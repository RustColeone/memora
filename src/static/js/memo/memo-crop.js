// memo-crop.js — Crop & Share tool + shared page-export helpers.
//
// Opened from the reader's ••• menu ("Crop & share"). Drag a selection on the
// current page, Apply to zoom in, Undo to step back, then Save (download) /
// Copy (clipboard) / Share (navigator.share) the result. Also exports reusable
// srcToBlob / copyBlob / saveBlob / shareBlob so the reader's "Copy/Save/Share
// page" actions share the same clipboard + download + Web-Share plumbing.
// Ported from ImageDB's crop tool, pared to static PNG output.
(function (global) {
  'use strict';
  var CROP_MIN = 10;
  var src = '', orig = null, scale = 1;
  var sel = null, dragging = false, start = null;
  var history = [];   // [{x,y,w,h}] in original-image px; [0] = whole image

  function id(x) { return document.getElementById(x); }
  function canvas() { return id('cropCanvas'); }
  function status(msg, bad) { var s = id('cropStatus'); if (s) { s.textContent = msg || ''; s.style.color = bad ? 'var(--danger)' : 'var(--muted)'; } }

  // ── shared export helpers (also used by the reader page-actions) ──
  function srcToBlob(url) {
    return new Promise(function (res, rej) {
      var img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function () {
        var c = document.createElement('canvas'); c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
        c.getContext('2d').drawImage(img, 0, 0);
        c.toBlob(function (b) { b ? res(b) : rej(new Error('encode failed')); }, 'image/png');
      };
      img.onerror = function () { rej(new Error('image load failed')); };
      img.src = url;
    });
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read image')); };
      reader.readAsDataURL(blob);
    });
  }
  async function copyBlob(blob) {
    var nativeClipboard = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.ClipboardImage;
    // Android WebView's browser clipboard path does not reliably preserve image
    // pixels. Prefer the FileProvider-backed native bridge when it is available.
    if (nativeClipboard && typeof nativeClipboard.copyImage === 'function') {
      await nativeClipboard.copyImage({ base64: await blobToBase64(blob), mime: blob.type || 'image/png' });
      return;
    }
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) throw new Error('Clipboard not supported');
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
  }
  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var ext = blob.type === 'image/jpeg' ? '.jpg' : (blob.type === 'image/webp' ? '.webp' : '.png');
    var a = document.createElement('a'); a.href = url; a.download = (name || 'image') + ext;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function sanitizeName(name) {
    return (String(name || 'image').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)) || 'image';
  }
  // Save into the phone's gallery (Photos) on native via the GallerySave plugin;
  // Browser downloads cannot confirm completion. Native errors propagate so
  // editors keep recovery rather than claiming that a fallback download saved.
  async function saveToPhone(blob, name) {
    var mime = (blob && blob.type) || 'image/png';
    var ext = mime.indexOf('/') > 0 ? mime.split('/')[1].split('+')[0] : 'png';
    var fileName = sanitizeName(name) + '.' + (ext === 'jpeg' ? 'jpg' : ext);
    var plugin = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.GallerySave;
    if (plugin && typeof plugin.save === 'function') {
      const start = performance.now();
      const base64 = await blobToBase64(blob);
      const encoded = performance.now();
      await plugin.save({ base64, mime: mime, fileName: fileName });
      global.MemoGalleryTimings = { base64Ms: encoded - start, nativeMs: performance.now() - encoded, bytes: blob.size };
      return 'gallery';
    }
    saveBlob(blob, name);
    return 'download';
  }
  async function shareBlob(blob, name) {
    var file = new File([blob], (name || 'image') + '.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file] });
    } else { saveBlob(blob, name); } // no Web Share → fall back to download
  }

  // ── crop view ──
  function loadView(rect) {
    var c = canvas(); if (!c) return;
    var maxW = Math.min(660, window.innerWidth * 0.9);
    var maxH = Math.min(460, window.innerHeight * 0.6);
    scale = Math.min(maxW / rect.w, maxH / rect.h, 1);
    c.width = Math.max(1, Math.round(rect.w * scale));
    c.height = Math.max(1, Math.round(rect.h * scale));
    sel = null; draw(); updateUndo();
  }
  function draw() {
    var c = canvas(); if (!c || !orig) return;
    var view = history[history.length - 1];
    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(orig, view.x, view.y, view.w, view.h, 0, 0, c.width, c.height);
    if (!sel || sel.w < 1 || sel.h < 1) return;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(orig, view.x + sel.x / scale, view.y + sel.y / scale, sel.w / scale, sel.h / scale, sel.x, sel.y, sel.w, sel.h);
    ctx.strokeStyle = 'rgba(224,164,88,.95)'; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
    ctx.strokeRect(sel.x + 1, sel.y + 1, sel.w - 2, sel.h - 2); ctx.setLineDash([]);
  }
  function updateUndo() { var u = id('cropUndoBtn'); if (u) u.disabled = history.length <= 1; }
  function pt(e) {
    var c = canvas(), r = c.getBoundingClientRect();
    return { x: Math.max(0, Math.min(c.width, e.clientX - r.left)), y: Math.max(0, Math.min(c.height, e.clientY - r.top)) };
  }
  function exportRect() {
    var view = history[history.length - 1];
    if (sel && sel.w >= CROP_MIN && sel.h >= CROP_MIN) {
      return { x: view.x + sel.x / scale, y: view.y + sel.y / scale, w: sel.w / scale, h: sel.h / scale };
    }
    if (history.length > 1) return view; // zoomed view, no fresh selection
    return null;
  }
  function croppedBlob() {
    var rect = exportRect();
    if (!rect) return Promise.resolve(null);
    var oc = document.createElement('canvas'); oc.width = Math.round(rect.w); oc.height = Math.round(rect.h);
    oc.getContext('2d').drawImage(orig, rect.x, rect.y, rect.w, rect.h, 0, 0, oc.width, oc.height);
    return new Promise(function (r) { oc.toBlob(function (b) { r(b); }, 'image/png'); });
  }

  // ── open / actions ──
  function open(imageSrc, title) {
    src = imageSrc; history = []; sel = null;
    status('');
    var img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = function () {
      orig = img;
      history = [{ x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }];
      loadView(history[0]);
      var dlg = id('cropDlg'); if (dlg && !dlg.open) dlg.showModal();
    };
    img.onerror = function () { status('Could not load the image.', true); };
    img.src = imageSrc;
    open._title = (title || 'crop').replace(/[^a-z0-9_\- ]/gi, '_').slice(0, 50) || 'crop';
  }
  function apply() {
    var rect = exportRect();
    if (!rect) { status('Drag a selection first.'); return; }
    history.push(rect); loadView(rect); status('');
  }
  function undo() { if (history.length > 1) { history.pop(); loadView(history[history.length - 1]); } }

  async function doCopy() { try { var b = await croppedBlob(); if (!b) return status('Drag a selection first.'); await copyBlob(b); status('Copied to clipboard.'); } catch (e) { status('Copy failed: ' + (e.message || e), true); } }
  async function doSave() { try { var b = await croppedBlob(); if (!b) return status('Drag a selection first.'); saveBlob(b, open._title + '_crop'); status('Saved.'); } catch (e) { status('Save failed: ' + (e.message || e), true); } }
  async function doShare() { try { var b = await croppedBlob(); if (!b) return status('Drag a selection first.'); await shareBlob(b, open._title + '_crop'); } catch (e) { if (e.name !== 'AbortError') status('Share failed: ' + (e.message || e), true); } }
  function close() { var dlg = id('cropDlg'); if (dlg && dlg.open) dlg.close(); }

  function wire() {
    var c = canvas(); if (!c) return;
    c.addEventListener('pointerdown', function (e) { e.preventDefault(); dragging = true; sel = null; start = pt(e); try { c.setPointerCapture(e.pointerId); } catch (_e) {} });
    c.addEventListener('pointermove', function (e) {
      if (!dragging) return; var cur = pt(e);
      sel = { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) };
      draw();
    });
    c.addEventListener('pointerup', function () { dragging = false; if (sel && (sel.w < CROP_MIN || sel.h < CROP_MIN)) { sel = null; draw(); } });
    clickWire('cropApplyBtn', apply);
    clickWire('cropUndoBtn', undo);
    clickWire('cropCopyBtn', doCopy);
    clickWire('cropSaveBtn', doSave);
    clickWire('cropShareBtn', doShare);
    clickWire('cropCloseBtn', close);
  }
  function clickWire(x, fn) { var e = id(x); if (e) e.addEventListener('click', fn); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoCrop = { open: open, close: close, srcToBlob: srcToBlob, copyBlob: copyBlob, saveBlob: saveBlob, saveToPhone: saveToPhone, shareBlob: shareBlob };
})(window);
