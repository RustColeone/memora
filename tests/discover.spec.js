// Discover (memo-discover.js): the fourth tab — search everything, On this
// day, this month, up next, rediscover — with privacy rules kept.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function seed(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoDiscover && window.MemoStateDb?.ready() && window.MemoCore && window.MemoFilterBootstrapped, null, { timeout: 15000 });
  await page.evaluate(async () => {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const ts = (yy, mm, dd) => new Date(yy, mm, dd, 12).getTime();
    const iso = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const memos = [
      { id: 'otd', description: 'First snow at the cabin', category: 'Travel', tags: [], images: [], ts: ts(y - 1, m, d) },
      { id: 'old', description: 'Miso soup with tofu', category: 'Recipes', tags: [], images: [], ts: ts(y - 2, 2, 3) },
      { id: 'park', description: 'Parking spot level B2', category: 'Car', tags: ['car'], images: [], ts: Date.now() - 3600e3 },
      { id: 'safe1', description: 'Parking garage secret code', category: 'Car', tags: [], images: [], ts: Date.now(), safe: true },
    ];
    const finance = [
      { id: 'f1', description: 'Ramen night', category: 'Food', tags: [], images: [], ts: Date.now(), purchaseDate: iso(y, m, 1), total: 42.5 },
      { id: 'f2', description: 'Parking meter', category: 'Car', tags: [], images: [], ts: Date.now(), purchaseDate: iso(y, m, 1), total: 6 },
      { id: 'f-old', description: 'Last year', category: 'Food', tags: [], images: [], ts: ts(y - 1, m, 1), purchaseDate: iso(y - 1, m, 1), total: 999 },
    ];
    const planner = [{ id: 'e1', kind: 'event', title: 'Dentist', date: iso(y + 1, 0, 2), start: '15:00', createdAt: now.toISOString(), updatedAt: now.toISOString() },
      { id: 'p-park', kind: 'todo', title: 'Renew parking permit', done: false, createdAt: now.toISOString(), updatedAt: now.toISOString() }];
    window.MemoStateDb.importBundle({ version: 1, memos, finance, planner }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    window.MemoCore.renderFeed();
  });
}
const results = page => page.locator('.discover-result .discover-result-title').allTextContents();

test('the Discover tab shows today, this month, up next and rediscover; Back and other tabs leave it', async ({ page }) => {
  await seed(page);
  await page.click('#primaryNav a[data-view=discover]');
  await expect(page.locator('#discoverView')).toBeVisible();
  await expect(page.locator('#primaryNav a[data-view=discover]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#primaryNav a[data-variant=default]')).not.toHaveAttribute('aria-current', 'page');
  const body = page.locator('.discover-body');
  await expect(body).toContainText('First snow at the cabin');   // on this day, a year ago
  await expect(body).toContainText('a year ago');
  await expect(body).toContainText('$48.50');                    // this month only, last year's 999 left out
  await expect(body).toContainText('Top: Food $42.50');
  await expect(body).toContainText('Dentist');
  await expect(body).toContainText('Miso soup with tofu');       // rediscover: older than 30 days
  await expect(page.locator('.discover-invite')).toBeVisible();  // no AI key yet
  expect(await page.evaluate(() => window.MemoShell.handleSystemBack())).toBe(true);
  await expect(page.locator('#discoverView')).toBeHidden();
  await expect(page.locator('#primaryNav a[data-variant=default]')).toHaveAttribute('aria-current', 'page');
  // The current page's tab just closes Discover.
  await page.click('#primaryNav a[data-view=discover]');
  await page.click('#primaryNav a[data-variant=default]');
  await expect(page.locator('#discoverView')).toBeHidden();
  // The menu tile opens it too.
  await page.click('#hamburgerBtn');
  await page.click('#mobileDiscoverBtn');
  await expect(page.locator('#discoverView')).toBeVisible();
});

test('search reaches notes, spending and plans, with scopes and a clear button', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => window.MemoDiscover.open());
  await page.fill('.discover-search', 'parking');
  await expect(page.locator('.discover-result')).toHaveCount(4);
  expect((await results(page)).sort()).toEqual(['Parking garage secret code', 'Parking meter', 'Parking spot level B2', 'Renew parking permit']);
  await page.click('.discover-scopes [data-scope=finance]');
  expect(await results(page)).toEqual(['Parking meter']);
  await page.click('.discover-scopes [data-scope=planner]');
  expect(await results(page)).toEqual(['Renew parking permit']);
  await page.click('.discover-clear');
  await expect(page.locator('.discover-result')).toHaveCount(0);
  await expect(page.locator('.discover-body')).toContainText('On this day');
});

test('privacy: Safe notes hide at Safe level, and a locked page stays out until unlocked', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { window.MemoPrivacy.session.levels.memo = 2; window.MemoDiscover.open(); });
  await page.fill('.discover-search', 'parking');
  await expect(page.locator('.discover-result')).toHaveCount(3);
  expect(await results(page)).not.toContain('Parking garage secret code');
  await page.evaluate(() => { window.MemoPrivacy.session.levels.memo = 1; window.MemoPrivacy.session.levels.finance = 3; window.MemoPrivacy.session.appUnlocked = false; window.MemoDiscover.render(); });
  expect(await results(page)).not.toContain('Parking meter');
  await page.fill('.discover-search', '');
  await expect(page.locator('.discover-body')).not.toContainText('This month');
  await page.evaluate(() => { window.MemoPrivacy.session.appUnlocked = true; window.MemoDiscover.render(); });
  await expect(page.locator('.discover-body')).toContainText('This month');
});

test('a result opens the note on its own page', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => window.MemoDiscover.open());
  await page.fill('.discover-search', 'spot level');
  await page.click('.discover-result');
  await expect(page.locator('#discoverView')).toBeHidden();
  await expect(page.locator('#detailDlg')).toHaveAttribute('open', '');
  await expect(page.locator('#detailDlg')).toContainText('Parking spot level B2');
});

test('a Safe note stays Safe after the app reloads', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    window.MemoPrivacy.session.levels.memo = 2;
    await window.MemoPrivacy.setEntriesSafe(['park'], true);
    await window.MemoStateDb.flush();
  });
  await page.reload();
  await page.waitForFunction(() => window.MemoStateDb?.ready() && window.MemoCore?.getState().db.entries.some(e => e.id === 'park'), null, { timeout: 15000 });
  const flags = await page.evaluate(() => ({
    stored: window.MemoStateDb.loadEntries('default').find(e => e.id === 'park').safe,
    other: window.MemoStateDb.loadEntries('default').find(e => e.id === 'otd').safe,
  }));
  expect(flags).toEqual({ stored: true, other: undefined });
});
