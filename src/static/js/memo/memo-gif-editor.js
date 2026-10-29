// memo-gif-editor.js — non-destructive editor for an imported animated GIF.
// Decodes frames with locally vendored gifuct-js, composites every patch into a
// full canvas, then re-encodes selected/cropped frames through existing gifenc.
(function (global) {
  'use strict';

  var sourceUrl = '';
  var sourceName = 'animation';
  var sourceUrlOwned = false;
  var frames = [];               // [{ rgba: Uint8ClampedArray, delay }], full logical-screen frames
  var width = 0, height = 0;
  var crop = null;               // source-coordinate crop {x,y,w,h}
  var previewIndex = 0, previewTimer = 0, previewRgba = null;
  var dragging = false, dragStart = null, dragCrop = null;
  var decoderPromise = null, encoderPromise = null;
  var decodeGeneration = 0;
  var pendingDecode = null;

  // Decoding keeps both gifuct's patches and one full RGBA logical-screen copy
  // per frame. Bound the compressed source and the estimated peak working set so
  // a valid-but-huge GIF cannot exhaust an Android WebView before the editor opens.
  var MAX_GIF_SOURCE_BYTES = 64 * 1024 * 1024;
  var MAX_GIF_LOGICAL_PIXELS = 16000000;
  var MAX_GIF_FRAMES = 600;
  var MAX_GIF_WORKING_BYTES = 256 * 1024 * 1024;

  function el(id) { return document.getElementById(id); }
  function dlg() { return el('gifEditorDlg'); }
  function canvas() { return el('gifEditorCanvas'); }
  function canSaveAsEntry() { return global.MEMO_VARIANT !== 'planner' && typeof global.openEntryModal === 'function' && !!(global.MemoCore && typeof global.MemoCore.addImages === 'function'); }
  function syncSaveAction() { var button = el('gifEditorSaveEntryBtn'); if (button) button.hidden = !canSaveAsEntry(); }
  function staticBase() { return global.STATIC_BASE || '/static/'; }
  function status(message, bad) {
    var node = el('gifEditorStatus');
    if (!node) return;
    node.textContent = message || '';
    node.style.color = bad ? 'var(--danger)' : '';
  }
  function setMeta(message) { var node = el('gifEditorMeta'); if (node) node.textContent = message || ''; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function currentCrop() { return crop || { x: 0, y: 0, w: width, h: height }; }
  function previewCrop() { return dragCrop || crop; }
  function escName(name) { return String(name || 'animation').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'animation'; }
  function focusSoon(id) {
    requestAnimationFrame(function () {
      var node = el(id), dialog = dlg();
      if (!node || !dialog || !dialog.open || node.hidden || !node.isConnected) return;
      try { node.focus({ preventScroll: true }); } catch (_error) { try { node.focus(); } catch (_error2) {} }
    });
  }
  function tooLargeError() { return new Error('GIF is too large to edit safely on this device.'); }
  function cancelledError() {
    var error = new Error('GIF decoding was cancelled.');
    error.name = 'AbortError';
    return error;
  }
  function finiteProduct(a, b) {
    var product = Number(a) * Number(b);
    return Number.isFinite(product) && product >= 0 ? product : Infinity;
  }
  function revokeDecodeJob(job) {
    if (!job || job.revoked || !job.ownsUrl || !job.url) return;
    job.revoked = true;
    try { URL.revokeObjectURL(job.url); } catch (_error) {}
  }
  function cancelPendingDecode() {
    var job = pendingDecode;
    pendingDecode = null;
    if (!job) return;
    try { if (job.controller) job.controller.abort(); } catch (_error) {}
    revokeDecodeJob(job);
  }

  function loadScript(path, check, getPromise, setPromise) {
    if (global[check]) return Promise.resolve(global[check]);
    if (getPromise()) return getPromise();
    var promise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = path;
      script.onload = function () { global[check] ? resolve(global[check]) : reject(new Error(check + ' missing after load')); };
      script.onerror = function () { reject(new Error('Could not load ' + path)); };
      document.head.appendChild(script);
    });
    setPromise(promise);
    return promise;
  }
  function ensureDecoder() { return loadScript(staticBase() + 'vendor/gifuct.js', 'MemoGifDecoder', function () { return decoderPromise; }, function (promise) { decoderPromise = promise; }); }
  function ensureEncoder() { return loadScript(staticBase() + 'vendor/gifenc.js', 'gifenc', function () { return encoderPromise; }, function (promise) { encoderPromise = promise; }); }
  function getOptions() {
    var speed = parseFloat((el('gifEditorSpeed') || {}).value || '1') || 1;
    var step = parseInt((el('gifEditorFrameStep') || {}).value || '1', 10) || 1;
    var quality = parseInt((el('gifEditorQuality') || {}).value || '256', 10) || 256;
    var start = parseInt((el('gifEditorTrimStart') || {}).value || '1', 10) || 1;
    var end = parseInt((el('gifEditorTrimEnd') || {}).value || String(frames.length), 10) || frames.length;
    start = clamp(start, 1, Math.max(1, frames.length));
    end = clamp(end, start, Math.max(1, frames.length));
    return { speed: speed, step: step, quality: clamp(quality, 2, 256), start: start, end: end };
  }
  function syncControls() {
    var start = el('gifEditorTrimStart'), end = el('gifEditorTrimEnd');
    if (start) { start.min = '1'; start.max = String(Math.max(1, frames.length)); start.value = '1'; }
    if (end) { end.min = '1'; end.max = String(Math.max(1, frames.length)); end.value = String(Math.max(1, frames.length)); }
    var speed = el('gifEditorSpeed'), out = el('gifEditorSpeedOut');
    if (speed) speed.value = '1';
    if (out) out.textContent = '1×';
    var step = el('gifEditorFrameStep'); if (step) step.value = '1';
    var quality = el('gifEditorQuality'); if (quality) quality.value = '256';
  }
  function releaseSourceUrl() {
    if (sourceUrlOwned && sourceUrl) {
      try { URL.revokeObjectURL(sourceUrl); } catch (_e) {}
    }
    sourceUrlOwned = false;
  }
  function reset() {
    decodeGeneration += 1;
    cancelPendingDecode();
    stopPreview();
    releaseSourceUrl();
    sourceUrl = ''; sourceName = 'animation'; frames = []; width = 0; height = 0; crop = null;
    previewIndex = 0; previewRgba = null; dragging = false; dragStart = null; dragCrop = null;
  }
  function showSourcePage() {
    var library = el('gifEditorFromLibraryBtn');
    if (library) library.hidden = global.MEMO_VARIANT === 'planner' || !(global.MemoCore && global.MemoLibraryPicker);
    var source = el('gifEditorPage1'), editor = el('gifEditorPage2');
    if (source) source.classList.remove('hidden');
    if (editor) editor.classList.add('hidden');
    status('');
    setMeta('Select a GIF file to edit.');
  }
  function showEditorPage() {
    var source = el('gifEditorPage1'), editor = el('gifEditorPage2');
    if (source) source.classList.add('hidden');
    if (editor) editor.classList.remove('hidden');
  }
  function showDialog() {
    var dialog = dlg();
    if (dialog && (!dialog.open || dialog.classList.contains('closing'))) dialog.showModal();
  }
  function stopPreview() { if (previewTimer) { clearTimeout(previewTimer); previewTimer = 0; } }
  function drawRgba(rgba) {
    var c = canvas(); if (!c || !rgba) return;
    c.width = width; c.height = height;
    var ctx = c.getContext('2d');
    previewRgba = rgba;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    drawCropOverlay(ctx, rgba);
  }
  function drawFrame(index) {
    if (!frames.length) return;
    index = ((index % frames.length) + frames.length) % frames.length;
    drawRgba(frames[index].rgba);
  }
  function drawCropOverlay(ctx, rgba) {
    // A live drag must win over the saved crop, otherwise drawing a replacement
    // crop appears stuck on the previous frame until pointer-up.
    var rect = previewCrop();
    if (!rect || !ctx) return;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.52)';
    ctx.fillRect(0, 0, width, height);
    ctx.putImageData(new ImageData(rgba || previewRgba, width, height), 0, 0, rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = 'rgba(224,164,88,.98)'; ctx.lineWidth = Math.max(1, Math.round(Math.max(width, height) / 350));
    ctx.setLineDash([Math.max(4, Math.round(Math.max(width, height) / 80)), Math.max(2, Math.round(Math.max(width, height) / 120))]);
    ctx.strokeRect(rect.x + .5, rect.y + .5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1));
    ctx.restore();
  }
  function startPreview() {
    stopPreview();
    if (!frames.length) return;
    previewIndex = 0;
    var output = collectOutputFrames(), previewFrames = output.frames;
    if (!previewFrames.length) return;
    function tick() {
      var frame = previewFrames[previewIndex % previewFrames.length];
      drawRgba(frame.rgba);
      previewIndex = (previewIndex + 1) % previewFrames.length;
      previewTimer = setTimeout(tick, frame.delay);
    }
    tick();
  }
  function sourcePoint(event) {
    var c = canvas(), rect = c.getBoundingClientRect();
    if (!c || !rect.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: clamp(Math.round((event.clientX - rect.left) * (c.width / rect.width)), 0, c.width),
      y: clamp(Math.round((event.clientY - rect.top) * (c.height / rect.height)), 0, c.height)
    };
  }
  function normalizeRect(a, b) {
    var x = clamp(Math.min(a.x, b.x), 0, width), y = clamp(Math.min(a.y, b.y), 0, height);
    return { x: x, y: y, w: clamp(Math.abs(b.x - a.x), 0, width - x), h: clamp(Math.abs(b.y - a.y), 0, height - y) };
  }
  function collectOutputFrames() {
    var opts = getOptions(), selected = [];
    for (var index = opts.start - 1; index <= opts.end - 1; index++) {
      var frame = frames[index];
      var delay = Math.max(20, frame.delay || 100);
      if ((index - (opts.start - 1)) % opts.step !== 0) {
        if (selected.length) selected[selected.length - 1].delay += delay;
        continue;
      }
      selected.push({ rgba: frame.rgba, delay: delay });
    }
    selected.forEach(function (frame) { frame.delay = Math.max(20, Math.round(frame.delay / opts.speed)); });
    return { frames: selected, options: opts };
  }
  async function encode() {
    if (!frames.length || !width || !height) throw new Error('No GIF frames are loaded.');
    var gifenc = await ensureEncoder();
    var selected = collectOutputFrames(), rect = currentCrop();
    if (!selected.frames.length) throw new Error('Choose at least one frame.');
    var outW = Math.max(1, Math.round(rect.w)), outH = Math.max(1, Math.round(rect.h));
    var source = document.createElement('canvas'); source.width = width; source.height = height;
    var output = document.createElement('canvas'); output.width = outW; output.height = outH;
    var sctx = source.getContext('2d'), octx = output.getContext('2d');
    var encoder = gifenc.GIFEncoder();
    selected.frames.forEach(function (frame, index) {
      sctx.putImageData(new ImageData(frame.rgba, width, height), 0, 0);
      octx.clearRect(0, 0, outW, outH);
      octx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, outW, outH);
      var rgba = octx.getImageData(0, 0, outW, outH).data;
      var palette = gifenc.quantize(rgba, selected.options.quality);
      var pixels = gifenc.applyPalette(rgba, palette);
      encoder.writeFrame(pixels, outW, outH, { palette: palette, delay: Math.max(2, Math.round(frame.delay / 10)), repeat: index === 0 ? 0 : undefined });
    });
    encoder.finish();
    return new Blob([encoder.bytesView()], { type: 'image/gif' });
  }
  function downloadBlob(blob) {
    var url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = escName(sourceName) + '_edited.gif';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  async function download() {
    try { status('Rendering GIF…'); var blob = await encode(); downloadBlob(blob); status('Saved (' + Math.round(blob.size / 1024) + ' KB).'); }
    catch (error) { status('GIF export failed: ' + ((error && error.message) || error), true); }
  }
  async function share() {
    try {
      status('Rendering GIF…');
      var blob = await encode(), file = new File([blob], escName(sourceName) + '_edited.gif', { type: 'image/gif' });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) await navigator.share({ files: [file] });
      else downloadBlob(blob);
      status('');
    } catch (error) {
      if (error && error.name === 'AbortError') { status(''); return; }
      status('GIF share failed: ' + ((error && error.message) || error), true);
    }
  }
  async function saveAsEntry() {
    if (!canSaveAsEntry()) return;
    try {
      status('Rendering GIF…');
      var blob = await encode(), file = new File([blob], escName(sourceName) + '_edited.gif', { type: 'image/gif' });
      close();
      global.openEntryModal(null);
      global.MemoCore.addImages([file]);
    } catch (error) { status('GIF export failed: ' + ((error && error.message) || error), true); }
  }
  function close() {
    var dialog = dlg();
    // Clear decoded pixels and abort an in-flight fetch immediately; the native
    // close event may be delayed briefly by dialog exit animation.
    reset();
    if (dialog && dialog.open) dialog.close();
  }
  function inspectParsedBudget(parsed) {
    var lsd = (parsed && parsed.lsd) || {};
    var logicalWidth = Number(lsd.width) || 0;
    var logicalHeight = Number(lsd.height) || 0;
    var parsedFrames = ((parsed && parsed.frames) || []).filter(function (frame) { return !!(frame && frame.image); });
    var logicalPixels = finiteProduct(logicalWidth, logicalHeight);
    if (!logicalWidth || !logicalHeight || !parsedFrames.length) throw new Error('This GIF has no editable frames.');
    if (logicalPixels > MAX_GIF_LOGICAL_PIXELS || parsedFrames.length > MAX_GIF_FRAMES) throw tooLargeError();

    var patchPixels = 0;
    parsedFrames.forEach(function (frame) {
      var descriptor = frame.image && frame.image.descriptor;
      var area = finiteProduct(descriptor && descriptor.width, descriptor && descriptor.height);
      if (!area || area > MAX_GIF_LOGICAL_PIXELS) throw tooLargeError();
      patchPixels += area;
      if (!Number.isFinite(patchPixels)) throw tooLargeError();
    });
    // gifuct retains an index array and an RGBA patch for every frame while this
    // editor also creates full logical-screen RGBA snapshots. The multiplier is
    // deliberately conservative for ordinary JS number arrays used by LZW.
    var estimated = logicalPixels * 4 * (parsedFrames.length + 2) + patchPixels * 12;
    if (!Number.isFinite(estimated) || estimated > MAX_GIF_WORKING_BYTES) throw tooLargeError();
    return { width: logicalWidth, height: logicalHeight, frameCount: parsedFrames.length, logicalPixels: logicalPixels };
  }
  function inspectDecodedBudget(info, patches) {
    if (!Array.isArray(patches) || !patches.length || patches.length > MAX_GIF_FRAMES) throw new Error('This GIF has no editable frames.');
    var decodedBytes = info.logicalPixels * 4 * (patches.length + 2);
    patches.forEach(function (patch) {
      var dims = patch && patch.dims;
      var area = finiteProduct(dims && dims.width, dims && dims.height);
      if (!area || area > MAX_GIF_LOGICAL_PIXELS) throw tooLargeError();
      var rgbaBytes = patch.patch && Number.isFinite(patch.patch.byteLength) ? patch.patch.byteLength : area * 4;
      var pixelBytes = patch.pixels && Number.isFinite(patch.pixels.byteLength)
        ? patch.pixels.byteLength
        : ((patch.pixels && Number.isFinite(patch.pixels.length)) ? patch.pixels.length * 8 : area * 8);
      decodedBytes += rgbaBytes + pixelBytes;
      if (!Number.isFinite(decodedBytes) || decodedBytes > MAX_GIF_WORKING_BYTES) throw tooLargeError();
    });
  }
  async function decodePatches(fileOrUrl, generation) {
    if (fileOrUrl && typeof fileOrUrl !== 'string' && Number(fileOrUrl.size) > MAX_GIF_SOURCE_BYTES) throw tooLargeError();
    var ownsUrl = typeof fileOrUrl !== 'string';
    var url = ownsUrl ? URL.createObjectURL(fileOrUrl) : fileOrUrl;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var job = { generation: generation, url: url, ownsUrl: ownsUrl, controller: controller, revoked: false };
    pendingDecode = job;
    function assertCurrent() {
      if (generation !== decodeGeneration || pendingDecode !== job) throw cancelledError();
    }
    try {
      var response = await fetch(url, controller ? { signal: controller.signal } : undefined);
      assertCurrent();
      if (!response.ok) throw new Error('Could not read GIF.');
      var declaredSize = Number(response.headers && response.headers.get('content-length')) || 0;
      if (declaredSize > MAX_GIF_SOURCE_BYTES) throw tooLargeError();
      var buffer = await response.arrayBuffer();
      assertCurrent();
      if (buffer.byteLength > MAX_GIF_SOURCE_BYTES) throw tooLargeError();
      var decoder = await ensureDecoder();
      assertCurrent();
      var parsed = decoder.parseGIF(buffer);
      var info = inspectParsedBudget(parsed);
      assertCurrent();
      var patches = decoder.decompressFrames(parsed, true);
      inspectDecodedBudget(info, patches);
      assertCurrent();
      pendingDecode = null;
      return { url: url, ownsUrl: ownsUrl, patches: patches, width: info.width, height: info.height };
    } catch (error) {
      if (pendingDecode === job) pendingDecode = null;
      revokeDecodeJob(job);
      throw error;
    }
  }
  async function open(fileOrUrl, name) {
    // An explicit reset also covers callers that replace a GIF while the editor
    // is open, where its native close event has not run yet.
    reset();
    var generation = decodeGeneration;
    syncSaveAction();
    if (!fileOrUrl) {
      showSourcePage();
      showDialog();
      focusSoon('gifEditorFromDeviceBtn');
      return true;
    }
    showEditorPage();
    showDialog();
    focusSoon('gifEditorBackBtn');
    status('Decoding GIF…');
    try {
      var decoded = await decodePatches(fileOrUrl, generation);
      if (generation !== decodeGeneration) {
        if (decoded.ownsUrl) { try { URL.revokeObjectURL(decoded.url); } catch (_error) {} }
        return false;
      }
      sourceUrl = decoded.url; sourceUrlOwned = !!decoded.ownsUrl; sourceName = name || (fileOrUrl && fileOrUrl.name) || 'animation.gif';
      width = decoded.width; height = decoded.height;
      var nextFrames = [];
      var work = new Uint8ClampedArray(width * height * 4), restoreBeforePrevious = null;
      decoded.patches.forEach(function (patch) {
        // Disposal 3 restores the pixels that existed before this frame.
        if (restoreBeforePrevious) { work.set(restoreBeforePrevious); restoreBeforePrevious = null; }
        var before = patch.disposalType === 3 ? new Uint8ClampedArray(work) : null;
        var dims = patch.dims || { left: 0, top: 0, width: width, height: height };
        var pixels = patch.patch || new Uint8ClampedArray(dims.width * dims.height * 4);
        for (var y = 0; y < dims.height; y++) for (var x = 0; x < dims.width; x++) {
          var src = (y * dims.width + x) * 4, dx = dims.left + x, dy = dims.top + y;
          if (dx < 0 || dy < 0 || dx >= width || dy >= height || pixels[src + 3] === 0) continue;
          var dst = (dy * width + dx) * 4;
          work[dst] = pixels[src]; work[dst + 1] = pixels[src + 1]; work[dst + 2] = pixels[src + 2]; work[dst + 3] = pixels[src + 3];
        }
        nextFrames.push({ rgba: new Uint8ClampedArray(work), delay: Math.max(20, patch.delay || 100) });
        // Disposal 2 clears the image rectangle after this displayed frame.
        if (patch.disposalType === 2) for (var cy = 0; cy < dims.height; cy++) for (var cx = 0; cx < dims.width; cx++) {
          var clearX = dims.left + cx, clearY = dims.top + cy;
          if (clearX < 0 || clearY < 0 || clearX >= width || clearY >= height) continue;
          var clearAt = (clearY * width + clearX) * 4;
          work[clearAt] = work[clearAt + 1] = work[clearAt + 2] = work[clearAt + 3] = 0;
        }
        restoreBeforePrevious = before;
      });
      if (generation !== decodeGeneration) return false;
      frames = nextFrames;
      crop = null; syncControls();
      setMeta(frames.length + ' frames · ' + width + ' × ' + height + ' px');
      status(''); startPreview();
      return true;
    } catch (error) {
      if (generation !== decodeGeneration || (error && error.name === 'AbortError')) return false;
      status('Could not edit GIF: ' + ((error && error.message) || error), true);
      reset();
      throw error;
    }
  }
  function pickFromLibrary() {
    if (!global.MemoLibraryPicker || typeof global.MemoLibraryPicker.open !== 'function') {
      status('Library picker is unavailable.', true);
      return;
    }
    global.MemoLibraryPicker.open({
      mode: 'single', filter: 'gif', selection: 'image', title: 'Pick a GIF from your library',
      onDone: function (picked) {
        var item = Array.isArray(picked) ? picked[0] : picked;
        if (!item) return;
        var url = typeof item === 'string' ? item : (item.url || item.ref);
        if (!url) return;
        open(url, (item && item.name) || 'animation.gif').catch(function () {});
      },
      // Opening Safe at privacy level 2 deliberately closes every dialog while
      // authentication is shown. The picker restores itself; if the user then
      // cancels, restore this source page as well instead of silently losing the
      // tool they came from.
      onCancel: function () {
        if (!dlg() || dlg().open) return;
        showSourcePage();
        showDialog();
        focusSoon('gifEditorFromDeviceBtn');
      }
    });
  }
  function wire() {
    var libraryButton = el('gifEditorFromLibraryBtn');
    if (libraryButton) libraryButton.hidden = !(global.MemoCore && global.MemoLibraryPicker);
    bind('gifEditorSpeed', 'input', function () { var speed = el('gifEditorSpeed'), out = el('gifEditorSpeedOut'); if (out) out.textContent = (parseFloat(speed.value) || 1) + '×'; startPreview(); });
    bind('gifEditorFrameStep', 'change', function () { startPreview(); });
    bind('gifEditorTrimStart', 'change', normalizeTrim);
    bind('gifEditorTrimEnd', 'change', normalizeTrim);
    bind('gifEditorResetCropBtn', 'click', function () { crop = null; drawRgba(previewRgba); });
    bind('gifEditorDownloadBtn', 'click', download);
    bind('gifEditorShareBtn', 'click', share);
    bind('gifEditorSaveEntryBtn', 'click', saveAsEntry);
    bind('gifEditorFromDeviceBtn', 'click', function () {
      var input = el('gifEditorFileInput');
      if (input) { input.value = ''; input.click(); }
    });
    bind('gifEditorFromLibraryBtn', 'click', pickFromLibrary);
    bind('gifEditorBackBtn', 'click', function () { reset(); showSourcePage(); focusSoon('gifEditorFromDeviceBtn'); });
    bind('gifEditorCloseBtn', 'click', close);
    bind('gifEditorCloseBtn2', 'click', close);
    var fileInput = el('gifEditorFileInput');
    if (fileInput) fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (!/image\/gif/i.test(file.type || '') && !/\.gif$/i.test(file.name || '')) {
        status('Choose an animated GIF file.', true);
        return;
      }
      open(file, file.name).catch(function () {});
    });
    var c = canvas();
    if (c) {
      // Keyboard-accessible numeric crop bounds need a designed coordinate UX;
      // keep that as a follow-up rather than exposing ambiguous canvas keystrokes.
      c.addEventListener('pointerdown', function (event) { if (!frames.length) return; event.preventDefault(); dragging = true; dragStart = sourcePoint(event); dragCrop = null; try { c.setPointerCapture(event.pointerId); } catch (_e) {} });
      c.addEventListener('pointermove', function (event) { if (!dragging) return; dragCrop = normalizeRect(dragStart, sourcePoint(event)); drawRgba(previewRgba); });
      c.addEventListener('pointerup', function () { if (!dragging) return; dragging = false; if (dragCrop && dragCrop.w >= 2 && dragCrop.h >= 2) crop = dragCrop; dragCrop = null; drawRgba(previewRgba); });
    }
    var dialog = dlg(); if (dialog) dialog.addEventListener('close', function () { reset(); showSourcePage(); });
  }
  function normalizeTrim() {
    var opts = getOptions(), start = el('gifEditorTrimStart'), end = el('gifEditorTrimEnd');
    if (start) start.value = String(opts.start); if (end) end.value = String(opts.end);
    startPreview();
  }
  function bind(id, type, handler) { var node = el(id); if (node) node.addEventListener(type, handler); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoGifEditor = { open: open, close: close, encode: encode, __state: function () { return { frameCount: frames.length, width: width, height: height, crop: crop && Object.assign({}, crop), dragCrop: dragCrop && Object.assign({}, dragCrop), previewCrop: previewCrop() && Object.assign({}, previewCrop()), decodePending: !!pendingDecode, previewActive: !!previewTimer, generation: decodeGeneration }; } };
})(window);
