// Offline-blob adapter — image bytes persist app-private (OPFS) and survive a
// reload, with object URLs regenerated and the entry's images stored as stable
// server-symmetric /uploads/<...> paths (never ephemeral blob: URLs).
const { test, expect } = require('@playwright/test');

// 1x1 transparent PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function waitForBoot(page) {
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready(),
    null, { timeout: 15000 }
  );
}

test('offline image bytes persist in OPFS and rehydrate after reload', async ({ page }) => {
  await page.goto('/index.html');
  await waitForBoot(page);

  const origLen = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const rel = 'uploads/2099-01-01/t.png';
    await window.MemoStateDb.writeBlob(rel, new Blob([bytes], { type: 'image/png' }));
    window.MemoStateDb.saveEntries(
      [{ id: 'img-1', description: 'has image', _storedPaths: [rel], images: ['blob:ephemeral'], ts: Date.now() }],
      'default'
    );
    await window.MemoStateDb.flush();
    return bytes.length;
  }, PNG_B64);

  await page.reload();
  await waitForBoot(page);

  const result = await page.evaluate(async () => {
    const rows = window.MemoStateDb.loadEntries('default') || [];
    const e = rows.find((r) => r.id === 'img-1');
    if (!e) return { found: false };
    const persistedPath = e.images[0];     // stable path, not a blob: URL
    const rel = e._storedPaths[0];
    await window.MemoStateDb.hydrateImages(e);
    const url = e.images[0];
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    return { found: true, persistedPath, rel, isBlob: url.indexOf('blob:') === 0, len: buf.length };
  });

  expect(result.found).toBe(true);
  expect(result.persistedPath).toBe('/uploads/2099-01-01/t.png'); // persisted as a path
  expect(result.rel).toBe('uploads/2099-01-01/t.png');
  expect(result.isBlob).toBe(true);                                // rehydrated to object URL
  expect(result.len).toBe(origLen);                                // bytes intact
});
