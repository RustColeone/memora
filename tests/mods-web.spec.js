// Mods on a plain web page (no desktop app, no Android, not served by a
// Memora server): nothing loads, and Settings says where mods work.
const { test, expect } = require('@playwright/test');

test('a plain web page has no mods and says where they work', async ({ page }) => {
  const asked = [];
  page.on('request', (r) => { if (/\/(api\/)?mods\b/.test(new URL(r.url()).pathname)) asked.push(r.url()); });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoAppReady && window.MemoMods);
  await page.evaluate(() => window.MemoMods.start());
  expect(await page.evaluate(() => window.MemoMods.list())).toEqual([]);
  expect(asked).toEqual([]);
  await expect(page.locator('#settingsDlg #modsSection')).toContainText('Mods work in the desktop app, the Android app and on pages opened from a Memora server.');
  expect(await page.evaluate(() => typeof window.Memora.mod)).toBe('function');
});
