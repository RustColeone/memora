/* ---------- Filters & Tag Manager UI ---------- */
console.log('🔍 memo-filter.js starting, els.categoryFilter=', els.categoryFilter, 'els.filtersBtn=', els.filtersBtn);
// Category switches (folder open, Home, the dropdown) cross-fade the feed; typing
// in search re-renders in place (no fade — it'd flicker on every keystroke).
els.categoryFilter.addEventListener('change', function () {
  if (window.MemoMotion && MemoMotion.viewTransition && els.feed) MemoMotion.viewTransition(els.feed, renderFeed);
  else renderFeed();
});
// A full feed render scans/sorts the library and rebuilds visible cards. Wait for
// a brief typing pause, commit only the latest query, and never render partial
// IME composition text. The 100ms window is short enough to feel immediate while
// avoiding dozens of redundant layouts during a burst of input.
let searchComposing = false;
let searchFallbackTimer = 0;
function cancelSearchRender() {
  clearTimeout(searchFallbackTimer);
  searchFallbackTimer = 0;
  if (window.MemoMotion && MemoMotion.cancelScheduled) MemoMotion.cancelScheduled(els.searchBox);
}
function scheduleSearchRender() {
  if (searchComposing) return;
  if (window.MemoMotion && MemoMotion.schedule) MemoMotion.schedule(els.searchBox, renderFeed, 100);
  else {
    clearTimeout(searchFallbackTimer);
    searchFallbackTimer = setTimeout(renderFeed, 100);
  }
}
els.searchBox.addEventListener('compositionstart', () => { searchComposing = true; cancelSearchRender(); });
els.searchBox.addEventListener('compositionend', () => { searchComposing = false; scheduleSearchRender(); });
els.searchBox.addEventListener('input', event => {
  if (event.isComposing || searchComposing) return;
  scheduleSearchRender();
});

// Filter-dialog controls edit an isolated draft. The category/tag builders live
// in memo-core.js and historically read/write `activeFilters` directly, so render
// them against the draft temporarily and intercept their checkbox change events
// before those legacy listeners can mutate the applied state.
let filterDraft = null;
// When set, the dialog is editing a caller-supplied filter (e.g. the library
// picker) and returns it via callback instead of committing to the global feed
// filter. Lets that picker reuse this one dialog rather than duplicate it.
let filterCapture = null;
function cloneFilterState(source) {
  return {
    dateFrom: source && source.dateFrom || null,
    dateTo: source && source.dateTo || null,
    cats: new Set(source && source.cats || []),
    tags: new Set(source && source.tags || []),
    tagMatch: (source && source.tagMatch === 'all') ? 'all' : 'any',
    favorite: !!(source && source.favorite),
  };
}
// The folder picker navigates the main feed, which is meaningless for a local
// capture — hide its row while capturing, restore it otherwise.
function applyFilterCaptureUi(capturing) {
  var folderBtn = document.getElementById('filterChooseFolderBtn');
  var folderRow = folderBtn && folderBtn.closest ? folderBtn.closest('.row') : null;
  if (folderRow) folderRow.hidden = !!capturing;
  // "Favourites only" is a main-feed notion; the library picker doesn't use it.
  var favRow = document.getElementById('filterFavoritesRow');
  if (favRow) favRow.hidden = !!capturing;
}
// Open the SAME filters dialog to edit `source` and hand the result to onApply,
// without touching the global activeFilters. Used by MemoLibraryPicker.
function openFilterCapture(source, onApply) {
  if (!els.filtersDlg || els.filtersDlg.open) return;
  filterCapture = { onApply: typeof onApply === 'function' ? onApply : null };
  filterDraft = cloneFilterState(source || null);
  els.filterTagSearch.value = '';
  renderFilterDraftControls();
  buildTagManager();
  els.tagManager.classList.add('hidden');
  switchFilterTab('type');
  applyFilterCaptureUi(true);
  els.filtersDlg.showModal();
}

// ── Filter tag picker: Applied/Available pill panels + match mode ──
// Click a pill to move a tag between Available and Applied (draft-only until
// Apply). Match "any" = OR (has one of the tags), "all" = AND (has every tag).
function _filterTagPill(tag, applied, count) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tag-pill-btn' + (applied ? ' applied' : '');
  b.dataset.tag = tag;
  const label = document.createElement('span');
  label.textContent = '#' + tag;
  b.appendChild(label);
  if (count) {
    const c = document.createElement('span');
    c.className = 'tp-count';
    c.textContent = String(count);
    b.appendChild(c);
  }
  return b;
}
function renderFilterTagPanels() {
  const appliedEl = document.getElementById('filterTagApplied');
  const availEl = document.getElementById('filterTagAvailable');
  if (!appliedEl || !availEl || !filterDraft) return;
  const q = (els.filterTagSearch && els.filterTagSearch.value || '').toLowerCase().trim();
  const st = window.MemoCore ? window.MemoCore.getState() : {};
  const counts = (st.settings && st.settings.tagCounts) || {};
  const allTags = (st.settings && st.settings.tags) || [];
  const applied = Array.from(filterDraft.tags).filter(t => !q || t.toLowerCase().includes(q));
  const available = allTags.filter(t => !filterDraft.tags.has(t) && (!q || t.toLowerCase().includes(q)));
  appliedEl.innerHTML = '';
  if (!applied.length) appliedEl.innerHTML = '<span class="tag-panel-empty">No tags applied</span>';
  else applied.forEach(t => appliedEl.appendChild(_filterTagPill(t, true, counts[t])));
  availEl.innerHTML = '';
  if (!available.length) availEl.innerHTML = `<span class="tag-panel-empty">${q ? 'No matching tags' : 'No tags yet'}</span>`;
  else available.forEach(t => availEl.appendChild(_filterTagPill(t, false, counts[t])));
}
function _onFilterTagPillClick(event) {
  const btn = event.target && event.target.closest ? event.target.closest('.tag-pill-btn') : null;
  if (!btn || !filterDraft) return;
  const tag = btn.dataset.tag;
  const appliedEl = document.getElementById('filterTagApplied');
  const availEl = document.getElementById('filterTagAvailable');
  const mutate = () => {
    if (filterDraft.tags.has(tag)) filterDraft.tags.delete(tag);
    else filterDraft.tags.add(tag);
    renderFilterTagPanels();
  };
  // Animate the pill sliding to its new home (FLIP): same-panel neighbours slide,
  // the moved pill pops into the other panel. Reusable for any move-tags-around UI.
  if (window.MemoMotion && MemoMotion.flip && appliedEl && availEl) {
    MemoMotion.flip([appliedEl, availEl], mutate, { selector: '.tag-pill-btn', key: el => el.dataset.tag });
  } else mutate();
}
function setFilterTagMode(mode) {
  if (!filterDraft) return;
  filterDraft.tagMatch = (mode === 'all') ? 'all' : 'any';
  const group = document.getElementById('filterTagMode');
  if (group) group.querySelectorAll('.mode-opt').forEach(b => {
    const on = b.dataset.mode === filterDraft.tagMatch;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const hint = document.getElementById('filterTagModeHint');
  if (hint) hint.textContent = (filterDraft.tagMatch === 'all')
    ? 'Shows entries that have every selected tag.'
    : 'Shows entries that have any of the selected tags.';
}
function renderAgainstFilterDraft(renderFn) {
  if (!filterDraft) { renderFn(); return; }
  const applied = activeFilters;
  activeFilters = filterDraft;
  try { renderFn(); }
  finally { activeFilters = applied; }
}
function renderFilterDraftControls() {
  if (!filterDraft) return;
  els.dateFrom.value = filterDraft.dateFrom || '';
  els.dateTo.value = filterDraft.dateTo || '';
  var favChk = document.getElementById('filterFavorites'); if (favChk) favChk.checked = !!filterDraft.favorite;
  renderAgainstFilterDraft(() => {
    refreshCategoryControls();
  });
  setFilterTagMode(filterDraft.tagMatch);
  renderFilterTagPanels();
}
function updateDraftSetFromCheckbox(event, container, dataKey, setKey) {
  if (!filterDraft || !els.filtersDlg.open) return;
  const input = event.target && event.target.closest && event.target.closest(`input[data-${dataKey}]`);
  if (!input || !container.contains(input)) return;
  // The builders attach direct listeners to each input. Stop in capture phase so
  // those applied-state listeners never observe a draft-only interaction.
  event.stopImmediatePropagation();
  const value = input.dataset[dataKey];
  if (input.checked) filterDraft[setKey].add(value);
  else filterDraft[setKey].delete(value);
}
// The per-folder checkbox list was replaced by the Choose-folder picker; guard
// in case the element is absent.
if (els.filterCats) els.filterCats.addEventListener('change', event => {
  updateDraftSetFromCheckbox(event, els.filterCats, 'cat', 'cats');
}, true);

// ── Filter tabs (By Type / By Date) ──────────────────────────────────────────
function switchFilterTab(name) {
  var dlg = els.filtersDlg; if (!dlg) return;
  dlg.querySelectorAll('.filter-tab').forEach(function (t) {
    var on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  var typePanel = document.getElementById('filterTabType');
  var datePanel = document.getElementById('filterTabDate');
  if (typePanel) { typePanel.classList.toggle('hidden', name !== 'type'); typePanel.hidden = name !== 'type'; }
  if (datePanel) { datePanel.classList.toggle('hidden', name !== 'date'); datePanel.hidden = name !== 'date'; }
  if (name === 'date') openCalendar();   // build the index + render the grid in place
}
(function wireFilterTabs() {
  var dlg = els.filtersDlg; if (!dlg) return;
  dlg.querySelectorAll('.filter-tab').forEach(function (tab) {
    tab.addEventListener('click', function () { switchFilterTab(tab.dataset.tab); });
  });
  var tabs = dlg.querySelector('.filter-tabs');
  if (tabs) tabs.addEventListener('keydown', function (e) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) < 0) return;
    var list = Array.prototype.slice.call(dlg.querySelectorAll('.filter-tab'));
    var cur = list.indexOf(e.target.closest('.filter-tab'));
    if (cur < 0) return;
    var next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1
      : (cur + (e.key === 'ArrowLeft' ? -1 : 1) + list.length) % list.length;
    e.preventDefault(); list[next].focus(); switchFilterTab(list[next].dataset.tab);
  });
})();
// Tag pill panels + match-mode toggle (the tag checkbox list is gone).
(function wireFilterTagPicker() {
  const applied = document.getElementById('filterTagApplied');
  const available = document.getElementById('filterTagAvailable');
  if (applied) applied.addEventListener('click', _onFilterTagPillClick);
  if (available) available.addEventListener('click', _onFilterTagPillClick);
  const modeGroup = document.getElementById('filterTagMode');
  if (modeGroup) modeGroup.querySelectorAll('.mode-opt').forEach(b => {
    b.addEventListener('click', () => setFilterTagMode(b.dataset.mode));
  });
})();

els.filtersBtn.addEventListener('click', () => {
    console.log('🔍 filtersBtn clicked, filtersDlg=', els.filtersDlg);
    if (els.filtersDlg.open) return;
    try {
        filterCapture = null;                   // normal (global) mode
        applyFilterCaptureUi(false);
        filterDraft = cloneFilterState(activeFilters);
        els.filterTagSearch.value = '';
        renderFilterDraftControls();
        buildTagManager();
        els.tagManager.classList.add('hidden'); // start hidden each open
        switchFilterTab('type');                // always open on By Type
        els.filtersDlg.showModal();
        console.log('🔍 filtersDlg.showModal() called OK');
    } catch(e) {
        filterDraft = null;
        console.error('🔍 filtersBtn handler threw:', e);
    }
});
els.filterTagSearch.addEventListener('input', () => {
    renderFilterTagPanels();
});
// "Favourites only" toggle — draft-only until Apply, like the rest of the dialog.
(function wireFavoritesFilter() {
    var chk = document.getElementById('filterFavorites');
    if (chk) chk.addEventListener('change', () => { if (filterDraft) filterDraft.favorite = chk.checked; });
})();
// Quick-date pills were retired with the By Date tab; guard if absent.
if (els.quickThisMonth) els.quickThisMonth.addEventListener('click', () => {
    const d = new Date(); const y = d.getFullYear(); const m = d.getMonth();
    els.dateFrom.value = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const last = new Date(y, m + 1, 0).getDate();
    els.dateTo.value = `${y}-${String(m + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
});
if (els.quickClearDates) els.quickClearDates.addEventListener('click', () => { els.dateFrom.value = ''; els.dateTo.value = ''; });
els.filtersReset.addEventListener('click', () => {
    if (!filterDraft) return;
    filterDraft = { dateFrom: null, dateTo: null, cats: new Set(), tags: new Set(), tagMatch: 'any', favorite: false };
    renderFilterDraftControls();
});
els.filtersCancel.addEventListener('click', () => {
    filterCapture = null; applyFilterCaptureUi(false);
    filterDraft = null;
    els.filtersDlg.close();
});
els.filtersApply.addEventListener('click', () => {
    if (!filterDraft) filterDraft = cloneFilterState(activeFilters);
    filterDraft.dateFrom = els.dateFrom.value || null;
    filterDraft.dateTo = els.dateTo.value || null;
    // Capture mode: return the edited filter to the caller; don't touch the feed.
    if (filterCapture) {
        const cb = filterCapture.onApply;
        const result = {
            dateFrom: filterDraft.dateFrom, dateTo: filterDraft.dateTo,
            cats: new Set(filterDraft.cats), tags: new Set(filterDraft.tags),
            tagMatch: (filterDraft.tagMatch === 'all') ? 'all' : 'any',
        };
        filterCapture = null; filterDraft = null;
        applyFilterCaptureUi(false);
        els.filtersDlg.close();
        if (cb) cb(result);
        return;
    }
    activeFilters.dateFrom = filterDraft.dateFrom;
    activeFilters.dateTo = filterDraft.dateTo;
    activeFilters.cats = new Set(filterDraft.cats);
    activeFilters.tags = new Set(filterDraft.tags);
    activeFilters.tagMatch = (filterDraft.tagMatch === 'all') ? 'all' : 'any';
    activeFilters.favorite = !!filterDraft.favorite;
    filterDraft = null;
    // The filter is global: keep the folder-navigation select in sync so a single
    // applied category reads as "inside that folder" (breadcrumb + folder context),
    // and multi/zero categories fall back to the root's "__ALL__".
    if (els.categoryFilter) {
        const only = activeFilters.cats.size === 1 ? Array.from(activeFilters.cats)[0] : '__ALL__';
        if (only !== '__ALL__' && !Array.from(els.categoryFilter.options).some(o => o.value === only)) {
            const o = document.createElement('option'); o.value = only; o.textContent = only;
            els.categoryFilter.appendChild(o);
        }
        els.categoryFilter.value = only;
    }
    updateFilterIndicator();
    els.filtersDlg.close();
    renderFeed();
});
els.filtersDlg.addEventListener('close', () => { filterCapture = null; applyFilterCaptureUi(false); filterDraft = null; });
// Expose the reusable capture entry point (library picker uses it).
window.MemoFilterDialog = { openCapture: openFilterCapture };
els.dateFrom.addEventListener('change', () => {
    normalizeDateRange();
});
els.dateTo.addEventListener('change', () => {
    normalizeDateRange();
});
function normalizeDateRange() {
    if (els.dateFrom.value && els.dateTo.value) {
        const from = new Date(els.dateFrom.value);
        const to = new Date(els.dateTo.value);
        if (from > to) {
            // swap values
            const tmp = els.dateFrom.value;
            els.dateFrom.value = els.dateTo.value;
            els.dateTo.value = tmp;
        }
        const target = filterDraft || activeFilters;
        target.dateFrom = els.dateFrom.value || null;
        target.dateTo = els.dateTo.value || null;
    }
}

function filtersAreDefault() {
    const none = !activeFilters.dateFrom && !activeFilters.dateTo &&
        activeFilters.cats.size === 0 && activeFilters.tags.size === 0 && !activeFilters.favorite;
    return none;
}
function updateFilterIndicator() {
    // In Memo, one category is the folder you are in: the breadcrumb already
    // says so, and the funnel's dot is kept for filters beyond that.
    const folderOnly = window.MEMO_VARIANT === 'default' && activeFilters.cats.size === 1 &&
        !activeFilters.dateFrom && !activeFilters.dateTo && activeFilters.tags.size === 0 && !activeFilters.favorite;
    if (filtersAreDefault() || folderOnly) {
        els.filtersBtn.classList.remove('filter-active');
    } else {
        els.filtersBtn.classList.add('filter-active');
    }
}


// Calendar state
let calState = {
    view: 'month',         // 'year' | 'month' | 'day'
    pivot: new Date(),     // which month/year/day is in view
    parentView: null,      // where to go back (month<-year, day<-month)
    rangeStart: null,      // Date at 00:00
    rangeEnd: null,        // Date at 23:59:59.999
    dragging: false,       // range selection
    dragAnchor: null       // Date of first cell
};

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function ym(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

// Calendar rendering is intentionally frequent: navigation, view changes and
// every pointer-selection update redraw the grid. Build all date aggregates in
// one O(n) pass when the dialog opens, then keep those redraws O(1) with respect
// to library size. Hour maps are sparse so the index remains O(n) in memory.
let calendarIndex = null;
const emptyCalendarIndex = {
    days: new Map(),
    months: new Map(),
    hoursByDay: new Map()
};
function buildCalendarIndex(entries) {
    const index = { days: new Map(), months: new Map(), hoursByDay: new Map() };
    for (const entry of entries || []) {
        // Recycle-bin tombstones remain in db.entries until permanent deletion,
        // but calendar totals describe the live feed only.
        if (!entry || entry.deletedAt) continue;
        // Don't count Safe/locked entries in the calendar heatmap (matches the feed).
        if (window.MemoPrivacy && window.MemoPrivacy.canViewEntry && !window.MemoPrivacy.canViewEntry(entry)) continue;
        const date = new Date(entry && entry.ts);
        if (Number.isNaN(date.getTime())) continue;
        const dayKey = ymd(date);
        const monthKey = ym(date);
        index.days.set(dayKey, (index.days.get(dayKey) || 0) + 1);
        index.months.set(monthKey, (index.months.get(monthKey) || 0) + 1);
        let hours = index.hoursByDay.get(dayKey);
        if (!hours) {
            hours = new Map();
            index.hoursByDay.set(dayKey, hours);
        }
        const hour = date.getHours();
        hours.set(hour, (hours.get(hour) || 0) + 1);
    }
    return index;
}
function countsByDay() {
    return (calendarIndex || emptyCalendarIndex).days;
}
function countsByMonth() {
    return (calendarIndex || emptyCalendarIndex).months;
}
function countsByHourForDay(dayDate) {
    const arr = new Array(24).fill(0);
    const hours = (calendarIndex || emptyCalendarIndex).hoursByDay.get(ymd(dayDate));
    if (hours) hours.forEach((count, hour) => { arr[hour] = count; });
    return arr;
}
function partOfDayClass(h) {
    if (h >= 6 && h < 12) return 'morning';
    if (h >= 12 && h < 18) return 'afternoon';
    if (h >= 18 && h < 21) return 'evening';
    return 'night'; // 21-24 and 0-6
}

function calendarCountLabel(count) {
    return count === 1 ? '1 entry' : `${count} entries`;
}

function decorateCalendarCell(cell, options) {
    const selected = !!options.selected;
    const disabled = !!options.disabled;
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', `${options.label}, ${calendarCountLabel(options.count || 0)}`);
    cell.setAttribute('aria-selected', String(selected));
    if (disabled) cell.setAttribute('aria-disabled', 'true');
    else cell.removeAttribute('aria-disabled');
    cell.dataset.calKey = options.key;
    cell.tabIndex = -1;
    cell._calendarActivate = disabled ? null : options.activate || null;
}

function calendarColumnCount() {
    if (calState.view === 'month') return 7;
    if (calState.view === 'day') return 6;
    if (window.innerWidth <= 420) return 2;
    if (window.innerWidth <= 720) return 3;
    return 4;
}

function syncCalendarGridSemantics(previousFocusKey, restoreFocus) {
    const columns = calendarColumnCount();
    const heading = els.calHeading.textContent || 'Calendar';
    const cells = Array.from(els.calGrid.querySelectorAll('[role="gridcell"]'));
    els.calGrid.setAttribute('role', 'grid');
    els.calGrid.setAttribute('aria-colcount', String(columns));
    els.calGrid.setAttribute('aria-rowcount', String(Math.ceil(cells.length / columns)));
    els.calGrid.setAttribute('aria-multiselectable', String(calState.view !== 'day'));
    if (calState.view === 'year') els.calGrid.setAttribute('aria-label', `${heading} calendar months`);
    else if (calState.view === 'month') els.calGrid.setAttribute('aria-label', `${heading} calendar days`);
    else els.calGrid.setAttribute('aria-label', `${heading} hourly activity`);

    const matchingCell = previousFocusKey
        ? cells.find(cell => cell.dataset.calKey === previousFocusKey)
        : null;
    const tabStop = matchingCell || cells.find(cell => cell.classList.contains('rangeEdge'))
        || cells.find(cell => cell.classList.contains('inRange')) || cells[0];
    cells.forEach(cell => { cell.tabIndex = cell === tabStop ? 0 : -1; });
    if (restoreFocus && tabStop) tabStop.focus({ preventScroll: true });
}

// The calendar now lives inside the Filters dialog's "By Date" tab, so this just
// (re)builds the index and renders the grid in place — no separate dialog.
function openCalendar() {
    if (!els.calGrid) return;
    // default: show month of current pivot; reset selection
    calState.view = 'month';
    calState.parentView = null;
    calState.rangeStart = null;
    calState.rangeEnd = null;
    calState.dragging = false;
    calState.dragAnchor = null;
    calendarIndex = buildCalendarIndex(db.entries);
    try {
        renderCalendar();
    } catch (error) {
        calendarIndex = null;
        throw error;
    }
}

function setHeading(text) {
    els.calHeading.textContent = text;
}

function setLegend() {
    if (calState.view === 'day') {
        els.calLegend.innerHTML = `<span>Day view (hourly). Apply is disabled in this view.</span>`;
    } else if (calState.view === 'month') {
        els.calLegend.innerHTML = `<span class="muted">Drag to select a date range. <span style="display:inline-block;width:10px;height:10px;background:#0d1a33;border:1px solid var(--border);border-radius:3px;margin:0 6px -1px 8px"></span>has data</span>`;
    } else {
        els.calLegend.innerHTML = `<span class="muted">Click a month to zoom in; drag-select to pick multiple months. <span style="display:inline-block;width:10px;height:10px;background:#0d1a33;border:1px solid var(--border);border-radius:3px;margin:0 6px -1px 8px"></span>has data</span>`;
    }
}

function renderCalendar() {
    const activeCell = els.calGrid.contains(document.activeElement)
        ? document.activeElement.closest('[role="gridcell"]')
        : null;
    const previousFocusKey = activeCell && activeCell.dataset.calKey;
    els.calView.value = calState.view;
    els.calGrid.className = `calgrid ${calState.view}`;
    setLegend();

    if (calState.view === 'year') renderYear();
    else if (calState.view === 'month') renderMonth();
    else renderDay();

    syncCalendarGridSemantics(previousFocusKey, !!activeCell);

    // Apply button enabled unless day view or no selection
    els.calApply.disabled = (calState.view === 'day') || !(calState.rangeStart && calState.rangeEnd);
    // show/hide up button
    els.calUp.style.display = calState.parentView ? '' : 'none';
    updateDrillAndSelectButton();
}

function renderYear() {
    const base = new Date(calState.pivot); base.setMonth(0, 1); base.setHours(0, 0, 0, 0);
    setHeading(`${base.getFullYear()}`);
    const cm = countsByMonth();
    els.calGrid.innerHTML = '';
    for (let m = 0; m < 12; m++) {
        const d = new Date(base); d.setMonth(m, 1);
        const label = d.toLocaleString(undefined, { month: 'short' });
        const key = ym(d);
        const count = cm.get(key) || 0;

        const cell = document.createElement('div');
        cell.className = `calcell small ${count > 0 ? 'hasData' : 'noData'}`;
        cell.dataset.month = m;
        cell.innerHTML = `<div class="title">${label}</div><div class="count">${count || ''}</div>`;
        const selected = markSelectionClass(cell, d, endOfMonth(d));

        const drillIntoMonth = () => {
            calState.parentView = 'year';
            calState.view = 'month';
            calState.pivot = new Date(d);
            renderCalendar();
        };
        decorateCalendarCell(cell, {
            key: `month:${ym(d)}`,
            label: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }),
            count,
            selected,
            activate: drillIntoMonth,
        });

        cell.addEventListener('mousedown', e => yearStartDrag(e, d));
        cell.addEventListener('mouseenter', e => yearHoverDrag(e, d));
        cell.addEventListener('mouseup', e => yearEndDrag(e, d));
        cell.addEventListener('click', drillIntoMonth);

        els.calGrid.appendChild(cell);
    }
}

function endOfMonth(d) {
    const x = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    x.setHours(23, 59, 59, 999); return x;
}

function renderMonth() {
    // Build a 7x6 grid for current month
    const base = new Date(calState.pivot); base.setDate(1); base.setHours(0, 0, 0, 0);
    const year = base.getFullYear(), month = base.getMonth();
    setHeading(`${base.toLocaleString(undefined, { month: 'long' })} ${year}`);
    const cd = countsByDay();

    // compute first day shown (Sun/Mon aligned; we’ll use locale weekday start = Sunday)
    const firstDow = new Date(year, month, 1).getDay(); // 0..6 Sun..Sat
    const start = new Date(year, month, 1 - firstDow);
    els.calGrid.innerHTML = '';

    // Weekday header row
    const headerNames = Array.from({ length: 7 }, (_, i) => new Date(2020, 5, 7 + i).toLocaleString(undefined, { weekday: 'short' }));
    headerNames.forEach(n => {
        const h = document.createElement('div');
        h.className = 'muted';
        h.style.textAlign = 'center';
        h.textContent = n;
        h.setAttribute('role', 'columnheader');
        els.calGrid.appendChild(h);
    });

    // 6 weeks * 7 days
    for (let i = 0; i < 42; i++) {
        const d = new Date(start); d.setDate(d.getDate() + i);
        const inMonth = d.getMonth() === month;
        const key = ymd(d);
        const count = cd.get(key) || 0;

        const cell = document.createElement('div');
        cell.className = `calcell ${count > 0 ? 'hasData' : 'noData'} ${inMonth ? '' : 'disabled'}`;
        cell.innerHTML = `<div class="title">${d.getDate()}</div><div class="count">${count || ''}</div>`;
        const selected = markSelectionClass(cell, d, d);

        const selectDay = () => {
            calState.dragging = false;
            calState.dragAnchor = { date: startOfDay(d) };
            calState.rangeStart = startOfDay(d);
            calState.rangeEnd = endOfDay(d);
            renderCalendar();
        };
        decorateCalendarCell(cell, {
            key: `day:${key}`,
            label: d.toLocaleDateString(undefined, {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            }),
            count,
            selected,
            disabled: !inMonth,
            activate: selectDay,
        });

        // range selection on month grid (only if in current month)
        cell.addEventListener('mousedown', e => monthStartDrag(e, d));
        cell.addEventListener('mouseenter', e => monthHoverDrag(e, d));
        cell.addEventListener('mouseup', e => monthEndDrag(e, d));

        // drill into day
        cell.addEventListener('dblclick', () => {
            calState.parentView = 'month';
            calState.view = 'day';
            calState.pivot = new Date(d);
            renderCalendar();
        });

        els.calGrid.appendChild(cell);
    }
}

function renderDay() {
    const d = new Date(calState.pivot); d.setHours(0, 0, 0, 0);
    setHeading(d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }));
    els.calGrid.innerHTML = '';
    els.calPickDay.value = ymd(d);

    const hours = countsByHourForDay(d);

    // Build 24 cells as a 4×6 grid (rows × cols)
    for (let h = 0; h < 24; h++) {
        const cell = document.createElement('div');
        cell.className = `hourcell ${partOfDayClass(h)}`;
        const label = `${String(h).padStart(2, '0')}`;
        cell.innerHTML = `<span class="label">${label}</span><span class="badge">${hours[h]}</span>`;
        const hourDate = new Date(d); hourDate.setHours(h);
        decorateCalendarCell(cell, {
            key: `hour:${ymd(d)}:${h}`,
            label: hourDate.toLocaleTimeString(undefined, { hour: 'numeric' }),
            count: hours[h],
            selected: false,
        });
        els.calGrid.appendChild(cell);
    }
}


function markSelectionClass(cell, cellStart, cellEnd) {
    const { rangeStart, rangeEnd } = calState;
    if (!rangeStart || !rangeEnd) return false;
    const a = startOfDay(rangeStart).getTime();
    const b = endOfDay(rangeEnd).getTime();
    const cs = startOfDay(cellStart).getTime();
    const ce = endOfDay(cellEnd).getTime();
    const intersects = ce >= a && cs <= b;
    if (intersects) {
        cell.classList.add('inRange');
        if (cs === a || ce === b) cell.classList.add('rangeEdge');
    }
    return intersects;
}

els.calGrid.addEventListener('keydown', event => {
    const cell = event.target.closest('[role="gridcell"]');
    if (!cell || !els.calGrid.contains(cell)) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        if (!cell._calendarActivate || cell.getAttribute('aria-disabled') === 'true') return;
        event.preventDefault();
        cell._calendarActivate();
        return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const cells = Array.from(els.calGrid.querySelectorAll('[role="gridcell"]'));
    const current = cells.indexOf(cell);
    if (current < 0) return;
    const columns = calendarColumnCount();
    let next = current;
    if (event.key === 'ArrowLeft') next -= 1;
    else if (event.key === 'ArrowRight') next += 1;
    else if (event.key === 'ArrowUp') next -= columns;
    else if (event.key === 'ArrowDown') next += columns;
    else if (event.key === 'Home') next -= current % columns;
    else if (event.key === 'End') next += columns - 1 - (current % columns);
    next = Math.max(0, Math.min(cells.length - 1, next));
    event.preventDefault();
    cells.forEach(candidate => { candidate.tabIndex = -1; });
    cells[next].tabIndex = 0;
    cells[next].focus();
});

/* === Selection (Year) === */
function yearStartDrag(e, date) {
    if (e.button !== 0) return;
    calState.dragging = true;
    const s = new Date(date.getFullYear(), date.getMonth(), 1);
    const eom = endOfMonth(date);
    calState.dragAnchor = { start: s, end: eom };
    calState.rangeStart = s; calState.rangeEnd = eom;
    renderCalendar();
}
function yearHoverDrag(e, date) {
    if (!calState.dragging) return;
    // union of months from anchor to hovered month
    const a = calState.dragAnchor.start;
    const z = new Date(date.getFullYear(), date.getMonth(), 1);
    const s = (z < a) ? z : a;
    const ee = (z < a) ? endOfMonth(a) : endOfMonth(z);
    calState.rangeStart = s; calState.rangeEnd = ee;
    renderCalendar();
}
function yearEndDrag(e, date) {
    if (!calState.dragging) return;
    calState.dragging = false;
    yearHoverDrag(e, date);
}

/* === Selection (Month) === */
function monthStartDrag(e, date) {
    if (e.button !== 0) return;
    calState.dragging = true;
    calState.dragAnchor = { date: startOfDay(date) };
    calState.rangeStart = startOfDay(date);
    calState.rangeEnd = endOfDay(date);
    renderCalendar();
}
function monthHoverDrag(e, date) {
    if (!calState.dragging) return;
    const a = calState.dragAnchor.date;
    const b = startOfDay(date);
    if (b < a) { calState.rangeStart = b; calState.rangeEnd = endOfDay(a); }
    else { calState.rangeStart = a; calState.rangeEnd = endOfDay(b); }
    renderCalendar();
}
function monthEndDrag(e, date) {
    if (!calState.dragging) return;
    calState.dragging = false;
    monthHoverDrag(e, date);
}
function updateDrillAndSelectButton() {

    // Month: one exact day selected?
    var visibleDrill = false;
    const s = calState.rangeStart, e = calState.rangeEnd;
    if (s && e) {
        els.calClearSel.disabled = false;
        els.calClearSel.style.display = "block";
    }
    else {
        els.calClearSel.disabled = true;
        els.calClearSel.style.display = "none";
    }

    if (calState.view === 'month') {
        if (s && e && startOfDay(s).getTime() === startOfDay(e).getTime()) {
            visibleDrill = true;
            els.calDrill.textContent = `Open (${ymd(s)})`;
        }
    }

    // Year: one exact month selected?
    if (calState.view === 'year') {
        //console.log(calState)
        if (s && e && s.month === e.month) {
            visibleDrill = true;
            els.calDrill.textContent = `Open (${ym(s)})`;
        }
    }
    if (visibleDrill) {
        els.calDrill.style.display = "block";
        els.calDrill.disabled = false;
        els.calApply.disabled = false;
    }
    else {
        els.calDrill.disabled = true;
        els.calDrill.style.display = "none";
        els.calDrill.textContent = 'Drill selection';
    }

}
// The standalone Calendar button + dialog are gone — the calendar is now the
// Filters "By Date" tab (openCalendar renders it in place; see switchFilterTab).

// Apply the drag-selected range: write the hidden date inputs, then commit the
// whole filter draft through the main Apply (disabled in Day view).
els.calApply.addEventListener('click', () => {
    if (!calState.rangeStart || !calState.rangeEnd || calState.view === 'day') return;
    els.dateFrom.value = ymd(startOfDay(calState.rangeStart));
    els.dateTo.value = ymd(endOfDay(calState.rangeEnd));
    els.filtersApply.click();
});

// Prev / Next (depends on view)
els.calPrev.addEventListener('click', () => {
    const p = new Date(calState.pivot);
    if (calState.view === 'year') { p.setFullYear(p.getFullYear() - 1); }
    else if (calState.view === 'month') { p.setMonth(p.getMonth() - 1); }
    else { p.setDate(p.getDate() - 1); }
    calState.pivot = p; renderCalendar();
});
els.calNext.addEventListener('click', () => {
    const p = new Date(calState.pivot);
    if (calState.view === 'year') { p.setFullYear(p.getFullYear() + 1); }
    else if (calState.view === 'month') { p.setMonth(p.getMonth() + 1); }
    else { p.setDate(p.getDate() + 1); }
    calState.pivot = p; renderCalendar();
});

// View switcher
els.calView.addEventListener('change', () => {
    const v = els.calView.value;
    if (v === 'day') { calState.parentView = (calState.view === 'month' ? 'month' : null); }
    calState.view = v;
    // reset selection when entering day
    if (v === 'day') { calState.rangeStart = calState.rangeEnd = null; }
    renderCalendar();
});

// Choose specific day (doesn't affect filters directly)
els.calPickDay.addEventListener('change', () => {
    if (!els.calPickDay.value) return;
    const [Y, M, D] = els.calPickDay.value.split('-').map(n => parseInt(n, 10));
    calState.pivot = new Date(Y, M - 1, D);
    calState.view = 'day';
    calState.parentView = 'month';
    calState.rangeStart = calState.rangeEnd = null; // not applicable
    renderCalendar();
});

// Go up (day->month or month->year)
els.calUp.addEventListener('click', () => {
    if (calState.parentView) {
        if (calState.view === 'day') { calState.view = 'month'; calState.parentView = 'year'; }
        else if (calState.view === 'month') { calState.view = 'year'; calState.parentView = null; }
        renderCalendar();
    }
});

els.calClearSel.addEventListener('click', () => {
    calState.rangeStart = null;
    calState.rangeEnd = null;
    renderCalendar();
});

els.calDrill.addEventListener('click', () => {
    if (els.calDrill.disabled) return;

    const s = calState.rangeStart, e = calState.rangeEnd;

    if (calState.view === 'year') {
        // must be exactly one day selected
        if (!s || !e) return;
        if (s.month !== e.month) return;
        // Enter Day view at that date
        calState.parentView = 'year';
        calState.view = 'month';
        calState.pivot = new Date(s);
        renderCalendar();
        return;
    }

    if (calState.view === 'month') {
        // must be exactly one day selected
        const s = calState.rangeStart, e = calState.rangeEnd;
        if (!s || !e) return;
        if (startOfDay(s).getTime() !== startOfDay(e).getTime()) return;

        // Enter Day view at that date
        calState.parentView = 'month';
        calState.view = 'day';
        calState.pivot = new Date(s);
        renderCalendar();
        return;
    }
});

// Readiness means every filter/calendar listener above is attached. Setting
// this at file entry lets consumers race partially initialized controls.
window.MemoFilterBootstrapped = true;
