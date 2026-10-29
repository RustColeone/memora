/**
 * Operation Queue Manager for Event Sourcing
 * Handles reliable operation queuing, retry logic, and sync
 */

function queueGetContracts() {
  return window.MemoContracts || null;
}

function queueGetRuntime() {
  return window.MemoRuntime || null;
}

function queueGetApiBase() {
  const runtime = queueGetRuntime();
  if (runtime && typeof runtime.getApiBase === 'function') {
    return runtime.getApiBase();
  }
  const contracts = queueGetContracts();
  if (contracts && typeof contracts.getApiBase === 'function') {
    return contracts.getApiBase();
  }
  return '';
}

function queueGetVariant() {
  const contracts = queueGetContracts();
  if (contracts && typeof contracts.getVariant === 'function') {
    return contracts.getVariant();
  }
  return window.MEMO_VARIANT || 'default';
}

function queueGetMode() {
  const runtime = queueGetRuntime();
  if (runtime && typeof runtime.getMode === 'function') return runtime.getMode();
  const contracts = queueGetContracts();
  if (contracts && typeof contracts.getMode === 'function') return contracts.getMode();
  return window.MODE || 'local';
}

// imageMeta uses the same stable-key form as MemoExifEditor/StateDb:
// `uploads/<date>/<file>` with no leading slash, query, or fragment. Sync
// uploads can allocate a new server path, so the key must travel with the image
// URL remap instead of becoming an orphaned revert backup.
function queueImageMetaKey(value) {
  let path = String(value || '');
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) path = new URL(path, window.location && window.location.href).pathname;
  } catch (_e) {}
  return path.split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/^\/+/, '');
}

function remapOperationImageMeta(data, sourcePaths, resolvedImages) {
  if (!data || !data.imageMeta || typeof data.imageMeta !== 'object' || Array.isArray(data.imageMeta)) return;
  const ownedSourceKeys = new Set(sourcePaths.map(queueImageMetaKey).filter(Boolean));
  const normalized = {};
  Object.entries(data.imageMeta).forEach(([key, value]) => {
    const normalizedKey = queueImageMetaKey(key);
    if (normalizedKey && ownedSourceKeys.has(normalizedKey)) normalized[normalizedKey] = value;
  });
  for (let index = 0; index < sourcePaths.length; index++) {
    const oldKey = queueImageMetaKey(sourcePaths[index]);
    const newKey = queueImageMetaKey(resolvedImages[index]);
    if (!oldKey || !newKey || oldKey === newKey || !Object.prototype.hasOwnProperty.call(normalized, oldKey)) continue;
    const oldRecord = normalized[oldKey];
    if (normalized[newKey] && typeof normalized[newKey] === 'object'
        && oldRecord && typeof oldRecord === 'object') {
      normalized[newKey] = { ...normalized[newKey], ...oldRecord };
    } else {
      normalized[newKey] = oldRecord;
    }
    delete normalized[oldKey];
  }
  data.imageMeta = normalized;
}

// The sync queue persists in the shared SQLite store when available, so all
// app state lives in one place; localStorage is only a fallback.
function queueStateDb() {
  return (window.MemoStateDb && typeof window.MemoStateDb.ready === 'function' && window.MemoStateDb.ready())
    ? window.MemoStateDb : null;
}

// Every server accepts these; newer collections sync only where the server
// lists them (serverCollections). Document collections live in doc_entries.
const CORE_VARIANTS = ['default', 'finance', 'planner'];
function queueSyncVariants() { return window.MemoStateDb?.SYNC_VARIANTS || CORE_VARIANTS; }
function queueIsDocVariant(variant) {
  return window.MemoStateDb?.isDocVariant ? window.MemoStateDb.isDocVariant(variant) : variant === 'planner';
}

// The queue is store-agnostic: it reads/writes the host page's entry array
// through an "entryStore" adapter resolved from the service registry. Memo and
// finance pages register nothing and fall back to the MemoCore-backed default
// below; other pages (e.g. Planner) register their own adapter so the same
// sync engine drives a different data model. Adapter contract:
//   getEntries()      -> the LIVE entries array (mutations must persist)
//   replaceAll(arr)   -> swap the whole entries array (full-sync snapshot)
//   save()            -> persist current state
//   render()          -> refresh the UI
const DEFAULT_ENTRY_STORE = {
  getEntries() {
    const s = window.MemoCore && window.MemoCore.getState && window.MemoCore.getState();
    return (s && s.db && s.db.entries) || [];
  },
  replaceAll(entries) {
    const s = window.MemoCore && window.MemoCore.getState && window.MemoCore.getState();
    if (s && s.db) s.db.entries = entries;
  },
  save() { if (window.MemoCore && window.MemoCore.saveAll) return window.MemoCore.saveAll(); },
  // Prefer applyServerState (re-derives categories/tags + refreshes controls) so a
  // pulled snapshot/ops populate the category dropdown, not just the folder view.
  render() {
    var mc = window.MemoCore;
    if (mc && mc.applyServerState) return mc.applyServerState();
    if (mc && mc.renderFeed) return mc.renderFeed();
  }
};

function queueGetStore() {
  const runtime = queueGetRuntime();
  if (runtime && typeof runtime.getService === 'function') {
    const svc = runtime.getService('entryStore', null);
    if (svc) return svc;
  }
  const contracts = queueGetContracts();
  if (contracts && typeof contracts.getService === 'function') {
    const svc = contracts.getService('entryStore');
    if (svc) return svc;
  }
  return DEFAULT_ENTRY_STORE;
}

// Sync jobs retain a variant and server context across every await. The active
// view is only a projection; changing tabs never redirects an in-flight write.
const OperationQueue = {
  queue: [], lastServerOpId: 0, deviceId: null,
  ownsSyncCadence: true, isSyncing: false, autoSyncInterval: null,
  visibilityHandler: null, focusHandler: null, unloadHandler: null, onlineHandler: null,
  states: new Map(),

  key(variant) { return `memo_operation_queue_${variant}`; },
  readState(variant) {
    const sdb = queueStateDb();
    let data = sdb?.getItem(this.key(variant));
    if (!data) {
      try { data = JSON.parse(localStorage.getItem(this.key(variant)) || 'null'); } catch (_) {}
    }
    return { queue: data?.queue || [], lastServerOpId: data?.lastServerOpId || 0 };
  },
  context(variant = queueGetVariant(), apiBase = queueGetApiBase()) {
    apiBase = (apiBase || '').replace(/\/$/, '');
    const key = apiBase + '|' + variant;
    let state = this.states.get(key);
    if (!state) {
      state = variant === queueGetVariant()
        ? { queue: this.queue, lastServerOpId: this.lastServerOpId }
        : this.readState(variant);
      this.states.set(key, state);
    }
    if (variant === queueGetVariant() && apiBase === (queueGetApiBase() || '').replace(/\/$/, '')) {
      state.queue = this.queue;
      state.lastServerOpId = this.lastServerOpId;
    }
    return { variant, apiBase, state };
  },
  isCurrent(ctx) {
    return ctx.variant === queueGetVariant() && ctx.apiBase === (queueGetApiBase() || '').replace(/\/$/, '');
  },
  assertServer(ctx) {
    if (ctx.apiBase !== (queueGetApiBase() || '').replace(/\/$/, '')) {
      throw new Error('Sync server changed; the previous job was stopped.');
    }
  },
  entries(ctx) {
    if (this.isCurrent(ctx)) return queueGetStore().getEntries();
    const db = queueStateDb();
    return (queueIsDocVariant(ctx.variant) ? db?.loadDocs(ctx.variant) : db?.loadEntries(ctx.variant)) || [];
  },
  persist(ctx, entries) {
    this.assertServer(ctx);
    const sdb = queueStateDb();
    if (entries && sdb?.saveSyncBatch) {
      sdb.saveSyncBatch(ctx.variant, entries, ctx.state);
    } else {
      if (entries) {
        if (this.isCurrent(ctx)) { queueGetStore().replaceAll(entries); queueGetStore().save(); }
        else if (queueIsDocVariant(ctx.variant)) sdb?.saveDocs(ctx.variant, entries);
        else sdb?.saveEntries(entries, ctx.variant);
      }
      if (sdb) sdb.setItem(this.key(ctx.variant), ctx.state);
      else localStorage.setItem(this.key(ctx.variant), JSON.stringify(ctx.state));
    }
    if (this.isCurrent(ctx)) {
      this.queue = ctx.state.queue;
      this.lastServerOpId = ctx.state.lastServerOpId;
      if (entries && sdb?.saveSyncBatch) queueGetStore().replaceAll(entries);
    }
    window.dispatchEvent(new CustomEvent('memo:sync-state'));
  },
  render(ctx, reason) {
    if (!this.isCurrent(ctx)) return;
    const previous = window.__memoRenderReason;
    window.__memoRenderReason = reason;
    try { queueGetStore().render(); }
    finally { window.__memoRenderReason = previous; }
  },
  init() {
    this.destroy();
    this.deviceId = localStorage.getItem('memo_device_id');
    if (!this.deviceId) {
      this.deviceId = 'device-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem('memo_device_id', this.deviceId);
    }
    this.reloadQueue();
    this.autoSyncInterval = setInterval(() => { if (!document.hidden) this.processQueue(); }, 300000);
    this.visibilityHandler = () => { if (!document.hidden) this.processQueue(); };
    this.focusHandler = () => {
      if (document.hidden || Date.now() - (this._lastFocusSync || 0) < 3000) return;
      this._lastFocusSync = Date.now(); this.processQueue();
    };
    this.onlineHandler = () => this.processQueue();
    this.unloadHandler = () => this.saveQueue();
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('focus', this.focusHandler);
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('memo:resume', this.onlineHandler);
    window.addEventListener('beforeunload', this.unloadHandler);
    this.processQueue();
  },
  reloadQueue() {
    const variant = queueGetVariant();
    const key = (queueGetApiBase() || '').replace(/\/$/, '') + '|' + variant;
    const state = this.states.get(key) || this.readState(variant);
    this.states.set(key, state);
    this.queue = state.queue;
    this.lastServerOpId = state.lastServerOpId;
  },
  saveQueue() { this.persist(this.context()); },

  // options.variant targets another collection than the current page (the
  // Vault and other app-wide collections write from any page).
  async addOperation(type, entryId, data = {}, options = {}) {
    const op = { clientOpId: `${this.deviceId || 'local'}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type, entryId, timestamp: Date.now(), deviceId: this.deviceId, synced: false,
      attempts: 0, nextRetry: 0, lastError: null, ...data };
    const ctx = this.context(options.variant || queueGetVariant());
    ctx.state.queue.push(op);
    const entries = this.entries(ctx).slice();
    this._applyOpToEntries(entries, op);
    this.persist(ctx, entries);
    this.render(ctx, 'local');
    // Mods listen for this (memo-mods.js, memora.on('saved')).
    const page = { default: 'notes', finance: 'spending', planner: 'plans' }[options.variant || queueGetVariant()];
    if (page) window.dispatchEvent(new CustomEvent('memo:entries-changed', { detail: { type, id: entryId, page } }));
    // Reviewed imports checkpoint the completed batch once. Their caller starts
    // synchronization only after that durable checkpoint succeeds.
    if (options.deferCheckpoint) return op.clientOpId;
    await queueStateDb()?.flush?.();
    // A follow-up pass includes edits made while another pass was in flight.
    this._requested = true;
    if (navigator.onLine) this.processQueue();
    return op.clientOpId;
  },
  async applyOperationLocally(op) {
    const ctx = this.context();
    const entries = this.entries(ctx).slice();
    this._applyOpToEntries(entries, op);
    this.persist(ctx, entries);
    this.render(ctx, 'local');
  },
  async beginRestore() {
    this._restoreDepth = (this._restoreDepth || 0) + 1;
    if (this._flight) await this._flight;
  },
  endRestore(sync) {
    this._restoreDepth = Math.max(0, (this._restoreDepth || 0) - 1);
    if (sync && !this._restoreDepth) this.processQueue();
  },
  reloadRestoredQueue() {
    this.states.clear();
    const state = this.readState(queueGetVariant());
    this.queue = state.queue;
    this.lastServerOpId = state.lastServerOpId;
  },
  journalRestore(before, mode, localFiles = new Set()) {
    const sdb = queueStateDb();
    if (!sdb) return;
    for (const variant of queueSyncVariants()) {
      if (!before[variant]) continue;
      const previous = new Map((before[variant] || []).map(e => [e.id, e]));
      const entries = queueIsDocVariant(variant) ? sdb.loadDocs(variant) : sdb.loadEntries(variant);
      const ids = new Set(entries.map(e => e.id));
      const changed = entries.filter(e => JSON.stringify(previous.get(e.id)) !== JSON.stringify(e));
      const removed = mode === 'replace' ? [...previous.keys()].filter(id => !ids.has(id)) : [];
      const changedIds = new Set(changed.map(e => e.id).concat(removed));
      const ctx = this.context(variant);
      ctx.state.queue = ctx.state.queue.filter(op => op.synced || !changedIds.has(op.entryId));
      const make = (type, entryId, data) => ({ type, entryId, data, synced: false, attempts: 0, nextRetry: 0,
        timestamp: Date.now(), deviceId: this.deviceId,
        clientOpId: `${this.deviceId || 'local'}-restore-${Date.now()}-${Math.random().toString(36).slice(2)}` });
      for (const id of removed) ctx.state.queue.push(make('delete', id));
      for (const entry of changed) {
        const data = JSON.parse(JSON.stringify(entry));
        delete data._storedPaths;
        delete data._attachments;
        if (!queueIsDocVariant(variant)) {
          const rel = value => typeof value === 'string' && /^\/?uploads\//.test(value) ? value.replace(/^\//, '') : null;
          const paths = [...new Set((data.images || []).concat((data.attachments || []).map(a => typeof a === 'string' ? a : a.url)).map(rel).filter(Boolean))];
          const local = paths.filter(path => localFiles.has(path));
          if (local.length) {
            data._filesToUpload = local;
            data._restoreFilePaths = true;
          }
        }
        ctx.state.queue.push(make('create', entry.id, data));
      }
      sdb.setItem(this.key(variant), ctx.state);
      if (this.isCurrent(ctx)) { this.queue = ctx.state.queue; this.lastServerOpId = ctx.state.lastServerOpId; }
    }
  },
  // The sync server's /api/config, cached per server for an hour. Unknown or
  // unreachable → null (the last good copy while one exists).
  async serverConfig(apiBase) {
    const base = (apiBase || '').replace(/\/$/, '');
    this._configs = this._configs || {};
    const hit = this._configs[base];
    if (hit && Date.now() - hit.at < 3600000) return hit.config;
    try {
      const response = window.MemoTransport
        ? await window.MemoTransport.request(`${base}/api/config`, { cache: 'no-store' }, base)
        : await fetch(`${base}/api/config`, { cache: 'no-store' });
      if (!response.ok) return hit ? hit.config : null;
      const config = await response.json();
      this._configs[base] = { config, at: Date.now() };
      return config;
    } catch (_) { return hit ? hit.config : null; }
  },
  // Collections the sync server accepts. Unknown → the three core collections.
  async serverCollections(apiBase) {
    const config = await this.serverConfig(apiBase);
    return config && Array.isArray(config.collections)
      ? config.collections.filter(v => typeof v === 'string') : CORE_VARIANTS.slice();
  },
  processQueue() {
    if (this._restoreDepth) return Promise.resolve({ status: 'restoring' });
    if (this._flight) return this._flight;
    const hasServer = !!queueGetApiBase() || queueGetMode() === 'server';
    if (!hasServer) { this.updateSyncUI('local'); return Promise.resolve({ status: 'local', pending: this.queue.filter(o => !o.synced).length }); }
    const syncBase = (queueGetApiBase() || '').replace(/\/$/, '');
    this.isSyncing = true;
    this.updateSyncUI('syncing', 'Syncing...');
    this._flight = (async () => {
      let result = { status: 'success', pending: 0, failed: 0 };
      try {
        do {
          this._requested = false;
          const first = queueGetVariant();
          const base = queueGetApiBase();
          // Core collections first, unchanged; newer ones (the Vault) only
          // after the server has said it accepts them.
          const variants = queueStateDb() ? [first, ...queueSyncVariants().filter(v => v !== first)] : [first];
          result = { status: 'success', pending: 0, failed: 0 };
          for (const variant of variants) {
            if (!CORE_VARIANTS.includes(variant) && !(await this.serverCollections(base)).includes(variant)) continue;
            const ctx = this.context(variant, base);
            try {
              await this.pushUnsyncedOperations(ctx);
              await this.pullServerOperations(ctx);
            } catch (error) {
              result.error = error.message;
              if (result.status !== 'auth') result.status = error.status === 401 ? 'auth' : 'offline';
            }
            result.pending += ctx.state.queue.filter(o => !o.synced).length;
            result.failed += ctx.state.queue.filter(o => !o.synced && o.lastError).length;
          }
        } while (this._requested && result.status === 'success');
        if (result.status === 'success' && result.pending) result.status = 'pending';
        if (syncBase !== (queueGetApiBase() || '').replace(/\/$/, '')) return result;
        if (result.status === 'success') {
          this.lastSuccessfulSync = Date.now();
          try { localStorage.setItem('memo_last_sync:' + syncBase, String(this.lastSuccessfulSync)); } catch (_) {}
        }
        this.lastResult = result;
        const message = result.status === 'auth' ? 'Sync password required. Changes saved on this device'
          : result.status === 'offline' ? 'Server unavailable. Changes saved on this device'
          : result.pending ? `Saved on this device. ${result.pending} pending` : 'Synced';
        this.updateSyncUI(result.status, message);
        return result;
      } finally {
        this.isSyncing = false; this._flight = null;
        if (this.presentation?.status === 'syncing') this.presentation = null;
        window.dispatchEvent(new CustomEvent('memo:sync-state'));
      }
    })();
    return this._flight;
  },
  async pushUnsyncedOperations(ctx = this.context()) {
    const pending = ctx.state.queue.filter(o => !o.synced);
    if (!pending.length) return;
    if (pending.some(o => !(Date.now() < o.nextRetry))) await queueStateDb()?.flush?.();
    const blocked = new Set();
    let changed = false, rejectedNow = 0;
    for (const op of pending) {
      if (blocked.has(op.entryId) || Date.now() < op.nextRetry) { blocked.add(op.entryId); continue; }
      changed = true;
      try {
        await this.uploadFilesForOperation(op, ctx);
        await this.pushOperationToServer(op, ctx);
        this.assertServer(ctx);
        op.synced = true; op.lastError = null;
        if (op.rejected) rejectedNow += 1;
      } catch (error) {
        op.attempts = (op.attempts || 0) + 1;
        op.lastError = error.message;
        op.nextRetry = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(op.attempts, 8));
        op.needsManualReview = op.attempts > 10;
        blocked.add(op.entryId);
        if (error.status === 401) { this.persist(ctx); throw error; }
      }
    }
    if (!changed) return;
    if (rejectedNow) {
      const t = window.MemoI18n ? window.MemoI18n.t : (s, v) => s.replace('{n}', v.n);
      window.MemoShell?.toast?.(t('{n} change(s) were not saved: the entry no longer exists on your server.', { n: rejectedNow }), { kind: 'error', ms: 6000 });
    }
    const completed = ctx.state.queue.filter(o => o.synced).slice(-100);
    ctx.state.queue = ctx.state.queue.filter(o => !o.synced || completed.includes(o));
    this.persist(ctx);
    await queueStateDb()?.flush?.();
  },
  async request(url, options = {}, ctx = this.context()) {
    this.assertServer(ctx);
    const response = window.MemoTransport
      ? await window.MemoTransport.request(url, options, ctx.apiBase)
      : await fetch(url, options);
    this.assertServer(ctx);
    if (!response.ok) {
      const error = new Error(`Sync request failed (${response.status})`);
      error.status = response.status; throw error;
    }
    return response;
  },
  async pushOperationToServer(op, ctx = this.context()) {
    const cleanData = op.data && typeof op.data === 'object'
      ? Object.fromEntries(Object.entries(op.data).filter(([key]) => !key.startsWith('_'))) : op.data;
    const wire = { clientOpId: op.clientOpId, type: op.type, entryId: op.entryId, timestamp: op.timestamp,
      deviceId: op.deviceId, data: cleanData, field: op.field, value: op.value, url: op.url, attachment: op.attachment };
    const response = await this.request(`${ctx.apiBase}/api/operations/push?variant=${ctx.variant}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operations: [wire] }) }, ctx);
    const result = await response.json();
    // The server has no such entry (e.g. it was permanently deleted elsewhere):
    // retrying cannot help, so the change is recorded as rejected and shown.
    const rejected = result.rejected?.find(item => item.clientOpId === op.clientOpId);
    if (rejected) { op.rejected = rejected.reason || 'rejected'; return; }
    const assigned = result.operations?.find(item => item.clientOpId === op.clientOpId);
    if (!assigned || result.success === false) throw new Error('Server did not acknowledge the operation');
    // Last write wins by edit time: a newer edit is already on the server, so
    // this device adopts the server's copy instead of keeping its older one.
    if (assigned.stale) { op.stale = true; if (assigned.entry) this._adoptServerEntry(ctx, assigned.entry, op); return; }
    op.serverOpId = assigned.serverOpId;
    // An upload acknowledgement says nothing about unseen remote operations.
  },
  // Pulls come in pages so a first sync of years of data never arrives as one
  // huge response. Pages are collected, then applied once exactly as a single
  // response was. A server without paging ignores `limit` and answers in one.
  PULL_PAGE: 2000,
  async pullServerOperations(ctx = this.context()) {
    const get = async params => {
      const query = new URLSearchParams({ variant: ctx.variant, limit: String(this.PULL_PAGE), ...params });
      const response = await this.request(`${ctx.apiBase}/api/operations/pull?${query}`, { method: 'GET', cache: 'no-store' }, ctx);
      const page = await response.json();
      if (!page || !Array.isArray(page.operations)) throw new Error('Invalid sync response');
      return page;
    };
    const since = ctx.state.lastServerOpId;
    let page = await get({ sinceOpId: since });
    let result = page;
    if (page.needsFullSync) {
      let entries = [], restarts = 0;
      for (;;) {
        if (page.snapshotChanged) {
          // Compaction replaced the snapshot while it was being paged.
          if (++restarts > 3) throw new Error('The server snapshot kept changing; sync again later');
          entries = []; page = await get({ sinceOpId: since }); continue;
        }
        if (!page.snapshot || !Array.isArray(page.snapshot.entries)) throw new Error('Missing sync snapshot');
        for (const entry of page.snapshot.entries) entries.push(entry);
        if (page.snapshotNextOffset == null) break;
        page = await get({ sinceOpId: since, snapshotOffset: page.snapshotNextOffset, snapshotId: page.snapshot.snapshotId });
      }
      result = { ...page, snapshot: { ...page.snapshot, entries }, operations: page.operations.slice() };
    }
    while (page.hasMore) {
      page = await get({ sinceOpId: page.latestOpId });
      for (const op of page.operations) result.operations.push(op);
    }
    await this.applyPull(result, ctx);
  },
  // A stale push: show the server's copy of the entry, with this device's later
  // pending changes for it still on top. Local-only fields (stored file paths)
  // are kept when the images did not change.
  _adoptServerEntry(ctx, serverEntry, staleOp) {
    const entries = this.entries(ctx).slice();
    const index = entries.findIndex(e => e.id === serverEntry.id);
    const old = index < 0 ? null : entries[index];
    const local = old && JSON.stringify(old.images || []) === JSON.stringify(serverEntry.images || [])
      ? Object.fromEntries(Object.entries(old).filter(([key]) => key.startsWith('_'))) : {};
    const adopted = { ...local, ...serverEntry };
    if (index < 0) entries.push(adopted); else entries[index] = adopted;
    for (const op of ctx.state.queue) {
      if (!op.synced && op !== staleOp && op.entryId === serverEntry.id) this._applyOpToEntries(entries, op);
    }
    this.persist(ctx, entries);
    this.render(ctx, 'sync');
  },
  async applyPull(result, ctx) {
    this.assertServer(ctx);
    const snapshot = result.needsFullSync && result.snapshot;
    if (result.needsFullSync && !snapshot) throw new Error('Missing sync snapshot');
    if (snapshot && (!Array.isArray(snapshot.entries) || !Number.isFinite(snapshot.snapshotId))) throw new Error('Invalid sync snapshot');
    const pending = ctx.state.queue.filter(o => !o.synced);
    // Most pulls bring nothing: then nothing can change, so no entries are
    // loaded or compared (a whole notebook is tens of MB in memory).
    if (!snapshot && !(result.operations || []).some(op => op.opId > ctx.state.lastServerOpId) && !pending.length) {
      if (this.isCurrent(ctx) && (window.MemoOfflineFiles || window.SyncManager?.downloadAssets)) this._cacheAssets(ctx, this.entries(ctx));
      return;
    }
    const current = this.entries(ctx);
    let cursor = snapshot ? snapshot.snapshotId : ctx.state.lastServerOpId;
    // _applyOpToEntries never edits an entry in place (it replaces it with a
    // copy), so a shallow array copy is enough for both paths.
    const entries = snapshot ? snapshot.entries.slice() : current.slice();
    for (const op of (result.operations || [])) {
      if (!Number.isFinite(op.opId)) throw new Error('Invalid sync operation ID');
      if (op.opId <= cursor) continue;
      this._applyOpToEntries(entries, op);
      cursor = op.opId;
    }
    // Local intent overlays both snapshots and incremental remote edits. Replays
    // are idempotent, including attachments, and never erase pending creates.
    for (const op of pending) {
      if (op.type === 'update' && !entries.some(e => e.id === op.entryId)) {
        const local = current.find(e => e.id === op.entryId);
        if (local) entries.push({ ...local });
      }
      this._applyOpToEntries(entries, op);
    }
    const changed = this._entriesChanged(entries, current, !!snapshot);
    const previousCursor = ctx.state.lastServerOpId;
    ctx.state.lastServerOpId = cursor;
    try { if (changed || cursor !== previousCursor) this.persist(ctx, changed ? entries : undefined); }
    catch (error) { ctx.state.lastServerOpId = previousCursor; throw error; }
    if (changed) this.render(ctx, 'sync');
    if (changed || cursor !== previousCursor) await queueStateDb()?.flush?.();
    // Only cache bytes. Do not write captured entry arrays back over newer edits.
    if (window.MemoOfflineFiles || window.SyncManager?.downloadAssets) {
      this._cacheAssets(ctx, entries);
    }
  },
  // Did applying operations change anything? An incremental pull starts from
  // current.slice(), so untouched entries are the same objects in the same
  // places: only replaced or added entries are compared, one at a time. A
  // snapshot is compared entry by entry against the current list by id.
  _entriesChanged(entries, current, fromSnapshot) {
    if (entries.length !== current.length) return true;
    if (!fromSnapshot) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i] !== current[i] && JSON.stringify(entries[i]) !== JSON.stringify(current[i])) return true;
      }
      return false;
    }
    const byId = new Map(current.map(e => [e.id, e]));
    for (const e of entries) {
      const old = byId.get(e.id);
      if (!old || JSON.stringify(e) !== JSON.stringify(old)) return true;
    }
    return false;
  },
  async _cacheAssets(ctx, entries) {
    if (window.MemoOfflineFiles) return window.MemoOfflineFiles.enqueue(entries, ctx.variant, ctx.apiBase);
    for (const entry of entries) {
      if (!entry.images?.length && !entry.attachments?.length) continue;
      try {
        this.assertServer(ctx);
        await window.SyncManager.downloadAssets(JSON.parse(JSON.stringify(entry)), ctx.apiBase);
        if (this.isCurrent(ctx)) window.dispatchEvent(new CustomEvent('memo:assets-cached'));
      } catch (_) { break; }
    }
  },
  async applySnapshot(snapshot, variant = queueGetVariant()) {
    const ctx = this.context(variant);
    await this.applyPull({ needsFullSync: true, snapshot, operations: [] }, ctx);
    return this.isCurrent(ctx);
  },
  async syncOtherVariants() { return this.processQueue(); },
  async syncVariantToStore(variant, apiBase) {
    const ctx = this.context(variant, apiBase);
    await this.pushUnsyncedOperations(ctx);
    return this.pullServerOperations(ctx);
  },
  _applyOpToEntries(entries, op) {
    if (!op.entryId) throw new Error('Operation has no entry ID');
    const index = entries.findIndex(e => e.id === op.entryId);
    const old = index < 0 ? null : entries[index];
    const stamp = new Date(op.timestamp || Date.now()).toISOString();
    let entry = old ? { ...old } : null;
    switch (op.type) {
      // A create means "this entry exists": like the server, it clears an old
      // deletion of the same id unless the create itself carries one (restores).
      case 'create': entry = { ...old, deletedAt: null, deletedBy: null, ...op.data, id: op.entryId,
        createdAt: op.data?.createdAt || old?.createdAt || stamp, updatedAt: op.data?.updatedAt || stamp }; break;
      case 'update':
        if (!entry) return;
        if (op.data) Object.assign(entry, op.data);
        else if (op.field != null) entry[op.field] = op.value;
        entry.updatedAt = stamp; break;
      case 'delete': if (!entry) return; entry.deletedAt = stamp; entry.deletedBy = op.deviceId; break;
      case 'addImage': if (!entry) return;
        entry.images = [...new Set([...(entry.images || []), ...(op.url ? [op.url] : [])])]; break;
      case 'addAttachment': if (!entry) return;
        entry.attachments = [...(entry.attachments || [])];
        if (op.attachment && !entry.attachments.some(a => JSON.stringify(a) === JSON.stringify(op.attachment))) entry.attachments.push(op.attachment);
        break;
      default: throw new Error('Unsupported sync operation: ' + op.type);
    }
    if (op.data && Object.prototype.hasOwnProperty.call(op.data, 'images') && !Object.prototype.hasOwnProperty.call(op.data, '_storedPaths')) {
      delete entry._storedPaths;
    }
    if (index < 0) entries.push(entry); else entries[index] = entry;
  },
  async uploadFilesForOperation(op, context = this.context()) {
    console.log(`📤 uploadFilesForOperation for ${op.type} on ${op.entryId}`);
    
    // App-private blobs live in the SQLite store; upload from there.
    if (!queueStateDb()) {
      console.log('📤 No local blob store, skipping uploads');
      return;
    }
    
    // Upload image if needed
    if (op.type === 'addImage' && op.localFilePath && !op.url) {
      const url = await this.uploadFile(op.localFilePath, context);
      op.url = url;
    }
    
    // Upload attachment if needed
    if (op.type === 'addAttachment' && op.attachment && op.attachment.storedPath && !op.attachment.url) {
      const url = await this.uploadFile(op.attachment.storedPath, context);
      op.attachment.url = url;
    }
    
    // Upload files in operation data if needed
    if (op.data && op.data._filesToUpload) {
      // Rebuild each attempt so a retried upload never appends duplicates
      // (which would misalign the rel -> url mapping below).
      op.data._uploadedUrls = [];
      for (const filePath of op.data._filesToUpload) {
        const url = await this.uploadFile(filePath, context);
        op.data._uploadedUrls.push(url);
      }
    }
    if (op.data?._restoreFilePaths) {
      const remap = new Map(op.data._filesToUpload.map((path, index) => [path, op.data._uploadedUrls[index]]));
      const resolve = value => typeof value === 'string' ? (remap.get(value.replace(/^\//, '')) || value) : value;
      const original = op.data.images || [];
      op.data.images = original.map(resolve);
      remapOperationImageMeta(op.data, original, op.data.images);
      op.data.attachments = (op.data.attachments || []).map(a => typeof a === 'string' ? resolve(a) : { ...a, url: resolve(a.url) });
    }

    // Materialise the entry's images/attachments from durable rel paths using
    // the freshly-uploaded server URLs. memo-core intentionally omits `images`
    // at creation time (so the local apply keeps display URLs); a create/update
    // op only gains server-resolvable URLs here, right before push. Without this
    // the files uploaded but were never linked to the entry on the server.
    if (op.data && (op.data._storedPaths || op.data._attachments)) {
      const map = {};
      const rels = op.data._filesToUpload || [];
      const urls = op.data._uploadedUrls || [];
      for (let i = 0; i < rels.length; i++) { if (urls[i]) map[rels[i]] = urls[i]; }
      const resolve = (rel) => !rel ? rel : (map[rel] || (rel.charAt(0) === '/' ? rel : '/' + rel));
      if (Array.isArray(op.data._storedPaths)) {
        const sourcePaths = op.data._storedPaths.slice();
        const resolvedImages = sourcePaths.map(resolve);
        remapOperationImageMeta(op.data, sourcePaths, resolvedImages);
        op.data.images = resolvedImages;
      }
      if (Array.isArray(op.data._attachments)) {
        op.data.attachments = op.data._attachments.map(a => ({
          name: a.name, type: a.type, url: (a.storedPath ? resolve(a.storedPath) : null) || a.url
        }));
      }
    }

    // Last line of defence: a blob: URL is a handle into THIS session's memory.
    // Pushing one to the server records a reference no device can ever resolve
    // (and the bytes were never uploaded), which is exactly how a synced receipt
    // turned into an attachment that renders nowhere. If one survives to here the
    // file failed to persist, so fail the push: the op stays queued and retries
    // with backoff instead of writing an unresolvable reference into shared data.
    const blobRefs = []
      .concat((op.data && Array.isArray(op.data.images)) ? op.data.images : [])
      .concat((op.data && Array.isArray(op.data.attachments)) ? op.data.attachments.map(a => a && a.url) : [])
      .concat([op.url, op.attachment && op.attachment.url])
      .filter(u => typeof u === 'string' && u.startsWith('blob:'));
    if (blobRefs.length) {
      throw new Error(`Refusing to sync ${blobRefs.length} unsaved file reference(s) (blob: URL) on ` +
                      `${op.type} ${op.entryId} — the file was never written to the local store.`);
    }
  },
  
  /**
   * Upload a file to server with checksum validation
   */
  async uploadFile(localFilePath, context = this.context()) {
    const filename = localFilePath.split('/').pop();

    // Read the blob from the app-private store (OPFS / Capacitor DATA / IDB).
    const sdb = queueStateDb();
    const blob = sdb ? await sdb.readBlob(localFilePath) : null;
    if (!blob) throw new Error('Local blob not found: ' + localFilePath);
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });

    // Calculate checksum
    const arrayBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const clientHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    console.log(`📤 Uploading ${filename} (hash: ${clientHash.substr(0, 8)}...)`);
    
    // Upload to server
    let apiBase = context.apiBase;
    apiBase = apiBase.replace(/\/$/, '');
    const uploadUrl = `${apiBase}/api/upload`;
    
    let uploadResp;
    if (window.Capacitor?.Plugins?.CapacitorHttp) {
      uploadResp = await this.request(uploadUrl, { method: 'POST', body: JSON.stringify({
        file: await this.fileToBase64(file), filename, type: file.type || 'application/octet-stream'
      }), headers: { 'Content-Type': 'application/json' } }, context);
    } else {
      const formData = new FormData();
      formData.append('file', file, filename);
      uploadResp = await this.request(uploadUrl, { method: 'POST', body: formData }, context);
    }
    if (!uploadResp.ok) {
      throw new Error(`Upload failed: ${uploadResp.status}`);
    }
    
    const result = await uploadResp.json();
    
    // Verify checksum
    if (result.hash && result.hash !== clientHash) {
      throw new Error(`Checksum mismatch! Client: ${clientHash.substr(0, 8)}, Server: ${result.hash.substr(0, 8)}`);
    }
    
    console.log(`✅ Upload verified: ${result.url}`);
    return result.url;
  },
  

  fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result);
      reader.onerror = reject; reader.readAsDataURL(file);
    });
  },
  updateSyncUI(status, message) {
    this.presentation = { status, apiBase: (queueGetApiBase() || '').replace(/\/$/, '') };
    window.dispatchEvent(new CustomEvent('memo:sync-state'));
    if (window.MemoSyncStatus) return;
    const el = document.getElementById('syncStatus');
    if (!el) return;
    el.className = `sync-status ${status}`;
    el.title = message; el.setAttribute('aria-label', message);
    const icon = el.querySelector('#syncIcon'), text = el.querySelector('#syncText');
    if (icon) icon.innerHTML = `<span class="svg-icon svg-icon-${status === 'syncing' ? 'refresh' : status === 'success' ? 'check' : 'cloud'}"></span>`;
    if (text) text.textContent = message;
  },
  manualSync() {
    for (const state of this.states.values()) for (const op of state.queue) if (!op.synced) op.nextRetry = 0;
    return this.processQueue();
  },
  destroy() {
    if (this.autoSyncInterval !== null) clearInterval(this.autoSyncInterval);
    this.autoSyncInterval = null;
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
    if (this.focusHandler) window.removeEventListener('focus', this.focusHandler);
    if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler);
    if (this.onlineHandler) window.removeEventListener('memo:resume', this.onlineHandler);
    if (this.unloadHandler) window.removeEventListener('beforeunload', this.unloadHandler);
    this.visibilityHandler = this.focusHandler = this.onlineHandler = this.unloadHandler = null;
    this._lastFocusSync = 0;
  }
};
window.OperationQueue = OperationQueue;
