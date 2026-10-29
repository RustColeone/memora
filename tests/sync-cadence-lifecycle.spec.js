const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const operationQueueSource = fs.readFileSync(
  path.join(process.cwd(), 'src/static/js/memo/memo-operation-queue.js'),
  'utf8',
);
const syncManagerSource = fs.readFileSync(
  path.join(process.cwd(), 'src/static/js/memo/memo-sync.js'),
  'utf8',
);

async function boot(page) {
  // Load the two lifecycle owners in isolation. This keeps the probe focused on
  // their timers/listeners instead of unrelated application boot hooks.
  await page.goto('/sync-lifecycle-harness.html');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: operationQueueSource });
  await page.addScriptTag({ content: syncManagerSource });
}

async function installLifecycleProbe(page) {
  await page.evaluate(() => {
    const nativeSetInterval = window.setInterval;
    const nativeClearInterval = window.clearInterval;
    const cadenceIntervals = new Set();
    window.setInterval = function trackedSetInterval(callback, delay, ...args) {
      const id = nativeSetInterval.call(this, callback, delay, ...args);
      if (delay === 5 * 60 * 1000) cadenceIntervals.add(id);
      return id;
    };
    window.clearInterval = function trackedClearInterval(id) {
      cadenceIntervals.delete(id);
      return nativeClearInterval.call(this, id);
    };

    const trackedTypes = new Set(['focus', 'visibilitychange', 'beforeunload']);
    const activeListeners = {
      focus: new Set(),
      visibilitychange: new Set(),
      beforeunload: new Set(),
    };
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function trackedAdd(type, listener, options) {
      if (trackedTypes.has(type)) activeListeners[type].add(listener);
      return nativeAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function trackedRemove(type, listener, options) {
      if (trackedTypes.has(type)) activeListeners[type].delete(listener);
      return nativeRemove.call(this, type, listener, options);
    };

    window.__syncLifecycleProbe = {
      snapshot() {
        return {
          cadenceIntervals: cadenceIntervals.size,
          focus: activeListeners.focus.size,
          visibilitychange: activeListeners.visibilitychange.size,
          beforeunload: activeListeners.beforeunload.size,
        };
      },
    };
  });
}

test('repeated OperationQueue init retains one cadence and one lifecycle handler per event', async ({ page }) => {
  await boot(page);
  await installLifecycleProbe(page);

  const result = await page.evaluate(() => {
    const queue = window.OperationQueue;
    queue.destroy();
    queue.processQueue = async () => {};
    queue.init();
    queue.init();
    queue.init();
    return window.__syncLifecycleProbe.snapshot();
  });

  expect(result).toEqual({
    cadenceIntervals: 1,
    focus: 1,
    visibilitychange: 1,
    beforeunload: 1,
  });
});

test('OperationQueue destroy releases every cadence timer and lifecycle handler it owns', async ({ page }) => {
  await boot(page);
  await installLifecycleProbe(page);

  const result = await page.evaluate(() => {
    const queue = window.OperationQueue;
    queue.destroy();
    queue.processQueue = async () => {};
    queue.init();
    const active = window.__syncLifecycleProbe.snapshot();
    queue.destroy();
    return {
      active,
      destroyed: window.__syncLifecycleProbe.snapshot(),
      ownedReferences: {
        interval: queue.autoSyncInterval,
        focus: queue.focusHandler,
        visibilitychange: queue.visibilityHandler,
        beforeunload: queue.unloadHandler,
      },
    };
  });

  expect(result.active).toEqual({
    cadenceIntervals: 1,
    focus: 1,
    visibilitychange: 1,
    beforeunload: 1,
  });
  expect(result.destroyed).toEqual({
    cadenceIntervals: 0,
    focus: 0,
    visibilitychange: 0,
    beforeunload: 0,
  });
  expect(result.ownedReferences).toEqual({
    interval: null,
    focus: null,
    visibilitychange: null,
    beforeunload: null,
  });
});

test('SyncManager delegates the five-minute cadence to OperationQueue', async ({ page }) => {
  await boot(page);
  await installLifecycleProbe(page);

  const result = await page.evaluate(async () => {
    const queue = window.OperationQueue;
    const manager = window.SyncManager;
    queue.destroy();
    manager.destroy();
    queue.processQueue = async () => {};
    await manager.init();
    return {
      lifecycle: window.__syncLifecycleProbe.snapshot(),
      queueInterval: queue.autoSyncInterval !== null,
      managerInterval: manager.syncState.autoSyncInterval,
    };
  });

  expect(result).toEqual({
    lifecycle: {
      cadenceIntervals: 1,
      focus: 1,
      visibilitychange: 1,
      beforeunload: 1,
    },
    queueInterval: true,
    managerInterval: null,
  });
});

test('media upload remaps imageMeta to the server path without a leading slash', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    window.MemoStateDb = { ready: () => true };
    const queue = window.OperationQueue;
    queue.uploadFile = async () => '/uploads/2026-08-03/renamed.jpg';
    const op = {
      type: 'update',
      entryId: 'memo-1',
      data: {
        _filesToUpload: ['uploads/2026-08-02/original.jpg'],
        _storedPaths: ['uploads/2026-08-02/original.jpg'],
        _attachments: [],
        imageMeta: {
          '/uploads/2026-08-02/original.jpg': { embeddedBackup: 'backup' },
          '/uploads/stale.jpg': { note: 'orphaned metadata is pruned during remap' },
        },
      },
    };
    await queue.uploadFilesForOperation(op);
    return { images: op.data.images, imageMeta: op.data.imageMeta };
  });

  expect(result.images).toEqual(['/uploads/2026-08-03/renamed.jpg']);
  expect(result.imageMeta).toEqual({
    'uploads/2026-08-03/renamed.jpg': { embeddedBackup: 'backup' },
  });
});
