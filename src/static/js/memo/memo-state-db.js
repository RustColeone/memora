/**
 * memo-state-db.js — in-browser SQLite store (offline-independent mode).
 *
 * Mirrors the Flask backend's SQLite schema (services/db.py) inside the browser
 * via sql.js (WASM).  The database lives in memory and its bytes are persisted
 * to OPFS (browser) or the Capacitor app-private DATA directory (native), with a
 * debounced write.  When neither is available the module reports ready()===false
 * and MemoCore falls back to its legacy localStorage path — exactly like ImageDB.
 *
 * This is the local engine behind the "store interface": MemoCore/UI never talk
 * to sql.js directly, only through loadEntries/saveEntries/loadSettings/etc.
 *
 * Entry <-> row mapping is identical to the backend (services/memo_store.py) so
 * the JSON export envelope is byte-compatible in both directions.
 */
(function (global) {
  'use strict';

  var SQLITE_FILE = 'memosystem.sqlite';
  var SQLITE_PRE_NATIVE_FILE = 'memosystem.pre-native.sqlite'; // kept after the move to native
  var SQLITE_TEMP_FILE = 'memosystem.sqlite.tmp';
  var SQLITE_BACKUP_FILE = 'memosystem.sqlite.bak';
  var SQLITE_SCHEMA_VERSION = 4;
  var CAP_DIR = 'MemoSystem';
  var PERSIST_DELAY = 1000;
  // Three 60-card feed windows can each expose multiple images. Keep enough
  // headroom for normal detail/editor work while ensuring a long browsing
  // session cannot pin every Blob it has ever touched.
  var BLOB_URL_CACHE_MAX_ENTRIES = 384;

  var SQL = null;        // sql.js module
  var sqlDb = null;      // sql.js Database instance (null => fallback to localStorage)
  var persistTimer = null;
  var persistGeneration = 0;
  var persistedGeneration = 0;
  var persistInFlight = null;
  var initPromise = null;
  var metadataHealth = {
    status: 'healthy',
    recoveredFrom: null,
    issues: [],
    quarantinedRows: [],
    lastPersistError: null
  };

  function errorText(error) {
    return String(error && error.message || error || 'Unknown metadata error');
  }
  function metadataSnapshot() {
    return {
      status: metadataHealth.status,
      pending: persistedGeneration < persistGeneration,
      recoveredFrom: metadataHealth.recoveredFrom,
      issues: metadataHealth.issues.slice(),
      quarantinedRows: metadataHealth.quarantinedRows.slice(),
      lastPersistError: metadataHealth.lastPersistError
    };
  }
  function dispatchMetadataHealth() {
    try {
      global.dispatchEvent(new CustomEvent('memo:metadata-health', { detail: metadataSnapshot() }));
    } catch (_e) {}
  }
  function reportMetadataIssue(code, error, severity, field) {
    var issue = {
      code: code,
      message: errorText(error),
      severity: severity || 'warning',
      field: field || null,
      timestamp: new Date().toISOString()
    };
    metadataHealth.issues.push(issue);
    if (issue.severity === 'error') metadataHealth.status = 'error';
    else if (metadataHealth.status === 'healthy') metadataHealth.status = 'degraded';
    dispatchMetadataHealth();
    return issue;
  }

  // ── small helpers ────────────────────────────────────────────
  function j(obj) { return obj === null || obj === undefined ? null : JSON.stringify(obj); }
  function p(text) { try { return text === null || text === undefined ? null : JSON.parse(text); } catch (_e) { return null; } }
  function parseRowJson(row, field, fallback, validator) {
    var raw = row && row[field];
    if (raw === null || raw === undefined || raw === '') return fallback;
    try {
      var parsed = JSON.parse(raw);
      if (validator && !validator(parsed)) throw new TypeError('Stored value has the wrong JSON shape.');
      return parsed;
    } catch (error) {
      var rowId = String(row && (row.id || row.variant) || 'unknown');
      var exists = metadataHealth.quarantinedRows.some(function (item) {
        return item.rowId === rowId && item.field === field && item.raw === String(raw);
      });
      if (!exists) {
        metadataHealth.quarantinedRows.push({
          rowId: rowId,
          field: field,
          raw: String(raw),
          message: errorText(error)
        });
        reportMetadataIssue('row-json-invalid', error, 'warning', field);
      }
      return fallback;
    }
  }
  function parseRowArray(row, field, fallback, allowNull) {
    return parseRowJson(row, field, fallback, function (value) {
      return (allowNull && value === null) || Array.isArray(value);
    });
  }
  function nowMs() { return Date.now(); }
  function isoToMs(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    return isNaN(t) ? null : t;
  }
  function msToIso(ms) {
    if (ms === null || ms === undefined) return null;
    try { return new Date(ms).toISOString(); } catch (_e) { return null; }
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  // Tax may be a flat amount ("8", 8) OR a percentage rate ("8%"). num() would
  // coerce "8%" → 8 (a flat $8), silently breaking percentage tax on reload, so
  // store it raw: sql.js keeps a non-numeric string as TEXT even in the REAL
  // column, and a numeric string/number as REAL. Empty/missing → null.
  function taxVal(v) { return (v === '' || v == null) ? null : v; }
  // A purchase's optional details, kept together in finance_entries.details.
  var DETAIL_KEYS = ['store', 'paidWith', 'notes'];
  function financeDetails(e) {
    var out = {}, any = false;
    DETAIL_KEYS.forEach(function (k) { var v = e[k] == null ? '' : String(e[k]).trim(); if (v) { out[k] = v; any = true; } });
    return any ? JSON.stringify(out) : null;
  }

  var isCapacitorNative = function () {
    return !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform());
  };
  function getCapFilesystem() {
    return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Filesystem) ||
           (global.Capacitor && global.Capacitor.Filesystem) || null;
  }

  // ── locate the wasm next to the loaded sql-wasm.js script ─────
  function locateWasm(file) {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || '';
      var idx = src.indexOf('sql-wasm.js');
      if (idx >= 0) return src.slice(0, idx) + file;
    }
    var base = global.STATIC_BASE || '/static/';
    return base + 'vendor/' + file;
  }

  // ── base64 <-> bytes (for Capacitor) ─────────────────────────
  function bytesToBase64(u8) {
    var binary = '', chunk = 0x8000;
    for (var i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + chunk, u8.length)));
    }
    return btoa(binary);
  }
  function base64ToBytes(b64) {
    var binary = atob(b64);
    var u8 = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
    return u8;
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  function mimeForPath(p) {
    var ext = (p.split('.').pop() || '').toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'pdf') return 'application/pdf';
    return 'application/octet-stream';
  }

  // Object URLs pin their backing Blob until explicitly revoked. Memo entries
  // can own several stored paths, so cache one URL per path and restore every
  // owning entry to its stable /uploads/... reference when that URL is released.
  // Mounted images and the reader are protected; trimmed URLs are retried after
  // those surfaces leave the document.
  class BlobUrlCache extends Map {
    constructor(options) {
      super();
      options = options || {};
      this.maxEntries = Number.isFinite(options.maxEntries)
        ? Math.max(1, options.maxEntries)
        : BLOB_URL_CACHE_MAX_ENTRIES;
      this.retryDelay = Number.isFinite(options.retryDelay) ? Math.max(0, options.retryDelay) : 2000;
      this.onRevoke = typeof options.onRevoke === 'function' ? options.onRevoke : function () {};
      this.pendingRevocations = new Map(); // url -> { key, reusable }
      this.revokeTimer = 0;
      this.disposed = false;
    }

    get(key) {
      var value = super.get(key);
      if (value !== undefined) {
        super.delete(key);
        super.set(key, value);
      }
      return value;
    }

    set(key, url) {
      if (this.disposed) {
        if (typeof url === 'string' && url.indexOf('blob:') === 0) this._queue(url, key, false, false);
        this._flushRevocations(true);
        return this;
      }
      var previous = super.get(key);
      if (previous && previous !== url) this._queue(previous, key, false, false);
      super.delete(key);
      super.set(key, url);
      this._trim();
      return this;
    }

    takePending(key) {
      for (const pair of this.pendingRevocations.entries()) {
        var url = pair[0], record = pair[1];
        if (record.key !== key || !record.reusable) continue;
        this.pendingRevocations.delete(url);
        if (!this.pendingRevocations.size && this.revokeTimer) {
          clearTimeout(this.revokeTimer);
          this.revokeTimer = 0;
        }
        this.set(key, url);
        return url;
      }
      return null;
    }

    delete(key) {
      var previous = super.get(key);
      var deleted = super.delete(key);
      if (deleted) this._queue(previous, key, false, true);
      // A replaced/deleted blob must never resurrect an older pending URL.
      for (const pair of this.pendingRevocations.entries()) {
        if (pair[1].key === key) pair[1].reusable = false;
      }
      return deleted;
    }

    clear() {
      for (const pair of super.entries()) this._queue(pair[1], pair[0], false, false);
      super.clear();
      if (this.pendingRevocations.size) this._scheduleRevocations();
    }

    dispose() {
      if (this.revokeTimer) clearTimeout(this.revokeTimer);
      this.revokeTimer = 0;
      for (const pair of super.entries()) this._queue(pair[1], pair[0], false, false);
      super.clear();
      this.disposed = true;
      this._flushRevocations(true);
    }

    flush(force) {
      if (this.revokeTimer) clearTimeout(this.revokeTimer);
      this.revokeTimer = 0;
      this._flushRevocations(!!force);
    }

    stats() {
      return {
        size: super.size,
        keys: Array.from(super.keys()),
        pending: this.pendingRevocations.size,
        disposed: this.disposed,
        maxEntries: this.maxEntries,
        retryScheduled: !!this.revokeTimer
      };
    }

    _queue(url, key, reusable, schedule) {
      if (typeof url !== 'string' || url.indexOf('blob:') !== 0) return;
      var existing = this.pendingRevocations.get(url);
      if (existing) {
        existing.reusable = existing.reusable && reusable;
      } else {
        this.pendingRevocations.set(url, { key: key, reusable: !!reusable });
      }
      if (schedule !== false) this._scheduleRevocations();
    }

    _trim() {
      while (super.size > this.maxEntries) {
        var oldestKey = super.keys().next().value;
        var oldestUrl = super.get(oldestKey);
        super.delete(oldestKey);
        this._queue(oldestUrl, oldestKey, true, false);
      }
      if (this.pendingRevocations.size) this._scheduleRevocations();
    }

    _scheduleRevocations(delay) {
      if (this.revokeTimer || this.disposed) return;
      var self = this;
      this.revokeTimer = setTimeout(function () {
        self.revokeTimer = 0;
        self._flushRevocations(false);
      }, delay === undefined ? 0 : delay);
    }

    _activeUrls() {
      var active = new Set();
      if (typeof document === 'undefined') return active;
      var nodes = document.querySelectorAll('img[src^="blob:"],img[data-src^="blob:"],source[src^="blob:"]');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        // Loaded feed thumbnails keep their decoded pixels after revocation and
        // can resolve their stable path again when remounted. Protect only work
        // still loading and action surfaces which may fetch the URL again.
        var actionSurface = node.closest && node.closest('#detailDlg[open],#entryDlg[open],#panelDlg[open],#gifEditorDlg[open]');
        var queuedSource = node.getAttribute && node.getAttribute('data-src');
        var assignedSource = node.getAttribute && node.getAttribute('src');
        var waitingForLazyLoad = queuedSource && queuedSource.indexOf('blob:') === 0 && !assignedSource;
        if (node.complete && !actionSurface && !waitingForLazyLoad) continue;
        var values = [node.getAttribute('src'), node.getAttribute('data-src'), node.currentSrc];
        for (var j = 0; j < values.length; j++) {
          if (values[j] && String(values[j]).indexOf('blob:') === 0) active.add(String(values[j]));
        }
      }
      return active;
    }

    _flushRevocations(force) {
      var protectAll = !force && typeof document !== 'undefined' && !!document.querySelector('#urDlg[open]');
      var active = force ? new Set() : this._activeUrls();
      for (const pair of Array.from(this.pendingRevocations.entries())) {
        var url = pair[0], record = pair[1];
        if (protectAll || active.has(url)) continue;
        try { URL.revokeObjectURL(url); } catch (_e) {}
        this.pendingRevocations.delete(url);
        try { this.onRevoke(record.key, url); } catch (_ownerError) {}
      }
      if (!force && this.pendingRevocations.size) this._scheduleRevocations(this.retryDelay);
    }
  }

  var blobUrlOwners = new Map(); // rel -> Map(url -> Set(entry))
  var blobUrlLoads = new Map();
  var blobUrlGenerations = new Map();

  function normalizeBlobRel(relPath) {
    var value = String(relPath || '');
    if (!value || value.indexOf('blob:') === 0 || value.indexOf('data:') === 0) return '';
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) value = new URL(value, global.location && global.location.href).pathname;
    } catch (_e) {}
    value = value.split('?')[0].split('#')[0];
    return urlToRel(value);
  }

  function restoreBlobUrlOwners(relPath, url) {
    var byUrl = blobUrlOwners.get(relPath);
    var owners = byUrl && byUrl.get(url);
    if (owners) {
      owners.forEach(function (entry) {
        if (!entry || !Array.isArray(entry.images)) return;
        entry.images = entry.images.map(function (image) {
          return image === url ? relToUrl(relPath) : image;
        });
      });
      byUrl.delete(url);
      if (!byUrl.size) blobUrlOwners.delete(relPath);
    }
  }

  function registerBlobUrlOwner(relPath, url, entry) {
    if (!entry || !url) return;
    var byUrl = blobUrlOwners.get(relPath);
    if (!byUrl) { byUrl = new Map(); blobUrlOwners.set(relPath, byUrl); }
    var owners = byUrl.get(url);
    if (!owners) { owners = new Set(); byUrl.set(url, owners); }
    owners.add(entry);
  }

  var blobUrlCache = new BlobUrlCache({ onRevoke: restoreBlobUrlOwners });

  // Reverse of the blob-URL cache: given a display URL like
  // "blob:https://localhost/<uuid>", find the stored rel it was created from.
  // Needed because images are often already hydrated to a blob: URL by the time
  // a thumbnail consumer sees them, and a blob: URL carries no path information
  // of its own — without this, such images can't be matched to their cached
  // thumbnail and fall back to decoding the full-size original.
  function relForBlobUrl(url) {
    if (!url || String(url).indexOf('blob:') !== 0) return null;
    var found = null;
    blobUrlOwners.forEach(function (byUrl, rel) {
      if (found || !byUrl) return;
      if (byUrl.has(url)) found = rel;
    });
    return found;
  }

  function invalidateBlobUrl(relPath) {
    var key = normalizeBlobRel(relPath);
    if (!key) return;
    blobUrlGenerations.set(key, (blobUrlGenerations.get(key) || 0) + 1);
    blobUrlCache.delete(key);
    blobUrlLoads.delete(key);
  }

  // Thumbnails are derived from a stored image (see memo-thumbs.js). When the
  // source is rewritten or deleted its cached thumb is stale, so drop it —
  // otherwise an edited image would keep showing its previous thumbnail.
  // Guarded: the thumbs module is optional and never loaded in some contexts.
  function dropDerivedThumb(relPath) {
    var key = normalizeBlobRel(relPath);
    if (!key || key.indexOf('thumbs/') === 0) return;   // don't recurse on thumbs
    var thumbs = (typeof window !== 'undefined') && window.MemoThumbs;
    if (thumbs && typeof thumbs.drop === 'function') {
      try { thumbs.drop(key); } catch (_e) { /* best effort */ }
    }
  }

  async function cachedBlobUrl(relPath) {
    var key = normalizeBlobRel(relPath);
    if (!key) return null;
    var cached = blobUrlCache.get(key) || blobUrlCache.takePending(key);
    if (cached) return cached;
    if (blobUrlLoads.has(key)) return blobUrlLoads.get(key);
    var generation = blobUrlGenerations.get(key) || 0;
    var load = (async function () {
      var blob = await blobRead(key);
      if (!blob) return null;
      var url = URL.createObjectURL(blob);
      if ((blobUrlGenerations.get(key) || 0) !== generation) {
        try { URL.revokeObjectURL(url); } catch (_e) {}
        return cachedBlobUrl(key);
      }
      blobUrlCache.set(key, url);
      return url;
    })();
    blobUrlLoads.set(key, load);
    try { return await load; }
    finally { if (blobUrlLoads.get(key) === load) blobUrlLoads.delete(key); }
  }

  // ── IndexedDB blob fallback (browsers without OPFS) ──────────
  var IDB_NAME = 'memosystem_blobs', IDB_STORE = 'blobs', _idb = null;
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (_idb) return resolve(_idb);
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { _idb = req.result; resolve(_idb); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbBlob(method, key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, method === 'get' ? 'readonly' : 'readwrite');
        var store = tx.objectStore(IDB_STORE);
        var req = method === 'get' ? store.get(key) : (method === 'put' ? store.put(val, key) : store.delete(key));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function idbAllKeys() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ── app-private blob storage (uploads/<date>/<name>) ──────────
  // Capacitor app-private DATA (native) > OPFS (browser) > IndexedDB.
  // Mirrors the server's /uploads layout so export ZIP + sync stay symmetric.
  async function blobWrite(relPath, blob) {
    if (isCapacitorNative()) {
      var Filesystem = getCapFilesystem();
      if (Filesystem) {
        await Filesystem.writeFile({ path: CAP_DIR + '/' + relPath, data: await blobToBase64(blob), directory: 'DATA', recursive: true });
        return;
      }
    }
    if (hasOPFS()) {
      var root = await navigator.storage.getDirectory();
      var parts = relPath.split('/'); var dir = root;
      for (var i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });
      var fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      var wr = await fh.createWritable(); await wr.write(blob); await wr.close();
      return;
    }
    await idbBlob('put', relPath, blob);
  }
  async function blobRead(relPath) {
    if (isCapacitorNative()) {
      var Filesystem = getCapFilesystem();
      if (Filesystem) {
        try {
          var res = await Filesystem.readFile({ path: CAP_DIR + '/' + relPath, directory: 'DATA' });
          if (typeof res.data === 'string') return new Blob([base64ToBytes(res.data)], { type: mimeForPath(relPath) });
          return res.data;
        } catch (_e) { return null; }
      }
    }
    if (hasOPFS()) {
      try {
        var root = await navigator.storage.getDirectory();
        var parts = relPath.split('/'); var dir = root;
        for (var i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
        var fh = await dir.getFileHandle(parts[parts.length - 1]);
        return await fh.getFile();
      } catch (_e) { return null; }
    }
    try { return (await idbBlob('get', relPath)) || null; } catch (_e) { return null; }
  }
  async function blobDelete(relPath) {
    if (isCapacitorNative()) {
      var Filesystem = getCapFilesystem();
      if (Filesystem) { try { await Filesystem.deleteFile({ path: CAP_DIR + '/' + relPath, directory: 'DATA' }); } catch (_e) {} return; }
    }
    if (hasOPFS()) {
      try {
        var root = await navigator.storage.getDirectory();
        var parts = relPath.split('/'); var dir = root;
        for (var i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
        await dir.removeEntry(parts[parts.length - 1]);
      } catch (_e) {}
      return;
    }
    try { await idbBlob('del', relPath); } catch (_e) {}
  }

  // ── blob enumeration (for Verify & Repair) ───────────────────
  // List every stored blob's rel path (uploads/<date>/<name>) across whichever
  // backend is active. Used to diff stored files against entry references.
  async function opfsWalk(dirHandle, prefix, out) {
    // dirHandle.entries() is an async iterator of [name, handle].
    for await (var pair of dirHandle.entries()) {
      var name = pair[0], handle = pair[1];
      var rel = prefix ? prefix + '/' + name : name;
      if (handle.kind === 'directory') await opfsWalk(handle, rel, out);
      else out.push(rel);
    }
  }
  async function capWalk(Filesystem, relDir, out) {
    var res;
    try { res = await Filesystem.readdir({ path: CAP_DIR + '/' + relDir, directory: 'DATA' }); }
    catch (_e) { return; } // dir missing → nothing to enumerate
    var files = (res && res.files) || [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var name = (typeof f === 'string') ? f : f.name;
      var type = (typeof f === 'string') ? null : f.type; // 'file' | 'directory' (modern)
      var childRel = relDir + '/' + name;
      if (type === 'directory') { await capWalk(Filesystem, childRel, out); }
      else if (type === 'file') { out.push(childRel); }
      else {
        // Older Capacitor: no type. Try to recurse; if it wasn't a dir, it's a file.
        var before = out.length;
        await capWalk(Filesystem, childRel, out);
        if (out.length === before) out.push(childRel);
      }
    }
  }
  async function enumerateBlobs() {
    var out = [];
    if (isCapacitorNative()) {
      var Filesystem = getCapFilesystem();
      if (Filesystem) { await capWalk(Filesystem, 'uploads', out); return out; }
    }
    if (hasOPFS()) {
      try {
        var root = await navigator.storage.getDirectory();
        var up = await root.getDirectoryHandle('uploads'); // throws if no uploads yet
        await opfsWalk(up, 'uploads', out);
      } catch (_e) { /* no uploads dir → empty */ }
      return out;
    }
    try {
      var keys = await idbAllKeys();
      for (var k = 0; k < keys.length; k++) {
        var key = String(keys[k]);
        if (key.indexOf('uploads') === 0) out.push(key);
      }
    } catch (_e) {}
    return out;
  }

  // image url <-> stored rel path:  "/uploads/d/f.jpg" <-> "uploads/d/f.jpg"
  function urlToRel(u) { return String(u || '').replace(/^\//, ''); }
  function relToUrl(rel) { return '/' + String(rel || '').replace(/^\//, ''); }

  function attachmentPathSet(attachments) {
    var paths = new Set();
    (Array.isArray(attachments) ? attachments : []).forEach(function (attachment) {
      if (!attachment) return;
      var owned = attachment.storedPath || attachment.url;
      var rel = urlToRel(owned);
      if (rel) paths.add(rel);
    });
    return paths;
  }

  function imagePathsWithoutAttachments(paths, attachments) {
    var attachmentPaths = attachmentPathSet(attachments);
    return (Array.isArray(paths) ? paths : []).filter(function (path) {
      return path && !attachmentPaths.has(urlToRel(path));
    });
  }

  // ── persistence of the .sqlite bytes ─────────────────────────
  // Capacitor app-private DATA (native) > OPFS (browser) > localStorage.
  // Every backend uses the same staged + last-known-good protocol.
  var LS_DB_KEY = 'memosystem_sqlite_b64';
  function hasOPFS() { return !!(navigator.storage && typeof navigator.storage.getDirectory === 'function'); }
  function localStorageKeyFor(name) {
    if (name === SQLITE_FILE) return LS_DB_KEY;
    if (name === SQLITE_TEMP_FILE) return LS_DB_KEY + '_tmp';
    if (name === SQLITE_BACKUP_FILE) return LS_DB_KEY + '_bak';
    return LS_DB_KEY + '_' + name;
  }
  function isMissingFileError(error) {
    var name = error && error.name || '';
    var code = error && error.code || '';
    var message = errorText(error);
    return name === 'NotFoundError' || code === 'OS-PLUG-FILE-0008' ||
      /(?:does not exist|not found|no such file)/i.test(message);
  }
  function sqliteBytesView(bytes) {
    if (bytes instanceof Uint8Array) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    throw new TypeError('SQLite snapshot is not binary data.');
  }
  function assertSqliteIntegrity(database, label) {
    var result = database.exec('PRAGMA quick_check');
    var rows = result.length ? (result[0].values || []) : [];
    if (rows.length !== 1 || rows[0][0] !== 'ok') {
      var detail = rows.map(function (row) { return row.join(': '); }).join('; ') || 'quick_check returned no result';
      throw new Error((label || 'SQLite database') + ' failed integrity validation: ' + detail);
    }
  }
  function validateSqliteBytes(bytes, label) {
    if (!SQL) throw new Error('sql.js is not initialized');
    var view = sqliteBytesView(bytes);
    if (!view.byteLength) throw new Error((label || 'SQLite snapshot') + ' is empty.');
    var probe = null;
    try {
      probe = new SQL.Database(new Uint8Array(view));
      assertSqliteIntegrity(probe, label || 'SQLite snapshot');
    } finally {
      try { if (probe) probe.close(); } catch (_e) {}
    }
    return true;
  }

  async function readDbFile(name, allowMissing) {
    if (allowMissing === undefined) allowMissing = true;
    if (isCapacitorNative()) {
      var Filesystem = getCapFilesystem();
      if (!Filesystem) throw new Error('Capacitor Filesystem plugin not available');
      try {
        var res = await Filesystem.readFile({ path: CAP_DIR + '/' + name, directory: 'DATA' });
        return typeof res.data === 'string' ? base64ToBytes(res.data) : new Uint8Array(await res.data.arrayBuffer());
      } catch (error) {
        if (allowMissing && isMissingFileError(error)) return null;
        throw error;
      }
    }
    if (hasOPFS()) {
      try {
        var root = await navigator.storage.getDirectory();
        var fh = await root.getFileHandle(name);
        return new Uint8Array(await (await fh.getFile()).arrayBuffer());
      } catch (error2) {
        if (allowMissing && isMissingFileError(error2)) return null;
        throw error2;
      }
    }
    try {
      var b64 = localStorage.getItem(localStorageKeyFor(name));
      return b64 ? base64ToBytes(b64) : null;
    } catch (error3) {
      if (allowMissing && isMissingFileError(error3)) return null;
      throw error3;
    }
  }
  async function writeDbFile(name, bytes) {
    var view = sqliteBytesView(bytes);
    if (isCapacitorNative()) {
      var Filesystem = getCapFilesystem();
      if (!Filesystem) throw new Error('Capacitor Filesystem plugin not available');
      try { await Filesystem.mkdir({ path: CAP_DIR, directory: 'DATA', recursive: true }); } catch (_e) {}
      await Filesystem.writeFile({ path: CAP_DIR + '/' + name, data: bytesToBase64(view), directory: 'DATA' });
      return;
    }
    if (hasOPFS()) {
      var root = await navigator.storage.getDirectory();
      var fh = await root.getFileHandle(name, { create: true });
      var wr = await fh.createWritable();
      await wr.write(view);
      await wr.close();
      return;
    }
    localStorage.setItem(localStorageKeyFor(name), bytesToBase64(view));
  }
  async function deleteDbFile(name) {
    if (isCapacitorNative()) {
      var Filesystem = getCapFilesystem();
      if (!Filesystem) throw new Error('Capacitor Filesystem plugin not available');
      try {
        await Filesystem.deleteFile({ path: CAP_DIR + '/' + name, directory: 'DATA' });
        return true;
      } catch (error) {
        if (isMissingFileError(error)) return false;
        throw error;
      }
    }
    if (hasOPFS()) {
      try {
        var root = await navigator.storage.getDirectory();
        await root.removeEntry(name);
        return true;
      } catch (error2) {
        if (isMissingFileError(error2)) return false;
        throw error2;
      }
    }
    var key = localStorageKeyFor(name);
    var existed = localStorage.getItem(key) !== null;
    localStorage.removeItem(key);
    return existed;
  }
  async function promoteTempSnapshot(bytes) {
    if (isCapacitorNative()) {
      var Filesystem = getCapFilesystem();
      await deleteDbFile(SQLITE_FILE);
      if (Filesystem && typeof Filesystem.rename === 'function') {
        try {
          await Filesystem.rename({
            from: CAP_DIR + '/' + SQLITE_TEMP_FILE,
            to: CAP_DIR + '/' + SQLITE_FILE,
            directory: 'DATA',
            toDirectory: 'DATA'
          });
          return;
        } catch (_renameError) {}
      }
    }
    await writeDbFile(SQLITE_FILE, bytes);
    await deleteDbFile(SQLITE_TEMP_FILE);
  }
  async function persistSqliteSnapshot(bytes, options) {
    options = options || {};
    var rotateBackup = options.rotateBackup !== false;
    var seedBackup = options.seedBackup !== false;
    var view = sqliteBytesView(bytes);
    if (!view.byteLength) throw new Error('In-memory SQLite snapshot is empty.');

    await writeDbFile(SQLITE_TEMP_FILE, view);
    var staged = await readDbFile(SQLITE_TEMP_FILE, false);
    validateSqliteBytes(staged, 'Staged SQLite snapshot');

    var backupReady = false;
    if (rotateBackup) {
      var current = await readDbFile(SQLITE_FILE, true);
      if (current) {
        try {
          validateSqliteBytes(current, 'Current SQLite snapshot');
          await writeDbFile(SQLITE_BACKUP_FILE, current);
          backupReady = true;
        } catch (currentError) {
          reportMetadataIssue('primary-corrupt-during-persist', currentError, 'warning', SQLITE_FILE);
        }
      }
    }
    if (seedBackup && !backupReady) {
      var existingBackup = await readDbFile(SQLITE_BACKUP_FILE, true);
      if (existingBackup) {
        try {
          validateSqliteBytes(existingBackup, 'Existing last-known-good SQLite snapshot');
          backupReady = true;
        } catch (backupError) {
          reportMetadataIssue('backup-invalid-during-persist', backupError, 'warning', SQLITE_BACKUP_FILE);
        }
      }
    }

    await promoteTempSnapshot(staged);
    var durable = await readDbFile(SQLITE_FILE, false);
    validateSqliteBytes(durable, 'Persisted SQLite snapshot');
    if (seedBackup && !backupReady) await writeDbFile(SQLITE_BACKUP_FILE, durable);
  }

  // Android: send what the working copy recorded to native SQLite as one
  // atomic batch. A failed batch goes back to the front of the journal, in
  // order, and is retried on the next flush.
  async function flushNative() {
    var store = global.MemoNativeStore, conn = store && store.main();
    if (!conn) throw new Error('The phone database is not open.');
    var batch = [], full = fullCopyPending;
    if (full) journal = [];
    else batch = journal.splice(0);
    try {
      if (full) {
        await ensureNativeColumns(conn);
        await conn.applyChunks(fullCopyChunks());
        fullCopyPending = false;
      } else await conn.apply(batch);
    } catch (error) {
      if (!full) journal = batch.concat(journal);
      throw error;
    }
  }
  function flushNow() {
    if (!sqlDb) return Promise.resolve();
    // A locked phone database accepts nothing until it is unlocked.
    if (engine === 'locked' || engine === 'unavailable') return Promise.resolve();
    clearTimeout(persistTimer); persistTimer = null;
    if (persistInFlight) return persistInFlight;
    if (persistedGeneration >= persistGeneration) return Promise.resolve();

    persistInFlight = (async function () {
      while (persistedGeneration < persistGeneration) {
        var generation = persistGeneration;
        try {
          if (engine === 'native') {
            await flushNative();
          } else {
            assertSqliteIntegrity(sqlDb, 'In-memory SQLite database');
            await persistSqliteSnapshot(sqlDb.export());
          }
          persistedGeneration = generation;
          metadataHealth.lastPersistError = null;
          if (metadataHealth.status === 'error') {
            var otherFatal = metadataHealth.issues.some(function (issue) {
              return issue.severity === 'error' && issue.code !== 'persist-failed';
            });
            if (!otherFatal) metadataHealth.status = metadataHealth.recoveredFrom ? 'recovered' : 'healthy';
          }
          dispatchMetadataHealth();
        } catch (error) {
          metadataHealth.lastPersistError = errorText(error);
          reportMetadataIssue('persist-failed', error, 'error', SQLITE_FILE);
          console.error('[StateDb] persist failed:', error);
          throw error;
        }
      }
    })().finally(function () { persistInFlight = null; });
    return persistInFlight;
  }
  function schedulePersist(delay) {
    if (!sqlDb) return;
    var wasSaved = persistedGeneration >= persistGeneration;
    persistGeneration++;
    if (wasSaved) dispatchMetadataHealth();
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      flushNow().catch(function () { /* metadata health already records the failure */ });
    }, delay === undefined ? (engine === 'native' ? NATIVE_FLUSH_DELAY : PERSIST_DELAY) : delay);
  }

  // ── schema — mirror of services/db.py ────────────────────────
  var SCHEMA = [
    "CREATE TABLE IF NOT EXISTS memos (id TEXT PRIMARY KEY, description TEXT, category TEXT, tags TEXT, images TEXT, attachments TEXT, image_meta TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0, deleted_at INTEGER, safe INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS finance_entries (id TEXT PRIMARY KEY, description TEXT, category TEXT, tags TEXT, images TEXT, attachments TEXT, image_meta TEXT, purchase_date TEXT, sheet TEXT DEFAULT 'General', price REAL DEFAULT 0, tax REAL DEFAULT 0, adjustment REAL DEFAULT 0, total REAL DEFAULT 0, items TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0, deleted_at INTEGER, details TEXT)",
    "CREATE TABLE IF NOT EXISTS operations (variant TEXT NOT NULL DEFAULT 'default', op_id INTEGER NOT NULL, type TEXT, entry_id TEXT, timestamp INTEGER, device_id TEXT, client_op_id TEXT, payload TEXT, PRIMARY KEY (variant, op_id))",
    "CREATE TABLE IF NOT EXISTS snapshots (variant TEXT PRIMARY KEY, snapshot_id INTEGER NOT NULL DEFAULT 0, timestamp INTEGER NOT NULL DEFAULT 0, entries TEXT NOT NULL DEFAULT '[]')",
    "CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, variant TEXT DEFAULT 'default', role TEXT, content TEXT, created_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS hashbook (sha256 TEXT PRIMARY KEY, stored_path TEXT, ref_count INTEGER DEFAULT 1, created_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)",
    // Generic per-entry document store for "document variants" (planner today,
    // and any future page whose entries are heterogeneous documents rather than
    // a fixed column set). Keyed by (variant, id); the whole document lives in
    // `doc` as JSON, with timestamps/deletion mirrored into columns for merge
    // + ordering. Memos/finance keep their own columnar tables.
    "CREATE TABLE IF NOT EXISTS doc_entries (variant TEXT NOT NULL, id TEXT NOT NULL, doc TEXT, created_at INTEGER, updated_at INTEGER, deleted INTEGER DEFAULT 0, deleted_at INTEGER, PRIMARY KEY (variant, id))",
    // On-device image analysis (labels, faces, codes) keyed by stored path.
    // Derived data: rebuilt on the device, never synced or put in a backup.
    "CREATE TABLE IF NOT EXISTS image_insights (path TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ready', labels TEXT NOT NULL DEFAULT '[]', faces INTEGER NOT NULL DEFAULT 0, face_area REAL NOT NULL DEFAULT 0, codes INTEGER NOT NULL DEFAULT 0, camera INTEGER NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, analyzer_version INTEGER NOT NULL DEFAULT 1, analyzed_at INTEGER NOT NULL DEFAULT 0, error_code TEXT NOT NULL DEFAULT '')",
    // Duplicate review: a 64-bit brightness fingerprint (dHash) per stored
    // image, plus the pairs the person chose to keep. Derived/local only.
    "CREATE TABLE IF NOT EXISTS image_dhash (path TEXT PRIMARY KEY, dhash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, computed_at INTEGER NOT NULL DEFAULT 0)"
  ];

  function sqliteUserVersion(database) {
    var result = database.exec('PRAGMA user_version');
    return Number(result.length && result[0].values.length ? result[0].values[0][0] : 0);
  }
  function sqliteColumns(database, table) {
    var result = database.exec('PRAGMA table_info(' + table + ')');
    return new Set((result.length ? result[0].values : []).map(function (row) { return row[1]; }));
  }
  function migrateSqliteSchema(database) {
    var originalVersion = sqliteUserVersion(database);
    if (originalVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error('This database uses metadata schema ' + originalVersion +
        ', but this app supports up to ' + SQLITE_SCHEMA_VERSION + '.');
    }
    var changed = originalVersion !== SQLITE_SCHEMA_VERSION;
    database.run('BEGIN IMMEDIATE');
    try {
      for (var i = 0; i < SCHEMA.length; i++) database.run(SCHEMA[i]);

      // Version 1 introduced the shared memo/finance tables. Some pre-versioned
      // databases already have those tables, so column presence is authoritative.
      var financeColumns = sqliteColumns(database, 'finance_entries');
      if (!financeColumns.has('sheet')) {
        database.run("ALTER TABLE finance_entries ADD COLUMN sheet TEXT DEFAULT 'General'");
        changed = true;
      }

      // Version 3 stores metadata that belongs to a particular image within a
      // multi-image entry.  EXIF's original-segment backup lives here, keyed by
      // the stable stored path, so reordering images cannot attach it to the
      // wrong file and normal backup/sync flows retain it.
      var memoColumns = sqliteColumns(database, 'memos');
      if (!memoColumns.has('image_meta')) {
        database.run('ALTER TABLE memos ADD COLUMN image_meta TEXT');
        changed = true;
      }
      financeColumns = sqliteColumns(database, 'finance_entries');
      if (!financeColumns.has('image_meta')) {
        database.run('ALTER TABLE finance_entries ADD COLUMN image_meta TEXT');
        changed = true;
      }

      // A purchase's store, how it was paid and notes, as one JSON column, so
      // later fields need no new column. Older app versions simply ignore it.
      financeColumns = sqliteColumns(database, 'finance_entries');
      if (!financeColumns.has('details')) {
        database.run('ALTER TABLE finance_entries ADD COLUMN details TEXT');
        changed = true;
      }

      // Version 4 keeps a note's Safe flag (privacy level 2). Before it, the
      // flag lived only in memory and a restart made Safe notes ordinary.
      memoColumns = sqliteColumns(database, 'memos');
      if (!memoColumns.has('safe')) {
        database.run('ALTER TABLE memos ADD COLUMN safe INTEGER DEFAULT 0');
        changed = true;
      }

      // Version 2 adds the generic document store used by Planner and future
      // document variants. CREATE IF NOT EXISTS above handles legacy v0/v1 files.
      database.run('PRAGMA user_version = ' + SQLITE_SCHEMA_VERSION);
      assertSqliteIntegrity(database, 'Migrated SQLite database');
      database.run('COMMIT');
    } catch (error) {
      try { database.run('ROLLBACK'); } catch (_e) {}
      throw error;
    }
    return changed;
  }

  function tableFor(variant) { return variant === 'finance' ? 'finance_entries' : 'memos'; }

  // ── writes ───────────────────────────────────────────────────
  // Every change to the working copy goes through write()/tx(). When the
  // durable store is Android's native database, the same statements are
  // recorded in `journal` and sent to it as one atomic batch (see flushNow),
  // so the phone stores single rows instead of rewriting a whole file. A
  // rolled-back transaction drops what it recorded.
  var journal = null;  // [{statement, values}] while the native store is active
  function write(sql, params) {
    sqlDb.run(sql, params || []);
    if (journal) journal.push({ statement: sql, values: params ? params.slice() : [] });
  }
  var txDepth = 0;
  function tx(fn) {
    // Nested calls join the outer transaction; a failure anywhere rolls the
    // whole thing back. Row prints may describe rolled-back writes, so they
    // are dropped and rebuilt from the table on the next save.
    if (txDepth) return fn();
    var mark = journal ? journal.length : 0;
    sqlDb.run('BEGIN');
    txDepth++;
    try {
      var result = fn();
      sqlDb.run('COMMIT');
      return result;
    } catch (err) {
      try { sqlDb.run('ROLLBACK'); } catch (_e) {}
      if (journal) journal.length = mark;
      dropRowPrints();
      throw err;
    } finally {
      txDepth--;
    }
  }

  // ── changed-row saves ────────────────────────────────────────
  // Callers hand over a whole list (saveEntries/saveDocs/saveSyncBatch), but
  // only rows whose stored form changed are written, plus deletes for rows
  // that left the list. A short fingerprint of each row as last written is
  // kept per table; bulk paths (imports, restores) drop it and it is rebuilt
  // from the table on the next save.
  var rowPrints = {};
  function fingerprint(text) {
    // cyrb53: a 53-bit hash, so an edit that leaves the print unchanged is
    // vanishingly unlikely (about 1 in 9e15 per changed row).
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0, ch; i < text.length; i++) {
      ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function dropRowPrints() { rowPrints = {}; }
  // Write `rows` ([{id, sql, values}]) for one table key so that the table
  // ends up holding exactly those ids; `deleteSql` removes one id.
  function saveChangedRows(key, rows, buildPrints, deleteSql, deleteParams) {
    var prints = rowPrints[key] || (rowPrints[key] = buildPrints());
    var seen = new Set(), changed = [], removed = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (seen.has(r.id)) {
        // A duplicate id: the last one wins, as INSERT OR REPLACE did before.
        changed = changed.filter(function (c) { return c.row.id !== r.id; });
      }
      seen.add(r.id);
      var print = fingerprint(JSON.stringify(r.values));
      if (prints.get(r.id) !== print) changed.push({ row: r, print: print });
    }
    prints.forEach(function (_print, id) { if (!seen.has(id)) removed.push(id); });
    if (!changed.length && !removed.length) return false;
    tx(function () {
      changed.forEach(function (c) { write(c.row.sql, c.row.values); });
      removed.forEach(function (id) { write(deleteSql, deleteParams(id)); });
    });
    changed.forEach(function (c) { prints.set(c.row.id, c.print); });
    removed.forEach(function (id) { prints.delete(id); });
    return true;
  }
  function entryPrints(variant) {
    return function () {
      var map = new Map();
      selectAll('SELECT * FROM ' + tableFor(variant)).forEach(function (row) {
        map.set(row.id, fingerprint(JSON.stringify(entryStatement(rowToEntry(row, variant), variant).values)));
      });
      return map;
    };
  }
  function docPrints(variant) {
    return function () {
      var map = new Map();
      selectAll('SELECT id, doc FROM doc_entries WHERE variant=?', [variant]).forEach(function (row) {
        var doc = p(row.doc);
        if (doc && doc.id) map.set(row.id, fingerprint(JSON.stringify(docStatement(variant, doc).values)));
      });
      return map;
    };
  }
  function saveEntryList(entries, variant) {
    var rows = [];
    (entries || []).forEach(function (e) {
      if (!e || !e.id) return;
      var st = entryStatement(e, variant);
      rows.push({ id: e.id, sql: st.sql, values: st.values });
    });
    return saveChangedRows(tableFor(variant), rows, entryPrints(variant),
      'DELETE FROM ' + tableFor(variant) + ' WHERE id=?', function (id) { return [id]; });
  }
  // ── Android: native SQLite as the durable store ──────────────
  // engine: 'web' (verified snapshot file, the browser and the fallback),
  // 'native' (rows go to MemoNativeStore), 'locked' (a restored phone whose
  // database key stayed on the old phone) or 'unavailable' (the phone
  // database could not be opened; nothing is written until it can be).
  var engine = 'web';
  var engineInfo = null;
  var fullCopyPending = false;
  var NATIVE_FLUSH_DELAY = 250;
  var NATIVE_FLAG = 'memo_native_engine';                 // set once data lives natively
  var MIRRORED = ['memos', 'finance_entries', 'operations', 'snapshots', 'chat_messages', 'hashbook', 'settings', 'doc_entries', 'image_insights', 'image_dhash'];
  var COPY_NAMES = ['memora-lkg-a', 'memora-lkg-b'];       // last-known-good copies
  var COPY_EVERY_MS = 6 * 3600 * 1000;
  var COPY_KEY = 'memo_lkg_last';

  function nativeStore() {
    var s = global.MemoNativeStore;
    return s && s.available() ? s : null;
  }
  function nativeFlag(value) {
    try {
      if (value === undefined) return localStorage.getItem(NATIVE_FLAG);
      localStorage.setItem(NATIVE_FLAG, value);
    } catch (_e) { return null; }
  }
  function tableColumns(database, table) {
    var result = database.exec('PRAGMA table_info(' + table + ')');
    return (result.length ? result[0].values : []).map(function (row) { return { name: row[1], type: row[2] || '' }; });
  }
  // The statements that make another database hold exactly the working
  // copy, produced a page of rows at a time: nextChunk() returns the next
  // array of statements, then `tail`, then null. Rows are written with
  // INSERT OR REPLACE, so a row edited between pages cannot fail the copy; a
  // copy that missed one fails verifyCopy instead and is redone later.
  var COPY_PAGE = 2000;
  function fullCopyChunks(tail) {
    var t = 0, offset = 0, started = false, done = false;
    return function nextChunk() {
      if (done) return null;
      while (t < MIRRORED.length) {
        var table = MIRRORED[t];
        var cols = tableColumns(sqlDb, table).map(function (c) { return c.name; });
        if (!started) { started = true; offset = 0; return [{ statement: 'DELETE FROM ' + table, values: [] }]; }
        var rows = cols.length ? selectAll('SELECT * FROM ' + table + ' ORDER BY rowid LIMIT ? OFFSET ?', [COPY_PAGE, offset]) : [];
        if (rows.length) {
          offset += rows.length;
          var sql = 'INSERT OR REPLACE INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map(function () { return '?'; }).join(',') + ')';
          return rows.map(function (row) { return { statement: sql, values: cols.map(function (c) { return row[c] === undefined ? null : row[c]; }) }; });
        }
        t++; started = false;
      }
      done = true;
      return tail && tail.length ? tail : null;
    };
  }

  // Columns added to the working copy by a schema migration are added to the
  // native tables too, before any row that uses them is written.
  async function ensureNativeColumns(conn) {
    for (var i = 0; i < MIRRORED.length; i++) {
      var table = MIRRORED[i];
      var have = new Set((await conn.query('PRAGMA table_info(' + table + ')')).map(function (r) { return r.name; }));
      var add = tableColumns(sqlDb, table).filter(function (c) { return !have.has(c.name); });
      if (add.length) {
        await conn.apply(add.map(function (c) { return { statement: 'ALTER TABLE ' + table + ' ADD COLUMN ' + c.name + ' ' + c.type, values: [] }; }));
      }
    }
  }
  async function verifyCopy(conn) {
    for (var i = 0; i < MIRRORED.length; i++) {
      var expected = countRows(MIRRORED[i]), actual = await conn.count(MIRRORED[i]);
      if (expected !== actual) throw new Error('Copy check failed for ' + MIRRORED[i] + ': ' + actual + ' of ' + expected + ' rows.');
    }
  }
  // Build a working copy from a native database (the main one, or a copy).
  async function workingCopyFrom(conn) {
    var database = new SQL.Database();
    for (var i = 0; i < SCHEMA.length; i++) database.run(SCHEMA[i]);
    database.run('PRAGMA user_version = ' + SQLITE_SCHEMA_VERSION);
    for (var t = 0; t < MIRRORED.length; t++) {
      var table = MIRRORED[t];
      var known = new Set(tableColumns(database, table).map(function (c) { return c.name; }));
      await conn.readTable(table, function (rows) {
        var cols = Object.keys(rows[0]).filter(function (c) { return known.has(c); });
        var stmt = database.prepare('INSERT OR REPLACE INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map(function () { return '?'; }).join(',') + ')');
        try {
          database.run('BEGIN');
          rows.forEach(function (row) { stmt.run(cols.map(function (c) { return row[c] === undefined ? null : row[c]; })); });
          database.run('COMMIT');
        } finally { stmt.free(); }
      });
    }
    assertSqliteIntegrity(database, 'Working copy built from ' + conn.name);
    return database;
  }
  // First launch on Android: carry the working copy (opened from today's
  // snapshot file) into native SQLite. One transaction holds every row plus
  // the marker, then the copy is counted before anything switches over. The
  // snapshot file is then kept aside as memosystem.pre-native.sqlite.
  async function moveIntoNative(store) {
    var conn = store.main();
    await ensureNativeColumns(conn);
    await conn.applyChunks(fullCopyChunks([{
      statement: 'INSERT OR REPLACE INTO native_meta (key,value) VALUES (?,?)', values: ['working_copy_ready', new Date().toISOString()]
    }]));
    await verifyCopy(conn);
    engine = 'native';
    journal = [];
    nativeFlag('active');
    var old = await readDbFile(SQLITE_FILE, true);
    if (old) {
      await writeDbFile(SQLITE_PRE_NATIVE_FILE, old);
      validateSqliteBytes(await readDbFile(SQLITE_PRE_NATIVE_FILE, false), 'Kept pre-native snapshot');
      await deleteDbFile(SQLITE_FILE);
    }
    try { await deleteDbFile(SQLITE_TEMP_FILE); } catch (_e) {}
    try { await deleteDbFile(SQLITE_BACKUP_FILE); } catch (_e) {}
  }
  // Main database damaged: build the working copy from the newest good copy,
  // move the main database name aside (nothing is deleted) and write the copy
  // into a new main database. Sync then catches up from the copy's cursor.
  async function recoverFromCopy(store) {
    var best = null;
    for (var i = 0; i < COPY_NAMES.length; i++) {
      if (!(await store.exists(COPY_NAMES[i]))) continue;
      try {
        var conn = await store.openCopy(COPY_NAMES[i], SCHEMA);
        var at = await conn.meta('copied_at');
        if (at && (!best || at > best.at)) { if (best) await best.conn.close(); best = { conn: conn, at: at }; }
        else await conn.close();
      } catch (copyError) {
        reportMetadataIssue('safety-copy-unreadable', copyError, 'warning', COPY_NAMES[i]);
      }
    }
    if (!best) return false;
    sqlDb = await workingCopyFrom(best.conn);
    await store.adoptSecretFrom(best.conn);
    await best.conn.close();
    migrateSqliteSchema(sqlDb);
    await store.replaceMainName(SCHEMA);
    await moveIntoNative(store);
    metadataHealth.recoveredFrom = 'safety copy from ' + best.at;
    metadataHealth.status = 'recovered';
    reportMetadataIssue('native-recovered', 'Recovered this phone\'s notes from the safety copy made ' + best.at + '.', 'info');
    return true;
  }
  // Open the native store. Returns true when the working copy is ready (from
  // native, or a recovery), false when today's snapshot file should be opened
  // and moved over, and sets engine 'locked' / 'unavailable' when the app
  // must not write anywhere yet.
  async function openNative(store) {
    var opened;
    try {
      opened = await store.open(SCHEMA);
    } catch (openError) {
      reportMetadataIssue('native-open-failed', openError, 'error');
      if (nativeFlag() === 'active') {
        try { if (await recoverFromCopy(store)) return true; }
        catch (recoverError) { reportMetadataIssue('native-recovery-failed', recoverError, 'error'); }
        // Data lives natively; a blank web database would hide it. Stop here.
        engine = 'unavailable';
        engineInfo = { reason: errorText(openError), preNative: await preNativeSummary() };
        sqlDb = new SQL.Database();
        for (var s = 0; s < SCHEMA.length; s++) sqlDb.run(SCHEMA[s]);
        return true;
      }
      return false; // never moved yet: keep using the snapshot file
    }
    if (opened.state === 'locked') {
      engine = 'locked';
      engineInfo = Object.assign({ preNative: await preNativeSummary() }, opened);
      sqlDb = new SQL.Database();
      for (var i = 0; i < SCHEMA.length; i++) sqlDb.run(SCHEMA[i]);
      return true;
    }
    var conn = store.main();
    if (await conn.meta('working_copy_ready')) {
      sqlDb = await workingCopyFrom(conn);
      engine = 'native';
      journal = [];
      nativeFlag('active');
      if (migrateSqliteSchema(sqlDb)) await ensureNativeColumns(conn);
      return true;
    }
    return false;
  }
  // The snapshot file kept when this phone moved to native storage: a last
  // resort when the phone database cannot be opened and no safety copy can.
  async function preNativeSummary() {
    try {
      var bytes = await readDbFile(SQLITE_PRE_NATIVE_FILE, true);
      if (!bytes) return null;
      return StateDb.inspectDatabaseFile(bytes);
    } catch (_e) { return null; }
  }
  // The unencrypted pre-native snapshot is a last resort only until the
  // encrypted safety copies exist. On a launch where BOTH copies open, pass
  // their integrity check and hold every table, it is removed: the encrypted
  // database and two encrypted copies hold the same data.
  async function retirePreNative() {
    if (engine !== 'native') return false;
    if (!(await readDbFile(SQLITE_PRE_NATIVE_FILE, true))) return false;
    var store = nativeStore();
    for (var i = 0; i < COPY_NAMES.length; i++) {
      if (!(await store.exists(COPY_NAMES[i]))) return false;
      var conn = await store.openCopy(COPY_NAMES[i], SCHEMA); // integrity-checked on open
      try {
        if (!(await conn.meta('copied_at'))) return false;
        for (var t = 0; t < MIRRORED.length; t++) {
          if ((await conn.count(MIRRORED[t])) === 0 && countRows(MIRRORED[t]) > 0 && MIRRORED[t] !== 'operations') return false;
        }
      } finally { await conn.close(); }
    }
    await deleteDbFile(SQLITE_PRE_NATIVE_FILE);
    console.info('[StateDb] removed the unencrypted pre-native copy; two encrypted safety copies hold the same data');
    return true;
  }
  async function restorePreNative() {
    var bytes = await readDbFile(SQLITE_PRE_NATIVE_FILE, false);
    validateSqliteBytes(bytes, 'Kept pre-native snapshot');
    var store = nativeStore();
    // Unreadable databases are set aside (kept), a new key is made, and the
    // kept snapshot becomes the phone database again.
    await store.startFresh(SCHEMA);
    var next = new SQL.Database(new Uint8Array(sqliteBytesView(bytes)));
    migrateSqliteSchema(next);
    assertSqliteIntegrity(next, 'Kept pre-native snapshot');
    try { if (sqlDb) sqlDb.close(); } catch (_e) {}
    sqlDb = next;
    dropRowPrints();
    await moveIntoNative(store);
    return true;
  }

  // Last-known-good copy, at most every 6 hours when the app goes to the
  // background: alternate between two encrypted copies, count the rows, and
  // only then record the time.
  var copyInFlight = null;
  function writeSafetyCopy(force) {
    if (engine !== 'native' || copyInFlight) return copyInFlight || Promise.resolve(false);
    var last = 0;
    try { last = Number(localStorage.getItem(COPY_KEY)) || 0; } catch (_e) {}
    if (!force && Date.now() - last < COPY_EVERY_MS) return Promise.resolve(false);
    copyInFlight = (async function () {
      var store = nativeStore();
      await flushNow();
      var index = 0;
      try { index = (Number(localStorage.getItem(COPY_KEY + '_slot')) || 0) % COPY_NAMES.length; } catch (_e) {}
      var conn = await store.openCopy(COPY_NAMES[index], SCHEMA);
      try {
        await ensureNativeColumns(conn);
        var at = new Date().toISOString();
        await conn.applyChunks(fullCopyChunks(store.secretStatements().concat([{ statement: 'INSERT OR REPLACE INTO native_meta (key,value) VALUES (?,?)', values: ['copied_at', at] }])));
        await verifyCopy(conn);
        try { localStorage.setItem(COPY_KEY, String(Date.now())); localStorage.setItem(COPY_KEY + '_slot', String(index + 1)); } catch (_e) {}
        return true;
      } finally { await conn.close(); }
    })().catch(function (error) {
      reportMetadataIssue('safety-copy-failed', error, 'warning');
      return false;
    }).finally(function () { copyInFlight = null; });
    return copyInFlight;
  }

  function saveDocList(variant, docs) {
    var rows = [];
    (docs || []).forEach(function (d) {
      if (!d || !d.id) return;
      var st = docStatement(variant, d);
      rows.push({ id: d.id, sql: st.sql, values: st.values });
    });
    return saveChangedRows('doc:' + variant, rows, docPrints(variant),
      'DELETE FROM doc_entries WHERE variant=? AND id=?', function (id) { return [variant, id]; });
  }

  // ── generic document store (doc_entries) for "document variants" ──────────
  // Planner (and any future document-variant page) stores its heterogeneous
  // docs here, one row per entry, mirroring the memos/finance per-entry model —
  // so it exports, imports and merges like any other variant.
  var LEGACY_PLANNER_BLOB_KEY = 'plannerEntries.v1'; // planner's old single-blob store
  // Every document collection. Planner is a page; the rest are app-wide
  // collections (the Vault holds items its own module encrypted) that sync,
  // export and import exactly like planner docs. SYNC_VARIANTS is every
  // collection the operation log carries.
  // contacts: AI contacts, groups and the Me profile; messages: one per chat message.
  var DOC_VARIANTS = ['planner', 'vault', 'contacts', 'messages'];
  var EXTRA_DOC_VARIANTS = DOC_VARIANTS.filter(function (v) { return v !== 'planner'; });
  var SYNC_VARIANTS = ['default', 'finance'].concat(DOC_VARIANTS);
  function isDocVariant(variant) { return DOC_VARIANTS.indexOf(variant) >= 0; }

  function docRowParams(doc) {
    var created = (typeof doc.ts === 'number' ? doc.ts : isoToMs(doc.createdAt)) || nowMs();
    var updated = isoToMs(doc.updatedAt) || created;
    var delAt = isoToMs(doc.deletedAt);
    return { id: doc.id, doc: j(doc), created_at: created, updated_at: updated, deleted: delAt ? 1 : 0, deleted_at: delAt };
  }
  function docStatement(variant, doc) {
    var c = docRowParams(doc);
    return { sql: 'INSERT OR REPLACE INTO doc_entries (variant,id,doc,created_at,updated_at,deleted,deleted_at) VALUES (?,?,?,?,?,?,?)',
      values: [variant, c.id, c.doc, c.created_at, c.updated_at, c.deleted, c.deleted_at] };
  }
  function insertDoc(variant, doc) {
    var st = docStatement(variant, doc);
    write(st.sql, st.values);
  }
  // Assistant chat history lives in settings as chat_<variant>.
  function loadChats() {
    var out = {};
    selectAll("SELECT key, value FROM settings WHERE key LIKE 'chat\\_%' ESCAPE '\\'").forEach(function (r) {
      var list = p(r.value);
      if (Array.isArray(list) && list.length) out[r.key.slice(5)] = list;
    });
    return out;
  }
  function loadSavedSearches() {
    var rows = selectAll("SELECT value FROM settings WHERE key='saved_searches'");
    var list = rows.length ? p(rows[0].value) : null;
    return Array.isArray(list) ? list : [];
  }
  // All docs for a variant (incl. deleted tombstones — callers filter), parsed
  // back to their document objects (the source of truth), oldest first.
  function loadDocs(variant) {
    if (!sqlDb) return [];
    return selectAll('SELECT id, doc FROM doc_entries WHERE variant=? ORDER BY created_at', [variant])
      .map(function (r) {
        return parseRowJson(r, 'doc', null, function (value) {
          return !!value && typeof value === 'object' && !Array.isArray(value);
        });
      }).filter(Boolean);
  }
  // Whole-array replace for a variant (matches the store's saveEntries
  // semantics); only changed rows are written.
  function saveDocs(variant, docs) {
    if (!sqlDb) return;
    if (saveDocList(variant, docs)) schedulePersist();
  }
  function countDocs(variant) {
    var r = selectAll('SELECT COUNT(*) AS n FROM doc_entries WHERE variant=?', [variant]);
    return r.length ? r[0].n : 0;
  }
  // Per-entry merge for import: last-write-wins on updatedAt; 'replace' clears
  // the variant first (first-part semantics). Multi-part safe. Returns count.
  function importDocs(variant, list, mode) {
    if (!Array.isArray(list) || !sqlDb) return 0;
    var applied = 0;
    dropRowPrints();
    tx(function () {
      if (mode === 'replace') write('DELETE FROM doc_entries WHERE variant=?', [variant]);
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || !e.id) continue;
        if (mode !== 'replace') {
          var existing = selectAll('SELECT updated_at FROM doc_entries WHERE variant=? AND id=?', [variant, e.id]);
          if (existing.length) {
            var incoming = isoToMs(e.updatedAt) || 0;
            if (incoming < (existing[0].updated_at || 0)) continue; // keep newer
          }
        }
        insertDoc(variant, e); applied++;
      }
    });
    schedulePersist();
    return applied;
  }
  // One-time: move planner's old single-blob into doc_entries, then retire the
  // blob. Guarded (countDocs===0) so it never clobbers newer table data.
  function migratePlannerBlob() {
    if (!sqlDb) return;
    var rows = selectAll('SELECT value FROM settings WHERE key=?', [LEGACY_PLANNER_BLOB_KEY]);
    if (!rows.length) return;
    var arr = p(rows[0].value);
    if (Array.isArray(arr) && arr.length && countDocs('planner') === 0) {
      saveDocs('planner', arr);
      console.log('[StateDb] migrated', arr.length, 'planner docs from blob -> doc_entries');
    }
    write('DELETE FROM settings WHERE key=?', [LEGACY_PLANNER_BLOB_KEY]);
  }

  // ── row <-> entry mapping (matches services/memo_store.py) ────
  function rowToEntry(row, variant) {
    // row is an object {col: value}
    var deletedAtMs = row.deleted ? row.deleted_at : null;
    var attachments = parseRowArray(row, 'attachments', [], false);
    // Older builds accidentally serialized attachment stored paths into the
    // images column. Remove those duplicates on read so existing libraries
    // self-heal instead of presenting a PDF as an image.
    var imagePaths = imagePathsWithoutAttachments(
      parseRowArray(row, 'images', [], false),
      attachments
    );
    var entry = {
      id: row.id,
      description: row.description || '',
      category: row.category || '',
      tags: parseRowArray(row, 'tags', [], false),
      images: imagePaths.slice(),
      // app-private upload refs (uploads/<date>/<name>) for blob-URL regeneration
      _storedPaths: imagePaths.map(urlToRel),
      attachments: attachments,
      imageMeta: parseRowJson(row, 'image_meta', {}, function (value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
      }),
      ts: row.created_at,
      createdAt: msToIso(row.created_at),
      updatedAt: msToIso(row.updated_at),
      deletedAt: msToIso(deletedAtMs),
      deletedBy: row.deleted ? 'local' : null,
      permanentDeleteAt: (row.deleted && row.deleted_at) ? msToIso(row.deleted_at + 30 * 24 * 3600 * 1000) : null
    };
    if (variant === 'finance') {
      entry.purchaseDate = row.purchase_date || '';
      entry.sheet = row.sheet || 'General';
      entry.price = row.price; entry.tax = row.tax;
      entry.adjustment = row.adjustment; entry.total = row.total;
      entry.items = parseRowArray(row, 'items', null, true);
      var details = parseRowJson(row, 'details', {}, function (value) { return !!value && typeof value === 'object' && !Array.isArray(value); });
      DETAIL_KEYS.forEach(function (k) { if (details[k] != null && details[k] !== '') entry[k] = String(details[k]); });
    } else if (row.safe) {
      entry.safe = true;
    }
    return entry;
  }

  function entryCommonParams(e) {
    var created = (typeof e.ts === 'number' ? e.ts : isoToMs(e.createdAt)) || nowMs();
    var updated = isoToMs(e.updatedAt) || created;
    var deletedAt = isoToMs(e.deletedAt);
    // Persist stable upload paths, never ephemeral blob: URLs.  _storedPaths
    // (set by the save flow / load) is the source of truth; otherwise keep any
    // already-stable paths from images.
    var attachments = Array.isArray(e.attachments) ? e.attachments : [];
    var imagePaths;
    if (Array.isArray(e._storedPaths)) {
      imagePaths = imagePathsWithoutAttachments(e._storedPaths, attachments).map(relToUrl);
    } else {
      imagePaths = imagePathsWithoutAttachments(
        (e.images || []).filter(function (u) { return u && String(u).indexOf('blob:') !== 0; }),
        attachments
      );
    }
    return {
      id: e.id, description: e.description || '', category: e.category || '',
      tags: j(e.tags || []), images: j(imagePaths), attachments: j(attachments), image_meta: j(e.imageMeta || {}),
      created_at: created, updated_at: updated, deleted: deletedAt ? 1 : 0, deleted_at: deletedAt
    };
  }

  function entryStatement(e, variant) {
    var c = entryCommonParams(e);
    if (variant === 'finance') {
      return {
        sql: 'INSERT OR REPLACE INTO finance_entries (id,description,category,tags,images,attachments,image_meta,purchase_date,sheet,price,tax,adjustment,total,items,created_at,updated_at,deleted,deleted_at,details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        values: [c.id, c.description, c.category, c.tags, c.images, c.attachments, c.image_meta,
         e.purchaseDate || '', e.sheet || 'General', num(e.price), taxVal(e.tax), num(e.adjustment), num(e.total), j(e.items || null),
         c.created_at, c.updated_at, c.deleted, c.deleted_at, financeDetails(e)]
      };
    }
    return {
      sql: 'INSERT OR REPLACE INTO memos (id,description,category,tags,images,attachments,image_meta,created_at,updated_at,deleted,deleted_at,safe) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      values: [c.id, c.description, c.category, c.tags, c.images, c.attachments, c.image_meta, c.created_at, c.updated_at, c.deleted, c.deleted_at, e.safe ? 1 : 0]
    };
  }
  function insertEntry(e, variant) {
    var st = entryStatement(e, variant);
    write(st.sql, st.values);
  }

  // ── query helpers ────────────────────────────────────────────
  function selectAll(sql, params) {
    var out = [];
    var stmt = sqlDb.prepare(sql);
    try { stmt.bind(params || []); while (stmt.step()) out.push(stmt.getAsObject()); }
    finally { stmt.free(); }
    return out;
  }
  function countRows(table) {
    var r = selectAll('SELECT COUNT(*) AS n FROM ' + table);
    return r.length ? r[0].n : 0;
  }

  // ── one-time migration from legacy localStorage ──────────────
  function migrateLocalStorage(variant) {
    var dbKey = variant === 'finance' ? 'memo_finance_db_v1' : 'memo_db_v1';
    if (countRows(tableFor(variant)) > 0) return null; // already has data
    var raw; try { raw = localStorage.getItem(dbKey); } catch (_e) { raw = null; }
    if (!raw) return null;
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) {
      reportMetadataIssue('legacy-localstorage-parse-failed', error, 'warning', dbKey);
      return null;
    }
    var entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
    if (!entries.length) return null;
    dropRowPrints();
    tx(function () { for (var i = 0; i < entries.length; i++) insertEntry(entries[i], variant); });
    console.log('[StateDb] migrated', entries.length, 'entries from localStorage[' + dbKey + '] -> sqlite');
    return dbKey;
  }
  function migratePlannerLocalStorage() {
    if (countDocs('planner') > 0) return null;
    var raw;
    try { raw = localStorage.getItem(LEGACY_PLANNER_BLOB_KEY); }
    catch (_e) { raw = null; }
    if (!raw) return null;

    var docs;
    try { docs = JSON.parse(raw); }
    catch (error) {
      reportMetadataIssue('legacy-planner-localstorage-parse-failed', error, 'warning', LEGACY_PLANNER_BLOB_KEY);
      return null;
    }
    if (!Array.isArray(docs) || !docs.length) return null;
    importDocs('planner', docs, 'merge');
    console.log('[StateDb] migrated', docs.length, 'planner docs from localStorage -> doc_entries');
    return LEGACY_PLANNER_BLOB_KEY;
  }
  async function migrateLegacyLocalStorage() {
    var migratedKeys = [];
    var memoKey = migrateLocalStorage('default');
    var financeKey = migrateLocalStorage('finance');
    var plannerKey = migratePlannerLocalStorage();
    if (memoKey) migratedKeys.push(memoKey);
    if (financeKey) migratedKeys.push(financeKey);
    if (plannerKey) migratedKeys.push(plannerKey);
    if (!migratedKeys.length) return 0;

    // Do not remove the only legacy copy until the SQLite snapshot has been
    // staged, read back, integrity-checked, promoted, and read back again.
    schedulePersist(0);
    await flushNow();
    migratedKeys.forEach(function (key) {
      try { localStorage.removeItem(key); } catch (_e) {}
    });
    return migratedKeys.length;
  }

  async function readRecoveryCandidate(name) {
    try {
      var bytes = await readDbFile(name, true);
      if (!bytes) return { name: name, bytes: null, error: null };
      validateSqliteBytes(bytes, name);
      return { name: name, bytes: bytes, error: null };
    } catch (error) {
      return { name: name, bytes: null, error: error };
    }
  }

  // ── public API ───────────────────────────────────────────────
  var StateDb = {
    ready: function () { return !!sqlDb; },

    init: function () {
      if (initPromise) return initPromise;
      initPromise = (async function () {
        if (typeof initSqlJs !== 'function') { console.warn('[StateDb] sql.js not loaded — store disabled'); return; }
        try {
          SQL = await initSqlJs({ locateFile: locateWasm });
          var store = nativeStore();
          if (store && await openNative(store)) {
            if (engine === 'native') {
              migratePlannerBlob();
              await migrateLegacyLocalStorage();
              // Off the start-up path: retire the unencrypted kept copy once
              // both safety copies prove good on this later launch.
              setTimeout(function () { retirePreNative().catch(function () {}); }, 5000);
            } else {
              dispatchStorageState();
            }
            return;
          }
          var primary = await readRecoveryCandidate(SQLITE_FILE);
          var recoveryErrors = [];
          var openedBytes = primary.bytes;
          var recoveredFrom = null;
          if (primary.error) {
            recoveryErrors.push(primary);
            reportMetadataIssue('primary-invalid', primary.error, 'warning', SQLITE_FILE);
          }

          if (!openedBytes) {
            var recoveryNames = [SQLITE_TEMP_FILE, SQLITE_BACKUP_FILE];
            for (var i = 0; i < recoveryNames.length; i++) {
              var candidate = await readRecoveryCandidate(recoveryNames[i]);
              if (candidate.bytes) {
                openedBytes = candidate.bytes;
                recoveredFrom = candidate.name;
                break;
              }
              if (candidate.error) {
                recoveryErrors.push(candidate);
                reportMetadataIssue('recovery-candidate-invalid', candidate.error, 'warning', candidate.name);
              }
            }
          }

          if (!openedBytes && recoveryErrors.length) {
            var damagedNames = recoveryErrors.map(function (item) { return item.name; }).join(', ');
            throw new Error('No valid metadata snapshot remained (' + damagedNames + ').');
          }

          sqlDb = openedBytes ? new SQL.Database(new Uint8Array(openedBytes)) : new SQL.Database();
          assertSqliteIntegrity(sqlDb, 'Opened SQLite database');
          var schemaChanged = migrateSqliteSchema(sqlDb);

          if (recoveredFrom) {
            await persistSqliteSnapshot(sqlDb.export(), { rotateBackup: false, seedBackup: true });
            metadataHealth.recoveredFrom = recoveredFrom;
            metadataHealth.status = 'recovered';
            reportMetadataIssue('primary-recovered', 'Recovered local metadata from ' + recoveredFrom + '.', 'info', recoveredFrom);
          } else if (primary.bytes) {
            try { await deleteDbFile(SQLITE_TEMP_FILE); }
            catch (cleanupError) {
              reportMetadataIssue('stale-temp-cleanup-failed', cleanupError, 'warning', SQLITE_TEMP_FILE);
            }
          }

          if (schemaChanged || !openedBytes) schedulePersist(0);
          // One-time: move planner's legacy single-blob into the doc_entries table.
          migratePlannerBlob();
          await migrateLegacyLocalStorage();
          if (store && store.state() === 'ready') {
            try { await flushNow(); await moveIntoNative(store); writeSafetyCopy(true); }
            catch (moveError) {
              // The snapshot file stays the store; the move is retried next launch.
              reportMetadataIssue('native-move-failed', moveError, 'warning');
            }
          }
        } catch (e) {
          reportMetadataIssue('metadata-open-failed', e, 'error', SQLITE_FILE);
          console.error('[StateDb] init failed; existing metadata was left untouched:', e);
          try { if (sqlDb) sqlDb.close(); } catch (_closeError) {}
          sqlDb = null;
          throw e;
        }
      })();
      return initPromise;
    },

    loadEntries: function (variant) {
      if (!sqlDb) return null;
      var rows = selectAll('SELECT * FROM ' + tableFor(variant) + ' ORDER BY created_at');
      return rows.map(function (r) { return rowToEntry(r, variant); });
    },

    // Whole-list replace for a variant; only changed rows are written.
    saveEntries: function (entries, variant) {
      if (!sqlDb) return;
      if (saveEntryList(entries, variant)) schedulePersist();
    },

    // Generic document-variant storage (doc_entries), used by planner-store and
    // any future document-variant page. Whole-array replace, like saveEntries.
    DOC_VARIANTS: DOC_VARIANTS.slice(),
    SYNC_VARIANTS: SYNC_VARIANTS.slice(),
    isDocVariant: isDocVariant,
    loadDocs: function (variant) { return loadDocs(variant); },
    saveDocs: function (variant, docs) { return saveDocs(variant, docs); },

    // Entries and their applied operation cursor form one recoverable generation.
    // No await or scheduled flush may split this transaction.
    saveSyncBatch: function (variant, entries, queueState) {
      if (!sqlDb) throw new Error('Local database is not ready');
      // One transaction: the changed rows and the queue/cursor together.
      tx(function () {
        if (isDocVariant(variant)) saveDocList(variant, entries);
        else saveEntryList(entries, variant);
        write('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',
          ['memo_operation_queue_' + variant, j(queueState)]);
      });
      schedulePersist();
    },

    loadSettings: function () {
      if (!sqlDb) return null;
      var rows = selectAll("SELECT value FROM settings WHERE key='app_settings'");
      return rows.length ? p(rows[0].value) : null;
    },

    saveSettings: function (settings) {
      if (!sqlDb) return;
      var clean = Object.assign({}, settings); delete clean.memoDirHandle;
      write('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', ['app_settings', j(clean)]);
      schedulePersist();
    },

    // Generic key/value (settings table) — used e.g. by the sync op-queue.
    // ── on-device image analysis (MemoInsights) ──
    // Every stored image of live Memo and Finance entries, newest first, read
    // straight from the rows (no entry objects are built).
    listImagePaths: function () {
      if (!sqlDb) return [];
      var out = [];
      [['default', 'memos'], ['finance', 'finance_entries']].forEach(function (pair) {
        selectAll('SELECT id, images, created_at FROM ' + pair[1] + ' WHERE deleted IS NULL OR deleted = 0').forEach(function (row) {
          var images = p(row.images);
          if (!Array.isArray(images)) return;
          images.forEach(function (ref, index) {
            var rel = typeof ref === 'string' ? urlToRel(ref) : null;
            if (rel && /^uploads\//.test(rel)) out.push({ path: rel, entryId: row.id, index: index, variant: pair[0], ts: row.created_at || 0 });
          });
        });
      });
      return out.sort(function (a, b) { return b.ts - a.ts; });
    },
    loadImageHashes: function () {
      if (!sqlDb) return [];
      return selectAll('SELECT path, dhash, version FROM image_dhash');
    },
    putImageHashes: function (records) {
      if (!sqlDb || !Array.isArray(records) || !records.length) return;
      tx(function () {
        records.forEach(function (r) {
          if (r && typeof r.path === 'string' && /^[0-9a-f]{16}$/.test(r.dhash || '')) {
            write('INSERT OR REPLACE INTO image_dhash (path,dhash,version,computed_at) VALUES (?,?,?,?)', [r.path, r.dhash, r.version | 0 || 1, Date.now()]);
          }
        });
      });
      schedulePersist();
    },
    loadImageInsights: function () {
      if (!sqlDb) return [];
      return selectAll('SELECT path, status, labels, faces, face_area, codes, camera, width, height, analyzer_version, analyzed_at, error_code FROM image_insights')
        .map(function (r) {
          var labels = p(r.labels);
          return { path: r.path, status: r.status, labels: Array.isArray(labels) ? labels : [], faces: r.faces || 0,
            faceArea: r.face_area || 0, codes: r.codes || 0, camera: !!r.camera, width: r.width || 0, height: r.height || 0,
            analyzerVersion: r.analyzer_version || 1, analyzedAt: r.analyzed_at || 0, errorCode: r.error_code || '' };
        });
    },
    upsertImageInsights: function (records) {
      if (!sqlDb || !Array.isArray(records) || !records.length) return 0;
      var n = 0;
      tx(function () {
        records.forEach(function (r) {
          if (!r || typeof r.path !== 'string' || !/^uploads\//.test(r.path)) return;
          write('INSERT OR REPLACE INTO image_insights (path,status,labels,faces,face_area,codes,camera,width,height,analyzer_version,analyzed_at,error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [r.path, r.status === 'error' ? 'error' : 'ready', j(Array.isArray(r.labels) ? r.labels : []), r.faces | 0, +r.faceArea || 0,
              r.codes | 0, r.camera ? 1 : 0, r.width | 0, r.height | 0, r.analyzerVersion | 0 || 1, r.analyzedAt || Date.now(), String(r.errorCode || '').slice(0, 160)]);
          n++;
        });
      });
      schedulePersist();
      return n;
    },
    deleteImageInsights: function (paths) {
      if (!sqlDb) return;
      tx(function () {
        if (paths === 'all') write('DELETE FROM image_insights');
        else (paths || []).forEach(function (path) { write('DELETE FROM image_insights WHERE path=?', [path]); });
      });
      schedulePersist();
    },

    getItem: function (key) {
      if (!sqlDb) return null;
      var rows = selectAll('SELECT value FROM settings WHERE key=?', [key]);
      return rows.length ? p(rows[0].value) : null;
    },
    setItem: function (key, value) {
      if (!sqlDb) return;
      write('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, j(value)]);
      schedulePersist();
    },

    // ── interchange: JSON envelope identical to the backend bundle ──
    // (services/db_converter.py export_to_bundle).  A bundle produced here
    // imports into the server and vice-versa.
    exportBundle: function () {
      if (!sqlDb) return null;
      function variantEntries(v) {
        return selectAll('SELECT * FROM ' + tableFor(v) + ' ORDER BY created_at')
          .map(function (r) { return rowToEntry(r, v); });
      }
      // Planner is a document variant (doc_entries table). Include it so an
      // export from ANY page always covers the entire database.
      return {
        version: 1,
        exported_at: new Date().toISOString(),
        memos: variantEntries('default'),
        finance: variantEntries('finance'),
        planner: loadDocs('planner'),
        // App-wide document collections, e.g. { vault: [...] } (still encrypted).
        docs: EXTRA_DOC_VARIANTS.reduce(function (out, v) { out[v] = loadDocs(v); return out; }, {}),
        // Assistant chat history, per variant (settings key chat_<variant>).
        chat: loadChats(),
        // Saved searches the person made (Memo page smart folders).
        savedSearches: loadSavedSearches()
      };
    },

    importBundle: function (bundle, mode) {
      if (!sqlDb || !bundle) return { memos: 0, finance: 0 };
      mode = mode || 'merge';
      function importList(list, variant) {
        if (!Array.isArray(list)) return 0;
        var n = 0;
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          if (!e || !e.id) continue;
          if (mode === 'merge') {
            var existing = selectAll('SELECT updated_at FROM ' + tableFor(variant) + ' WHERE id=?', [e.id]);
            if (existing.length) {
              var incoming = isoToMs(e.updatedAt) || (typeof e.ts === 'number' ? e.ts : 0) || 0;
              if (incoming < (existing[0].updated_at || 0)) continue; // keep newer
            }
          }
          insertEntry(e, variant); n++;
        }
        return n;
      }
      function importDocList(list, variant) {
        if (!Array.isArray(list)) return 0;
        var n = 0;
        for (var i = 0; i < list.length; i++) {
          var doc = list[i];
          if (!doc || !doc.id) continue;
          if (mode === 'merge') {
            var existing = selectAll('SELECT updated_at FROM doc_entries WHERE variant=? AND id=?', [variant, doc.id]);
            if (existing.length) {
              var incoming = isoToMs(doc.updatedAt) || 0;
              if (incoming < (existing[0].updated_at || 0)) continue;
            }
          }
          insertDoc(variant, doc); n++;
        }
        return n;
      }
      // Chat history: replace swaps in the backup's conversations (a backup
      // with no chat section leaves them alone); merge adds messages by id.
      function importChats(chat) {
        if (!chat || typeof chat !== 'object') return 0;
        if (mode === 'replace') write("DELETE FROM settings WHERE key LIKE 'chat\\_%' ESCAPE '\\'");
        var n = 0;
        Object.keys(chat).forEach(function (variant) {
          var list = chat[variant];
          if (!Array.isArray(list) || !/^[a-z0-9_-]+$/i.test(variant)) return;
          var key = 'chat_' + variant, merged = list;
          if (mode === 'merge') {
            var have = selectAll('SELECT value FROM settings WHERE key=?', [key]);
            var byId = {}, order = [];
            [].concat(have.length && Array.isArray(p(have[0].value)) ? p(have[0].value) : [], list).forEach(function (m) {
              if (!m || !m.id) return;
              if (!byId[m.id]) order.push(m.id);
              byId[m.id] = m;
            });
            merged = order.map(function (id) { return byId[id]; })
              .sort(function (a, b) { return (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0); });
          }
          write('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, j(merged)]);
          n += list.length;
        });
        return n;
      }
      // Saved searches: replace takes the backup's list, merge adds by id. A
      // backup without the section leaves them alone.
      function importSavedSearches(list) {
        if (!Array.isArray(list)) return 0;
        var incoming = list.filter(function (item) { return item && typeof item.id === 'string' && typeof item.name === 'string'; });
        var merged = incoming;
        if (mode === 'merge') {
          var byId = {};
          loadSavedSearches().concat(incoming).forEach(function (item) { if (item && item.id) byId[item.id] = item; });
          merged = Object.keys(byId).map(function (id) { return byId[id]; });
        }
        write('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', ['saved_searches', j(merged.slice(0, 100))]);
        return incoming.length;
      }
      var counts;
      dropRowPrints();
      try {
        tx(function () {
        if (mode === 'replace') {
          write('DELETE FROM memos');
          write('DELETE FROM finance_entries');
          if (Array.isArray(bundle.planner)) write('DELETE FROM doc_entries WHERE variant=?', ['planner']);
          EXTRA_DOC_VARIANTS.forEach(function (v) {
            if (bundle.docs && Array.isArray(bundle.docs[v])) write('DELETE FROM doc_entries WHERE variant=?', [v]);
          });
        }
        counts = {
          memos: importList(bundle.memos, 'default'),
          finance: importList(bundle.finance, 'finance'),
          planner: importDocList(bundle.planner, 'planner'),
          docs: EXTRA_DOC_VARIANTS.reduce(function (out, v) {
            out[v] = importDocList(bundle.docs && bundle.docs[v], v); return out;
          }, {}),
          chat: importChats(bundle.chat),
          savedSearches: importSavedSearches(bundle.savedSearches)
        };
        });
      } catch (error) {
        throw error;
      }
      schedulePersist();
      return counts;
    },

    // Whole-database imports stage blobs outside SQLite, so keep an exact byte
    // checkpoint of every metadata/settings table until the imported snapshot
    // has passed durable promotion. This is intentionally not JSON interchange:
    // it must also preserve operations, settings, hashes, and future tables.
    createImportCheckpoint: function () {
      if (!sqlDb) return null;
      assertSqliteIntegrity(sqlDb, 'Pre-import SQLite checkpoint');
      return new Uint8Array(sqlDb.export());
    },
    restoreImportCheckpoint: function (bytes) {
      if (!sqlDb || !bytes) return false;
      validateSqliteBytes(bytes, 'Import rollback checkpoint');
      var restored = new SQL.Database(new Uint8Array(sqliteBytesView(bytes)));
      try { assertSqliteIntegrity(restored, 'Restored import checkpoint'); }
      catch (error) { try { restored.close(); } catch (_closeError) {} throw error; }
      var replaced = sqlDb;
      sqlDb = restored;
      try { replaced.close(); } catch (_closeOldError) {}
      dropRowPrints();
      if (engine === 'native') { fullCopyPending = true; journal = []; }
      schedulePersist(0);
      return true;
    },

    // ── whole-database files ─────────────────────────────────
    // Export: the working copy as an SQLite file. The phone database key
    // (native_meta) is never part of the working copy, so it never leaves.
    exportDatabaseFile: function () {
      if (!sqlDb) return null;
      assertSqliteIntegrity(sqlDb, 'Database export');
      return new Uint8Array(sqlDb.export());
    },
    // Check a chosen database file without touching the current data.
    inspectDatabaseFile: function (bytes) {
      validateSqliteBytes(bytes, 'Selected database file');
      var probe = new SQL.Database(new Uint8Array(sqliteBytesView(bytes)));
      try {
        var version = sqliteUserVersion(probe);
        if (version > SQLITE_SCHEMA_VERSION) {
          throw new Error('This database file comes from a newer version of Memora. Update the app, then import it.');
        }
        var tables = new Set((probe.exec("SELECT name FROM sqlite_master WHERE type='table'")[0] || { values: [] }).values.map(function (r) { return r[0]; }));
        if (!tables.has('memos') || !tables.has('finance_entries') || !tables.has('settings')) {
          throw new Error('This file is not a Memora database.');
        }
        function one(sql) { var r = probe.exec(sql); return r.length ? r[0].values[0][0] : 0; }
        return {
          schemaVersion: version,
          memos: one('SELECT COUNT(*) FROM memos WHERE deleted=0'),
          finance: one('SELECT COUNT(*) FROM finance_entries WHERE deleted=0'),
          planner: tables.has('doc_entries') ? one("SELECT COUNT(*) FROM doc_entries WHERE variant='planner' AND deleted=0") : 0,
          newest: msToIso(Math.max(one('SELECT MAX(updated_at) FROM memos') || 0, one('SELECT MAX(updated_at) FROM finance_entries') || 0)) || null
        };
      } finally { try { probe.close(); } catch (_e) {} }
    },
    // Replace everything with a database file. The current data is kept as
    // a checkpoint and put back if the new data cannot be stored.
    importDatabaseFile: async function (bytes) {
      if (engine === 'locked' || engine === 'unavailable') throw new Error('The phone database is not open.');
      var summary = this.inspectDatabaseFile(bytes);
      var checkpoint = this.createImportCheckpoint();
      var next = new SQL.Database(new Uint8Array(sqliteBytesView(bytes)));
      try { migrateSqliteSchema(next); assertSqliteIntegrity(next, 'Imported database'); }
      catch (error) { try { next.close(); } catch (_e) {} throw error; }
      var replaced = sqlDb;
      sqlDb = next;
      try { replaced.close(); } catch (_e) {}
      dropRowPrints();
      if (engine === 'native') { fullCopyPending = true; journal = []; }
      schedulePersist(0);
      try {
        await flushNow();
      } catch (error) {
        this.restoreImportCheckpoint(checkpoint);
        try { await flushNow(); } catch (_e) {}
        throw error;
      }
      return summary;
    },

    // ── the phone database (Android) ─────────────────────────
    storage: {
      engine: function () { return engine; },
      info: function () { return engineInfo; },
      encrypted: function () { return engine === 'native'; },
      hasRecoveryPassword: function () { var s = nativeStore(); return s ? s.hasRecoveryPassword() : Promise.resolve(false); },
      setRecoveryPassword: function (password) {
        var s = nativeStore();
        if (!s || engine !== 'native') return Promise.reject(new Error('Only the Android app keeps an encrypted phone database.'));
        return s.setRecoveryPassword(password);
      },
      unlock: async function (password) {
        await nativeStore().unlockWithRecoveryPassword(password, SCHEMA);
        return true;
      },
      startFresh: async function () {
        await nativeStore().startFresh(SCHEMA);
        nativeFlag('active');
        return true;
      },
      writeSafetyCopy: function () { return writeSafetyCopy(true); },
      restorePreNative: restorePreNative,
      retirePreNative: retirePreNative
    },

    // ── app-private blob storage ──────────────────────────────
    writeBlob: async function (relPath, blob) {
      await blobWrite(relPath, blob);
      invalidateBlobUrl(relPath);
      dropDerivedThumb(relPath);   // a replaced image must not keep its old thumbnail
    },
    readBlob: function (relPath) { return blobRead(relPath); },
    deleteBlob: async function (relPath) {
      await blobDelete(relPath);
      invalidateBlobUrl(relPath);
      dropDerivedThumb(relPath);
    },
    // List every stored blob rel path (uploads/…) — for Verify & Repair.
    enumerateBlobs: function () { return enumerateBlobs(); },
    blobUrl: function (relPath) { return cachedBlobUrl(relPath); },
    relForBlobUrl: relForBlobUrl,
    urlToRel: urlToRel,
    relToUrl: relToUrl,

    // Adopt one newly persisted image without rehydrating or reordering the
    // entry's other slots. Core uses this to replace an optimistic preview only
    // after its blob and journal write succeed.
    hydrateImageAt: async function (entry, index, relPath) {
      var rel = normalizeBlobRel(relPath);
      if (!entry || !rel || !Number.isInteger(index) || index < 0) return null;
      var url = await this.blobUrl(rel);
      if (!url) return null;
      if (!Array.isArray(entry.images)) entry.images = [];
      entry.images[index] = url;
      registerBlobUrlOwner(rel, url, entry);
      return url;
    },

    // Replace an entry's images (stable paths) with fresh object URLs for display.
    // Mutates and returns the entry; sets _storedPaths to the rel paths.
    hydrateImages: async function (entry) {
      var originalImages = entry.images;
      var originalPaths = entry._storedPaths;
      var sources = (entry.images || []).slice();
      var rels = Array.isArray(entry._storedPaths) && entry._storedPaths.length
        ? entry._storedPaths
        : (entry.images || []).map(urlToRel);
      var attachmentPaths = attachmentPathSet(entry.attachments);
      var urls = [];
      var kept = [];
      for (var i = 0; i < rels.length; i++) {
        var rel = normalizeBlobRel(rels[i]);
        if (!rel) { if (sources[i]) urls.push(sources[i]); continue; }
        if (attachmentPaths.has(rel)) continue;
        var u = await this.blobUrl(rel);
        kept.push(rel);
        if (u) {
          urls.push(u);
          registerBlobUrlOwner(rel, u, entry);
        } else urls.push(sources.find(function (source) { return urlToRel(source) === rel; }) || '/' + rel);
      }
      // Bytes may still be downloading, or an edit may have replaced the image
      // list during an asynchronous read. Neither condition is an image deletion.
      if (entry.images !== originalImages || entry._storedPaths !== originalPaths) return entry;
      entry._storedPaths = kept;
      entry.images = urls;
      return entry;
    },

    flush: flushNow,
    getMetadataHealth: metadataSnapshot
  };

  // flush on tab hide / unload so nothing is lost
  global.addEventListener('pagehide', function (event) {
    // A persisted pagehide freezes this runtime for BFCache, so its live Object
    // URLs must remain usable when the page is restored. Pending SQLite changes
    // still need an immediate durable flush: a cached page can later be evicted
    // without receiving another lifecycle event.
    if (!(window.MemoLifecycle?.retain(event) || (event && event.persisted))) {
      blobUrlCache.dispose();
      blobUrlLoads.clear();
    }
    flushNow().catch(function () {});
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      flushNow().then(function () { return writeSafetyCopy(false); }).catch(function () {});
    }
  });
  function dispatchStorageState() {
    try { global.dispatchEvent(new CustomEvent('memo:storage-state', { detail: { engine: engine, info: engineInfo } })); } catch (_e) {}
  }

  if (global.__MEMO_STATE_DB_TEST__) {
    StateDb.__test = {
      assertSqliteIntegrity: assertSqliteIntegrity,
      validateSqliteBytes: validateSqliteBytes,
      migrateSqliteSchema: migrateSqliteSchema,
      readDbFile: readDbFile,
      writeDbFile: writeDbFile,
      deleteDbFile: deleteDbFile,
      persistSqliteSnapshot: persistSqliteSnapshot,
      readRecoveryCandidate: readRecoveryCandidate,
      setSql: function (value) { SQL = value; },
      setDb: function (value) { sqlDb = value; },
      resetPersistence: function () {
        clearTimeout(persistTimer);
        persistTimer = null;
        persistGeneration = 0;
        persistedGeneration = 0;
        persistInFlight = null;
      },
      resetBlobUrlCache: function (options) {
        blobUrlCache.dispose();
        blobUrlOwners.clear();
        blobUrlLoads.clear();
        blobUrlCache = new BlobUrlCache(Object.assign({}, options || {}, { onRevoke: restoreBlobUrlOwners }));
      },
      blobUrlCacheStats: function () { return blobUrlCache.stats(); },
      flushBlobUrlRevocations: function (force) { blobUrlCache.flush(!!force); },
      constants: {
        primary: SQLITE_FILE,
        temporary: SQLITE_TEMP_FILE,
        backup: SQLITE_BACKUP_FILE,
        schemaVersion: SQLITE_SCHEMA_VERSION
      }
    };
  }

  global.MemoStateDb = StateDb;
  if (global.MemoContracts && typeof global.MemoContracts.registerService === 'function') {
    global.MemoContracts.registerService('stateDb', StateDb);
  }
})(window);
