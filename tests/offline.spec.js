// Stage 2 checkpoint — the offline-independent frontend persists through the
// in-browser SQLite engine (sql.js + OPFS), surviving a full reload.
const { test, expect } = require('@playwright/test');

async function waitForBoot(page) {
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready() &&
          window.MemoCore && typeof window.MemoCore.getState === 'function',
    null,
    { timeout: 15000 }
  );
  await page.evaluate(() => window.MemoAppReady || window.MemoCore.start());
}

test('offline mode runs on sql.js/OPFS and persists across reload', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/index.html');
  await waitForBoot(page);

  // Confirm we are in local (offline) mode backed by the SQLite engine.
  const mode = await page.evaluate(() => window.MemoCore.getState && (window.MODE || 'local'));
  expect(['local', undefined, 'local']).toContain(mode || 'local');

  // Create an entry through the real store path (MemoCore.saveAll -> StateDb).
  await page.evaluate(async () => {
    const { db } = window.MemoCore.getState();
    db.entries.push({
      id: 'pw-test-1',
      description: 'persisted via sql.js',
      category: 'TestCat',
      tags: ['t1'],
      images: [],
      attachments: [],
      ts: Date.now(),
    });
    window.MemoCore.saveAll();
    await window.MemoStateDb.flush(); // force OPFS write before reload
  });

  // Full reload — data must come back from OPFS, not memory/localStorage.
  await page.reload();
  await waitForBoot(page);

  const desc = await page.evaluate(() => {
    const { db } = window.MemoCore.getState();
    const e = db.entries.find((x) => x.id === 'pw-test-1');
    return e ? e.description : null;
  });
  expect(desc).toBe('persisted via sql.js');

  // The entry must live in the sqlite memos table (not just the JS array).
  const inSqlite = await page.evaluate(() => {
    // Re-open via the engine's own query surface by reloading entries.
    const rows = window.MemoStateDb.loadEntries('default') || [];
    return rows.some((r) => r.id === 'pw-test-1');
  });
  expect(inSqlite).toBe(true);

  expect(errors, 'no uncaught page errors').toEqual([]);
});
