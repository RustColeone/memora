const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready()
      && window.OperationQueue && typeof window.MemoCore.persistEntryMediaMutation === 'function',
    null,
    { timeout: 15000 },
  );
}

test('media mutation prunes orphaned backups and flushes after journaling', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    const entry = {
      id: 'exif-persist-probe',
      description: 'EXIF persistence probe',
      category: 'Uncategorized',
      tags: [],
      images: ['/uploads/keep.jpg', 'https://memo.test/uploads/also-keep.jpg?thumb=1'],
      _storedPaths: ['/uploads/keep.jpg', 'https://memo.test/uploads/also-keep.jpg?thumb=1'],
      attachments: [],
      imageMeta: {
        '/uploads/keep.jpg': { embeddedBackup: 'keep-a' },
        'https://memo.test/uploads/also-keep.jpg?old=1': { embeddedBackup: 'keep-b' },
        'uploads/removed.jpg': { embeddedBackup: 'remove-me' },
      },
      ts: Date.now(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const state = window.MemoCore.getState();
    state.db.entries.push(entry);

    const events = [];
    const stateDb = window.MemoStateDb;
    const queue = window.OperationQueue;
    const originalFlush = stateDb.flush;
    const originalAdd = queue.addOperation;
    stateDb.flush = async () => { events.push('flush'); };
    queue.addOperation = async (_type, _id, payload) => {
      events.push('add');
      window.__exifPersistPayload = payload.data;
      return 'probe-op';
    };
    try {
      await window.MemoCore.persistEntryMediaMutation(entry);
    } finally {
      stateDb.flush = originalFlush;
      queue.addOperation = originalAdd;
      state.db.entries = state.db.entries.filter((candidate) => candidate.id !== entry.id);
    }
    return {
      events,
      imageMeta: entry.imageMeta,
      payloadMeta: window.__exifPersistPayload && window.__exifPersistPayload.imageMeta,
    };
  });

  expect(result.events).toEqual(['flush', 'add', 'flush']);
  expect(result.imageMeta).toEqual({
    'uploads/keep.jpg': { embeddedBackup: 'keep-a' },
    'uploads/also-keep.jpg': { embeddedBackup: 'keep-b' },
  });
  expect(result.payloadMeta).toEqual(result.imageMeta);
});

test('pruning accepts final server URLs and removes replaced-image records', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(() => {
    const entry = {
      imageMeta: {
        'uploads/old.jpg': { embeddedBackup: 'old' },
        '/uploads/current.jpg': { embeddedBackup: 'current' },
      },
    };
    window.MemoCore.pruneEntryImageMeta(entry, ['https://server.test/uploads/current.jpg#view']);
    return entry.imageMeta;
  });

  expect(result).toEqual({
    'uploads/current.jpg': { embeddedBackup: 'current' },
  });
});
