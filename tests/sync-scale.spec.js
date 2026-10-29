// Sync behaviour added for large notebooks: paged pulls, edit-time last write
// wins (a stale push adopts the server's copy) and rejected changes.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const source = name => fs.readFileSync(path.join(process.cwd(), 'src/static/js/memo', name), 'utf8');

async function queueHarness(page) {
  await page.goto('/queue-harness.html');
  await page.setContent('<html><body></body></html>');
  await page.evaluate(() => {
    const state = { entries: [], renders: 0, saves: 0, variant: 'default', toasts: [] };
    window.__state = state;
    window.MemoRuntime = { getApiBase: () => 'https://home.test', getMode: () => 'local',
      getService: name => name === 'entryStore' ? {
        getEntries: () => state.entries, replaceAll: entries => { state.entries = entries; },
        save: () => state.saves++, render: () => state.renders++
      } : null };
    window.MemoContracts = { getVariant: () => state.variant };
    window.MemoShell = { toast: message => state.toasts.push(message) };
  });
  await page.addScriptTag({ content: source('memo-operation-queue.js') });
  await page.evaluate(() => { OperationQueue.deviceId = 'A'; });
}

test('a first sync arrives in pages and is applied once', async ({ page }) => {
  await queueHarness(page);
  const result = await page.evaluate(async () => {
    const q = OperationQueue;
    q.PULL_PAGE = 2;
    q.lastServerOpId = -1;
    const all = Array.from({ length: 5 }, (_, i) => ({ id: 'n' + i, description: 'note ' + i }));
    const urls = [];
    window.fetch = async url => {
      urls.push(url);
      const params = new URL(url).searchParams;
      const since = Number(params.get('sinceOpId'));
      if (since < 7) {
        const offset = Number(params.get('snapshotOffset') || 0);
        const done = offset + 2 >= all.length;
        return { ok: true, json: async () => ({ needsFullSync: true, snapshotTotal: 5,
          snapshot: { snapshotId: 7, entries: all.slice(offset, offset + 2) },
          snapshotNextOffset: done ? null : offset + 2,
          operations: done ? [{ opId: 8, type: 'update', entryId: 'n0', timestamp: 1, data: { description: 'edited' } },
            { opId: 9, type: 'create', entryId: 'n5', timestamp: 2, data: { description: 'note 5' } }] : [],
          latestOpId: done ? 9 : 7, hasMore: done }) };
      }
      return { ok: true, json: async () => ({ needsFullSync: false, latestOpId: 10, hasMore: false,
        operations: [{ opId: 10, type: 'create', entryId: 'n6', timestamp: 3, data: { description: 'note 6' } }] }) };
    };
    await q.pullServerOperations();
    return { requests: urls.length, limit: new URL(urls[0]).searchParams.get('limit'),
      ids: __state.entries.map(e => e.id), first: __state.entries[0].description, cursor: q.lastServerOpId, renders: __state.renders };
  });
  expect(result).toEqual({ requests: 4, limit: '2', ids: ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
    first: 'edited', cursor: 10, renders: 1 });
});

test('a stale push adopts the server copy and keeps later local changes on top', async ({ page }) => {
  await queueHarness(page);
  const result = await page.evaluate(async () => {
    const q = OperationQueue;
    __state.entries = [{ id: 'note', description: 'my older offline edit', tags: ['local'], _storedPaths: ['p'], images: [] }];
    const stale = { clientOpId: 'a1', entryId: 'note', type: 'update', timestamp: 1000, data: { description: 'my older offline edit' } };
    const later = { clientOpId: 'a2', entryId: 'note', type: 'update', timestamp: 3000, data: { tags: ['later'] }, synced: false };
    q.queue.push(later);
    window.fetch = async () => ({ ok: true, json: async () => ({ success: true, rejected: [], operations: [{
      clientOpId: 'a1', serverOpId: null, stale: true,
      entry: { id: 'note', description: 'newer edit from the other phone', tags: ['server'], images: [] } }] }) });
    await q.pushOperationToServer(stale);
    const entry = __state.entries[0];
    return { stale: stale.stale, description: entry.description, tags: entry.tags, stored: entry._storedPaths };
  });
  expect(result).toEqual({ stale: true, description: 'newer edit from the other phone', tags: ['later'], stored: ['p'] });
});

test('a rejected change stops retrying and is reported', async ({ page }) => {
  await queueHarness(page);
  const result = await page.evaluate(async () => {
    const q = OperationQueue;
    q.queue.push({ clientOpId: 'r1', entryId: 'gone', type: 'update', timestamp: 1000, data: { description: 'x' }, synced: false });
    let posts = 0;
    window.fetch = async () => { posts++; return { ok: true, json: async () => ({ success: true, operations: [],
      rejected: [{ clientOpId: 'r1', entryId: 'gone', reason: 'not_found' }] }) }; };
    await q.pushUnsyncedOperations();
    await q.pushUnsyncedOperations();
    const op = q.queue.find(o => o.clientOpId === 'r1');
    return { posts, synced: op.synced, rejected: op.rejected, toasts: __state.toasts.length };
  });
  expect(result).toEqual({ posts: 1, synced: true, rejected: 'not_found', toasts: 1 });
});
