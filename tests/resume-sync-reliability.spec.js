const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const source = name => fs.readFileSync(path.join(process.cwd(), 'src/static/js/memo', name), 'utf8');

async function queueHarness(page) {
  await page.goto('/queue-harness.html');
  await page.setContent('<html><body></body></html>');
  await page.evaluate(() => {
    const state = { entries: [], renders: 0, saves: 0, variant: 'default', stored: {} };
    window.__state = state;
    window.MemoRuntime = { getApiBase: () => 'https://home.test', getMode: () => 'local',
      getService: name => name === 'entryStore' ? {
        getEntries: () => state.entries, replaceAll: entries => { state.entries = entries; },
        save: () => state.saves++, render: () => state.renders++
      } : null };
    window.MemoContracts = { getVariant: () => state.variant };
  });
  await page.addScriptTag({ content: source('memo-operation-queue.js') });
  await page.evaluate(() => { OperationQueue.deviceId = 'A'; });
}

test('pull applies a batch once, leaves an empty pull untouched, and preserves pending creates', async ({ page }) => {
  await queueHarness(page);
  const result = await page.evaluate(async () => {
    const q = OperationQueue;
    const ops = Array.from({ length: 20 }, (_, i) => ({ type: 'create', entryId: 'remote-' + i,
      opId: i + 1, timestamp: 1000, deviceId: 'B', data: { description: 'Remote ' + i } }));
    window.fetch = async () => ({ ok: true, json: async () => ({ operations: ops }) });
    await q.pullServerOperations();
    const batch = { renders: __state.renders, saves: __state.saves, count: __state.entries.length };
    window.fetch = async () => ({ ok: true, json: async () => ({ operations: [] }) });
    await q.pullServerOperations();
    const afterEmpty = __state.renders;
    q.queue.push({ type: 'create', entryId: 'pending', data: { description: 'Local' }, timestamp: 2000, synced: false });
    __state.entries.push({ id: 'pending', description: 'Local' });
    await q.applySnapshot({ snapshotId: 30, entries: [{ id: 'snapshot' }] });
    return { batch, afterEmpty, ids: __state.entries.map(e => e.id) };
  });
  expect(result).toEqual({ batch: { renders: 1, saves: 1, count: 20 }, afterEmpty: 1, ids: ['snapshot', 'pending'] });
});

test('an upload acknowledgement cannot skip an unseen operation from another device', async ({ page }) => {
  await queueHarness(page);
  const result = await page.evaluate(async () => {
    const q = OperationQueue;
    q.lastServerOpId = 10;
    let pullUrl;
    window.fetch = async (url, options) => options.method === 'POST'
      ? { ok: true, json: async () => ({ operations: [{ clientOpId: 'local', serverOpId: 12 }] }) }
      : { ok: true, json: async () => { pullUrl = url; return { operations: [
        { opId: 11, type: 'create', entryId: 'other-device', deviceId: 'B', timestamp: 1000, data: {} }
      ] }; } };
    await q.pushOperationToServer({ clientOpId: 'local', entryId: 'mine', type: 'create', data: {} });
    await q.pullServerOperations();
    return { pullUrl, ids: __state.entries.map(e => e.id), cursor: q.lastServerOpId };
  });
  expect(result.pullUrl).toContain('sinceOpId=10');
  expect(result.ids).toEqual(['other-device']);
  expect(result.cursor).toBe(11);
});

test('failed uploads remain pending and later operations on that entry cannot overtake them', async ({ page }) => {
  await queueHarness(page);
  const result = await page.evaluate(async () => {
    const q = OperationQueue;
    q.queue = [{ type: 'create', entryId: 'one', clientOpId: 'first', synced: false, nextRetry: 0 },
      { type: 'update', entryId: 'one', clientOpId: 'second', synced: false, nextRetry: 0 }];
    const pushed = [];
    q.uploadFilesForOperation = async () => {};
    q.pushOperationToServer = async op => { pushed.push(op.clientOpId); throw new Error('Unavailable'); };
    q.pullServerOperations = async () => {};
    return { result: await q.processQueue(), pushed };
  });
  expect(result.result.status).toBe('pending');
  expect(result.result.pending).toBe(2);
  expect(result.pushed).toEqual(['first']);
});

test('native sync sends the existing password only to the configured server', async ({ page }) => {
  await queueHarness(page);
  await page.addScriptTag({ content: source('memo-transport.js') });
  const result = await page.evaluate(async () => {
    const calls = [];
    window.MemoAuth = { headers: () => ({ 'X-Sync-Password': 'test-password' }) };
    window.Capacitor = { Plugins: { CapacitorHttp: { request: async options => {
      calls.push(options); return { status: 200, data: { operations: [{ clientOpId: 'op', serverOpId: 1 }] } };
    } } } };
    await OperationQueue.pushOperationToServer({ clientOpId: 'op', type: 'create', entryId: 'one', data: {} });
    await MemoTransport.request('https://other.test/api/example', {}, 'https://home.test');
    return calls;
  });
  expect(result[0].headers['X-Sync-Password']).toBe('test-password');
  expect(result[1].headers['X-Sync-Password']).toBeUndefined();
  expect(result[0].readTimeout).toBe(30000);
});

test('a pull finishing after a tab switch commits only its original variant', async ({ page }) => {
  await queueHarness(page);
  const result = await page.evaluate(async () => {
    const stored = { default: [], finance: [] };
    window.MemoStateDb = { ready: () => true, getItem: () => null, loadEntries: v => stored[v],
      saveSyncBatch: (v, entries) => { stored[v] = entries; }, flush: async () => {} };
    let finish;
    window.fetch = () => new Promise(resolve => { finish = resolve; });
    const job = OperationQueue.pullServerOperations();
    __state.variant = 'finance'; __state.entries = [{ id: 'receipt' }]; OperationQueue.reloadQueue();
    finish({ ok: true, json: async () => ({ operations: [{ opId: 1, entryId: 'remote-memo', type: 'create', data: {}, timestamp: 1 }] }) });
    await job;
    return { stored, active: __state.entries, renders: __state.renders, cursor: OperationQueue.lastServerOpId };
  });
  expect(result.stored.default.map(e => e.id)).toEqual(['remote-memo']);
  expect(result.active).toEqual([{ id: 'receipt' }]);
  expect(result.renders).toBe(0);
  expect(result.cursor).toBe(0);
});

test('a failed local commit cannot advance the pull cursor', async ({ page }) => {
  await queueHarness(page);
  const result = await page.evaluate(async () => {
    window.MemoStateDb = { ready: () => true, saveSyncBatch: () => { throw new Error('disk fault'); } };
    try { await OperationQueue.applyPull({ operations: [{ opId: 1, entryId: 'one', type: 'create', data: {} }] }, OperationQueue.context()); } catch (_) {}
    return { cursor: OperationQueue.context().state.lastServerOpId, entries: __state.entries, renders: __state.renders };
  });
  expect(result).toEqual({ cursor: 0, entries: [], renders: 0 });
});

async function boot(page, url = '/index.html') {
  await page.goto(url);
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready());
  await page.evaluate(() => MemoCore.start());
  await page.evaluate(() => window.MemoAppReady);
}

test('unchanged finance refresh preserves its table, row, and focused control', async ({ page }) => {
  await boot(page, '/finance.html');
  const result = await page.evaluate(() => {
    const state = MemoCore.getState();
    state.db.entries = [{ id: 'receipt', description: 'Receipt', purchaseDate: '2026-09-01', price: 10,
      category: 'Uncategorized', images: [], tags: [] }];
    MemoCore.applyServerState();
    const table = document.querySelector('#feed table');
    const row = document.querySelector('#feed .entry-row');
    const button = document.createElement('button'); button.textContent = 'Focus'; row.firstChild.append(button); button.focus();
    MemoCore.applyServerState();
    return { table: table === document.querySelector('#feed table'), row: row === document.querySelector('#feed .entry-row'), focus: document.activeElement === button };
  });
  expect(result).toEqual({ table: true, row: true, focus: true });
});

test('reload reconstructs the saved window before restoring scroll; native hide retains observers and URLs', async ({ page }) => {
  await page.addInitScript(() => {
    const observers = [];
    window.__observers = observers;
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
      observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    };
  });
  await boot(page);
  const before = await page.evaluate(async () => {
    const state = MemoCore.getState();
    state.db.entries = Array.from({ length: 125 }, (_, i) => ({ id: 'memo-' + i, description: 'Memo ' + i,
      category: 'Uncategorized', ts: 1000 + i, tags: [], images: [] }));
    state.settings.timeSplit = { enabled: false, period: 'month' };
    MemoCore.applyServerState();
    for (const observer of __observers.slice()) for (const target of [...observer.targets]) {
      if (target.matches('.feed-window-sentinel')) observer.callback([{ target, isIntersecting: true }]);
    }
    MemoCore.saveAll(); updateBackupNudge(); await MemoStateDb.flush();
    window.scrollTo(0, document.scrollingElement.scrollHeight);
    await new Promise(requestAnimationFrame);
    MemoRestore.save();
    return { count: document.querySelectorAll('#feed .card[data-id]').length, top: scrollY,
      saved: JSON.parse(sessionStorage.getItem('memo.view.v2')), height: document.scrollingElement.scrollHeight };
  });
  expect(before.count).toBe(120);
  expect(before.top).toBeGreaterThan(0);
  await boot(page);
  const after = await page.evaluate(() => ({ count: document.querySelectorAll('#feed .card[data-id]').length, top: scrollY,
    saved: JSON.parse(sessionStorage.getItem('memo.view.v2')), height: document.scrollingElement.scrollHeight }));
  expect(after.count).toBe(120);
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
  const retained = await page.evaluate(async () => {
    const db = MemoStateDb;
    await db.writeBlob('uploads/test/lifecycle.txt', new Blob(['saved']));
    const url = await db.blobUrl('uploads/test/lifecycle.txt');
    const card = document.querySelector('#feed .card[data-id]');
    const count = () => __observers.filter(o => [...o.targets].some(t => t.matches('.feed-window-sentinel'))).length;
    const before = count();
    window.Capacitor = { isNativePlatform: () => true };
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    return { before, after: count(), same: card === document.querySelector('#feed .card[data-id]'), text: await fetch(url).then(r => r.text()) };
  });
  expect(retained).toEqual({ before: 1, after: 1, same: true, text: 'saved' });
});

test('an unfinished editor restores its text and attachment bytes after reload', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => openEntryModal(null));
  await page.fill('#desc', 'Unfinished personal memo');
  await page.setInputFiles('#images', { name: 'draft.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') });
  await page.waitForFunction(() => MemoCore.captureDraft()?.images.length === 1);
  const saved = await page.evaluate(async () => {
    await MemoDraft.save();
    const draft = MemoStateDb.getItem('memo_editor_draft_default');
    return { path: draft.images[0].draftPath, bytes: (await MemoStateDb.readBlob(draft.images[0].draftPath)).size };
  });
  expect(saved.bytes).toBeGreaterThan(0);
  await boot(page);
  await expect(page.locator('#entryDlg')).toHaveAttribute('open', '');
  await expect(page.locator('#desc')).toHaveValue('Unfinished personal memo');
  expect(await page.evaluate(() => MemoCore.captureDraft().images[0].file.size)).toBe(saved.bytes);
  await page.evaluate(async () => { document.getElementById('entryDlg').close(); await MemoDraft.clear(); });
  expect(await page.evaluate(() => MemoStateDb.getItem('memo_editor_draft_default'))).toBeNull();
});

test('an explicit draft save waits for an autosave that supersedes it during attachment writes', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const capture = MemoCore.captureDraft, write = MemoStateDb.writeBlob;
    let unblock, started;
    const writing = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    const file = new File(['draft bytes'], 'draft.txt', { type: 'text/plain' });
    let description = 'first';
    MemoCore.captureDraft = () => ({ description, images: [], files: [{ file }] });
    MemoStateDb.writeBlob = async (...args) => { started(); await gate; return write(...args); };
    try {
      const firstSave = MemoDraft.save();
      await writing;
      description = 'latest';
      const nextSave = MemoDraft.save();
      unblock();
      await firstSave;
      const saved = MemoStateDb.getItem('memo_editor_draft_default');
      const out = { description: saved?.description,
        bytes: saved?.files[0]?.draftPath ? await (await MemoStateDb.readBlob(saved.files[0].draftPath)).text() : null };
      await nextSave;
      await MemoDraft.clear();
      return out;
    } finally { MemoCore.captureDraft = capture; MemoStateDb.writeBlob = write; }
  });
  expect(result).toEqual({ description: 'latest', bytes: 'draft bytes' });
});

test('rapid tab changes settle on the latest view with visible content', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    await Promise.all([MemoSpaShell.switchTo('planner'), MemoSpaShell.switchTo('finance'), MemoSpaShell.switchTo('planner')]);
    const view = document.getElementById('view-planner');
    await Promise.allSettled(view.getAnimations().map(animation => animation.finished));
    return { variant: MemoSpaShell.getVariant(), opacity: getComputedStyle(view).opacity, hidden: view.hidden };
  });
  expect(result).toEqual({ variant: 'planner', opacity: '1', hidden: false });
  await page.reload();
  await page.evaluate(() => window.MemoAppReady);
  await expect(page.locator('#view-planner')).toBeVisible();
});

test('checking a planner task retains its row, focus, and unrelated panels', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    await MemoSpaShell.switchTo('planner');
    Planner.setTab('todos');
    Planner.Store.addTodo({ title: 'Focus test' });
    const check = document.querySelector('#todoList .todo-check'), row = check.parentElement;
    const calendar = document.querySelector('#calBody');
    const firstDay = calendar?.firstChild;
    check.focus(); check.click();
    return { row: row === document.querySelector('#todoList .todo-item'), focus: document.activeElement === check,
      done: check.classList.contains('on'), calendar: !!firstDay && firstDay === calendar.firstChild };
  });
  expect(result).toEqual({ row: true, focus: true, done: true, calendar: true });
});

test('hydrating an image before its download completes retains the stable reference', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const entry = { images: ['/uploads/home/pending.png'], attachments: [] };
    await MemoStateDb.hydrateImages(entry);
    const pending = entry.images.slice();
    await MemoStateDb.writeBlob('uploads/home/pending.png', new Blob(['image bytes']));
    await MemoStateDb.hydrateImages(entry);
    return { pending, hydrated: entry.images[0].startsWith('blob:'), paths: entry._storedPaths };
  });
  expect(result).toEqual({ pending: ['/uploads/home/pending.png'], hydrated: true, paths: ['uploads/home/pending.png'] });
});

test('offline pending edits survive a restart before a server is configured', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => OperationQueue.addOperation('create', 'offline-first', { data: { description: 'First' } }));
  await boot(page);
  await page.evaluate(() => OperationQueue.addOperation('create', 'offline-second', { data: { description: 'Second' } }));
  const pending = await page.evaluate(() => MemoStateDb.getItem('memo_operation_queue_default').queue.filter(o => !o.synced).map(o => o.entryId));
  expect(pending).toEqual(['offline-first', 'offline-second']);
});

test('a retained habit button toggles the current state on repeated presses', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    await MemoSpaShell.switchTo('planner');
    Planner.Store.addHabit({ name: 'Daily memo', type: 'check', targetDays: [0], timesPerWeek: 1 });
    const button = document.querySelector('#habitsGrid .h-check');
    button.click(); const done = button.getAttribute('aria-pressed');
    button.click();
    return { same: button === document.querySelector('#habitsGrid .h-check'), done, undone: button.getAttribute('aria-pressed') };
  });
  expect(result).toEqual({ same: true, done: 'true', undone: 'false' });
});

test('an unchanged resume sync does not rewrite or flush the local database', async ({ page }) => {
  await queueHarness(page);
  const result = await page.evaluate(async () => {
    let writes = 0, flushes = 0;
    window.MemoStateDb = { ready: () => true, getItem: () => null,
      loadEntries: () => [], loadDocs: () => [], setItem: () => writes++,
      saveSyncBatch: () => writes++, flush: async () => { flushes++; } };
    window.fetch = async () => ({ ok: true, json: async () => ({ operations: [] }) });
    await OperationQueue.processQueue();
    return { writes, flushes, renders: __state.renders };
  });
  expect(result).toEqual({ writes: 0, flushes: 0, renders: 0 });
});

test('a create over a deleted id brings the entry back, as on the server', async ({ page }) => {
  await queueHarness(page);
  const out = await page.evaluate(async () => {
    const q = OperationQueue;
    const entries = [{ id: 'x', description: 'old', deletedAt: '2026-01-01T00:00:00Z', deletedBy: 'A' }];
    q._applyOpToEntries(entries, { type: 'create', entryId: 'x', timestamp: Date.now(), data: { description: 'new' } });
    const restoredDeleted = [{ id: 'y', description: 'old' }];
    q._applyOpToEntries(restoredDeleted, { type: 'create', entryId: 'y', timestamp: Date.now(), data: { description: 'kept deleted', deletedAt: '2026-02-02T00:00:00Z' } });
    return { x: [entries[0].description, entries[0].deletedAt], y: [restoredDeleted[0].description, restoredDeleted[0].deletedAt] };
  });
  expect(out).toEqual({ x: ['new', null], y: ['kept deleted', '2026-02-02T00:00:00Z'] });
});
