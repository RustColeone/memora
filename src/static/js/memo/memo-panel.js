// memo-panel.js — arrange images and stitch them into one combined picture.
//
// The dialog is intentionally a two-step workflow. Page 1 owns an ordered list
// that can be filled from the device or MemoLibraryPicker; page 2 owns the
// layout controls, a live canvas preview, and the memo-specific export actions.
(function (global) {
  'use strict';

  var DEFAULTS = {
    direction: 'vertical',
    resize: true,
    gap: 8,
    gapColor: '#ffffff',
    border: 0,
    borderColor: '#ffffff'
  };
  var PREVIEW_MAX_WIDTH = 460;
  var PREVIEW_MAX_DIMENSION = 2048;
  var PREVIEW_MAX_PIXELS = 750000;
  var EXPORT_MAX_DIMENSION = 32767;
  // A dimension-only cap can still allocate a multi-hundred-megabyte canvas
  // (for example, two 10k square pages). Keep final output below a conservative
  // mobile-WebView pixel budget as well as the cross-browser dimension ceiling.
  var EXPORT_MAX_PIXELS = 32000000;

  var _items = [];
  var _opts = Object.assign({}, DEFAULTS);
  var _format = 'webp';
  var _nextItemId = 0;
  var _raf = 0;
  var _previewGeneration = 0;
  var _previewBusyGeneration = 0;
  var _sessionGeneration = 0;
  var _decodeSession = { id: 0, cache: new Map() };
  var _activeExports = new Set();
  var _wired = false;

  function el(id) { return document.getElementById(id); }
  function dialog() { return el('panelDlg'); }
  function isOpen() { var d = dialog(); return !!(d && d.open); }
  function clampInt(value, min, max) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) n = min;
    return Math.max(min, Math.min(max, n));
  }
  function toast(message, bad) {
    if (global.MemoShell && typeof global.MemoShell.toast === 'function') {
      global.MemoShell.toast(message, bad ? { kind: 'error' } : undefined);
    }
  }
  function focusSoon(target) {
    requestAnimationFrame(function () {
      var node = typeof target === 'function' ? target() : (typeof target === 'string' ? el(target) : target);
      if (!node || !isOpen() || node.hidden || !node.isConnected) return;
      try { node.focus({ preventScroll: true }); } catch (_error) { try { node.focus(); } catch (_error2) {} }
    });
  }
  function canSaveAsEntry() {
    return global.MEMO_VARIANT !== 'planner' && typeof global.openEntryModal === 'function'
      && !!(global.MemoCore && typeof global.MemoCore.addImages === 'function');
  }
  function syncSaveAction() {
    var button = el('panelSaveEntryBtn');
    if (button) {
      var available = canSaveAsEntry();
      button.hidden = !available;
      // .actions > button supplies an author-level display declaration, which
      // otherwise wins over the browser's default [hidden] rule on Planner.
      button.style.display = available ? '' : 'none';
    }
  }

  function previewHosts() {
    var hosts = [];
    var legacy = el('panelPreview');
    var canvas = el('panelCanvas');
    var wrap = canvas && canvas.closest ? canvas.closest('.panel-preview-wrap') : null;
    [legacy, wrap, canvas].forEach(function (node) {
      if (node && hosts.indexOf(node) < 0) hosts.push(node);
    });
    return hosts;
  }
  function syncBusyState() {
    var busy = !!_previewBusyGeneration || _activeExports.size > 0;
    previewHosts().forEach(function (host) {
      host.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
    ['panelSaveEntryBtn', 'panelDownloadBtn', 'panelShareBtn'].forEach(function (id) {
      var button = el(id);
      if (button) button.disabled = busy || _items.length < 2;
    });
  }

  function inferMime(source) {
    if (source && typeof source === 'object' && source.type) return source.type;
    var url = typeof source === 'string' ? source : ((source && (source.url || source.src)) || '');
    var data = /^data:([^;,]+)/i.exec(url);
    if (data) return data[1].toLowerCase();
    var ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url);
    var types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' };
    return (ext && types[ext[1].toLowerCase()]) || 'image/*';
  }
  function cleanLabel(value) {
    return String(value || '').replace(/[?#].*$/, '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  }
  function sourceLabel(source, index) {
    if (source && typeof source === 'object') {
      var named = source.label || source.name || (source.file && source.file.name);
      if (named) return cleanLabel(named) || ('Image ' + (index + 1));
      source = source.url || source.src || '';
    }
    if (typeof source === 'string' && !/^(?:blob:|data:)/i.test(source)) {
      var fromPath = cleanLabel(source);
      if (fromPath) return fromPath;
    }
    return 'Image ' + (index + 1);
  }
  function isImageBlob(value) {
    return typeof Blob !== 'undefined' && value instanceof Blob
      && (!value.type || value.type.indexOf('image/') === 0);
  }
  function makeItem(source, index) {
    var original = source;
    var ownedUrl = false;
    var url = '';
    var file = null;
    if (isImageBlob(source)) file = source;
    else if (source && typeof source === 'object') {
      if (isImageBlob(source.file)) file = source.file;
      else url = source.url || source.src || '';
    } else if (typeof source === 'string') url = source;
    if (file) {
      url = URL.createObjectURL(file);
      ownedUrl = true;
    }
    if (!url) return null;
    return {
      id: 'panel-' + (++_nextItemId),
      url: url,
      label: sourceLabel(original, index),
      mime: (original && original.mime) || inferMime(file || original),
      safe: !!(original && original.safe),
      entryId: original && original.entryId != null ? original.entryId : null,
      imageIndex: original && original.index != null ? original.index : null,
      storedPath: (original && original.storedPath) || null,
      sourceFile: file,
      ownedUrl: ownedUrl
    };
  }
  function sourceArray(sources) {
    if (sources == null) return [];
    if (typeof sources === 'string' || isImageBlob(sources)) return [sources];
    if (typeof sources.length === 'number') return Array.prototype.slice.call(sources);
    return [sources];
  }
  function revokeItem(item) {
    if (!item || !item.ownedUrl || !item.url) return;
    try { URL.revokeObjectURL(item.url); } catch (_e) {}
    item.ownedUrl = false;
  }
  function releaseItems() {
    _items.forEach(revokeItem);
    _items = [];
  }
  function addSources(sources) {
    var start = _items.length;
    sourceArray(sources).forEach(function (source, index) {
      var item = makeItem(source, start + index);
      if (item) _items.push(item);
    });
    renderList();
    return _items.length - start;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        if (!(img.naturalWidth || img.width) || !(img.naturalHeight || img.height)) {
          reject(new Error('Image has no renderable dimensions'));
          return;
        }
        resolve(img);
      };
      img.onerror = function () { reject(new Error('Image load failed')); };
      img.src = src;
    });
  }
  function loadSessionImage(session, src) {
    if (session.cache.has(src)) return session.cache.get(src);
    var pending = loadImage(src);
    session.cache.set(src, pending);
    pending.catch(function () {
      if (session.cache.get(src) === pending) session.cache.delete(src);
    });
    return pending;
  }

  // Build a combined canvas from a snapshot of the current ordered list.
  // Preview canvases have independent width, dimension, and pixel budgets so a
  // very tall panel remains safe to render inside a mobile WebView.
  async function buildCanvas(forPreview, shouldCancel) {
    var urls = _items.map(function (item) { return item.url; });
    var opts = Object.assign({}, _opts);
    var session = _decodeSession;
    if (urls.length < 2) return null;
    var imgs = await Promise.all(urls.map(function (src) { return loadSessionImage(session, src); }));
    if (shouldCancel && shouldCancel()) return null;

    var gap = clampInt(opts.gap, 0, 200);
    var border = clampInt(opts.border, 0, 200);
    var dimensions = imgs.map(function (img) {
      return { w: img.naturalWidth || img.width || 1, h: img.naturalHeight || img.height || 1 };
    });
    var scaled;
    var positions = [];
    var canvasW;
    var canvasH;
    var i;

    if (opts.direction === 'horizontal') {
      var maxH = Math.max.apply(null, dimensions.map(function (dim) { return dim.h; }));
      scaled = dimensions.map(function (dim) {
        return opts.resize ? { w: Math.round(dim.w * maxH / dim.h), h: maxH } : { w: dim.w, h: dim.h };
      });
      canvasH = Math.max.apply(null, scaled.map(function (dim) { return dim.h; }));
      canvasW = scaled.reduce(function (sum, dim) { return sum + dim.w; }, 0) + gap * (scaled.length - 1);
      var x = 0;
      for (i = 0; i < scaled.length; i += 1) {
        positions.push({ x: x, y: Math.round((canvasH - scaled[i].h) / 2), w: scaled[i].w, h: scaled[i].h });
        x += scaled[i].w + (i < scaled.length - 1 ? gap : 0);
      }
    } else {
      var maxW = Math.max.apply(null, dimensions.map(function (dim) { return dim.w; }));
      scaled = dimensions.map(function (dim) {
        return opts.resize ? { w: maxW, h: Math.round(dim.h * maxW / dim.w) } : { w: dim.w, h: dim.h };
      });
      canvasW = Math.max.apply(null, scaled.map(function (dim) { return dim.w; }));
      canvasH = scaled.reduce(function (sum, dim) { return sum + dim.h; }, 0) + gap * (scaled.length - 1);
      var y = 0;
      for (i = 0; i < scaled.length; i += 1) {
        positions.push({ x: Math.round((canvasW - scaled[i].w) / 2), y: y, w: scaled[i].w, h: scaled[i].h });
        y += scaled[i].h + (i < scaled.length - 1 ? gap : 0);
      }
    }

    var totalW = canvasW + border * 2;
    var totalH = canvasH + border * 2;
    var scale = 1;
    if (forPreview) {
      scale = Math.min(
        1,
        PREVIEW_MAX_WIDTH / Math.max(totalW, 1),
        PREVIEW_MAX_DIMENSION / Math.max(totalW, totalH, 1),
        Math.sqrt(PREVIEW_MAX_PIXELS / Math.max(totalW * totalH, 1))
      );
    } else {
      scale = Math.min(
        1,
        EXPORT_MAX_DIMENSION / Math.max(totalW, totalH, 1),
        Math.sqrt(EXPORT_MAX_PIXELS / Math.max(totalW * totalH, 1))
      );
    }

    var output = document.createElement('canvas');
    output.width = Math.max(1, Math.floor(totalW * scale));
    output.height = Math.max(1, Math.floor(totalH * scale));
    var ctx = output.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is unavailable');
    ctx.fillStyle = opts.borderColor;
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.fillStyle = opts.gapColor;
    ctx.fillRect(
      Math.round(border * scale),
      Math.round(border * scale),
      Math.round(canvasW * scale),
      Math.round(canvasH * scale)
    );
    for (i = 0; i < positions.length; i += 1) {
      var pos = positions[i];
      ctx.drawImage(
        imgs[i], 0, 0, dimensions[i].w, dimensions[i].h,
        Math.round((pos.x + border) * scale), Math.round((pos.y + border) * scale),
        Math.round(pos.w * scale), Math.round(pos.h * scale)
      );
    }
    return output;
  }

  function invalidatePreview() {
    _previewGeneration += 1;
    if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
    _previewBusyGeneration = 0;
    syncBusyState();
  }
  function previewError(message) {
    var canvas = el('panelCanvas');
    var wrap = canvas && canvas.closest ? canvas.closest('.panel-preview-wrap') : null;
    var legacy = el('panelPreview');
    // In the two-page markup panelPreview is also the canvas wrapper. Preserve
    // that canvas so a later option change can retry after a transient failure.
    if (legacy && !canvas) legacy.innerHTML = '<span class="muted">' + message + '</span>';
    if (canvas) canvas.hidden = true;
    if (wrap) {
      var status = wrap.querySelector('.panel-preview-status');
      if (!status) {
        status = document.createElement('span');
        status.className = 'muted panel-preview-status';
        wrap.appendChild(status);
      }
      status.textContent = message;
    }
  }
  function paintPreview(output) {
    var canvas = el('panelCanvas');
    var legacy = el('panelPreview');
    if (canvas) {
      var status = canvas.parentElement && canvas.parentElement.querySelector('.panel-preview-status');
      if (status) status.remove();
      canvas.hidden = false;
      canvas.width = output.width;
      canvas.height = output.height;
      var ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas rendering is unavailable');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(output, 0, 0);
      return;
    }
    if (legacy) {
      legacy.innerHTML = '';
      legacy.appendChild(output);
    }
  }
  function schedulePreview() {
    if (_raf) cancelAnimationFrame(_raf);
    var generation = ++_previewGeneration;
    var session = _decodeSession;
    _previewBusyGeneration = generation;
    syncBusyState();
    _raf = requestAnimationFrame(async function () {
      _raf = 0;
      function cancelled() {
        return generation !== _previewGeneration || session !== _decodeSession;
      }
      try {
        var output = await buildCanvas(true, cancelled);
        if (cancelled()) return;
        if (output) paintPreview(output);
      } catch (_error) {
        if (cancelled()) return;
        previewError('Preview unavailable');
      } finally {
        if (generation === _previewGeneration && _previewBusyGeneration === generation) {
          _previewBusyGeneration = 0;
          syncBusyState();
        }
      }
    });
  }

  function setPage(page) {
    var page1 = el('panelPage1');
    var page2 = el('panelPage2');
    if (!page1 || !page2) return;
    var first = page !== 2;
    page1.classList.toggle('hidden', !first);
    page2.classList.toggle('hidden', first);
    page1.hidden = !first;
    page2.hidden = first;
    if (first) invalidatePreview();
  }
  function onResultPage() {
    var page2 = el('panelPage2');
    return !!(page2 && !page2.hidden && !page2.classList.contains('hidden'));
  }

  function moveItem(from, to) {
    if (from < 0 || from >= _items.length) return;
    to = Math.max(0, Math.min(_items.length - 1, to));
    if (to === from) return;
    var item = _items.splice(from, 1)[0];
    _items.splice(to, 0, item);
    renderList();
    if (onResultPage()) schedulePreview();
  }
  function removeItem(index) {
    if (index < 0 || index >= _items.length) return;
    var removed = _items.splice(index, 1)[0];
    revokeItem(removed);
    if (removed && !_items.some(function (item) { return item.url === removed.url; })) {
      _decodeSession.cache.delete(removed.url);
    }
    renderList();
  }
  function initDrag(handle, index, card) {
    var pointerId = null;
    var startY = 0;
    var cardTop = 0;
    var dragging = false;

    handle.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      moveItem(index, index + (event.key === 'ArrowUp' ? -1 : 1));
      var moved = el('panelList') && el('panelList').querySelector('[data-panel-idx="' + (index + (event.key === 'ArrowUp' ? -1 : 1)) + '"] .panel-drag-handle');
      if (moved) moved.focus();
    });
    handle.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      pointerId = event.pointerId;
      startY = event.clientY;
      cardTop = card.getBoundingClientRect().top;
      dragging = false;
      try { handle.setPointerCapture(pointerId); } catch (_e) {}
    }, { passive: false });
    handle.addEventListener('pointermove', function (event) {
      if (event.pointerId !== pointerId) return;
      var dy = event.clientY - startY;
      if (!dragging && Math.abs(dy) > 6) { dragging = true; card.classList.add('dragging'); }
      if (!dragging) return;
      card.style.transform = 'translateY(' + dy + 'px)';
      card.style.zIndex = '10';
      var center = cardTop + dy + card.offsetHeight / 2;
      var list = el('panelList');
      if (!list) return;
      Array.prototype.forEach.call(list.querySelectorAll('.panel-card'), function (candidate) {
        if (candidate === card) return;
        var rect = candidate.getBoundingClientRect();
        candidate.classList.toggle('drag-over', center >= rect.top && center <= rect.bottom);
      });
    });
    function clearDrag() {
      var list = el('panelList');
      if (list) Array.prototype.forEach.call(list.querySelectorAll('.panel-card'), function (candidate) {
        candidate.classList.remove('drag-over', 'dragging');
        candidate.style.transform = '';
        candidate.style.zIndex = '';
      });
    }
    handle.addEventListener('pointerup', function (event) {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (!dragging) { clearDrag(); return; }
      var center = cardTop + (event.clientY - startY) + card.offsetHeight / 2;
      var list = el('panelList');
      var target = index;
      if (list) {
        var cards = Array.prototype.filter.call(list.querySelectorAll('.panel-card'), function (candidate) { return candidate !== card; });
        for (var i = 0; i < cards.length; i += 1) {
          var rect = cards[i].getBoundingClientRect();
          var candidateIndex = parseInt(cards[i].dataset.panelIdx, 10);
          if (center < rect.top + rect.height / 2) { target = candidateIndex; break; }
          target = candidateIndex + 1;
        }
      }
      clearDrag();
      var insertAt = target > index ? target - 1 : target;
      moveItem(index, insertAt);
    });
    handle.addEventListener('pointercancel', function () { pointerId = null; clearDrag(); });
  }

  function requestDeviceImages() {
    var input = el('panelFileInput');
    if (!input) return;
    input.value = '';
    input.click();
  }
  function restorableSource(item) {
    var source = {
      label: item.label,
      mime: item.mime,
      safe: item.safe,
      entryId: item.entryId,
      index: item.imageIndex,
      storedPath: item.storedPath
    };
    if (item.sourceFile) source.file = item.sourceFile;
    else source.url = item.url;
    return source;
  }
  function captureDraft() {
    return {
      sources: _items.map(restorableSource),
      options: Object.assign({}, _opts),
      format: _format
    };
  }
  function sourceStillViewable(source) {
    if (!source || source.entryId == null) return true;
    try {
      var core = global.MemoCore;
      var state = core && typeof core.getState === 'function' ? core.getState() : null;
      var entries = state && state.db && Array.isArray(state.db.entries) ? state.db.entries : [];
      var entry = entries.find(function (candidate) {
        return candidate && !candidate.deletedAt && String(candidate.id) === String(source.entryId);
      });
      if (!entry) return false;
      return !(global.MemoPrivacy && typeof global.MemoPrivacy.canViewEntry === 'function')
        || !!global.MemoPrivacy.canViewEntry(entry);
    } catch (_error) {
      // Provenance-bearing media fails closed when its privacy projection cannot
      // be proven. Device/direct items deliberately have no entryId and bypass it.
      return false;
    }
  }
  function showDialog() {
    var d = dialog();
    // memo-motion keeps a dialog in the top layer briefly while its close
    // animation runs. Calling showModal() during that interval cancels the
    // owned close timer; otherwise the stale close event can clear a session
    // that was opened immediately after the user changed tools.
    if (d && (!d.open || d.classList.contains('closing'))) {
      try { d.showModal(); } catch (_error) { d.setAttribute('open', ''); }
    }
  }
  function restoreDraft(draft, addedSources) {
    var sources = (draft && draft.sources ? draft.sources.slice() : [])
      .concat(sourceArray(addedSources))
      .filter(sourceStillViewable);
    startSession(sources);
    _opts = Object.assign({}, DEFAULTS, (draft && draft.options) || {});
    _format = draft && draft.format === 'png' ? 'png' : 'webp';
    syncControls();
    showDialog();
    focusSoon(function () {
      var list = el('panelList');
      return (list && list.querySelector('.panel-drag-handle, .panel-add-device')) || el('panelCombineBtn');
    });
  }
  function addFromLibrary() {
    if (!global.MemoLibraryPicker || typeof global.MemoLibraryPicker.open !== 'function') {
      toast('Library picker is unavailable right now.', true);
      return;
    }
    var session = _sessionGeneration;
    var draft = captureDraft();
    var received = false;
    function receive(sources) {
      if (received || sources == null) return;
      received = true;
      if (session === _sessionGeneration && isOpen()) addSources(sources);
      // Level-2 Safe switching intentionally closes every sensitive dialog.
      // MemoLibraryPicker preserves its own session across that teardown; rebuild
      // this parent draft (File objects included) when its callback later returns.
      else if (!isOpen()) restoreDraft(draft, sources);
    }
    function cancelled() {
      if (session !== _sessionGeneration && !isOpen()) restoreDraft(draft);
    }
    var result = global.MemoLibraryPicker.open({
      mode: 'multi',
      filter: 'image',
      min: 1,
      title: 'Add images from library',
      onDone: receive,
      onCancel: cancelled
    });
    if (result && typeof result.then === 'function') result.then(receive).catch(function () {});
  }
  function createActionButton(label, className, handler) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className || '';
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }
  function renderList() {
    var list = el('panelList');
    if (list) {
      if (global.MemoLazy && typeof global.MemoLazy.release === 'function') global.MemoLazy.release(list);
      list.innerHTML = '';
      _items.forEach(function (item, index) {
        var card = document.createElement('div');
        card.className = 'panel-card';
        card.dataset.panelId = item.id;
        card.dataset.panelIdx = String(index);

        var handle = document.createElement('div');
        handle.className = 'panel-drag-handle';
        handle.setAttribute('role', 'button');
        handle.tabIndex = 0;
        handle.setAttribute('aria-label', 'Reorder ' + item.label + '. Use the arrow keys or drag.');
        handle.title = 'Drag to reorder';
        handle.textContent = '⋮⋮';
        initDrag(handle, index, card);
        card.appendChild(handle);

        var thumbWrap = document.createElement('div');
        thumbWrap.className = 'panel-thumb-wrap';
        var thumb = document.createElement('img');
        thumb.className = 'panel-thumb lazy-img';
        thumb.setAttribute('data-src', global.MemoLazy && typeof global.MemoLazy.thumbUrl === 'function'
          ? global.MemoLazy.thumbUrl(item.url, 200) : item.url);
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumbWrap.appendChild(thumb);
        card.appendChild(thumbWrap);

        var label = document.createElement('span');
        label.className = 'panel-card-label';
        label.textContent = item.label;
        label.title = item.label;
        card.appendChild(label);

        var actions = document.createElement('div');
        actions.className = 'panel-card-btns';
        var remove = createActionButton('×', 'ghost', function () { removeItem(index); });
        remove.classList.add('panel-remove-btn');
        remove.setAttribute('aria-label', 'Remove ' + item.label);
        remove.title = 'Remove from panel';
        actions.appendChild(remove);
        card.appendChild(actions);
        list.appendChild(card);
      });

      var addCard = document.createElement('div');
      addCard.className = 'panel-add-card';
      var device = createActionButton('From Device', 'ghost panel-add-device', requestDeviceImages);
      var library = createActionButton('From Library', 'ghost panel-add-library', addFromLibrary);
      // Planner shares the export-only panel controller but deliberately does
      // not load MemoCore (and therefore has no memo library to browse).
      var libraryAvailable = global.MEMO_VARIANT !== 'planner' && !!(global.MemoCore && global.MemoLibraryPicker);
      library.hidden = !libraryAvailable;
      library.style.display = libraryAvailable ? '' : 'none';
      addCard.appendChild(device);
      addCard.appendChild(library);
      list.appendChild(addCard);
      if (global.MemoLazy && typeof global.MemoLazy.hydrate === 'function') global.MemoLazy.hydrate(list);
    }

    var count = el('panelItemCount');
    if (count) count.textContent = !_items.length ? 'No images yet' : (_items.length + ' image' + (_items.length === 1 ? '' : 's'));
    var combine = el('panelCombineBtn');
    if (combine) combine.disabled = _items.length < 2;
    syncBusyState();
  }

  function syncControls() {
    Array.prototype.forEach.call(document.querySelectorAll('.panel-dir-btn'), function (button) {
      var active = button.dataset.dir === _opts.direction;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.panel-fmt-btn'), function (button) {
      var active = button.dataset.fmt === _format;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
    setChecked('panelResizeToggle', _opts.resize);
    setValue('panelGapInput', _opts.gap);
    setValue('panelGapColor', _opts.gapColor);
    setValue('panelBorderInput', _opts.border);
    setValue('panelBorderColor', _opts.borderColor);

    // Transitional support for the original single-page controls. This is not
    // required by the new markup, but keeps buildCanvas callers source-compatible.
    setValue('panelDirection', _opts.direction);
    setChecked('panelResize', _opts.resize);
    setValue('panelGap', _opts.gap);
    setValue('panelBorder', _opts.border);
    var gapOut = el('panelGapOut');
    var borderOut = el('panelBorderOut');
    if (gapOut) gapOut.textContent = _opts.gap + 'px';
    if (borderOut) borderOut.textContent = _opts.border + 'px';
  }
  function setValue(id, value) { var node = el(id); if (node) node.value = value; }
  function setChecked(id, checked) { var node = el(id); if (node) node.checked = !!checked; }
  function resetOptionsPanel() {
    setOptionsExpanded(false);
  }
  function setOptionsExpanded(expanded) {
    var options = el('panelOpts');
    var toggle = el('panelOptsToggle');
    expanded = !!expanded;
    if (options) {
      options.classList.toggle('collapsed', !expanded);
      options.hidden = !expanded;
      options.setAttribute('aria-hidden', expanded ? 'false' : 'true');
      if (expanded) options.removeAttribute('inert');
      else options.setAttribute('inert', '');
    }
    if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function startSession(sources) {
    invalidatePreview();
    releaseItems();
    _sessionGeneration += 1;
    _decodeSession = { id: _sessionGeneration, cache: new Map() };
    _activeExports.clear();
    _opts = Object.assign({}, DEFAULTS);
    _format = 'webp';
    addSources(sources);
    syncControls();
    syncSaveAction();
    resetOptionsPanel();
    setPage(1);
  }
  function open(sources) {
    startSession(sources);
    showDialog();
    focusSoon(function () {
      var list = el('panelList');
      return (list && list.querySelector('.panel-drag-handle, .panel-add-device')) || el('panelCombineBtn');
    });
    // Legacy markup had no list/options pages and displayed its preview at once.
    if (!el('panelPage1') || !el('panelPage2')) schedulePreview();
  }
  function cleanupSession() {
    invalidatePreview();
    _sessionGeneration += 1;
    _decodeSession = { id: _sessionGeneration, cache: new Map() };
    _activeExports.clear();
    releaseItems();
    renderList();
    syncBusyState();
  }
  function close() {
    var d = dialog();
    if (d && d.open) {
      try { d.close(); } catch (_error) { d.removeAttribute('open'); cleanupSession(); }
    } else cleanupSession();
  }
  function combine() {
    if (_items.length < 2) return;
    setPage(2);
    syncControls();
    schedulePreview();
    focusSoon('panelOptsToggle');
  }
  function back() { setPage(1); focusSoon('panelCombineBtn'); }

  function encodeCanvas(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('Could not encode the combined image'));
        }, mime, quality);
      } catch (error) { reject(error); }
    });
  }
  async function toBlob() {
    var session = _decodeSession;
    var token = {};
    var format = _format === 'png' ? 'png' : 'webp';
    _activeExports.add(token);
    syncBusyState();
    try {
      var canvas = await buildCanvas(false, function () { return session !== _decodeSession; });
      if (!canvas || session !== _decodeSession) return null;
      var blob = await encodeCanvas(canvas, 'image/' + format, format === 'webp' ? 0.9 : undefined);
      return session === _decodeSession ? blob : null;
    } finally {
      _activeExports.delete(token);
      syncBusyState();
    }
  }
  function outputName() { return 'panel_' + Date.now() + '.' + (_format === 'png' ? 'png' : 'webp'); }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  async function download() {
    try {
      var blob = await toBlob();
      if (blob) downloadBlob(blob, outputName());
    } catch (error) { toast('Could not export the combined image: ' + ((error && error.message) || error), true); }
  }
  async function share() {
    try {
      var blob = await toBlob();
      if (!blob) return;
      var file = new File([blob], outputName(), { type: blob.type || ('image/' + _format) });
      if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share({ files: [file] });
      } else {
        downloadBlob(blob, file.name);
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      toast('Could not share the combined image: ' + ((error && error.message) || error), true);
    }
  }
  async function saveAsEntry() {
    if (!canSaveAsEntry()) return;
    try {
      var blob = await toBlob();
      if (!blob) return;
      var file = new File([blob], outputName(), { type: blob.type || ('image/' + _format) });
      close();
      global.openEntryModal(null);
      global.MemoCore.addImages([file]);
    } catch (error) { toast('Could not save the combined image: ' + ((error && error.message) || error), true); }
  }

  function bind(id, type, handler) {
    var node = el(id);
    if (node) node.addEventListener(type, handler);
  }
  function wireRadioKeys(selector) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (button) {
      button.addEventListener('keydown', function (event) {
        var key = event.key;
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return;
        var group = button.closest && button.closest('[role="radiogroup"]');
        if (!group) return;
        var buttons = Array.prototype.slice.call(group.querySelectorAll(selector));
        var index = buttons.indexOf(button);
        if (index < 0 || buttons.length < 2) return;
        event.preventDefault();
        if (key === 'Home') index = 0;
        else if (key === 'End') index = buttons.length - 1;
        else index = (index + ((key === 'ArrowLeft' || key === 'ArrowUp') ? -1 : 1) + buttons.length) % buttons.length;
        buttons[index].focus();
        buttons[index].click();
      });
    });
  }
  function wire() {
    if (_wired || !dialog()) return;
    _wired = true;
    bind('panelCombineBtn', 'click', combine);
    bind('panelBackBtn', 'click', back);
    bind('closePanelBtn', 'click', close);
    bind('closePanelBtn2', 'click', close);
    bind('panelCloseBtn', 'click', close);
    bind('panelDownloadBtn', 'click', download);
    bind('panelSaveEntryBtn', 'click', saveAsEntry);
    bind('panelShareBtn', 'click', share);
    bind('panelFileInput', 'change', function (event) {
      var input = event.currentTarget;
      var files = Array.prototype.filter.call(input.files || [], function (file) {
        return !file.type || file.type.indexOf('image/') === 0;
      });
      addSources(files);
      input.value = '';
    });
    bind('panelOptsToggle', 'click', function () {
      var toggle = el('panelOptsToggle');
      if (!toggle) return;
      setOptionsExpanded(toggle.getAttribute('aria-expanded') !== 'true');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.panel-dir-btn'), function (button) {
      button.addEventListener('click', function () {
        _opts.direction = button.dataset.dir === 'horizontal' ? 'horizontal' : 'vertical';
        syncControls();
        schedulePreview();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.panel-fmt-btn'), function (button) {
      button.addEventListener('click', function () {
        _format = button.dataset.fmt === 'png' ? 'png' : 'webp';
        syncControls();
      });
    });
    wireRadioKeys('.panel-dir-btn');
    wireRadioKeys('.panel-fmt-btn');
    bind('panelResizeToggle', 'change', function (event) { _opts.resize = event.currentTarget.checked; schedulePreview(); });
    bind('panelGapInput', 'input', function (event) { _opts.gap = clampInt(event.currentTarget.value, 0, 200); schedulePreview(); });
    bind('panelGapColor', 'input', function (event) { _opts.gapColor = event.currentTarget.value || DEFAULTS.gapColor; schedulePreview(); });
    bind('panelBorderInput', 'input', function (event) { _opts.border = clampInt(event.currentTarget.value, 0, 200); schedulePreview(); });
    bind('panelBorderColor', 'input', function (event) { _opts.borderColor = event.currentTarget.value || DEFAULTS.borderColor; schedulePreview(); });

    // Compatibility listeners for callers/tests still hosted by the former
    // single-page markup. They disappear naturally with that markup.
    bind('panelDirection', 'input', function (event) { _opts.direction = event.currentTarget.value === 'horizontal' ? 'horizontal' : 'vertical'; schedulePreview(); });
    bind('panelResize', 'change', function (event) { _opts.resize = event.currentTarget.checked; schedulePreview(); });
    bind('panelGap', 'input', function (event) { _opts.gap = clampInt(event.currentTarget.value, 0, 200); syncControls(); schedulePreview(); });
    bind('panelBorder', 'input', function (event) { _opts.border = clampInt(event.currentTarget.value, 0, 200); syncControls(); schedulePreview(); });

    dialog().addEventListener('close', cleanupSession);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoPanel = {
    open: open,
    close: close,
    buildCanvas: buildCanvas,
    add: addSources,
    toBlob: toBlob,
    __state: function () {
      return {
        items: _items.map(function (item) { return { id: item.id, url: item.url, label: item.label, mime: item.mime, safe: item.safe }; }),
        options: Object.assign({}, _opts),
        format: _format,
        page: onResultPage() ? 2 : 1
      };
    }
  };
})(window);
