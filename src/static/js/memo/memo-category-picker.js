// memo-category-picker.js — a searchable Category picker for the entry modal, an
// alternative to the inline <select> (which gets unwieldy as categories grow).
//
// Toggles between a LIST view (name + entry count) and a CARD view (a grid of
// category cards showing up to 3 preview thumbnails, reusing the feed's folder-card
// look). Picking one sets #categoryInput (creating it via window.ensureCategory if
// new) and closes; the modal's existing save path reads the value unchanged.
(function (global) {
  'use strict';
  var VIEW_KEY = 'memoCatPickView';   // 'list' | 'card'
  var q = '';
  // Per-open options. Default: assign the chosen folder to the entry being edited.
  // { onChoose(cat), title, allowCreate } lets the same dialog be reused elsewhere —
  // e.g. the filter opens it in "navigate" mode where choosing opens that folder.
  var opts = {};

  function el(id) { return document.getElementById(id); }
  function dlg() { return el('catPickerDlg'); }
  function core() { return global.MemoCore; }
  function state() { try { return core().getState(); } catch (_e) { return { db: { entries: [] }, settings: {} }; } }
  function isImage(u) { return (core() && core().isImage) ? core().isImage(u) : /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(u || ''); }
  // Default to the list of names (folders read better as a list than a wall of
  // card thumbnails); the card view stays one toggle away and is remembered.
  function view() { try { return localStorage.getItem(VIEW_KEY) === 'card' ? 'card' : 'list'; } catch (_e) { return 'list'; } }
  function setView(v) { try { localStorage.setItem(VIEW_KEY, v); } catch (_e) {} render(); }
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function matchesQ(c) { return !q || c.toLowerCase().indexOf(q) !== -1; }
  function lazySrc(src) { return global.MemoLazy ? global.MemoLazy.thumbUrl(src, 240) : src; }

  function categories() {
    // settings.categories is shared across memo/finance/planner, so it would show
    // finance folders while you're in memo. Scope to the CURRENT variant instead by
    // deriving folders from ITS entries (same source as the feed's folder cards) —
    // which also means memo and finance can each have a same-named folder without
    // collision (categories are per-entry string labels, entries are per-variant).
    var set = new Set(['Uncategorized']);
    liveEntries().forEach(function (e) { set.add(e.category || 'Uncategorized'); });
    // Keep the entry being edited's own (possibly brand-new) category visible.
    try { var cur = (el('categoryInput') || {}).value; if (cur) set.add(cur); } catch (_e) {}
    return Array.from(set);
  }
  function liveEntries() {
    var P = global.MemoPrivacy;
    return (state().db.entries || []).filter(function (e) {
      // Folder counts/thumbnails must not reveal Safe/locked entries.
      return !e.deletedAt && (!P || !P.canViewEntry || P.canViewEntry(e));
    });
  }
  function statsFor(cat) {
    var ents = liveEntries().filter(function (e) { return (e.category || 'Uncategorized') === cat; });
    var previews = [];
    for (var i = 0; i < ents.length && previews.length < 3; i++) {
      var imgs = (ents[i].images || []).filter(isImage);
      if (imgs[0]) previews.push(imgs[0]);
    }
    return { count: ents.length, previews: previews };
  }

  function render() {
    var wrap = el('catPickList'); if (!wrap) return;
    var v = view();
    wrap.className = 'catpick-grid catpick-' + v;
    var tl = el('catPickViewList'), tc = el('catPickViewCard');
    if (tl) {
      tl.classList.toggle('active', v === 'list');
      tl.setAttribute('aria-pressed', String(v === 'list'));
    }
    if (tc) {
      tc.classList.toggle('active', v === 'card');
      tc.setAttribute('aria-pressed', String(v === 'card'));
    }
    var cats = categories().filter(matchesQ);
    wrap.innerHTML = cats.map(function (c) {
      var st = statsFor(c);
      if (v === 'list') {
        var thumb = st.previews.length
          ? '<img class="catpick-row-thumb lazy-img" data-src="' + escHtml(lazySrc(st.previews[0])) + '" loading="lazy" alt="">'
          : '<span class="catpick-row-thumb catpick-row-thumb-empty"><span class="svg-icon svg-icon-folder"></span></span>';
        return '<button type="button" class="catpick-row" data-cat="' + escHtml(c) + '">'
          + thumb
          + '<span class="catpick-name">' + escHtml(c) + '</span>'
          + '<span class="catpick-count muted">' + st.count + '</span></button>';
      }
      var thumbs = st.previews.length
        ? st.previews.map(function (s) { return '<img class="lazy-img" data-src="' + escHtml(lazySrc(s)) + '" loading="lazy" alt="">'; }).join('')
        : '<span class="folder-empty"><span class="svg-icon svg-icon-folder"></span></span>';
      return '<button type="button" class="catpick-card card folder-card" data-cat="' + escHtml(c) + '">'
        + '<div class="folder-thumbs">' + thumbs + '</div>'
        + '<div class="folder-meta"><div class="folder-name">' + escHtml(c) + '</div>'
        + '<div class="muted">' + st.count + ' ' + (st.count === 1 ? 'entry' : 'entries') + '</div></div></button>';
    }).join('');
    if (global.MemoLazy) global.MemoLazy.hydrate(wrap);
  }

  function allowCreate() { return opts.allowCreate !== false; }
  function choose(cat) {
    cat = (cat || '').trim(); if (!cat) return;
    // Navigate/reuse mode can't create folders — you only open ones that exist.
    if (!allowCreate() && categories().indexOf(cat) === -1) return;
    // A custom consumer (e.g. the filter opening a folder) handles the choice.
    if (typeof opts.onChoose === 'function') {
      if (allowCreate() && typeof global.ensureCategory === 'function') global.ensureCategory(cat);
      close();
      opts.onChoose(cat);
      return;
    }
    // Default: assign the chosen folder to the entry being edited.
    if (typeof global.ensureCategory === 'function') global.ensureCategory(cat);
    var input = el('categoryInput');
    if (input) {
      if (!Array.prototype.some.call(input.options, function (o) { return o.value === cat; })) {
        var o = document.createElement('option'); o.value = cat; o.textContent = cat; input.appendChild(o);
      }
      input.value = cat;
    }
    close();
  }

  // open() or open({ onChoose, title, allowCreate }). No args = assign mode (sets the
  // entry modal's category). A custom onChoose reuses the same dialog elsewhere.
  function open(options) {
    opts = options || {};
    var d = dlg(); if (!d) return;
    var titleEl = d.querySelector('header strong');
    if (titleEl) titleEl.textContent = opts.title || 'Choose Folder';
    var addBtn = el('catPickAddBtn');
    if (addBtn) addBtn.style.display = allowCreate() ? '' : 'none';
    q = ''; var s = el('catPickSearch');
    if (s) { s.value = ''; s.placeholder = allowCreate() ? 'Search — or type a new folder and press Enter' : 'Search folders…'; }
    render();
    if (typeof d.showModal === 'function') { try { d.showModal(); } catch (_e) { d.setAttribute('open', ''); } }
    else d.setAttribute('open', '');
    if (s) setTimeout(function () { try { s.focus(); } catch (_e) {} }, 40);
  }
  function close() { var d = dlg(); if (!d) return; if (typeof d.close === 'function') { try { d.close(); } catch (_e) { d.removeAttribute('open'); } } else d.removeAttribute('open'); }

  function wire() {
    var openBtn = el('catPickerBtn');
    if (openBtn) openBtn.addEventListener('click', function (e) { e.preventDefault(); open(); });
    // Filter reuse: the same Choose Folder dialog, but choosing opens (navigates
    // into) that folder — which routes through the global filter (openCategory).
    var navBtn = el('filterChooseFolderBtn');
    if (navBtn) navBtn.addEventListener('click', function (e) {
      e.preventDefault();
      open({
        title: 'Choose Folder',
        allowCreate: false,
        onChoose: function (cat) {
          var fd = el('filtersDlg'); if (fd && fd.open) { try { fd.close(); } catch (_e) {} }
          var v = global.MemoVariant;
          if (v && typeof v.openCategory === 'function') v.openCategory(cat);
        },
      });
    });
    var d = dlg(); if (!d) return;
    var list = el('catPickList');
    if (list) list.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-cat]'); if (b) choose(b.dataset.cat); });
    var s = el('catPickSearch');
    if (s) {
      s.addEventListener('input', function () { q = s.value.toLowerCase().trim(); render(); });
      s.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); choose(s.value); } });
    }
    var tl = el('catPickViewList'), tc = el('catPickViewCard');
    if (tl) tl.addEventListener('click', function () { setView('list'); });
    if (tc) tc.addEventListener('click', function () { setView('card'); });
    var addBtn = el('catPickAddBtn');
    if (addBtn) addBtn.addEventListener('click', function () { choose((el('catPickSearch') || {}).value || ''); });
    var closeBtn = el('catPickClose'); if (closeBtn) closeBtn.addEventListener('click', function () { close(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoCategoryPicker = { open: open, close: close, __render: render };
})(window);
