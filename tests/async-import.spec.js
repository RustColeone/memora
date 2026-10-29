// Phase 1 — optimistic async import. A local-mode save with a new image renders
// its card immediately (blob: URL) with an "importing…" badge and closes the modal,
// then writes the blob + persists (_storedPaths) + queues the op in the background;
// the badge fades out on completion. Text-only saves stay synchronous (no badge).
const { test, expect } = require('@playwright/test');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
}
// DOM-click the FAB (headless hit-testing at the fixed corner is unreliable).
async function openModal(page) {
  await page.evaluate(() => document.getElementById('fab').click());
  await page.waitForSelector('#entryDlg[open]');
}
// Enter a category so the feed renders ENTRY cards (root shows folder cards, which
// carry no import badge). New entries then default to this category.
async function enterCategory(page, cat) {
  await page.evaluate((c) => {
    const s = document.getElementById('categoryFilter');
    if (![...s.options].some(o => o.value === c)) { const o = document.createElement('option'); o.value = c; o.textContent = c; s.appendChild(o); }
    s.value = c; s.dispatchEvent(new Event('change'));
  }, cat);
}

test('adding an image posts optimistically: modal closes at once, card shows importing badge, then persists in the background', async ({ page }) => {
  await boot(page);
  await enterCategory(page, 'Uncategorized');
  // Slow the durable blob write so the (normally near-instant, in IDB) optimistic
  // window is observable — proving the card renders BEFORE the write finishes.
  await page.evaluate(() => {
    const db = window.MemoStateDb; const orig = db.writeBlob.bind(db);
    db.writeBlob = (rel, f) => new Promise(res => setTimeout(() => res(orig(rel, f)), 1500));
  });
  await openModal(page);
  await page.setInputFiles('#images', { name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await page.fill('#desc', 'optimistic entry');
  await page.click('#saveBtn');

  // Modal closes immediately and a card with the importing badge appears — while
  // the durable write is still in flight (proves the render didn't wait for it).
  await page.waitForFunction(() => !document.getElementById('entryDlg').open);
  await page.waitForSelector('#feed .card .import-badge');
  const now = await page.evaluate(() => {
    const e = window.MemoCore.getState().db.entries.find(x => x.description === 'optimistic entry');
    return { has: !!e, importing: !!(e && e._importing), images: e ? (e.images || []).length : 0 };
  });
  expect(now.has).toBe(true);
  expect(now.importing).toBe(true);       // still importing at this instant
  expect(now.images).toBe(1);             // displayed from the blob: URL right away

  // Background persist completes: _importing cleared, durable _storedPaths written.
  await page.waitForFunction(() => {
    const e = window.MemoCore.getState().db.entries.find(x => x.description === 'optimistic entry');
    return e && !e._importing && Array.isArray(e._storedPaths) && e._storedPaths.length === 1;
  }, null, { timeout: 10000 });
  // …and the badge is fading/gone (has the .done class or removed).
  await page.waitForFunction(() => !document.querySelector('#feed .card .import-badge:not(.done)'), null, { timeout: 3000 });
});

test('a text-only entry still posts synchronously with no importing badge', async ({ page }) => {
  await boot(page);
  await openModal(page);
  await page.fill('#desc', 'text only entry');
  await page.click('#saveBtn');
  await page.waitForFunction(() => !document.getElementById('entryDlg').open);
  await page.waitForSelector('#feed .card');
  const r = await page.evaluate(() => {
    const e = window.MemoCore.getState().db.entries.find(x => x.description === 'text only entry');
    return { has: !!e, importing: !!(e && e._importing), badge: !!document.querySelector('#feed .card .import-badge') };
  });
  expect(r.has).toBe(true);
  expect(r.importing).toBe(false);
  expect(r.badge).toBe(false);
});
