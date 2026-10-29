// memo-thumbs.js — cached local thumbnails for stored images.
//
// Why this exists: on a native build the feed displays images out of the local
// blob store, and MemoLazy.thumbUrl() can only add `?w=` to SERVER /uploads
// paths — a blob: URL has no server to resize it. So every card thumbnail was
// decoding its image at FULL resolution: measured on-device, a thumbnail shown
// at 54x54 was decoding at 539x837, roughly 1.8MB of bitmap for a 54px tile.
// Twenty of those is tens of MB of live bitmap, which is what got the WebView
// renderer reclaimed while the app was backgrounded — and a killed renderer
// means the whole page reloads on resume (slow, flashing restore).
//
// Mirrors ImageDB's approach (src/image-utils.js): decode once, downscale to a
// 400px-max-edge JPEG, keep it in the blob store beside the original, and serve
// that to every thumbnail surface. 400px covers the largest thumbnail we render
// (the library picker at 320) so one cached thumb serves them all.
(function (global) {
  'use strict';

  var THUMB_MAX_PX = 400;      // max edge; >= the largest thumbnail surface (320)
  var THUMB_QUALITY = 0.8;
  var DECODE_TIMEOUT_MS = 10000;
  var MAX_CONCURRENT = 3;      // decoding is memory-hungry: don't do 20 at once
  // NO file-size gate. An earlier version skipped sources under 48KB as "not
  // worth it" — which quietly defeated the whole feature: the cost we care about
  // is DECODED PIXELS, not bytes on disk, and screenshots compress ferociously.
  // A real case from the feed: a 44KB PNG that decodes to 539x837 ≈ 1.8MB of
  // bitmap, skipped by that gate while being exactly the kind of image we need
  // to shrink. resizeBlob() already returns null when an image is genuinely
  // small in PIXELS, which is the only check that means anything here; the one
  // decode it costs is paid once and cached forever.
  var MAX_DECODE_EDGE = 32768;
  var MAX_DECODE_PIXELS = 64 * 1024 * 1024;

  var inFlight = new Map();    // rel -> Promise<url>   (dedupe concurrent asks)
  var known = new Map();       // rel -> true/false     (thumb exists / not worth one)
  var active = 0;
  var queue = [];

  function stateDb() {
    var db = global.MemoStateDb;
    return (db && typeof db.ready === 'function' && db.ready()) ? db : null;
  }

  // Callers hand us whatever the DOM had — '/uploads/x.png', 'uploads/x.png',
  // sometimes with a ?query. The store keys on the bare rel path, so normalise
  // exactly the way it does or every lookup silently misses and we fall back to
  // the full-size image (which is the whole thing we're trying to avoid).
  function normalizeRel(rel) {
    var db = stateDb();
    if (db && typeof db.urlToRel === 'function') {
      try {
        var mapped = db.urlToRel(rel);
        if (mapped) return mapped;
      } catch (_e) { /* fall through */ }
    }
    return String(rel || '').split('?')[0].split('#')[0].replace(/^\/+/, '');
  }

  // Derived, collision-free key beside the original: uploads/a/b.png -> thumbs/uploads_a_b.png.jpg
  function thumbRel(rel) {
    return 'thumbs/' + normalizeRel(rel).replace(/[^a-z0-9._-]+/gi, '_') + '.jpg';
  }

  function acquire() {
    if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
    return new Promise(function (resolve) { queue.push(resolve); });
  }
  function release() {
    active--;
    var next = queue.shift();
    if (next) { active++; next(); }
  }

  // Canvas downscale -> JPEG blob. Ported from ImageDB's resizeBlob, minus its
  // import-pipeline specifics; same safety limits and timeout.
  function resizeBlob(blob, maxPx, quality) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var src = URL.createObjectURL(blob);
      var settled = false;
      var timer = setTimeout(function () { finish(null, new Error('thumbnail decode timed out')); }, DECODE_TIMEOUT_MS);
      function finish(value, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        if (error) img.src = '';
        URL.revokeObjectURL(src);
        if (error) reject(error); else resolve(value);
      }
      img.onload = function () {
        var w0 = img.naturalWidth || img.width;
        var h0 = img.naturalHeight || img.height;
        if (!w0 || !h0 || w0 > MAX_DECODE_EDGE || h0 > MAX_DECODE_EDGE || (w0 * h0) > MAX_DECODE_PIXELS) {
          finish(null, new Error('image exceeds the decode safety limit'));
          return;
        }
        // Already small enough to be its own thumbnail.
        if (Math.max(w0, h0) <= maxPx) { finish(null, null); return; }
        var scale = maxPx / Math.max(w0, h0);
        var w = Math.max(1, Math.round(w0 * scale));
        var h = Math.max(1, Math.round(h0 * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        if (!ctx) { finish(null, new Error('canvas unavailable')); return; }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (out) { finish(out, out ? null : new Error('thumbnail encoding failed')); },
          'image/jpeg', quality);
      };
      img.onerror = function () { finish(null, new Error('unable to decode image')); };
      img.src = src;
    });
  }

  function isThumbnailable(blob) {
    var type = (blob && blob.type) || '';
    // SVG scales for free; GIF would lose animation but a thumb is static anyway.
    return type.indexOf('image/') === 0 && type !== 'image/svg+xml';
  }

  async function build(rel) {
    var db = stateDb();
    if (!db) return null;
    var key = thumbRel(rel);

    // Already generated on a previous run?
    try {
      var cached = await db.readBlob(key);
      if (cached) { known.set(rel, true); return db.blobUrl(key); }
    } catch (_e) { /* fall through and generate */ }

    var source = null;
    try { source = await db.readBlob(rel); } catch (_e) { return null; }
    if (!source) return null;
    if (!isThumbnailable(source)) { known.set(rel, false); return null; }

    await acquire();
    try {
      var thumb = await resizeBlob(source, THUMB_MAX_PX, THUMB_QUALITY);
      if (!thumb) { known.set(rel, false); return null; }   // source already small
      await db.writeBlob(key, thumb);
      known.set(rel, true);
      return db.blobUrl(key);
    } catch (_e) {
      known.set(rel, false);      // don't retry a source that can't be decoded
      return null;
    } finally {
      release();
    }
  }

  var MemoThumbs = {
    THUMB_MAX_PX: THUMB_MAX_PX,
    thumbRel: thumbRel,

    /**
     * Blob URL of the cached thumbnail for a stored image, generating it on
     * first use. Resolves null when a thumbnail isn't applicable (not an image,
     * already small, decode failed) — callers fall back to the full image.
     */
    urlFor: function (rel) {
      if (!rel || !stateDb()) return Promise.resolve(null);
      var key = normalizeRel(rel);
      if (!key) return Promise.resolve(null);
      if (known.get(key) === false) return Promise.resolve(null);
      var pending = inFlight.get(key);
      if (pending) return pending;
      var job = build(key).catch(function () { return null; }).then(function (url) {
        inFlight.delete(key);
        return url;
      });
      inFlight.set(key, job);
      return job;
    },

    /** Forget a cached thumbnail (call when its source blob is replaced/removed). */
    drop: async function (rel) {
      var key = normalizeRel(rel);
      known.delete(key);
      inFlight.delete(key);
      var db = stateDb();
      if (!db || typeof db.deleteBlob !== 'function') return;
      try { await db.deleteBlob(thumbRel(key)); } catch (_e) { /* nothing cached */ }
    },
  };

  global.MemoThumbs = MemoThumbs;
})(typeof window !== 'undefined' ? window : this);
