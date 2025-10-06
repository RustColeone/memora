/* ---------- Filters & Tag Manager UI ---------- */
els.categoryFilter.addEventListener('change', renderFeed);
els.searchBox.addEventListener('input', renderFeed);
els.filtersBtn.addEventListener('click', () => {
    refreshCategoryControls();
    els.filterTagSearch.value = ''; refreshFilterTagsList();
    buildTagManager();
    els.tagManager.classList.add('hidden'); // start hidden each open
    els.filtersDlg.showModal();
});
els.filterTagSearch.addEventListener('input', refreshFilterTagsList);
els.quickThisMonth.addEventListener('click', () => {
    const d = new Date(); const y = d.getFullYear(); const m = d.getMonth();
    els.dateFrom.value = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const last = new Date(y, m + 1, 0).getDate();
    els.dateTo.value = `${y}-${String(m + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
});
els.quickClearDates.addEventListener('click', () => { els.dateFrom.value = ''; els.dateTo.value = ''; });
els.filtersReset.addEventListener('click', () => {
    activeFilters = { dateFrom: null, dateTo: null, cats: new Set(), tags: new Set() };
    els.dateFrom.value = ''; els.dateTo.value = '';
    refreshCategoryControls(); refreshFilterTagsList();
    updateFilterIndicator();
});
els.filtersCancel.addEventListener('click', () => els.filtersDlg.close());
els.filtersApply.addEventListener('click', () => {
    activeFilters.dateFrom = els.dateFrom.value || null;
    activeFilters.dateTo = els.dateTo.value || null;
    els.filtersDlg.close();
    renderFeed();
});
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
        activeFilters.dateFrom = els.dateFrom.value || null;
        activeFilters.dateTo = els.dateTo.value || null;
    }
}

function filtersAreDefault() {
    const none = !activeFilters.dateFrom && !activeFilters.dateTo &&
        activeFilters.cats.size === 0 && activeFilters.tags.size === 0;
    return none;
}
function updateFilterIndicator() {
    if (filtersAreDefault()) {
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

function countsByDay() {
    const map = new Map(); // key: 'YYYY-MM-DD' -> count
    for (const e of db.entries) {
        const k = ymd(new Date(e.ts));
        map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
}
function countsByMonth() {
    const map = new Map(); // 'YYYY-MM' -> count
    for (const e of db.entries) {
        const d = new Date(e.ts);
        const k = ym(d);
        map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
}
function countsByHourForDay(dayDate) {
    const start = startOfDay(dayDate).getTime();
    const end = endOfDay(dayDate).getTime();
    const arr = new Array(24).fill(0);
    for (const e of db.entries) {
        if (e.ts >= start && e.ts <= end) {
            const h = new Date(e.ts).getHours();
            arr[h] += 1;
        }
    }
    return arr;
}
function partOfDayClass(h) {
    if (h >= 6 && h < 12) return 'morning';
    if (h >= 12 && h < 18) return 'afternoon';
    if (h >= 18 && h < 21) return 'evening';
    return 'night'; // 21-24 and 0-6
}
function openCalendar() {
    // default: show month of current pivot; reset selection
    calState.view = 'month';
    calState.parentView = null;
    calState.rangeStart = null;
    calState.rangeEnd = null;
    renderCalendar();
    els.calendarDlg.showModal();
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
    els.calView.value = calState.view;
    els.calGrid.className = `calgrid ${calState.view}`;
    setLegend();

    if (calState.view === 'year') renderYear();
    else if (calState.view === 'month') renderMonth();
    else renderDay();

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
        markSelectionClass(cell, d, endOfMonth(d));

        cell.addEventListener('mousedown', e => yearStartDrag(e, d));
        cell.addEventListener('mouseenter', e => yearHoverDrag(e, d));
        cell.addEventListener('mouseup', e => yearEndDrag(e, d));
        cell.addEventListener('click', () => { // drill into month
            calState.parentView = 'year';
            calState.view = 'month';
            calState.pivot = new Date(d);
            renderCalendar();
        });

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
        markSelectionClass(cell, d, d);

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
        els.calGrid.appendChild(cell);
    }
}


function markSelectionClass(cell, cellStart, cellEnd) {
    const { rangeStart, rangeEnd } = calState;
    if (!rangeStart || !rangeEnd) return;
    const a = startOfDay(rangeStart).getTime();
    const b = endOfDay(rangeEnd).getTime();
    const cs = startOfDay(cellStart).getTime();
    const ce = endOfDay(cellEnd).getTime();
    const intersects = ce >= a && cs <= b;
    if (intersects) {
        cell.classList.add('inRange');
        if (cs === a || ce === b) cell.classList.add('rangeEdge');
    }
}

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
// Open
els.calendarBtn.addEventListener('click', openCalendar);

// Close
els.calCancel.addEventListener('click', () => els.calendarDlg.close());

// Apply -> write into filter date inputs and apply (not available in Day view)
els.calApply.addEventListener('click', () => {
    if (!calState.rangeStart || !calState.rangeEnd || calState.view === 'day') return;
    const s = startOfDay(calState.rangeStart);
    const e = endOfDay(calState.rangeEnd);
    els.dateFrom.value = ymd(s);
    // date inputs are yyyy-mm-dd (no time), but we store both in activeFilters on Apply
    els.dateTo.value = ymd(e);
    els.calendarDlg.close();

    // same as Filters Apply button’s logic
    activeFilters.dateFrom = els.dateFrom.value || null;
    activeFilters.dateTo = els.dateTo.value || null;
    renderFeed();
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