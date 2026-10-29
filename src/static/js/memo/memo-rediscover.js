// memo-rediscover.js — find your sync server again when its address changes.
//
// Home routers sometimes give the computer running the server a new address,
// and the desktop app may move its server to another port when 5050 is taken.
// After a good sync this app remembers who the server is (its permanent
// serverId from /api/config). When that server stops answering at a
// home-network address (10.x, 172.16–31.x, 192.168.x), it looks for it on the
// same network: the same computer on ports 5050–5059 first, then every other
// address in the same /24 on the server's port. It moves over only to a
// server with the same id that also proves it knows the sync password
// (HMAC of a fresh challenge), so another device cannot pose as it to collect
// the password. No address typing, no settings.
(function (global) {
  'use strict';
  var KEY = 'memo_server_identity';          // { url, id }
  var EVERY_MS = 5 * 60 * 1000;               // at most one search per 5 minutes
  var PROBE_MS = 1500, PARALLEL = 24;
  var PORTS = [5050, 5051, 5052, 5053, 5054, 5055, 5056, 5057, 5058, 5059];
  var lastRun = 0, running = null;

  function t(s, v) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s, v) : String(s).replace(/\{(\w+)\}/g, function (_m, k) { return v && v[k] != null ? v[k] : ''; }); }
  function apiBase() { return String((global.MemoContracts && global.MemoContracts.getApiBase && global.MemoContracts.getApiBase()) || '').replace(/\/$/, ''); }
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_e) {} }
  function privateIPv4(host) {
    var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host || '');
    if (!m) return null;
    var a = +m[1], b = +m[2];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return m.slice(1, 5).map(Number);
    return null;
  }
  function hex(bytes) { return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  async function hmac(password, text) {
    var enc = new TextEncoder();
    var key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))));
  }

  // One quick question to one address: its /api/config, or null.
  async function probe(origin, challenge) {
    var url = origin + '/api/config?challenge=' + challenge;
    try {
      var native = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.CapacitorHttp;
      if (native && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform()) {
        var r = await native.request({ url: url, method: 'GET', connectTimeout: PROBE_MS, readTimeout: PROBE_MS, responseType: 'json' });
        if (r.status !== 200) return null;
        return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      }
      if (global.MemoDesktop && global.MemoDesktop.http) {
        var d = await global.MemoDesktop.http.request({ url: url, method: 'GET', headers: {}, timeoutMs: PROBE_MS });
        if (d.error || d.status !== 200) return null;
        return JSON.parse(new TextDecoder().decode(d.body));
      }
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, PROBE_MS);
      try {
        var res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
        return res.ok ? await res.json() : null;
      } finally { clearTimeout(timer); }
    } catch (_e) { return null; }
  }

  // Is this the same server, and does it know the password?
  async function isOurs(config, identity, challenge) {
    if (!config || !config.server || config.serverId !== identity.id) return false;
    var password = global.MemoAuth && global.MemoAuth.getPassword ? global.MemoAuth.getPassword() : '';
    if (!config.authRequired) return !password;   // an open server, and we never had a password for it
    if (!password || typeof config.proof !== 'string') return false;
    return (await hmac(password, challenge + ':' + config.serverId)) === config.proof;
  }

  function candidates(old) {
    var u = new URL(old), ip = privateIPv4(u.hostname);
    if (!ip) return [];
    var port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    var base = ip.slice(0, 3).join('.'), out = [];
    PORTS.forEach(function (p) { if (p !== port) out.push(u.protocol + '//' + u.hostname + ':' + p); });
    for (var h = 1; h <= 254; h++) if (h !== ip[3]) out.push(u.protocol + '//' + base + '.' + h + ':' + port);
    return out;
  }

  async function search(identity) {
    var challenge = hex(crypto.getRandomValues(new Uint8Array(16)));
    var list = candidates(identity.url), found = null, next = 0;
    async function worker() {
      while (!found && next < list.length) {
        var origin = list[next++];
        var config = await probe(origin, challenge);
        if (!found && await isOurs(config, identity, challenge)) found = origin;
      }
    }
    var workers = [];
    for (var i = 0; i < PARALLEL; i++) workers.push(worker());
    await Promise.all(workers);
    return found;
  }

  function moveTo(url) {
    try { localStorage.setItem('memo_server_url', url); } catch (_e) {}
    if (global.MemoContracts && global.MemoContracts.setApiBase) global.MemoContracts.setApiBase(url);
    var input = document.getElementById('serverUrlInput');
    if (input) input.value = url;
    var identity = load();
    if (identity) save({ url: url, id: identity.id });
    if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast(t('Found your sync server at its new address.'), { kind: 'success' });
    if (global.OperationQueue && global.OperationQueue.processQueue) global.OperationQueue.processQueue();
  }

  // Look for the server now (also used by tests). Resolves to the new address, or null.
  function run(force) {
    if (running) return running;
    var identity = load(), current = apiBase();
    if (!identity || !identity.id || identity.url !== current || !privateIPv4(new URL(current).hostname)) return Promise.resolve(null);
    if (!force && Date.now() - lastRun < EVERY_MS) return Promise.resolve(null);
    if (global.navigator && global.navigator.onLine === false) return Promise.resolve(null);
    lastRun = Date.now();
    running = search(identity).then(function (url) {
      if (url && apiBase() === current) moveTo(url);
      return url;
    }).finally(function () { running = null; });
    return running;
  }

  // After a good sync, remember who the server is.
  async function remember() {
    var base = apiBase(), q = global.OperationQueue;
    if (!base || !q || !q.serverConfig) return;
    var known = load();
    if (known && known.url === base && known.id) return;
    var config = await q.serverConfig(base);
    if (config && config.serverId && apiBase() === base) save({ url: base, id: config.serverId });
  }

  global.addEventListener('memo:sync-state', function () {
    var p = global.OperationQueue && global.OperationQueue.presentation;
    if (!p || !apiBase()) return;
    if (p.status === 'success' || p.status === 'pending') remember();
    else if (p.status === 'offline') run(false);
  });

  global.MemoRediscover = { run: run, remember: remember, candidates: candidates, _identity: load };
})(window);
