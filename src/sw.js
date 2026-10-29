/* Memora service worker — makes the app an offline-capable PWA.
 *
 * Strategy (runtime caching; no precache list to maintain):
 *   /api/*        → network-only              (live sync; never cached)
 *   navigations   → network-first, cache fallback   (fresh HTML when online, shell offline)
 *   /static/*     → cache-first, then network        (the ~40 JS + CSS + wasm shell)
 *   /uploads/*    → stale-while-revalidate           (instant images + offline, refresh in bg)
 *   everything else → network, cache successful GETs
 *
 * BUILD_VERSION is stamped by build_tools/build.js so a new build ⇒ new cache name
 * ⇒ old caches purged on activate. Flask serves this file with Cache-Control:no-cache
 * so the SW itself is always revalidated.
 */
'use strict';
var BUILD_VERSION = '{{BUILD_VERSION}}';          // stamped at build / by the Flask route
var PRECACHE = [{{PRECACHE_LIST}}];               // shell URLs stamped in (html + js/css/icons + sql-wasm)
var SHELL_CACHE = 'memora-shell-' + BUILD_VERSION;
var UPLOAD_CACHE = 'memora-uploads-' + BUILD_VERSION;
var UPLOAD_MAX = 400;                              // cap the image cache (rough LRU trim)

// Precache the app shell on install so the FIRST controlled load (2nd visit) is
// fully served from cache — no re-download of the ~40 JS files. Tolerant: a single
// missing URL doesn't abort the whole install.
self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(SHELL_CACHE);
    // `cache: 'reload'` is essential, not a nicety. A plain cache.add() fetches
    // through the HTTP cache, so a new build could precache the PREVIOUS build's
    // bytes into its brand-new cache — the worker updated, the cache name changed,
    // and the app still ran the old JS/CSS. (Seen exactly this: an installed APK
    // kept serving stale assets until a force-stop / `pm clear`.) Reload forces
    // these to come from the network.
    await Promise.all(PRECACHE.map(function (u) {
      return cache.add(new Request(u, { cache: 'reload' })).catch(function () {
        return cache.add(u).catch(function () {});   // older WebViews: better stale than nothing
      });
    }));
    // Leave an update waiting while an existing view is using the old bundle.
    // First installs activate normally; updates activate after those clients close.
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keep = { [SHELL_CACHE]: 1, [UPLOAD_CACHE]: 1 };
    var names = await caches.keys();
    await Promise.all(names.map(function (n) {
      if (n.indexOf('memora-') === 0 && !keep[n]) return caches.delete(n);
    }));
    await self.clients.claim();
  })());
});

function isNav(req) { return req.mode === 'navigate'; }

async function cacheFirst(req, cacheName) {
  var cache = await caches.open(cacheName);
  // ignoreSearch so a precached '/static/x.js' also answers '/static/x.js?v=4'
  // (the build-versioned cache name is what busts across releases, not the ?v=).
  var hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  // Miss on a fresh build's cache: pull from the network rather than let the
  // HTTP cache hand back the previous build's copy (same reasoning as the
  // precache above — this entry is about to be cached for the whole build).
  var res;
  try { res = await fetch(new Request(req, { cache: 'reload' })); }
  catch (_e) { res = await fetch(req); }
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  var cache = await caches.open(cacheName);
  try {
    var res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    var hit = await cache.match(req);
    if (hit) return hit;
    // Offline navigation with no cached page → fall back to the cached index shell.
    var shell = await cache.match('/index.html') || await cache.match('/');
    if (shell) return shell;
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  var cache = await caches.open(cacheName);
  var hit = await cache.match(req);
  var fetching = fetch(req).then(function (res) {
    if (res && res.ok) { cache.put(req, res.clone()); trimCache(cacheName, UPLOAD_MAX); }
    return res;
  }).catch(function () { return hit; });
  return hit || fetching;
}

// Rough LRU: Cache API preserves insertion order, so drop the oldest entries.
async function trimCache(cacheName, max) {
  var cache = await caches.open(cacheName);
  var keys = await cache.keys();
  if (keys.length <= max) return;
  for (var i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;                 // never cache writes
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let cross-origin go straight to network

  if (url.pathname.indexOf('/api/') === 0) return;  // live sync — network only, do not intercept
  if (url.pathname.indexOf('/uploads/') === 0) { event.respondWith(staleWhileRevalidate(req, UPLOAD_CACHE)); return; }
  if (isNav(req)) { event.respondWith(cacheFirst(req, SHELL_CACHE)); return; }
  if (url.pathname.indexOf('/static/') === 0 || url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(cacheFirst(req, SHELL_CACHE)); return;
  }
  // default: try network, cache successful GETs for offline
  event.respondWith((async function () {
    try {
      var res = await fetch(req);
      if (res && res.ok) { var c = await caches.open(SHELL_CACHE); c.put(req, res.clone()); }
      return res;
    } catch (e) {
      var hit = await caches.match(req);
      if (hit) return hit;
      throw e;
    }
  })());
});
