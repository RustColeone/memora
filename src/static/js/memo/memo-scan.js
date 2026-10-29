// memo-scan.js — "Scan": read a QR or bar code with the phone camera.
//
// The camera screen is Google's code scanner (QrScannerPlugin, Android); only
// the decoded text reaches Memora. A Memora pairing code — what "Host sync on
// this computer" shows on the desktop app, {"memora":1,"url","password"} or
// memora://sync?url=…&password=… — asks to connect to that sync server. Any
// other code starts a new note with its text, ready to edit before saving.
(function (global) {
  'use strict';

  function t(s, v) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s, v) : String(s).replace(/\{(\w+)\}/g, function (_m, k) { return v && v[k] != null ? v[k] : ''; }); }
  function plugin() { var C = global.Capacitor; return (C && C.Plugins && C.Plugins.QrScanner) || null; }
  function isNative() { var C = global.Capacitor; return !!(C && C.isNativePlatform && C.isNativePlatform()); }
  function available() { return isNative() && !!plugin(); }
  function toast(message, kind) { if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast(message, { kind: kind || 'info' }); }
  function apiBase() { return String((global.MemoContracts && global.MemoContracts.getApiBase && global.MemoContracts.getApiBase()) || '').replace(/\/$/, ''); }

  // A pairing code, or null.
  function pairing(text) {
    var s = String(text || '').trim(), url = null, password = '';
    try {
      var j = JSON.parse(s);
      if (j && j.memora && typeof j.url === 'string') { url = j.url; password = j.password || ''; }
    } catch (_e) {
      var m = /^memora:\/\/sync\?(.*)$/i.exec(s);
      if (m) { var q = new URLSearchParams(m[1]); url = q.get('url'); password = q.get('password') || ''; }
    }
    if (!url) return null;
    try { var u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; url = u.origin + u.pathname.replace(/\/$/, ''); }
    catch (_e) { return null; }
    return { url: url, password: String(password) };
  }

  async function connect(code) {
    var current = apiBase();
    var message = t('Connect to the sync server at {url}?', { url: code.url }) +
      (current && current !== code.url ? '\n\n' + t('This replaces the server you sync with now ({url}).', { url: current }) : '') +
      (/^http:/i.test(code.url) ? '\n\n' + t('Plain HTTP: use it only on a home network you trust.') : '');
    var ok = !global.MemoShell || !global.MemoShell.confirm || await global.MemoShell.confirm(message, { okLabel: t('Connect') });
    if (!ok) return false;
    try { localStorage.setItem('memo_server_url', code.url); } catch (_e) {}
    if (global.MemoContracts && global.MemoContracts.setApiBase) global.MemoContracts.setApiBase(code.url);
    if (global.MemoAuth && global.MemoAuth.setPassword) global.MemoAuth.setPassword(code.password);
    var input = document.getElementById('serverUrlInput');
    if (input) input.value = code.url;
    try {
      if (global.SyncManager && global.SyncManager.init) await global.SyncManager.init();
      var result = global.OperationQueue && global.OperationQueue.manualSync ? await global.OperationQueue.manualSync() : null;
      if (result && !['success', 'pending'].includes(result.status)) throw new Error(result.error || result.status);
      var status = document.getElementById('syncStatus');
      if (status) status.style.display = 'flex';
      toast(t('Connected. Sync is on.'), 'success');
    } catch (error) {
      toast(t('Saved the server, but could not reach it yet: {error}', { error: (error && error.message) || String(error) }), 'error');
    }
    return true;
  }

  async function newNote(text) {
    var shell = global.MemoSpaShell;
    if (shell && shell.getVariant && shell.getVariant() !== 'default') await shell.switchTo('default');
    if (global.MemoShell && global.MemoShell.menuOpen && global.MemoShell.menuOpen()) global.MemoShell.closeMenu();
    if (!global.MemoCore || !global.MemoCore.restoreDraft) return false;
    global.MemoCore.restoreDraft({ entry: null, tags: [], images: [], files: [], fields: [{ id: 'desc', value: String(text) }] });
    return true;
  }

  // What to do with a scanned text (also used by tests).
  async function handle(text) {
    var s = String(text || '').trim();
    if (!s) { toast(t('That code is empty.')); return 'empty'; }
    var code = pairing(s);
    if (code) return (await connect(code)) ? 'connected' : 'declined';
    return (await newNote(s)) ? 'note' : 'ignored';
  }

  async function scan() {
    var p = plugin();
    if (!p) { toast(t('Scanning needs the Memora app on Android.'), 'error'); return null; }
    try {
      var result = await p.scan();
      if (!result || result.cancelled) return null;
      return handle(result.text);
    } catch (error) {
      toast(t('Could not open the scanner: {error}', { error: (error && error.message) || String(error) }), 'error');
      return null;
    }
  }

  function showButtons() {
    if (!available()) return;
    document.querySelectorAll('#mobileScanBtn, #scanPairingBtn').forEach(function (b) { b.hidden = false; });
  }
  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target.closest('#mobileScanBtn, #scanPairingBtn') : null;
    if (!el) return;
    event.preventDefault();
    scan();
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showButtons); else showButtons();
  document.addEventListener('memo:variant-changed', showButtons);

  global.MemoScan = { available: available, scan: scan, handle: handle, pairing: pairing };
})(window);
