// memo-health.js — Library Health score + the Organize quiz.
//
// Per-entry organization score: +1 for having any tags, +1 for being filed in a
// real folder (category ≠ Uncategorized). A Settings section shows a
// green/amber/grey bar (organized / in-progress / unorganized) with counts and
// an overall %, plus a "Start organizing" button. That opens a focused quiz that
// surfaces the least-organized entries one at a time so you can give each a
// folder + tags fast — each save runs through MemoCore.batchApply (same
// op-queue/sync path). Operates on the current page's variant (its live entries).
(function (global) {
  'use strict';
  function core() { return global.MemoCore; }
  function state() { try { return core().getState(); } catch (_e) { return null; } }
  function liveEntries() { var s = state(); return s ? (s.db.entries || []).filter(function (e) { return !e.deletedAt; }) : []; }
  function categories() { var s = state(); return (s && s.settings && s.settings.categories) || []; }
  function el(id) { return document.getElementById(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = String(v); }
  function escHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

  function computeScore(e) {
    var s = 0;
    if (Array.isArray(e.tags) && e.tags.length > 0) s++;
    if (e.category && e.category !== 'Uncategorized') s++;
    return s;
  }

  // ── Health bar ──
  function refresh() {
    var green = el('healthBarGreen'), amber = el('healthBarAmber');
    if (!green || !amber) return;
    var entries = liveEntries();
    var total = entries.length;
    if (!total) {
      green.style.width = '0%'; amber.style.width = '0%';
      ['healthOrganized', 'healthPartial', 'healthUnorg', 'healthTotal'].forEach(function (id) { setText(id, '0'); });
      setText('healthScore', '—');
      return;
    }
    var c2 = 0, c1 = 0;
    entries.forEach(function (e) { var s = computeScore(e); if (s === 2) c2++; else if (s === 1) c1++; });
    var c0 = total - c2 - c1;
    green.style.width = (c2 / total * 100).toFixed(1) + '%';
    amber.style.width = (c1 / total * 100).toFixed(1) + '%';
    setText('healthOrganized', c2); setText('healthPartial', c1); setText('healthUnorg', c0); setText('healthTotal', total);
    setText('healthScore', Math.round((c2 * 2 + c1) / (total * 2) * 100) + '%'); // avg per-entry score → %
  }

  // ── Quiz ──
  var queue = [], idx = 0, quizTags = new Set();
  var LIMIT = 10;

  function openQuiz() {
    queue = liveEntries()
      .map(function (e) { return { e: e, s: computeScore(e) }; })
      .filter(function (o) { return o.s < 2; })
      .sort(function (a, b) { return a.s - b.s || (b.e.ts || 0) - (a.e.ts || 0); })
      .slice(0, LIMIT)
      .map(function (o) { return o.e; });
    if (!queue.length) { window.MemoShell && window.MemoShell.toast('Everything is already organized — nice work!', { kind: 'success' }); return; }
    idx = 0;
    loadCard(0);
    var dlg = el('quizDlg'); if (dlg && !dlg.open) dlg.showModal();
  }
  function close() { var dlg = el('quizDlg'); if (dlg && dlg.open) dlg.close(); refresh(); }

  function loadCard(i) {
    var entry = queue[i]; if (!entry) return;
    setText('quizProgress', (i + 1) + ' of ' + queue.length);
    var img = el('quizPreview'), empty = el('quizPreviewEmpty');
    var src = (entry.images || []).filter(function (u) { return core().isImage(u); })[0];
    if (img) {
      if (src) { img.src = src; img.style.display = ''; if (empty) empty.style.display = 'none'; }
      else { img.removeAttribute('src'); img.style.display = 'none'; if (empty) empty.style.display = ''; }
    }
    setText('quizDesc', entry.description || '(No description)');

    var sel = el('quizCategory');
    if (sel) {
      var cats = categories().slice();
      if (cats.indexOf('Uncategorized') < 0) cats.unshift('Uncategorized');
      var cur = entry.category || 'Uncategorized';
      if (cats.indexOf(cur) < 0) cats.push(cur);
      sel.innerHTML = cats.map(function (c) { return '<option value="' + escAttr(c) + '"' + (c === cur ? ' selected' : '') + '>' + escHtml(c) + '</option>'; }).join('');
    }
    var nc = el('quizNewCat'); if (nc) nc.value = '';
    quizTags = new Set(entry.tags || []);
    renderChips();
    var ti = el('quizTagInput'); if (ti) ti.value = '';
    setText('quizSaveBtn', i < queue.length - 1 ? 'Save & Next' : 'Save & Done');
    var back = el('quizBackBtn'); if (back) back.disabled = i === 0;
  }
  function renderChips() {
    var box = el('quizTagChips'); if (!box) return;
    box.innerHTML = Array.from(quizTags).map(function (t) { return '<span class="tagpill removable" data-tag="' + escAttr(t) + '">#' + escHtml(t) + ' ✕</span>'; }).join('');
    box.querySelectorAll('.tagpill').forEach(function (chip) {
      chip.addEventListener('click', function () { quizTags['delete'](chip.getAttribute('data-tag')); renderChips(); });
    });
  }
  function addTagFromInput() {
    var ti = el('quizTagInput'); if (!ti) return;
    var v = ti.value.trim();
    if (v) { quizTags.add(v); renderChips(); }
    ti.value = '';
  }
  function addNewCategory() {
    var nc = el('quizNewCat'); if (!nc) return;
    var v = nc.value.trim();
    if (!v) return;
    var sel = el('quizCategory');
    if (sel && !Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) {
      var opt = document.createElement('option'); opt.value = v; opt.textContent = v; sel.appendChild(opt);
    }
    if (sel) sel.value = v;
    nc.value = '';
  }

  async function advance(save) {
    var entry = queue[idx];
    if (save && entry) {
      var cat = (el('quizCategory') || {}).value || 'Uncategorized';
      var newTags = Array.from(quizTags);
      var orig = entry.tags || [];
      var addTags = newTags.filter(function (t) { return orig.indexOf(t) < 0; });
      var removeTags = orig.filter(function (t) { return newTags.indexOf(t) < 0; });
      if (core() && core().batchApply) await core().batchApply([entry.id], { category: cat, addTags: addTags, removeTags: removeTags });
      // Reflect on the in-memory queue entry so Back shows the saved state.
      entry.category = cat; entry.tags = newTags;
    }
    refresh();
    if (idx < queue.length - 1) { idx++; loadCard(idx); }
    else close();
  }
  function back() { if (idx > 0) { idx--; loadCard(idx); } }

  function wire() {
    var startBtn = el('healthStartBtn'); if (startBtn) startBtn.addEventListener('click', openQuiz);
    var section = el('libraryHealthSection');
    if (section) { var h = section.querySelector('h3'); if (h) h.addEventListener('click', refresh); }
    clickWire('quizSkipBtn', function () { advance(false); });
    clickWire('quizSaveBtn', function () { advance(true); });
    clickWire('quizBackBtn', back);
    clickWire('quizCloseBtn', close);
    clickWire('quizAddCatBtn', addNewCategory);
    clickWire('quizAddTagBtn', addTagFromInput);
    var ti = el('quizTagInput');
    if (ti) ti.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); } });
    var nc = el('quizNewCat');
    if (nc) nc.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addNewCategory(); } });
    refresh();
  }
  function clickWire(id, fn) { var e = el(id); if (e) e.addEventListener('click', fn); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoHealth = { computeScore: computeScore, refresh: refresh, openQuiz: openQuiz, close: close };
})(window);
