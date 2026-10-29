// Android storage: native SQLite as the durable store, tested against a fake
// phone (tests/fixtures/fake-native-sqlite.js). Covers the one-time move from
// the snapshot file, single-row writes, reloads, retried batches, the locked
// restored-phone flow, recovery from a safety copy, and database files.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const fake = fs.readFileSync(path.join(__dirname, 'fixtures', 'fake-native-sqlite.js'), 'utf8');

// Boot only the storage layer, as on a phone. `before` runs after the fake
// phone exists and before MemoStateDb opens.
async function bootPhone(page, before) {
  await page.goto('/queue-harness.html');
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ url: '/static/vendor/sql-wasm.js' });
  await page.addScriptTag({ content: fake });
  if (before) await page.evaluate(before);
  for (const name of ['memo-crypto.js', 'memo-native-store.js', 'memo-state-db.js']) {
    await page.addScriptTag({ url: '/static/js/memo/' + name });
  }
  await page.evaluate(() => window.MemoStateDb.init());
}
const memo = (id, description, extra = {}) => ({ id, description, category: 'Work', tags: [], images: [], attachments: [],
  ts: 1700000000000, createdAt: '2023-11-14T22:13:20.000Z', updatedAt: '2023-11-14T22:13:20.000Z', ...extra });

test.beforeEach(async ({ page }) => {
  await page.goto('/queue-harness.html');
  await page.evaluate(() => localStorage.clear());
});

test('first launch moves the snapshot file into the phone database, then keeps it aside', async ({ page }) => {
  // An app version before this change: data in memosystem.sqlite on the phone.
  await page.goto('/queue-harness.html');
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ url: '/static/vendor/sql-wasm.js' });
  await page.evaluate(async () => {
    const SQL = await initSqlJs({ locateFile: f => '/static/vendor/' + f });
    const db = new SQL.Database();
    db.run('CREATE TABLE memos (id TEXT PRIMARY KEY, description TEXT, category TEXT, tags TEXT, images TEXT, attachments TEXT, image_meta TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0, deleted_at INTEGER)');
    for (let i = 0; i < 30; i++) db.run('INSERT INTO memos VALUES (?,?,?,?,?,?,?,?,?,0,NULL)', ['old' + i, 'Old note ' + i, 'Work', '[]', '[]', '[]', '{}', 1000 + i, 1000 + i]);
    const bytes = db.export();
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    localStorage.setItem('fakeNative:file:MemoSystem/memosystem.sqlite', btoa(s));
  });
  await bootPhone(page);
  const result = await page.evaluate(async () => ({
    engine: MemoStateDb.storage.engine(),
    loaded: MemoStateDb.loadEntries('default').length,
    nativeRows: await __fakeNative.tableCount('memora', 'memos'),
    snapshot: __fakeNative.file('MemoSystem/memosystem.sqlite'),
    keptAside: !!__fakeNative.file('MemoSystem/memosystem.pre-native.sqlite'),
  }));
  expect(result).toEqual({ engine: 'native', loaded: 30, nativeRows: 30, snapshot: null, keptAside: true });
});

test('edits go to the phone database as single rows and survive a restart', async ({ page }) => {
  await bootPhone(page);
  const first = await page.evaluate(async () => {
    const list = Array.from({ length: 200 }, (_, i) => ({ id: 'n' + i, description: 'Note ' + i, category: 'Work', tags: [], images: [], attachments: [], ts: 1000 + i }));
    MemoStateDb.saveEntries(list, 'default');
    await MemoStateDb.flush();
    __fakeNative.log.length = 0;
    list[7] = { ...list[7], description: 'Edited note 7' };
    MemoStateDb.saveEntries(list, 'default');
    await MemoStateDb.flush();
    const writes = __fakeNative.log.filter(c => c.method === 'executeSet');
    MemoStateDb.saveEntries(list, 'default'); // nothing changed
    await MemoStateDb.flush();
    return {
      statements: writes.reduce((n, c) => n + c.statements, 0),
      batches: writes.length,
      unchangedWrites: __fakeNative.log.filter(c => c.method === 'executeSet').length - writes.length,
      snapshotWrites: __fakeNative.log.filter(c => c.method === 'writeFile' && /memosystem\.sqlite/.test(c.path)).length,
    };
  });
  expect(first).toEqual({ statements: 1, batches: 1, unchangedWrites: 0, snapshotWrites: 0 });

  await page.reload();
  await bootPhone(page);
  const after = await page.evaluate(() => {
    const entries = MemoStateDb.loadEntries('default');
    return { engine: MemoStateDb.storage.engine(), count: entries.length, edited: entries.find(e => e.id === 'n7').description };
  });
  expect(after).toEqual({ engine: 'native', count: 200, edited: 'Edited note 7' });
});

test('a failed write batch is kept in order and stored on the next flush', async ({ page }) => {
  await bootPhone(page);
  const result = await page.evaluate(async () => {
    MemoStateDb.saveEntries([{ id: 'a', description: 'one', category: 'Work', tags: [], images: [], attachments: [], ts: 1 }], 'default');
    __fakeNative.failNext.executeSet = 1;
    let failed = false;
    try { await MemoStateDb.flush(); } catch (_e) { failed = true; }
    MemoStateDb.saveEntries([{ id: 'a', description: 'two', category: 'Work', tags: [], images: [], attachments: [], ts: 1 },
      { id: 'b', description: 'three', category: 'Work', tags: [], images: [], attachments: [], ts: 2 }], 'default');
    await MemoStateDb.flush();
    return { failed, pending: MemoStateDb.getMetadataHealth().pending };
  });
  expect(result).toEqual({ failed: true, pending: false });
  await page.reload();
  await bootPhone(page);
  const stored = await page.evaluate(() => MemoStateDb.loadEntries('default').map(e => [e.id, e.description]));
  expect(stored).toEqual([['a', 'two'], ['b', 'three']]);
});

test('a phone restored from backup is locked until the recovery password unlocks it', async ({ page }) => {
  await bootPhone(page);
  await page.evaluate(async () => {
    MemoStateDb.saveEntries([{ id: 'secret-note', description: 'Kept safe', category: 'Work', tags: [], images: [], attachments: [], ts: 1 }], 'default');
    await MemoStateDb.flush();
    await MemoStateDb.storage.setRecoveryPassword('correct horse');
    __fakeNative.restoreOnNewPhone();
  });
  await page.reload();
  await bootPhone(page);
  const locked = await page.evaluate(async () => {
    MemoStateDb.saveEntries([{ id: 'typed-while-locked', description: 'x', category: 'Work', tags: [], images: [], attachments: [], ts: 1 }], 'default');
    await MemoStateDb.flush();
    let wrong = null;
    try { await MemoStateDb.storage.unlock('wrong password'); } catch (e) { wrong = e.message; }
    return { engine: MemoStateDb.storage.engine(), hasRecovery: MemoStateDb.storage.info().hasRecovery, wrong,
      rows: await __fakeNative.tableCount('memora', 'memos') };
  });
  expect(locked).toEqual({ engine: 'locked', hasRecovery: true, wrong: 'Wrong password, or the file is damaged.', rows: 1 });
  await page.evaluate(() => MemoStateDb.storage.unlock('correct horse'));
  await page.reload();
  await bootPhone(page);
  const unlocked = await page.evaluate(() => ({ engine: MemoStateDb.storage.engine(), ids: MemoStateDb.loadEntries('default').map(e => e.id) }));
  expect(unlocked).toEqual({ engine: 'native', ids: ['secret-note'] });
});

test('starting fresh on a locked phone keeps the locked database untouched', async ({ page }) => {
  await bootPhone(page);
  await page.evaluate(async () => {
    MemoStateDb.saveEntries([{ id: 'old', description: 'Old phone', category: 'Work', tags: [], images: [], attachments: [], ts: 1 }], 'default');
    await MemoStateDb.flush();
    __fakeNative.restoreOnNewPhone();
  });
  await page.reload();
  await bootPhone(page);
  expect(await page.evaluate(() => MemoStateDb.storage.info().hasRecovery)).toBe(false);
  await page.evaluate(() => MemoStateDb.storage.startFresh());
  await page.reload();
  await bootPhone(page);
  const result = await page.evaluate(async () => ({
    engine: MemoStateDb.storage.engine(),
    entries: MemoStateDb.loadEntries('default').length,
    setAside: __fakeNative.setAside(),
  }));
  expect(result.engine).toBe('native');
  expect(result.entries).toBe(0);
  // The locked database was moved out of the plugin's folder, not deleted.
  expect(result.setAside.some(p => /^MemoSystem\/locked-\d+\/memoraSQLite\.db$/.test(p))).toBe(true);
});

test('a damaged phone database is rebuilt from the newest safety copy', async ({ page }) => {
  await bootPhone(page);
  await page.evaluate(async () => {
    MemoStateDb.saveEntries([{ id: 'n1', description: 'Before the copy', category: 'Work', tags: [], images: [], attachments: [], ts: 1 }], 'default');
    await MemoStateDb.flush();
    if (!(await MemoStateDb.storage.writeSafetyCopy())) throw new Error('safety copy failed');
    __fakeNative.damage('memora');
  });
  await page.reload();
  await bootPhone(page);
  const result = await page.evaluate(async () => {
    const health = MemoStateDb.getMetadataHealth();
    MemoStateDb.saveEntries([{ id: 'n1', description: 'Before the copy', category: 'Work', tags: [], images: [], attachments: [], ts: 1 },
      { id: 'n2', description: 'After recovery', category: 'Work', tags: [], images: [], attachments: [], ts: 2 }], 'default');
    await MemoStateDb.flush();
    let recoveryPassword = 'set';
    try { await MemoStateDb.storage.setRecoveryPassword('pw'); } catch (e) { recoveryPassword = e.message; }
    return { engine: MemoStateDb.storage.engine(), status: health.status, ids: MemoStateDb.loadEntries('default').map(e => e.id),
      damagedKept: __fakeNative.hasDb('memora'), recoveryPassword };
  });
  expect(result).toEqual({ engine: 'native', status: 'recovered', ids: ['n1', 'n2'], damagedKept: true, recoveryPassword: 'set' });
});

test('a database file exports and imports back, without the phone key', async ({ page }) => {
  await bootPhone(page);
  const result = await page.evaluate(async () => {
    MemoStateDb.saveEntries([{ id: 'keep', description: 'In the file', category: 'Work', tags: [], images: [], attachments: [], ts: 1 }], 'default');
    await MemoStateDb.flush();
    const file = MemoStateDb.exportDatabaseFile();
    const SQL = await initSqlJs({ locateFile: f => '/static/vendor/' + f });
    const probe = new SQL.Database(file);
    const tables = probe.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.map(r => r[0]);
    probe.close();
    MemoStateDb.saveEntries([{ id: 'later', description: 'Made after export', category: 'Work', tags: [], images: [], attachments: [], ts: 2 }], 'default');
    await MemoStateDb.flush();
    const summary = await MemoStateDb.importDatabaseFile(file);
    let notMemora = null;
    const other = new SQL.Database(); other.run('CREATE TABLE photos (id TEXT)');
    try { MemoStateDb.inspectDatabaseFile(other.export()); } catch (e) { notMemora = e.message; }
    return { hasKeyTable: tables.includes('native_meta'), summary: summary.memos, ids: MemoStateDb.loadEntries('default').map(e => e.id),
      nativeRows: await __fakeNative.tableCount('memora', 'memos'), notMemora };
  });
  expect(result).toEqual({ hasKeyTable: false, summary: 1, ids: ['keep'], nativeRows: 1, notMemora: 'This file is not a Memora database.' });
});

test('a phone database under another key is locked, and the copy kept at the switch restores it', async ({ page }) => {
  // Older data in the snapshot file, moved in on first launch.
  await page.goto('/queue-harness.html');
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ url: '/static/vendor/sql-wasm.js' });
  await page.evaluate(async () => {
    const SQL = await initSqlJs({ locateFile: f => '/static/vendor/' + f });
    const db = new SQL.Database();
    db.run('CREATE TABLE memos (id TEXT PRIMARY KEY, description TEXT, category TEXT, tags TEXT, images TEXT, attachments TEXT, image_meta TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0, deleted_at INTEGER)');
    for (let i = 0; i < 12; i++) db.run('INSERT INTO memos VALUES (?,?,?,?,?,?,?,?,?,0,NULL)', ['k' + i, 'Kept ' + i, 'Work', '[]', '[]', '[]', '{}', 1000 + i, 1000 + i]);
    const bytes = db.export();
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    localStorage.setItem('fakeNative:file:MemoSystem/memosystem.sqlite', btoa(s));
  });
  await bootPhone(page);
  expect(await page.evaluate(() => MemoStateDb.storage.engine())).toBe('native');
  // The phone now holds a different key than the database was made with.
  await page.evaluate(() => localStorage.setItem('fakeNative:secret', 'a-different-key'));
  await page.reload();
  await bootPhone(page);
  const locked = await page.evaluate(() => ({ engine: MemoStateDb.storage.engine(), copy: MemoStateDb.storage.info().preNative && MemoStateDb.storage.info().preNative.memos }));
  expect(locked).toEqual({ engine: 'locked', copy: 12 });
  await page.evaluate(() => MemoStateDb.storage.restorePreNative());
  await page.reload();
  await bootPhone(page);
  const restored = await page.evaluate(() => ({ engine: MemoStateDb.storage.engine(), count: MemoStateDb.loadEntries('default').length, aside: __fakeNative.setAside().length }));
  // Both the main database and the safety copy made after the move were set
  // aside: neither opens under the new key, and neither is deleted.
  expect(restored).toEqual({ engine: 'native', count: 12, aside: 2 });
});

test('the unencrypted kept copy is removed only after both safety copies prove good', async ({ page }) => {
  await page.goto('/queue-harness.html');
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ url: '/static/vendor/sql-wasm.js' });
  await page.evaluate(async () => {
    const SQL = await initSqlJs({ locateFile: f => '/static/vendor/' + f });
    const db = new SQL.Database();
    db.run('CREATE TABLE memos (id TEXT PRIMARY KEY, description TEXT, category TEXT, tags TEXT, images TEXT, attachments TEXT, image_meta TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0, deleted_at INTEGER)');
    db.run('INSERT INTO memos VALUES (?,?,?,?,?,?,?,?,?,0,NULL)', ['r1', 'Kept', 'Work', '[]', '[]', '[]', '{}', 1, 1]);
    const bytes = db.export();
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    localStorage.setItem('fakeNative:file:MemoSystem/memosystem.sqlite', btoa(s));
  });
  await bootPhone(page);
  await page.waitForFunction(() => __fakeNative.hasDb('memora-lkg-a'), null, { timeout: 10000 });
  const oneCopy = await page.evaluate(async () => ({
    retired: await MemoStateDb.storage.retirePreNative(),
    kept: !!__fakeNative.file('MemoSystem/memosystem.pre-native.sqlite'),
  }));
  expect(oneCopy).toEqual({ retired: false, kept: true });
  await page.evaluate(() => MemoStateDb.storage.writeSafetyCopy());
  await page.reload();
  await bootPhone(page);
  const later = await page.evaluate(async () => ({
    retired: await MemoStateDb.storage.retirePreNative(),
    kept: !!__fakeNative.file('MemoSystem/memosystem.pre-native.sqlite'),
    entries: MemoStateDb.loadEntries('default').map(e => e.id),
  }));
  expect(later).toEqual({ retired: true, kept: false, entries: ['r1'] });
});
