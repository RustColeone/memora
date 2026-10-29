// memo-ocr-native.js — thin web wrapper around the native on-device OCR plugin
// (MemoOcr / ML Kit). Resolves any image reference to a downscaled base64 image
// and hands it to the plugin; returns the recognized text. No-op on the web build
// (available() is false), where server OCR remains the path.
'use strict';
(function (global) {
  function plugin() {
    try { return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.MemoOcr) || null; }
    catch (_e) { return null; }
  }
  function available() { return !!(plugin() && plugin().recognize); }

  // Resolve a stored ref (app-private path) to something an <img> can load.
  function loadable(ref) {
    if (/^(https?:|blob:|data:)/i.test(ref)) return Promise.resolve(ref);
    var sdb = global.MemoStateDb;
    if (sdb && typeof sdb.blobUrl === 'function') {
      return Promise.resolve(sdb.blobUrl(ref)).then(function (u) { return u || ref; }, function () { return ref; });
    }
    return Promise.resolve(ref);
  }

  // Downscale to <= maxDim on the long edge and encode as JPEG for the bridge.
  function toBase64(url, maxDim) {
    maxDim = maxDim || 1600;
    return new Promise(function (resolve, reject) {
      var img = new Image();
      try { img.crossOrigin = 'anonymous'; } catch (_e) {}
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { reject(new Error('Empty image')); return; }
        var scale = Math.min(1, maxDim / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        try {
          canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
          resolve(canvas.toDataURL('image/jpeg', 0.9));
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('Could not load image')); };
      img.src = url;
    });
  }

  // recognize(ref, { language | languages, maxDim, lines })
  //   -> { text, language, results, lines?: [{ text, left, top, right, bottom }] }
  async function recognize(ref, opts) {
    opts = opts || {};
    var p = plugin();
    if (!p || !p.recognize) throw new Error('On-device OCR is not available');
    var url = await loadable(ref);
    var imageBase64 = await toBase64(url, opts.maxDim);
    var langs = opts.languages || (opts.language && opts.language !== 'auto' ? [opts.language] : null);
    var payload = { imageBase64: imageBase64 };
    if (langs && langs.length) payload.languages = langs;
    if (opts.lines) payload.lines = true;   // also each line's position (receipts)
    return p.recognize(payload);
  }

  global.MemoOcrNative = { available: available, recognize: recognize };
})(window);
