// Finance variant: table view with purchaseDate, items, tax, total
(function(){
  const { els } = window.MemoCore.getState();
  // In the single-page shell the active-variant body class is owned by the shell
  // (added/removed on tab switch); adding it here at load would stick the memo
  // screen with finance styling. Classic multi-page build adds it as before.
  if (!window.__MEMO_SPA__) document.body.classList.add('finance-variant');

  // Tracks the active sheet so the staggered row entrance plays on a real view
  // switch (sheet change / first load), not on every search keystroke or sort.
  let _lastFinanceView = null;
  let totalsObserver = null;
  // The calendar day on this device. toISOString() is the UTC day, which is
  // already tomorrow on an evening west of Greenwich.
  function localDay(ms) {
    const d = ms == null ? new Date() : new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const FINANCE_PAGE_SIZE = 60;
  let financeWindowCount = FINANCE_PAGE_SIZE;
  let financeWindowObserver = null;
  let financeWindowKey = null;
  let restoredWindow = null;
  window.addEventListener('pagehide', event => {
    if (window.MemoLifecycle?.retain(event) || (event && event.persisted)) return;
    if (totalsObserver) totalsObserver.disconnect();
    if (financeWindowObserver) financeWindowObserver.disconnect();
    totalsObserver = null;
    financeWindowObserver = null;
  });

  // ─── Viewport-class system ───────────────────────────────────────────────
  // Keep the responsive column classes and row colspans in agreement.
  // Maps a width to a named bucket so re-render only fires when we cross a
  // breakpoint — not on every pixel of a smooth resize.
  function _vwBucket(w) {
    if (w >= 880) return 'xl';
    if (w > 640) return 'lg';
    if (w >= 600) return 'md';
    if (w >= 420) return 'sm';
    if (w >= 360) return 'xs';
    if (w >= 340) return 'xxs';
    return 'tiny';
  }
  let _lastVwBucket = null;
  let viewportFrame = 0;

  function updateVwClasses() {
    const w = (window.visualViewport ? window.visualViewport.width : 0) || window.innerWidth;
    document.body.classList.toggle('vw-lt-880', w < 880);
    document.body.classList.toggle('vw-lt-600', w < 600);
    document.body.classList.toggle('vw-lt-420', w < 420);
    document.body.classList.toggle('vw-lt-360', w < 360);
    document.body.classList.toggle('vw-lt-340', w < 340);
    // Re-render only when we cross a breakpoint boundary so table-layout:fixed
    // recalculates column widths. Guards against render loops on smooth resize.
    const bucket = _vwBucket(w);
    if (bucket !== _lastVwBucket) {
      const initial = _lastVwBucket === null;
      _lastVwBucket = bucket;
      if (initial || window.MEMO_VARIANT !== 'finance') return;
      cancelAnimationFrame(viewportFrame);
      viewportFrame = requestAnimationFrame(function() {
        viewportFrame = 0;
        if (window.MEMO_VARIANT === 'finance' && window.MemoVariant && typeof window.MemoVariant.renderFeed === 'function') {
          window.MemoVariant.renderFeed();
        }
      });
    }
  }
  updateVwClasses();
  window.addEventListener('resize', updateVwClasses);
  window.addEventListener('orientationchange', updateVwClasses);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateVwClasses);
  }

  // Which of the 6 table columns are currently visible. MUST stay in sync with
  // the column-hiding breakpoints in memo-finance.css (the .col-*/vw-lt-* rules).
  // Full-width rows (empty-state, month-group header) span columns with a single
  // cell that lacks the .col-* hide classes — so they'd "revive" a hidden column
  // unless their colspan is trimmed to the visible count. renderFeed re-runs on
  // every breakpoint cross, so reading width here keeps the two numbers synced.
  // Below this width the ledger renders as stacked cards instead of a table
  // (see the "Mobile: one entry = one stacked card" block in memo-finance.css).
  // Keep the number in sync with that media query.
  const CARD_LAYOUT_MAX_WIDTH = 640;
  function isCardLayout() {
    const w = (window.visualViewport ? window.visualViewport.width : 0) || window.innerWidth;
    return w <= CARD_LAYOUT_MAX_WIDTH;
  }

  function colVisibility() {
    const w = (window.visualViewport ? window.visualViewport.width : 0) || window.innerWidth;
    return {
      date: true,
      desc: true,
      images: w >= 340 && feedHasAttachments,
      price: w >= 600,
      tax: w >= 420,
      total: true,
    };
  }
  // The Images column shows only when an entry on screen has a photo or file.
  let feedHasAttachments = true;
  function visibleColCount() {
    const v = colVisibility();
    return (v.date ? 1 : 0) + (v.desc ? 1 : 0) + (v.images ? 1 : 0)
      + (v.price ? 1 : 0) + (v.tax ? 1 : 0) + (v.total ? 1 : 0);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // In Capacitor mode, hide manual folder selection and browser-only saving hint
  if (typeof window !== 'undefined' && window.CAP_BOOT) {
    try {
      document.querySelectorAll('#chooseDirBtn,[data-hide-when-server]').forEach(el => { el.hidden = true; });
    } catch (e) { /* noop */ }
  }

  function formatMoney(val, isTax = false) {
    if (val === '' || val == null) return '';
    const s = String(val).trim();
    if (isTax && s.endsWith('%')) { return s; }
    const num = parseFloat(s);
    if (!isNaN(num)) return `$${num.toFixed(2)}`;
    return `$${s}`;
  }
  function formatMoneyFixed(val) {
    const num = typeof val === 'number' ? val : parseFloat(val) || 0;
    return `$${num.toFixed(2)}`;
  }

  // The purchase form (lines, tax, total, store, payment, scanning a receipt)
  // is memo-finance-entry.js; these hooks hand it the entry and take it back.
  const FE = () => window.MemoFinanceEntry;

  function getTaxAmount(subtotal, tax) {
    if (tax == null || tax === '') return 0;
    const s = String(tax).trim();
    if (s.endsWith('%')) {
      const perc = parseFloat(s.slice(0, -1));
      return isNaN(perc) ? 0 : subtotal * (perc / 100);
    }
    const abs = parseFloat(s);
    return isNaN(abs) ? 0 : abs;
  }

  function openEntryModalHook(entry) {
    function todayLocalYMD() {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    if (els.entryDate) els.entryDate.value = entry ? (entry.purchaseDate || (entry.ts ? localDay(entry.ts) : '')) : todayLocalYMD();

    // Sheet selector: defaults to the entry's sheet (edit) or the active sheet (new).
    const sheetSel = document.getElementById('entrySheet');
    if (sheetSel) {
      const cur = entry ? effSheet(entry) : getActiveSheet();
      const opts = allSheets();
      if (!opts.includes(cur)) opts.push(cur);
      sheetSel.innerHTML = opts.map(s => `<option value="${(s || '').replace(/"/g, '&quot;')}"${s === cur ? ' selected' : ''}>${(s || '').replace(/</g, '&lt;')}</option>`).join('');
    }

    if (FE()) FE().open(entry);
  }

  function collectAdditionalFields(entry, isNew) {
    const purchaseDate = els.entryDate && els.entryDate.value ? els.entryDate.value : localDay();
    
    const sheetSel = document.getElementById('entrySheet');
    entry.sheet = (sheetSel && sheetSel.value) ? sheetSel.value : getActiveSheet();

    entry.purchaseDate = purchaseDate;
    // Lines, tax, total, store, payment, notes; drops the legacy price fields.
    if (FE()) FE().collect(entry);
  }

  function normalizeServerMemo(m) {
    return {
      id: m.id,
      description: m.description || '',
      category: m.category || 'Uncategorized',
      tags: m.tags || [],
      ts: m.ts || Date.now(),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      deletedAt: m.deletedAt || null,
      deletedBy: m.deletedBy || null,
      permanentDeleteAt: m.permanentDeleteAt || null,
      images: m.images || [],
      attachments: m.attachments || [],
      imageMeta: m.imageMeta || {},
      purchaseDate: m.purchaseDate || (m.ts ? localDay(m.ts) : ''),
      sheet: m.sheet || 'General',
      items: m.items || [],
      tax: m.tax || '',
      total: m.total || 0,
      store: m.store || '',
      paidWith: m.paidWith || '',
      notes: m.notes || '',
      // Keep legacy for read-only if needed, but UI prefers items
      price: m.price,
      adjustment: m.adjustment
    };
  }

  // ── Finance sheets (per-entry 'sheet' label; e.g. Company / Personal) ──
  const SHEETS_KEY = 'finance_sheets_v1';
  const DEFAULT_SHEET = 'General';
  function loadSheetState() {
    try {
      const s = JSON.parse(localStorage.getItem(SHEETS_KEY) || '{}');
      return {
        sheets: Array.isArray(s.sheets) && s.sheets.length ? s.sheets.slice() : [DEFAULT_SHEET],
        active: s.active || DEFAULT_SHEET,
      };
    } catch (e) { return { sheets: [DEFAULT_SHEET], active: DEFAULT_SHEET }; }
  }
  let sheetState = loadSheetState();
  function saveSheetState() { try { localStorage.setItem(SHEETS_KEY, JSON.stringify(sheetState)); } catch (e) {} }
  function effSheet(e) { return (e && e.sheet && String(e.sheet).trim()) || DEFAULT_SHEET; }
  function allSheets() {
    const { db } = window.MemoCore.getState();
    const ordered = sheetState.sheets.slice();
    if (!ordered.includes(DEFAULT_SHEET)) ordered.unshift(DEFAULT_SHEET);
    (db.entries || []).forEach(e => { if (!e.deletedAt) { const s = effSheet(e); if (!ordered.includes(s)) ordered.push(s); } });
    return ordered;
  }
  function getActiveSheet() {
    const sheets = allSheets();
    if (!sheets.includes(sheetState.active)) { sheetState.active = sheets[0] || DEFAULT_SHEET; saveSheetState(); }
    return sheetState.active;
  }
  function setActiveSheet(name) {
    sheetState.active = name;
    if (!sheetState.sheets.includes(name)) sheetState.sheets.push(name);
    saveSheetState();
  }
  function sheetEntryCount(name) {
    const { db } = window.MemoCore.getState();
    return (db.entries || []).filter(e => !e.deletedAt && effSheet(e) === name).length;
  }
  // Header button just shows the active sheet's name; managing happens in a dialog.
  function updateSheetButton() {
    const nameEl = document.getElementById('sheetBtnName');
    if (nameEl) nameEl.textContent = getActiveSheet();
  }
  // Renames a sheet by relabeling every entry that carries it (sheets are a
  // per-entry label, not a separate store — see collectAdditionalFields).
  // Renaming onto an existing sheet name merges the two.
  async function renameSheet(oldName, newName) {
    const { db } = window.MemoCore.getState();
    const affected = db.entries.filter(e => effSheet(e) === oldName);
    affected.forEach(e => { e.sheet = newName; });

    sheetState.sheets = sheetState.sheets.filter(s => s !== oldName);
    if (!sheetState.sheets.includes(newName)) sheetState.sheets.push(newName);
    if (sheetState.active === oldName) sheetState.active = newName;
    saveSheetState();

    window.MemoCore.saveAll();
    if (MODE === 'server' && affected.length) {
      await Promise.all(affected.map(e => ServerAPI.update(e.id, { sheet: newName })));
    }
  }
  // Deleting a sheet is non-destructive: its entries move back to the default
  // sheet rather than being removed. The default sheet itself can't be deleted.
  async function deleteSheet(name) {
    if (name === DEFAULT_SHEET) return;
    const { db } = window.MemoCore.getState();
    const affected = db.entries.filter(e => !e.deletedAt && effSheet(e) === name);
    affected.forEach(e => { e.sheet = DEFAULT_SHEET; });
    sheetState.sheets = sheetState.sheets.filter(s => s !== name);
    if (sheetState.active === name) sheetState.active = DEFAULT_SHEET;
    saveSheetState();
    window.MemoCore.saveAll();
    if (MODE === 'server' && affected.length) {
      await Promise.all(affected.map(e => ServerAPI.update(e.id, { sheet: DEFAULT_SHEET })));
    }
  }

  // ── Sheet manage dialog (switch sheets; Edit mode = rename / delete) ──────
  let sheetEditMode = false;
  function ensureSheetDialog() {
    let dlg = document.getElementById('sheetDlg');
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'sheetDlg';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    return dlg;
  }
  function afterSheetChange() { updateSheetButton(); renderFeed(); }
  function renderSheetDialog(dlg) {
    const sheets = allSheets();
    const active = getActiveSheet();
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows = sheets.map(s => {
      const n = sheetEntryCount(s);
      if (sheetEditMode) {
        const canDel = s !== DEFAULT_SHEET;
        return `<div class="sheet-row">` +
          `<input class="sheet-rename" type="text" value="${esc(s)}" data-old="${esc(s)}" aria-label="Sheet name" />` +
          `<span class="sheet-count muted">${n}</span>` +
          (canDel
            ? `<button class="sheet-del" data-sheet="${esc(s)}" title="Delete (entries move to ${esc(DEFAULT_SHEET)})">Delete</button>`
            : `<span class="muted sheet-default-tag">default</span>`) +
          `</div>`;
      }
      return `<button type="button" class="sheet-row sheet-switch${s === active ? ' active' : ''}" data-sheet="${esc(s)}">` +
        `<span class="sheet-name">${esc(s)}</span>` +
        `<span class="sheet-count muted">${n}</span>` +
        (s === active ? `<span class="sheet-cur">●</span>` : ``) +
        `</button>`;
    }).join('');
    dlg.innerHTML =
      `<div class="modal sheet-modal">` +
        `<header><strong>Finance sheets</strong>` +
          `<button class="ghost icon" id="sheetDlgClose" title="Close"><span class="svg-icon svg-icon-x"></span></button></header>` +
        `<div class="sheet-list">${rows}</div>` +
        `<div class="sheet-actions">` +
          `<button id="sheetNewBtn">＋ New sheet</button>` +
          `<span class="spacer"></span>` +
          `<button id="sheetEditToggle" class="${sheetEditMode ? 'primary' : ''}">${sheetEditMode ? 'Done' : 'Edit'}</button>` +
        `</div>` +
      `</div>`;

    dlg.querySelector('#sheetDlgClose').addEventListener('click', () => dlg.close());
    dlg.querySelector('#sheetEditToggle').addEventListener('click', () => {
      sheetEditMode = !sheetEditMode; renderSheetDialog(dlg);
    });
    dlg.querySelector('#sheetNewBtn').addEventListener('click', async () => {
      const raw = window.MemoShell ? await window.MemoShell.prompt('New sheet name:', '', { okLabel: 'Create' }) : prompt('New sheet name:');
      const name = (raw || '').trim();
      if (name) { setActiveSheet(name); dlg.close(); afterSheetChange(); }
    });
    if (!sheetEditMode) {
      dlg.querySelectorAll('.sheet-switch').forEach(b => b.addEventListener('click', () => {
        setActiveSheet(b.dataset.sheet); dlg.close(); afterSheetChange();
      }));
    } else {
      dlg.querySelectorAll('.sheet-rename').forEach(inp => {
        const commit = async () => {
          const oldN = inp.dataset.old, newN = (inp.value || '').trim();
          if (newN && newN !== oldN) { await renameSheet(oldN, newN); renderSheetDialog(dlg); afterSheetChange(); }
        };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
        inp.addEventListener('blur', commit);
      });
      dlg.querySelectorAll('.sheet-del').forEach(b => b.addEventListener('click', async () => {
        const name = b.dataset.sheet, n = sheetEntryCount(name);
        const msg = n > 0 ? `Delete “${name}”? Its ${n} ${n === 1 ? 'entry' : 'entries'} will move to ${DEFAULT_SHEET}.` : `Delete “${name}”?`;
        const ok = window.MemoShell ? await window.MemoShell.confirm(msg, { danger: true, okLabel: 'Delete' }) : confirm(msg);
        if (!ok) return;
        // deleteSheet may switch the active sheet (to General) — re-render the
        // feed too, not just the dialog/tab, so content matches the tab.
        await deleteSheet(name); renderSheetDialog(dlg); afterSheetChange();
      }));
    }
  }
  function openSheetDialog() {
    const dlg = ensureSheetDialog();
    sheetEditMode = false;
    renderSheetDialog(dlg);
    dlg.showModal();
  }
  (function wireSheetButton() {
    const btn = document.getElementById('sheetBtn');
    if (btn) btn.addEventListener('click', openSheetDialog);
  })();

  // ── Finance table management: sorting, month grouping, category summary ──
  let financeSort = { col: 'date', dir: 'desc' };
  const collapsedMonths = new Set();
  // Many categories are possible, so keep the summary folded by default.
  let catPanelCollapsed = true;

  function entryMoney(e) {
    const items = Array.isArray(e.items) ? e.items : [];
    if (items.length) {
      const subtotal = items.reduce((s, i) => s + (parseFloat(i.totalPrice) || 0), 0);
      const taxable = items.reduce((s, i) => s + (i.kind === 'fee' ? 0 : (parseFloat(i.totalPrice) || 0)), 0);
      const tax = getTaxAmount(taxable, e.tax);
      const total = typeof e.total === 'number' ? e.total : (subtotal + tax);
      return { subtotal, tax, total };
    }
    const legacy = (parseFloat(e.price) || 0) + (parseFloat(e.adjustment) || 0);
    if (legacy) {
      const tax = getTaxAmount(legacy, e.tax);
      return { subtotal: legacy, tax, total: typeof e.total === 'number' && e.total ? e.total : legacy + tax };
    }
    // One amount: the total was paid, and any tax is part of it.
    const total = parseFloat(e.total) || 0;
    const t = String(e.tax == null ? '' : e.tax).trim();
    const tax = /%$/.test(t) ? total - total / (1 + (parseFloat(t) || 0) / 100) : getTaxAmount(0, t);
    return { subtotal: total - tax, tax, total };
  }
  function entryDateMs(e) { const t = new Date(e.purchaseDate || e.ts).getTime(); return isNaN(t) ? 0 : t; }
  function monthInfo(e) {
    const d = new Date(e.purchaseDate || e.ts);
    if (isNaN(d.getTime())) return { key: '0000-00', label: 'Undated' };
    return { key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
             label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
  }
  function sortEntries(arr) {
    const { col, dir } = financeSort;
    const sign = dir === 'asc' ? 1 : -1;
    const val = (e) => {
      const m = entryMoney(e);
      if (col === 'subtotal') return m.subtotal;
      if (col === 'tax') return m.tax;
      if (col === 'total') return m.total;
      if (col === 'desc') return (e.description || '').toLowerCase();
      return entryDateMs(e);
    };
    return arr.slice().sort((a, b) => { const va = val(a), vb = val(b); return va < vb ? -sign : va > vb ? sign : 0; });
  }
  function groupByMonth(sortedEntries) {
    const map = new Map();
    for (const e of sortedEntries) {
      const { key, label } = monthInfo(e);
      if (!map.has(key)) map.set(key, { key, label, entries: [], totals: { subtotal: 0, tax: 0, total: 0 } });
      const g = map.get(key); g.entries.push(e);
      const m = entryMoney(e); g.totals.subtotal += m.subtotal; g.totals.tax += m.tax; g.totals.total += m.total;
    }
    const groups = Array.from(map.values());
    // Months newest-first, unless explicitly sorting by date ascending.
    const monthSign = (financeSort.col === 'date' && financeSort.dir === 'asc') ? 1 : -1;
    groups.sort((a, b) => a.key < b.key ? -monthSign : a.key > b.key ? monthSign : 0);
    return groups;
  }
  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s); }
  function toggleMonth(key, tbody) {
    const collapsed = !collapsedMonths.has(key);
    if (collapsed) collapsedMonths.add(key); else collapsedMonths.delete(key);
    tbody.querySelectorAll(`tr.entry-row[data-month="${cssEsc(key)}"]`).forEach(r => r.classList.toggle('hidden-row', collapsed));
    const hr = tbody.querySelector(`tr.month-row[data-month="${cssEsc(key)}"]`);
    if (hr) hr.classList.toggle('collapsed', collapsed);
  }
  function buildCategorySummary(filtered) {
    const map = new Map();
    for (const e of filtered) {
      const c = e.category || 'Uncategorized';
      const m = entryMoney(e);
      const cur = map.get(c) || { total: 0, count: 0 };
      cur.total += m.total; cur.count += 1; map.set(c, cur);
    }
    const rows = Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
    const grand = rows.reduce((s, r) => s + r[1].total, 0);
    const catLabel = `${rows.length} ${rows.length === 1 ? 'category' : 'categories'}`;
    const panel = document.createElement('div');
    panel.className = 'cat-summary' + (catPanelCollapsed ? ' collapsed' : '');
    panel.innerHTML =
      `<div class="cat-summary-head"><span class="chev">▾</span> Spending by category ` +
      `<span class="cat-grand">${formatMoneyFixed(grand)}</span></div>` +
      `<div class="cat-summary-body">` +
      `<div class="cat-summary-bar">` +
        `<span class="muted">${catLabel}</span>` +
        `<span class="spacer"></span>` +
        `<button type="button" class="cat-details-btn" title="Open spending breakdown"><span class="svg-icon svg-icon-chart"></span> View breakdown</button>` +
      `</div>` +
      `<div class="cat-rows">` +
      rows.map(([c, v]) => `<button type="button" class="cat-row" data-cat="${(c || '').replace(/"/g, '&quot;')}">` +
        `<span class="cat-name">${(c || '').replace(/</g, '&lt;')}</span>` +
        `<span class="muted">${v.count}</span>` +
        `<span class="cat-amt">${formatMoneyFixed(v.total)}</span></button>`).join('') +
      `</div>` +
      `</div>`;
    panel.querySelector('.cat-summary-head').addEventListener('click', () => {
      catPanelCollapsed = !catPanelCollapsed; panel.classList.toggle('collapsed', catPanelCollapsed);
    });
    panel.querySelector('.cat-details-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      openCatChartDialog(rows, grand);
    });
    panel.querySelectorAll('.cat-row').forEach(btn => btn.addEventListener('click', () => {
      if (els.categoryFilter) { els.categoryFilter.value = btn.dataset.cat; els.categoryFilter.dispatchEvent(new Event('change')); }
      renderFeed();
    }));
    return panel;
  }

  // ── Interactive spending donut ──────────────────────────────────────────
  // A rotatable ring with a fixed pointer at the bottom (6 o'clock). Drag the
  // ring (or click a legend row) to bring a slice under the pointer; the centre
  // then shows that category's amount + share. Untouched, the centre shows TOTAL.
  const CAT_COLORS = ['#e8a87c', '#f0d264', '#a98fd6', '#8fc46b', '#6cc3d5',
                      '#f08a8a', '#7bb5e8', '#d68fb0', '#c2b280', '#9aa0a6'];
  const C_CX = 130, C_CY = 130, C_R = 110, C_RIN = 68;
  function _polar(radius, angDeg) {
    const a = angDeg * Math.PI / 180;
    return [C_CX + radius * Math.sin(a), C_CY - radius * Math.cos(a)];
  }
  function _arcPath(a1, a2) {
    // Single-slice full-circle guard: SVG arcs can't draw a 360° arc, nudge it.
    if (a2 - a1 >= 359.999) a2 = a1 + 359.999;
    const large = (a2 - a1) > 180 ? 1 : 0;
    const [ox1, oy1] = _polar(C_R, a1);
    const [ox2, oy2] = _polar(C_R, a2);
    const [ix2, iy2] = _polar(C_RIN, a2);
    const [ix1, iy1] = _polar(C_RIN, a1);
    return `M${ox1} ${oy1} A${C_R} ${C_R} 0 ${large} 1 ${ox2} ${oy2}`
         + ` L${ix2} ${iy2} A${C_RIN} ${C_RIN} 0 ${large} 0 ${ix1} ${iy1} Z`;
  }
  function _norm(a) { a %= 360; return a < 0 ? a + 360 : a; }

  function openCatChartDialog(rows, grand) {
    const segs = rows
      .filter(r => r[1].total > 0)
      .map(([name, v], i) => ({ name: name || 'Uncategorized', total: v.total, count: v.count,
                                color: CAT_COLORS[i % CAT_COLORS.length] }));
    // angular layout (clockwise from top)
    let cum = 0;
    segs.forEach(s => {
      const span = grand > 0 ? (s.total / grand) * 360 : 0;
      s.a1 = cum; s.a2 = cum + span; s.mid = cum + span / 2; cum += span;
    });

    let dlg = document.getElementById('catChartDlg');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'catChartDlg';
      document.body.appendChild(dlg);
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    }

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const pct = (t) => grand > 0 ? ((t / grand) * 100).toFixed(1) + '%' : '0%';
    const legend = segs.map((s, i) =>
      `<button type="button" class="catlg-row" data-i="${i}">` +
        `<span class="catlg-dot" style="background:${s.color}"></span>` +
        `<span class="catlg-name">${esc(s.name)}</span>` +
        `<span class="catlg-pct">${pct(s.total)}</span>` +
      `</button>`).join('');
    const paths = segs.map((s, i) =>
      `<path class="catseg" data-i="${i}" d="${_arcPath(s.a1, s.a2)}" fill="${s.color}"></path>`).join('');

    dlg.innerHTML =
      `<div class="modal catchart-modal">` +
        `<header><strong>Spending breakdown</strong>` +
          `<button class="ghost icon" id="catChartClose" title="Close"><span class="svg-icon svg-icon-x"></span></button></header>` +
        `<div class="catchart-body">` +
          `<div class="catchart-legend">${legend}</div>` +
          `<div class="catchart-stage">` +
            `<svg viewBox="0 0 260 268" class="catchart-svg">` +
              `<g class="catchart-ring" id="catRing">${paths}</g>` +
              // fixed pointer just below the ring (apex up), fully inside the viewBox
              `<path class="catchart-pointer" d="M130 ${C_CY + C_R + 3} l-10 16 l20 0 z"></path>` +
              `<text class="catchart-amt" id="catCenterAmt" x="130" y="126" text-anchor="middle">${formatMoneyFixed(grand)}</text>` +
              `<text class="catchart-lbl" id="catCenterLbl" x="130" y="148" text-anchor="middle">TOTAL</text>` +
            `</svg>` +
            `<div class="catchart-hint muted">Tap a slice (or drag the ring) to bring it to the ▲ pointer. Hover to peek.</div>` +
          `</div>` +
        `</div>` +
      `</div>`;

    const ring = dlg.querySelector('#catRing');
    const amtEl = dlg.querySelector('#catCenterAmt');
    const lblEl = dlg.querySelector('#catCenterLbl');
    const svg = dlg.querySelector('.catchart-svg');
    let rot = 0;          // current ring rotation (deg, clockwise)
    let selected = -1;    // committed slice (-1 = show TOTAL)

    function pointedIndex() {
      // The pointer sits at the bottom (180° from top). In the un-rotated frame
      // the slice under it is at angle (180 - rot). Segments tile [0,360).
      const target = _norm(180 - rot);
      for (let i = 0; i < segs.length; i++) {
        if (target >= segs[i].a1 && target < segs[i].a2) return i;
      }
      return segs.length ? segs.length - 1 : -1;   // wrap/rounding fallback
    }
    function applyRot(animate) {
      ring.style.transition = animate ? 'transform .22s ease' : 'none';
      ring.style.transform = `rotate(${rot}deg)`;
    }
    // Pure renderer: paints the centre + emphasis for slice i (-1 = TOTAL)
    // without mutating committed state, so it doubles as the hover preview.
    function renderCenter(i) {
      if (i < 0 || i >= segs.length) {
        amtEl.textContent = formatMoneyFixed(grand);
        lblEl.textContent = 'TOTAL';
        dlg.querySelectorAll('.catseg').forEach(p => p.classList.remove('dim', 'on'));
        dlg.querySelectorAll('.catlg-row').forEach(r => r.classList.remove('on'));
        return;
      }
      const s = segs[i];
      amtEl.textContent = formatMoneyFixed(s.total);
      lblEl.textContent = `${s.name} · ${pct(s.total)}`;
      dlg.querySelectorAll('.catseg').forEach(p => {
        const on = +p.dataset.i === i;
        p.classList.toggle('on', on); p.classList.toggle('dim', !on);
      });
      dlg.querySelectorAll('.catlg-row').forEach(r => r.classList.toggle('on', +r.dataset.i === i));
    }
    function updateCenter() { renderCenter(selected); }
    function selectIndex(i, animate) {
      selected = i;
      rot = _norm(180 - segs[i].mid);   // bring the slice to the bottom pointer
      applyRot(animate); updateCenter();
    }

    function angAt(ev) {
      const rect = svg.getBoundingClientRect();
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      const py = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
      // map to viewBox coords
      const vx = px / rect.width * 260, vy = py / rect.height * 268;
      return Math.atan2(vy - C_CY, vx - C_CX) * 180 / Math.PI;
    }
    function segIndexFrom(ev) {
      const t = ev.target;
      const i = (t && t.dataset && t.dataset.i != null) ? parseInt(t.dataset.i, 10) : NaN;
      return isNaN(i) ? -1 : i;
    }

    // Drag to spin the ring; a tap/click without movement selects that slice.
    let dragging = false, moved = false, startAng = 0, startRot = 0, downI = -1;
    function onDown(ev) {
      dragging = true; moved = false;
      startAng = angAt(ev); startRot = rot; downI = segIndexFrom(ev);
      ring.style.transition = 'none';
      ev.preventDefault();
    }
    function onMove(ev) {
      if (!dragging) return;
      const d = angAt(ev) - startAng;
      if (Math.abs(d) > 1.5) moved = true;
      rot = startRot + d;
      selected = pointedIndex();
      applyRot(false); renderCenter(selected);
      ev.preventDefault();
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      if (!moved && downI >= 0) selectIndex(downI, true);   // click a slice → select it
      else if (moved) selectIndex(pointedIndex(), true);    // settle the dragged ring
    }
    ring.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    ring.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);

    // Hover previews (segments + legend) without committing a selection.
    dlg.querySelectorAll('.catseg').forEach(p => {
      p.addEventListener('mouseenter', () => { if (!dragging) renderCenter(+p.dataset.i); });
      p.addEventListener('mouseleave', () => { if (!dragging) updateCenter(); });
    });
    dlg.querySelectorAll('.catlg-row').forEach(r => {
      r.addEventListener('click', () => selectIndex(+r.dataset.i, true));
      r.addEventListener('mouseenter', () => { if (!dragging) renderCenter(+r.dataset.i); });
      r.addEventListener('mouseleave', () => { if (!dragging) updateCenter(); });
    });
    dlg.querySelector('#catChartClose').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    }, { once: true });

    applyRot(false); updateCenter();
    dlg.showModal();
  }

  function buildFinanceMonthRow(group, tbody) {
    const row = document.createElement('tr');
    row.className = 'month-row' + (collapsedMonths.has(group.key) ? ' collapsed' : '');
    row.dataset.month = group.key;
    const labelSpan = colVisibility().images ? 3 : 2;
    row.innerHTML = `<td class="col-date month-toggle" colspan="${labelSpan}"><span class="chev">▾</span> ${group.label} <span class="muted">(${group.entries.length})</span></td>`
      + `<td class="col-price">${formatMoneyFixed(group.totals.subtotal)}</td>`
      + `<td class="col-tax">${formatMoneyFixed(group.totals.tax)}</td>`
      + `<td class="col-total">${formatMoneyFixed(group.totals.total)}</td>`;
    row.addEventListener('click', () => toggleMonth(group.key, tbody));
    return row;
  }

  // Flash-free re-render: reuse an entry row's DOM node (keeping its decoded
  // receipt thumbnails) when the entry's content signature is unchanged. The
  // month/collapse state is dynamic, so it's re-applied on reuse below.
  const _rowCache = new Map();
  function animateFinanceHeight(element, startHeight, endHeight, onFinish) {
    const finish = () => {
      element.classList.remove('is-expanding');
      element._financeExpansion = null;
      if (onFinish) onFinish();
    };
    if (!element.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    element.classList.add('is-expanding');
    const animation = element.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      { duration: 180, easing: 'linear' }
    );
    element._financeExpansion = animation;
    animation.addEventListener('finish', finish, { once: true });
    animation.addEventListener('cancel', finish, { once: true });
  }

  function toggleFinanceDescription(container, button) {
    if (container._financeExpansion) return;
    const startHeight = container.getBoundingClientRect().height;
    const expanded = !container.classList.contains('expanded');
    container.classList.toggle('expanded', expanded);
    button.textContent = expanded ? '(less)' : '(more)';
    button.setAttribute('aria-expanded', String(expanded));
    const endHeight = container.getBoundingClientRect().height;
    animateFinanceHeight(container, startHeight, endHeight);
  }

  function toggleFinanceAttachments(disclosure, content) {
    if (content._financeExpansion) return;
    const opening = !disclosure.open;
    if (opening) disclosure.open = true;
    disclosure.querySelector('summary')?.setAttribute('aria-expanded', String(opening));
    const startHeight = opening ? 0 : content.getBoundingClientRect().height;
    const endHeight = opening ? content.scrollHeight : 0;
    animateFinanceHeight(content, startHeight, endHeight, () => {
      if (!opening) disclosure.open = false;
    });
  }

  function _financeRowSig(e) {
    return JSON.stringify([e.description || '', e.tags || [], e.purchaseDate || e.ts || 0,
      (e.images || []).map(window.MemoDom.assetKey), (e.attachments || []).map(a => (a && (a.url || a.storedPath || a.name)) || ''),
      e.category || '', e.price, e.adjustment, e.items || [], e.tax, e.total, !!e._hasConflict,
      // Layout mode changes how much description/tags a row renders, so a cached
      // row built for the table must not be reused for the card layout.
      isCardLayout()]);
  }

  function buildFinanceEntryRow(e, monthKey) {
    const _sig = _financeRowSig(e);
    const _cached = _rowCache.get(e.id);
    if (_cached && _cached.sig === _sig && _cached.node) {
      const row = _cached.node;
      row.dataset.month = monthKey;
      row.classList.toggle('hidden-row', collapsedMonths.has(monthKey));
      if (row._syncDescriptionToggle) row._syncDescriptionToggle();
      return row;
    }
    const tr = document.createElement('tr');
    tr.className = 'entry-row' + (collapsedMonths.has(monthKey) ? ' hidden-row' : '');
    tr.dataset.month = monthKey;
    tr.setAttribute('data-id', e.id);

    if (e._hasConflict) {
      tr.style.borderLeft = '4px solid #f59e0b';
      tr.style.backgroundColor = 'rgba(245, 158, 11, 0.05)';
    }

    const dateCell = document.createElement('td'); dateCell.className = 'col-date';
    const rawDate = e.purchaseDate || (e.ts ? localDay(e.ts) : '');
    const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate);
    const shortDate = document.createElement('span'); shortDate.className = 'entry-date-short';
    shortDate.textContent = md ? `${md[2]}-${md[3]}` : rawDate;
    dateCell.appendChild(shortDate);
    const mobileDate = document.createElement('span'); mobileDate.className = 'entry-mobile-date';
    if (md) {
      const parsed = new Date(Number(md[1]), Number(md[2]) - 1, Number(md[3]));
      mobileDate.textContent = parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } else mobileDate.textContent = rawDate || 'Undated';
    dateCell.appendChild(mobileDate);
    if (e.category) {
      const category = document.createElement('span'); category.className = 'entry-category';
      category.textContent = e.category;
      dateCell.appendChild(category);
    }
    if (rawDate) dateCell.title = rawDate;
    tr.appendChild(dateCell);

    const descCell = document.createElement('td'); descCell.className = 'col-desc';
    const descWrap = document.createElement('div'); descWrap.className = 'desc-cell';
    if (e._hasConflict) {
      const conflictBanner = document.createElement('div');
      conflictBanner.style.background = '#f59e0b';
      conflictBanner.style.color = '#000';
      conflictBanner.style.padding = '2px 6px';
      conflictBanner.style.borderRadius = '4px';
      conflictBanner.style.fontSize = '10px';
      conflictBanner.style.fontWeight = '600';
      conflictBanner.style.marginBottom = '4px';
      conflictBanner.innerHTML = '<span class="svg-icon svg-icon-warning"></span> SYNC CONFLICT';
      descWrap.appendChild(conflictBanner);
    }
    const descText = document.createElement('div'); descText.className = 'desc-text';
    // Desktop keeps the compact table excerpt. Mobile owns the full description
    // and reveals it from a one-line preview via the adjacent more/less control.
    const cardMode = isCardLayout();
    const descLimit = 60;
    const tagLimit = cardMode ? 4 : 2;
    let pendingTagBar = null;
    const short = (e.description || '');
    descText.textContent = !cardMode && short.length > descLimit ? short.slice(0, descLimit) + '…' : short;
    if (e.tags?.length) {
      const tagBar = document.createElement('div'); tagBar.className = 'tagbar';
      const shown = e.tags.slice(0, tagLimit);
      shown.forEach(t => {
        const pill = document.createElement('span'); pill.className = 'tagpill'; pill.textContent = '#' + t; tagBar.appendChild(pill);
      });
      if (e.tags.length > tagLimit) {
        const more = document.createElement('span');
        more.className = 'tagpill tagpill-more';
        more.title = e.tags.map(t => '#' + t).join(' ');
        more.textContent = '+' + (e.tags.length - tagLimit);
        tagBar.appendChild(more);
      }
      // Sibling of .desc-cell rather than nested inside .desc-text. Same stacked
      // look on desktop, while the mobile grid can place tags directly below
      // the description and before its collapsed attachments disclosure.
      pendingTagBar = tagBar;
    }
    descWrap.appendChild(descText);
    if (cardMode && short.length > 0) {
      descWrap.classList.add('desc-collapsible');
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'desc-toggle'; toggle.textContent = '(more)';
      toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-label', 'Show full description');
      toggle.dataset.noLongpress = '';
      toggle.addEventListener('click', event => {
        event.stopPropagation();
        toggleFinanceDescription(descWrap, toggle);
        toggle.setAttribute('aria-label', descWrap.classList.contains('expanded') ? 'Collapse description' : 'Show full description');
      });
      descWrap.appendChild(toggle);
      tr._syncDescriptionToggle = () => {
        if (descWrap.classList.contains('expanded')) return;
        toggle.hidden = false;
        requestAnimationFrame(() => {
          if (!descWrap.isConnected || descWrap.classList.contains('expanded')) return;
          toggle.hidden = descText.scrollWidth <= descText.clientWidth;
        });
      };
      tr._syncDescriptionToggle();
    }
    descCell.appendChild(descWrap);
    if (pendingTagBar) descCell.appendChild(pendingTagBar);
    tr.appendChild(descCell);

    const imagesCell = document.createElement('td'); imagesCell.className = 'col-images images-cell';
    const isImage = window.MemoCore.isImage;
    const imgs = (Array.isArray(e.images) ? e.images.filter(Boolean) : []).filter(src => isImage(src));
    // MIME type decides: see MemoCore.isImageAttachment (a blob:-URL PDF used to
    // be misfiled as an image and then rendered nowhere at all).
    const otherFiles = (e.attachments || []).filter(a => a && !window.MemoCore.isImageAttachment(a));
    const attachmentCount = imgs.length + otherFiles.length;
    let attachmentTarget = imagesCell;
    if (cardMode && attachmentCount > 0) {
      const disclosure = document.createElement('details'); disclosure.className = 'attachment-disclosure';
      disclosure.dataset.noLongpress = '';
      const summary = document.createElement('summary'); summary.textContent = `Attachments (${attachmentCount})`;
      summary.setAttribute('aria-expanded', 'false');
      const content = document.createElement('div'); content.className = 'attachment-content';
      disclosure.append(summary, content);
      // Toggling or opening media should not also open the transaction detail.
      disclosure.addEventListener('click', event => event.stopPropagation());
      summary.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        toggleFinanceAttachments(disclosure, content);
      });
      imagesCell.appendChild(disclosure);
      attachmentTarget = content;
    }
    if (imgs.length > 0) {
      const container = document.createElement('div'); container.className = 'inline-thumbs';
      const lazyThumb = (image, src) => {
        if (window.MemoLazy) {
          image.dataset.src = window.MemoLazy.thumbUrl(src, 160);
          image.loading = 'lazy';
          window.MemoLazy.observe(image);
        } else image.src = src;
      };
      if (imgs.length <= 2) {
        imgs.forEach((src, index) => {
          const image = document.createElement('img'); lazyThumb(image, src); image.className = 'thumb lazy-img'; image.title = 'Click to preview';
          image.addEventListener('click', event => { event.stopPropagation(); window.MemoReader && window.MemoReader.open(e, index); });
          container.appendChild(image);
        });
      } else {
        const first = document.createElement('img'); lazyThumb(first, imgs[0]); first.className = 'thumb lazy-img'; first.title = 'Click to preview';
        first.addEventListener('click', event => { event.stopPropagation(); window.MemoReader && window.MemoReader.open(e, 0); });
        const more = document.createElement('div'); more.className = 'thumb more'; more.textContent = `+${imgs.length - 1}`; more.title = 'Click to preview';
        more.addEventListener('click', event => { event.stopPropagation(); window.MemoReader && window.MemoReader.open(e, 1); });
        container.append(first, more);
      }
      attachmentTarget.appendChild(container);
    }
    if (otherFiles.length) {
      const list = document.createElement('div'); list.className = 'filelist-cell';
      otherFiles.slice(0, 3).forEach(attachment => {
        const fileUrl = attachment.url || attachment.storedPath || '';
        const name = attachment.name || fileUrl.split('/').pop() || 'Attachment';
        const link = document.createElement('a'); link.href = fileUrl; link.target = '_blank'; link.rel = 'noopener'; link.className = 'filelink';
        link.innerHTML = '<span class="svg-icon svg-icon-file"></span> '; link.appendChild(document.createTextNode(name)); link.title = name;
        link.addEventListener('click', event => event.stopPropagation()); list.appendChild(link);
      });
      if (otherFiles.length > 3) {
        const more = document.createElement('div'); more.className = 'muted more-files'; more.textContent = '+' + (otherFiles.length - 3) + ' more'; list.appendChild(more);
      }
      attachmentTarget.appendChild(list);
    }
    tr.appendChild(imagesCell);

    const money = entryMoney(e);
    const priceCell = document.createElement('td'); priceCell.className = 'col-price'; priceCell.dataset.label = 'Subtotal'; priceCell.textContent = formatMoney(money.subtotal); tr.appendChild(priceCell);
    const taxCell = document.createElement('td'); taxCell.className = 'col-tax'; taxCell.dataset.label = 'Tax'; taxCell.textContent = formatMoney(money.tax, true); tr.appendChild(taxCell);
    const totalCell = document.createElement('td'); totalCell.className = 'col-total'; totalCell.dataset.label = 'Total'; totalCell.textContent = formatMoney(money.total); tr.appendChild(totalCell);
    tr.addEventListener('click', () => openDetail(e.id));
    if (window.MemoCtx) window.MemoCtx.attachLongPress(tr, event => showRowMenu(event, e.id));
    _rowCache.set(e.id, { node: tr, sig: _sig });
    return tr;
  }

  function appendFinanceRows(rows, groupsByKey, tbody, start, end, replace = false) {
    const desired = [];
    const fragment = { appendChild(node) { desired.push(node); } };
    const added = [];
    let lastMonth = !replace && tbody.lastElementChild && tbody.lastElementChild.dataset.month;
    for (let index = start; index < end; index += 1) {
      const item = rows[index];
      if (item.monthKey !== lastMonth) {
        fragment.appendChild(buildFinanceMonthRow(groupsByKey.get(item.monthKey), tbody));
        lastMonth = item.monthKey;
      }
      const row = buildFinanceEntryRow(item.entry, item.monthKey);
      fragment.appendChild(row);
      added.push(row);
    }
    window.MemoDom.reconcile(tbody, replace ? desired : [...tbody.childNodes, ...desired]);
    return added;
  }

  function installFinanceWindowSentinel(rows, groupsByKey, tbody, renderedCount) {
    if (!els.feed || renderedCount >= rows.length || typeof IntersectionObserver !== 'function') return;
    const sentinel = document.createElement('div');
    sentinel.className = 'finance-window-sentinel feed-window-sentinel';
    els.feed.appendChild(sentinel);
    financeWindowObserver = new IntersectionObserver(items => {
      if (!sentinel.isConnected || trashView || window.MEMO_VARIANT !== 'finance') return;
      if (!items.some(item => item.isIntersecting)) return;
      financeWindowObserver.disconnect();
      financeWindowObserver = null;
      sentinel.remove();
      const end = Math.min(renderedCount + FINANCE_PAGE_SIZE, rows.length);
      const added = appendFinanceRows(rows, groupsByKey, tbody, renderedCount, end);
      financeWindowCount = end;
      // Same reason as the hydrate after the initial mount: these rows can come
      // from _rowCache, in which case their images were never (re-)observed.
      if (window.MemoLazy && typeof window.MemoLazy.hydrate === 'function') {
        window.MemoLazy.hydrate(tbody);
      }
      if (window.MemoMotion && !window.__memoRestoring && added.length) window.MemoMotion.stagger(added, 'fade');
      installFinanceWindowSentinel(rows, groupsByKey, tbody, end);
    }, { rootMargin: '800px 0px' });
    financeWindowObserver.observe(sentinel);
  }

  // Breadcrumb (‹ Home › Category) so a spending-category drill can be reset in
  // place — finance had no way out of a category before (you had to leave the
  // page). The back button resets the shared category filter and re-renders the
  // active variant (the change event routes through the global renderFeed()).
  function updateFinanceBreadcrumb(cat) {
    const bc = document.getElementById('breadcrumb');
    if (!bc) return;
    if (!bc._wired) {
      bc._wired = true;
      const back = bc.querySelector('.bc-back');
      if (back) back.addEventListener('click', () => {
        const st = window.MemoCore.getState();
        if (st.activeFilters && st.activeFilters.cats) st.activeFilters.cats.clear();
        if (els.categoryFilter) { els.categoryFilter.value = '__ALL__'; els.categoryFilter.dispatchEvent(new Event('change')); }
      });
    }
    if (cat && cat !== '__ALL__') {
      bc.hidden = false;
      const nm = bc.querySelector('.bc-name');
      if (nm) nm.textContent = cat;
    } else {
      bc.hidden = true;
    }
  }

  function renderFeed() {
    if (totalsObserver) { totalsObserver.disconnect(); totalsObserver = null; }
    if (financeWindowObserver) { financeWindowObserver.disconnect(); financeWindowObserver = null; }
    // Bin view stands in for the ledger entirely (trashed entries only).
    if (trashView) { renderTrash(); return; }
    window.MemoCore.releaseTrashFeed();
    // Leaving the bin: restore the ledger's table list-mode and hide the banner.
    if (els.feed && els.feed.dataset.listmode !== 'table') els.feed.dataset.listmode = 'table';
    const trashBar = document.getElementById('trashBanner');
    if (trashBar && !trashBar.hidden) trashBar.hidden = true;
    const { db, activeFilters } = window.MemoCore.getState();
    const q = els.searchBox ? els.searchBox.value.toLowerCase().trim() : '';
    const cat = els.categoryFilter ? els.categoryFilter.value : '__ALL__';
    updateFinanceBreadcrumb(cat);
    const df = activeFilters.dateFrom ? new Date(activeFilters.dateFrom).getTime() : null;
    const dt = activeFilters.dateTo ? (new Date(activeFilters.dateTo).getTime() + 24 * 3600 * 1000 - 1) : null;

    const activeSheet = getActiveSheet();
    updateSheetButton();

    const filtered = db.entries
      .filter(e => e.deletedAt === null || e.deletedAt === undefined)
      .filter(e => effSheet(e) === activeSheet)
      .filter(e => (cat === '__ALL__' ? true : e.category === cat))
      .filter(e => activeFilters.cats.size ? activeFilters.cats.has(e.category) : true)
      .filter(e => {
        const pdt = new Date(e.purchaseDate || e.ts).getTime();
        if (df && pdt < df) return false;
        if (dt && pdt > dt) return false;
        if (activeFilters.tags.size) {
          const _et = e.tags || [];
          const _ok = (activeFilters.tagMatch === 'all')
            ? Array.from(activeFilters.tags).every(t => _et.includes(t))
            : _et.some(t => activeFilters.tags.has(t));
          if (!_ok) return false;
        }
        if (!q) return true;
        const inDesc = (e.description || '').toLowerCase().includes(q);
        const inTags = (e.tags || []).some(t => (t || '').toLowerCase().includes(q));
        // Also search in item names
        const inItems = (e.items || []).some(i => (i.name || '').toLowerCase().includes(q));
        // ...and the store and notes.
        const inDetails = [e.store, e.notes].some(v => (v || '').toLowerCase().includes(q));
        return inDesc || inTags || inItems || inDetails;
      })
      .sort((a, b) => {
        const ad = new Date(a.purchaseDate || a.ts).getTime();
        const bd = new Date(b.purchaseDate || b.ts).getTime();
        return bd - ad;
      });

    // Evict cached rows for entries no longer in the result set (deleted/filtered).
    const _keepIds = new Set(filtered.map(e => e.id));
    for (const id of _rowCache.keys()) { if (!_keepIds.has(id)) _rowCache.delete(id); }

    // Compute totals
    const totals = filtered.reduce((acc, e) => {
      // Calculate subtotal from items if available, else use legacy price
      let subtotal = 0;
      if (e.items && e.items.length) {
          subtotal = e.items.reduce((s, i) => s + (i.totalPrice || 0), 0);
      } else {
          subtotal = (parseFloat(e.price) || 0) + (parseFloat(e.adjustment) || 0);
      }
      
      const taxNum = getTaxAmount(subtotal, e.tax);
      const totalNum = typeof e.total === 'number' ? e.total : (subtotal + taxNum);
      
      acc.subtotal += subtotal;
      acc.tax += taxNum;
      acc.total += totalNum;
      return acc;
    }, { subtotal: 0, tax: 0, total: 0 });

    if (els.feed) {
      els.feed.querySelector('.finance-window-sentinel')?.remove();
      els.feed.dataset.listmode = 'table';
    }
    const wrap = els.feed.querySelector('.tablewrap') || document.createElement('div'); wrap.className = 'tablewrap';
    const table = wrap.querySelector(':scope > table.listtable') || document.createElement('table'); table.className = 'listtable';
    // Explicit colgroup so table-layout:fixed always derives column widths from
    // these <col> widths, never from row content — keeps headers aligned even
    // when a row spans all columns (empty-state) or a column is display:none.
    if (!table.children.length) table.innerHTML = `
      <colgroup>
        <col class="col-date">
        <col class="col-desc">
        <col class="col-images">
        <col class="col-price">
        <col class="col-tax">
        <col class="col-total">
      </colgroup>
      <thead>
        <tr>
          <th class="col-date sortable" data-sort="date">Date<span class="sort-ind"></span></th>
          <th class="col-desc sortable" data-sort="desc">Description<span class="sort-ind"></span></th>
          <th class="col-images">Images</th>
          <th class="col-price sortable" data-sort="subtotal">Subtotal<span class="sort-ind"></span></th>
          <th class="col-tax sortable" data-sort="tax">Tax<span class="sort-ind"></span></th>
          <th class="col-total sortable" data-sort="total">Total<span class="sort-ind"></span></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    table.querySelectorAll('th.sortable').forEach(th => {
      const col = th.dataset.sort;
      th.classList.toggle('sorted', col === financeSort.col);
      const ind = th.querySelector('.sort-ind');
      if (ind) ind.textContent = col === financeSort.col ? (financeSort.dir === 'asc' ? ' \u25b2' : ' \u25bc') : '';
      th.onclick = () => {
        if (financeSort.col === col) financeSort.dir = financeSort.dir === 'asc' ? 'desc' : 'asc';
        else { financeSort.col = col; financeSort.dir = col === 'desc' ? 'asc' : 'desc'; }
        renderFeed();
      };
    });

    window.MemoVariant.__lastFiltered = () => filtered.slice();
    feedHasAttachments = filtered.some(e => (Array.isArray(e.images) && e.images.some(Boolean)) || (Array.isArray(e.attachments) && e.attachments.some(Boolean)));
    els.feed.classList.toggle('no-attachments', !feedHasAttachments);
    const monthGroups = groupByMonth(sortEntries(filtered));
    const groupsByKey = new Map(monthGroups.map(group => [group.key, group]));
    const financeRows = monthGroups.flatMap(group => group.entries.map(entry => ({ entry, monthKey: group.key })));
    const nextWindowKey = JSON.stringify({
      sheet: activeSheet,
      query: q,
      category: cat,
      dateFrom: activeFilters.dateFrom || '',
      dateTo: activeFilters.dateTo || '',
      categories: Array.from(activeFilters.cats || []).sort(),
      tags: Array.from(activeFilters.tags || []).sort(),
      sort: financeSort,
    });
    if (nextWindowKey !== financeWindowKey) {
      financeWindowKey = nextWindowKey;
      financeWindowCount = restoredWindow || FINANCE_PAGE_SIZE;
      restoredWindow = null;
    }
    if (typeof IntersectionObserver !== 'function') financeWindowCount = financeRows.length;
    const initialFinanceCount = Math.min(financeWindowCount, financeRows.length);
    const financeRendered = initialFinanceCount;
    appendFinanceRows(financeRows, groupsByKey, tbody, 0, financeRendered, true);

    if (filtered.length === 0) {
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = visibleColCount(); td.className = 'muted empty-row-cell'; td.textContent = 'No entries yet. Add one with +, or adjust filters.'; tr.appendChild(td); tbody.appendChild(tr);
    }

    const tfoot = table.tFoot || document.createElement('tfoot');
    tfoot.innerHTML = `
      <tr class="totals-row">
        <td class="col-date"></td>
        <td class="col-desc totals-label">Totals</td>
        <td class="col-images"></td>
        <td class="col-price">${formatMoneyFixed(totals.subtotal)}</td>
        <td class="col-tax">${formatMoneyFixed(totals.tax)}</td>
        <td class="col-total">${formatMoneyFixed(totals.total)}</td>
      </tr>`;
    if (!tfoot.parentNode) table.appendChild(tfoot);
    if (!table.parentNode) wrap.appendChild(table);

    const sticky = wrap.querySelector('.totals-sticky') || document.createElement('div');
    if (!sticky.className) sticky.className = 'totals-sticky hidden';
    sticky.innerHTML = `
      <div class="inner">
        <table class="listtable">
          <colgroup>
            <col class="col-date">
            <col class="col-desc">
            <col class="col-images">
            <col class="col-price">
            <col class="col-tax">
            <col class="col-total">
          </colgroup>
          <tbody>
            <tr>
              <td class="col-date"></td>
              <td class="col-desc totals-label">Totals</td>
              <td class="col-images"></td>
              <td class="col-price">${formatMoneyFixed(totals.subtotal)}</td>
              <td class="col-tax">${formatMoneyFixed(totals.tax)}</td>
              <td class="col-total">${formatMoneyFixed(totals.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
    if (!sticky.parentNode) wrap.appendChild(sticky);

    try {
      const target = tfoot.querySelector('.totals-row') || tfoot;
      totalsObserver = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (entry && entry.isIntersecting) {
          sticky.classList.add('hidden');
        } else {
          if (filtered.length > 0) sticky.classList.remove('hidden');
        }
        document.body.classList.toggle('totals-sticky-on', !sticky.classList.contains('hidden'));
      }, { threshold: 0.01 });
      totalsObserver.observe(target);
    } catch (e) { totalsObserver = null; }

    // Category spending summary sits above the table.
    window.MemoDom.reconcile(els.feed, filtered.length ? [buildCategorySummary(filtered), wrap] : [wrap]);
    // Idempotently observe newly inserted images, retaining existing targets.
    if (els.feed && window.MemoLazy && typeof window.MemoLazy.hydrate === 'function') {
      window.MemoLazy.hydrate(els.feed);
    }
    installFinanceWindowSentinel(financeRows, groupsByKey, tbody, financeRendered);

    // Staggered row entrance on view switches (sheet change / first load) —
    // covers the thumbnail-load flash. Opacity-only (transforms fight <table>
    // layout). Skipped while typing/sorting since the active sheet is unchanged.
    const finView = String(activeSheet);
    if (window.MemoMotion && !window.__memoTabSwitching && !window.__memoRestoring && finView !== _lastFinanceView) {
      window.MemoMotion.stagger(tbody.querySelectorAll('tr.entry-row'), 'fade');
    }
    _lastFinanceView = finView;

    updateFilterIndicator();
  }

  // Long-press / right-click a transaction row → shared context menu (finance's own
  // actions). Reuses the shared MemoCtx + the shared openEntryModal / batchDelete.
  function showRowMenu(ev, id) {
    if (!window.MemoCtx) return;
    const e = window.MemoCore.getState().db.entries.find(x => x.id === id);
    if (!e) return;
    window.MemoCtx.showMenu(ev.clientX, ev.clientY, [
      { html: 'Edit', onClick: () => { if (window.openEntryModal) window.openEntryModal(e); } },
      { html: 'View details', onClick: () => openDetail(id) },
      { sep: true },
      { html: 'Delete', danger: true, onClick: async () => {
        if (window.MemoCore.batchDelete) await window.MemoCore.batchDelete([id]);
        if (window.MemoShell) window.MemoShell.toast('Moved to recycle bin', { action: { label: 'Undo', onClick: function () { window.MemoCore.restore && window.MemoCore.restore(id); } } });
      } },
    ]);
  }

  function mkDetailItem(icon, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'modal-menu-item';
    button.innerHTML = `<span class="svg-icon ${icon}"></span> ${label}`;
    button.addEventListener('click', () => {
      const popup = document.getElementById('detailMenuPopup');
      if (popup) popup.classList.remove('open');
      onClick();
    });
    return button;
  }

  function gifSource(entry) {
    const isImage = window.MemoCore.isImage;
    const images = entry.images || [];
    for (let index = 0; index < images.length; index++) {
      const src = images[index];
      const stored = Array.isArray(entry._storedPaths) ? entry._storedPaths[index] : '';
      if (isImage(src) && (/^data:image\/gif/i.test(src || '') || /\.gif(?:[?#]|$)/i.test(src || '') || /\.gif(?:[?#]|$)/i.test(stored || ''))) {
        return { src, name: String(stored || src || 'animation.gif').split('/').pop() };
      }
    }
    return null;
  }

  async function entryImageAction(kind, entry) {
    const crop = window.MemoCrop;
    const images = (entry.images || []).filter(window.MemoCore.isImage);
    if (!crop || !images.length) return;
    try {
      const blob = await crop.srcToBlob(images[0]);
      const name = ((entry.description || 'image').replace(/\s+/g, ' ').trim().slice(0, 40)) || 'image';
      if (kind === 'copy') await crop.copyBlob(blob);
      else if (kind === 'save') {
        const how = crop.saveToPhone ? await crop.saveToPhone(blob, name) : (crop.saveBlob(blob, name), 'download');
        if (window.MemoShell) window.MemoShell.toast(how === 'gallery' ? 'Saved to your gallery' : 'Image downloaded', { kind: 'success' });
      }
      else if (kind === 'share') await crop.shareBlob(blob, name);
    } catch (error) {
      if (!error || error.name !== 'AbortError') console.warn('entry image ' + kind + ' failed:', error);
    }
  }

  function copyItemsCsv(items) {
    const headers = ['ID', 'Name', 'Description', 'Quantity', 'Unit Price', 'Total Price'];
    const rows = items.map((item, index) => [
      index + 1,
      `"${(item.name || '').replace(/"/g, '""')}"`,
      `"${(item.description || '').replace(/"/g, '""')}"`,
      item.amount,
      item.unitPrice,
      item.totalPrice
    ]);
    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    function fallbackCopy() {
      return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = csvContent;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand && document.execCommand('copy');
        textarea.remove();
        if (copied) resolve(); else reject(new Error('Clipboard unavailable'));
      });
    }
    const copy = navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
      ? navigator.clipboard.writeText(csvContent).catch(fallbackCopy)
      : fallbackCopy();
    copy.then(() => {
      if (window.MemoShell && typeof window.MemoShell.toast === 'function') window.MemoShell.toast('Table copied.', { kind: 'success' });
    }).catch(() => {
      if (window.MemoShell && typeof window.MemoShell.toast === 'function') window.MemoShell.toast('Could not copy the table.', { kind: 'error' });
    });
  }

  function buildDetailMenu(entry, imageList, items) {
    const button = document.getElementById('detailMenuBtn');
    const popup = document.getElementById('detailMenuPopup');
    if (!button || !popup) return;
    const actions = [];
    if (items.length) actions.push(mkDetailItem('svg-icon-copy', 'Copy table as CSV', () => copyItemsCsv(items)));
    if (imageList.length >= 2 && window.MemoPanel) {
      const combine = mkDetailItem('svg-icon-image', 'Combine to panel', () => {
        const sources = (entry.images || []).map((url, index) => ({
          url,
          entryId: entry.id,
          index,
          storedPath: Array.isArray(entry._storedPaths) ? (entry._storedPaths[index] || null) : null,
          safe: !!entry.safe,
        })).filter(item => window.MemoCore.isImage(item.url));
        window.MemoPanel.open(sources);
      });
      combine.id = 'detailCombineBtn';
      actions.push(combine);
    }
    if (imageList.length >= 2 && window.MemoGif) {
      const createGif = mkDetailItem('svg-icon-play', 'Create GIF', () => window.MemoGif.open(imageList));
      createGif.id = 'detailGifBtn';
      actions.push(createGif);
    }
    if (imageList.length && window.MemoTools) {
      const toolsItem = mkDetailItem('svg-icon-sparkles', window.MemoI18n.t('Image tools'), () => window.MemoTools.open(entry.id, (entry.images || []).indexOf(imageList[0])));
      toolsItem.id = 'detailToolsBtn';
      actions.push(toolsItem);
    }
    // The same tools as a button beside Edit, where people look for them.
    const toolsAction = document.getElementById('detailToolsAction');
    if (toolsAction) {
      toolsAction.hidden = !(imageList.length && window.MemoTools);
      toolsAction.onclick = () => window.MemoTools.open(entry.id, (entry.images || []).indexOf(imageList[0]));
    }
    if (imageList.length && window.MemoImageEditor) actions.push(mkDetailItem('svg-icon-edit', imageList.length > 1 ? window.MemoI18n.t('Choose image to edit') : window.MemoI18n.t('Edit image'), () => {
      if (imageList.length === 1) window.MemoImageEditor.openEntry(entry, (entry.images || []).indexOf(imageList[0]));
      else { window.MemoReader.open(entry, 0); window.MemoShell?.toast(window.MemoI18n.t('Choose a page, then use Edit image in its actions menu.')); }
    }));
    const editableGif = gifSource(entry);
    if (editableGif && window.MemoGifEditor) actions.push(mkDetailItem('svg-icon-edit', 'Edit GIF', () => window.MemoGifEditor.open(editableGif.src, editableGif.name)));
    if (imageList.length && window.MemoExifEditor) {
      const exif = mkDetailItem('svg-icon-settings', 'Edit EXIF metadata', () => window.MemoExifEditor.pickFromLibrary());
      exif.id = 'detailExifBtn';
      actions.push(exif);
    }
    if (imageList.length) {
      actions.push(mkDetailItem('svg-icon-copy', 'Copy image', () => entryImageAction('copy', entry)));
      actions.push(mkDetailItem('svg-icon-download', 'Save to Phone', () => entryImageAction('save', entry)));
      actions.push(mkDetailItem('svg-icon-share', 'Share image', () => entryImageAction('share', entry)));
    }
    popup.innerHTML = '';
    actions.forEach(action => popup.appendChild(action));
    popup.classList.remove('open');
    button.style.display = actions.length ? '' : 'none';
    if (!button._wired) {
      button._wired = true;
      button.addEventListener('click', (event) => { event.stopPropagation(); popup.classList.toggle('open'); });
      document.addEventListener('click', (event) => { if (event.target !== button && !popup.contains(event.target)) popup.classList.remove('open'); });
    }
  }

  function openDetail(id) {
    const { db } = window.MemoCore.getState();
    const e = db.entries.find(x => x.id === id);
    if (!e || !els.detailContent) return;
    const isImage = window.MemoCore.isImage;
    const imgsOnly = (e.images || []).filter(src => isImage(src));
    const otherFiles = (e.attachments || []).filter(a => a && !window.MemoCore.isImageAttachment(a));
    let items = Array.isArray(e.items) ? e.items.slice() : [];
    // Migration for display
    if (items.length === 0 && (e.price || e.adjustment)) {
        if (e.price) items.push({name:'Item', description:e.description, amount:1, unitPrice:e.price, totalPrice:e.price});
        if (e.adjustment) items.push({name:'Adjustment', description:'', amount:1, unitPrice:e.adjustment, totalPrice:e.adjustment});
    }
    els.detailContent.innerHTML = '';
    const meta = document.createElement('div');
    meta.className = 'muted';
    const date = e.purchaseDate || (e.ts ? localDay(e.ts) : '');
    const tr = (window.MemoI18n ? window.MemoI18n.t : (k => k));
    const paid = { card: tr('Card'), cash: tr('Cash'), transfer: tr('Transfer') }[e.paidWith] || e.paidWith || '';
    meta.textContent = [`Date: ${date}`, e.category || 'Uncategorized', e.store || '', paid].filter(Boolean).join(' • ');
    const description = document.createElement('h3');
    description.style.whiteSpace = 'pre-line';
    description.textContent = e.description || '(No description)';
    const tags = document.createElement('div');
    tags.className = 'tagsline';
    (e.tags || []).forEach(t => {
      const pill = document.createElement('span');
      pill.className = 'tagpill';
      pill.textContent = '#' + t;
      tags.appendChild(pill);
    });
    els.detailContent.append(meta, description, tags);
    if (e.notes) {
      const notes = document.createElement('p');
      notes.className = 'muted';
      notes.style.cssText = 'white-space:pre-line;margin:8px 0 0';
      notes.textContent = e.notes;
      els.detailContent.appendChild(notes);
    }
    if (!items.length && e.total) {
      const total = document.createElement('div');
      total.style.cssText = 'margin:12px 0 4px;font-weight:700;font-size:18px';
      total.textContent = tr('Total') + ' ' + formatMoneyFixed(e.total) + (e.tax ? ' · ' + tr('Tax included') + ' ' + formatMoney(e.tax, true) : '');
      els.detailContent.appendChild(total);
    }

    if (items.length > 0) {
      const itemWrap = document.createElement('div');
      itemWrap.style.cssText = 'overflow-x:auto;margin:14px 0 10px 0';
      const table = document.createElement('table');
      table.className = 'feed-table';
      table.style.cssText = 'width:100%;border-collapse:collapse';
      table.innerHTML = '<thead><tr style="background:var(--card);border-bottom:1px solid var(--border)"><th style="padding:8px;text-align:left">#</th><th style="padding:8px;text-align:left">Name</th><th style="padding:8px;text-align:left">Desc</th><th style="padding:8px;text-align:right">Qty</th><th style="padding:8px;text-align:right">Unit</th><th style="padding:8px;text-align:right">Total</th></tr></thead><tbody></tbody>';
      const body = table.querySelector('tbody');
      items.forEach((item, i) => {
        const row = document.createElement('tr');
        row.style.borderBottom = '1px solid var(--border)';
        const kind = item.kind === 'discount' ? tr('Discount') : item.kind === 'fee' ? tr('Fee / tip') : '';
        const values = [String(i + 1), (kind ? kind + ': ' : '') + (item.name || ''), item.description || '', String(item.amount ?? ''), formatMoney(item.unitPrice), formatMoney(item.totalPrice)];
        values.forEach((value, column) => {
          const cell = document.createElement('td');
          cell.style.padding = '8px';
          if (column >= 3) cell.style.textAlign = 'right';
          if (column === 1 || column === 2) {
            const clamp = document.createElement('div');
            clamp.className = 'clamp-scroll';
            clamp.textContent = value;
            cell.appendChild(clamp);
          } else {
            cell.textContent = value;
          }
          row.appendChild(cell);
        });
        body.appendChild(row);
      });
      const appendTotalRow = (label, value) => {
        const row = document.createElement('tr');
        row.style.cssText = 'font-weight:bold;background:var(--card)';
        const labelCell = document.createElement('td');
        labelCell.colSpan = 5;
        labelCell.style.cssText = 'padding:8px;text-align:right';
        labelCell.textContent = label;
        const valueCell = document.createElement('td');
        valueCell.style.cssText = 'padding:8px;text-align:right';
        valueCell.textContent = value;
        row.append(labelCell, valueCell);
        body.appendChild(row);
      };
      const taxLabel = 'Tax' + ((typeof e.tax === 'string' && e.tax.trim().endsWith('%')) ? ' (' + e.tax.trim() + ')' : '');
      appendTotalRow(taxLabel, formatMoney(getTaxAmount(items.reduce((sum, item) => sum + (item.kind === 'fee' ? 0 : (item.totalPrice || 0)), 0), e.tax), true));
      appendTotalRow('Total', formatMoney(e.total));
      itemWrap.appendChild(table);
      els.detailContent.appendChild(itemWrap);
    }

    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    thumbs.id = 'detailThumbs';
    thumbs.style.marginTop = '10px';
    if (imgsOnly.length) {
      imgsOnly.forEach((src, i) => {
        const image = document.createElement('img');
        image.dataset.eid = e.id;
        image.dataset.idx = String(i);
        image.src = src;
        image.alt = '';
        image.className = 'thumb';
        image.style.cssText = 'width:60px;height:60px;margin:2px;cursor:pointer';
        thumbs.appendChild(image);
      });
    } else {
      const empty = document.createElement('span');
      empty.className = 'muted';
      empty.textContent = 'No images';
      thumbs.appendChild(empty);
    }
    els.detailContent.appendChild(thumbs);

    if (otherFiles.length) {
      const fileList = document.createElement('div');
      fileList.className = 'filelist';
      fileList.style.cssText = 'margin-top:10px;display:grid;gap:6px';
      otherFiles.forEach(a => {
        const fileUrl = a.url || a.storedPath || '';
        const name = a.name || fileUrl.split('/').pop() || 'Attachment';
        const link = document.createElement('a');
        link.href = fileUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.style.cssText = 'color:#93c5fd;text-decoration:none;font-size:13px';
        const icon = document.createElement('span');
        icon.className = 'svg-icon svg-icon-file';
        link.append(icon, document.createTextNode(' ' + name));
        fileList.appendChild(link);
      });
      els.detailContent.appendChild(fileList);
    }
    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.textContent = 'Tip: Open an image to view it. Drag to reorder (saves on drop).';
    els.detailContent.appendChild(tip);
      buildDetailMenu(e, imgsOnly, items);

    const cont = els.detailContent.querySelector('#detailThumbs');
    let startIdx = null;
    cont.querySelectorAll('img').forEach((im, idx) => {
      im.draggable = true;
      im.addEventListener('dragstart', () => { startIdx = idx; im.style.opacity = .5; });
      im.addEventListener('dragend', async () => {
        im.style.opacity = 1;
        startIdx = null;
        if (MODE === 'server') {
          const entry = db.entries.find(x => x.id === id);
          await ServerAPI.update(id, { images: entry.images });
        } else {
          saveAll();
        }
      });
      im.addEventListener('dragover', (ev) => ev.preventDefault());
      im.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const dst = idx; if (startIdx === null || startIdx === dst) return;
        const arr = imgsOnly.slice(); const item = arr.splice(startIdx, 1)[0]; arr.splice(dst, 0, item);
        const nonImgs = (e.images || []).filter(src => !isImage(src));
        e.images = arr.concat(nonImgs);
        openDetail(e.id);
      });
      im.addEventListener('click', () => window.MemoReader && window.MemoReader.open(e,idx));
    });
    if (els.detailDlg) {
      els.detailDlg.dataset.entryId = id;
      if (window.MemoCore && window.MemoCore.setActiveEntryFilter) window.MemoCore.setActiveEntryFilter(id);
      els.detailDlg.showModal();
    }
  }

  function applyItems(items) {
    if (FE()) FE().applyItems(items);
  }

  // ── Recycle bin as a feed view (mirrors the memo variant) ──────────────────
  // Same idea as Safe: the bin isn't a separate dialog, it's the feed showing
  // only trashed entries, with a fade on the way in and out. The shared trash
  // banner, the recycle cards and restore / delete-forever all come from
  // MemoCore, so this is the memo behaviour re-used rather than re-implemented.
  let trashView = false;
  function renderTrash() {
    const C = window.MemoCore;
    const deleted = (C && C.deletedEntries ? C.deletedEntries() : [])
      .filter(e => !window.MemoPrivacy || window.MemoPrivacy.canViewEntry(e));
    updateTrashBanner(deleted.length);
    if (!els.feed) return;
    // Trashed entries render as the shared recycle CARDS (not the finance
    // ledger table), so the bin looks and behaves the same on both pages and
    // inherits the card's Restore / Delete-forever actions. Drop the table
    // list-mode while we're here so the cards lay out in the normal grid.
    els.feed.removeAttribute('data-listmode');
    C.renderTrashFeed(deleted);
  }
  function updateTrashBanner(count) {
    const bar = document.getElementById('trashBanner');
    if (!bar) return;
    bar.hidden = !trashView;
    if (!bar._wired) {
      bar._wired = true;
      // Dispatch through the active variant — the banner is shared chrome and
      // is only wired once, by whichever variant opens the bin first.
      const active = () => window.MemoVariant || null;
      const exit = bar.querySelector('.trash-exit');
      if (exit) exit.addEventListener('click', () => {
        const v = active();
        if (v && typeof v.exitTrash === 'function') v.exitTrash();
      });
      const empty = bar.querySelector('.trash-empty');
      if (empty) empty.addEventListener('click', async () => {
        if (window.MemoCore && window.MemoCore.emptyRecycleBin) await window.MemoCore.emptyRecycleBin();
        const v = active();
        if (v && typeof v.renderFeed === 'function') v.renderFeed();
      });
    }
    const c = bar.querySelector('.trash-count');
    if (c) c.textContent = count + ' item' + (count === 1 ? '' : 's');
    const emptyBtn = bar.querySelector('.trash-empty');
    if (emptyBtn) emptyBtn.disabled = !count;
  }
  function setTrashView(on) {
    trashView = !!on;
    document.body.classList.toggle('trash-view', trashView);
    if (els.recycleBinBtn) els.recycleBinBtn.classList.toggle('active', trashView);
    renderFeed();
    if (els.feed) window.MemoDom.animate(els.feed, [{ opacity: 0.7 }, { opacity: 1 }], { duration: 140 });
  }
  function toggleTrash() { setTrashView(!trashView); }
  function exitTrash() { if (trashView) setTrashView(false); }
  // Android back closes the bin first (memo does the same). Only claims the
  // event while the bin is open, so every other back press behaves as before.
  function handleBack() {
    if (trashView) { exitTrash(); return true; }
    return false;
  }

  var __variantModule = {
    captureDraft: () => (FE() ? FE().captureDraft() : null),
    restoreDraft: draft => { if (draft && FE()) FE().restoreDraft(draft); },
    captureView: () => ({ window: financeWindowCount, collapsed: [...collapsedMonths], sort: financeSort, sheet: getActiveSheet(), trash: trashView }),
    restoreView: state => {
      restoredWindow = Math.max(FINANCE_PAGE_SIZE, Number(state.window) || FINANCE_PAGE_SIZE);
      financeWindowKey = null;
      collapsedMonths.clear(); (state.collapsed || []).forEach(g => collapsedMonths.add(g));
      if (state.sort) financeSort = state.sort;
      if (state.sheet) setActiveSheet(state.sheet);
      trashView = !!state.trash;
    },
    renderFeed,
    openDetail,
    normalizeServerMemo,
    openEntryModalHook,
    collectAdditionalFields,
    applyItems,
    activeSheet: () => getActiveSheet(),
    toggleTrash,         // recycle bin as a feed view (mirrors memo)
    exitTrash,
    isTrashView: () => trashView,
    handleBack,
  };

  // Register in the shell's variant registry so the single-page shell can flip
  // MemoCore between memo and finance without a page reload. In the classic
  // multi-page build only this module loads, so it also starts core directly.
  window.MemoVariantRegistry = window.MemoVariantRegistry || {};
  window.MemoVariantRegistry['finance'] = __variantModule;
  if (!window.MemoVariant) window.MemoVariant = __variantModule;
  if (window.__MEMO_SPA__) {
    if (typeof window.MemoShellVariantReady === 'function') window.MemoShellVariantReady('finance');
  } else {
    window.MemoCore.start();
  }
})();
