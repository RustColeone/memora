/**
 * Memo Sync Manager (Operation Queue Only)
 * Keeps compatibility methods used by core/settings while delegating sync to OperationQueue.
 */

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

    if (window.OperationQueue && window.OperationQueue.init) {
      window.OperationQueue.init();
    } else {
      console.warn('⚠️ OperationQueue not found; sync is unavailable.');
      return;
    }

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
      if (window.OperationQueue && window.OperationQueue.saveQueue) {
        window.OperationQueue.saveQueue();
      }
    };
    window.addEventListener('beforeunload', this.syncState.unloadHandler);
  },

  async performSync() {
    if (this.syncState.isSyncing) return;
    if (!(window.OperationQueue && window.OperationQueue.processQueue)) return;

    this.syncState.isSyncing = true;
    this.updateSyncUI('syncing', 'Syncing...');
    try {
      await window.OperationQueue.processQueue();
      this.updateSyncUI('success', 'Synced');
    } catch (err) {
      console.error('Operation queue sync failed:', err);
      this.updateSyncUI('error', 'Sync failed');
    } finally {
      this.syncState.isSyncing = false;
    }
  },

  async manualSync() {
    await this.performSync();
  },

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

  async downloadAssets(entry) {
    const apiBase = (window.API_BASE || '').replace(/\/$/, '');
    const isFileProtocol = window.location.protocol === 'file:';
    const needsDownload = isFileProtocol || !navigator.onLine;

    if (!needsDownload && window.location.protocol === 'https:') {
      return entry;
    }

    const { settings } = window.MemoCore.getState();
    const fsEnabled = settings.fsEnabled && settings.memoDirHandle;
    if (!fsEnabled) {
      return entry;
    }

    const getOrCreateDir = async (root, name) => {
      try {
        return await root.getDirectoryHandle(name, { create: true });
      } catch {
        return null;
      }
    };

    const writeFileToFS = async (dirHandle, filename, blob) => {
      try {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch {
        return false;
      }
    };

    const downloadBlob = async (url) => {
      try {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
          const response = await window.Capacitor.Plugins.CapacitorHttp.get({
            url,
            responseType: 'blob'
          });
          if (response.status >= 200 && response.status < 300) {
            if (typeof response.data === 'string') {
              return this.base64ToBlob(response.data);
            }
            return response.data;
          }
        }
      } catch {}

      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.blob();
      } catch {
        return null;
      }
    };

    if (entry.images && entry.images.length > 0) {
      const storedPaths = [];

      for (const imgUrl of entry.images) {
        const match = imgUrl && imgUrl.match(/\/uploads\/([^\/]+)\/(.+)/);
        if (!match) continue;

        const dateFolder = match[1];
        const filename = match[2];
        const fullUrl = imgUrl.startsWith('http://') || imgUrl.startsWith('https://')
          ? imgUrl
          : `${apiBase}${imgUrl}`;

        const blob = await downloadBlob(fullUrl);
        if (!blob) continue;

        const uploadsDir = await getOrCreateDir(settings.memoDirHandle, 'uploads');
        if (!uploadsDir) continue;

        const dateDir = await getOrCreateDir(uploadsDir, dateFolder);
        if (!dateDir) continue;

        const written = await writeFileToFS(dateDir, filename, blob);
        if (written) {
          storedPaths.push(`uploads/${dateFolder}/${filename}`);
        }
      }

      if (storedPaths.length > 0) {
        entry._storedPaths = storedPaths;
      }
    }

    if (entry.attachments && entry.attachments.length > 0) {
      for (const attachment of entry.attachments) {
        const attUrl = attachment && attachment.url;
        const match = attUrl && attUrl.match(/\/uploads\/([^\/]+)\/(.+)/);
        if (!match) continue;

        const dateFolder = match[1];
        const filename = match[2];
        const fullUrl = attUrl.startsWith('http://') || attUrl.startsWith('https://')
          ? attUrl
          : `${apiBase}${attUrl}`;

        const blob = await downloadBlob(fullUrl);
        if (!blob) continue;

        const uploadsDir = await getOrCreateDir(settings.memoDirHandle, 'uploads');
        if (!uploadsDir) continue;

        const dateDir = await getOrCreateDir(uploadsDir, dateFolder);
        if (!dateDir) continue;

        const written = await writeFileToFS(dateDir, filename, blob);
        if (written) {
          attachment.storedPath = `uploads/${dateFolder}/${filename}`;
        }
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
    const el = document.getElementById('syncStatus');
    if (!el) return;

    const iconEl = el.querySelector('#syncIcon');
    const textEl = el.querySelector('#syncText');
    if (!iconEl || !textEl) return;

    el.className = `sync-status ${status}`;

    const icons = {
      syncing: '🔄',
      success: '✅',
      error: '❌',
      idle: '☁️'
    };

    iconEl.textContent = icons[status] || icons.idle;
    textEl.textContent = message;

    if (status === 'success') {
      setTimeout(() => {
        if (el.classList.contains('success')) {
          iconEl.textContent = '☁️';
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
