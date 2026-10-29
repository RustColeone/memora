// memo-tag-picker.js — a two-panel tag picker for the entry modal.
//
// Applied tags sit in the top panel, all other tags in the bottom panel, with a
// search box that filters both. Tapping a pill toggles membership and *animates it
// across* to the other panel (FLIP). It edits window.workingTags directly and calls
// window.renderTagChips(), so the modal's inline #tagChips stay in sync — the dialog
// is purely an alternative way to add/remove; there's no separate "apply".
(function (global) {
  'use strict';

  var q = '';   // current search filter (lowercased)

  function dlg() { return document.getElementById('tagPickerDlg'); }
  function el(id) { return document.getElementById(id); }
  function settings() { try { return (global.MemoCore.getState().settings) || {}; } catch (_e) { return {}; } }
  function applied() { return global.workingTags || new Set(); }
  function drafts() { return global.workingTagDrafts || new Set(); }
  function reduced() { return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function attrEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function matchesQ(t) { return !q || t.toLowerCase().indexOf(q) !== -1; }
  function includesIgnoreCase(values, tag) {
    var wanted = String(tag || '').toLowerCase();
    return Array.from(values || []).some(function (value) { return String(value || '').toLowerCase() === wanted; });
  }
  function addDraft(tag) {
    var existing = settings().tags || [];
    if (!includesIgnoreCase(existing, tag) && !includesIgnoreCase(drafts(), tag)) drafts().add(tag);
  }
  // The explicit Done action commits only tags currently associated with the
  // entry. Unchecked draft names remain intentionally ephemeral and should not
  // linger in the next picker opening, nor be written to settings.tags.
  function reconcileDrafts() {
    var app = applied();
    Array.from(drafts()).forEach(function (tag) { if (!app.has(tag)) drafts().delete(tag); });
  }

  function pill(t, inApplied) {
    var counts = settings().tagCounts || {};
    var n = counts[t] ? ' <em>' + counts[t] + '</em>' : '';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tagpill tag-pick';
    b.dataset.tag = t;
    b.setAttribute('aria-pressed', String(inApplied));
    b.setAttribute('aria-label', (inApplied ? 'Remove tag ' : 'Add tag ') + t);
    b.innerHTML = (inApplied ? '' : '<span class="pk-op">+</span>') + '#' + escHtml(t) + n;
    return b;
  }

  function render() {
    var apPanel = el('tagPickApplied'), avPanel = el('tagPickAvailable');
    if (!apPanel || !avPanel) return;
    var app = applied();
    var all = (settings().tags || []).slice();
    drafts().forEach(function (t) { if (all.indexOf(t) === -1) all.push(t); });
    app.forEach(function (t) { if (all.indexOf(t) === -1) all.push(t); }); // freshly-added tags not yet in settings.tags
    apPanel.innerHTML = ''; avPanel.innerHTML = '';
    Array.from(app).filter(matchesQ).sort(function (a, b) { return a.localeCompare(b); })
      .forEach(function (t) { apPanel.appendChild(pill(t, true)); });
    all.filter(function (t) { return !app.has(t) && matchesQ(t); })
      .forEach(function (t) { avPanel.appendChild(pill(t, false)); });
    var ea = el('tagPickAppliedEmpty'); if (ea) ea.hidden = apPanel.children.length > 0;
    var ev = el('tagPickAvailEmpty'); if (ev) ev.hidden = avPanel.children.length > 0;
  }

  // FLIP: mutate the set, re-render, then animate the moved pill's twin from its
  // old screen position to its new one so it visibly slides across.
  function flipMove(fromBtn, toPanel, mutate) {
    if (reduced() || !fromBtn) { mutate(); render(); return; }
    var first = fromBtn.getBoundingClientRect();
    mutate();
    render();
    var twin = toPanel.querySelector('.tag-pick[data-tag="' + attrEsc(fromBtn.dataset.tag) + '"]');
    if (!twin) return;
    var last = twin.getBoundingClientRect();
    var dx = first.left - last.left, dy = first.top - last.top;
    if (!dx && !dy) return;
    twin.style.transition = 'none';
    twin.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    twin.classList.add('flipping');
    requestAnimationFrame(function () {
      twin.style.transition = 'transform .28s cubic-bezier(.2,.7,.3,1)';
      twin.style.transform = '';
      var done = function () { twin.style.transition = ''; twin.style.transform = ''; twin.classList.remove('flipping'); twin.removeEventListener('transitionend', done); };
      twin.addEventListener('transitionend', done);
      setTimeout(done, 380);
    });
  }

  function onPanelClick(e) {
    var btn = e.target.closest && e.target.closest('.tag-pick');
    if (!btn) return;
    var t = btn.dataset.tag, app = applied();
    if (app.has(t)) flipMove(btn, el('tagPickAvailable'), function () { app.delete(t); });
    else flipMove(btn, el('tagPickApplied'), function () { app.add(t); });
    if (typeof global.renderTagChips === 'function') global.renderTagChips();
  }

  function open() {
    var d = dlg(); if (!d) return;
    q = ''; var s = el('tagPickSearch'); if (s) s.value = '';
    render();
    if (typeof d.showModal === 'function') { try { d.showModal(); } catch (_e) { d.setAttribute('open', ''); } }
    else d.setAttribute('open', '');
    if (s) setTimeout(function () { try { s.focus(); } catch (_e) {} }, 40);
  }
  function close() { var d = dlg(); if (!d) return; if (typeof d.close === 'function') { try { d.close(); } catch (_e) { d.removeAttribute('open'); } } else d.removeAttribute('open'); }

  function wire() {
    var openBtn = el('tagPickerBtn');
    if (openBtn) openBtn.addEventListener('click', function (e) { e.preventDefault(); open(); });
    var d = dlg(); if (!d) return;
    var ap = el('tagPickApplied'), av = el('tagPickAvailable');
    if (ap) ap.addEventListener('click', onPanelClick);
    if (av) av.addEventListener('click', onPanelClick);
    var s = el('tagPickSearch');
    if (s) {
      s.addEventListener('input', function () { q = s.value.toLowerCase().trim(); render(); });
      s.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var v = s.value.trim(); if (!v) return;
        addDraft(v);
        applied().add(v);
        if (typeof global.renderTagChips === 'function') global.renderTagChips();
        s.value = ''; q = ''; render();
      });
    }
    // Escape or a system Back returns to the active entry editor without making
    // a tag decision. Only Done reconciles unassociated draft names; closing the
    // entry editor itself still clears every draft in MemoCore.
    var closeBtn = el('tagPickClose'); if (closeBtn) closeBtn.addEventListener('click', function () { reconcileDrafts(); close(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoTagPicker = { open: open, close: close, __render: render, __reconcileDrafts: reconcileDrafts };
})(window);
