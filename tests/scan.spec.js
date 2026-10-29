// "Scan" (memo-scan.js): a Memora pairing code connects to that sync server
// after a confirm; anything else starts a new note with the text. The camera
// screen itself is Google's (QrScannerPlugin on Android), so these tests hand
// the decoded text straight to MemoScan.handle.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoScan && window.MemoCore && window.MemoStateDb?.ready() && window.MODE !== 'detecting', null, { timeout: 20000 });
}

test('pairing codes: the desktop JSON and memora:// links are read; anything unsafe is not', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(() => [
    window.MemoScan.pairing(JSON.stringify({ memora: 1, url: 'http://192.168.1.20:5050', password: 'abcd-efgh-jkmn-pqrs' })),
    window.MemoScan.pairing('memora://sync?url=' + encodeURIComponent('https://memo.example.net/') + '&password=pw'),
    window.MemoScan.pairing(JSON.stringify({ memora: 1, url: 'javascript:alert(1)' })),
    window.MemoScan.pairing('https://example.com/menu'),
    window.MemoScan.pairing('Buy milk')
  ]);
  expect(out).toEqual([
    { url: 'http://192.168.1.20:5050', password: 'abcd-efgh-jkmn-pqrs' },
    { url: 'https://memo.example.net', password: 'pw' },
    null, null, null
  ]);
});

test('a pairing code asks first, then saves the server and its password; declining changes nothing', async ({ page }) => {
  await page.route('http://192.168.1.20:5050/**', route => route.abort());   // no such server here: fail fast
  await boot(page);
  const code = JSON.stringify({ memora: 1, url: 'http://192.168.1.20:5050', password: 'abcd-efgh-jkmn-pqrs' });
  // Decline.
  let pending = page.evaluate(c => window.MemoScan.handle(c), code);
  const dlg = page.locator('#memoConfirmDlg');
  await expect(dlg).toHaveAttribute('open', '');
  await expect(dlg).toContainText('Connect to the sync server at http://192.168.1.20:5050?');
  await expect(dlg).toContainText('Plain HTTP');
  await dlg.locator('.memo-confirm-cancel, button:not(.memo-confirm-ok)').first().click();
  expect(await pending).toBe('declined');
  expect(await page.evaluate(() => localStorage.getItem('memo_server_url'))).toBe(null);
  // Accept.
  pending = page.evaluate(c => window.MemoScan.handle(c), code);
  await dlg.locator('.memo-confirm-ok').click();
  expect(await pending).toBe('connected');
  const saved = await page.evaluate(() => ({ url: localStorage.getItem('memo_server_url'), base: window.MemoContracts.getApiBase(), password: window.MemoAuth.getPassword() }));
  expect(saved).toEqual({ url: 'http://192.168.1.20:5050', base: 'http://192.168.1.20:5050', password: 'abcd-efgh-jkmn-pqrs' });
});

test('any other code becomes a new note, ready to edit, even from another page', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.MemoSpaShell && window.MemoSpaShell.switchTo('finance'));
  const result = await page.evaluate(() => window.MemoScan.handle('Wi-Fi at the cabin: guest / pine-cone-42'));
  expect(result).toBe('note');
  await expect(page.locator('#entryDlg')).toHaveAttribute('open', '');
  await expect(page.locator('#desc')).toHaveValue('Wi-Fi at the cabin: guest / pine-cone-42');
  expect(await page.evaluate(() => window.MemoSpaShell ? window.MemoSpaShell.getVariant() : 'default')).toBe('default');
  // Nothing saved until the person saves it.
  expect(await page.evaluate(() => window.MemoStateDb.loadEntries('default').length)).toBe(0);
});

test('the Scan buttons stay hidden where there is no camera scanner (browser, desktop)', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(() => window.MemoScan.available())).toBe(false);
  await expect(page.locator('#mobileScanBtn')).toBeHidden();
  await expect(page.locator('#scanPairingBtn')).toBeHidden();
  // With the tile shown (as on the phone), five tiles still fit one row with readable labels.
  const fit = await page.evaluate(() => {
    document.getElementById('mobileScanBtn').hidden = false;
    document.querySelectorAll('#mobileDiscoverBtn, #mobileVaultBtn').forEach(b => { b.hidden = false; });
    window.MemoShell.openMenu();
    const tiles = [...document.querySelectorAll('.mobile-menu .menu-tiles button.menu-tile')].filter(b => !b.hidden);
    return { count: tiles.length, tops: [...new Set(tiles.map(b => Math.round(b.getBoundingClientRect().top)))].length,
      clipped: tiles.filter(b => { const s = b.querySelector('span:last-child'); return s.scrollWidth > s.clientWidth + 1; }).map(b => b.textContent.trim()) };
  });
  expect(fit.count).toBe(5);
  expect(fit.tops).toBe(1);
  expect(fit.clipped).toEqual([]);
});
