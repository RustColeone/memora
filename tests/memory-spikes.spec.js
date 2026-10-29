// Large-notebook memory spikes removed: the tag manager's undo keeps only what
// changed, an empty sync pull loads nothing, and whole-database copies to the
// phone stream in pages.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const fake = fs.readFileSync(path.join(__dirname, 'fixtures', 'fake-native-sqlite.js'), 'utf8');
const source = name => fs.readFileSync(path.join(process.cwd(), 'src/static/js/memo', name), 'utf8');

test('tag rename and delete touch only tagged entries, and undo keeps later edits', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready() && window.MemoAppReady, null, { timeout: 15000 });
  await page.evaluate(() => window.MemoAppReady);
  const result = await page.evaluate(async () => {
    const memos = [
      { id: 'a', description: 'tagged a', category: 'Work', tags: ['old', 'keep'], images: [], ts: 3 },
      { id: 'b', description: 'tagged b', category: 'Work', tags: ['old', 'new'], images: [], ts: 2 },
      { id: 'c', description: 'untagged', category: 'Work', tags: [], images: [], ts: 1 },
    ];
    window.MemoStateDb.importBundle({ version: 1, memos, finance: [], planner: [] }, 'replace');
    await window.MemoStateDb.flush();
    const st = window.MemoCore.getState();
    st.db.entries = window.MemoStateDb.loadEntries('default');
    const untouched = st.db.entries.find(e => e.id === 'c');
    recomputeTags(); buildTagManager();
    const row = [...document.querySelectorAll('#tagMgrList .tagrow')].find(r => r.querySelector('input').value === 'old');
    row.querySelector('input').value = 'new';
    row.querySelector('[data-act=save]').click();
    await new Promise(r => setTimeout(r, 50));
    const byId = () => st.db.entries.map(e => [e.id, e.tags]).sort((x, y) => x[0] < y[0] ? -1 : 1);
    const afterRename = byId();
    const sameObject = st.db.entries.find(e => e.id === 'c') === untouched;
    // A later, unrelated edit must survive the undo.
    st.db.entries.find(e => e.id === 'c').description = 'edited after the rename';
    await doUndo();
    return {
      afterRename, sameObject,
      afterUndo: byId(),
      laterEdit: st.db.entries.find(e => e.id === 'c').description,
    };
  });
  expect(result.afterRename).toEqual([['a', ['new', 'keep']], ['b', ['new']], ['c', []]]);
  expect(result.sameObject).toBe(true);
  expect(result.afterUndo).toEqual([['a', ['old', 'keep']], ['b', ['old', 'new']], ['c', []]]);
  expect(result.laterEdit).toBe('edited after the rename');
});

test('an empty sync pull loads no entries', async ({ page }) => {
  await page.goto('/queue-harness.html');
  await page.setContent('<html><body></body></html>');
  await page.evaluate(() => {
    const state = { loads: 0, variant: 'default' };
    window.__state = state;
    window.MemoRuntime = { getApiBase: () => 'https://home.test', getMode: () => 'local',
      getService: name => name === 'stateDb' ? { loadEntries: () => { state.loads++; return []; }, loadDocs: () => [], ready: () => true } : null };
    window.MemoContracts = { getVariant: () => state.variant };
  });
  await page.addScriptTag({ content: source('memo-operation-queue.js') });
  const loads = await page.evaluate(async () => {
    window.fetch = async () => ({ ok: true, json: async () => ({ needsFullSync: false, operations: [], latestOpId: 0, hasMore: false }) });
    // Finance is not the current page, so its entries would come from the database.
    await OperationQueue.pullServerOperations(OperationQueue.context('finance'));
    return __state.loads;
  });
  expect(loads).toBe(0);
});

test('a whole-database copy to the phone streams in pages and stays complete', async ({ page }) => {
  await page.goto('/queue-harness.html');
  await page.evaluate(() => localStorage.clear());
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ url: '/static/vendor/sql-wasm.js' });
  await page.evaluate(async () => {
    const SQL = await initSqlJs({ locateFile: f => '/static/vendor/' + f });
    const db = new SQL.Database();
    db.run('CREATE TABLE memos (id TEXT PRIMARY KEY, description TEXT, category TEXT, tags TEXT, images TEXT, attachments TEXT, image_meta TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0, deleted_at INTEGER)');
    db.run('BEGIN');
    for (let i = 0; i < 4500; i++) db.run('INSERT INTO memos VALUES (?,?,?,?,?,?,?,?,?,0,NULL)', ['m' + i, 'Note ' + i, 'Work', '[]', '[]', '[]', '{}', 1000 + i, 1000 + i]);
    db.run('COMMIT');
    const bytes = db.export();
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    localStorage.setItem('fakeNative:file:MemoSystem/memosystem.sqlite', btoa(s));
  });
  await page.addScriptTag({ content: fake });
  for (const name of ['memo-crypto.js', 'memo-native-store.js', 'memo-state-db.js']) await page.addScriptTag({ url: '/static/js/memo/' + name });
  await page.evaluate(() => window.MemoStateDb.init());
  const result = await page.evaluate(async () => {
    await window.MemoStateDb.storage.writeSafetyCopy();
    const sets = __fakeNative.log.filter(c => c.method === 'executeSet' && c.database === 'memora');
    return {
      engine: MemoStateDb.storage.engine(),
      main: await __fakeNative.tableCount('memora', 'memos'),
      copy: await __fakeNative.tableCount('memora-lkg-a', 'memos'),
      largestCall: Math.max(...sets.map(c => c.statements)),
    };
  });
  expect(result.engine).toBe('native');
  expect(result.main).toBe(4500);
  expect(result.copy).toBe(4500);
  expect(result.largestCall).toBeLessThanOrEqual(400);
});
