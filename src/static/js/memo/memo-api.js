(function (global) {
  'use strict';

  var Runtime = global.MemoRuntime || null;
  var Contracts = global.MemoContracts || null;

  function getApiBase() {
    if (Runtime) return Runtime.getApiBase();
    if (Contracts) return Contracts.getApiBase();
    return '';
  }

  function getVariant() {
    if (Contracts) return Contracts.getVariant();
    if (global.MEMO_VARIANT) return String(global.MEMO_VARIANT).toLowerCase();
    var meta = (typeof document !== 'undefined') ? document.querySelector('meta[name="memo-variant"]') : null;
    var v = (meta && meta.getAttribute('content') || 'default').trim().toLowerCase();
    return (v === 'finance' || v === 'default') ? v : 'default';
  }

  function setMode(mode) {
    if (Runtime) {
      Runtime.setMode(mode);
      return;
    }
    if (Contracts) Contracts.setMode(mode);
    else global.MODE = mode;
  }

  function getMode() {
    if (Contracts) return Contracts.getMode();
    return global.MODE || 'local';
  }

  function isAbsoluteHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  async function nativeFetch(url, options) {
    if (global.MemoTransport) return global.MemoTransport.request(url, options || {}, getApiBase());
    return fetch(url, options);
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function (error) { reject(error); };
    });
  }

  async function detectMode() {
    var mode = 'local';

    try {
      var response = await Promise.race([
        nativeFetch(getApiBase() + '/api/config', { cache: 'no-store' }),
        new Promise(function (_, reject) { setTimeout(function () { reject(new Error('config timeout')); }, 1200); })
      ]);

      if (response.ok) {
        var payload = await response.json();
        // A native (Capacitor) build is offline-first, exactly like ImageDB: the
        // local SQLite store is the single source of truth and the reachable
        // server is just a SYNC TARGET (apiBase) reconciled by the op-queue in
        // the background. So it stays in 'capacitor' mode. Only a web page truly
        // SERVED by the backend runs in same-origin 'server' mode (ServerAPI
        // direct, no local store). Classifying native as 'server' was the drift
        // that made every page bypass the one database and re-sync from scratch.
        var isNativeBuild = !!(global.Capacitor && (typeof global.Capacitor.isNativePlatform === 'function'
          ? global.Capacitor.isNativePlatform() : global.Capacitor.Plugins));
        // A separately hosted web client also owns its local database. Only a
        // page loaded from this backend may use direct, server-owned CRUD.
        const apiBase = getApiBase();
        const sameOrigin = !apiBase || new URL(apiBase, global.location.href).origin === global.location.origin;
        mode = isNativeBuild ? 'capacitor' : ((payload && payload.server && sameOrigin) ? 'server' : 'local');
        // Discover whether this server gates the API behind a sync password.
        if (global.MemoAuth) {
          global.MemoAuth.serverRequiresPassword = !!(payload && payload.authRequired);
          if (global.MemoAuth.serverRequiresPassword && !global.MemoAuth.getPassword()) {
            try {
              var entered = global.prompt('This server requires a sync password to load your data:');
              if (entered) global.MemoAuth.setPassword(entered.trim());
            } catch (_ignored) { /* non-interactive context */ }
          }
          // Set up the image cookie before any feed renders <img src="/uploads/…">.
          if (global.MemoAuth.serverRequiresPassword) {
            try {
              await global.MemoAuth.establishUploadSession(getApiBase());
              global.MemoAuth.startUploadSessionRefresh(getApiBase());
            } catch (_e) {}
          }
        }
        setMode(mode);
        return mode;
      }
    } catch (_ignored) {}

    if (typeof global !== 'undefined' && (global.CAP_BOOT || global.__CAP_MODE__)) {
      mode = 'capacitor';
      setMode(mode);
      return mode;
    }

    setMode(mode);
    return mode;
  }

  function variantQuery() {
    var variant = getVariant();
    return variant === 'default' ? '' : ('?variant=' + encodeURIComponent(variant));
  }

  function getVisibleIds() {
    var variant = getVariant();
    var visibleIds = [];

    try {
      if (variant === 'finance') {
        var rows = document.querySelectorAll('table.listtable tbody tr');
        rows.forEach(function (row) {
          var id = row.getAttribute('data-id');
          if (id) visibleIds.push(id);
        });

        if (!visibleIds.length && global.MemoVariant && typeof global.MemoVariant.__lastFiltered === 'function') {
          visibleIds = global.MemoVariant.__lastFiltered().map(function (entry) { return entry.id; });
        }
      } else {
        var cards = document.querySelectorAll('.feed .card');
        cards.forEach(function (card) {
          var id = card.getAttribute('data-id');
          if (id) visibleIds.push(id);
        });

        if (!visibleIds.length && global.MemoVariant && typeof global.MemoVariant.__lastFiltered === 'function') {
          visibleIds = global.MemoVariant.__lastFiltered().map(function (entry) { return entry.id; });
        }
      }
    } catch (_ignored) {}

    return Array.from(new Set(visibleIds)).slice(0, 100);
  }

  var ServerAPI = {
    async list() {
      var response = await nativeFetch(getApiBase() + '/api/memos' + variantQuery());
      if (!response.ok) throw new Error('Failed to fetch memos');
      return response.json();
    },

    async create(memo) {
      var response = await nativeFetch(getApiBase() + '/api/memos' + variantQuery(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(memo)
      });
      if (!response.ok) throw new Error('Failed to create memo');
      return response.json();
    },

    async update(id, patch) {
      var response = await nativeFetch(getApiBase() + '/api/memos/' + encodeURIComponent(id) + variantQuery(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (!response.ok) throw new Error('Failed to update memo');
      return response.json();
    },

    async remove(id) {
      var response = await nativeFetch(getApiBase() + '/api/memos/' + encodeURIComponent(id) + variantQuery(), { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete memo');
    },

    async removePermanent(id) {
      var variant = getVariant();
      var query = variant === 'default'
        ? '?permanent=true'
        : ('?variant=' + encodeURIComponent(variant) + '&permanent=true');
      var response = await nativeFetch(getApiBase() + '/api/memos/' + encodeURIComponent(id) + query, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to permanently delete memo');
    },

    async restore(id) {
      var response = await nativeFetch(getApiBase() + '/api/memos/' + encodeURIComponent(id) + '/restore' + variantQuery(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error('Failed to restore memo');
      return response.json();
    },

    async upload(file) {
      if (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.CapacitorHttp) {
        try {
          var base64Data = await fileToBase64(file);
          var nativeResponse = await nativeFetch(getApiBase() + '/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              file: base64Data,
              filename: file.name,
              type: file.type
            })
          });
          if (!nativeResponse.ok) throw new Error('Upload failed');
          return nativeResponse.json();
        } catch (error) {
          console.error('Native upload failed, falling back', error);
        }
      }

      var formData = new FormData();
      formData.append('file', file);
      var response = await fetch(getApiBase() + '/api/upload', { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Upload failed');
      return response.json();
    }
  };

  if (Contracts) {
    Contracts.registerService('serverApi', ServerAPI);
    Contracts.registerService('nativeFetch', nativeFetch);
  }

  global.nativeFetch = nativeFetch;
  global.ServerAPI = ServerAPI;

  global.MemoApi = {
    nativeFetch: nativeFetch,
    detectMode: detectMode,
    getServerAPI: function () { return ServerAPI; }
  };
})(window);
