const { test, expect } = require('@playwright/test');

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9TAAAAABJRU5ErkJggg==';

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoBatchImport && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(),
    null,
    { timeout: 15000 }
  );
}

async function makeFiles(page, names) {
  await page.evaluate(async ({ png, names: fileNames }) => {
    const raw = await fetch(png).then((response) => response.blob());
    window.__batchDurabilityFiles = fileNames.map(
      (name) => new File([raw], name, { type: 'image/png' })
    );
  }, { png: ONE_PIXEL_PNG, names });
}

test('completion waits for every blob write and the final durable metadata flush', async ({ page }) => {
  await boot(page);
  await makeFiles(page, ['durable.png']);

  await page.evaluate(() => {
    const probe = window.__batchDurabilityProbe = {
      writeCalls: 0,
      flushCalls: 0,
      toasts: [],
      resolveWrite: null,
      resolveFlush: null,
    };
    window.MemoStateDb.writeBlob = async () => {
      probe.writeCalls += 1;
      await new Promise((resolve) => { probe.resolveWrite = resolve; });
    };
    window.MemoStateDb.flush = async () => {
      probe.flushCalls += 1;
      await new Promise((resolve) => { probe.resolveFlush = resolve; });
    };
    window.MemoShell.toast = (message) => probe.toasts.push(message);

    window.MemoBatchImport.open(window.__batchDurabilityFiles);
    window.__batchFlushOriginalPreviews = window.MemoBatchImport.__items().map((item) => item.previewUrl);
    document.getElementById('batchImportConfirmBtn').click();
  });

  await page.waitForTimeout(30);
  await expect.poll(() => page.evaluate(() => ({
    open: document.getElementById('batchImportReviewDlg').open,
    disabled: document.getElementById('batchImportConfirmBtn').disabled,
    writes: window.__batchDurabilityProbe.writeCalls,
    flushes: window.__batchDurabilityProbe.flushCalls,
    toasts: window.__batchDurabilityProbe.toasts.slice(),
  }))).toEqual({ open: true, disabled: true, writes: 1, flushes: 0, toasts: [] });

  await page.evaluate(() => window.__batchDurabilityProbe.resolveWrite());
  await page.waitForFunction(() => window.__batchDurabilityProbe.flushCalls === 1);
  expect(await page.evaluate(() => ({
    open: document.getElementById('batchImportReviewDlg').open,
    disabled: document.getElementById('batchImportConfirmBtn').disabled,
    toasts: window.__batchDurabilityProbe.toasts.slice(),
  }))).toEqual({ open: true, disabled: true, toasts: [] });

  await page.evaluate(() => window.__batchDurabilityProbe.resolveFlush());
  await page.waitForFunction(() => !document.getElementById('batchImportReviewDlg').open);
  expect(await page.evaluate(() => {
    const entry = window.MemoCore.getState().db.entries.find((candidate) => candidate.description === 'durable');
    return {
      importing: entry && entry._importing,
      storedPaths: entry && entry._storedPaths,
      toastCount: window.__batchDurabilityProbe.toasts.length,
    };
  })).toEqual({ importing: undefined, storedPaths: [expect.stringMatching(/^uploads\//)], toastCount: 1 });
});

test('rapid confirm is single-flight and a failed file remains retryable without duplicating completed entries', async ({ page }) => {
  await boot(page);
  await makeFiles(page, ['first.png', 'second.png', 'third.png']);

  await page.evaluate(() => {
    const probe = window.__batchDurabilityProbe = {
      writeCalls: 0,
      flushCalls: 0,
      failSecondWrite: true,
      toasts: [],
    };
    window.MemoStateDb.writeBlob = async () => {
      probe.writeCalls += 1;
      if (probe.failSecondWrite && probe.writeCalls === 2) throw new Error('simulated disk full');
    };
    window.MemoStateDb.flush = async () => { probe.flushCalls += 1; };
    window.MemoShell.toast = (message) => probe.toasts.push(message);

    window.MemoBatchImport.open(window.__batchDurabilityFiles);
    const button = document.getElementById('batchImportConfirmBtn');
    button.click();
    button.click();
  });

  await page.waitForFunction(() => /simulated disk full/i.test(document.getElementById('batchImportStatus').textContent || ''));
  expect(await page.evaluate(() => ({
    open: document.getElementById('batchImportReviewDlg').open,
    disabled: document.getElementById('batchImportConfirmBtn').disabled,
    writes: window.__batchDurabilityProbe.writeCalls,
    flushes: window.__batchDurabilityProbe.flushCalls,
    toasts: window.__batchDurabilityProbe.toasts.slice(),
    remaining: window.MemoBatchImport.__items().map((item) => item.description),
    created: window.MemoCore.getState().db.entries
      .filter((entry) => ['first', 'second', 'third'].includes(entry.description))
      .map((entry) => entry.description),
  }))).toEqual({
    open: true,
    disabled: false,
    writes: 2,
    flushes: 1,
    toasts: [],
    remaining: ['second', 'third'],
    created: ['first'],
  });

  await page.evaluate(() => {
    window.__batchDurabilityProbe.failSecondWrite = false;
    document.getElementById('batchImportConfirmBtn').click();
  });
  await page.waitForFunction(() => !document.getElementById('batchImportReviewDlg').open);
  expect(await page.evaluate(() => ({
    writes: window.__batchDurabilityProbe.writeCalls,
    flushes: window.__batchDurabilityProbe.flushCalls,
    toastCount: window.__batchDurabilityProbe.toasts.length,
    created: window.MemoCore.getState().db.entries
      .filter((entry) => ['first', 'second', 'third'].includes(entry.description))
      .map((entry) => entry.description)
      .sort(),
  }))).toEqual({
    writes: 4,
    flushes: 2,
    toastCount: 1,
    created: ['first', 'second', 'third'],
  });
});

test('a failed final snapshot retries only the flush, never the completed file writes', async ({ page }) => {
  await boot(page);
  await makeFiles(page, ['flush-one.png', 'flush-two.png']);

  await page.evaluate(() => {
    const probe = window.__batchDurabilityProbe = {
      writeCalls: 0,
      flushCalls: 0,
      toasts: [],
    };
    const originalWriteBlob = window.MemoStateDb.writeBlob.bind(window.MemoStateDb);
    window.MemoStateDb.writeBlob = async (path, blob) => {
      probe.writeCalls += 1;
      return originalWriteBlob(path, blob);
    };
    window.MemoStateDb.flush = async () => {
      probe.flushCalls += 1;
      if (probe.flushCalls === 1) throw new Error('simulated snapshot promotion failure');
    };
    window.MemoShell.toast = (message) => probe.toasts.push(message);

    window.MemoBatchImport.open(window.__batchDurabilityFiles);
    window.__batchFlushOriginalPreviews = window.MemoBatchImport.__items()
      .map((item) => item.previewUrl);
    document.getElementById('batchImportConfirmBtn').click();
  });

  await page.waitForFunction(() => /simulated snapshot promotion failure/i.test(document.getElementById('batchImportStatus').textContent || ''));
  expect(await page.evaluate(async () => {
    const currentPreviews = window.MemoBatchImport.__items().map((item) => item.previewUrl);
    const readable = await Promise.all(currentPreviews.map(async (url) => {
      try { return (await fetch(url).then((response) => response.blob())).size > 0; } catch (_error) { return false; }
    }));
    return {
      open: document.getElementById('batchImportReviewDlg').open,
      writes: window.__batchDurabilityProbe.writeCalls,
      flushes: window.__batchDurabilityProbe.flushCalls,
      toasts: window.__batchDurabilityProbe.toasts.length,
      locked: window.MemoBatchImport.__items().filter((item) => item._completed).length,
      created: window.MemoCore.getState().db.entries
        .filter((entry) => ['flush one', 'flush two'].includes(entry.description)).length,
      transferred: currentPreviews.every((url) => !window.__batchFlushOriginalPreviews.includes(url)),
      readable,
      cacheOwned: window.MemoBatchImport.__items().map((item) => !!item._cacheOwnedPreview),
    };
  })).toEqual({
    open: true, writes: 2, flushes: 1, toasts: 0, locked: 2, created: 2,
    transferred: true, readable: [true, true], cacheOwned: [true, true]
  });

  await page.evaluate(() => document.getElementById('batchImportCancelBtn').click());
  await page.waitForTimeout(220);
  expect(await page.evaluate(() => ({
    open: document.getElementById('batchImportReviewDlg').open,
    remaining: window.MemoBatchImport.__items().length,
  }))).toEqual({ open: true, remaining: 2 });

  await page.evaluate(() => document.getElementById('batchImportConfirmBtn').click());
  await page.waitForFunction(() => !document.getElementById('batchImportReviewDlg').open);
  expect(await page.evaluate(() => ({
    writes: window.__batchDurabilityProbe.writeCalls,
    flushes: window.__batchDurabilityProbe.flushCalls,
    toastCount: window.__batchDurabilityProbe.toasts.length,
    created: window.MemoCore.getState().db.entries
      .filter((entry) => ['flush one', 'flush two'].includes(entry.description)).length,
  }))).toEqual({ writes: 2, flushes: 2, toastCount: 1, created: 2 });
});
