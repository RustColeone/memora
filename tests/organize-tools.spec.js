// Organize & smart library (ported from ImageDB): search by what is in a
// photo, smart albums, suggested tags, duplicate review, saved searches, and
// saved searches travelling in backups. On-device analysis results are put in
// directly (the ML Kit analysis itself runs only in the Android app).
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready() && window.MemoAppReady && window.MemoInsights && window.MemoDuplicates, null, { timeout: 15000 });
  await page.evaluate(() => window.MemoAppReady);
}

// Entries with drawn images; `same` makes two entries share one stored image.
async function seed(page, specs) {
  await page.evaluate(async list => {
    const draw = (color, w, h) => new Promise(resolve => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff'; g.fillRect(w * 0.15, h * 0.3, w * 0.5, h * 0.4);
      g.fillStyle = '#222'; g.beginPath(); g.arc(w * 0.75, h * 0.25, h * 0.12, 0, 7); g.fill();
      c.toBlob(resolve, 'image/jpeg', 0.9);
    });
    const sdb = window.MemoStateDb;
    const memos = [];
    for (const spec of list) {
      const path = spec.path || ('uploads/org-' + spec.id + '.jpg');
      if (!spec.path || spec.write) await sdb.writeBlob(path, await draw(spec.color || '#1f6f8b', spec.w || 320, spec.h || 240));
      memos.push({ id: spec.id, description: spec.description || spec.id, category: spec.category || 'Uncategorized', tags: spec.tags || [],
        images: [path], attachments: [], ts: Date.now() - (spec.age || 0) * 60000 });
    }
    sdb.importBundle({ version: 1, memos, finance: [], planner: [] }, 'replace');
    await sdb.flush();
    window.MemoCore.getState().db.entries = sdb.loadEntries('default');
    window.MemoCore.renderFeed();
  }, specs);
}

test('search finds entries by what is in their photos', async ({ page }) => {
  await boot(page);
  await seed(page, [{ id: 'bird-1', description: 'Garden this morning' }, { id: 'plain-1', description: 'Shopping list' }]);
  await page.evaluate(() => window.MemoInsights._put([{ path: 'uploads/org-bird-1.jpg', labels: [[20, 0.91]], faces: 0 }]));
  const ids = await page.evaluate(() => {
    document.getElementById('searchBox').value = 'bird';
    window.MemoCore.renderFeed();
    return window.MemoVariant.__lastFiltered().map(e => e.id);
  });
  expect(ids).toEqual(['bird-1']);
});

test('a smart album shows its entries with a banner, and Show all clears it', async ({ page }) => {
  await boot(page);
  await seed(page, [{ id: 'r1', age: 1 }, { id: 'r2', age: 2 }, { id: 'r3', age: 3 }, { id: 'other', age: 4 }]);
  await page.evaluate(() => window.MemoInsights._put(['r1', 'r2', 'r3'].map(id => ({ path: 'uploads/org-' + id + '.jpg', labels: [[240, 0.88]] }))));
  await page.evaluate(() => window.MemoInsights.openAutoAlbum('documents'));
  await expect(page.locator('#smartViewBanner')).toBeVisible();
  await expect(page.locator('#smartViewBanner')).toContainText('Smart album: Documents');
  expect(await page.evaluate(() => window.MemoVariant.__lastFiltered().map(e => e.id))).toEqual(['r1', 'r2', 'r3']);
  await page.click('#smartViewBanner .smart-view-clear');
  await expect(page.locator('#smartViewBanner')).toBeHidden();
  expect(await page.evaluate(() => window.MemoInsights.smartView())).toBeNull();
});

test('an entry suggests tags from its photo, and one tap adds the tag', async ({ page }) => {
  await boot(page);
  await seed(page, [{ id: 'food-1', description: 'Lunch' }]);
  await page.evaluate(() => window.MemoInsights._put([{ path: 'uploads/org-food-1.jpg', labels: [[184, 0.93]] }]));
  await page.evaluate(() => window.MemoVariant.openDetail('food-1'));
  const chip = page.locator('#detailAutoSuggest .auto-suggest-chip', { hasText: '+ Food' });
  await expect(chip).toBeVisible();
  await chip.click();
  await page.waitForFunction(() => (window.MemoCore.getState().db.entries.find(e => e.id === 'food-1').tags || []).includes('Food'));
});

test('Duplicates finds a shared image, and Keep this one moves the other entry to the Bin', async ({ page }) => {
  await boot(page);
  await seed(page, [
    { id: 'dup-a', description: 'First copy', path: 'uploads/org-shared.jpg', write: true },
    { id: 'dup-b', description: 'Second copy', path: 'uploads/org-shared.jpg' },
    { id: 'solo', description: 'Unrelated', color: '#8b1f4a', w: 200, h: 300 },
  ]);
  await page.click('#hamburgerBtn');
  await page.click('#mobileAdvancedToolsBtn');
  await expect(page.locator('#advancedOrganizeSection')).toBeVisible();
  await expect(page.locator('#advancedCleanupBtn')).toBeHidden();
  await page.click('#advancedDuplicatesBtn');
  await page.waitForSelector('#duplicateReviewDlg[open] .duplicate-card', { timeout: 20000 });
  await expect(page.locator('#duplicateReviewStatus')).toContainText('Same image');
  await expect(page.locator('#duplicatePair .duplicate-card')).toHaveCount(2);
  const left = await page.evaluate(() => window.MemoDuplicates._pairs()[0]);
  await page.click('#duplicatePair .duplicate-card[data-side="a"] .duplicate-keep');
  await page.waitForFunction(id => !!window.MemoCore.getState().db.entries.find(e => e.id === id)?.deletedAt, left.b);
  expect(await page.evaluate(id => !window.MemoCore.getState().db.entries.find(e => e.id === id).deletedAt, left.a)).toBe(true);
});

test('near-identical images are paired by their brightness fingerprint', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const make = quality => new Promise(resolve => {
      const c = document.createElement('canvas'); c.width = 300; c.height = 200;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 300, 200); grad.addColorStop(0, '#123'); grad.addColorStop(1, '#fd8');
      g.fillStyle = grad; g.fillRect(0, 0, 300, 200);
      g.fillStyle = '#fff'; g.fillRect(40, 60, 120, 80);
      c.toBlob(blob => { const img = new Image(); img.onload = () => resolve(img); img.src = URL.createObjectURL(blob); }, 'image/jpeg', quality);
    });
    const D = window.MemoDuplicates;
    const a = D.dhashOf(await make(0.95)), b = D.dhashOf(await make(0.4));
    return { distance: D.hamming(a, b), self: D.hamming(a, a) };
  });
  expect(result.self).toBe(0);
  expect(result.distance).toBeLessThanOrEqual(3);
});

test('a saved search keeps the current view and reopens it', async ({ page }) => {
  await boot(page);
  await seed(page, [{ id: 's1', description: 'Coffee receipt' }, { id: 's2', description: 'Train ticket' }]);
  await page.evaluate(() => { document.getElementById('searchBox').value = 'receipt'; window.MemoCore.renderFeed(); });
  await page.evaluate(() => window.MemoSavedSearches.open());
  await page.waitForSelector('#savedSearchDlg[open]');
  await expect(page.locator('#savedSearchCurrent')).toContainText('“receipt”');
  await page.fill('#savedSearchName', 'Receipts');
  await page.click('#savedSearchSave');
  await expect(page.locator('#savedSearchList .saved-search-open')).toHaveCount(1);
  await page.evaluate(() => { document.getElementById('savedSearchDlg').close(); document.getElementById('searchBox').value = ''; window.MemoCore.renderFeed(); });
  await page.evaluate(() => window.MemoSavedSearches.open());
  await page.click('#savedSearchList .saved-search-open');
  expect(await page.evaluate(() => ({ q: document.getElementById('searchBox').value, ids: window.MemoVariant.__lastFiltered().map(e => e.id) })))
    .toEqual({ q: 'receipt', ids: ['s1'] });
});

test('saved searches travel in the backup bundle and merge by id', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(() => {
    const sdb = window.MemoStateDb;
    sdb.setItem('saved_searches', [{ id: 'a', name: 'Alpha', rule: { search: 'a' } }]);
    const bundle = sdb.exportBundle();
    sdb.setItem('saved_searches', [{ id: 'b', name: 'Beta', rule: { search: 'b' } }]);
    sdb.importBundle({ version: 1, savedSearches: bundle.savedSearches }, 'merge');
    const merged = sdb.getItem('saved_searches').map(s => s.id).sort();
    sdb.importBundle({ version: 1, memos: [], finance: [], savedSearches: bundle.savedSearches }, 'replace');
    return { exported: bundle.savedSearches.map(s => s.id), merged, replaced: sdb.getItem('saved_searches').map(s => s.id) };
  });
  expect(out).toEqual({ exported: ['a'], merged: ['a', 'b'], replaced: ['a'] });
});
