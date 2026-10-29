// Stage 3 (engine) — the offline sql.js store and the Flask backend share one
// JSON envelope.  A bundle produced by the backend imports cleanly into the
// browser store, and a browser export round-trips back to the same shape.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function waitForBoot(page) {
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready(),
    null,
    { timeout: 15000 }
  );
}

test('backend bundle imports into the offline store and round-trips', async ({ page }) => {
  const bundle = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'backend-bundle.json'), 'utf8')
  );

  await page.goto('/index.html');
  await waitForBoot(page);

  // Import the backend-produced envelope into the in-browser SQLite DB.
  const counts = await page.evaluate((b) => window.MemoStateDb.importBundle(b, 'replace'), bundle);
  expect(counts.memos).toBe(bundle.memos.length);
  expect(counts.finance).toBe(bundle.finance.length);

  // Entries are queryable from the memos table.
  const loaded = await page.evaluate(() => (window.MemoStateDb.loadEntries('default') || []).length);
  expect(loaded).toBe(bundle.memos.length);

  // Export back out — same shape, same counts (cross-compatible round-trip).
  const exported = await page.evaluate(() => window.MemoStateDb.exportBundle());
  expect(exported.memos.length).toBe(bundle.memos.length);
  expect(exported.finance.length).toBe(bundle.finance.length);
  // a representative entry preserves its identity + description across the round-trip
  const sampleId = bundle.memos[0].id;
  const exportedSample = exported.memos.find((m) => m.id === sampleId);
  expect(exportedSample).toBeTruthy();
  expect(exportedSample.description).toBe(bundle.memos[0].description);
});
