// Attachment readiness is separate from metadata sync. Durable entry references
// are the work list, so an interrupted transfer is rediscovered after restart.
(function (global) {
  'use strict';
  const states = new Map();
  const base = () => (global.MemoRuntime?.getApiBase?.() || '').replace(/\/$/, '');
  const changed = () => global.dispatchEvent(new Event('memo:offline-files'));
  function references(entries) {
    const files = new Map();
    for (const entry of entries) {
      if (entry.deletedAt) continue;
      for (const url of [...(entry.images || []), ...(entry._storedPaths || []), ...(entry.attachments || []).map(a => a.url || a.storedPath)]) {
        if (typeof url !== 'string') continue;
        const match = url.match(/(?:^|\/)uploads\/([^?#]+)/);
        if (match) files.set('uploads/' + match[1], { path: 'uploads/' + match[1], entryId: entry.id });
      }
    }
    return [...files.values()];
  }
  function enqueue(entries, variant, apiBase, download = true) {
    apiBase = (apiBase || '').replace(/\/$/, '');
    const key = apiBase + '|' + variant;
    let state = states.get(key);
    if (!state) { state = { variant, apiBase, files: [], running: false }; states.set(key, state); }
    state.next = references(entries); state.download = download; changed();
    if (state.flight) return state.flight;
    state.flight = (async () => {
      state.running = true;
      while (state.next) {
        state.files = state.next.map(file => ({ ...file, status: 'pending' })); state.next = null; changed();
        for (const file of state.files) {
          if (base() !== apiBase) break;
          try {
            if (await global.MemoStateDb.readBlob(file.path)) { file.status = 'ready'; continue; }
            if (!state.download) continue;
            file.status = 'downloading'; changed();
            const response = await global.MemoTransport.request(apiBase + '/' + file.path, { responseType: 'blob' }, apiBase);
            if (!response.ok) {
              file.reason = response.status === 401 ? 'Sync password required' : response.status === 404 ? 'File missing on server' : 'File download failed';
              throw new Error(file.reason);
            }
            const blob = await response.blob();
            if (!blob.size) { file.reason = 'File download failed'; throw new Error(file.reason); }
            if (base() !== apiBase) break;
            try { await global.MemoStateDb.writeBlob(file.path, blob); }
            catch (error) { file.reason = 'Could not store file on this device'; throw error; }
            file.status = 'ready';
            global.dispatchEvent(new Event('memo:assets-cached'));
          } catch (_) { file.status = 'failed'; file.reason ||= 'File download failed'; }
          finally { changed(); }
        }
      }
    })().finally(() => { state.running = false; state.flight = null; changed(); });
    return state.flight;
  }
  function snapshot() {
    const relevant = [...states.values()].filter(s => s.apiBase === base());
    const files = relevant.flatMap(s => s.files.map(f => ({ ...f, variant: s.variant })));
    return { checked: relevant.length === 3, running: relevant.some(s => s.running || s.next),
      total: files.length, ready: files.filter(f => f.status === 'ready').length,
      failed: files.filter(f => f.status === 'failed'), pending: files.filter(f => f.status !== 'ready').length };
  }
  async function scan(download = false) {
    const db = global.MemoStateDb;
    if (!db?.ready()) return;
    const apiBase = base();
    await Promise.all(['default', 'finance', 'planner'].map(variant => enqueue(
      variant === 'planner' ? db.loadDocs(variant) : db.loadEntries(variant), variant, apiBase, download)));
  }
  global.MemoOfflineFiles = { enqueue, snapshot, scan };
  global.addEventListener('load', () => {
    Promise.resolve(global.MemoAppReady).then(() => scan(false)).catch(() => {});
  }, { once: true });
})(window);
