// Responsive dialog actions, overflow detail menus, and the standalone Advanced
// tools chooser. These tests cover the source-level accessibility contracts as
// well as the device-file launch paths.
const { test, expect } = require('@playwright/test');

const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3nQAAAABJRU5ErkJggg==', 'base64');
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function bootMemo(page, narrow = false) {
  if (narrow) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoAdvancedTools && window.MemoPanel && window.MemoGifEditor, null, { timeout: 15000 });
}

test('narrow media footers use compact labels and preserve accessible names and icons', async ({ page }) => {
  await bootMemo(page, true);

  const state = await page.evaluate(() => ({
    downloadFull: getComputedStyle(document.querySelector('#gifEditorDownloadBtn .action-label-full')).display,
    downloadCompact: getComputedStyle(document.querySelector('#gifEditorDownloadBtn .action-label-compact')).display,
    saveFull: getComputedStyle(document.querySelector('#gifEditorSaveEntryBtn .action-label-full')).display,
    saveCompact: getComputedStyle(document.querySelector('#gifEditorSaveEntryBtn .action-label-compact')).display,
    shareFull: getComputedStyle(document.querySelector('#gifEditorShareBtn .action-label-full')).display,
    shareLabel: document.getElementById('gifEditorShareBtn').getAttribute('aria-label'),
    downloadLabel: document.getElementById('gifEditorDownloadBtn').getAttribute('aria-label'),
    saveLabel: document.getElementById('gifEditorSaveEntryBtn').getAttribute('aria-label'),
    detailIcons: [
      !!document.querySelector('#deleteBtn .svg-icon-trash'),
      !!document.querySelector('#editBtn .svg-icon-edit'),
      !!document.querySelector('#tagPickClose .svg-icon-check'),
    ],
    mediaCloseButtons: [
      'closePanelBtn', 'closePanelBtn2', 'gifEditorCloseBtn', 'gifEditorCloseBtn2',
      'libPickClose', 'metadataEditorClose',
    ].map(id => document.getElementById(id)?.classList.contains('modal-close')),
    metadataDateMatchesTextInput:
      getComputedStyle(document.getElementById('metadataCapturedAt')).backgroundColor
        === getComputedStyle(document.getElementById('metadataCreator')).backgroundColor,
  }));

  expect(state.downloadFull).toBe('none');
  expect(state.downloadCompact).not.toBe('none');
  expect(state.saveFull).toBe('none');
  expect(state.saveCompact).not.toBe('none');
  expect(state.shareFull).toBe('none');
  expect(state.shareLabel).toBe('Share GIF');
  expect(state.downloadLabel).toBe('Download GIF');
  expect(state.saveLabel).toBe('Save as a new entry');
  expect(state.detailIcons).toEqual([true, true, true]);
  expect(state.mediaCloseButtons).toEqual([true, true, true, true, true, true]);
  expect(state.metadataDateMatchesTextInput).toBe(true);
});

test('Advanced tools opens each tool before its device or library choice', async ({ page }) => {
  await bootMemo(page);

  await page.click('#hamburgerBtn');
  await page.click('#mobileAdvancedToolsBtn');
  await page.waitForSelector('#advancedToolsDlg[open]');
  expect(await page.evaluate(() => document.getElementById('mobileMenu').classList.contains('open'))).toBe(false);
  await expect(page.locator('#advancedToolsDlg [data-section="create"] .advanced-tool:visible, #advancedToolsDlg [data-section="edit"] .advanced-tool:visible')).toHaveCount(4);
  await expect(page.locator('#advancedToolsDlg [data-section="organize"] .advanced-tool:visible')).toHaveCount(3);
  await expect(page.locator('#advancedPanelLibBtn, #advancedGifLibBtn, #advancedPanelInput, #advancedGifInput')).toHaveCount(0);

  await page.click('#advancedPanelBtn');
  await page.waitForSelector('#panelDlg[open]');
  await expect(page.locator('#panelPage1')).toBeVisible();
  await page.setInputFiles('#panelFileInput', [
    { name: 'one.png', mimeType: 'image/png', buffer: PIXEL_PNG },
    { name: 'two.png', mimeType: 'image/png', buffer: PIXEL_PNG },
  ]);
  await expect(page.locator('#panelList .panel-card')).toHaveCount(2);
  await expect(page.locator('#panelCombineBtn')).toBeEnabled();
  await page.evaluate(() => window.MemoPanel.close());

  await page.click('#hamburgerBtn');
  await page.click('#mobileAdvancedToolsBtn');
  await page.click('#advancedGifEditorBtn');
  await page.waitForSelector('#gifEditorDlg[open]', { timeout: 15000 });
  await expect(page.locator('#gifEditorPage1')).toBeVisible();
  await page.setInputFiles('#gifEditorFileInput', [{ name: 'tiny.gif', mimeType: 'image/gif', buffer: PIXEL_GIF }]);
  await page.waitForFunction(() => window.MemoGifEditor.__state().frameCount > 0);
  await expect(page.locator('#gifEditorPage2')).toBeVisible();
  expect(await page.evaluate(() => window.MemoGifEditor.__state().frameCount)).toBeGreaterThan(0);
});

test('Planner exposes export-only Advanced tools without loading the Memo editor', async ({ page }) => {
  await page.goto('/planner.html');
  await page.waitForFunction(() => window.Planner && window.MemoAdvancedTools && window.MemoPanel && window.MemoGifEditor, null, { timeout: 15000 });
  expect(await page.evaluate(() => typeof window.MemoCore)).toBe('undefined');

  await page.click('#hamburgerBtn');
  await page.click('#mobileAdvancedToolsBtn');
  await page.waitForSelector('#advancedToolsDlg[open]');
  await expect(page.locator('#advancedExifBtn')).toBeHidden();
  await page.click('#advancedPanelBtn');
  await page.waitForSelector('#panelDlg[open]');
  await expect(page.locator('.panel-add-library')).toBeHidden();
  await page.setInputFiles('#panelFileInput', [
    { name: 'one.png', mimeType: 'image/png', buffer: PIXEL_PNG },
    { name: 'two.png', mimeType: 'image/png', buffer: PIXEL_PNG },
  ]);
  expect(await page.evaluate(() => document.getElementById('panelSaveEntryBtn').hidden)).toBe(true);

  await page.evaluate(() => window.MemoPanel.close());
  await page.click('#hamburgerBtn');
  await page.click('#mobileAdvancedToolsBtn');
  await page.click('#advancedGifEditorBtn');
  await page.waitForSelector('#gifEditorDlg[open]');
  await expect(page.locator('#gifEditorFromLibraryBtn')).toBeHidden();
});

test('Finance details place secondary table and media actions in the overflow menu', async ({ page }) => {
  await page.goto('/finance.html');
  await page.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready() && window.MemoCore && window.MemoVariant, null, { timeout: 15000 });

  const items = await page.evaluate(async () => {
    window.MemoStateDb.saveEntries([{
      id: 'finance-detail-menu', description: 'Receipt', category: 'Work', tags: [], images: [],
      purchaseDate: '2025-01-01', tax: '0', total: 10,
      items: [{ name: 'Coffee', description: '', amount: 1, unitPrice: 10, totalPrice: 10 }],
    }], 'finance');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('finance');
    window.MemoVariant.openDetail('finance-detail-menu');
    return {
      open: document.getElementById('detailDlg').open,
      menuVisible: getComputedStyle(document.getElementById('detailMenuBtn')).display !== 'none',
      footer: document.querySelector('#detailDlg .actions').textContent.replace(/\s+/g, ' ').trim(),
      menu: Array.from(document.querySelectorAll('#detailMenuPopup .modal-menu-item')).map(item => item.textContent.trim()),
      inlineCopy: !!document.getElementById('copyCsvBtn'),
    };
  });

  expect(items.open).toBe(true);
  expect(items.menuVisible).toBe(true);
  expect(items.footer).toContain('Delete');
  expect(items.footer).toContain('Edit');
  expect(items.menu).toContain('Copy table as CSV');
  expect(items.inlineCopy).toBe(false);
});
