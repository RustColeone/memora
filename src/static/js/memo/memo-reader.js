// memo-reader.js — MemoReader: a thin adapter over the shared UniversalReader
// module (vendored into static/reader/ by build_tools/sync-reader.js from the
// sibling ../reader repo — same pattern as ImageDB).
//
// The adapter keeps the app-facing surface the old in-house reader exposed —
// MemoReader.open(entry, idx) / openDirect(srcs, idx) / close / goTo /
// handleBack — and translates the memo entry model into UniversalReader
// descriptors:
//   • one GROUPED descriptor per entry: its images followed by its PDF
//     attachments, rendered as one continuous page sequence with a divider
//     between documents (exactly the old buildPages() model);
//   • the whole filtered feed (MemoVariant.__lastFiltered) is passed as the
//     file list, so cross-entry swiping is UniversalReader's own file nav;
//   • per-entry reading-position memory is UniversalReader's, keyed on the
//     entry id we set on each descriptor.
//
// Blob-URL ownership: UniversalReader revokes every blob: URL it holds when a
// file leaves view, so it must never be handed the app's shared object URLs
// (card thumbnails use the same hydrated blob: URLs). Blob-backed images are
// therefore passed as urlFn parts that mint a FRESH copy per request.
//
// pdf.js: UniversalReader loads pdf.js itself (window.pdfjsLib → pdfLibSrc →
// CDN), but our vendored .mjs can be served with the wrong MIME (Flask on
// Windows / capacitor://), which breaks a plain dynamic import. Each PDF
// part's prepare() therefore pre-seeds window.pdfjsLib via MemoPdf.ensure()
// (the Blob-URL import workaround in memo-pdf.js) before the reader looks.
(function (global) {
  'use strict';
  var MODE_KEY = 'memoReaderMode';
  var ur = null;                                 // lazy UniversalReader singleton
  var session = { entries: null, srcs: null };   // what the open file list maps back to
  var openGeneration = 0;                        // invalidates pending initial-page anchors
  var ownsEntryContext = false;                  // reader, rather than an open detail dialog, is the active location

  function core() { return global.MemoCore; }
  function isImage(u) { return (core() && core().isImage) ? core().isImage(u) : /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(u || ''); }
  function readMode() { try { var m = localStorage.getItem(MODE_KEY); return (m === 'scroll' || m === 'ltr' || m === 'rtl') ? m : 'scroll'; } catch (_e) { return 'scroll'; } }
  function saveMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch (_e) {} }
  function staticBase() { return global.STATIC_BASE || '/static/'; }
  function appTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function entryImages(e) { return ((e && e.images) || []).filter(isImage); }
  function titleFor(e) { return (e && e.description) ? String(e.description).replace(/\s+/g, ' ').trim().slice(0, 80) : ''; }
  function isPdfAtt(a) { return !!(global.MemoPdf && global.MemoPdf.isPdf) ? global.MemoPdf.isPdf(a) : false; }
  function entryList() {
    try { var v = global.MemoVariant; if (v && typeof v.__lastFiltered === 'function') { var l = v.__lastFiltered(); if (Array.isArray(l)) return l; } } catch (_e) {}
    return [];
  }
  function detailEntryId() {
    var dialog = document.getElementById('detailDlg');
    return dialog && dialog.open && dialog.dataset && dialog.dataset.entryId
      ? String(dialog.dataset.entryId) : null;
  }
  function setEntryContext(id) {
    try {
      var c = core();
      if (c && typeof c.setActiveEntryFilter === 'function') c.setActiveEntryFilter(id);
    } catch (_e) {}
  }
  function readerEntryAt(index) {
    if (!session.entries || !session.entries.length) return null;
    var entry = session.entries[Math.max(0, Math.min(Number(index) || 0, session.entries.length - 1))];
    return entry && entry.id != null ? entry : null;
  }
  function beginEntryContext(entry) {
    if (!entry || entry.id == null) return;
    ownsEntryContext = true;
    setEntryContext(String(entry.id));
  }
  function releaseEntryContext() {
    if (!ownsEntryContext) return;
    ownsEntryContext = false;
    // A reader opened from a detail dialog is stacked above that dialog. When
    // it closes, the user is back inside the detail and that memo remains the
    // active location. A direct-thumbnail reader has no underlying detail, so
    // closing it returns to the feed and removes the contextual filter.
    setEntryContext(detailEntryId());
  }

  // ── descriptor construction ───────────────────────────────────────
  // A fresh object URL per request: the reader owns (and revokes) what it gets.
  function localStoredRel(src) {
    if (!src || typeof src !== 'string' || !/(^|\/)uploads\//.test(src)) return null;
    var mode = global.MemoContracts && typeof global.MemoContracts.getMode === 'function'
      ? global.MemoContracts.getMode() : global.MODE;
    if (mode === 'server') return null;
    var path = src;
    try { path = new URL(src, global.location.href).pathname; } catch (_e) {}
    path = String(path).split('?')[0].split('#')[0];
    var stateDb = global.MemoStateDb;
    return stateDb && typeof stateDb.urlToRel === 'function' ? stateDb.urlToRel(path) : path.replace(/^\//, '');
  }
  async function freshUrl(src) {
    try {
      var rel = localStoredRel(src);
      var stateDb = global.MemoStateDb;
      if (rel && stateDb && typeof stateDb.readBlob === 'function') {
        var stored = await stateDb.readBlob(rel);
        if (stored) return URL.createObjectURL(stored);
      }
      var r = await fetch(src); var b = await r.blob(); return URL.createObjectURL(b);
    }
    catch (_e) { return src; }
  }
  // All of an entry's images form ONE sub-document (one urlFn part), so the
  // reader draws its document divider only where a PDF attachment starts —
  // never between two images (the old pages model tagged all images doc:'img').
  function imagesPart(srcs) {
    return {
      pageCount: srcs.length, type: 'image/jpeg',
      urlFn: function (i) {
        var s = srcs[i];
        return /^blob:/.test(s) || localStoredRel(s) ? freshUrl(s) : Promise.resolve(s);
      },
    };
  }
  function pdfPart(att) {
    return {
      name: att.name || 'PDF', type: 'application/pdf',
      prepare: async function () {
        try { global.pdfjsLib = await global.MemoPdf.ensure(); } catch (_e) {}   // MIME-proof pdf.js preload
        var blob = await global.MemoPdf.blob(att);
        return blob ? { file: blob, type: 'application/pdf' } : null;
      },
    };
  }
  function pdfAtts(e) { return ((e && e.attachments) || []).filter(isPdfAtt); }
  function readable(e) { return entryImages(e).length > 0 || pdfAtts(e).length > 0; }
  function descFor(e) {
    var imgs = entryImages(e);
    var parts = imgs.length ? [imagesPart(imgs)] : [];
    pdfAtts(e).forEach(function (a) { parts.push(pdfPart(a)); });
    return { id: e.id, name: titleFor(e), parts: parts };
  }

  // ── page-actions menu (host-supplied; reader renders + dispatches) ─
  function pageName(ctx) {
    var base = ((ctx.file && ctx.file.name) || 'page').replace(/[^a-z0-9_\- ]/gi, '_').slice(0, 50);
    return base + '_p' + (ctx.pageIndex + 1);
  }
  function withBlob(ctx, fn) {
    ctx.getBlob().then(function (blob) { if (blob) return fn(blob); })
      .catch(function (e) { if (e && e.name !== 'AbortError') console.warn('[Reader] page action failed:', e); });
  }
  function panelSrcs() {
    if (session.srcs) return session.srcs;
    var e = session.entries && ur ? session.entries[ur._index] : null;
    return e ? entryImages(e) : [];
  }
  function pageMenu(ctx) {
    var mc = global.MemoCrop;
    var multi = !!(ur && ur._pages.length > 1);
    return [
      { title: 'This page' },
      { html: '<span class="svg-icon svg-icon-edit"></span> Edit image',
        when: function () { const e = session.entries && session.entries[ctx.fileIndex]; return !!global.MemoImageEditor && !!e && ctx.pageIndex < entryImages(e).length; },
        onClick: function () { const e = session.entries && session.entries[ctx.fileIndex]; const ref = e && entryImages(e)[ctx.pageIndex]; if (ref) global.MemoImageEditor.openEntry(e, e.images.indexOf(ref)); } },
      { html: '<span class="svg-icon svg-icon-sparkles"></span> Image tools',
        when: function () { const e = session.entries && session.entries[ctx.fileIndex]; return !!global.MemoTools && !!e && ctx.pageIndex < entryImages(e).length; },
        onClick: function () { const e = session.entries && session.entries[ctx.fileIndex]; const ref = e && entryImages(e)[ctx.pageIndex]; if (ref) global.MemoTools.open(e.id, e.images.indexOf(ref)); } },
      { html: '<span class="svg-icon svg-icon-copy"></span> Copy page', when: function () { return !!mc; }, onClick: function () { withBlob(ctx, function (b) { return mc.copyBlob(b); }); } },
      { html: '<span class="svg-icon svg-icon-save"></span> Save page', when: function () { return !!mc; }, onClick: function () { withBlob(ctx, async function (b) { var how = mc.saveToPhone ? await mc.saveToPhone(b, pageName(ctx)) : (mc.saveBlob(b, pageName(ctx)), 'download'); if (global.MemoShell) global.MemoShell.toast(how === 'gallery' ? 'Saved to your gallery' : 'Page downloaded', { kind: 'success' }); }); } },
      { html: '<span class="svg-icon svg-icon-share"></span> Share page', when: function () { return !!mc; }, onClick: function () { withBlob(ctx, function (b) { return mc.shareBlob(b, pageName(ctx)); }); } },
      {
        html: '<span class="svg-icon svg-icon-crop"></span> Crop &amp; share', when: function () { return !!mc; },
        onClick: function () {
          withBlob(ctx, function (b) {
            var u = URL.createObjectURL(b);
            mc.open(u, ctx.file && ctx.file.name);
            setTimeout(function () { try { URL.revokeObjectURL(u); } catch (_e) {} }, 30000);
          });
        },
      },
      { separator: true, when: function () { return multi; } },
      {
        html: '<span class="svg-icon svg-icon-image"></span> Export all to panel',
        when: function () { return multi && !!global.MemoPanel && panelSrcs().length > 0; },
        onClick: function () { global.MemoPanel.open(panelSrcs()); },
      },
    ];
  }

  // ── lazy UniversalReader singleton ────────────────────────────────
  function ensureUr() {
    if (ur) return ur;
    var UR = global.UniversalReader;
    if (!UR) { console.warn('[MemoReader] UniversalReader module not loaded'); return null; }
    var t = global.MemoI18n && global.MemoI18n.t;
    ur = new UR(document.body, {
      theme: appTheme(),
      mode: readMode(),
      keyboardControls: true,
      holdMenu: true,
      zoomEnabled: true,
      pdfLibSrc: staticBase() + 'vendor/pdf.min.mjs',   // fallback; prepare() pre-seeds window.pdfjsLib
      pageMenu: pageMenu,
      modeLabels: t ? { scroll: t('modeScroll'), ltr: t('modeLtr'), rtl: t('modeRtl') } : null,
    });
    ur.addEventListener('modechange', function (e) { saveMode(e.detail.mode); });
    ur.addEventListener('navigate', function (event) {
      if (!ownsEntryContext) return;
      var entry = readerEntryAt(event && event.detail ? event.detail.fileIndex : 0);
      if (entry) setEntryContext(String(entry.id));
    });
    // UniversalReader.close() emits its own close event, while privacy teardown
    // may close the native dialog directly. Listen to both and make cleanup
    // idempotent so either lifecycle clears/restores the context exactly once.
    ur.addEventListener('close', releaseEntryContext);
    ur._dlg.addEventListener('close', function () {
      // Ignore a queued close event from an older session if the reusable
      // dialog has already been opened again.
      if (!urOpen()) releaseEntryContext();
    });
    // Any deliberate reader interaction transfers position ownership away
    // from the initial-page anchor. A slow page above the viewport must not
    // pull the user back after they have already navigated elsewhere.
    var cancelInitialAnchor = function () { openGeneration++; };
    ur._dlg.addEventListener('pointerdown', cancelInitialAnchor, true);
    ur._dlg.addEventListener('wheel', cancelInitialAnchor, { capture: true, passive: true });
    ur._dlg.addEventListener('keydown', function (event) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].indexOf(event.key) >= 0) {
        cancelInitialAnchor();
      }
    }, true);
    ur._progress.addEventListener('input', function () {
      var generation = ++openGeneration;
      var requested = Math.max(0, (Number(ur._progress.value) || 1) - 1 + (ur._segStart || 0));
      // UniversalReader's own target listener runs later in this event
      // dispatch. Preserve the selected value explicitly because an already
      // queued scroll-indicator frame may rewrite `_idx` first.
      requestAnimationFrame(function () {
        if (ur && ur._mode === 'scroll') anchorPage(ur, requested, generation);
      });
    }, true);
    return ur;
  }
  function urOpen() { return !!(ur && ur.isOpen); }

  // UniversalReader lays continuous pages out lazily. If an image above the
  // requested page finishes loading after the first jump, its new height can
  // otherwise move the viewport back into page one. Re-anchor after each such
  // layout settles; the generation guard prevents an old open from touching a
  // newer reader session.
  function anchorPage(r, startIdx, generation) {
    var requested = Math.max(0, Math.floor(startIdx));
    function anchorWhenMounted() {
      if (generation !== openGeneration || !r.isOpen) return;
      if (!r._pages || !r._pages.length) {
        requestAnimationFrame(anchorWhenMounted);
        return;
      }
      requested = Math.min(requested, r._pages.length - 1);
      if (r._mode !== 'scroll') {
        r.goPage(requested);
        return;
      }
      var pages = Array.prototype.slice.call(r._scroll.querySelectorAll('.ur-strip img.ur-page'));
      if (pages.length <= requested) {
        requestAnimationFrame(anchorWhenMounted);
        return;
      }
      function anchor() {
        // Image `load` fires before the browser's scroll-anchoring adjustment
        // is necessarily committed. Reapply after layout and the following
        // paint so that adjustment cannot win one frame later.
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            if (generation === openGeneration && r.isOpen) r.goPage(requested);
          });
        });
      }
      // Include the requested page itself. Its first intrinsic height can make
      // browser scroll anchoring preserve a later visual node even when the
      // requested offset is zero.
      pages.slice(0, requested + 1).forEach(function (img) {
        if (img.complete && img.currentSrc) return;
        img.addEventListener('load', anchor, { once: true });
        img.addEventListener('error', anchor, { once: true });
      });
      anchor();
    }
    requestAnimationFrame(anchorWhenMounted);
  }

  function openAtPage(r, files, fileIndex, startIdx) {
    var generation = ++openGeneration;
    r.open(files, fileIndex);
    if (typeof startIdx !== 'number' || startIdx <= 0) return;
    anchorPage(r, startIdx, generation);
  }

  // ── public surface (same contract as the old in-house reader) ─────
  function open(entry, startIdx) {
    var r = ensureUr(); if (!r || !entry || !readable(entry)) return;
    // Cross-entry swiping walks the feed's filtered order, skipping entries
    // with nothing to show (the old reader refused to open those too).
    var list = entryList().filter(readable);
    var i = -1; for (var k = 0; k < list.length; k++) { if (list[k] && list[k].id === entry.id) { i = k; break; } }
    var entries = i >= 0 ? list : [entry];
    if (i < 0) i = 0;
    session = { entries: entries, srcs: null };
    beginEntryContext(entry);
    r.setOption('theme', appTheme());
    // A specific page was asked for (a thumbnail click) — beat the saved
    // position and keep it anchored while earlier lazy pages finish laying out.
    openAtPage(r, entries.map(descFor), i, startIdx);
  }
  function openDirect(srcs, startIdx) {
    var r = ensureUr(); if (!r) return;
    var imgs = (srcs || []).filter(isImage);
    if (!imgs.length) return;
    // A loose-media session is not a memo location. If it replaces an entry
    // reader in-place, first restore the underlying detail/feed context.
    releaseEntryContext();
    session = { entries: null, srcs: imgs };
    r.setOption('theme', appTheme());
    // One grouped doc of loose images; unique id so stale position memory never applies.
    openAtPage(r, [{ id: 'loose:' + Date.now(), name: '', parts: [imagesPart(imgs)] }], 0, startIdx);
  }
  function close() { openGeneration++; if (urOpen()) ur.close(); }
  function goTo(i) {
    // Explicit navigation transfers ownership away from a still-loading
    // initial-page anchor, so a late image load cannot pull the user back.
    var generation = ++openGeneration;
    if (!urOpen()) return;
    ur.goPage(i);
    if (ur._mode === 'scroll') anchorPage(ur, i, generation);
  }
  // Shared Android-back hook (memo-shell): reader-local state first, then close.
  function handleBack() {
    if (!urOpen()) return false;
    if (ur.isHoldMenuOpen) { ur.hideHoldMenu(); return true; }
    if (ur.isZoomed) { ur.resetZoom(); return true; }
    close();
    return true;
  }

  global.MemoReader = {
    open: open, openDirect: openDirect, close: close,
    goTo: goTo, handleBack: handleBack,
    // test/inspection helper
    __state: function () {
      if (!ur) return { opened: false, idx: 0, pageCount: 0, mode: readMode(), entryId: null };
      var fd = ur._files[ur._index];
      return { opened: urOpen(), idx: ur._idx, pageCount: ur._pages.length, mode: ur._mode, entryId: (fd && fd.id != null) ? fd.id : null };
    },
  };
})(window);
