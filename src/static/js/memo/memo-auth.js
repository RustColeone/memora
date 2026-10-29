/*
 * memo-auth.js — optional shared-password gate for server sync.
 *
 * If the server is configured with a sync password, every /api request must
 * carry an `X-Sync-Password` header. This module keeps the user's password in
 * localStorage and transparently attaches it to outgoing API calls by wrapping
 * window.fetch — so every module (sync, operations, settings, chat, ocr, …) is
 * covered without touching each call site. The Capacitor HTTP path is handled
 * separately in memo-api.js via MemoAuth.headers().
 *
 * Loaded early (right after memo-runtime.js) so the wrapper is installed before
 * any module issues a request. With no password set, behaviour is unchanged.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'memo_sync_password';
  var HEADER = 'X-Sync-Password';

  function getPassword() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (_e) { return ''; }
  }
  function setPassword(pw) {
    try {
      if (pw) localStorage.setItem(STORAGE_KEY, pw);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_e) { /* ignore quota / privacy mode */ }
  }
  function clearPassword() { setPassword(''); }

  // Plain object form for the Capacitor HTTP branch (memo-api.js).
  function headers() {
    var pw = getPassword();
    var out = {};
    if (pw) out[HEADER] = pw;
    return out;
  }

  // API + upload traffic needs the header — never static assets or wasm.
  // (Image <img> tags can't send it; those rely on the cookie set below.)
  function isApiUrl(url) {
    try {
      var target = new URL(url, global.location.href);
      var base = global.MemoRuntime?.getApiBase?.() || global.API_BASE || global.location.origin;
      return target.origin === new URL(base, global.location.href).origin && /^\/(api|uploads)\//.test(target.pathname);
    } catch (_) { return false; }
  }

  var _lastApiBase = '';

  // <img> requests can't carry the header, so once we have the password we ask
  // the server (header-authenticated) to drop a short-lived cookie that the
  // browser then attaches to same-origin image requests automatically.
  function establishUploadSession(apiBase) {
    if (apiBase != null) _lastApiBase = apiBase;
    if (!getPassword()) return Promise.resolve();
    try {
      return global.fetch((_lastApiBase || '') + '/api/uploads/session', {
        method: 'POST', credentials: 'same-origin'
      }).then(function () {}, function () {});
    } catch (_e) { return Promise.resolve(); }
  }

  // The image cookie is short-lived (24h). Refresh it periodically and whenever
  // the tab is refocused, so a long-open session never starts 401-ing images.
  var _refreshStarted = false;
  var _refreshInterval = 0;
  var _visibilityHandler = null;
  function stopUploadSessionRefresh() {
    if (_refreshInterval) clearInterval(_refreshInterval);
    _refreshInterval = 0;
    if (_visibilityHandler) document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
    _refreshStarted = false;
  }
  function startUploadSessionRefresh(apiBase) {
    if (apiBase != null) _lastApiBase = apiBase;
    if (_refreshStarted) return;
    _refreshStarted = true;
    _refreshInterval = setInterval(function () { establishUploadSession(); }, 12 * 3600 * 1000);
    _visibilityHandler = function () {
      if (!document.hidden) establishUploadSession();
    };
    document.addEventListener('visibilitychange', _visibilityHandler);
  }

  // Wrap window.fetch once so the header rides along on every API request, and
  // so a 401 from a gated endpoint can trigger a single re-prompt.
  if (typeof global.fetch === 'function' && !global.__memoAuthFetchWrapped) {
    var origFetch = global.fetch.bind(global);
    global.fetch = function (input, init) {
      var url = '';
      try {
        url = (typeof input === 'string') ? input : (input && input.url) || '';
        var pw = getPassword();
        if (pw && isApiUrl(url)) {
          init = init || {};
          var merged = new Headers((init && init.headers) || (typeof input !== 'string' && input && input.headers) || {});
          if (!merged.has(HEADER)) merged.set(HEADER, pw);
          init = Object.assign({}, init, { headers: merged });
        }
      } catch (_e) { /* fall through to a normal fetch */ }
      return origFetch(input, init).then(function (resp) {
        try {
          if (resp && resp.status === 401 && isApiUrl(url)) global.dispatchEvent(new CustomEvent('memo:sync-auth-required'));
        } catch (_e) {}
        return resp;
      });
    };
    global.__memoAuthFetchWrapped = true;
  }

  global.MemoAuth = {
    getPassword: getPassword,
    setPassword: setPassword,
    clearPassword: clearPassword,
    headers: headers,
    establishUploadSession: establishUploadSession,
    startUploadSessionRefresh: startUploadSessionRefresh,
    stopUploadSessionRefresh: stopUploadSessionRefresh,
    HEADER: HEADER,
    // Set by detectMode() once /api/config is read, so the UI can react.
    serverRequiresPassword: false
  };
  global.addEventListener('pagehide', function (event) {
    if (window.MemoLifecycle?.retain(event) || (event && event.persisted)) return;
    stopUploadSessionRefresh();
  });
})(window);
