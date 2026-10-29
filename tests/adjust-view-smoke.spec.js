const { test, expect } = require('@playwright/test');

test('Adjust View button opens the dialog and ✕ closes it', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoView && document.getElementById('viewSettingsDlg'), null, { timeout: 15000 });

  const opened = await page.evaluate(() => {
    document.getElementById('mobileAdjustViewBtn').click();
    return document.getElementById('viewSettingsDlg').open;
  });
  expect(opened).toBe(true);

  const closing = await page.evaluate(() => {
    document.querySelector('#viewSettingsDlg .modal-close').click();
    const dialog = document.getElementById('viewSettingsDlg');
    return { open: dialog.open, closing: dialog.classList.contains('closing') };
  });
  expect(closing).toEqual({ open: true, closing: true });
  await page.waitForFunction(() => !document.getElementById('viewSettingsDlg').open);
});
