/**
 * UniversalReader — standalone scroll/page reader module.
 * No external runtime dependencies (pdf.js loaded lazily if needed).
 * ES module; also works as a classic <script> (exposes window.UniversalReader).
 *
 * Faithful port of ImageDB's battle-tested reader (v1.3.14):
 *   Scroll mode  — continuous webtoon strip + a 3-cell horizontal canvas that
 *                  swipes between whole files (prev | current | next), each side
 *                  cell fully rendered & lazy-loaded, committed by DOM rotation
 *                  (no rebuild, no flash), with per-file scroll-position memory.
 *   Paged modes  — L→R / R→L 3-cell carousel dragged with the finger, edge-zone
 *                  tap paging, double-tap / pinch zoom anchored on the focal point.
 *   Chrome       — top/bottom bars hidden (immersive) until a centre tap toggles
 *                  them; tap the black padding (scroll mode) closes the reader.
 *   Per page     — press-and-hold pops a contextual menu near the finger to
 *                  copy / save / share the current page.
 *
 * A "file" is one descriptor. Multi-page files expose pages lazily; see
 * _normalizeFiles for the accepted descriptor shapes.
 */

'use strict';

// ── Utilities ────────────────────────────────────────────────────────────────
const _esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const _ext = name => (String(name).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

const _mime = name => ({
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
  gif:'image/gif', webp:'image/webp', avif:'image/avif',
  pdf:'application/pdf',
}[_ext(name)] || '');

function _isImage(type) { return /^image\//.test(type); }
function _isPdf(type)   { return type === 'application/pdf'; }
function _range(n)  { return Array.from({ length: Math.max(0, n) }, (_, i) => i); }
function _range1(n) { return Array.from({ length: Math.max(0, n) }, (_, i) => i + 1); }

/** Natural sort: "page2" < "page10" */
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// ── PDF.js lazy loader ───────────────────────────────────────────────────────
// Resolution order: an already-present window.pdfjsLib → `pdfLibSrc` (a locally
// hosted build; ES-module `.mjs` is imported, a classic `.js` is script-tagged) →
// a CDN fallback. Offline/Capacitor apps MUST set `pdfLibSrc` (the CDN is a
// last-resort convenience for online demos and fails with no network).
let _pdfLib = null;
async function _loadScript(src) {
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
async function _ensurePdf(workerSrc, libSrc) {
  if (_pdfLib) return _pdfLib;
  if (window.pdfjsLib) {
    _pdfLib = window.pdfjsLib;
  } else if (libSrc) {
    if (/\.mjs(\?|$)/i.test(libSrc)) {
      const mod = await import(libSrc);                 // ES-module build (e.g. pdfjs-dist legacy .mjs)
      _pdfLib = (mod && mod.getDocument) ? mod : (window.pdfjsLib || mod);
    } else {
      await _loadScript(libSrc);                        // UMD build → window.pdfjsLib
      _pdfLib = window.pdfjsLib;
    }
  } else {
    await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    _pdfLib = window.pdfjsLib;
  }
  if (_pdfLib && workerSrc) { try { _pdfLib.GlobalWorkerOptions.workerSrc = workerSrc; } catch {} }
  return _pdfLib;
}

async function _pdfRenderPage(pdfDoc, pageNum, widthPx) {
  const page = await pdfDoc.getPage(pageNum);
  const vp0  = page.getViewport({ scale: 1 });
  const scale = widthPx / vp0.width;
  // Cap the device-pixel multiplier at 2: past that a phone can't resolve the extra
  // detail but the canvas (and its encode/decode) grows quadratically.
  const vp    = page.getViewport({ scale: scale * Math.min(2, window.devicePixelRatio || 1) });
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // WebP encodes ~40× faster than JPEG in the Android WebView (the JPEG encoder is the
  // dominant cost of opening a PDF page — dwarfing the ~30ms rasterisation) and yields
  // a smaller blob at equal quality.
  return new Promise(res => canvas.toBlob(b => res(b), 'image/webp', 0.85));
}

// ── Default options ───────────────────────────────────────────────────────────
const DEFAULTS = {
  theme:            'system',  // 'dark' | 'light' | 'system'
  backgroundColor:  '',        // '' = CSS-variable default
  pageSeparator:    0,         // px between pages in scroll mode
  keyboardControls: true,
  holdMenu:         true,
  mode:             'scroll',  // 'scroll' | 'ltr' | 'rtl'
  zoomEnabled:      true,
  pdfWorkerSrc:     '',
  pdfLibSrc:        '',        // local pdf.js build ('.mjs' imported / '.js' script-tagged); '' → CDN. Set for offline/Capacitor.
  pageMenu:         null,      // array | (ctx)=>array of page-action menu items (host-supplied)
  modeLabels:       null,      // { scroll, ltr, rtl } HTML labels for the orientation switch
  a11yLabels:       null,      // { back, actions, position, direction } plain-text labels
  dividers:         null,      // per-boundary divider config: { document?, page? }, each
                               //   false | <px> | { height, line } | (ctx)=>Node|null.
                               //   Unset → document boundaries get the default hairline,
                               //   page boundaries fall back to `pageSeparator`.
};

const HOLD_MS    = 500;
const ZOOM_MAX   = 5;
const ZOOM_TAP   = 2.6;
const BARS_DEFER = 300;  // ms a single tap waits before toggling bars (to spot a double-tap)
const DBL_MS     = 360;  // max gap between taps to count as a double-tap
const PAN_THRESHOLD = 10; // px a zoomed pan must clear before it starts (keeps taps tappable)

// ── UniversalReader ──────────────────────────────────────────────────────────
export class UniversalReader extends EventTarget {
  constructor(container, options = {}) {
    super();
    this._opts = { ...DEFAULTS, ...options };
    this._host = typeof container === 'string'
      ? document.querySelector(container) : container;
    this._mode = (this._opts.mode === 'ltr' || this._opts.mode === 'rtl') ? this._opts.mode : 'scroll';

    this._files   = [];
    this._index   = 0;      // current file index
    this._idx     = 0;      // current page index within the current file
    this._pages   = [];     // pages of the current file (indices or pdf page numbers)
    this._format  = null;   // 'image' | 'pdf' | 'urlFn' | 'group'
    this._pdfDoc  = null;
    this._groupParts = null; // for 'group' files: [{ fd, format, pdfDoc, pages, start }] resolved sub-documents
    this._urls    = new Map();  // page index → ObjectURL
    this._io      = null;

    this._zs      = 1;      // scroll-mode zoom scale
    this._z       = null;   // paged-mode zoom state
    this._cellW   = 0;
    this._seeking = false;

    this._canvas     = null;   // 3-cell canvas state
    this._committing = false;

    this._pos = new Map();  // file index → { idx, scrollTop } position memory
    this._segStart = 0;     // grouped file: global index of the active sub-document's first page

    // Gesture state
    this._PTRS       = new Map();
    this._G          = null;
    this._PINCH      = null;
    this._holdTimer  = null;
    this._tapTimer   = null;
    this._holdAt     = 0;
    this._holdX = 0; this._holdY = 0;
    this._ghostGuard = null; this._ghostGuardT = null;  // swallow the tap that ends a long-press
    this._lastUpT = 0; this._lastUpX = 0; this._lastUpY = 0;
    this._barsShown  = false;
    this._immersive  = false;
    this._keyHandler = null;

    this._buildDom();
    this._applyTheme();
    this._wireGestures();
  }

  // ── DOM construction ────────────────────────────────────────────────────────
  _buildDom() {
    const dlg = document.createElement('dialog');
    dlg.id = 'urDlg';
    dlg.setAttribute('aria-labelledby', 'urTitle');
    dlg.setAttribute('data-theme', this._opts.theme);
    dlg.innerHTML = `
      <div class="ur-scroll" id="urScroll"></div>
      <div class="ur-bars ur-top">
        <button class="ur-btn ur-back" id="urCloseBtn" title="Back" aria-label="Back">‹</button>
        <span class="ur-title" id="urTitle"></span>
        <button class="ur-btn" id="urActionsBtn" title="Page actions" aria-label="Page actions">···</button>
      </div>
      <div class="ur-bars ur-indicator">
        <input type="range" class="ur-progress" id="urProgress" min="1" max="1" value="1" aria-label="Reading position">
        <div class="ur-controls">
          <div class="ur-modes" id="urModes" role="radiogroup" aria-label="Reading direction">
            <button class="ur-mode" role="radio" data-mode="scroll"></button>
            <button class="ur-mode" role="radio" data-mode="ltr"></button>
            <button class="ur-mode" role="radio" data-mode="rtl"></button>
          </div>
          <span class="ur-page-label" id="urPageLabel"></span>
        </div>
      </div>
      <div class="ur-hold-menu" id="urHoldMenu" hidden>
        <img class="ur-hold-thumb" id="urHoldThumb" alt="" />
        <div class="ur-menu-items" id="urMenuItems"></div>
      </div>`;

    this._dlg = dlg;
    document.body.appendChild(dlg);

    this._scroll    = dlg.querySelector('#urScroll');
    this._title     = dlg.querySelector('#urTitle');
    this._progress  = dlg.querySelector('#urProgress');
    this._pageLabel = dlg.querySelector('#urPageLabel');
    this._modes     = dlg.querySelector('#urModes');
    this._holdMenu  = dlg.querySelector('#urHoldMenu');
    this._holdThumb = dlg.querySelector('#urHoldThumb');
    this._menuItems = dlg.querySelector('#urMenuItems');

    const al = this._opts.a11yLabels || {};
    dlg.querySelector('#urCloseBtn').setAttribute('aria-label', al.back || 'Back');
    dlg.querySelector('#urActionsBtn').setAttribute('aria-label', al.actions || 'Page actions');
    this._progress.setAttribute('aria-label', al.position || 'Reading position');
    this._modes.setAttribute('aria-label', al.direction || 'Reading direction');

    dlg.querySelector('#urCloseBtn').addEventListener('click', e => { e.stopPropagation(); this.close(); });
    dlg.querySelector('#urActionsBtn').addEventListener('click', e => {
      e.stopPropagation();
      // Opened from the top-right button → fixed placement (not the press-point logic).
      if (this._holdMenu.hidden) this._openMenu('button'); else this._hideHoldMenu();
    });

    // Read-orientation switch (scroll / L→R / R→L). Labels come from opts.modeLabels
    // so the host controls translation; they may contain trusted icon markup.
    const ml = this._opts.modeLabels || {};
    this._modes.querySelectorAll('.ur-mode').forEach(b => {
      b.innerHTML = ml[b.dataset.mode] || { scroll:'Scroll', ltr:'L→R', rtl:'R→L' }[b.dataset.mode];
      b.setAttribute('aria-label', b.textContent.trim());
      b.addEventListener('click', e => { e.stopPropagation(); this._setMode(b.dataset.mode); });
    });
    this._modes.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
      const buttons = [...this._modes.querySelectorAll('.ur-mode')];
      const current = buttons.indexOf(e.target.closest('.ur-mode'));
      if (current < 0) return;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
        : (current + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      e.preventDefault();
      e.stopPropagation();
      buttons[next].focus();
      this._setMode(buttons[next].dataset.mode);
    });
    this._syncModeButtons();

    // ESC / hardware-back → close (native <dialog> cancel)
    dlg.addEventListener('cancel', e => { e.preventDefault(); this.close(); });

    // Page scrubber: drag to jump; suppress the live write while dragging so the
    // scroll-driven indicator doesn't fight the thumb.
    // In a grouped file the scrubber tracks the ACTIVE sub-document (its own bar), so
    // its value is segment-local — map it back to a global page for the jump.
    this._progress.addEventListener('input',  () => {
      this._seeking = true;
      const v = (+this._progress.value) - 1;
      this._goToPage(this._format === 'group' ? this._segStart + v : v);
    });
    this._progress.addEventListener('change', () => { this._seeking = false; });
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  _applyTheme() {
    this._dlg.setAttribute('data-theme', this._opts.theme);
    this._scroll.style.background = this._opts.backgroundColor || '';
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  open(files, startIndex = 0) {
    this._PTRS.clear(); this._PINCH = null; this._G = null;   // start every session with a clean pointer map
    this._files = this._normalizeFiles(files);
    this._index = Math.max(0, Math.min(startIndex, this._files.length - 1));
    this._barsShown = false;
    this._dlg.classList.remove('bars-shown');
    if (!this._dlg.open) this._dlg.showModal();
    this._setImmersive(true);           // open immersive (chrome hidden)
    this._renderFile(this._index);
    this._dispatchEvent('open', { files: this._files, index: this._index });
  }

  close() {
    this._saveReaderPos();
    this._csTeardown();
    this._hardResetZoom();
    this._revokeAll();
    this._cancelHold();
    clearTimeout(this._tapTimer);
    this._PTRS.clear(); this._PINCH = null; this._G = null;   // never carry pointer/gesture state across sessions
    this._seeking = false;
    this._hideHoldMenu();
    this._unwireKeys();
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._pdfDoc) { try { this._pdfDoc.destroy(); } catch {} this._pdfDoc = null; }
    this._destroyGroupParts(this._groupParts); this._groupParts = null;
    this._setImmersive(false);          // restore system chrome on close
    if (this._dlg.open) this._dlg.close();
    this._scroll.innerHTML = '';
    this._dispatchEvent('close', {});
  }

  goFile(index, startAt) {
    const i = Math.max(0, Math.min(index, this._files.length - 1));
    this._renderFile(i, startAt);
  }
  nextFile() { this.goFile(this._index + 1); }
  prevFile() { this.goFile(this._index - 1); }
  goPage(page) { this._goToPage(page); }

  setOption(key, value) {
    this._opts[key] = value;
    if (key === 'theme' || key === 'backgroundColor') this._applyTheme();
    if (key === 'mode') {
      this._mode = (value === 'ltr' || value === 'rtl') ? value : 'scroll';
      this._syncModeButtons();
      if (this._dlg.open) this._renderFile(this._index);
    }
    if ((key === 'pageSeparator' || key === 'dividers') && this._dlg.open) this._renderFile(this._index);
    if (key === 'keyboardControls') { this._unwireKeys(); if (value && this._dlg.open) this._wireKeys(); }
  }

  // ── File normalization ──────────────────────────────────────────────────────
  // Accepted descriptor shapes:
  //   File | Blob                              → single image/pdf (type inferred)
  //   { file, name?, type? }                   → single image/pdf
  //   { url, name?, type? }                    → single image/pdf by URL
  //   { urlFn, pageCount, name?, type? }       → lazy multi-page (urlFn(i) → url)
  //   { prepare, name?, type? }                → prepare() resolves { pageCount, urlFn }
  //   { parts: [<any of the above>], name?, id? }
  //       → GROUPED: one swipe-unit spanning several sub-documents rendered in a
  //         single continuous scroll, with a divider between sub-documents. This is
  //         opt-in — omit `parts` and each descriptor stays its own swipe-unit, so
  //         existing (ImageDB) callers are unaffected.
  _normalizeFiles(input) {
    const arr = Array.isArray(input) ? input : [input];
    return arr.map(f => this._normalizeOne(f));
  }

  // Normalize one descriptor. A grouped descriptor recurses into its parts (parts
  // may not themselves be grouped — one level of nesting only).
  _normalizeOne(f) {
    if (f && Array.isArray(f.parts)) {
      const parts = f.parts.filter(p => p && !p.parts).map(p => this._normalizeOne(p));
      return { id: f.id, name: f.name || 'file', parts };
    }
    return this._normalizeSingle(f);
  }

  _normalizeSingle(f) {
    if (f instanceof File || f instanceof Blob) {
      const name = f.name || 'file';
      return { file: f, name, type: f.type || _mime(name) };
    }
    if (typeof f.prepare === 'function') {
      return { id: f.id, prepare: f.prepare, name: f.name || 'file', type: f.type || '', pageCount: f.pageCount || 0 };
    }
    if (typeof f.urlFn === 'function') {
      return { id: f.id, urlFn: f.urlFn, pageCount: f.pageCount || 1, name: f.name || 'file', type: f.type || 'image/jpeg' };
    }
    if (f.file instanceof Blob) {
      const name = f.name || f.file.name || 'file';
      // pageCount is carried through so a PDF part can declare it and be lazy-opened.
      return { id: f.id, file: f.file, name, type: f.type || f.file.type || _mime(name), pageCount: f.pageCount || 0 };
    }
    const name = f.name || String(f.url || '').split('/').pop() || 'file';
    return { id: f.id, url: f.url || '', name, type: f.type || _mime(name), pageCount: f.pageCount || 0 };
  }

  // Grouped-file helpers ───────────────────────────────────────────────────────
  _isGroup(fd) { return !!(fd && Array.isArray(fd.parts)); }

  // Global page index → the owning sub-document part and its local page index.
  _partAt(parts, i) {
    if (!parts) return null;
    for (const p of parts) { if (i >= p.start && i < p.start + p.pages.length) return { part: p, local: i - p.start }; }
    return null;
  }

  // The active sub-document of a grouped file (from the current global page), or null.
  _activeSegment() {
    if (this._format !== 'group' || !this._groupParts) return null;
    const at = this._partAt(this._groupParts, this._idx);
    if (!at) return null;
    return {
      index: this._groupParts.indexOf(at.part),
      count: this._groupParts.length,
      name: (at.part.fd && at.part.fd.name) || '',
      start: at.part.start,
      pageIndex: at.local,
      pageCount: at.part.pages.length,
    };
  }

  // ── Divider construction (configurable via opts.dividers) ────────────────────
  // Context passed to a divider callback so the host can render per-boundary.
  _boundaryCtx(kind, i, parts) {
    let before = null, after = null;
    if (parts) {
      after  = parts.find(p => p.start === i) || null;
      before = parts.find(p => p.start + p.pages.length === i) || null;
    }
    return {
      kind, index: i,
      beforeName: (before && before.fd && before.fd.name) || '',
      afterName:  (after  && after.fd  && after.fd.name)  || '',
      beforeSegment: before, afterSegment: after,
    };
  }

  _dividerEl(kind, height, line) {
    const d = document.createElement('div');
    d.className = (kind === 'document') ? 'ur-doc-divider' : 'ur-sep';
    if (height != null) d.style.height = height + 'px';
    if (kind === 'document' && line === false) d.classList.add('ur-doc-divider--plain');
    return d;
  }

  // Resolve the configured divider for a boundary → an element to insert, or null.
  //   false → none · number → sized · { height, line } → styled · fn(ctx) → host node.
  //   Unset: 'document' → default hairline; 'page' → the `pageSeparator` gap (or none).
  _makeDivider(kind, ctx) {
    const spec = this._opts.dividers ? this._opts.dividers[kind] : undefined;
    if (spec === false) return null;
    if (typeof spec === 'function') { const n = spec(ctx); return (n instanceof Node) ? n : null; }
    if (typeof spec === 'number')   return this._dividerEl(kind, spec, true);
    if (spec && typeof spec === 'object') return this._dividerEl(kind, spec.height, spec.line !== false);
    if (kind === 'document') return this._dividerEl('document', undefined, true);
    return this._opts.pageSeparator > 0 ? this._dividerEl('page', this._opts.pageSeparator, false) : null;
  }

  // The divider to place before page `i` (i>0): a 'document' boundary if `i` starts a
  // new sub-document of `parts`, else a 'page' boundary. Returns an element or null.
  _dividerFor(i, parts, starts) {
    const kind = starts.has(i) ? 'document' : 'page';
    return this._makeDivider(kind, this._boundaryCtx(kind, i, parts));
  }

  _segStarts(parts) {
    const s = new Set();
    if (parts) for (const p of parts) if (p.start > 0) s.add(p.start);
    return s;
  }

  // Resolve ONE descriptor into a flat page model { format, pdfDoc, pages }.
  //   image → 1 page · pdf → pdf.js doc · urlFn → lazy N pages.
  // This is the single source of format resolution, shared by the main render, a
  // canvas-cell load, and each grouped sub-document. `isValid()` (optional) is polled
  // across every await so a superseded caller (e.g. a cell reassigned mid-load) can
  // bail; on bail it returns null after reclaiming any half-loaded PDF. `noLib` marks
  // "pdf.js unavailable" so the caller can surface it.
  async _resolveModel(fd, isValid) {
    await this._ensurePrepared(fd);
    if (isValid && !isValid()) return null;
    if (fd.urlFn) {
      return { format: 'urlFn', pdfDoc: null, pages: _range(fd.pageCount || 1) };
    }
    if (_isPdf(fd.type)) {
      try {
        const lib = await _ensurePdf(this._opts.pdfWorkerSrc, this._opts.pdfLibSrc);
        if (isValid && !isValid()) return null;
        if (!lib) return { format: 'pdf', pdfDoc: null, pages: [1], noLib: true };
        const buf = fd.file ? await fd.file.arrayBuffer() : await (await fetch(fd.url)).arrayBuffer();
        if (isValid && !isValid()) return null;
        const doc = await lib.getDocument(buf).promise;
        if (isValid && !isValid()) { try { doc.destroy(); } catch {} return null; }
        return { format: 'pdf', pdfDoc: doc, pages: _range1(doc.numPages) };
      } catch (err) {
        console.error('UniversalReader: PDF load failed', err);
        return { format: 'pdf', pdfDoc: null, pages: [1] };
      }
    }
    return { format: 'image', pdfDoc: null, pages: [0] };
  }

  // Resolve every part of a grouped file into a flat, offset-tagged page model.
  // Aborts (returns null) if `isValid()` flips mid-flight, reclaiming parts already
  // loaded so a superseded grouped-cell load can't leak sub-document PDFs.
  //
  // Lazy per-segment preparation: a PDF part that DECLARES its `pageCount` reserves
  // that many strip slots without opening the document — the (expensive, memory-heavy)
  // `getDocument` + blob read are deferred to `_ensurePartDoc`, run only when one of
  // the part's pages is first requested. A PDF part with no declared count must be
  // opened here to learn `numPages` (today's eager behaviour). Image / urlFn parts are
  // already lazy per page.
  async _resolveGroupParts(parts, isValid) {
    const out = []; let start = 0;
    for (const part of parts) {
      if (part.pageCount > 0 && _isPdf(part.type)) {
        out.push({ fd: part, format: 'pdf', pdfDoc: null, pages: _range1(part.pageCount), start, lazy: true });
        start += part.pageCount;
        continue;
      }
      const m = await this._resolveModel(part, isValid);
      if (!m) { this._destroyGroupParts(out); return null; }
      out.push({ fd: part, format: m.format, pdfDoc: m.pdfDoc, pages: m.pages, start });
      start += m.pages.length;
    }
    return { parts: out, total: start };
  }

  // Open a lazy PDF part's document on first use, once. Concurrent page requests share
  // the one in-flight promise; a part destroyed mid-open reclaims the doc it produced.
  async _ensurePartDoc(part) {
    if (part.pdfDoc) return part.pdfDoc;
    if (part._dead) return null;
    if (!part._docPromise) {
      part._docPromise = (async () => {
        const fd = part.fd;
        await this._ensurePrepared(fd);
        const lib = await _ensurePdf(this._opts.pdfWorkerSrc, this._opts.pdfLibSrc);
        if (!lib) return null;
        const buf = fd.file ? await fd.file.arrayBuffer() : await (await fetch(fd.url)).arrayBuffer();
        const doc = await lib.getDocument(buf).promise;
        if (part._dead) { try { doc.destroy(); } catch {} return null; }
        part.pdfDoc = doc;
        return doc;
      })().catch(err => { console.error('UniversalReader: lazy PDF open failed', err); return null; });
    }
    return part._docPromise;
  }

  _destroyGroupParts(parts) {
    if (!parts) return;
    for (const p of parts) {
      p._dead = true;              // in-flight lazy opens will reclaim their doc
      if (p.pdfDoc && p.pdfDoc.destroy) { try { p.pdfDoc.destroy(); } catch {} }
      p.pdfDoc = null;
    }
  }

  // Stable position-memory key: descriptor id when supplied, else file index.
  _posKey(index) {
    const fd = this._files[index];
    return (fd && fd.id != null) ? ('id:' + fd.id) : ('i:' + index);
  }

  // Resolve a lazy descriptor (prepare) once, caching the result on the fd.
  async _ensurePrepared(fd) {
    if (!fd || fd._prepared || typeof fd.prepare !== 'function') return fd;
    try {
      const r = await fd.prepare();
      if (r) {
        if (r.urlFn) fd.urlFn = r.urlFn;
        if (r.file)  fd.file  = r.file;
        if (r.url)   fd.url   = r.url;
        if (r.pageCount) fd.pageCount = r.pageCount;
        if (r.type) fd.type = r.type;
        if (r.name && !fd.name) fd.name = r.name;
      }
    } catch {}
    fd._prepared = true;
    return fd;
  }

  // ── File rendering entry point ──────────────────────────────────────────────
  async _renderFile(index, startAt) {
    // Save the outgoing file's position before switching.
    if (this._files[this._index] && this._index !== index) this._saveReaderPos();
    this._index = index;
    const fd = this._files[index];
    if (!fd) return;

    if (!this._committing && this._canvas) this._csHide();
    this._revokeAll();
    this._cancelHold();
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._pdfDoc) { try { this._pdfDoc.destroy(); } catch {} this._pdfDoc = null; }
    this._destroyGroupParts(this._groupParts); this._groupParts = null;
    this._pdfDoc = null; this._pages = []; this._idx = 0;
    this._hardResetZoom();
    this._hideHoldMenu();

    await this._ensurePrepared(fd);
    this._title.textContent = fd.name || '';

    // Resolve this file's page model (a grouped file flattens its sub-documents;
    // everything else is one segment via the shared resolver).
    if (this._isGroup(fd)) {
      this._format = 'group';
      const g = await this._resolveGroupParts(fd.parts);
      this._groupParts = g.parts;
      this._pages = _range(Math.max(1, g.total));
    } else {
      const m = await this._resolveModel(fd);
      this._format = m.format; this._pdfDoc = m.pdfDoc; this._pages = m.pages;
      if (m.noLib) this._title.textContent = 'pdf.js not found';
    }

    // Restore saved page position for this file, else honour startAt.
    const saved = this._pos.get(this._posKey(index));
    this._idx = saved
      ? Math.max(0, Math.min(this._pages.length - 1, saved.idx))
      : startAt === 'last' ? Math.max(0, this._pages.length - 1)
      : (typeof startAt === 'number' ? Math.max(0, Math.min(this._pages.length - 1, startAt)) : 0);

    this._lastNavKey = null;          // force the post-render indicator to emit navigate
    await this._render();
    this._wireKeys();
    this._csReload();
  }

  _render() {
    this._hardResetZoom();
    return this._mode === 'scroll' ? this._renderScrollMode() : this._renderPagedMode();
  }

  // ── Shared page-URL resolver (main strip & canvas cells) ────────────────────
  // ctx: { fd, format, pages, pdfDoc, urls, widthEl }
  async _resolvePageUrl(ctx, i) {
    if (ctx.urls.has(i)) return ctx.urls.get(i);
    let out = '';
    try {
      if (ctx.format === 'group') {
        // Route the global page index to its sub-document, then resolve with that
        // part's own model (image / pdf / urlFn). Cached on the shared urls map by
        // global index, so each grouped page is produced at most once.
        const at = this._partAt(ctx.parts, i);
        if (at) {
          const p = at.part, li = at.local;
          if (p.format === 'urlFn') {
            out = (await p.fd.urlFn(li)) || '';
          } else if (p.format === 'pdf') {
            const doc = p.pdfDoc || await this._ensurePartDoc(p);   // lazy parts open here, once
            if (doc) {
              const w = (ctx.widthEl && ctx.widthEl.clientWidth) || 800;
              const blob = await _pdfRenderPage(doc, p.pages[li], w);
              out = blob ? URL.createObjectURL(blob) : '';
            }
          } else { // image
            out = p.fd.file ? URL.createObjectURL(p.fd.file) : (p.fd.url || '');
          }
        }
      } else if (ctx.format === 'urlFn') {
        out = (await ctx.fd.urlFn(i)) || '';
      } else if (ctx.format === 'pdf' && ctx.pdfDoc) {
        const w = (ctx.widthEl && ctx.widthEl.clientWidth) || 800;
        const blob = await _pdfRenderPage(ctx.pdfDoc, ctx.pages[i], w);
        out = blob ? URL.createObjectURL(blob) : '';
      } else { // image
        out = ctx.fd.file ? URL.createObjectURL(ctx.fd.file) : (ctx.fd.url || '');
      }
    } catch { out = ''; }
    if (out) ctx.urls.set(i, out);
    return out;
  }

  _mainCtx() {
    return { fd: this._files[this._index], format: this._format, pages: this._pages,
             pdfDoc: this._pdfDoc, urls: this._urls, widthEl: this._scroll, parts: this._groupParts };
  }
  _pageUrl(i) { return this._resolvePageUrl(this._mainCtx(), i); }

  async _currentPageBlob() {
    const i = this._idx;
    if (i < 0 || i >= this._pages.length) return null;
    try {
      if (this._format === 'pdf' && this._pdfDoc) {
        const w = this._scroll.clientWidth || 800;
        return await _pdfRenderPage(this._pdfDoc, this._pages[i], w);
      }
      const url = await this._pageUrl(i);
      if (!url) return null;
      const r = await fetch(url);
      return r.ok ? await r.blob() : null;
    } catch { return null; }
  }

  _revokeAll() {
    for (const u of this._urls.values()) { if (u && u.startsWith('blob:')) URL.revokeObjectURL(u); }
    this._urls.clear();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCROLL (continuous / webtoon) MODE
  // ══════════════════════════════════════════════════════════════════════════
  _clearScroll() {
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this._scroll.innerHTML = '';
  }

  async _renderScrollMode() {
    this._clearScroll();
    this._scroll.classList.remove('ur-paged');
    this._scroll.classList.add('ur-continuous');
    this._zs = 1;

    const strip = document.createElement('div');
    strip.className = 'ur-strip'; strip.id = 'urStrip';
    strip.classList.add('ur-center'); // centre short content; no-op for tall strips

    const starts = this._segStarts(this._groupParts);
    for (let i = 0; i < this._pages.length; i++) {
      if (i > 0) {
        const div = this._dividerFor(i, this._groupParts, starts);
        if (div) strip.appendChild(div);
      }
      const img = document.createElement('img');
      img.className = 'ur-page'; img.dataset.idx = i; img.alt = ''; img.draggable = false;
      strip.appendChild(img);
    }
    this._scroll.appendChild(strip);
    this._observeStrip(strip);
    // Entering immersive mode (system bars hide) relays the scroll container out on a
    // delay, so it can be 0-height when the first kicks fire. A ResizeObserver loads the
    // visible pages the moment the container actually gets its size — the reliable cure
    // for "reader stays black until you scroll/wait".
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this._loadVisibleScroll());
      this._ro.observe(this._scroll);
    }

    const imgs = strip.querySelectorAll('img.ur-page');
    const cur  = imgs[this._idx];
    if (cur) { cur.dataset.full = '1'; this._pageUrl(this._idx).then(u => this._setPageSrc(cur, u)); }

    // Snap to the starting page once laid out (scrollIntoView during open is unreliable).
    requestAnimationFrame(() => {
      const c = strip.querySelectorAll('img.ur-page')[this._idx];
      if (c) this._scroll.scrollTop = c.offsetTop;
      this._loadVisibleScroll();          // paint the first screen without waiting for a scroll
      this._updateScrollIndicator();
      this._csReload();
    });
    // Extra kicks in case layout settles between frames (belt-and-suspenders with the RO).
    setTimeout(() => this._loadVisibleScroll(), 260);
    setTimeout(() => this._loadVisibleScroll(), 700);
  }

  // Manually load the pages in / near the viewport. A root-scoped IntersectionObserver
  // is unreliable on a freshly-opened <dialog>: its FIRST callback can report every
  // page as non-intersecting until the user scrolls or resizes — which left the reader
  // black on open until a nudge. This kick makes the first screen paint immediately,
  // while the observer still handles everything from the first real scroll onward.
  _loadVisibleScroll() {
    if (this._mode !== 'scroll') return;
    const root = this._scroll.getBoundingClientRect();
    if (!root.height) return;
    const margin = 1400;
    this._scroll.querySelectorAll('img.ur-page:not([src])').forEach(img => {
      if (img.dataset.full) return;
      const r = img.getBoundingClientRect();
      if (r.bottom >= root.top - margin && r.top <= root.bottom + margin) {
        img.dataset.full = '1';
        const i = +img.dataset.idx;
        this._pageUrl(i).then(u => this._setPageSrc(img, u));
      }
    });
  }

  // Set a page image's src, then force its decode + a compositor commit. Some WebViews
  // (notably Samsung's after the immersive-mode surface resize) deprioritise decoding
  // and painting freshly-loaded content while the reader sits idle — so the page stays
  // blank until the user touches the screen. Explicitly requesting the decode and then
  // nudging paint makes the page appear on its own, promptly.
  _setPageSrc(img, url, container) {
    if (!url || !img || !img.isConnected) return;
    img.src = url;
    const el = container || (this._mode === 'scroll' ? this._scroll : null);
    const kick = () => this._kickPaint(el);
    if (img.decode) img.decode().then(kick, kick); else kick();
  }
  _kickPaint(el) {
    if (!el || el.__kickScheduled) return;
    el.__kickScheduled = true;
    requestAnimationFrame(() => {
      el.style.opacity = '0.999';
      requestAnimationFrame(() => { el.style.opacity = ''; el.__kickScheduled = false; });
    });
  }

  _observeStrip(strip) {
    this._io = new IntersectionObserver(ents => {
      for (const ent of ents) {
        if (!ent.isIntersecting || ent.target.dataset.full) continue;
        const i = +ent.target.dataset.idx;
        ent.target.dataset.full = '1';
        this._pageUrl(i).then(u => this._setPageSrc(ent.target, u));
      }
    }, { root: this._scroll, rootMargin: '1400px 0px' });
    strip.querySelectorAll('img.ur-page').forEach(img => {
      if (!img._indl) { img.addEventListener('load', () => { if (this._mode === 'scroll') this._updateScrollIndicator(); }); img._indl = true; }
      this._io.observe(img);
    });
  }

  _updateScrollIndicator() {
    if (this._mode !== 'scroll') return;
    const imgs = this._scroll.querySelectorAll('img.ur-page');
    if (!imgs.length) return;
    const y = this._scroll.scrollTop + 2;
    let cur = 0;
    for (let i = 0; i < imgs.length; i++) { if (imgs[i].offsetTop <= y) cur = i; else break; }
    if (this._scroll.scrollHeight > this._scroll.clientHeight + 4 &&
        this._scroll.scrollTop + this._scroll.clientHeight >= this._scroll.scrollHeight - 4) cur = imgs.length - 1;
    this._idx = cur;
    this._setIndicator();
  }

  _setIndicator() {
    const total = this._pages.length;
    const ft = this._files.length;
    // In a grouped file the scrubber + label track the ACTIVE sub-document — its own
    // progress bar, resetting as you scroll across a sub-document boundary — so a
    // continuous cross-entry scroll reads like the horizontal swipe's per-file bar.
    const seg = this._activeSegment();
    this._segStart = seg ? seg.start : 0;

    // Single-page files (a lone image / 1-page doc) have no use for a page scrubber
    // or an orientation switch — hide both, leaving just the position label. A group
    // keeps them (there's always somewhere to scroll to).
    this._dlg.classList.toggle('ur-single', total <= 1);
    const barTotal = seg ? seg.pageCount : total;
    const barIdx   = seg ? seg.pageIndex : this._idx;
    this._progress.max = Math.max(1, barTotal);
    if (!this._seeking) this._progress.value = barIdx + 1;

    if (seg) {
      const unit = `${seg.index + 1}/${seg.count}`;
      this._pageLabel.textContent = seg.pageCount > 1
        ? `${unit}  p.${seg.pageIndex + 1}/${seg.pageCount}`
        : unit;
    } else {
      const fi = this._index + 1;
      this._pageLabel.textContent = total > 1 ? `${fi}/${ft}  p.${this._idx + 1}/${total}` : `${fi} / ${ft}`;
    }

    // Emit navigate only when the position actually changes (not on every scroll frame).
    // Grouped files additionally carry segment (sub-document) fields.
    const key = seg
      ? `g${this._index}:${seg.index}:${seg.pageIndex}:${seg.pageCount}`
      : `${this._index}:${this._idx}:${total}`;
    if (key !== this._lastNavKey) {
      this._lastNavKey = key;
      const detail = { fileIndex: this._index, pageIndex: this._idx, totalPages: total, totalFiles: ft };
      if (seg) Object.assign(detail, {
        segmentIndex: seg.index, segmentCount: seg.count, segmentName: seg.name,
        segmentPageIndex: seg.pageIndex, segmentPageCount: seg.pageCount,
      });
      this._dispatchEvent('navigate', detail);
    }
  }

  _goToPage(idx) {
    idx = Math.max(0, Math.min(this._pages.length - 1, idx));
    this._hardResetZoom();
    if (this._mode === 'scroll') {
      this._idx = idx;
      const img = this._scroll.querySelector(`img.ur-page[data-idx="${idx}"]`);
      if (img) { if (!img.src) this._pageUrl(idx).then(u => { if (u) img.src = u; }); img.scrollIntoView({ block: 'start' }); }
      this._setIndicator();
    } else {
      this._buildPagedSlots(idx).then(() => this._pagedSetX(-this._cellW, false));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3-CELL HORIZONTAL CANVAS (scroll-mode inter-file swipe)
  // Layout left→right: [ prevCell = index-1 | current (urScroll) | nextCell = index+1 ]
  // Swipe RIGHT reveals prevCell (index-1); swipe LEFT reveals nextCell (index+1).
  // ══════════════════════════════════════════════════════════════════════════
  _csGetOrCreate() {
    if (this._canvas) return this._canvas;
    const W = this._dlg.clientWidth || window.innerWidth;
    const clip = document.createElement('div');
    clip.className = 'ur-canvas';
    clip.style.cssText = 'position:absolute;inset:0;z-index:2;overflow:hidden;pointer-events:none;';
    const track = document.createElement('div');
    track.style.cssText = `position:absolute;top:0;bottom:0;left:0;width:${3*W}px;display:flex;transform:translateX(${-W}px);`;
    const prevCell = document.createElement('div');
    const center = document.createElement('div');
    center.style.cssText = `width:${W}px;height:100%;flex:none;pointer-events:none;background:transparent;`;
    const nextCell = document.createElement('div');
    [prevCell, nextCell].forEach(c => {
      c.className = 'ur-canvas-cell';
      c.style.cssText = `width:${W}px;height:100%;flex:none;`;
      c._fi = -1; c._format = null; c._pages = []; c._pdfDoc = null; c._groupParts = null; c._urls = new Map(); c._io = null;
    });
    track.append(prevCell, center, nextCell);
    clip.appendChild(track);
    this._dlg.appendChild(clip);
    this._canvas = { clip, track, center, prevCell, nextCell, W };
    return this._canvas;
  }

  _csTeardown() {
    if (!this._canvas) return;
    this._csClearCell(this._canvas.prevCell);
    this._csClearCell(this._canvas.nextCell);
    this._canvas.clip.remove();
    this._canvas = null;
    this._committing = false;
  }

  _csHide() {
    if (!this._canvas) return;
    this._canvas.track.style.transition = 'none';
    this._canvas.track.style.transform = `translateX(${-this._canvas.W}px)`;
    this._scroll.style.transition = '';
    this._scroll.style.transform = '';
  }

  _csClearCell(cell) {
    if (!cell) return;
    if (cell._io) { cell._io.disconnect(); cell._io = null; }
    if (cell._pdfDoc && cell._pdfDoc.destroy) { try { cell._pdfDoc.destroy(); } catch {} }
    this._destroyGroupParts(cell._groupParts);
    if (cell._urls) { for (const u of cell._urls.values()) { if (u && u.startsWith('blob:')) URL.revokeObjectURL(u); } }
    cell._fi = -1; cell._format = null; cell._pages = []; cell._pdfDoc = null; cell._groupParts = null; cell._urls = new Map();
    cell.innerHTML = '';
  }

  _csCtx(cell) {
    return { fd: this._files[cell._fi], format: cell._format, pages: cell._pages,
             pdfDoc: cell._pdfDoc, urls: cell._urls, widthEl: cell, parts: cell._groupParts };
  }

  _csObserveCell(cell, strip) {
    cell._io = new IntersectionObserver(ents => {
      for (const ent of ents) {
        if (!ent.isIntersecting || ent.target.src) continue;
        const i = +ent.target.dataset.idx;
        this._resolvePageUrl(this._csCtx(cell), i).then(u => {
          if (u && ent.target.isConnected && !ent.target.dataset.full) { ent.target.dataset.full = '1'; this._setPageSrc(ent.target, u, cell); }
        });
      }
    }, { root: cell, rootMargin: '1200px 0px' });
    strip.querySelectorAll('img.ur-page').forEach(img => cell._io.observe(img));
  }

  async _csLoadCell(cell, fi) {
    this._csClearCell(cell);
    if (fi < 0 || fi >= this._files.length) return;
    cell._fi = fi;
    const fd = this._files[fi];

    // Resolve the neighbour's page model (grouped → flatten sub-documents; else one
    // segment). `stillMine()` lets the shared resolver bail — reclaiming any loaded
    // PDF — if this cell gets reassigned while it's awaiting.
    const stillMine = () => cell._fi === fi;
    if (this._isGroup(fd)) {
      const g = await this._resolveGroupParts(fd.parts, stillMine);
      if (!g || !stillMine()) { if (g) this._destroyGroupParts(g.parts); return; }
      cell._groupParts = g.parts; cell._format = 'group'; cell._pages = _range(Math.max(1, g.total));
    } else {
      const m = await this._resolveModel(fd, stillMine);
      if (!m || !stillMine()) { if (m && m.pdfDoc && m.pdfDoc.destroy) { try { m.pdfDoc.destroy(); } catch {} } return; }
      cell._pdfDoc = m.pdfDoc; cell._format = m.format; cell._pages = m.pages;
    }
    if (!cell._pages.length || cell._fi !== fi) return;

    const strip = document.createElement('div');
    strip.className = 'ur-strip ur-center';
    const starts = this._segStarts(cell._groupParts);
    for (let i = 0; i < cell._pages.length; i++) {
      if (i > 0) {
        const div = this._dividerFor(i, cell._groupParts, starts);
        if (div) strip.appendChild(div);
      }
      const img = document.createElement('img');
      img.className = 'ur-page'; img.alt = ''; img.draggable = false; img.dataset.idx = String(i);
      strip.appendChild(img);
    }
    cell.appendChild(strip);
    this._csObserveCell(cell, strip);

    // Restore the neighbour's saved scroll position; seed the visible page.
    const saved = this._pos.get(this._posKey(fi));
    const idx = saved ? Math.max(0, Math.min(cell._pages.length - 1, saved.idx)) : 0;
    requestAnimationFrame(() => {
      if (cell._fi !== fi) return;
      const imgs = cell.querySelectorAll('img.ur-page');
      if (imgs[idx]) cell.scrollTop = imgs[idx].offsetTop;
      this._resolvePageUrl(this._csCtx(cell), idx).then(u => {
        const im = cell.querySelector(`img.ur-page[data-idx="${idx}"]`);
        if (im && u && im.isConnected) { im.dataset.full = '1'; this._setPageSrc(im, u, cell); }
      });
    });
  }

  _csSaveCellPos(cell) {
    if (cell._fi < 0 || !cell._pages.length) return;
    const imgs = cell.querySelectorAll('img.ur-page');
    if (!imgs.length) return;
    const st = cell.scrollTop + 2; let idx = 0;
    for (let i = 0; i < imgs.length; i++) { if (imgs[i].offsetTop <= st) idx = i; else break; }
    if (cell.scrollHeight > cell.clientHeight + 4 && cell.scrollTop + cell.clientHeight >= cell.scrollHeight - 4) idx = imgs.length - 1;
    this._pos.set(this._posKey(cell._fi), { idx, scrollTop: cell.scrollTop });
  }

  _saveReaderPos() {
    if (this._index == null || !this._pages.length) return;
    this._pos.set(this._posKey(this._index), { idx: this._idx, scrollTop: this._scroll.scrollTop });
  }

  _csReload() {
    if (this._mode !== 'scroll' || this._committing || !this._dlg.open) return;
    this._csGetOrCreate();
    if (!this._canvas) return;
    this._csLoadCell(this._canvas.prevCell, this._index - 1);
    this._csLoadCell(this._canvas.nextCell, this._index + 1);
  }

  _csUpdate(dx) {
    if (this._committing) return;
    if (!this._canvas) this._csGetOrCreate();
    if (!this._canvas) return;
    this._canvas.track.style.transform = `translateX(${-this._canvas.W + dx}px)`;
    this._scroll.style.transform = `translateX(${dx}px)`;
  }

  // Rotate the three rendered units on commit — pure DOM moves, no re-decode, no flash.
  _csRotate(goPrev) {
    const cs = this._canvas; if (!cs) return false;
    // goPrev=true (swipe right) → destination is prevCell (index-1).
    const destCell = goPrev ? cs.prevCell : cs.nextCell;
    const fallCell = goPrev ? cs.nextCell : cs.prevCell;
    const destStrip = destCell.querySelector('.ur-strip');
    if (!destStrip || destCell._fi < 0) return false;

    const leavingStrip = this._scroll.querySelector('.ur-strip');
    const leaving = {
      fi: this._index, pages: this._pages, format: this._format, pdfDoc: this._pdfDoc,
      groupParts: this._groupParts, urls: this._urls, scrollTop: this._scroll.scrollTop,
    };
    this._saveReaderPos();
    if (this._io) { this._io.disconnect(); this._io = null; }

    // Drop the far-side unit (record its page first).
    this._csSaveCellPos(fallCell);
    this._csClearCell(fallCell);

    // Transplant the old current into the near-side cell — kept fully rendered.
    if (leavingStrip) {
      leavingStrip.id = '';
      fallCell.appendChild(leavingStrip);
      fallCell._fi = leaving.fi; fallCell._pages = leaving.pages; fallCell._format = leaving.format;
      fallCell._pdfDoc = leaving.pdfDoc; fallCell._groupParts = leaving.groupParts; fallCell._urls = leaving.urls;
      this._csObserveCell(fallCell, leavingStrip);
      fallCell.scrollTop = leaving.scrollTop;
    }

    // Adopt the destination cell straight into urScroll.
    const destTop = destCell.scrollTop;
    if (destCell._io) { destCell._io.disconnect(); destCell._io = null; }
    this._index  = destCell._fi;
    this._pages  = destCell._pages || [];
    this._format = destCell._format;
    this._pdfDoc = destCell._pdfDoc;
    this._groupParts = destCell._groupParts;
    this._urls   = destCell._urls || new Map();
    this._zs = 1;
    // Detach context from the cell so its upcoming reload can't revoke adopted urls
    // or destroy the sub-document PDFs we just adopted.
    destCell._fi = -1; destCell._pages = []; destCell._urls = new Map();
    destCell._pdfDoc = null; destCell._format = null; destCell._groupParts = null;
    this._scroll.classList.remove('ur-paged'); this._scroll.classList.add('ur-continuous');
    this._scroll.innerHTML = '';
    destStrip.id = 'urStrip';
    this._scroll.appendChild(destStrip);
    this._observeStrip(destStrip);
    const fd = this._files[this._index];
    this._title.textContent = (fd && fd.name) || '';
    this._scroll.scrollTop = destTop;
    // Restore the adopted file's remembered page (fallback to derived-from-scroll).
    const saved = this._pos.get(this._posKey(this._index));
    this._idx = saved ? Math.max(0, Math.min(this._pages.length - 1, saved.idx)) : 0;
    this._updateScrollIndicator();

    // Render the newly-exposed far neighbour into the freed cell (fire-and-forget).
    this._csLoadCell(destCell, goPrev ? this._index - 1 : this._index + 1);
    return true;
  }

  _csCommit(dx) {
    if (this._committing) return;
    const cs = this._canvas; if (!cs) return;
    const goPrev = dx > 0;                                // swipe right → index-1
    const targetFi = goPrev ? this._index - 1 : this._index + 1;
    if (targetFi < 0 || targetFi >= this._files.length) { this._csCancel(); return; }
    const targetX = goPrev ? 0 : -2 * cs.W;
    const ease = 'transform .25s ease-out';
    cs.track.style.transition = ease;
    cs.track.style.transform = `translateX(${targetX}px)`;
    this._scroll.style.transition = ease;
    this._scroll.style.transform = `translateX(${goPrev ? cs.W : -cs.W}px)`;
    this._committing = true;
    setTimeout(async () => {
      this._scroll.style.transition = ''; this._scroll.style.transform = '';
      let rotated = false;
      try { rotated = this._csRotate(goPrev); } catch { rotated = false; }
      if (rotated) {
        this._csHide();
        this._committing = false;
        // _csRotate → _updateScrollIndicator already emitted 'navigate'.
      } else {
        this._committing = false;
        this._csHide();
        await this._renderFile(targetFi, goPrev ? 'last' : 0);
      }
    }, 260);
  }

  _csCancel() {
    if (this._committing) return;
    const cs = this._canvas; if (!cs) return;
    const ease = 'transform .3s ease-out';
    cs.track.style.transition = ease;
    cs.track.style.transform = `translateX(${-cs.W}px)`;
    this._scroll.style.transition = ease;
    this._scroll.style.transform = 'translateX(0)';
    setTimeout(() => {
      if (this._canvas) this._canvas.track.style.transition = '';
      this._scroll.style.transition = ''; this._scroll.style.transform = '';
    }, 320);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PAGED (L→R / R→L) CAROUSEL MODE
  // ══════════════════════════════════════════════════════════════════════════
  async _renderPagedMode() {
    this._csTeardown();
    this._clearScroll();
    this._scroll.classList.remove('ur-continuous');
    this._scroll.classList.add('ur-paged');
    const track = document.createElement('div');
    track.className = 'ur-track'; track.id = 'urTrack';
    for (const pos of ['left', 'center', 'right']) {
      const cell = document.createElement('div');
      cell.className = 'ur-cell'; cell.dataset.pos = pos;
      track.appendChild(cell);
    }
    this._scroll.appendChild(track);
    this._cellW = this._scroll.clientWidth || window.innerWidth;
    this._pagedSetX(-this._cellW, false);
    await this._buildPagedSlots(this._idx);
    requestAnimationFrame(() => { this._cellW = this._scroll.clientWidth || this._cellW; this._pagedSetX(-this._cellW, false); });
  }

  _adjFile(which) {
    const i = this._index + (which === 'next' ? 1 : -1);
    return (i >= 0 && i < this._files.length) ? i : -1;
  }

  _slotFor(rel) { // rel: 'next' | 'prev'
    const N = this._pages.length;
    if (rel === 'next') {
      if (this._idx < N - 1) return { kind: 'page', idx: this._idx + 1 };
      const fi = this._adjFile('next');
      return fi >= 0 ? { kind: 'nextfile', fi } : { kind: 'none' };
    }
    if (this._idx > 0) return { kind: 'page', idx: this._idx - 1 };
    const fi = this._adjFile('prev');
    return fi >= 0 ? { kind: 'prevfile', fi } : { kind: 'none' };
  }

  async _buildPagedSlots(idx) {
    this._hardResetZoom();
    this._idx = Math.max(0, Math.min(this._pages.length - 1, idx));
    const next = this._slotFor('next'), prev = this._slotFor('prev');
    this._slots = this._mode === 'rtl'
      ? { left: next, center: { kind: 'page', idx: this._idx }, right: prev }
      : { left: prev, center: { kind: 'page', idx: this._idx }, right: next };
    await this._fillCell('center', this._slots.center);
    this._fillCell('left', this._slots.left);
    this._fillCell('right', this._slots.right);
    this._setIndicator();
    // Prefetch neighbours; trim the URL cache (PDF pages are costly → keep a wider window).
    void this._pageUrl(this._idx + 1); void this._pageUrl(this._idx - 1);
    const keep = (this._format === 'pdf' || this._format === 'group') ? 4 : 2;
    for (const k of [...this._urls.keys()]) {
      if (Math.abs(k - this._idx) > keep) { const u = this._urls.get(k); if (u && u.startsWith('blob:')) URL.revokeObjectURL(u); this._urls.delete(k); }
    }
  }

  async _fillCell(pos, slot) {
    const cell = this._scroll.querySelector(`.ur-cell[data-pos="${pos}"]`);
    if (!cell) return;
    cell.classList.remove('ur-zoomed'); cell.scrollTop = cell.scrollLeft = 0; cell.innerHTML = '';
    if (!slot || slot.kind === 'none') return;
    if (slot.kind === 'page') {
      const img = document.createElement('img');
      img.className = 'ur-page'; img.alt = ''; img.draggable = false;
      cell.appendChild(img);
      this._pageUrl(slot.idx).then(u => { if (u) { img.dataset.full = '1'; img.src = u; } });
    } else { // nextfile / prevfile preview — show the neighbour's first page
      const img = document.createElement('img');
      img.className = 'ur-page'; img.alt = ''; img.draggable = false;
      cell.appendChild(img);
      const fd = this._files[slot.fi];
      // A grouped neighbour previews its first sub-document's first page.
      const p0 = this._isGroup(fd) ? (fd.parts[0] || {}) : fd;
      this._ensurePrepared(p0).then(() => {
        if (p0.urlFn) p0.urlFn(0).then(u => { if (u && img.isConnected) img.src = u; }).catch(() => {});
        else if (_isImage(p0.type)) { const u = p0.file ? URL.createObjectURL(p0.file) : (p0.url || ''); if (u) img.src = u; }
      });
    }
  }

  _pagedSetX(px, animate) {
    const t = this._scroll.querySelector('#urTrack'); if (!t) return;
    t.style.transition = animate ? 'transform .25s ease-out' : 'none';
    t.style.transform = `translateX(${px}px)`;
  }

  _pagedAnimateTo(target) {
    const w = this._cellW || this._scroll.clientWidth;
    const slot = target === 'center' ? null : this._slots[target];
    if (target !== 'center' && (!slot || slot.kind === 'none')) target = 'center';
    const x = target === 'left' ? 0 : target === 'right' ? -2 * w : -w;
    const t = this._scroll.querySelector('#urTrack'); if (!t) return;
    this._pagedSetX(x, true);
    if (target === 'center') return;
    let done = false;
    const commit = () => { if (done) return; done = true; t.removeEventListener('transitionend', commit); this._pagedCommit(this._slots[target]); };
    t.addEventListener('transitionend', commit);
    setTimeout(commit, 320);
  }

  _pagedCommit(slot) {
    if (!slot) return;
    if (slot.kind === 'page') { this._buildPagedSlots(slot.idx).then(() => this._pagedSetX(-this._cellW, false)); }
    else if (slot.kind === 'nextfile') this.goFile(slot.fi, 0);
    else if (slot.kind === 'prevfile') this.goFile(slot.fi, 'last');
  }

  // ── Paged zoom (double-tap anchored on tap; pinch anchored on midpoint) ─────
  _centerCell() { return this._scroll.querySelector('.ur-cell[data-pos="center"]'); }
  _isZoomed()   { return !!((this._z && this._z.s > 1.01) || this._zs > 1.01); }

  _ensureZoomState() {
    if (this._z) return this._z;
    const cell = this._centerCell(); if (!cell) return null;
    const img = cell.querySelector('.ur-page'); if (!img) return null;
    const st = cell.scrollTop, sl = cell.scrollLeft;
    cell.classList.add('ur-zoomed'); cell.scrollTop = 0; cell.scrollLeft = 0;
    const cr = cell.getBoundingClientRect(), ir = img.getBoundingClientRect();
    this._z = { img, cell, s: 1, tx: -sl, ty: -st, w0: ir.width, h0: ir.height, left0: ir.left - cr.left, top0: ir.top - cr.top };
    this._applyZoom(false);
    void img.offsetWidth;
    return this._z;
  }
  _clampPan() {
    const z = this._z; if (!z) return;
    const cr = z.cell.getBoundingClientRect();
    const sw = z.w0 * z.s, sh = z.h0 * z.s;
    if (sw <= cr.width)  z.tx = (cr.width  - sw) / 2 - z.left0;
    else z.tx = Math.min(-z.left0, Math.max(cr.width  - sw - z.left0, z.tx));
    if (sh <= cr.height) z.ty = (cr.height - sh) / 2 - z.top0;
    else z.ty = Math.min(-z.top0, Math.max(cr.height - sh - z.top0, z.ty));
  }
  _applyZoom(animate) {
    const z = this._z; if (!z) return;
    z.img.style.transition = animate ? 'transform .2s ease-out' : 'none';
    z.img.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
  }
  _zoomScaleAround(s2, mx, my, animate) {
    const z = this._ensureZoomState(); if (!z) return;
    s2 = Math.max(1, Math.min(ZOOM_MAX, s2));
    const cr = z.cell.getBoundingClientRect();
    const Mcx = mx - cr.left, Mcy = my - cr.top;
    const px = (Mcx - z.left0 - z.tx) / z.s, py = (Mcy - z.top0 - z.ty) / z.s;
    z.s = s2; z.tx = Mcx - z.left0 - px * z.s; z.ty = Mcy - z.top0 - py * z.s;
    this._clampPan(); this._applyZoom(!!animate);
  }
  _zoomOut() {
    const z = this._z; if (!z) return;
    this._z = null;
    z.img.style.transition = 'transform .2s ease-out'; z.img.style.transform = '';
    z.cell.classList.remove('ur-zoomed');
  }
  _hardResetZoom() {
    this._cancelPanMomentum(); this._cancelZoomAnim();
    const z = this._z; this._z = null;
    if (z) { try { z.img.style.transition = 'none'; z.img.style.transform = ''; z.cell.classList.remove('ur-zoomed'); } catch {} }
    if ((this._zs || 1) > 1.01) { const strip = this._scroll.querySelector('#urStrip'); if (strip) strip.style.width = ''; this._scroll.classList.remove('ur-zoomed'); }
    this._zs = 1;
  }
  _toggleZoomAt(cx, cy) { if (this._z && this._z.s > 1.01) this._zoomOut(); else this._zoomScaleAround(ZOOM_TAP, cx, cy, true); }

  // ── Zoomed scroll-mode pan momentum (native scroll has it; JS pan must too) ──
  _cancelPanMomentum() { if (this._panRaf) { cancelAnimationFrame(this._panRaf); this._panRaf = 0; } }
  _startPanMomentum(vx, vy) {
    this._cancelPanMomentum();
    const scroll = this._scroll;
    let px = vx, py = vy, last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last); last = now;
      const maxL = scroll.scrollWidth - scroll.clientWidth, maxT = scroll.scrollHeight - scroll.clientHeight;
      const nl = scroll.scrollLeft + px * dt, nt = scroll.scrollTop + py * dt;
      if (nl <= 0 || nl >= maxL) px = 0;               // stop an axis dead at its edge
      if (nt <= 0 || nt >= maxT) py = 0;
      scroll.scrollLeft = Math.max(0, Math.min(maxL, nl));
      scroll.scrollTop  = Math.max(0, Math.min(maxT, nt));
      const decay = Math.pow(0.95, dt / 16);           // friction per ~frame
      px *= decay; py *= decay;
      if (Math.abs(px) < 0.015 && Math.abs(py) < 0.015) { this._panRaf = 0; return; }
      this._panRaf = requestAnimationFrame(step);
    };
    this._panRaf = requestAnimationFrame(step);
  }

  // ── Scroll-mode continuous zoom (scale the whole strip; native 2-axis pan) ──
  _focalAnchor(sx, sy) {
    const el0 = document.elementFromPoint(sx, sy);
    const el = el0 && el0.closest ? el0.closest('.ur-page') : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { el, fx: r.width ? (sx - r.left) / r.width : 0.5, fy: r.height ? (sy - r.top) / r.height : 0.5 };
  }
  _scrollZoomCore(s, fx, fy) {
    this._cancelPanMomentum();                         // a new zoom gesture ends any glide
    const strip = this._scroll.querySelector('#urStrip'); if (!strip) return;
    const prev = this._zs || 1;
    s = Math.max(1, Math.min(ZOOM_MAX, s));
    const rect = this._scroll.getBoundingClientRect();
    const Cx = (fx != null) ? fx - rect.left : rect.width / 2;
    const Cy = (fy != null) ? fy - rect.top  : rect.height / 2;
    const a = this._focalAnchor((fx != null) ? fx : rect.left + Cx, (fy != null) ? fy : rect.top + Cy);
    this._zs = s;
    if (s > 1.01) { strip.style.width = (rect.width * s) + 'px'; this._scroll.classList.add('ur-zoomed'); }
    else { strip.style.width = ''; this._scroll.classList.remove('ur-zoomed'); }
    if (a) {
      this._scroll.scrollLeft = Math.max(0, a.el.offsetLeft + a.fx * a.el.offsetWidth  - Cx);
      this._scroll.scrollTop  = Math.max(0, a.el.offsetTop  + a.fy * a.el.offsetHeight - Cy);
    } else {
      const ratio = s / prev;
      this._scroll.scrollLeft = Math.max(0, (this._scroll.scrollLeft + Cx) * ratio - Cx);
      this._scroll.scrollTop  = Math.max(0, (this._scroll.scrollTop  + Cy) * ratio - Cy);
    }
  }
  _scrollZoomTo(s, fx, fy, animate) {
    const strip = this._scroll.querySelector('#urStrip'); if (!strip) return;
    const prev = this._zs || 1;
    s = Math.max(1, Math.min(ZOOM_MAX, s));
    this._cancelZoomAnim();
    if (!animate || Math.abs(s - prev) <= 0.01) { this._scrollZoomCore(s, fx, fy); return; }
    // Animate on the MAIN THREAD by re-applying the resting zoom each frame — the exact
    // path pinch uses continuously (which never flashes) — instead of a CSS `transform`
    // transition. The transition composited the strip, and its end hand-off (drop the
    // transform, restore the real width) briefly painted the un-scaled, full-width strip:
    // the double-tap-zoom-out flash. Re-anchoring per frame keeps the tap point fixed.
    const start = performance.now(), dur = 200;
    const ease = t => 1 - Math.pow(1 - t, 3);          // ease-out cubic
    const step = (now) => {
      const t = Math.min(1, ((now || performance.now()) - start) / dur);
      this._scrollZoomCore(prev + (s - prev) * ease(t), fx, fy);
      if (t < 1) { this._zoomAnimRaf = requestAnimationFrame(step); }
      else { this._zoomAnimRaf = 0; this._scrollZoomCore(s, fx, fy); }
    };
    this._zoomAnimRaf = requestAnimationFrame(step);
  }
  _cancelZoomAnim() { if (this._zoomAnimRaf) { cancelAnimationFrame(this._zoomAnimRaf); this._zoomAnimRaf = 0; } }

  // ══════════════════════════════════════════════════════════════════════════
  // GESTURES — one pointer model for tap / double-tap / swipe / pan / pinch / hold
  // ══════════════════════════════════════════════════════════════════════════
  _cancelHold() { clearTimeout(this._holdTimer); this._holdTimer = null; }
  _twoFinger() {
    const a = [...this._PTRS.values()];
    return { mx: (a[0].x + a[1].x) / 2, my: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1 };
  }

  _wireGestures() {
    const scroll = this._scroll;

    scroll.addEventListener('pointerdown', e => {
      this._cancelPanMomentum(); this._cancelZoomAnim();   // a new touch stops any ongoing glide / zoom tween
      this._PTRS.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._PTRS.size === 2) {
        this._cancelHold(); this._G = null;
        const t = this._twoFinger();
        if (this._mode === 'scroll') this._PINCH = { dist: t.d, mx: t.mx, my: t.my, scroll: true, d0: t.d };
        else { this._ensureZoomState(); this._PINCH = { dist: t.d, mx: t.mx, my: t.my, scroll: false, d0: t.d }; }
        return;
      }
      if (this._PTRS.size !== 1) return;
      if (e.pointerType === 'mouse') { try { scroll.setPointerCapture(e.pointerId); } catch {} }
      this._cellW = scroll.clientWidth;
      const cell = this._centerCell();
      const now = Date.now();
      const dbl = (now - this._lastUpT < DBL_MS) && Math.abs(e.clientX - this._lastUpX) < 60 && Math.abs(e.clientY - this._lastUpY) < 60;
      if (dbl) { clearTimeout(this._tapTimer); this._tapTimer = null; }
      this._G = { x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, t: performance.now(),
                  axis: null, dragging: false, panned: false, top: scroll.scrollTop, left: scroll.scrollLeft,
                  cellTop0: cell ? cell.scrollTop : 0, target: e.target, dbl };
      this._cancelHold();
      this._holdX = e.clientX; this._holdY = e.clientY;
      if (this._opts.holdMenu) {
        this._holdTimer = setTimeout(() => { this._holdAt = Date.now(); this._openMenu('hold', this._holdX, this._holdY); }, HOLD_MS);
      }
    }, { passive: true });

    scroll.addEventListener('pointermove', e => {
      const rec = this._PTRS.get(e.pointerId); if (rec) { rec.x = e.clientX; rec.y = e.clientY; }
      if (this._PINCH && this._PTRS.size >= 2) {
        const t = this._twoFinger();
        if (this._opts.zoomEnabled) {
          if (this._PINCH.scroll) this._scrollZoomTo((this._zs || 1) * (t.d / this._PINCH.dist), t.mx, t.my);
          else {
            this._zoomScaleAround((this._z ? this._z.s : 1) * (t.d / this._PINCH.dist), this._PINCH.mx, this._PINCH.my, false);
            if (this._z) { this._z.tx += t.mx - this._PINCH.mx; this._z.ty += t.my - this._PINCH.my; this._clampPan(); this._applyZoom(false); }
          }
        }
        // Pinch-to-quit is intentionally disabled: it lacked the shrink/opacity
        // feedback and, on release while a finger was still down, could strand a
        // pointer that broke navigation on re-entry. Close via Back / the button.
        this._PINCH.dist = t.d; this._PINCH.mx = t.mx; this._PINCH.my = t.my;
        return;
      }
      if (!this._G) return;
      const dx = e.clientX - this._G.x, dy = e.clientY - this._G.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) this._cancelHold();
      if (this._mode === 'scroll') {
        if (this._zs > 1.01) {
          // Drive zoomed panning ourselves (both axes) rather than leaving it to
          // native touch-scroll, which locks each gesture to a single axis on
          // Chromium/Samsung WebViews — so a zoomed page could only pan in x OR y.
          // Paired with touch-action:none on .ur-zoomed so the two don't fight.
          // Only start once the finger clears a small deadzone, so a double-tap's
          // slight jitter still reads as a tap (keeps double-tap-to-zoom-out alive).
          if (this._G.panning || Math.hypot(e.clientX - this._G.x, e.clientY - this._G.y) >= PAN_THRESHOLD) {
            this._G.panning = true;
            const mdx = e.clientX - this._G.px, mdy = e.clientY - this._G.py;
            scroll.scrollLeft -= mdx; scroll.scrollTop -= mdy;
            const vt = performance.now(), dt = vt - (this._G.vt || vt);   // recent velocity → release-flick momentum
            if (dt > 0) { this._G.vx = -mdx / dt; this._G.vy = -mdy / dt; }
            this._G.vt = vt;
            this._G.panned = true;
          }
          this._G.px = e.clientX; this._G.py = e.clientY;   // always track so crossing the deadzone doesn't jump
          return;
        }
        if (!this._isZoomed()) {
          if (!this._G.axis) {
            if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { this._G.axis = 'v'; this._csCancel(); }
            else if (Math.abs(dx) > 8) this._G.axis = 'h';
          }
          if (this._G.axis === 'h') this._csUpdate(dx);
        }
        return;
      }
      if (this._isZoomed()) {
        this._z.tx += e.clientX - this._G.px; this._z.ty += e.clientY - this._G.py;
        this._G.px = e.clientX; this._G.py = e.clientY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this._G.panned = true;
        this._clampPan(); this._applyZoom(false); return;
      }
      if (this._G.axis === null) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; this._G.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'; }
      if (this._G.axis === 'h') { this._G.dragging = true; this._pagedSetX(-this._cellW + dx, false); }
      else {
        const cell = this._centerCell();
        if (cell && cell.scrollHeight > cell.clientHeight + 1) { cell.scrollTop = this._G.cellTop0 - dy; this._G.panned = true; }
      }
    }, { passive: true });

    const end = e => this._endPointer(e);
    scroll.addEventListener('pointerup', end, { passive: true });
    scroll.addEventListener('pointercancel', e => { this._csCancel(); this._endPointer(e); }, { passive: true });
    scroll.addEventListener('dragstart', e => e.preventDefault());
    scroll.addEventListener('contextmenu', e => e.preventDefault());
    scroll.addEventListener('scroll', () => {
      if (this._mode !== 'scroll' || this._rScrollRaf) return;
      this._rScrollRaf = requestAnimationFrame(() => { this._rScrollRaf = 0; this._updateScrollIndicator(); });
    }, { passive: true });

    // Dismiss the hold menu on a tap outside it.
    scroll.addEventListener('pointerdown', e => {
      if (!this._holdMenu.hidden && !this._holdMenu.contains(e.target)) this._hideHoldMenu();
    }, { passive: true });
  }

  _recordTap(e) { this._lastUpT = Date.now(); this._lastUpX = e.clientX; this._lastUpY = e.clientY; }

  _readerTap(e, g) {
    if (this._mode === 'scroll') {
      if (g.dbl && this._opts.zoomEnabled) {
        clearTimeout(this._tapTimer); this._tapTimer = null; this._lastUpT = 0;
        this._scrollZoomTo(this._zs > 1.01 ? 1 : ZOOM_TAP, e.clientX, e.clientY, true); return;
      }
      // A single tap anywhere (image or black padding) toggles the bars. Closing
      // is deliberate: the top-left back button or the system back gesture.
      this._recordTap(e); clearTimeout(this._tapTimer);
      this._tapTimer = setTimeout(() => this._toggleBars(), BARS_DEFER); return;
    }
    // Paged mode: edge zones page; centre is for bars / zoom.
    if (!this._isZoomed()) {
      const w = this._scroll.clientWidth;
      const zone = e.clientX < w / 3 ? 'left' : e.clientX > w * 2 / 3 ? 'right' : 'center';
      if (zone !== 'center') { this._pagedAnimateTo(zone); return; }
    }
    if (g.dbl && this._opts.zoomEnabled) {
      clearTimeout(this._tapTimer); this._tapTimer = null; this._lastUpT = 0;
      this._toggleZoomAt(e.clientX, e.clientY); return;
    }
    this._recordTap(e); clearTimeout(this._tapTimer);
    this._tapTimer = setTimeout(() => this._toggleBars(), BARS_DEFER);
  }

  _endPointer(e) {
    if (e.pointerType === 'mouse') { try { this._scroll.releasePointerCapture(e.pointerId); } catch {} }
    this._PTRS.delete(e.pointerId);
    if (this._PINCH) {
      if (this._PTRS.size < 2) {
        const wasScroll = this._PINCH.scroll, doExit = this._PINCH.exit; this._PINCH = null;
        if (doExit) { this.close(); return; }
        if (wasScroll) { if ((this._zs || 1) <= 1.02) this._scrollZoomTo(1); }
        else if (this._z && this._z.s <= 1.02) this._zoomOut();
        if (this._PTRS.size === 1) {
          const r = [...this._PTRS.values()][0], cell = this._centerCell();
          this._G = { x: r.x, y: r.y, px: r.x, py: r.y, t: performance.now(), axis: null, dragging: false, panned: true,
                      top: this._scroll.scrollTop, left: this._scroll.scrollLeft, cellTop0: cell ? cell.scrollTop : 0, target: e.target };
        }
      }
      return;
    }
    const g = this._G; this._G = null;
    this._cancelHold();
    if (!g) return;
    if (Date.now() - this._holdAt < 700) return;          // ignore the tap that ends a hold
    if (!this._holdMenu.hidden) { this._hideHoldMenu(); return; }
    if (g.dragging) {                                     // paged carousel drag → snap
      const dx = e.clientX - g.x, w = this._cellW || this._scroll.clientWidth;
      const vx = dx / Math.max(1, performance.now() - g.t) * 1000;
      if (dx <= -w * 0.5 || vx < -550) this._pagedAnimateTo('right');
      else if (dx >= w * 0.5 || vx > 550) this._pagedAnimateTo('left');
      else this._pagedAnimateTo('center');
      return;
    }
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    const absDx = Math.abs(dx), absDy = Math.abs(dy);
    // Scroll-mode horizontal swipe → threshold snap (60%) or bounce back.
    if (this._mode === 'scroll' && !this._isZoomed() && g.axis === 'h') {
      const vx = dx / Math.max(1, performance.now() - g.t) * 1000;
      const threshold = (this._canvas ? this._canvas.W : this._scroll.clientWidth) * 0.6;
      if (Math.abs(dx) >= threshold || Math.abs(vx) > 500) this._csCommit(dx);
      else this._csCancel();
      return;
    }
    // Zoomed scroll-mode pan: keep gliding after lift-off with a decaying flick,
    // so it matches native (non-zoomed) scroll momentum instead of stopping dead.
    if (this._mode === 'scroll' && this._zs > 1.01 && g.panned) {
      const fresh = performance.now() - (g.vt || 0) < 90;
      if (fresh && (Math.abs(g.vx || 0) > 0.03 || Math.abs(g.vy || 0) > 0.03)) this._startPanMomentum(g.vx, g.vy);
    }
    const moved = absDx > 10 || absDy > 10;
    const scrolled = this._mode === 'scroll'
      ? (Math.abs(this._scroll.scrollTop - g.top) > 4 || Math.abs(this._scroll.scrollLeft - (g.left || 0)) > 4)
      : false;
    if (moved || scrolled || g.panned) return;
    this._readerTap(e, g);
  }

  // ── Bars ──────────────────────────────────────────────────────────────────
  _toggleBars() {
    this._barsShown = !this._barsShown;
    this._dlg.classList.toggle('bars-shown', this._barsShown);
    // Bars hidden ⇄ immersive on. Hosts (e.g. Android) mirror this on the system
    // navigation bar so tapping reveals the app chrome and the system nav together.
    this._setImmersive(!this._barsShown);
  }

  // Emit immersive state (true = chrome hidden / go full-screen) for the host to
  // mirror on native system bars. No-op cross-emit when the state is unchanged.
  _setImmersive(on) {
    if (this._immersive === on) return;
    this._immersive = on;
    this._dispatchEvent('immersive', { immersive: on });
  }

  // ── Page-actions menu ───────────────────────────────────────────────────────
  // Items are supplied by the host (opts.pageMenu) so labels/translations and the
  // actual work live in the host; the reader just renders and dispatches. Shapes:
  //   { html, onClick(ctx), when?(ctx) }   action row (html may contain trusted icons)
  //   { separator: true, when?(ctx) }      divider
  //   { title, when?(ctx) }                small section heading
  // ctx = { fileIndex, pageIndex, file, getBlob: () => Promise<Blob|null> }.
  // opts.pageMenu may be that array or a function (ctx) => array (re-evaluated on
  // every open, so it always reflects the current file + language).
  _menuContext() {
    return {
      fileIndex: this._index,
      pageIndex: this._idx,
      file: this._files[this._index],
      getBlob: () => this._currentPageBlob(),
    };
  }

  _resolveMenu(ctx) {
    let items = this._opts.pageMenu;
    if (typeof items === 'function') { try { items = items(ctx); } catch { items = null; } }
    if (!Array.isArray(items)) {
      // Built-in default (standalone / demo use): copy / save / share.
      items = [
        { html: '⎘ Copy',  onClick: () => this._defaultAction('copy',  ctx) },
        { html: '↓ Save',  onClick: () => this._defaultAction('save',  ctx) },
        { html: '↗ Share', onClick: () => this._defaultAction('share', ctx) },
      ];
    }
    return items.filter(it => typeof it.when !== 'function' || it.when(ctx));
  }

  _renderMenuItems(ctx) {
    this._menuItems.innerHTML = '';
    for (const it of this._resolveMenu(ctx)) {
      if (it.separator) { const d = document.createElement('div'); d.className = 'ur-hold-sep'; this._menuItems.appendChild(d); continue; }
      if (it.title != null) { const t = document.createElement('div'); t.className = 'ur-hold-title'; t.innerHTML = it.title; this._menuItems.appendChild(t); continue; }
      const b = document.createElement('button');
      b.className = 'ur-menu-btn';
      b.innerHTML = it.html != null ? it.html : (it.label || '');
      b.addEventListener('click', e => {
        e.stopPropagation();
        this._hideHoldMenu();
        try { it.onClick && it.onClick(ctx); } catch (err) { console.error('UniversalReader menu action failed', err); }
      });
      this._menuItems.appendChild(b);
    }
  }

  // mode: 'hold' (near the press point, with a page thumbnail) | 'button' (fixed,
  // top-right, no thumbnail — the top-bar ··· button).
  _openMenu(mode, x, y) {
    const fd = this._files[this._index];
    if (!fd) return;
    this._G = null; this._PINCH = null;                  // cancel any in-flight gesture
    const ctx = this._menuContext();
    this._renderMenuItems(ctx);

    const showThumb = mode === 'hold';
    this._holdThumb.hidden = !showThumb;
    this._holdThumb.src = '';
    if (showThumb) {
      ctx.getBlob().then(blob => {
        if (blob && !this._holdMenu.hidden) {
          const u = URL.createObjectURL(blob);
          this._holdThumb.src = u;
          setTimeout(() => URL.revokeObjectURL(u), 30_000);
        }
      }).catch(() => {});
    }

    this._holdMenu.hidden = false;
    if (mode === 'hold') {
      this._dispatchEvent('longpress', { fileIndex: this._index, pageIndex: this._idx });
    }
    // A long-press opens this menu while the finger is still down; the browser then
    // synthesizes a click when it lifts, landing on whatever menu button is now
    // under the finger (firing it instantly) — and can select the text beneath.
    // Swallow that one ghost click so the menu only acts on a fresh, deliberate tap.
    if (mode === 'hold') this._armGhostGuard(); else this._disarmGhostGuard();
    const mw = this._holdMenu.offsetWidth || 200, mh = this._holdMenu.offsetHeight || 220;
    const vw = this._dlg.clientWidth, vh = this._dlg.clientHeight;
    if (mode === 'button') {
      // Fixed placement under the top-right ··· button.
      this._holdMenu.style.left = Math.max(8, vw - mw - 8) + 'px';
      this._holdMenu.style.top  = `calc(env(safe-area-inset-top, 0px) + 54px)`;
    } else {
      let left = Math.max(8, Math.min(vw - mw - 8, x - mw / 2));
      let top  = y - mh - 12;                             // above the finger
      if (top < 8) top = Math.min(vh - mh - 8, y + 16);  // no room above → below
      top = Math.max(8, Math.min(vh - mh - 8, top));
      this._holdMenu.style.left = left + 'px';
      this._holdMenu.style.top  = top + 'px';
    }
  }
  _hideHoldMenu() { this._holdMenu.hidden = true; this._disarmGhostGuard(); }

  // One-shot capturing click swallower: kills the ghost click that a touch
  // long-press emits on release (see _openMenu). Beats the menu buttons' own
  // handlers via the capture phase; self-clears on first click or after 700ms.
  _armGhostGuard() {
    this._disarmGhostGuard();
    const swallow = e => { e.stopPropagation(); e.preventDefault(); this._disarmGhostGuard(); };
    this._ghostGuard = swallow;
    window.addEventListener('click', swallow, true);
    this._ghostGuardT = setTimeout(() => this._disarmGhostGuard(), 700);
  }
  _disarmGhostGuard() {
    if (this._ghostGuard) { window.removeEventListener('click', this._ghostGuard, true); this._ghostGuard = null; }
    if (this._ghostGuardT) { clearTimeout(this._ghostGuardT); this._ghostGuardT = null; }
  }

  // Built-in copy/save/share for the default menu (standalone use).
  async _defaultAction(kind, ctx) {
    const blob = await ctx.getBlob();
    if (!blob) return;
    const url  = URL.createObjectURL(blob);
    const name = (ctx.file?.name || 'page').replace(/\.[^.]+$/, '') + `_${ctx.pageIndex + 1}`;
    try {
      if (kind === 'copy') await this._copyBlob(blob);
      else if (kind === 'save') { const a = document.createElement('a'); a.href = url; a.download = name + '.jpg'; a.click(); }
      else if (kind === 'share' && navigator.share) {
        await navigator.share({ files: [new File([blob], name + '.jpg', { type: blob.type || 'image/jpeg' })] });
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.error('UniversalReader action failed', err);
    } finally { setTimeout(() => URL.revokeObjectURL(url), 30_000); }
  }

  async _copyBlob(blob) {
    let pngBlob = blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const cv  = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      pngBlob = await new Promise(r => cv.toBlob(r, 'image/png'));
    }
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    }
  }

  // ── Read-orientation mode switch ─────────────────────────────────────────────
  _setMode(mode) {
    if (mode === this._mode || !['scroll','ltr','rtl'].includes(mode)) return;
    this._mode = mode;
    this._opts.mode = mode;
    this._syncModeButtons();
    this._dispatchEvent('modechange', { mode });
    if (this._dlg.open) this._renderFile(this._index);
  }
  _syncModeButtons() {
    if (!this._modes) return;
    this._modes.querySelectorAll('.ur-mode').forEach(b => {
      const active = b.dataset.mode === this._mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
      b.tabIndex = active ? 0 : -1;
    });
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────
  _wireKeys() {
    if (!this._opts.keyboardControls || this._keyHandler) return;
    this._keyHandler = e => {
      if (!this._dlg.open) return;
      if (e.target === this._progress) return;
      switch (e.key) {
        case 'Escape': e.preventDefault(); this.close(); break;
        case 'ArrowRight': case 'PageDown':
          e.preventDefault();
          if (this._mode === 'scroll') this._scroll.scrollBy({ top: this._scroll.clientHeight * 0.9, behavior: 'smooth' });
          else this._pagedAnimateTo(this._mode === 'rtl' ? 'left' : 'right');
          break;
        case 'ArrowLeft': case 'PageUp':
          e.preventDefault();
          if (this._mode === 'scroll') this._scroll.scrollBy({ top: -this._scroll.clientHeight * 0.9, behavior: 'smooth' });
          else this._pagedAnimateTo(this._mode === 'rtl' ? 'right' : 'left');
          break;
        case '+': case '=': e.preventDefault(); this._scrollZoomTo(Math.min(ZOOM_MAX, this._zs * 1.3), null, null, true); break;
        case '-':           e.preventDefault(); this._scrollZoomTo(Math.max(1, this._zs / 1.3), null, null, true); break;
        case '0':           e.preventDefault(); this._scrollZoomTo(1, null, null, true); break;
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }
  _unwireKeys() {
    if (this._keyHandler) { document.removeEventListener('keydown', this._keyHandler); this._keyHandler = null; }
  }

  // ── Public state accessors (for host back-button handling) ──────────────────
  get isOpen()         { return this._dlg.open; }
  get isZoomed()       { return this._isZoomed(); }
  get isHoldMenuOpen() { return !this._holdMenu.hidden; }
  hideHoldMenu()       { this._hideHoldMenu(); }
  resetZoom()          { if (this._mode === 'scroll') this._scrollZoomTo(1, null, null, true); else this._zoomOut(); }

  // ── Event helper ────────────────────────────────────────────────────────────
  _dispatchEvent(name, detail) {
    this.dispatchEvent(Object.assign(new Event(name), { detail }));
  }
}

// Classic-script compatibility (no bundler)
if (typeof window !== 'undefined') window.UniversalReader = UniversalReader;
