// memo-gif.js — "Create GIF" (animate an entry's images).
//
// Turns a multi-image entry into an animated GIF: pick a per-frame delay, loop
// on/off, a letterbox background colour and an output size cap. Frames are
// contain-fit onto a common canvas (so mixed aspect ratios line up), then
// encoded with gifenc (quantize → applyPalette → writeFrame). A live preview
// just cycles the source images; encoding happens only on export (Download GIF
// or Save as new entry, via the same MemoCore.addImages seam as Panel Images).
// gifenc is vendored (static/vendor/gifenc.js) and lazy-loaded on first use.
(function (global) {
  'use strict';
  var _urls = [];
  var DEFAULTS = { delay: 500, loop: true, bg: '#ffffff', maxDim: 480 };
  var _opts = Object.assign({}, DEFAULTS);
  var _previewTimer = 0, _previewIdx = 0;
  var _gifencPromise = null;

  function el(id) { return document.getElementById(id); }
  function loadImage(src) {
    return new Promise(function (res, rej) {
      var img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function () { res(img); };
      img.onerror = function () { rej(new Error('image load failed')); };
      img.src = src;
    });
  }
  function ensureGifenc() {
    if (global.gifenc) return Promise.resolve(global.gifenc);
    if (_gifencPromise) return _gifencPromise;
    _gifencPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = (global.STATIC_BASE || '/static/') + 'vendor/gifenc.js';
      s.onload = function () { global.gifenc ? res(global.gifenc) : rej(new Error('gifenc missing after load')); };
      s.onerror = function () { rej(new Error('gifenc failed to load')); };
      document.head.appendChild(s);
    });
    return _gifencPromise;
  }

  // Common output size: bounding box of all frames, capped to maxDim on the long edge.
  function outputSize(dims) {
    var w = Math.max.apply(null, dims.map(function (d) { return d.w; }));
    var h = Math.max.apply(null, dims.map(function (d) { return d.h; }));
    var longEdge = Math.max(w, h), cap = _opts.maxDim;
    if (longEdge > cap) { var s = cap / longEdge; w = Math.round(w * s); h = Math.round(h * s); }
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  async function encode() {
    if (_urls.length < 2) return null;
    var gifenc = await ensureGifenc();
    var GIFEncoder = gifenc.GIFEncoder, quantize = gifenc.quantize, applyPalette = gifenc.applyPalette;
    var imgs = await Promise.all(_urls.map(loadImage));
    var dims = imgs.map(function (im) { return { w: im.naturalWidth || 1, h: im.naturalHeight || 1 }; });
    var out = outputSize(dims);
    var tc = document.createElement('canvas'); tc.width = out.w; tc.height = out.h;
    var ctx = tc.getContext('2d');
    var enc = GIFEncoder();
    var centis = Math.max(2, Math.round(_opts.delay / 10)); // ms → centiseconds (min 20ms)

    for (var i = 0; i < imgs.length; i++) {
      ctx.fillStyle = _opts.bg; ctx.fillRect(0, 0, out.w, out.h);
      var s = Math.min(out.w / dims[i].w, out.h / dims[i].h);
      var w = Math.round(dims[i].w * s), h = Math.round(dims[i].h * s);
      ctx.drawImage(imgs[i], Math.round((out.w - w) / 2), Math.round((out.h - h) / 2), w, h);
      var rgba = ctx.getImageData(0, 0, out.w, out.h).data;
      var palette = quantize(rgba, 256);
      var index = applyPalette(rgba, palette);
      // The loop count (Netscape ext) is written from the first frame only.
      enc.writeFrame(index, out.w, out.h, { palette: palette, delay: centis, repeat: i === 0 ? (_opts.loop ? 0 : -1) : undefined });
    }
    enc.finish();
    return new Blob([enc.bytesView()], { type: 'image/gif' });
  }

  // ── live preview (cycles the source images; no encoding) ──
  function stopPreview() { if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = 0; } }
  function startPreview() {
    stopPreview();
    var img = el('gifPreview'); if (!img || _urls.length < 2) return;
    _previewIdx = 0;
    function tick() {
      img.src = _urls[_previewIdx % _urls.length];
      _previewIdx++;
      _previewTimer = setTimeout(tick, Math.max(60, _opts.delay));
    }
    tick();
  }

  function open(urls) {
    _urls = (urls || []).filter(Boolean);
    _opts = Object.assign({}, DEFAULTS);
    syncControls();
    var dlg = el('gifDlg'); if (dlg && !dlg.open) dlg.showModal();
    startPreview();
    setStatus('');
  }
  function close() { stopPreview(); var dlg = el('gifDlg'); if (dlg && dlg.open) dlg.close(); }

  function syncControls() {
    setVal('gifDelay', _opts.delay);
    setText('gifDelayOut', _opts.delay + 'ms');
    setChecked('gifLoop', _opts.loop);
    setVal('gifBg', _opts.bg);
    setVal('gifSize', String(_opts.maxDim));
  }
  function setVal(id, v) { var e = el(id); if (e) e.value = v; }
  function setChecked(id, v) { var e = el(id); if (e) e.checked = !!v; }
  function setText(id, v) { var e = el(id); if (e) e.textContent = v; }
  function setStatus(msg, bad) { var s = el('gifStatus'); if (s) { s.textContent = msg || ''; s.style.color = bad ? 'var(--danger)' : 'var(--muted)'; } }

  async function withBlob(fn, label) {
    setStatus('Rendering…');
    try { var blob = await encode(); if (!blob) return; await fn(blob); }
    catch (e) { setStatus('GIF export failed: ' + (e && e.message || e), true); }
  }
  function download() {
    return withBlob(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'animation_' + Date.now() + '.gif';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      setStatus('Saved (' + Math.round(blob.size / 1024) + ' KB).');
    });
  }
  function saveAsEntry() {
    return withBlob(function (blob) {
      var file = new File([blob], 'animation_' + Date.now() + '.gif', { type: 'image/gif' });
      close();
      if (global.openEntryModal) global.openEntryModal(null);
      if (global.MemoCore && global.MemoCore.addImages) global.MemoCore.addImages([file]);
    });
  }

  function wire() {
    if (!el('gifDlg')) return;
    onInput('gifDelay', function (v) { _opts.delay = parseInt(v, 10) || 500; setText('gifDelayOut', _opts.delay + 'ms'); startPreview(); });
    onChange('gifLoop', function (chk) { _opts.loop = chk; });
    onInput('gifBg', function (v) { _opts.bg = v; });
    onInput('gifSize', function (v) { _opts.maxDim = parseInt(v, 10) || 480; });
    click('gifDownloadBtn', download);
    click('gifSaveEntryBtn', saveAsEntry);
    click('gifCloseBtn', close);
    var dlg = el('gifDlg'); if (dlg) dlg.addEventListener('close', stopPreview);
  }
  function onInput(id, fn) { var e = el(id); if (e) e.addEventListener('input', function () { fn(e.value); }); }
  function onChange(id, fn) { var e = el(id); if (e) e.addEventListener('change', function () { fn(e.checked); }); }
  function click(id, fn) { var e = el(id); if (e) e.addEventListener('click', fn); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoGif = { open: open, close: close, encode: encode };
})(window);
