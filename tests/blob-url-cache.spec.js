const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.addInitScript(() => {
    window.__MEMO_STATE_DB_TEST__ = true;
    window.__memoBlobUrlProbe = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.__memoBlobUrlProbe.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.__memoBlobUrlProbe.revoked.push(url);
      return revoke(url);
    };
  });
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready() &&
      window.MemoStateDb.__test && window.MemoStateDb.__test.resetBlobUrlCache,
    null,
    { timeout: 15000 }
  );
}

test('multi-image hydration reuses one cached Object URL per stable path', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const db = window.MemoStateDb;
    db.__test.resetBlobUrlCache({ maxEntries: 8 });
    window.__memoBlobUrlProbe.created.length = 0;
    window.__memoBlobUrlProbe.revoked.length = 0;
    const paths = ['uploads/cache/reuse-a.png', 'uploads/cache/reuse-b.png'];
    await db.writeBlob(paths[0], new Blob(['a'], { type: 'image/png' }));
    await db.writeBlob(paths[1], new Blob(['b'], { type: 'image/png' }));
    const entry = { id: 'reuse', _storedPaths: paths.slice(), images: paths.map(db.relToUrl) };

    await db.hydrateImages(entry);
    const first = entry.images.slice();
    await db.hydrateImages(entry);
    const second = entry.images.slice();
    return {
      first,
      second,
      created: window.__memoBlobUrlProbe.created.slice(),
      stats: db.__test.blobUrlCacheStats(),
    };
  });

  expect(result.first).toEqual(result.second);
  expect(result.first).toHaveLength(2);
  expect(result.first.every((url) => url.startsWith('blob:'))).toBe(true);
  expect(result.created).toHaveLength(2);
  expect(result.stats.keys).toEqual([
    'uploads/cache/reuse-a.png',
    'uploads/cache/reuse-b.png',
  ]);
});

test('LRU eviction bounds unmounted cached URLs and revokes the oldest', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const db = window.MemoStateDb;
    db.__test.resetBlobUrlCache({ maxEntries: 2 });
    window.__memoBlobUrlProbe.revoked.length = 0;
    const paths = ['uploads/cache/lru-a.png', 'uploads/cache/lru-b.png', 'uploads/cache/lru-c.png'];
    for (const path of paths) await db.writeBlob(path, new Blob([path], { type: 'image/png' }));
    const urls = [];
    for (const path of paths) urls.push(await db.blobUrl(path));
    db.__test.flushBlobUrlRevocations(false);
    return {
      urls,
      revoked: window.__memoBlobUrlProbe.revoked.slice(),
      stats: db.__test.blobUrlCacheStats(),
    };
  });

  expect(result.stats.size).toBe(2);
  expect(result.stats.keys).toEqual(['uploads/cache/lru-b.png', 'uploads/cache/lru-c.png']);
  expect(result.revoked).toContain(result.urls[0]);
  expect(result.revoked).not.toContain(result.urls[1]);
  expect(result.revoked).not.toContain(result.urls[2]);
});

test('blob replacement and deletion invalidate cached URLs and restore owner paths', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const db = window.MemoStateDb;
    db.__test.resetBlobUrlCache({ maxEntries: 4 });
    window.__memoBlobUrlProbe.revoked.length = 0;
    const path = 'uploads/cache/replace.png';
    const entry = { id: 'replace', _storedPaths: [path], images: [db.relToUrl(path)] };

    await db.writeBlob(path, new Blob(['old'], { type: 'image/png' }));
    await db.hydrateImages(entry);
    const oldUrl = entry.images[0];
    await db.writeBlob(path, new Blob(['new'], { type: 'image/png' }));
    db.__test.flushBlobUrlRevocations(false);
    const afterReplace = entry.images.slice();

    await db.hydrateImages(entry);
    const newUrl = entry.images[0];
    await db.deleteBlob(path);
    db.__test.flushBlobUrlRevocations(false);
    const afterDelete = entry.images.slice();
    await db.hydrateImages(entry);

    return {
      oldUrl,
      newUrl,
      afterReplace,
      afterDelete,
      finalImages: entry.images.slice(),
      finalPaths: entry._storedPaths.slice(),
      revoked: window.__memoBlobUrlProbe.revoked.slice(),
    };
  });

  expect(result.newUrl).not.toBe(result.oldUrl);
  expect(result.afterReplace).toEqual(['/uploads/cache/replace.png']);
  expect(result.afterDelete).toEqual(['/uploads/cache/replace.png']);
  // Removing cached bytes does not delete the entry's image reference. It may
  // still be available on the sync server and can be downloaded again.
  expect(result.finalImages).toEqual(['/uploads/cache/replace.png']);
  expect(result.finalPaths).toEqual(['uploads/cache/replace.png']);
  expect(result.revoked).toEqual(expect.arrayContaining([result.oldUrl, result.newUrl]));
});

test('mounted detail and open reader defer eviction until a later retry', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const db = window.MemoStateDb;
    db.__test.resetBlobUrlCache({ maxEntries: 1 });
    window.__memoBlobUrlProbe.revoked.length = 0;
    const paths = ['uploads/cache/mount-a.png', 'uploads/cache/mount-b.png', 'uploads/cache/mount-c.png'];
    for (const path of paths) await db.writeBlob(path, new Blob([path], { type: 'image/png' }));

    const first = await db.blobUrl(paths[0]);
    const detail = document.getElementById('detailDlg');
    detail.setAttribute('open', '');
    const mounted = document.createElement('img');
    mounted.src = first;
    detail.appendChild(mounted);
    await db.blobUrl(paths[1]);
    db.__test.flushBlobUrlRevocations(false);
    const detailDeferred = !window.__memoBlobUrlProbe.revoked.includes(first);
    const detailPending = db.__test.blobUrlCacheStats().pending;

    mounted.remove();
    detail.removeAttribute('open');
    db.__test.flushBlobUrlRevocations(false);
    const detailReleased = window.__memoBlobUrlProbe.revoked.includes(first);

    const second = (await db.blobUrl(paths[1]));
    let reader = document.getElementById('urDlg');
    if (!reader) {
      reader = document.createElement('dialog');
      reader.id = 'urDlg';
      document.body.appendChild(reader);
    }
    reader.setAttribute('open', '');
    await db.blobUrl(paths[2]);
    db.__test.flushBlobUrlRevocations(false);
    const readerDeferred = !window.__memoBlobUrlProbe.revoked.includes(second);
    const readerPending = db.__test.blobUrlCacheStats().pending;

    reader.removeAttribute('open');
    db.__test.flushBlobUrlRevocations(false);
    const readerReleased = window.__memoBlobUrlProbe.revoked.includes(second);
    return { detailDeferred, detailPending, detailReleased, readerDeferred, readerPending, readerReleased };
  });

  expect(result).toEqual({
    detailDeferred: true,
    detailPending: 1,
    detailReleased: true,
    readerDeferred: true,
    readerPending: 1,
    readerReleased: true,
  });
});

test('one oversized detail hydration keeps every URL alive until the action surface mounts', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const db = window.MemoStateDb;
    db.__test.resetBlobUrlCache({ maxEntries: 2 });
    window.__memoBlobUrlProbe.revoked.length = 0;
    const paths = [
      'uploads/cache/detail-batch-a.png',
      'uploads/cache/detail-batch-b.png',
      'uploads/cache/detail-batch-c.png',
    ];
    for (const path of paths) await db.writeBlob(path, new Blob([path], { type: 'image/png' }));
    const entry = { id: 'detail-batch', _storedPaths: paths.slice(), images: paths.map(db.relToUrl) };

    await db.hydrateImages(entry);
    const detail = document.getElementById('detailDlg');
    detail.setAttribute('open', '');
    entry.images.forEach(url => {
      const image = document.createElement('img');
      image.src = url;
      detail.appendChild(image);
    });
    db.__test.flushBlobUrlRevocations(false);
    const out = {
      images: entry.images.slice(),
      revoked: window.__memoBlobUrlProbe.revoked.slice(),
      pending: db.__test.blobUrlCacheStats().pending,
    };
    detail.querySelectorAll('img').forEach(image => image.remove());
    detail.removeAttribute('open');
    return out;
  });

  expect(result.images.every(url => url.startsWith('blob:'))).toBe(true);
  expect(result.images.some(url => result.revoked.includes(url))).toBe(false);
  expect(result.pending).toBe(1);
});

test('entry editor, panel, and GIF surfaces defer shared-cache eviction until close', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const db = window.MemoStateDb;
    const outcomes = [];
    for (const [index, id] of ['entryDlg', 'panelDlg', 'gifEditorDlg'].entries()) {
      db.__test.resetBlobUrlCache({ maxEntries: 1 });
      window.__memoBlobUrlProbe.revoked.length = 0;
      const activePath = `uploads/cache/action-${index}-active.png`;
      const pressurePath = `uploads/cache/action-${index}-pressure.png`;
      await db.writeBlob(activePath, new Blob(['active'], { type: 'image/png' }));
      await db.writeBlob(pressurePath, new Blob(['pressure'], { type: 'image/png' }));
      const activeUrl = await db.blobUrl(activePath);
      const dialog = document.getElementById(id);
      dialog.setAttribute('open', '');
      const image = document.createElement('img');
      image.src = activeUrl;
      dialog.appendChild(image);

      await db.blobUrl(pressurePath);
      db.__test.flushBlobUrlRevocations(false);
      const deferred = !window.__memoBlobUrlProbe.revoked.includes(activeUrl);
      image.remove();
      dialog.removeAttribute('open');
      db.__test.flushBlobUrlRevocations(false);
      outcomes.push({ id, deferred, released: window.__memoBlobUrlProbe.revoked.includes(activeUrl) });
    }
    return outcomes;
  });

  expect(result).toEqual([
    { id: 'entryDlg', deferred: true, released: true },
    { id: 'panelDlg', deferred: true, released: true },
    { id: 'gifEditorDlg', deferred: true, released: true },
  ]);
});

test('pagehide force-disposes cached and mounted Object URLs', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const db = window.MemoStateDb;
    db.__test.resetBlobUrlCache({ maxEntries: 4 });
    window.__memoBlobUrlProbe.revoked.length = 0;
    const paths = ['uploads/cache/hide-a.png', 'uploads/cache/hide-b.png'];
    for (const path of paths) await db.writeBlob(path, new Blob([path], { type: 'image/png' }));
    const urls = [await db.blobUrl(paths[0]), await db.blobUrl(paths[1])];
    const holder = document.createElement('div');
    urls.forEach((url) => { const image = document.createElement('img'); image.src = url; holder.appendChild(image); });
    document.body.appendChild(holder);

    window.dispatchEvent(new Event('pagehide'));
    return {
      urls,
      revoked: window.__memoBlobUrlProbe.revoked.slice(),
      stats: db.__test.blobUrlCacheStats(),
    };
  });

  expect(result.stats).toMatchObject({ size: 0, pending: 0, disposed: true });
  expect(result.revoked).toEqual(expect.arrayContaining(result.urls));
});

test('an evicted older entry rehydrates when an appended card or detail surface mounts', async ({ page }) => {
  await boot(page);
  await page.waitForFunction(() => window.MemoCore && window.MemoCore.__mountedImageHydrationReady &&
    window.MemoCore.__mountedImageHydrationReady(), null, { timeout: 15000 });
  const initial = await page.evaluate(async () => {
    const db = window.MemoStateDb;
    db.__test.resetBlobUrlCache({ maxEntries: 1 });
    const paths = [
      'uploads/cache/remount-entry.png',
      'uploads/cache/remount-pressure-a.png',
      'uploads/cache/remount-pressure-b.png',
    ];
    for (const path of paths) await db.writeBlob(path, new Blob([path], { type: 'image/png' }));
    const entry = {
      id: 'blob-remount-entry', description: 'Older entry', category: 'Uncategorized', tags: [],
      _storedPaths: [paths[0]], images: [db.relToUrl(paths[0])], ts: Date.now(),
    };
    window.MemoCore.getState().db.entries.push(entry);
    await db.hydrateImages(entry);
    const firstUrl = entry.images[0];
    await db.blobUrl(paths[1]);
    db.__test.flushBlobUrlRevocations(false);

    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = entry.id;
    const image = document.createElement('img');
    image.dataset.src = entry.images[0];
    card.appendChild(image);
    document.getElementById('feed').appendChild(card);
    return { firstUrl, stableAfterEviction: entry.images[0], paths };
  });

  expect(initial.stableAfterEviction).toBe('/uploads/cache/remount-entry.png');
  await page.waitForFunction(() => {
    const entry = window.MemoCore.getState().db.entries.find((candidate) => candidate.id === 'blob-remount-entry');
    const image = document.querySelector('[data-id="blob-remount-entry"] img');
    return entry && entry.images[0] && entry.images[0].startsWith('blob:') &&
      image && image.getAttribute('data-src') === entry.images[0];
  }, null, { timeout: 5000 });
  await page.evaluate(() => {
    const card = document.querySelector('[data-id="blob-remount-entry"]');
    card.scrollIntoView();
    window.MemoLazy.hydrate(card);
  });
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-id="blob-remount-entry"] img');
    return image && image.dataset.lazyDone === '1' && image.getAttribute('src') && image.complete;
  }, null, { timeout: 5000 });

  await page.waitForFunction(() => window.MemoReader && window.UniversalReader);
  const mountedRelease = await page.evaluate(async (paths) => {
    const db = window.MemoStateDb;
    await db.blobUrl(paths[2]);
    db.__test.flushBlobUrlRevocations(false);
    const entry = window.MemoCore.getState().db.entries.find((candidate) => candidate.id === 'blob-remount-entry');
    const stable = entry.images[0];
    window.MemoReader.open(entry, 0);
    return { stable, stats: db.__test.blobUrlCacheStats() };
  }, initial.paths);
  expect(mountedRelease.stable).toBe('/uploads/cache/remount-entry.png');
  expect(mountedRelease.stats).toMatchObject({ size: 1, pending: 0 });
  await page.waitForFunction(() => {
    const image = document.querySelector('#urDlg[open] img.ur-page');
    return image && image.src && image.src.startsWith('blob:');
  }, null, { timeout: 5000 });

  await page.evaluate(() => window.MemoReader.close());
  await page.waitForFunction(() => !document.getElementById('urDlg').open);
  await page.evaluate(() => {
    document.querySelector('[data-id="blob-remount-entry"]').remove();
    window.MemoVariant.openDetail('blob-remount-entry');
  });

  await page.waitForFunction(() => {
    const entry = window.MemoCore.getState().db.entries.find((candidate) => candidate.id === 'blob-remount-entry');
    const image = document.querySelector('#detailThumbs img');
    return entry && entry.images[0] && entry.images[0].startsWith('blob:') &&
      image && image.getAttribute('src') === entry.images[0];
  }, null, { timeout: 5000 });
});

test('cold startup leaves offscreen stable paths unhydrated beyond the mounted feed window', async ({ page }) => {
  await boot(page);
  const total = 80;
  await page.evaluate(async (count) => {
    const db = window.MemoStateDb;
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      const path = `uploads/cache/cold-${index}.png`;
      await db.writeBlob(path, new Blob([String(index)], { type: 'image/png' }));
      entries.push({
        id: `cold-${index}`, description: `Cold ${index}`, category: 'Uncategorized', tags: [],
        _storedPaths: [path], images: [db.relToUrl(path)], ts: Date.now() + index,
      });
    }
    db.saveEntries(entries, 'default');
    await db.flush();
  }, total);

  // Keep the append sentinel idle so this test measures the first mounted
  // window rather than Playwright's empty viewport auto-advancing every page.
  await page.addInitScript(() => {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });
  await page.reload();
  await page.waitForFunction((count) => window.MemoCore && window.MemoCore.__mountedImageHydrationReady &&
    window.MemoCore.__mountedImageHydrationReady() && window.MemoCore.getState().db.entries.length === count,
  total, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#feed [data-id]').length > 0);
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({
    created: window.__memoBlobUrlProbe.created.length,
    mounted: document.querySelectorAll('#feed [data-id]').length,
    finiteProductionCap: Number.isFinite(window.MemoStateDb.__test.blobUrlCacheStats().maxEntries),
    stableEntries: window.MemoCore.getState().db.entries
      .filter((entry) => entry.images[0] && entry.images[0].startsWith('/uploads/')).length,
  }));

  expect(result.mounted).toBeLessThan(total);
  expect(result.created).toBeGreaterThan(0);
  expect(result.created).toBeLessThan(total);
  expect(result.stableEntries).toBeGreaterThan(0);
  expect(result.finiteProductionCap).toBe(true);
});
