// memo-desktop-sync.js — "Host sync on this computer" (desktop app only).
//
// The switch starts the bundled memora-server (desktop/main.cjs) on this
// computer's network and shows its address, sync password and a QR code
// for the phone. This computer then syncs with its own server like any other
// device, unless it already syncs with another server. The server runs only
// while Memora is open; the switch is remembered across launches.
(function (global) {
  'use strict';
  var D = global.MemoDesktop;
  if (!D) return;
  var KEY = 'memo_desktop_server';
  var busy = false, info = null, error = '';

  function t(s, v) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s, v) : String(s).replace(/\{(\w+)\}/g, function (_m, k) { return v && v[k] != null ? v[k] : ''; }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function remembered() { try { return localStorage.getItem(KEY) === '1'; } catch (_e) { return false; } }
  function remember(on) { try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch (_e) {} }
  function apiBase() { return String((global.MemoContracts && global.MemoContracts.getApiBase && global.MemoContracts.getApiBase()) || '').replace(/\/$/, ''); }
  function setApiBase(url) { if (global.MemoContracts && global.MemoContracts.setApiBase) global.MemoContracts.setApiBase(url); else global.API_BASE = url; }

  // This computer syncs with its own server unless it already uses another one.
  async function connectSelf(local, password) {
    var current = apiBase();
    if (current && current !== local) return false;
    try { localStorage.setItem('memo_server_url', local); } catch (_e) {}
    setApiBase(local);
    if (global.MemoAuth && global.MemoAuth.setPassword) global.MemoAuth.setPassword(password);
    var input = document.getElementById('serverUrlInput');
    if (input) input.value = local;
    try {
      if (global.SyncManager && global.SyncManager.init) await global.SyncManager.init();
      if (global.OperationQueue && global.OperationQueue.manualSync) await global.OperationQueue.manualSync();
    } catch (_e) { /* the sync status shows any problem */ }
    return true;
  }
  function disconnectSelf(local) {
    if (apiBase() !== local) return;
    try { localStorage.removeItem('memo_server_url'); } catch (_e) {}
    setApiBase('');
    var input = document.getElementById('serverUrlInput');
    if (input) input.value = '';
    var status = document.getElementById('syncStatus');
    if (status) status.style.display = 'none';
  }

  async function turnOn() {
    busy = true; error = ''; render();
    try {
      info = await D.server.start();
      remember(true);
      info.self = await connectSelf(info.local, info.password);
    } catch (e) {
      info = null; remember(false);
      error = (e && e.message) || String(e);
    } finally { busy = false; render(); }
  }
  async function turnOff() {
    busy = true; render();
    var local = info && info.local;
    try { await D.server.stop(); } catch (_e) {}
    if (local) disconnectSelf(local);
    info = null; remember(false); busy = false; render();
  }

  function render() {
    var box = document.getElementById('desktopServerSection');
    if (!box) return;
    box.hidden = false;
    var on = !!(info && info.running);
    var html = '<h3><span class="svg-icon svg-icon-cloud"></span> <span>' + esc(t('Host sync on this computer')) + '</span></h3>' +
      '<p class="muted">' + esc(t('Your phone and other devices can sync with this computer. The server runs only while Memora is open.')) + '</p>' +
      '<label class="desktop-server-switch"><input type="checkbox" id="desktopServerToggle"' + (on ? ' checked' : '') + (busy ? ' disabled' : '') + '> ' +
      '<span>' + esc(busy ? t('Starting…') : on ? t('Sync server is on') : t('Turn on sync server')) + '</span></label>';
    if (error) html += '<p class="desktop-server-error" role="alert">' + esc(error) + '</p>';
    if (on) {
      html += '<div class="desktop-server-info">' +
        (info.qr ? '<img class="desktop-server-qr" src="' + esc(info.qr) + '" alt="' + esc(t('QR code with the address and sync password')) + '">' : '') +
        '<div class="desktop-server-text"><div class="muted">' + esc(t('On your phone, open Settings, Server Sync, and enter:')) + '</div>' +
        '<div><strong>' + esc(t('Server URL')) + '</strong></div>' +
        (info.urls.length ? info.urls.map(function (u) { return '<code class="desktop-server-copy" data-copy="' + esc(u) + '">' + esc(u) + '</code>'; }).join('')
          : '<div class="muted">' + esc(t('This computer has no network connection right now.')) + '</div>') +
        '<div><strong>' + esc(t('Sync password')) + '</strong></div><code class="desktop-server-copy" data-copy="' + esc(info.password) + '">' + esc(info.password) + '</code>' +
        '<div class="muted">' + esc(info.self ? t('This computer syncs with it too.') : t('This computer keeps syncing with {url}.', { url: apiBase() })) + '</div>' +
        '<div class="muted">' + esc(t('Plain HTTP: use it on a home network you trust. Windows may ask once to allow Memora on private networks.')) + '</div>' +
        '</div></div>';
    }
    box.innerHTML = html;
  }

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'desktopServerToggle' && !busy) { if (e.target.checked) turnOn(); else turnOff(); }
  });
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('.desktop-server-copy');
    if (!el) return;
    var text = el.getAttribute('data-copy');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () {
      if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast(t('Copied.'));
    }).catch(function () {});
  });
  if (D.on) D.on('server-stopped', function () { info = null; error = t('The sync server stopped.'); render(); });

  async function init() {
    render();
    try {
      var status = await D.server.status();
      if (status && status.running) { info = status; info.self = apiBase() === status.local; render(); }
      else if (remembered()) await turnOn();
    } catch (_e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  document.addEventListener('memo:localechange', render);

  global.MemoDesktopSync = { turnOn: turnOn, turnOff: turnOff, info: function () { return info; } };
})(window);
