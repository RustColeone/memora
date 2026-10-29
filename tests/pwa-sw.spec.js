// PWA: the service worker registers, controls the page, and caches the app shell
// so a warm load serves /static from Cache Storage (not the network). The manifest
// is present + valid. (Feature specs block the SW via playwright.config; this one
// opts back in.)
const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'allow' });

test('service worker registers, caches the shell, and the manifest is valid', async ({ page }) => {
  await page.goto('/index.html');
  // SW installs during first load; wait until it's active.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

  // Reload so the now-active SW controls the page and its /static fetches go through
  // the cache-first handler (populating Cache Storage).
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 });
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });

  const info = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = names.find(n => n.indexOf('memora-shell-') === 0);
    let staticCached = false;
    if (shell) {
      const keys = await (await caches.open(shell)).keys();
      staticCached = keys.some(r => r.url.indexOf('/static/') !== -1);
    }
    return { names, shell: !!shell, staticCached, controlled: !!navigator.serviceWorker.controller };
  });
  expect(info.controlled).toBe(true);            // SW is driving requests
  expect(info.shell).toBe(true);                 // versioned shell cache exists
  expect(info.staticCached).toBe(true);          // app-shell assets are cached (no re-fetch on warm load)

  // Manifest is linked + serves valid JSON.
  expect(await page.evaluate(() => !!document.querySelector('link[rel="manifest"]'))).toBe(true);
  const man = await page.evaluate(() => fetch('/manifest.webmanifest').then(r => r.json()));
  expect(man.name).toBe('Memora');
  expect(man.start_url).toBe('/');
  expect(Array.isArray(man.icons) && man.icons.length).toBeTruthy();
});

test('the /api path is never intercepted by the SW (stays live)', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 });
  // /api/* must not be cached (the static server 404s it; the point is the SW must
  // not answer it from cache — it returns undefined from the fetch handler).
  const apiCached = await page.evaluate(async () => {
    const names = await caches.keys();
    for (const n of names) {
      const keys = await (await caches.open(n)).keys();
      if (keys.some(r => r.url.indexOf('/api/') !== -1)) return true;
    }
    return false;
  });
  expect(apiCached).toBe(false);
});
