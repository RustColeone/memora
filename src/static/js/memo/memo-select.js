// memo-select.js — multi-select + batch edit for the memo feed (memo variant).
// Long-press a card to enter select mode; tap cards to toggle; a toolbar offers
// Invert / None / Delete / Edit / Exit. The Edit dialog batch-sets a category,
// adds a tag, or removes tags shared by every selected entry. Batch mutations
// run through MemoCore.batchDelete / batchApply (same op-queue/sync semantics).
(function (global) {
  'use strict';
  var selected = new Set();
  var isActive = false;
  var suppressClickUntil = 0; // guards the synthetic click after a long-press

  function feed() { return document.getElementById('feed'); }
  function core() { return global.MemoCore; }
  function entries() { try { return core().getState().db.entries || []; } catch (_e) { return []; } }
  function liveEntries() { return entries().filter(function (e) { return !e.deletedAt; }); }
  function selectedEntries() { return liveEntries().filter(function (e) { return selected.has(e.id); }); }
  function selectionHaptic() {
    if (global.MemoNativeUi) void global.MemoNativeUi.haptic('selection');
  }

  function active() { return isActive; }
  function has(id) { return selected.has(id); }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function reflectCard(id) {
    var f = feed(); if (!f) return;
    var el = f.querySelector('.card[data-id="' + cssEsc(id) + '"]');
    if (el) el.classList.toggle('selected', selected.has(id));
  }

  // ── Folders select as a unit ──────────────────────────────────────────────
  // At the root you can't see the entries inside a folder, so you can't select
  // them one by one — you select or deselect the WHOLE folder. Internally that's
  // just "every entry in this category", but to the user it's one highlighted
  // folder card.
  function folderIds(cat) {
    return liveEntries().filter(function (e) { return (e.category || 'Uncategorized') === cat; }).map(function (e) { return e.id; });
  }
  function folderSelected(cat) {
    var ids = folderIds(cat);
    return ids.length > 0 && ids.every(function (id) { return selected.has(id); });
  }
  function reflectFolder(cat) {
    var f = feed(); if (!f) return;
    var el = f.querySelector('.folder-card[data-folder="' + cssEsc(cat) + '"]');
    if (el) el.classList.toggle('selected', folderSelected(cat));
  }
  function toggleFolder(cat) {
    if (!isActive) enter();
    var ids = folderIds(cat);
    if (!ids.length) return;
    if (folderSelected(cat)) ids.forEach(function (id) { selected.delete(id); });
    else ids.forEach(function (id) { selected.add(id); });
    selectionHaptic();
    reflectFolder(cat);
    updateBar();
  }

  function enter(id, fromLongPress) {
    isActive = true;
    document.body.classList.add('select-mode');
    var f = feed(); if (f) f.classList.add('selecting');
    if (id && !selected.has(id)) { selected.add(id); selectionHaptic(); }
    if (fromLongPress) suppressClickUntil = Date.now() + 500;
    render();
  }
  function exit() {
    isActive = false;
    selected.clear();
    document.body.classList.remove('select-mode');
    var f = feed();
    if (f) { f.classList.remove('selecting'); f.querySelectorAll('.card.selected').forEach(function (c) { c.classList.remove('selected'); }); }
    updateBar();
  }
  function toggle(id) {
    if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; }
    if (!isActive) enter();
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    selectionHaptic();
    reflectCard(id);
    updateBar();
  }
  function selectNone() { selected.clear(); render(); }
  function invert() {
    liveEntries().forEach(function (e) { if (selected.has(e.id)) selected.delete(e.id); else selected.add(e.id); });
    render();
  }

  // Re-apply visual state to every rendered card (after a feed re-render) — both
  // individual entry cards and whole-folder cards.
  function render() {
    var f = feed(); if (!f) return;
    f.classList.toggle('selecting', isActive);
    f.querySelectorAll('.card[data-id]').forEach(function (c) { c.classList.toggle('selected', selected.has(c.dataset.id)); });
    const counts = new Map();
    if (isActive) liveEntries().forEach(e => {
      const cat = e.category || 'Uncategorized';
      const value = counts.get(cat) || { total: 0, selected: 0 };
      value.total++; if (selected.has(e.id)) value.selected++;
      counts.set(cat, value);
    });
    f.querySelectorAll('.folder-card[data-folder]').forEach(c => {
      const value = counts.get(c.dataset.folder);
      c.classList.toggle('selected', !!value && value.total === value.selected);
    });
    updateBar();
  }

  // Called by buildCard for each entry card — re-applies the selected class after a
  // re-render. Long-press no longer enters select mode directly; it opens the shared
  // context menu (MemoCtx), whose "Select" item calls enter(). See buildCard.
  function decorate(card, id) {
    if (isActive && selected.has(id)) card.classList.add('selected');
  }

  // ── toolbar ──
  function updateBar() {
    var b = document.getElementById('selectBar'); if (!b) return;
    b.classList.toggle('open', isActive);
    b.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    b.inert = !isActive;
    var count = document.getElementById('selectCount');
    if (count) count.textContent = selected.size + ' selected';
    var editBtn = document.getElementById('selectEdit');
    var delBtn = document.getElementById('selectDelete');
    if (editBtn) editBtn.disabled = selected.size === 0;
    if (delBtn) delBtn.disabled = selected.size === 0;
  }

  async function doDelete() {
    if (!selected.size) return;
    var ids = Array.from(selected);
    if (core() && core().batchDelete) await core().batchDelete(ids);
    exit();
    if (window.MemoShell) {
      window.MemoShell.toast('Moved ' + ids.length + ' to recycle bin', { action: { label: 'Undo', onClick: function () {
        var c = core(); if (c && c.restore) ids.forEach(function (id) { c.restore(id); });
      } } });
    }
  }

  // ── batch edit dialog ──
  function escHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

  function openEdit() {
    if (!selected.size) return;
    var dlg = document.getElementById('batchEditDlg'); if (!dlg) return;
    var sel = document.getElementById('batchCategory');
    if (sel) {
      var cats = [];
      try { cats = core().getState().settings.categories || []; } catch (_e) {}
      sel.innerHTML = '<option value="">— keep current —</option>' + cats.map(function (c) { return '<option value="' + escAttr(c) + '">' + escHtml(c) + '</option>'; }).join('');
    }
    var addInput = document.getElementById('batchAddTag'); if (addInput) addInput.value = '';
    var chips = document.getElementById('batchCommonTags');
    if (chips) {
      var sels = selectedEntries();
      var common = sels.length ? (sels[0].tags || []).slice() : [];
      sels.forEach(function (e) { common = common.filter(function (t) { return (e.tags || []).indexOf(t) >= 0; }); });
      chips.innerHTML = common.length
        ? common.map(function (t) { return '<button type="button" class="tagpill removable" data-tag="' + escAttr(t)
          + '" aria-pressed="false" aria-label="Remove ' + escAttr(t) + ' from all selected entries">#'
          + escHtml(t) + ' <span aria-hidden="true">✕</span></button>'; }).join('')
        : '<span class="muted" style="font-size:12px">No tags shared by all selected</span>';
    }
    var countEl = document.getElementById('batchEditCount'); if (countEl) countEl.textContent = selected.size + ' selected';
    dlg.showModal();
  }
  async function applyEdit() {
    var ids = Array.from(selected);
    var category = (document.getElementById('batchCategory') || {}).value || '';
    var addTag = ((document.getElementById('batchAddTag') || {}).value || '').trim();
    var removeTags = [];
    var chips = document.getElementById('batchCommonTags');
    if (chips) chips.querySelectorAll('.tagpill.removable.pending-remove').forEach(function (c) { removeTags.push(c.getAttribute('data-tag')); });
    var patch = {};
    if (category) patch.category = category;
    if (addTag) patch.addTags = [addTag];
    if (removeTags.length) patch.removeTags = removeTags;
    if (Object.keys(patch).length && core() && core().batchApply) await core().batchApply(ids, patch);
    var dlg = document.getElementById('batchEditDlg'); if (dlg) dlg.close();
    exit();
  }

  function wire(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); }
  function init() {
    wire('selectExit', exit);
    wire('selectNone', selectNone);
    wire('selectInvert', invert);
    wire('selectDelete', doDelete);
    wire('selectEdit', openEdit);
    wire('batchEditCancel', function () { var d = document.getElementById('batchEditDlg'); if (d) d.close(); });
    wire('batchEditApply', applyEdit);
    var chips = document.getElementById('batchCommonTags');
    if (chips) chips.addEventListener('click', function (ev) {
      var chip = ev.target.closest ? ev.target.closest('.tagpill.removable') : null;
      if (chip) {
        var marked = chip.classList.toggle('pending-remove');
        chip.setAttribute('aria-pressed', String(marked));
      }
    });
    // Escape exits select mode (before dialogs, which handle their own Escape).
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isActive && !document.querySelector('dialog[open]')) exit();
    });
    updateBar();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.MemoSelect = { active: active, has: has, toggle: toggle, toggleFolder: toggleFolder, folderSelected: folderSelected, decorate: decorate, enter: enter, exit: exit, render: render };
})(window);
