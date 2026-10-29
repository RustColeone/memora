const { test, expect } = require('@playwright/test');

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9TAAAAABJRU5ErkJggg==';

async function boot(page) {
  await page.addInitScript(() => {
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    const probe = window.__previewOwnershipProbe = { created: [], revoked: [] };
    URL.createObjectURL = function (blob) {
      const url = createObjectURL(blob);
      probe.created.push(url);
      return url;
    };
    URL.revokeObjectURL = function (url) {
      probe.revoked.push(url);
      return revokeObjectURL(url);
    };
  });
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoBatchImport && window.MemoReader && window.MemoCore
      && window.MemoStateDb && window.MemoStateDb.ready(),
    null,
    { timeout: 15000 }
  );
  await page.evaluate(() => window.MemoAppReady || window.MemoCore.start());
}

async function enterCategory(page, category = 'Uncategorized') {
  await page.evaluate((value) => {
    const select = document.getElementById('categoryFilter');
    if (![...select.options].some((option) => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    select.value = value;
    select.dispatchEvent(new Event('change'));
  }, category);
}

async function makeFiles(page, names) {
  await page.evaluate(async ({ png, fileNames }) => {
    const raw = await fetch(png).then((response) => response.blob());
    window.__previewOwnershipFiles = fileNames.map(
      (name) => new File([raw], name, { type: 'image/png' })
    );
  }, { png: ONE_PIXEL_PNG, fileNames: names });
}

test('normal save hands an optimistic preview to durable storage before revoking it', async ({ page }) => {
  await boot(page);
  await enterCategory(page);

  // Hold the real write at its boundary so both ownership phases are observable:
  // the card first paints from the editor-owned preview, then swaps atomically.
  await page.evaluate(() => {
    const originalWrite = window.MemoStateDb.writeBlob.bind(window.MemoStateDb);
    let releaseWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    window.__previewWriteGate = { release: releaseWrite, started: false };
    window.MemoStateDb.writeBlob = async (path, blob) => {
      window.__previewWriteGate.started = true;
      await gate;
      return originalWrite(path, blob);
    };
    document.getElementById('fab').click();
  });
  await page.waitForSelector('#entryDlg[open]');
  await page.setInputFiles('#images', {
    name: 'normal-owned.png',
    mimeType: 'image/png',
    buffer: Buffer.from(ONE_PIXEL_PNG.split(',')[1], 'base64'),
  });
  await page.fill('#desc', 'normal ownership handoff');
  const preview = await page.evaluate(() => window.modalImages[0].src);
  await page.click('#saveBtn');

  await page.waitForFunction(() => window.__previewWriteGate.started);
  const optimistic = await page.evaluate((expectedPreview) => {
    const entry = window.MemoCore.getState().db.entries
      .find((candidate) => candidate.description === 'normal ownership handoff');
    const cardImage = entry && document.querySelector(`.card[data-id="${entry.id}"] img`);
    return {
      importing: !!(entry && entry._importing),
      entryUrl: entry && entry.images[0],
      cardUrl: cardImage && (cardImage.getAttribute('src') || cardImage.dataset.src),
      previewAlive: expectedPreview === (entry && entry.images[0]),
    };
  }, preview);
  expect(optimistic).toEqual({
    importing: true,
    entryUrl: preview,
    cardUrl: preview,
    previewAlive: true,
  });

  await page.evaluate(() => window.__previewWriteGate.release());
  await page.waitForFunction((oldPreview) => {
    const entry = window.MemoCore.getState().db.entries
      .find((candidate) => candidate.description === 'normal ownership handoff');
    return entry && !entry._importing && entry.images[0] && entry.images[0] !== oldPreview;
  }, preview, { timeout: 10000 });

  const durable = await page.evaluate(async (oldPreview) => {
    const entry = window.MemoCore.getState().db.entries
      .find((candidate) => candidate.description === 'normal ownership handoff');
    const cardImage = document.querySelector(`.card[data-id="${entry.id}"] img`);
    let byteLength = 0;
    try { byteLength = (await fetch(entry.images[0]).then((response) => response.arrayBuffer())).byteLength; } catch (_error) {}
    return {
      image: entry.images[0],
      storedPaths: entry._storedPaths.slice(),
      revoked: window.__previewOwnershipProbe.revoked.includes(oldPreview),
      cardSrc: cardImage && cardImage.getAttribute('src'),
      cardDataSrc: cardImage && cardImage.dataset.src,
      byteLength,
    };
  }, preview);
  expect(durable.image).not.toBe(preview);
  expect(durable.image).toMatch(/^(blob:|\/uploads\/)/);
  expect(durable.storedPaths).toHaveLength(1);
  expect(durable.revoked).toBe(true);
  expect([durable.cardSrc, durable.cardDataSrc]).toContain(durable.image);
  expect(durable.byteLength).toBeGreaterThan(0);

  // The first downstream consumer must still open after the preview is gone.
  await page.evaluate(() => {
    const entry = window.MemoCore.getState().db.entries
      .find((candidate) => candidate.description === 'normal ownership handoff');
    window.MemoReader.open(entry, 0);
  });
  await page.waitForFunction(
    () => window.MemoReader.__state().opened && window.MemoReader.__state().pageCount === 1,
    null,
    { timeout: 10000 }
  );
});

test('a successful reviewed batch releases every direct preview without blanking its entries', async ({ page }) => {
  await boot(page);
  await enterCategory(page);
  await makeFiles(page, ['ownership-one.png', 'ownership-two.png', 'ownership-three.png']);

  const previews = await page.evaluate(() => {
    window.MemoBatchImport.open(window.__previewOwnershipFiles);
    window.MemoBatchImport.__items().forEach((item) => { item.category = 'Uncategorized'; });
    window.__previewOwnershipReviews = window.MemoBatchImport.__items().slice();
    return window.__previewOwnershipReviews.map((item) => item.previewUrl);
  });
  await page.click('#batchImportConfirmBtn');
  await page.waitForFunction(() => !document.getElementById('batchImportReviewDlg').open, null, { timeout: 15000 });

  const result = await page.evaluate(async ({ oldPreviews, descriptions }) => {
    const entries = window.MemoCore.getState().db.entries
      .filter((entry) => descriptions.includes(entry.description));
    const reads = await Promise.all(entries.map(async (entry) => {
      try { return (await fetch(entry.images[0]).then((response) => response.arrayBuffer())).byteLength; }
      catch (_error) { return 0; }
    }));
    return {
      count: entries.length,
      imageUrls: entries.map((entry) => entry.images[0]),
      storedCounts: entries.map((entry) => (entry._storedPaths || []).length),
      importing: entries.map((entry) => !!entry._importing),
      reads,
      revoked: oldPreviews.map((url) => window.__previewOwnershipProbe.revoked.includes(url)),
      kept: window.__previewOwnershipReviews.map((item) => item._keepPreview),
      mountedUrls: entries.map((entry) => {
        const image = document.querySelector(`.card[data-id="${entry.id}"] img`);
        return image && [image.getAttribute('src'), image.dataset.src];
      }),
    };
  }, {
    oldPreviews: previews,
    descriptions: ['ownership one', 'ownership two', 'ownership three'],
  });

  expect(result.count).toBe(3);
  result.imageUrls.forEach((url) => {
    expect(url).toBeTruthy();
    expect(previews).not.toContain(url);
  });
  expect(result.storedCounts).toEqual([1, 1, 1]);
  expect(result.importing).toEqual([false, false, false]);
  expect(result.reads.every((size) => size > 0)).toBe(true);
  expect(result.revoked).toEqual([true, true, true]);
  expect(result.kept).toEqual([undefined, undefined, undefined]);
  result.mountedUrls.forEach((mounted, index) => expect(mounted).toContain(result.imageUrls[index]));
});

test('a failed reviewed save retains its live preview for retry, then releases it after success', async ({ page }) => {
  await boot(page);
  await enterCategory(page);
  await makeFiles(page, ['retry-owned.png']);

  const preview = await page.evaluate(() => {
    const originalWrite = window.MemoStateDb.writeBlob.bind(window.MemoStateDb);
    let shouldFail = true;
    window.MemoStateDb.writeBlob = async (path, blob) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('ownership retry sentinel');
      }
      return originalWrite(path, blob);
    };
    window.MemoBatchImport.open(window.__previewOwnershipFiles);
    const review = window.MemoBatchImport.__items()[0];
    review.category = 'Uncategorized';
    window.__previewOwnershipRetryReview = review;
    document.getElementById('batchImportConfirmBtn').click();
    return review.previewUrl;
  });

  await page.waitForFunction(
    () => /ownership retry sentinel/i.test(document.getElementById('batchImportStatus').textContent || '')
  );
  const failed = await page.evaluate(async (oldPreview) => {
    let readable = false;
    try { readable = (await fetch(oldPreview).then((response) => response.blob())).size > 0; } catch (_error) {}
    return {
      dialogOpen: document.getElementById('batchImportReviewDlg').open,
      previewStillOwned: window.__previewOwnershipRetryReview.previewUrl === oldPreview,
      revoked: window.__previewOwnershipProbe.revoked.includes(oldPreview),
      readable,
      created: window.MemoCore.getState().db.entries
        .filter((entry) => entry.description === 'retry owned').length,
    };
  }, preview);
  expect(failed).toEqual({
    dialogOpen: true,
    previewStillOwned: true,
    revoked: false,
    readable: true,
    created: 0,
  });

  await page.click('#batchImportConfirmBtn');
  await page.waitForFunction(() => !document.getElementById('batchImportReviewDlg').open, null, { timeout: 15000 });
  const retried = await page.evaluate(async (oldPreview) => {
    const entry = window.MemoCore.getState().db.entries
      .find((candidate) => candidate.description === 'retry owned');
    let readable = false;
    try { readable = (await fetch(entry.images[0]).then((response) => response.blob())).size > 0; } catch (_error) {}
    return {
      count: window.MemoCore.getState().db.entries
        .filter((candidate) => candidate.description === 'retry owned').length,
      image: entry.images[0],
      revoked: window.__previewOwnershipProbe.revoked.includes(oldPreview),
      kept: window.__previewOwnershipRetryReview._keepPreview,
      readable,
    };
  }, preview);
  expect(retried.count).toBe(1);
  expect(retried.image).not.toBe(preview);
  expect(retried.revoked).toBe(true);
  expect(retried.kept).toBeUndefined();
  expect(retried.readable).toBe(true);
});

test('mixed image and PDF save keeps image paths aligned and round-trips the attachment separately', async ({ page }) => {
  await boot(page);
  await enterCategory(page);
  await page.evaluate(() => document.getElementById('fab').click());
  await page.waitForSelector('#entryDlg[open]');
  await page.setInputFiles('#images', [
    {
      name: 'mixed-owned.png',
      mimeType: 'image/png',
      buffer: Buffer.from(ONE_PIXEL_PNG.split(',')[1], 'base64'),
    },
    {
      name: 'mixed-owned.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF', 'utf8'),
    },
  ]);
  await page.fill('#desc', 'mixed ownership roundtrip');
  const previews = await page.evaluate(() => ({
    image: window.modalImages[0].src,
    attachment: window.modalFilesExtra[0].url,
  }));
  await page.click('#saveBtn');
  await page.waitForFunction(() => {
    const entry = window.MemoCore.getState().db.entries
      .find((candidate) => candidate.description === 'mixed ownership roundtrip');
    return entry && !entry._importing && entry._storedPaths && entry._storedPaths.length;
  }, null, { timeout: 10000 });
  await page.evaluate(() => window.MemoCore.flushPersistence());

  const beforeReload = await page.evaluate((oldPreviews) => {
    const entry = window.MemoCore.getState().db.entries
      .find((candidate) => candidate.description === 'mixed ownership roundtrip');
    return {
      imageCount: entry.images.length,
      imagePaths: entry._storedPaths.slice(),
      attachmentCount: entry.attachments.length,
      attachmentPath: entry.attachments[0] && entry.attachments[0].storedPath,
      attachmentUrl: entry.attachments[0] && entry.attachments[0].url,
      imagePreviewRevoked: window.__previewOwnershipProbe.revoked.includes(oldPreviews.image),
      attachmentPreviewRevoked: window.__previewOwnershipProbe.revoked.includes(oldPreviews.attachment),
    };
  }, previews);
  expect(beforeReload.imageCount).toBe(1);
  expect(beforeReload.imagePaths).toHaveLength(1);
  expect(beforeReload.attachmentCount).toBe(1);
  expect(beforeReload.attachmentPath).toMatch(/^uploads\//);
  expect(beforeReload.attachmentUrl).toBe('/' + beforeReload.attachmentPath);
  expect(beforeReload.imagePaths).not.toContain(beforeReload.attachmentPath);
  expect(beforeReload.imagePreviewRevoked).toBe(true);
  expect(beforeReload.attachmentPreviewRevoked).toBe(true);

  await page.reload();
  await page.waitForFunction(
    () => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(),
    null,
    { timeout: 15000 }
  );
  await page.evaluate(() => window.MemoAppReady || window.MemoCore.start());
  const restored = await page.evaluate(async () => {
    const entry = window.MemoCore.getState().db.entries
      .find((candidate) => candidate.description === 'mixed ownership roundtrip');
    const imageBlob = await window.MemoStateDb.readBlob(entry._storedPaths[0]);
    const attachmentBlob = await window.MemoStateDb.readBlob(entry.attachments[0].storedPath);
    return {
      imageCount: entry.images.length,
      imagePaths: entry._storedPaths.slice(),
      attachmentCount: entry.attachments.length,
      attachmentPath: entry.attachments[0].storedPath,
      imageType: imageBlob && imageBlob.type,
      attachmentType: attachmentBlob && attachmentBlob.type,
    };
  });
  expect(restored.imageCount).toBe(1);
  expect(restored.imagePaths).toHaveLength(1);
  expect(restored.attachmentCount).toBe(1);
  expect(restored.imagePaths).not.toContain(restored.attachmentPath);
  expect(restored.imageType).toBe('image/png');
  expect(restored.attachmentType).toBe('application/pdf');
});
