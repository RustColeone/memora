// Whole-DB export: an export from ANY page must cover the entire database —
// memos, finance AND planner. Planner is a "document variant" (doc_entries
// table), so these check it's included in the bundle, merged by id on import
// (last-write-wins, multi-part safe), survives a real export→import, and that
// its legacy single-blob storage migrates into the table on init.
const { test, expect } = require('@playwright/test');
const { clickExport, answerPassword, readPlain, plainName } = require('./helpers/protected-backup');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function boot(page) {
  await page.goto('/index.html');
  await page.evaluate(() => window.MemoAppReady);
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready() && window.MemoCore,
    null, { timeout: 15000 }
  );
}

test('exportBundle includes planner; importBundle merges it by id (last-write-wins)', async ({ page }) => {
  await boot(page);
  const res = await page.evaluate(() => {
    const sdb = window.MemoStateDb;
    sdb.saveDocs('planner', [
      { id: 'p1', kind: 'todo', title: 'A', updatedAt: '2025-01-01T00:00:00Z' },
      { id: 'p2', kind: 'event', title: 'B', updatedAt: '2025-01-02T00:00:00Z' },
    ]);
    const bundle = sdb.exportBundle();
    const counts = sdb.importBundle({
      version: 1, memos: [], finance: [], planner: [
        { id: 'p1', kind: 'todo', title: 'A-updated', updatedAt: '2025-06-01T00:00:00Z' }, // newer → wins
        { id: 'p3', kind: 'habit', title: 'C', updatedAt: '2025-01-03T00:00:00Z' },         // new → added
        { id: 'p2', kind: 'event', title: 'B-OLD', updatedAt: '2020-01-01T00:00:00Z' },     // older → ignored
      ],
    }, 'merge');
    const byId = {};
    (sdb.loadDocs('planner') || []).forEach(e => { byId[e.id] = e; });
    return {
      exportedPlanner: bundle.planner.length,
      countsPlanner: counts.planner,
      p1: byId.p1.title, p2: byId.p2.title, p3: byId.p3.title,
      total: Object.keys(byId).length,
    };
  });
  expect(res.exportedPlanner).toBe(2);
  expect(res.countsPlanner).toBe(2);   // p1 updated + p3 added; p2-old skipped
  expect(res.p1).toBe('A-updated');
  expect(res.p2).toBe('B');
  expect(res.p3).toBe('C');
  expect(res.total).toBe(3);
});

test("import 'replace' clears planner first (first-part semantics for multi-part)", async ({ page }) => {
  await boot(page);
  const ids = await page.evaluate(() => {
    const sdb = window.MemoStateDb;
    sdb.saveDocs('planner', [{ id: 'old', kind: 'todo', title: 'old', updatedAt: '2025-01-01T00:00:00Z' }]);
    sdb.importBundle({ version: 1, memos: [], finance: [], planner: [{ id: 'new', kind: 'todo', title: 'new', updatedAt: '2025-01-02T00:00:00Z' }] }, 'replace');
    return (sdb.loadDocs('planner') || []).map(e => e.id);
  });
  expect(ids).toEqual(['new']);
});

test('a backup taken on the memo page carries planner through export→import', async ({ page, browser }) => {
  test.setTimeout(60000);
  await boot(page);
  await page.evaluate(async () => {
    window.MemoStateDb.importBundle({
      version: 1,
      memos: [{ id: 'm1', description: 'memo one', category: 'X', tags: [], images: [], ts: Date.now() }],
      finance: [{ id: 'f1', description: 'fin one', category: 'Y', tags: [], images: [], purchaseDate: '2025-01-01', ts: Date.now() }],
    }, 'replace');
    window.MemoStateDb.saveDocs('planner', [
      { id: 'p1', kind: 'todo', title: 'plan one', updatedAt: '2025-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' },
    ]);
    await window.MemoStateDb.flush();
  });

  // Export via the real Settings button (offline, size-capped path).
  await page.evaluate(() => document.getElementById('mobileSettingsBtn').click());
  await page.waitForFunction(() => document.getElementById('settingsDlg').open, null, { timeout: 5000 });
  await page.evaluate(() => {
    const s = document.getElementById('exportDataBtn').closest('.settings-section');
    if (s) s.classList.remove('collapsed');
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickExport(page),
  ]);
  const zp = path.join(os.tmpdir(), 'wholedb-' + Date.now() + '.zip');
  fs.writeFileSync(zp, (await readPlain(download)).bytes);

  // Fresh profile → import → all three variants restored.
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto('/index.html');
  await p2.evaluate(() => window.MemoAppReady);
  await p2.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
  await p2.setInputFiles('#importDataInput', zp);
  await p2.locator('#memoConfirmDlg .memo-confirm-ok').click();
  await p2.waitForFunction(() => (window.MemoStateDb.loadEntries('default') || []).length === 1, null, { timeout: 15000 });

  const restored = await p2.evaluate(() => ({
    memos: (window.MemoStateDb.loadEntries('default') || []).length,
    finance: (window.MemoStateDb.loadEntries('finance') || []).length,
    planner: (window.MemoStateDb.loadDocs('planner') || []).length,
    plannerTitle: ((window.MemoStateDb.loadDocs('planner') || [])[0] || {}).title,
  }));
  expect(restored).toEqual({ memos: 1, finance: 1, planner: 1, plannerTitle: 'plan one' });

  fs.unlinkSync(zp);
  await ctx.close();
});

async function seedAndOpenExport(page, seedFn) {
  await boot(page);
  await page.evaluate(seedFn);
  await page.evaluate(() => document.getElementById('mobileSettingsBtn').click());
  await page.waitForFunction(() => document.getElementById('settingsDlg').open, null, { timeout: 5000 });
  await page.evaluate(() => document.getElementById('exportDataBtn').closest('.settings-section').classList.remove('collapsed'));
}

async function exportImportInFresh(page, browser, waitCount) {
  const [dl] = await Promise.all([page.waitForEvent('download'), clickExport(page)]);
  const zp = path.join(os.tmpdir(), 'scope-' + Date.now() + '.zip');
  fs.writeFileSync(zp, (await readPlain(dl)).bytes);
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto('/index.html');
  await p2.evaluate(() => window.MemoAppReady);
  await p2.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
  await p2.setInputFiles('#importDataInput', zp);
  await p2.locator('#memoConfirmDlg .memo-confirm-ok').click();
  await p2.waitForFunction((n) => (window.MemoStateDb.loadEntries('default') || []).length >= n, waitCount, { timeout: 15000 });
  const out = await p2.evaluate(() => ({
    memos: (window.MemoStateDb.loadEntries('default') || []).map(e => e.id).sort(),
    finance: (window.MemoStateDb.loadEntries('finance') || []).length,
    planner: (window.MemoStateDb.loadDocs('planner') || []).length,
  }));
  fs.unlinkSync(zp);
  await ctx.close();
  return out;
}

test('export scope: unchecking a variant excludes it from the backup', async ({ page, browser }) => {
  test.setTimeout(60000);
  await seedAndOpenExport(page, async () => {
    window.MemoStateDb.importBundle({
      version: 1,
      memos: [{ id: 'm1', description: 'm', category: 'X', tags: [], images: [], ts: Date.now() }],
      finance: [{ id: 'f1', description: 'f', category: 'Y', tags: [], images: [], purchaseDate: '2025-01-01', ts: Date.now() }],
    }, 'replace');
    window.MemoStateDb.saveDocs('planner', [{ id: 'p1', kind: 'todo', title: 'p', updatedAt: '2025-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' }]);
    await window.MemoStateDb.flush();
  });
  await page.evaluate(() => {
    document.getElementById('exportInclPlanner').checked = false;
    document.getElementById('exportInclFinance').checked = false;
  });
  const out = await exportImportInFresh(page, browser, 1);
  expect(out).toEqual({ memos: ['m1'], finance: 0, planner: 0 });
});

test('export scope: a date range limits which entries are backed up', async ({ page, browser }) => {
  test.setTimeout(60000);
  await seedAndOpenExport(page, async () => {
    const mk = (id, d) => ({ id, description: id, category: 'X', tags: [], images: [], ts: new Date(d).getTime() });
    window.MemoStateDb.importBundle({ version: 1, memos: [mk('old', '2020-01-01'), mk('mid', '2023-06-15'), mk('new', '2025-12-31')], finance: [] }, 'replace');
    await window.MemoStateDb.flush();
  });
  await page.evaluate(() => {
    document.getElementById('exportRangeFrom').value = '2023-01-01';
    document.getElementById('exportRangeTo').value = '2024-01-01';
  });
  const out = await exportImportInFresh(page, browser, 1);
  expect(out.memos).toEqual(['mid']); // only the 2023-06-15 entry is in range
});

test('the Planner page has the shared backup panel and exports/imports the whole DB', async ({ page, browser }) => {
  test.setTimeout(60000);
  await page.goto('/planner.html');
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready() && window.Planner && window.Planner.Store && window.MemoBackup,
    null, { timeout: 15000 }
  );
  await page.evaluate(async () => {
    window.MemoStateDb.importBundle({
      version: 1,
      memos: [{ id: 'm1', description: 'm', category: 'X', tags: [], images: [], ts: Date.now() }],
      finance: [{ id: 'f1', description: 'f', category: 'Y', tags: [], images: [], purchaseDate: '2025-01-01', ts: Date.now() }],
    }, 'replace');
    window.MemoStateDb.saveDocs('planner', [{ id: 'p1', kind: 'todo', title: 'plan one', updatedAt: '2025-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' }]);
    await window.MemoStateDb.flush();
  });

  // Open Planner settings → the shared Data Backup section is present + export works.
  await page.evaluate(() => document.getElementById('mobileSettingsBtn').click());
  await page.waitForFunction(() => document.getElementById('settingsDlg').open, null, { timeout: 5000 });
  await page.waitForSelector('#exportDataBtn');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickExport(page),
  ]);
  const zp = path.join(os.tmpdir(), 'planner-backup-' + Date.now() + '.zip');
  fs.writeFileSync(zp, (await readPlain(download)).bytes);

  // Fresh Planner profile → import → the whole DB (incl. this planner) restores.
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto('/planner.html');
  await p2.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
  await p2.setInputFiles('#importDataInput', zp);
  await p2.locator('#memoConfirmDlg .memo-confirm-ok').click();
  await p2.waitForFunction(() => (window.MemoStateDb.loadDocs('planner') || []).length === 1, null, { timeout: 15000 });

  const restored = await p2.evaluate(() => ({
    memos: (window.MemoStateDb.loadEntries('default') || []).length,
    finance: (window.MemoStateDb.loadEntries('finance') || []).length,
    planner: (window.MemoStateDb.loadDocs('planner') || []).map(e => e.title),
  }));
  expect(restored).toEqual({ memos: 1, finance: 1, planner: ['plan one'] });

  fs.unlinkSync(zp);
  await ctx.close();
});

test('planner legacy blob migrates into doc_entries on init', async ({ page }) => {
  await boot(page);
  // Simulate an old install: planner data in the legacy settings blob, and the
  // doc table empty. Persist, then reload so init() runs the migration.
  await page.evaluate(async () => {
    window.MemoStateDb.setItem('plannerEntries.v1', [
      { id: 'l1', kind: 'todo', title: 'legacy one', updatedAt: '2025-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'l2', kind: 'habit', title: 'legacy two', updatedAt: '2025-01-02T00:00:00Z', createdAt: '2025-01-02T00:00:00Z' },
    ]);
    await window.MemoStateDb.flush();
  });
  await page.reload();
  await page.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
  await page.evaluate(() => window.MemoStateDb.init());

  const res = await page.evaluate(() => ({
    docs: (window.MemoStateDb.loadDocs('planner') || []).map(e => e.id).sort(),
    titles: (window.MemoStateDb.loadDocs('planner') || []).map(e => e.title).sort(),
    blobGone: window.MemoStateDb.getItem('plannerEntries.v1') === null,
  }));
  expect(res.docs).toEqual(['l1', 'l2']);
  expect(res.titles).toEqual(['legacy one', 'legacy two']);
  expect(res.blobGone).toBe(true); // blob retired after migration
});

test('pre-SQLite planner localStorage migrates durably into doc_entries on first boot', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('plannerEntries.v1', JSON.stringify([
      {
        id: 'legacy-local-planner',
        kind: 'todo',
        title: 'Recovered legacy planner task',
        createdAt: '2025-03-01T00:00:00.000Z',
        updatedAt: '2025-03-01T00:00:00.000Z',
      },
    ]));
  });

  await page.goto('/planner.html');
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready() && window.Planner && window.Planner.Store,
    null,
    { timeout: 15000 }
  );

  const result = await page.evaluate(async () => {
    // `ready()` means the SQLite handle is available.  Await init() as well so
    // the migration's verified snapshot promotion and source retirement have
    // crossed their durability boundary before asserting either one.
    await window.MemoStateDb.init();
    return {
      docs: (window.MemoStateDb.loadDocs('planner') || []).map(doc => ({ id: doc.id, title: doc.title })),
      sourceRemoved: localStorage.getItem('plannerEntries.v1') === null,
    };
  });

  expect(result.docs).toEqual([
    { id: 'legacy-local-planner', title: 'Recovered legacy planner task' },
  ]);
  expect(result.sourceRemoved).toBe(true);
  await context.close();
});
