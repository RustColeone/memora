// Explicit opt-in device profile. Preserves records and refuses existing drafts.
const { chromium, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const serial = process.argv[2];
if (!serial || !/^[\w-]+$/.test(serial)) throw new Error('Pass an authorized Android serial');
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const app = 'com.laplacengan.memora';
let browser, port;
(async () => {
  try {
    adb('shell', 'am', 'start', '-W', '-n', app + '/.MainActivity');
    const pid = adb('shell', 'pidof', app);
    port = adb('forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true });
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => !!window.MemoAppReady); await page.evaluate(() => MemoAppReady);
    const fingerprint = () => page.evaluate(async () => {
      const value = JSON.stringify([MemoStateDb.loadEntries('default'), MemoStateDb.loadEntries('finance'), MemoStateDb.loadDocs('planner')]);
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).join(',');
    });
    const before = await fingerprint();
    if (await page.evaluate(async () => !!await MemoImageDraft.read(MEMO_VARIANT, false))) throw new Error('An image recovery draft exists; leave it intact.');
    if (await page.locator('#entryDlg[open]').count()) throw new Error('An entry draft is open; leave it intact.');
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 4000; canvas.height = 3000;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, 4000, 3000);
      ctx.fillStyle = '#345'; for (let y = 20; y < 3000; y += 70) ctx.fillRect(50, y, 2000 + y / 3, 22);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .94));
      canvas.width = canvas.height = 1;
      await MemoImageEditor.open(new File([blob], 'memora-export-profile.jpg', { type: 'image/jpeg' }));
    });
    await page.click('#mieRotateRight'); await page.click('#mieAdjustTool');
    await page.locator('#mieBrightness').fill('13'); await page.locator('#mieBrightness').dispatchEvent('input');
    await page.click('#mieApply'); await page.click('#mieDownload');
    await expect(page.locator('#mieStatus')).toHaveText('Copy saved to device. Original kept.', { timeout: 60000 });
    const phases = await page.evaluate(() => ({ editor: MemoImageExportTimings, gallery: MemoGalleryTimings }));
    await page.click('#mieClose');
    expect(await fingerprint()).toBe(before);
    fs.mkdirSync('.playwright/export-profile', { recursive: true });
    fs.writeFileSync('.playwright/export-profile/' + serial + '.json', JSON.stringify(phases, null, 2));
    console.log(JSON.stringify(phases, null, 2));
  } finally {
    if (browser) await browser.close();
    if (port) adb('forward', '--remove', 'tcp:' + port);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
