// memo-lazyimg.js — viewport-based lazy image loading + server thumbnail URLs.
//
// Cards render <img class="lazy-img" data-src="…" loading="lazy"> with no eager
// src; the real source is set only when the image scrolls near the viewport, so
// a long feed no longer fetches/decodes every image up front. For server-hosted
// uploads we point cards at a downscaled thumbnail (?w=<width>) to cut bytes;
// blob:/data:/external URLs (offline mode) are used as-is, just lazily.
(function (global) {
  'use strict';
  var supported = typeof IntersectionObserver === 'function';
  var observer = null;
  var observed = new Set();
  var loadRuns = new WeakMap();

  function unobserve(img) {
    if (observer) observer.unobserve(img);
    observed.delete(img);
  }

  function prune() {
    observed.forEach(function (img) {
      if (!img || !img.isConnected) unobserve(img);
    });
  }

  function load(img) {
    if (!img || img.dataset.lazyDone) return;
    var src = img.getAttribute('data-src');
    var run = (loadRuns.get(img) || 0) + 1;
    loadRuns.set(img, run);
    if (src) {
      // Fade in on decode so a burst of images doesn't flash/pop as they load.
      img.decoding = 'async';
      var reveal = function () {
        var finish = function () {
          if (img.isConnected && loadRuns.get(img) === run) img.classList.add('lazy-loaded');
        };
        if (typeof img.decode === 'function') {
          try { Promise.resolve(img.decode()).then(finish, finish); } catch (_e) { finish(); }
        } else finish();
      };
      var assign = function (resolved) {
        // A recycled/mutated node may have started a newer path lookup while
        // this Blob read was pending. Only the latest request owns the paint.
        if (!img.isConnected || loadRuns.get(img) !== run || img.getAttribute('data-src') !== src) return;
        var finalSrc = resolved || src;
        img.setAttribute('data-src', finalSrc);
        img.dataset.lazyDone = '1';
        img.addEventListener('load', reveal, { once: true });
        img.addEventListener('error', function () {
          // A local blob missing from the store (a sync straggler) 404s on native
          // (https://localhost/uploads/… doesn't exist). Re-fetch it from the sync
          // server, cache it, and swap in the healed blob URL. Falls through to
          // reveal so a genuinely-gone image doesn't retry forever.
          if (isNative && isUploadPath(src)) selfHeal(img, src, run);
          reveal();
        }, { once: true });
        img.src = finalSrc;
        if (img.complete) reveal(); // already cached → no transition needed
      };
      var stateDb = global.MemoStateDb;
      var mode = global.MemoContracts && typeof global.MemoContracts.getMode === 'function'
        ? global.MemoContracts.getMode() : global.MODE;
      // Web server mode serves /uploads same-origin, so load those directly. But a
      // native (Capacitor) build runs at https://localhost while the server is a
      // different (often http) origin — those URLs can't load (mixed content), so
      // always display from the local blob store on native, whatever the sync mode.
      var isNative = !!(global.Capacitor && (typeof global.Capacitor.isNativePlatform === 'function'
        ? global.Capacitor.isNativePlatform() : global.Capacitor.Plugins));
      // Prefer a cached downscaled thumbnail over the full-size image. MemoLazy
      // only drives THUMBNAIL surfaces (feed cards/rows, the panel, the
      // category/library pickers — the lightbox and reader resolve their own
      // full-size URLs), so this never costs display quality, and it stops a
      // 54px tile from decoding a multi-megapixel bitmap.
      var dbReady = !!(stateDb && typeof stateDb.ready === 'function' && stateDb.ready());
      var thumbs = global.MemoThumbs;
      var canThumb = !!(dbReady && thumbs && typeof thumbs.urlFor === 'function');
      if (isUploadPath(src) && (mode !== 'server' || isNative) && dbReady
          && typeof stateDb.blobUrl === 'function') {
        var resolved = canThumb
          ? Promise.resolve(thumbs.urlFor(src)).then(function (thumbUrl) {
              return thumbUrl || stateDb.blobUrl(src);
            })
          : Promise.resolve(stateDb.blobUrl(src));
        resolved.then(assign, function () { assign(src); });
      } else if (canThumb && String(src).indexOf('blob:') === 0
                 && typeof stateDb.relForBlobUrl === 'function') {
        // Already hydrated to a display blob: URL by another path (this is the
        // common case in the feed on native). A blob: URL carries no path, so
        // map it back to its stored rel — otherwise these images, the very ones
        // filling the feed, would keep decoding at full resolution.
        var rel = stateDb.relForBlobUrl(src);
        if (rel) {
          Promise.resolve(thumbs.urlFor(rel)).then(function (thumbUrl) { assign(thumbUrl || src); },
                                                   function () { assign(src); });
        } else assign(src);
      } else assign(src);
    } else {
      img.classList.add('lazy-loaded');
      img.dataset.lazyDone = '1';
    }
  }

  function ensureObserver() {
    if (observer || !supported) return observer;
    // Preload a bit before the image enters view for a seamless scroll.
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        load(en.target);
        unobserve(en.target);
      });
    }, { rootMargin: '400px 0px' });
    return observer;
  }

  function isUploadPath(src) {
    return typeof src === 'string'
      && src.indexOf('blob:') !== 0
      && src.indexOf('data:') !== 0
      && /(^|\/)uploads\//.test(src);
  }

  // ── Self-heal for a missing local blob ──────────────────────────────────
  // A native build shows images from the app-private blob store; if one image
  // failed to download during sync (e.g. "unexpected end of stream"), it 404s
  // forever until the entry re-syncs. When such an <img> errors, pull the
  // original from the sync server, cache it, and swap it in.
  var healing = new Set();
  function relFromSrc(src) {
    var m = String(src || '').match(/(?:^|\/)uploads\/([^\/?#]+)\/([^?#]+)/);
    return m ? ('uploads/' + m[1] + '/' + m[2]) : null;
  }
  function healApiBase() {
    var b = (global.MemoContracts && typeof global.MemoContracts.getApiBase === 'function')
      ? global.MemoContracts.getApiBase() : (global.API_BASE || '');
    return (b || '').replace(/\/$/, '');
  }
  function base64ToBlob(b64, mime) {
    try {
      var bin = atob(b64), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime || 'application/octet-stream' });
    } catch (_e) { return null; }
  }
  function downloadRemoteBlob(url) {
    const request = global.MemoTransport ? global.MemoTransport.request(url, { responseType: 'blob' }, healApiBase()) : fetch(url);
    return request.then(r => r.ok ? r.blob() : null).catch(() => null);
  }
  function downloadWithRetry(url, attempts) {
    return downloadRemoteBlob(url).then(function (blob) {
      if (blob || attempts <= 1) return blob;
      return new Promise(function (r) { setTimeout(r, 500); }).then(function () { return downloadWithRetry(url, attempts - 1); });
    });
  }
  function selfHeal(img, src, run) {
    var stateDb = global.MemoStateDb;
    if (!stateDb || typeof stateDb.ready !== 'function' || !stateDb.ready() || typeof stateDb.writeBlob !== 'function') return;
    if (!isUploadPath(src)) return;
    var rel = relFromSrc(src);
    if (!rel || healing.has(rel)) return;
    var apiBase = healApiBase();
    if (!apiBase) return; // no server configured → can't re-fetch
    healing.add(rel);
    var clean = String(src).split('?')[0].split('#')[0]; // fetch the original, not the ?w= thumbnail
    var fullUrl = /^https?:\/\//.test(clean) ? clean : (apiBase + (clean.charAt(0) === '/' ? clean : '/' + clean));
    downloadWithRetry(fullUrl, 3).then(function (blob) {
      healing.delete(rel);
      if (!blob) return;
      Promise.resolve(stateDb.writeBlob(rel, blob)).then(function () {
        if (!img.isConnected || loadRuns.get(img) !== run) return;
        Promise.resolve(stateDb.blobUrl(src)).then(function (url) {
          if (!url || !img.isConnected || loadRuns.get(img) !== run) return;
          img.addEventListener('load', function () { img.classList.add('lazy-loaded'); }, { once: true });
          img.src = url;
        });
      }, function () {});
    });
  }

  var MemoLazy = {
    // Thumbnail URL for card display. Server uploads get ?w=<width>; blob:/data:/
    // external URLs are returned unchanged (no server to resize them).
    thumbUrl: function (src, width) {
      if (!isUploadPath(src)) return src;
      var w = width || 240;
      return src + (src.indexOf('?') === -1 ? '?' : '&') + 'w=' + w;
    },
    observe: function (img) {
      if (!img) return;
      if (!supported) { load(img); return; }
      if (observed.has(img)) return;
      observed.add(img);
      ensureObserver().observe(img);
    },
    // Hydrate every <img data-src> under root — call right after rendering a feed.
    hydrate: function (root) {
      prune();
      var scope = root || document;
      var imgs = scope.querySelectorAll('img[data-src]:not([data-lazy-done])');
      for (var i = 0; i < imgs.length; i++) this.observe(imgs[i]);
    },
    // Release pending targets before a renderer detaches a subtree. Loaded
    // images need no observer ownership and are left to normal DOM collection.
    release: function (root) {
      if (!root) return;
      observed.forEach(function (img) {
        if (img === root || (root.contains && root.contains(img))) unobserve(img);
      });
    },
    disconnect: function () {
      if (observer) observer.disconnect();
      observed.clear();
      observer = null;
    },
  };

  global.MemoLazy = MemoLazy;
  global.addEventListener('pagehide', function (event) {
    if (window.MemoLifecycle?.retain(event) || (event && event.persisted)) return;
    MemoLazy.disconnect();
  });

  // Re-arm after the app comes back to the foreground.
  //
  // In a browser tab, pagehide (persisted=false) means the document is going
  // away, so tearing the observer down is final. In a Capacitor WebView it is
  // NOT: pressing Home fires pagehide while the page stays alive, and on
  // resume nothing recreates the IntersectionObserver — so every pending
  // <img data-src> stays blank and the feed looks like it lost its thumbnails.
  //
  // visibilitychange is the reliable signal here (pageshow only fires on a real
  // bfcache restore, which a WebView resume is not); both are bound, and
  // hydrate() is idempotent, so re-arming twice is harmless.
  function rearm() {
    if (global.document && global.document.visibilityState === 'hidden') return;
    MemoLazy.hydrate(global.document);
  }
  global.addEventListener('pageshow', rearm);
  if (global.document) global.document.addEventListener('visibilitychange', rearm);
})(typeof window !== 'undefined' ? window : this);
