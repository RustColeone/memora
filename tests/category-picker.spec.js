// Phase 3 — category picker. Searchable, toggles list ⇄ card (persisted); picking a
// category sets #categoryInput (creating it if new) and closes.
const { test, expect } = require('@playwright/test');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function boot(page) {
  await page.goto('/index.html');
  await page.evaluate(() => window.MemoAppReady);
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready() && window.MemoCategoryPicker, null, { timeout: 15000 });
}
async function openModal(page) {
  await page.evaluate(() => document.getElementById('fab').click());
  await page.waitForSelector('#entryDlg[open]');
}

test('list/card toggle persists; picking sets categoryInput; a new name is created and selected', async ({ page }) => {
  await boot(page);
  await page.evaluate((png) => {
    const s = window.MemoCore.getState();
    s.settings.categories = ['Work', 'Home', 'Receipts'];
    s.db.entries = [
      { id: 'a', category: 'Work', tags: [], images: [png], ts: 3 },
      { id: 'b', category: 'Work', tags: [], images: [], ts: 2 },
      { id: 'c', category: 'Home', tags: [], images: [], ts: 1 },
    ];
  }, PNG);
  await openModal(page);                       // populates #categoryInput from settings.categories
  await page.evaluate(() => window.MemoCategoryPicker.open());
  await page.waitForSelector('#catPickerDlg[open]');

  // The picker defaults to list and derives folders from this variant's entries.
  await expect(page.locator('#catPickList')).toHaveClass(/catpick-list/);
  await expect(page.locator('#catPickList [data-cat]')).toHaveCount(3);
  await expect(page.locator('#catPickList [data-cat="Receipts"]')).toHaveCount(0);
  await expect(page.locator('#catPickList [data-cat="Work"]')).toContainText('2');

  await page.click('#catPickViewCard');
  await expect(page.locator('#catPickList')).toHaveClass(/catpick-card/);
  expect(await page.evaluate(() => localStorage.getItem('memoCatPickView'))).toBe('card');
  await page.locator('#catPickerDlg .modal-close').click();
  await page.evaluate(() => window.MemoCategoryPicker.open());
  await expect(page.locator('#catPickList')).toHaveClass(/catpick-card/);
  await page.click('#catPickViewList');
  await expect(page.locator('#catPickList')).toHaveClass(/catpick-list/);
  expect(await page.evaluate(() => localStorage.getItem('memoCatPickView'))).toBe('list');

  // search filters
  await page.fill('#catPickSearch', 'ho');
  await page.evaluate(() => document.getElementById('catPickSearch').dispatchEvent(new Event('input')));
  expect(await page.evaluate(() => document.querySelectorAll('#catPickList [data-cat]').length)).toBe(1); // Home

  // pick Home → categoryInput updates, dialog closes
  await page.click('#catPickList [data-cat="Home"]');
  await page.waitForFunction(() => !document.getElementById('catPickerDlg').open);
  expect(await page.evaluate(() => document.getElementById('categoryInput').value)).toBe('Home');

  // reopen; a brand-new category via Enter is created + selected
  await page.evaluate(() => window.MemoCategoryPicker.open());
  await page.waitForSelector('#catPickerDlg[open]');
  await page.fill('#catPickSearch', 'Taxes2026');
  await page.press('#catPickSearch', 'Enter');
  await page.waitForFunction(() => !document.getElementById('catPickerDlg').open);
  const r = await page.evaluate(() => ({
    val: document.getElementById('categoryInput').value,
    inCats: window.MemoCore.getState().settings.categories.includes('Taxes2026'),
  }));
  expect(r.val).toBe('Taxes2026');
  expect(r.inCats).toBe(true);
});
