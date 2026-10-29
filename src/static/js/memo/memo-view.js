// memo-view.js — "Adjust View" controls (memo variant; finance is a table).
//  • Card size: a persisted <body> class (.cards-s/m/l/xl) drives the feed's
//    card density via the --card-min CSS var (see memo.css).
//  • Date format: how each card's timestamp reads — locale auto / explicit
//    ordering (MM/DD/YYYY · DD/MM/YYYY · YYYY/MM/DD) / relative ("3 days ago").
//    fmtDate() in memo-core.js delegates here.
(function (global) {
  'use strict';

  // ── Card size ──
  var SIZE_KEY = 'memoCardSize';
  var SIZES = ['s', 'm', 'l', 'xl'];
  function readSize() { try { return localStorage.getItem(SIZE_KEY) || 'm'; } catch (_e) { return 'm'; } }
  function applySize(size) {
    if (SIZES.indexOf(size) < 0) size = 'm';
    var b = document.body;
    b.classList.remove('cards-s', 'cards-m', 'cards-l', 'cards-xl');
    b.classList.add('cards-' + size);
    markActive('cardSizeCtrl', 'data-size', size);
  }
  function setSize(size) {
    try { localStorage.setItem(SIZE_KEY, size); } catch (_e) {} applySize(size);
    // Card width changed → re-fit each card's one-line tag row (+N overflow).
    if (global.MemoVariant && global.MemoVariant.relayoutTags) global.MemoVariant.relayoutTags();
  }

  // ── Date format ──
  var FMT_KEY = 'memoDateFormat';
  var FORMATS = ['auto', 'mdy', 'dmy', 'ymd', 'rel'];
  function readFmt() { try { var v = localStorage.getItem(FMT_KEY); return FORMATS.indexOf(v) >= 0 ? v : 'auto'; } catch (_e) { return 'auto'; } }

  function pad(n) { return String(n).padStart(2, '0'); }
  function relative(ts) {
    var diff = Date.now() - ts, abs = Math.abs(diff);
    var MIN = 60000, HR = 3600000, DAY = 86400000;
    if (abs < 45000) return 'just now';
    var suffix = diff < 0 ? ' from now' : ' ago';
    function unit(n, word) { return n + ' ' + word + (n === 1 ? '' : 's') + suffix; }
    if (abs < HR) return unit(Math.round(abs / MIN), 'min');
    if (abs < DAY) return unit(Math.round(abs / HR), 'hour');
    if (abs < 7 * DAY) return unit(Math.round(abs / DAY), 'day');
    return new Date(ts).toLocaleDateString(); // older than a week → plain date
  }
  // The single source of truth for card timestamps; fmtDate() calls this.
  function formatWith(ts, fmt) {
    var d = new Date(ts);
    if (fmt === 'rel') return relative(ts);
    var mm = pad(d.getMonth() + 1), dd = pad(d.getDate()), yyyy = d.getFullYear();
    if (fmt === 'mdy') return mm + '/' + dd + '/' + yyyy;
    if (fmt === 'dmy') return dd + '/' + mm + '/' + yyyy;
    if (fmt === 'ymd') return yyyy + '/' + mm + '/' + dd;
    return d.toLocaleString(); // 'auto' → device locale date + time
  }
  function formatDate(ts) { return formatWith(ts, readFmt()); }
  // Card timestamps are date-only — the exact hour/minute isn't useful at card
  // scale (open the entry for that). Explicit formats are already date-only; only
  // 'auto' (locale) would add a time, so drop it.
  function formatCardDate(ts) {
    var fmt = readFmt();
    if (fmt === 'auto') { try { return new Date(ts).toLocaleDateString(); } catch (_e) { return formatWith(ts, fmt); } }
    return formatWith(ts, fmt);
  }
  function applyFmt(fmt) {
    if (FORMATS.indexOf(fmt) < 0) fmt = 'auto';
    var sel = document.getElementById('dateFmtSelect');
    if (sel && sel.value !== fmt) sel.value = fmt;
  }
  function setFmt(fmt) {
    try { localStorage.setItem(FMT_KEY, fmt); } catch (_e) {}
    applyFmt(fmt);
    // Re-render so every visible card's date reflects the new format immediately.
    if (global.MemoCore && global.MemoCore.renderFeed) global.MemoCore.renderFeed();
  }

  // ── shared ──
  function syncChoiceGroup(ctrlId, attr, value, enabled) {
    var ctrl = document.getElementById(ctrlId);
    if (!ctrl) return;
    var isEnabled = enabled !== false;
    ctrl.setAttribute('aria-disabled', String(!isEnabled));
    ctrl.querySelectorAll('button').forEach(function (btn) {
      var selected = btn.getAttribute(attr) === value;
      btn.classList.toggle('active', selected);
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(selected));
      btn.disabled = !isEnabled;
      btn.tabIndex = isEnabled && selected ? 0 : -1;
    });
  }

  function markActive(ctrlId, attr, value) {
    syncChoiceGroup(ctrlId, attr, value, true);
  }

  function wireChoiceGroup(ctrlId, attr, fn) {
    var ctrl = document.getElementById(ctrlId);
    if (!ctrl || ctrl.dataset.memoChoiceWired === 'true') return;
    ctrl.dataset.memoChoiceWired = 'true';
    var buttons = Array.prototype.slice.call(ctrl.querySelectorAll('button'));
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () { fn(btn.getAttribute(attr)); });
    });
    ctrl.addEventListener('keydown', function (event) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(event.key) < 0) return;
      var available = buttons.filter(function (button) { return !button.disabled; });
      var current = available.indexOf(event.target.closest('button'));
      if (current < 0 || !available.length) return;
      var next = event.key === 'Home' ? 0
        : event.key === 'End' ? available.length - 1
          : (current + ((event.key === 'ArrowLeft' || event.key === 'ArrowUp') ? -1 : 1) + available.length) % available.length;
      event.preventDefault();
      available[next].focus();
      available[next].click();
    });
  }

  function wireCtrl(ctrlId, attr, fn) {
    wireChoiceGroup(ctrlId, attr, fn);
  }
  function init() {
    applySize(readSize());
    applyFmt(readFmt());
    wireCtrl('cardSizeCtrl', 'data-size', setSize);
    wireDateFmtSelect();
    initAdjustView();
  }

  // Date-format dropdown: options carry literal patterns (MM/DD/YYYY, …) so the
  // ordering a user picks is self-evident. Sync the current value and re-render
  // on change.
  function wireDateFmtSelect() {
    var sel = document.getElementById('dateFmtSelect');
    if (!sel) return;
    sel.value = readFmt();
    sel.addEventListener('change', function () { setFmt(sel.value); });
  }

  // The Adjust View dialog groups card-size, group-by-time and date-format
  // controls. Opened from the hamburger menu's "Adjust View" button; the inner
  // controls keep their original ids so their existing wiring runs untouched.
  function initAdjustView() {
    var dlg = document.getElementById('viewSettingsDlg');
    if (!dlg) return;
    var openBtn = document.getElementById('mobileAdjustViewBtn');
    if (openBtn) openBtn.addEventListener('click', function () {
      if (global.MemoTheme && global.MemoTheme.closeMobileMenu) global.MemoTheme.closeMobileMenu();
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    });
    // The top-right ✕ (injected by memo-ctxmenu) and the backdrop both close it.
    dlg.addEventListener('click', function (ev) {
      if (ev.target === dlg) dlg.close();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.MemoView = {
    setCardSize: setSize, applyCardSize: applySize, getCardSize: readSize,
    setDateFormat: setFmt, applyDateFormat: applyFmt, getDateFormat: readFmt, formatDate: formatDate, formatCardDate: formatCardDate,
    syncChoiceGroup: syncChoiceGroup, wireChoiceGroup: wireChoiceGroup,
  };
})(window);
