// Restore the actual view and mounted window before applying its scroll anchor.
(function (global) {
  'use strict';
  const KEY = 'memo.view.v2';
  let record = { version: 2, views: {} };
  try { const saved = JSON.parse(sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || 'null');
    if (saved?.version === 2 && saved.views) record = saved;
  } catch (_) {}
  const details = new Map();
  let applying = false, frame = 0;
  global.__memoRestoring = !!record.variant;
  function variant() { return global.MEMO_VARIANT || 'default'; }
  function nodes() { return [...document.querySelectorAll('#feed .card[data-id], #feed .entry-row[data-id]')]; }
  // Checkpoint layout coordinates. Entrance transforms are transient and must
  // not become an extra scroll offset after a process restart.
  function layoutTop(node) {
    let top = 0;
    for (let current = node; current; current = current.offsetParent) {
      top += current.offsetTop;
      if (current.offsetParent) top += current.offsetParent.clientTop;
    }
    for (let parent = node.parentElement; parent && parent !== document.scrollingElement; parent = parent.parentElement) top -= parent.scrollTop;
    return top - document.scrollingElement.scrollTop;
  }
  function save() {
    if (applying || !global.MemoStateDb?.ready?.()) return;
    const v = variant(), state = global.MemoCore?.getState?.();
    const rows = nodes();
    const anchor = rows.find(n => n.offsetHeight > 0 && layoutTop(n) + n.offsetHeight > 65);
    const filter = state?.activeFilters || {};
    record.variant = v;
    record.views[v] = {
      scrollTop: document.scrollingElement.scrollTop,
      anchor: anchor ? { id: anchor.dataset.id, offset: layoutTop(anchor),
        index: rows.indexOf(anchor) } : null,
      query: document.getElementById('searchBox')?.value || '',
      category: document.getElementById('categoryFilter')?.value || '__ALL__',
      filters: { ...filter, cats: [...(filter.cats || [])], tags: [...(filter.tags || [])] },
      detailId: document.getElementById('detailDlg')?.open ? document.getElementById('detailDlg').dataset.entryId : null,
      view: v === 'planner' ? null : global.MemoVariant?.captureView?.()
    };
    try { const data = JSON.stringify(record); sessionStorage.setItem(KEY, data); localStorage.setItem(KEY, data); } catch (_) {}
  }
  function scheduleSave() {
    if (frame || applying) return;
    frame = requestAnimationFrame(() => { frame = 0; save(); });
  }
  function prepare(v) {
    const saved = record.views[v];
    if (!saved) return;
    details.set(v, saved.detailId);
    applying = true;
    global.__memoRestoring = true;
    const state = global.MemoCore?.getState?.();
    const search = document.getElementById('searchBox'); if (search) search.value = saved.query || '';
    const category = document.getElementById('categoryFilter');
    if (category && [...category.options].some(o => o.value === saved.category)) category.value = saved.category;
    if (state && saved.filters && v !== 'planner') Object.assign(state.activeFilters, saved.filters,
      { cats: new Set(saved.filters.cats || []), tags: new Set(saved.filters.tags || []) });
    if (v !== 'planner') global.MemoVariant?.restoreView?.(saved.view || {});
  }
  async function ready() {
    const v = variant(), saved = record.views[v];
    await new Promise(requestAnimationFrame);
    if (applying && saved) {
      if (global.history) global.history.scrollRestoration = 'manual';
      const rows = nodes();
      const target = rows.find(n => n.dataset.id === saved.anchor?.id) || rows[Math.min(saved.anchor?.index || 0, rows.length - 1)];
      if (target && saved.anchor) window.scrollBy(0, layoutTop(target) - saved.anchor.offset);
      else document.scrollingElement.scrollTop = saved.scrollTop || 0;
    }
    applying = false; global.__memoRestoring = false;
    global.MemoLifecycle?.trace('view-ready', { variant: v, mounted: nodes().length });
    save();
    global.dispatchEvent(new CustomEvent('memo:view-ready', { detail: { variant: v } }));
  }
  async function restoreDetail() {
    const v = variant(), id = details.get(v); details.delete(v);
    if (!id || document.getElementById('entryDlg')?.open) return;
    const entry = global.MemoCore?.getState?.().db.entries.find(e => e.id === id);
    if (entry && (!global.MemoPrivacy || global.MemoPrivacy.canViewEntry(entry))) await global.MemoVariant?.openDetail?.(id);
  }
  global.MemoRestore = { prepare, restoreDetail, ready, save, scheduleSave, isRestoring: () => applying,
    initialVariant: () => record.variant, reveal: () => { applying = false; global.__memoRestoring = false; } };
  global.addEventListener('scroll', scheduleSave, { passive: true });
  document.addEventListener('input', scheduleSave);
  document.addEventListener('change', scheduleSave);
  document.addEventListener('click', scheduleSave);
  global.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
})(window);
