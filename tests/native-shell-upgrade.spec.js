const { test, expect } = require('@playwright/test');
const fs = require('fs');
const html = fs.readFileSync('android/app/src/main/assets/native-start.html','utf8');
test.use({ serviceWorkers:'allow' });

test('native preparation retires the old worker and only shell caches before reporting ready', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.evaluate(async () => {
    await (await caches.open('memora-shell-obsolete')).put('/obsolete.js', new Response('old code'));
    await (await caches.open('memora-uploads-preserved')).put('/photo', new Response('original bytes'));
    localStorage.setItem('native-upgrade-draft-probe','keep');
    window.NativeShell = { ready:() => { window.__prepared = true; } };
  });
  // Supply the trusted startup HTML directly here. Real native URL interception
  // and WebView service-worker cleanup are covered on connected devices.
  await page.setContent(html);
  await page.waitForFunction(() => window.__prepared);
  expect(await page.evaluate(async () => ({
    registrations:(await navigator.serviceWorker.getRegistrations()).length,
    shell:(await caches.keys()).filter(key=>key.startsWith('memora-shell-')),
    upload:await (await (await caches.open('memora-uploads-preserved')).match('/photo')).text(),
    draft:localStorage.getItem('native-upgrade-draft-probe')
  }))).toEqual({registrations:0,shell:[],upload:'original bytes',draft:'keep'});
});

test('failed shell preparation offers retry without starting the app or deleting user storage', async ({ page }) => {
  await page.goto('/queue-harness.html');
  await page.evaluate(async () => {
    window.NativeShell = { ready:() => { window.__prepared = true; } };
    const original=caches.delete.bind(caches);
    await caches.open('memora-shell-obsolete');
    caches.delete = async name => { if (!window.__allowDelete) throw new Error('Storage busy'); return original(name); };
    localStorage.setItem('native-upgrade-draft-probe','keep');
  });
  await page.setContent(html); await expect(page.locator('#failure')).toBeVisible();
  expect(await page.evaluate(() => !!window.__prepared)).toBe(false);
  await page.evaluate(() => { window.__allowDelete = true; }); await page.click('#retry');
  await page.waitForFunction(() => window.__prepared);
  expect(await page.evaluate(() => localStorage.getItem('native-upgrade-draft-probe'))).toBe('keep');
});
