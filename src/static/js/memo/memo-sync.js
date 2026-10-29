/**
 * Memo Sync Manager (Operation Queue Only)
 * Keeps compatibility methods used by core/settings while delegating sync to OperationQueue.
 */

const SyncContracts = (typeof window !== 'undefined' && window.MemoContracts) ? window.MemoContracts : null;
const SyncRuntime = (typeof window !== 'undefined' && window.MemoRuntime) ? window.MemoRuntime : null;

function getOperationQueue() {
  if (SyncRuntime && typeof SyncRuntime.getService === 'function') {
    return SyncRuntime.getService('operationQueue', window.OperationQueue);
  }
  if (SyncContracts && typeof SyncContracts.getService === 'function') {
    const svc = SyncContracts.getService('operationQueue');
    if (svc) return svc;
  }
  return window.OperationQueue;
}

function getApiBase() {
  if (SyncRuntime && typeof SyncRuntime.getApiBase === 'function') {
    return SyncRuntime.getApiBase();
  }
  if (SyncContracts && typeof SyncContracts.getApiBase === 'function') {
    return SyncContracts.getApiBase();
  }
  return '';
}

const SyncManager = {
  syncState: {
    isSyncing: false,
    autoSyncInterval: null,
    visibilityHandler: null,
    unloadHandler: null
  },

  async init() {
    console.log('📡 Sync Manager: Initializing (operation queue only)...');

    if (this.syncState.autoSyncInterval) {
      clearInterval(this.syncState.autoSyncInterval);
      this.syncState.autoSyncInterval = null;
    }
    if (this.syncState.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.syncState.visibilityHandler);
      this.syncState.visibilityHandler = null;
    }
    if (this.syncState.unloadHandler) {
      window.removeEventListener('beforeunload', this.syncState.unloadHandler);
      this.syncState.unloadHandler = null;
    }

    const operationQueue = getOperationQueue();
    if (operationQueue && operationQueue.init) {
      operationQueue.init();
    } else {
      console.warn('⚠️ OperationQueue not found; sync is unavailable.');
      return;
    }

    // The current OperationQueue owns its cadence and lifecycle hooks. Keep the
    // legacy fallback below for alternate queue adapters that do not declare
    // ownership, but never schedule a second five-minute loop for the built-in
    // queue.
    if (operationQueue.ownsSyncCadence === true) return;

    this.syncState.autoSyncInterval = setInterval(() => {
      this.performSync();
    }, 5 * 60 * 1000);

    this.syncState.visibilityHandler = () => {
      if (!document.hidden && !this.syncState.isSyncing) {
        this.performSync();
      }
    };
    document.addEventListener('visibilitychange', this.syncState.visibilityHandler);

    this.syncState.unloadHandler = () => {
      const operationQueue = getOperationQueue();
      if (operationQueue && operationQueue.saveQueue) {
        operationQueue.saveQueue();
      }
    };
    window.addEventListener('beforeunload', this.syncState.unloadHandler);
  },

  performSync() { return getOperationQueue()?.processQueue(); },
  manualSync() { return getOperationQueue()?.manualSync(); },

  markModified(_entryId) {
    // No-op in operation queue architecture.
  },

  saveSyncState() {
    // Legacy no-op retained for compatibility.
  },

  normalizeServerEntry(serverEntry) {
    if (window.MemoVariant && typeof window.MemoVariant.normalizeServerMemo === 'function') {
      return window.MemoVariant.normalizeServerMemo(serverEntry);
    }

    return {
      id: serverEntry.id,
      description: serverEntry.description || '',
      category: serverEntry.category || 'Uncategorized',
      tags: serverEntry.tags || [],
      ts: serverEntry.ts || Date.now(),
      images: serverEntry.images || [],
      attachments: serverEntry.attachments || [],
      createdAt: serverEntry.createdAt,
      updatedAt: serverEntry.updatedAt,
      deletedAt: serverEntry.deletedAt || null,
      deletedBy: serverEntry.deletedBy || null,
      permanentDeleteAt: serverEntry.permanentDeleteAt || null
    };
  },

  async downloadAssets(entry, sourceBase = getApiBase()) {
    const apiBase = sourceBase.replace(/\/$/, '');
    const isFileProtocol = window.location.protocol === 'file:';
    // On a native (Capacitor) build the page runs at https://localhost but the
    // sync server is a *different* origin (often plain http on the LAN). An <img>
    // can't load those URLs (mixed content / cross-origin), so synced files must
    // be cached to the local blob store and displayed from there. Only a genuine
    // web deployment — served over https from the same origin as its uploads —
    // can safely skip the local copy.
    const isCapacitor = !!(window.Capacitor && (typeof window.Capacitor.isNativePlatform === 'function'
      ? window.Capacitor.isNativePlatform() : window.Capacitor.Plugins));
    const needsDownload = isFileProtocol || isCapacitor || !navigator.onLine;

    if (!needsDownload && window.location.protocol === 'https:') {
      return entry;
    }

    // Cache synced assets into the app-private SQLite blob store so they're
    // available offline (and rehydrate as object URLs on load).
    const sdb = (window.MemoStateDb && typeof window.MemoStateDb.ready === 'function' && window.MemoStateDb.ready())
      ? window.MemoStateDb : null;
    if (!sdb) {
      return entry;
    }

    const downloadBlobOnce = async (url) => {
      try {
        const response = window.MemoTransport
          ? await window.MemoTransport.request(url, { responseType: 'blob' }, apiBase)
          : await fetch(url);
        return response.ok ? await response.blob() : null;
      } catch (_) { return null; }
    };
    // Mobile transfers can drop mid-stream ("unexpected end of stream"); a
    // single flaked image would otherwise stay a broken thumbnail until the next
    // full sync. Retry a couple of times with backoff before giving up.
    const downloadBlob = async (url) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const blob = await downloadBlobOnce(url);
        if (blob) return blob;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
      return null;
    };

    const cache = async (url) => {
      const match = url && url.match(/\/uploads\/([^\/]+)\/(.+)/);
      if (!match) return null;
      const rel = `uploads/${match[1]}/${match[2]}`;
      // Already in the local store — don't re-download it on every sync. This is
      // what makes a warm re-sync (and background variant sync) fast instead of
      // re-fetching every image each time.
      try { if (await sdb.readBlob(rel)) return rel; } catch (_e) {}
      const fullUrl = (url.startsWith('http://') || url.startsWith('https://')) ? url : `${apiBase}${url}`;
      this._assetDownloads = this._assetDownloads || new Map();
      if (!this._assetDownloads.has(fullUrl)) {
        this._assetDownloads.set(fullUrl, (async () => {
          const blob = await downloadBlob(fullUrl);
          if (!blob) return null;
          try { await sdb.writeBlob(rel, blob); return rel; } catch (_) { return null; }
        })().finally(() => this._assetDownloads.delete(fullUrl)));
      }
      return this._assetDownloads.get(fullUrl);
    };

    if (entry.images && entry.images.length > 0) {
      const storedPaths = [];
      for (const imgUrl of entry.images) {
        const rel = await cache(imgUrl);
        if (rel) storedPaths.push(rel);
      }
      if (storedPaths.length > 0) entry._storedPaths = storedPaths;
    }

    if (entry.attachments && entry.attachments.length > 0) {
      for (const attachment of entry.attachments) {
        const rel = await cache(attachment && attachment.url);
        if (rel) attachment.storedPath = rel;
      }
    }

    return entry;
  },

  base64ToBlob(base64, mimeType = 'application/octet-stream') {
    try {
      const byteCharacters = atob(base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      return new Blob([byteArray], { type: mimeType });
    } catch {
      return null;
    }
  },

  updateSyncUI(status, message) {
    if (window.OperationQueue?.ownsSyncCadence) { window.MemoSyncStatus?.refresh(); return; }
    const el = document.getElementById('syncStatus');
    if (!el) return;

    const iconEl = el.querySelector('#syncIcon');
    const textEl = el.querySelector('#syncText');
    if (!iconEl || !textEl) return;

    el.className = `sync-status ${status}`;

    const icons = {
      syncing: 'refresh',
      success: 'check',
      error: 'x',
      idle: 'cloud'
    };

    iconEl.innerHTML = `<span class="svg-icon svg-icon-${icons[status] || icons.idle}"></span>`;
    textEl.textContent = message;

    if (status === 'success') {
      setTimeout(() => {
        if (el.classList.contains('success')) {
          iconEl.innerHTML = '<span class="svg-icon svg-icon-cloud"></span>';
          textEl.textContent = 'Synced';
          el.className = 'sync-status';
        }
      }, 2000);
    }
  },

  destroy() {
    if (this.syncState.autoSyncInterval) {
      clearInterval(this.syncState.autoSyncInterval);
      this.syncState.autoSyncInterval = null;
    }
    if (this.syncState.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.syncState.visibilityHandler);
      this.syncState.visibilityHandler = null;
    }
    if (this.syncState.unloadHandler) {
      window.removeEventListener('beforeunload', this.syncState.unloadHandler);
      this.syncState.unloadHandler = null;
    }
  }
};

window.SyncManager = SyncManager;
if (SyncContracts && typeof SyncContracts.registerService === 'function') {
  SyncContracts.registerService('syncManager', SyncManager);
}
