// The shared chrome shell (memo-shell.js): theme toggle + hamburger menu must
// work identically on all three pages.
const { test, expect } = require('@playwright/test');

for (const page of ['index.html', 'finance.html', 'planner.html']) {
  test(`${page}: theme toggle + hamburger menu via memo-shell`, async ({ page: p }) => {
    await p.goto('/' + page);
    await p.waitForFunction(() => window.MemoShell, null, { timeout: 15000 });

    // Theme starts dark; the menu's Theme tile opens the Theme sheet, where
    // Light switches mode (data-theme set, choice stored) and Dark switches back.
    const before = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await p.click('#hamburgerBtn');
    await p.click('#mobileThemeBtn');
    await expect(p.locator('#themeDlg')).toHaveAttribute('open', '');
    expect(await p.locator('#mobileMenu.open').count()).toBe(0);
    await p.click('#themeDlg [data-theme-mode="light"]');
    const afterLight = await p.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      pressed: document.querySelector('#themeDlg [data-theme-mode="light"]').getAttribute('aria-pressed'),
      stored: localStorage.getItem('memoTheme'),
    }));
    expect(before).toBe(null);              // default dark
    expect(afterLight.theme).toBe('light');
    expect(afterLight.pressed).toBe('true');
    expect(afterLight.stored).toBe('light');
    await p.click('#themeDlg [data-theme-mode="dark"]');
    expect(await p.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(null);
    await p.evaluate(() => document.getElementById('themeDlg').close());

    // Hamburger opens the mobile menu; close button closes it.
    await p.click('#hamburgerBtn');
    expect(await p.evaluate(() => document.getElementById('mobileMenu').classList.contains('open'))).toBe(true);
    await p.click('#mobileMenuClose');
    expect(await p.evaluate(() => document.getElementById('mobileMenu').classList.contains('open'))).toBe(false);

    // Re-open, then Escape closes it.
    await p.click('#hamburgerBtn');
    await p.keyboard.press('Escape');
    expect(await p.evaluate(() => document.getElementById('mobileMenu').classList.contains('open'))).toBe(false);
  });
}

test('each mode keeps its own look; System follows the device and the boot script paints it first', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.goto('/index.html');
  await p.waitForFunction(() => window.MemoShell && window.MemoShell.openThemeSheet, null, { timeout: 15000 });
  const look = () => p.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), look: document.documentElement.getAttribute('data-look'),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }));
  await p.evaluate(() => window.MemoShell.openThemeSheet());
  await p.click('#themeDlg [data-look="midnight"]');
  expect(await look()).toEqual({ theme: null, look: 'midnight', bg: '#000000' });
  // Picking a light look switches to light and shows it; the dark pick is kept.
  await p.click('#themeDlg [data-look="paper"]');
  expect(await look()).toEqual({ theme: 'light', look: 'paper', bg: '#f6f1e7' });
  // System + a dark device → the dark look; flip the device to light → the light look.
  await p.click('#themeDlg [data-theme-mode="system"]');
  expect(await look()).toEqual({ theme: null, look: 'midnight', bg: '#000000' });
  await p.emulateMedia({ colorScheme: 'light' });
  await expect.poll(look).toEqual({ theme: 'light', look: 'paper', bg: '#f6f1e7' });
  // Graphite is the base dark palette: no data-look at all.
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.click('#themeDlg [data-look="graphite"]');
  expect(await look()).toEqual({ theme: null, look: null, bg: '#17181b' });
  // The pre-paint boot script applies mode + look before any app script runs.
  await p.click('#themeDlg [data-look="sage"]');
  await p.addInitScript(() => document.addEventListener('readystatechange', () => {
    if (document.readyState === 'interactive') window.__bootLook = [document.documentElement.getAttribute('data-theme'), document.documentElement.getAttribute('data-look')];
  }));
  await p.reload();
  await p.waitForFunction(() => window.__bootLook);
  expect(await p.evaluate(() => window.__bootLook)).toEqual([null, 'sage']);
  await ctx.close();
});
