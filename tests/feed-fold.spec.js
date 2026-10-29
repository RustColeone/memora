// Unified feed render (ImageDB-style foldable order) + the loose-entry bug fix.
//  - a loose/Uncategorized entry opens its DETAIL, never a category (the bug)
//  - a folder ("Albums") card opens its category, with a working breadcrumb back
//  - clicking the Albums / Uncategorized divider folds that section's cards
//  - windowing: only the first page of cards renders, with a 1px sentinel after
const { test, expect } = require('@playwright/test');
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Seed `memos`, register `categories` as folder-nav options, optionally turn off the
// group-by-time split (so loose entries fall under a single "Uncategorized" divider),
// then render.
async function seed(page, memos, categories = [], timeSplit = true) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready() && window.MemoMotion && window.MemoFilterBootstrapped, null, { timeout: 15000 });
  await page.evaluate(async ({ memos, categories, timeSplit }) => {
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    const st = window.MemoCore.getState();
    st.db.entries = window.MemoStateDb.loadEntries('default') || [];
    st.settings.timeSplit = { enabled: timeSplit, period: 'month' };
    categories.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; document.getElementById('categoryFilter').appendChild(o); });
    window.MemoCore.renderFeed();
  }, { memos, categories, timeSplit });
}

test('a loose/Uncategorized entry opens its detail, not a category', async ({ page }) => {
  await seed(page, [
    { id: 'u1', description: 'loose one', category: 'Uncategorized', tags: [], images: [IMG], ts: 3000 },
  ], [], false);
  await page.waitForSelector('#feed .time-divider[data-group="__uncategorized__"]');
  await page.waitForSelector('#feed .card[data-id="u1"]');
  await page.evaluate(() => document.querySelector('#feed .card[data-id="u1"]').click());
  // Opens the detail dialog — and does NOT navigate into a category.
  await page.waitForFunction(() => document.getElementById('detailDlg').open === true, null, { timeout: 3000 });
  expect(await page.evaluate(() => document.getElementById('categoryFilter').value)).toBe('__ALL__');
  expect(await page.evaluate(() => document.getElementById('breadcrumb').hidden)).toBe(true);
});

test('an Albums folder opens its category with a working breadcrumb back', async ({ page }) => {
  await seed(page, [
    { id: 'a', description: 'work', category: 'Work', tags: [], images: [IMG], ts: 3000 },
    { id: 'u1', description: 'loose', category: 'Uncategorized', tags: [], images: [IMG], ts: 2000 },
  ], ['Work'], false);
  await page.waitForSelector('#feed .time-divider[data-group="__folders__"]');
  await page.evaluate(() => document.querySelector('#feed .folder-card').click());
  await page.waitForSelector('#feed .card[data-id="a"]');
  expect(await page.evaluate(() => document.getElementById('categoryFilter').value)).toBe('Work');
  expect(await page.evaluate(() => document.getElementById('breadcrumb').hidden)).toBe(false);
  // Breadcrumb Home → back to root.
  await page.evaluate(() => document.querySelector('#breadcrumb .bc-back').click());
  await page.waitForFunction(() => document.getElementById('categoryFilter').value === '__ALL__', null, { timeout: 3000 });
  await page.waitForFunction(() => document.getElementById('breadcrumb').hidden === true, null, { timeout: 3000 });
});

test('at root the New Entry card sits under an Uncategorized divider (Albums · cards · Uncategorized · Add)', async ({ page }) => {
  // All entries categorized (no loose) + time-split OFF: the Uncategorized divider must
  // still appear so the add card sits under it, matching ImageDB.
  await seed(page, [
    { id: 'w1', description: 'a', category: 'Work', tags: [], images: [IMG], ts: 3000 },
    { id: 'w2', description: 'b', category: 'Work', tags: [], images: [IMG], ts: 2000 },
  ], ['Work'], false);
  await page.waitForSelector('#feed .time-divider[data-group="__uncategorized__"]');
  const order = await page.evaluate(() => [...document.querySelectorAll('#feed > *')].map(el => {
    if (el.classList.contains('time-divider')) return 'divider:' + el.dataset.group;
    if (el.classList.contains('folder-shelf')) return 'shelf:' + el.querySelectorAll('.folder-card').length;
    if (el.id === 'addCard') return 'add';
    if (el.classList.contains('card') && el.dataset.id) return 'card:' + el.dataset.id;
    return null;
  }).filter(Boolean));
  expect(order).toEqual(['divider:__folders__', 'shelf:1', 'divider:__uncategorized__', 'add']);
  expect(await page.evaluate(() => document.getElementById('addCard').dataset.group)).toBe('__uncategorized__');
});

test('opening a folder whose category is not yet a <select> option still shows its entries + breadcrumb', async ({ page }) => {
  // Deliberately DON'T register 'Untracked' as a categoryFilter option — this is the
  // synced-from-another-device case that used to set the select to "" → 0 entries and
  // hide the breadcrumb. openCategory must self-heal (ensureCategory + append option).
  await seed(page, [
    { id: 'x1', description: 'one', category: 'Untracked', tags: [], images: [IMG], ts: 3000 },
    { id: 'x2', description: 'two', category: 'Untracked', tags: [], images: [IMG], ts: 2000 },
  ], [], false);
  await page.waitForSelector('#feed .folder-card');
  await page.evaluate(() => document.querySelector('#feed .folder-card').click());
  await page.waitForSelector('#feed .card[data-id="x1"]');
  expect(await page.evaluate(() => document.getElementById('categoryFilter').value)).toBe('Untracked');
  expect(await page.evaluate(() => document.querySelectorAll('#feed .card[data-id]').length)).toBe(2);
  expect(await page.evaluate(() => document.getElementById('breadcrumb').hidden)).toBe(false);
});

test('clicking the Albums divider folds and unfolds its folder cards', async ({ page }) => {
  await seed(page, [
    { id: 'a', description: 'work', category: 'Work', tags: [], images: [IMG], ts: 3000 },
    { id: 'b', description: 'home', category: 'Home', tags: [], images: [IMG], ts: 2000 },
  ], ['Work', 'Home'], false);
  await page.waitForSelector('#feed .folder-card');
  const foldersBefore = await page.evaluate(() => document.querySelectorAll('#feed .folder-card').length);
  expect(foldersBefore).toBe(2);
  await page.evaluate(() => document.querySelector('#feed .time-divider[data-group="__folders__"]').click());
  // fade+scale then .collapsed (display:none) — the whole folder shelf folds away.
  await page.waitForFunction(() => {
    const shelf = document.querySelector('#feed > .folder-shelf');
    return shelf.querySelectorAll('.folder-card').length === 2 && shelf.classList.contains('collapsed')
      && getComputedStyle(shelf).display === 'none';
  }, null, { timeout: 2000 });
  // Toggle back open.
  await page.evaluate(() => document.querySelector('#feed .time-divider[data-group="__folders__"]').click());
  await page.waitForFunction(() => {
    const shelf = document.querySelector('#feed > .folder-shelf');
    return !shelf.classList.contains('collapsed') && getComputedStyle(shelf).display !== 'none';
  }, null, { timeout: 2000 });
});

test('windowing: only the first page of cards renders, with a sentinel after', async ({ page }) => {
  const memos = [];
  for (let i = 0; i < 65; i++) memos.push({ id: 'w' + i, description: 'e' + i, category: 'Uncategorized', tags: [], images: [IMG], ts: 1000 + i });
  await seed(page, memos, [], false);
  await page.waitForSelector('#feed .card[data-id]');
  const count = await page.evaluate(() => document.querySelectorAll('#feed .card[data-id]').length);
  expect(count).toBe(60);   // FEED_PAGE_SIZE
  expect(await page.evaluate(() => !!document.querySelector('#feed .feed-window-sentinel'))).toBe(true);
});
