/**
 * Memo System Core – Shared logic for both variants
 * Variants must define window.MemoVariant with methods:
 *  - renderFeed()
 *  - openDetail(id)
 *  - normalizeServerMemo(m)
 *  - openEntryModalHook(entry) [optional]
 *  - collectAdditionalFields(entry, isNew) [optional]
 * Then call: window.MemoCore.start()
 */

// =======================
// Config
// =======================
const Contracts = (typeof window !== 'undefined' && window.MemoContracts) ? window.MemoContracts : null;
const MemoApi = (typeof window !== 'undefined' && window.MemoApi) ? window.MemoApi : null;
const Runtime = (typeof window !== 'undefined' && window.MemoRuntime) ? window.MemoRuntime : null;

function getService(name, fallback) {
  if (Runtime && typeof Runtime.getService === 'function') {
    return Runtime.getService(name, fallback);
  }
  if (Contracts && typeof Contracts.getService === 'function') {
    const svc = Contracts.getService(name);
    if (svc) return svc;
  }
  return fallback;
}

function getApiBase() {
  if (Runtime && typeof Runtime.getApiBase === 'function') {
    return Runtime.getApiBase();
  }
  if (Contracts) return Contracts.getApiBase();
  return "";
}

function getMode() {
  if (Contracts) return Contracts.getMode();
  return MODE;
}

function setMode(mode) {
  MODE = mode;
  if (Contracts) {
    Contracts.setMode(mode);
  } else {
    window.MODE = mode;
  }
  return MODE;
}

function getSyncManager() {
  return getService('syncManager', window.SyncManager);
}

function getOperationQueue() {
  return getService('operationQueue', window.OperationQueue);
}

function nativeHaptic(type) {
  if (window.MemoNativeUi) void window.MemoNativeUi.haptic(type);
}
// Variant detection (default|finance). Prefer explicit window.MEMO_VARIANT or <meta name="memo-variant" content="finance">.
// In the single-page shell this is re-pointable: switchVariant() reassigns it so
// one memo-core instance renders both the memo and finance screens against the
// one local database. Left as `let` (was `const`) so the shell can flip it; all
// existing reads keep working unchanged.
let MEMO_VARIANT = (function(){
  if (typeof window !== 'undefined' && window.MEMO_VARIANT) return String(window.MEMO_VARIANT).toLowerCase();
  const meta = (typeof document !== 'undefined') ? document.querySelector('meta[name="memo-variant"]') : null;
  const mval = meta?.getAttribute('content');
  const metaVariant = (mval || '').trim().toLowerCase();
  if (metaVariant === 'finance' || metaVariant === 'default') return metaVariant;
  let storedVariant = '';
  try { storedVariant = (localStorage.getItem('memo_variant') || '').trim().toLowerCase(); } catch (_ignored) {}
  return (storedVariant === 'finance' || storedVariant === 'default') ? storedVariant : 'default';
})();
function getVariant(){ return MEMO_VARIANT; }
// Storage keys are variant-derived; keep them as functions so a runtime variant
// switch reads/writes the correct localStorage fallback bucket.
function dbKey(){ return (MEMO_VARIANT === 'finance') ? 'memo_finance_db_v1' : 'memo_db_v1'; }

// Guarded query helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// =======================
// DOM refs (superset; finance-only fields will be null in default UI)
// =======================
const els = {
  feed: $('#feed'),
  fab: $('#fab'),
  entryDlg: $('#entryDlg'),
  detailDlg: $('#detailDlg'),
  dlgTitle: $('#dlgTitle'),
  desc: $('#desc'),
  images: $('#images'),
  categoryInput: $('#categoryInput'),
  newCategory: $('#newCategory'),
  addCategoryBtn: $('#addCategoryBtn'),
  tagInput: $('#tagInput'),
  tagDropdown: $('#tagDropdown'),
  tagChips: $('#tagChips'),
  cancelBtn: $('#cancelBtn'),
  saveBtn: $('#saveBtn'),
  categoryFilter: $('#categoryFilter'),
  searchBox: $('#searchBox'),
  filtersBtn: $('#filtersBtn'),
  chooseDirBtn: $('#chooseDirBtn'),
  fsStatus: $('#fsStatus'),
  detailContent: $('#detailContent'),
  deleteBtn: $('#deleteBtn'),
  editBtn: $('#editBtn'),
  closeDetailBtn: $('#closeDetailBtn'),
  dragGrid: $('#dragGrid'),
  filtersDlg: $('#filtersDlg'),
  dateFrom: $('#dateFrom'),
  dateTo: $('#dateTo'),
  quickThisMonth: $('#quickThisMonth'),
  quickClearDates: $('#quickClearDates'),
  filterCats: $('#filterCats'),
  filterTagSearch: $('#filterTagSearch'),
  filterTags: $('#filterTags'),
  filtersReset: $('#filtersReset'),
  filtersCancel: $('#filtersCancel'),
  filtersApply: $('#filtersApply'),
  manageTagsLink: $('#manageTagsLink'),
  tagManager: $('#tagManager'),
  tagMgrList: $('#tagMgrList'),
  tagMgrUndo: $('#tagMgrUndo'),
  tagMgrClose: $('#tagMgrClose'),
  // chat
  chatBtn: $('#chatBtn'),
  chatDebugBtn: $('#chatDebugBtn'),
  // chat context picker
  chatCtxDateFrom: $('#chatCtxDateFrom'),
  chatCtxDateTo: $('#chatCtxDateTo'),
  chatCtxQuickThisMonth: $('#chatCtxQuickThisMonth'),
  chatCtxClearDates: $('#chatCtxClearDates'),
  chatCtxCats: $('#chatCtxCats'),
  chatCtxTagSearch: $('#chatCtxTagSearch'),
  chatCtxTags: $('#chatCtxTags'),
  chatCtxReset: $('#chatCtxReset'),
  chatCtxCancel: $('#chatCtxCancel'),
  chatCtxApply: $('#chatCtxApply'),
  lightbox: $('#lightbox'),
  lbImg: $('#lbImg'),
  lbPrev: $('#lbPrev'),
  lbNext: $('#lbNext'),
  lbClose: $('#lbClose'),
  lbCounter: $('#lbCounter'),
  lbStrip: $('#lbStrip'),
  calendarDlg: $('#calendarDlg'),
  calendarBtn: $('#calendarBtn'),
  calPrev: $('#calPrev'),
  calNext: $('#calNext'),
  calHeading: $('#calHeading'),
  calView: $('#calView'),
  calGrid: $('#calGrid'),
  calApply: $('#calApply'),
  calCancel: $('#calCancel'),
  calUp: $('#calUp'),
  calPickDay: $('#calPickDay'),
  calLegend: $('#calLegend'),
  calDrill: $('#calDrill'),
  calClearSel: $('#calClearSel'),
  // finance-only
  entryDate: $('#entryDate'),
  price: $('#price'),
  tax: $('#tax'),
  adjustment: $('#adjustment'),
  total: $('#total'),
  dropzone: $('#dropzone'),
  // recycle bin
  recycleBinBtn: $('#recycleBinBtn'),
  recycleBinDlg: $('#recycleBinDlg'),
  recycleBinFeed: $('#recycleBinFeed'),
  emptyRecycleBin: $('#emptyRecycleBin'),
  closeRecycleBin: $('#closeRecycleBin')
};

// No-op hook (memo-filter.js may override visually)
function updateFilterIndicator() { /* optional hook in your app; safe no-op here */ }

// =======================
// State
// =======================
// Variant-aware local storage keys are dbKey()/chatKey() (defined above) so a
// runtime variant switch targets the right bucket. SETTINGS_KEY is shared.
const SETTINGS_KEY = 'memo_settings_v1';

let MODE = 'detecting'; // 'server' | 'local' | 'capacitor'
setMode(MODE);
window.MEMO_VARIANT = MEMO_VARIANT; // Make MEMO_VARIANT accessible globally
let db = ({ entries: [] });
let settings = ({ categories: ['Uncategorized'], tags: [], tagCounts: {}, fsEnabled: false, memoDirHandle: undefined });

let workingTags = new Set();
// Tags typed while an entry editor is open are deliberately not written to
// settings.tags: that list is derived from saved entries. Keep them available
// for the lifetime of this editor instead, so deselecting a new tag does not
// make it disappear from the picker before the user finishes the entry.
let workingTagDrafts = new Set();
let editingId = null;
let modalImages = []; // [{src, file?, existing, storedPath?}]
let modalFilesExtra = []; // non-image attachments (e.g. pdf) [{name, url, file?, existing, storedPath?, type}]
let dragSrcIdx = null;
const RECYCLE_PAGE_SIZE = 60;
let recycleWindowObserver = null;
let expiredDeleteInterval = null;

// `entryId` is contextual rather than a feed predicate.  It records which memo
// detail is currently open so child tools can inherit that location as a local
// picker filter without exposing it in (or narrowing) the main Filters UI.
let activeFilters = { dateFrom: null, dateTo: null, cats: new Set(), tags: new Set(), tagMatch: 'any', entryId: null };
// Active chat context chips: [{ id, label, filters: {dateFrom,dateTo,cats,tags}, entries: [...] }]

// =======================
// Server detection & API (delegated)
// =======================
const ServerAPI = (Contracts && typeof Contracts.getService === 'function' && Contracts.getService('serverApi'))
  || (MemoApi && typeof MemoApi.getServerAPI === 'function'
  ? MemoApi.getServerAPI()
  : (Runtime && typeof Runtime.getServerAPI === 'function' ? Runtime.getServerAPI() : null));

async function detectMode() {
  if (MemoApi && typeof MemoApi.detectMode === 'function') {
    setMode(await MemoApi.detectMode());
  } else {
    setMode('local');
  }
  return MODE;
}

// =======================
// Local storage + FS Access
// =======================
function getStateDb() {
  // Every mode uses the same durable local projection, including a browser
  // served by the sync server. Network availability must not select a new store.
  const svc = getService('stateDb', window.MemoStateDb);
  return (svc && typeof svc.ready === 'function' && svc.ready()) ? svc : null;
}
// StateDb can restore cache-owned Object URLs to durable /uploads/... paths when
// a blob is invalidated. This observer resolves those stable paths again when a
// later feed window or detail surface enters the DOM, allowing production to
// keep a finite Blob URL cache without leaving mounted images revoked.
let mountedImageObserver = null;
let mountedImageHydrationReady = false;
const mountedImageHydrations = new Map();

function stableStoredRel(src, stateDb) {
  if (!src || typeof src !== 'string' || src.startsWith('blob:') || src.startsWith('data:')) return null;
  let path = src;
  try { path = new URL(src, window.location.href).pathname; } catch (_e) {}
  path = String(path).split('?')[0].split('#')[0];
  if (!/(^|\/)uploads\//.test(path)) return null;
  return stateDb.urlToRel(path);
}

function patchMountedImageSources(host, entry, stateDb) {
  if (!host || !host.isConnected || !entry || !Array.isArray(entry._storedPaths)) return;
  const byPath = new Map();
  entry._storedPaths.forEach((path, index) => {
    const url = entry.images && entry.images[index];
    if (path && typeof url === 'string' && url.startsWith('blob:')) byPath.set(stateDb.urlToRel(path), url);
  });
  if (!byPath.size) return;
  const images = [];
  if (host.matches && host.matches('img')) images.push(host);
  if (host.querySelectorAll) images.push(...host.querySelectorAll('img'));
  images.forEach(image => {
    ['data-src', 'src'].forEach(attribute => {
      const current = image.getAttribute(attribute);
      const rel = stableStoredRel(current, stateDb);
      const replacement = rel && byPath.get(rel);
      if (replacement) image.setAttribute(attribute, replacement);
    });
  });
}

function mountedHostEntryId(host) {
  if (!host) return null;
  if (host.id === 'detailDlg') return host.dataset.entryId || null;
  return host.dataset && host.dataset.id || null;
}

function collectMountedEntryHosts(root) {
  const hosts = new Set();
  if (!root) return hosts;
  const element = root.nodeType === 1 ? root : null;
  if (element && element.matches('[data-id],#detailDlg[data-entry-id]')) hosts.add(element);
  if (element && element.closest) {
    const closest = element.closest('[data-id],#detailDlg[data-entry-id]');
    if (closest) hosts.add(closest);
  }
  if (root.querySelectorAll) {
    root.querySelectorAll('[data-id],#detailDlg[data-entry-id]').forEach(host => hosts.add(host));
  }
  return hosts;
}

function hydrateMountedEntryHost(host) {
  const stateDb = getStateDb();
  const id = mountedHostEntryId(host);
  if (!stateDb || !id) return Promise.resolve();
  const entry = db.entries.find(candidate => candidate && candidate.id === id);
  const variant = MEMO_VARIANT;
  if (!entry || !(entry.images || []).some(src => stableStoredRel(src, stateDb))) return Promise.resolve();

  let inFlight = mountedImageHydrations.get(id);
  if (!inFlight) {
    inFlight = stateDb.hydrateImages(entry).finally(() => {
      if (mountedImageHydrations.get(id) === inFlight) mountedImageHydrations.delete(id);
    });
    mountedImageHydrations.set(id, inFlight);
  }
  return inFlight.then(() => {
    if (variant === MEMO_VARIANT && db.entries.find(candidate => candidate.id === id) === entry) patchMountedImageSources(host, entry, stateDb);
  });
}

function hydrateMountedImages(root) {
  const jobs = [];
  collectMountedEntryHosts(root || document).forEach(host => jobs.push(hydrateMountedEntryHost(host)));
  return Promise.all(jobs);
}

function installMountedImageHydration() {
  if (mountedImageHydrationReady) return;
  mountedImageHydrationReady = true;
  if (typeof MutationObserver === 'function') {
    mountedImageObserver = new MutationObserver(records => {
      records.forEach(record => {
        if (record.type === 'attributes') hydrateMountedImages(record.target);
        record.addedNodes.forEach(node => hydrateMountedImages(node));
      });
    });
    mountedImageObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'data-entry-id']
    });
  }
  hydrateMountedImages(document);
  bindMountedImageLifecycle();
}

// Bound once, not per install: installMountedImageHydration() is re-entrant now
// (the re-arm below calls it again), and registering the pagehide handler inside
// it would stack a new listener on every resume.
let mountedImageLifecycleBound = false;
function bindMountedImageLifecycle() {
  if (mountedImageLifecycleBound) return;
  mountedImageLifecycleBound = true;

  window.addEventListener('pagehide', event => {
    if (window.MemoLifecycle?.retain(event) || (event && event.persisted)) return;
    if (mountedImageObserver) mountedImageObserver.disconnect();
    mountedImageObserver = null;
    mountedImageHydrations.clear();
    mountedImageHydrationReady = false;
  });

  // …and put it back when the app returns to the foreground. A Capacitor
  // WebView fires pagehide when you press Home but keeps the document alive, so
  // without this the MutationObserver stays dead and images mounted afterwards
  // are never hydrated from the local blob store — the "thumbnails all gone
  // after leaving and coming back" bug. Guarded + idempotent.
  const rearm = () => {
    if (document.visibilityState === 'hidden') return;
    installMountedImageHydration();
    hydrateMountedImages(document);
    if (window.MemoLazy && typeof window.MemoLazy.hydrate === 'function') {
      window.MemoLazy.hydrate(document);
    }
  };
  window.addEventListener('pageshow', rearm);
  let assetFrame = 0;
  window.addEventListener('memo:assets-cached', () => {
    if (assetFrame) return;
    assetFrame = requestAnimationFrame(() => { assetFrame = 0; rearm(); });
  });
  document.addEventListener('visibilitychange', rearm);
}
function loadAll() {
  const stateDb = getStateDb();
  if (stateDb) {
    // Offline-independent engine: read entries + settings from in-browser SQLite.
    db.entries = stateDb.loadEntries(MEMO_VARIANT) || [];
    const s = stateDb.loadSettings();
    if (s) settings = { ...settings, ...s };
  } else {
    try { const raw = localStorage.getItem(dbKey()); if (raw) db = JSON.parse(raw); } catch (e) { db = { entries: [] }; }
    try { const raw = localStorage.getItem(SETTINGS_KEY); if (raw) settings = JSON.parse(raw); } catch (e) { /* ignore */ }
  }
  if (!Array.isArray(settings.categories) || !settings.categories.length) settings.categories = ['Uncategorized'];
  recomputeTags();
  // Union in every category present in the loaded entries, so folder cards built from
  // entry categories always have a matching <option> (otherwise opening such a folder
  // sets the select to "" → 0 entries + the breadcrumb hides).
  recomputeCategories();
}
function saveAll() {
  const stateDb = getStateDb();
  if (stateDb) {
    stateDb.saveEntries(db.entries, MEMO_VARIANT);
    stateDb.saveSettings(settings);
  } else {
    // Server mode: small localStorage cache for instant first paint before
    // ServerAPI loads. The SQLite store is authoritative in every other mode.
    localStorage.setItem(dbKey(), JSON.stringify(db));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
}
function recomputeTags() {
  const counts = {};
  const P = window.MemoPrivacy;
  for (const e of db.entries) {
    // Don't let a Safe/locked entry's tags surface in the tag list, filter, or
    // manager — the projection matches the current view (Safe view includes them).
    if (P && P.canViewEntry && !P.canViewEntry(e)) continue;
    for (const t of (e.tags || [])) counts[t] = (counts[t] || 0) + 1;
  }
  const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  settings.tags = tags;
  settings.tagCounts = counts;
}
// Union settings.categories with every category present in the entries — so a cold
// client that just pulled a server snapshot (or a synced create from another device)
// has those categories in its dropdown/picker, not only in the folder view.
function recomputeCategories() {
  const fromEntries = db.entries.map(e => e.category || 'Uncategorized');
  settings.categories = Array.from(new Set(['Uncategorized', ...(settings.categories || []), ...fromEntries]));
}
// Op-queue hook: called after it applies server state (a snapshot or pulled ops).
// Re-derive categories/tags, refresh the category controls, and repaint the feed.
function applyServerState() {
  recomputeCategories();
  recomputeTags();
  refreshCategoryControls();
  renderFeed();
}


// =======================
// Utils
// =======================
function uid() { return 'e_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
// Card timestamp — honours the "Date format" View setting (memo-view.js) when
// present, else the locale default. See MemoView.formatDate.
function fmtDate(ts) {
  if (window.MemoView && window.MemoView.formatDate) return window.MemoView.formatDate(ts);
  return new Date(ts).toLocaleString();
}
function slug(s) { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function todayFolder(ts) {
  const d = new Date(ts);
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// =======================
// UI helpers
// =======================
function refreshCategoryControls() {
  // "Uncategorized" is always offered as a category, even if the user's list
  // doesn't explicitly contain it.
  const base = settings.categories || [];
  const categories = base.includes('Uncategorized') ? base : ['Uncategorized', ...base];
  if (els.categoryFilter) {
    // Preserve the current selection across rebuilds so opening the entry modal
    // (which refreshes these controls) doesn't kick us out of the current folder.
    const prev = els.categoryFilter.value;
    els.categoryFilter.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = '__ALL__';
    allOption.textContent = 'All categories';
    els.categoryFilter.appendChild(allOption);
    categories.forEach(c => {
      const option = document.createElement('option');
      option.value = c;
      option.textContent = c;
      els.categoryFilter.appendChild(option);
    });
    if (prev && Array.from(els.categoryFilter.options).some(o => o.value === prev)) els.categoryFilter.value = prev;
  }
  if (els.categoryInput) {
    els.categoryInput.innerHTML = '';
    categories.forEach(c => {
      const option = document.createElement('option');
      option.value = c;
      option.textContent = c;
      els.categoryInput.appendChild(option);
    });
  }
  if (els.filterCats) {
    els.filterCats.innerHTML = '';
    categories.forEach(c => {
      const label = document.createElement('label');
      label.className = 'check-row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.cat = c;
      input.checked = activeFilters.cats.has(c);
      const text = document.createElement('span');
      text.className = 'cr-text';
      text.textContent = c;
      label.append(input, text);
      els.filterCats.appendChild(label);
    });
    els.filterCats.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const c = e.target.dataset.cat;
        if (e.target.checked) activeFilters.cats.add(c); else activeFilters.cats.delete(c);
        updateFilterIndicator();
      });
    });
  }
}
function ensureCategory(c) {
  if (!settings.categories.includes(c)) {
    settings.categories.push(c);
    saveAll(); refreshCategoryControls();
  }
}

function renderTagChips() {
  if (!els.tagChips) return;
  els.tagChips.innerHTML = '';
  for (const t of workingTags) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.appendChild(document.createTextNode(t + ' '));
    const button = document.createElement('button');
    button.title = 'Remove tag';
    button.setAttribute('aria-label', 'Remove tag ' + t);
    button.textContent = '×';
    button.addEventListener('click', () => { workingTags.delete(t); renderTagChips(); });
    c.appendChild(button);
    els.tagChips.appendChild(c);
  }
  // OCR: refresh suggested-tag styling after chips render
  if (window.MemoOcr && typeof window.MemoOcr.refreshSuggestedTagStyles === 'function') {
    window.MemoOcr.refreshSuggestedTagStyles();
  }
}

// =======================
// Modals: create/edit (core pieces)
// =======================
function openEntryModal(entry = null) {
  editingId = entry ? entry.id : null;
  if (els.dlgTitle) els.dlgTitle.textContent = entry ? 'Edit Entry' : 'New Entry';
  if (els.desc) els.desc.value = entry ? (entry.description || '') : '';
  workingTags = new Set(entry ? (entry.tags || []) : []);
  workingTagDrafts = new Set();
  renderTagChips();

  refreshCategoryControls();
  if (entry) { ensureCategory(entry.category); if (els.categoryInput) els.categoryInput.value = entry.category; }
  else if (els.categoryInput) {
    // New entry: default to the folder we're viewing (so adding inside a category
    // keeps the entry in that category), else the first category.
    const pref = (window.MemoVariant && typeof window.MemoVariant.preferredNewCategory === 'function')
      ? window.MemoVariant.preferredNewCategory() : null;
    // In a folder → default to that category; at root → Uncategorized.
    els.categoryInput.value = pref || 'Uncategorized';
  }

  // Variant hook (e.g., set finance fields)
  if (window.MemoVariant && typeof window.MemoVariant.openEntryModalHook === 'function') {
    window.MemoVariant.openEntryModalHook(entry);
  }

  modalImages = [];
  modalFilesExtra = [];
  if (entry?.images?.length) {
    const stored = Array.isArray(entry._storedPaths) ? entry._storedPaths : [];
    entry.images.forEach((src, i) => {
      modalImages.push({ src, existing: true, storedPath: stored[i] || null });
    });
  }
  // Load prior attachments array if present
  if (Array.isArray(entry?.attachments)) {
    entry.attachments.forEach(att => {
      if (!att || !att.url) return;
      // Normalize absolute URLs (e.g. http://localhost:5050/uploads/...) to relative paths
      let attUrl = att.url;
      try {
        if (/^https?:\/\//i.test(attUrl)) {
          const u = new URL(attUrl);
          attUrl = u.pathname;
        }
      } catch (_e) {}
      const isImg = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(attUrl);
      if (isImg) {
        if (!modalImages.some(mi => mi.src === attUrl)) modalImages.push({ src: attUrl, existing: true, storedPath: att.storedPath || null });
      } else {
        modalFilesExtra.push({ name: att.name || attUrl.split('/').pop(), url: attUrl, existing: true, storedPath: att.storedPath || null, type: att.type || 'application/octet-stream' });
      }
    });
  }
  if (els.images) els.images.value = '';
  rebuildDragGrid();
  renderExtraAttachmentsList();

  if (els.entryDlg) els.entryDlg.showModal();

  // OCR hook – notify after modal is fully open
  if (window.MemoOcr && typeof window.MemoOcr.onModalOpen === 'function') {
    requestAnimationFrame(() => window.MemoOcr.onModalOpen(entry ? entry.id : null));
  }
}

// Tag chips/dropdown
let dropActiveIndex = -1;
function openTagDropdown(items, createText) {
  if (!els.tagDropdown) return;
  if (items.length === 0 && !createText) { closeTagDropdown(); return; }
  els.tagDropdown.innerHTML = '';
  let optionIndex = 0;
  if (createText) {
    const n = document.createElement('div');
    n.className = 'dropitem active';
    n.dataset.create = '1';
    n.id = 'tagOption-' + optionIndex++;
    n.setAttribute('role', 'option');
    const label = document.createElement('span');
    label.textContent = `Create tag “${createText}”`;
    n.appendChild(label);
    els.tagDropdown.appendChild(n);
  }
  items.forEach((t) => {
    const d = document.createElement('div');
    d.className = 'dropitem';
    d.id = 'tagOption-' + optionIndex++;
    d.setAttribute('role', 'option');
    const label = document.createElement('span');
    label.textContent = t;
    const count = document.createElement('span');
    count.className = 'muted';
    count.textContent = String(settings.tagCounts[t] || 0);
    d.append(label, count);
    els.tagDropdown.appendChild(d);
  });
  els.tagDropdown.classList.remove('hidden');
  if (els.tagInput) els.tagInput.setAttribute('aria-expanded', 'true');
  dropActiveIndex = 0;
  updateDropActive();

  els.tagDropdown.querySelectorAll('.dropitem').forEach((el) => {
    el.addEventListener('mousedown', (ev) => { ev.preventDefault(); selectDropItem(el); });
    el.addEventListener('touchstart', (ev) => { ev.preventDefault(); selectDropItem(el); }, { passive: false });
    el.addEventListener('pointerdown', (ev) => { if (ev.pointerType !== 'mouse') { ev.preventDefault(); selectDropItem(el); } });
  });
}
function closeTagDropdown() {
  if (els.tagDropdown) els.tagDropdown.classList.add('hidden');
  if (els.tagInput) {
    els.tagInput.setAttribute('aria-expanded', 'false');
    els.tagInput.removeAttribute('aria-activedescendant');
  }
  dropActiveIndex = -1;
}
function updateDropActive() {
  if (!els.tagDropdown) return;
  const items = [...els.tagDropdown.querySelectorAll('.dropitem')];
  items.forEach((el, i) => {
    const active = i === dropActiveIndex;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', String(active));
  });
  const active = items[dropActiveIndex];
  if (els.tagInput) {
    if (active && active.id) els.tagInput.setAttribute('aria-activedescendant', active.id);
    else els.tagInput.removeAttribute('aria-activedescendant');
  }
}
function selectDropItem(el) {
  if (el.dataset.create === '1') { addTag(els.tagInput.value); }
  else { addTag(el.querySelector('span').textContent); }
  if (els.tagInput) els.tagInput.value = '';
  closeTagDropdown();
  if (els.tagInput) els.tagInput.focus();
}
function addTag(t) {
  const val = (t || '').trim();
  if (!val) return;
  if (!settings.tags.some(existing => existing.toLowerCase() === val.toLowerCase())) workingTagDrafts.add(val);
  workingTags.add(val);
  renderTagChips();
}
if (els.tagInput) {
  els.tagInput.setAttribute('role', 'combobox');
  els.tagInput.setAttribute('aria-autocomplete', 'list');
  els.tagInput.setAttribute('aria-haspopup', 'listbox');
  els.tagInput.setAttribute('aria-controls', 'tagDropdown');
  els.tagInput.setAttribute('aria-expanded', 'false');
  if (els.tagDropdown) {
    els.tagDropdown.setAttribute('role', 'listbox');
    els.tagDropdown.setAttribute('aria-label', 'Tag suggestions');
  }
  els.tagInput.addEventListener('input', () => {
    const q = els.tagInput.value.toLowerCase().trim();
    const matches = settings.tags.filter(t => t.toLowerCase().includes(q)).slice(0, 50);
    const createNew = q && !settings.tags.some(t => t.toLowerCase() === q) ? els.tagInput.value.trim() : null;
    openTagDropdown(matches, createNew);
  });
  els.tagInput.addEventListener('keydown', (e) => {
    const open = !els.tagDropdown.classList.contains('hidden');
    if ((e.key === 'Enter' || e.key === ',') && open) {
      e.preventDefault();
      const items = [...els.tagDropdown.querySelectorAll('.dropitem')];
      const el = items[dropActiveIndex]; if (!el) return;
      selectDropItem(el);
    } else if ((e.key === 'Enter' || e.key === ',') && !open) {
      e.preventDefault(); addTag(els.tagInput.value); els.tagInput.value = '';
    } else if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const len = els.tagDropdown.querySelectorAll('.dropitem').length;
      if (e.key === 'Home') dropActiveIndex = 0;
      else if (e.key === 'End') dropActiveIndex = len - 1;
      else dropActiveIndex = (dropActiveIndex + (e.key === 'ArrowDown' ? 1 : -1) + len) % len;
      updateDropActive();
    } else if (e.key === 'Escape') { closeTagDropdown(); }
  });
  document.addEventListener('click', (e) => { if (!els.tagDropdown.contains(e.target) && e.target !== els.tagInput) closeTagDropdown(); });
}

// Drag grid
function rebuildDragGrid() {
  if (!els.dragGrid) return;
  els.dragGrid.innerHTML = '';
  // Reveal the on-device OCR row only when the native plugin exists and there's an
  // image to scan (server/web builds fall back to the AI OCR flow).
  const ocrRow = document.getElementById('ocrScanRow');
  if (ocrRow) {
    const looksImage = (s) => /^(blob:|data:image\/)/i.test(s || '') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|$)/i.test(s || '');
    const hasImage = modalImages.some(mi => looksImage(mi.src));
    ocrRow.hidden = !(hasImage && window.MemoOcrNative && window.MemoOcrNative.available());
  }
  modalImages.forEach((it, idx) => {
    const d = document.createElement('div');
    d.className = 'dragitem';
    d.draggable = true;
    const remove = document.createElement('button');
    remove.className = 'delimg';
    remove.title = 'Remove image';
    remove.setAttribute('aria-label', 'Remove image');
    remove.dataset.idx = String(idx);
    remove.textContent = '×';
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.title = 'Drag to reorder';
    handle.textContent = `⋮⋮ ${idx + 1}`;
    const image = document.createElement('img');
    image.src = it.src;
    image.alt = '';
    d.append(remove, handle, image);
    d.querySelector('.delimg').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = idx;
      const item = modalImages[i];
      try { if (item?.file && item?.src?.startsWith?.('blob:')) URL.revokeObjectURL(item.src); } catch { }
      modalImages.splice(i, 1);
      rebuildDragGrid();
    });
    const gridImg = d.querySelector('img');
    gridImg.style.cursor = 'zoom-in';
    gridImg.title = 'Click to preview';
    d.addEventListener('click', (ev) => {
      if (ev.target.closest('.delimg') || ev.target.closest('.handle')) return;
      ev.stopPropagation();
      if (window.MemoReader) window.MemoReader.openDirect(modalImages.map(m => m.src), idx);
    });
    d.addEventListener('dragstart', (ev) => { dragSrcIdx = idx; d.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; });
    d.addEventListener('dragend', () => { d.classList.remove('dragging'); dragSrcIdx = null; });
    d.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; });
    d.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const dst = idx;
      if (dragSrcIdx === null || dragSrcIdx === dst) return;
      const item = modalImages.splice(dragSrcIdx, 1)[0];
      modalImages.splice(dst, 0, item);
      rebuildDragGrid();
    });
    els.dragGrid.appendChild(d);
  });
}
function addImageFiles(files) {
  for (const f of files) {
    if (!f) continue;
    if (f.type?.startsWith('image/')) {
      const url = URL.createObjectURL(f);
      modalImages.push({ src: url, file: f, existing: false });
    } else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      const url = URL.createObjectURL(f);
      modalFilesExtra.push({ name: f.name, url, file: f, existing: false, type: 'application/pdf' });
    }
  }
  rebuildDragGrid();
  renderExtraAttachmentsList();
}

if (els.images) {
  els.images.addEventListener('change', () => {
    addImageFiles(els.images.files);
    els.images.value = ''; // allow selecting same file again
  });
}

if (els.dropzone && els.images) {
  els.dropzone.addEventListener('click', () => els.images.click());
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    els.dropzone.click();
  });
  els.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); });
  els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragover'));
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); els.dropzone.classList.remove('dragover');
    addImageFiles(e.dataTransfer?.files || []);
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && (f.type?.startsWith('image/') || f.type === 'application/pdf')) files.push(f);
      }
    }
    if (files.length) addImageFiles(files);
  });
}

// ============= On-device OCR (ML Kit) — extract text into the description =====
async function scanEntryImages() {
  if (!window.MemoOcrNative || !window.MemoOcrNative.available()) return;
  const btn = document.getElementById('scanTextBtn');
  const note = document.getElementById('ocrScanNote');
  const langSel = document.getElementById('ocrLangSelect');
  const looksImage = (s) => /^(blob:|data:image\/)/i.test(s || '') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|$)/i.test(s || '');
  const imgs = modalImages.filter(mi => looksImage(mi.src));
  if (!imgs.length) return;
  const language = langSel ? langSel.value : 'auto';
  const setNote = (t) => { if (note) note.textContent = t; };
  if (btn) btn.disabled = true;
  const parts = [];
  try {
    for (let i = 0; i < imgs.length; i++) {
      setNote('Scanning ' + (i + 1) + '/' + imgs.length + '…');
      try {
        const res = await window.MemoOcrNative.recognize(imgs[i].src, { language });
        const text = ((res && res.text) || '').trim();
        if (text) parts.push(text);
      } catch (_e) { /* skip unreadable image */ }
    }
    const combined = parts.join('\n\n').trim();
    if (!combined) { setNote('No text found in the image' + (imgs.length === 1 ? '' : 's') + '.'); return; }
    if (els.desc) {
      const cur = els.desc.value.trim();
      els.desc.value = cur ? (cur + '\n\n' + combined) : combined;
      els.desc.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setNote('Added text from ' + parts.length + ' image' + (parts.length === 1 ? '' : 's') + '.');
  } finally {
    if (btn) btn.disabled = false;
  }
}
(function wireScanText() {
  const btn = document.getElementById('scanTextBtn');
  if (btn) btn.addEventListener('click', () => { void scanEntryImages(); });
})();

// ============= Save / Delete =============
if (els.cancelBtn) els.cancelBtn.addEventListener('click', () => {
  els.entryDlg.close();
  if (window.MemoOcr && typeof window.MemoOcr.onModalClose === 'function') window.MemoOcr.onModalClose();
});
if (els.saveBtn) els.saveBtn.addEventListener('click', onSaveEntry);
function setActiveEntryFilter(id) {
  activeFilters.entryId = id == null || id === '' ? null : String(id);
}
function activeReaderEntryFilter() {
  try {
    const state = window.MemoReader && typeof window.MemoReader.__state === 'function'
      ? window.MemoReader.__state() : null;
    const id = state && state.opened ? state.entryId : null;
    return id != null && !String(id).startsWith('loose:') ? String(id) : null;
  } catch (_e) { return null; }
}
if (els.closeDetailBtn) els.closeDetailBtn.addEventListener('click', () => {
  if (window.MemoVariant && typeof window.MemoVariant.closeDetail === 'function') window.MemoVariant.closeDetail();
  else els.detailDlg.close();
});
if (els.detailDlg) els.detailDlg.addEventListener('close', () => {
  // Covers the close button, Escape, privacy teardown, reader transitions and
  // every programmatic close. If a reader was opened as part of that same
  // transition, it now owns the location; this also avoids an asynchronously
  // delivered dialog-close event erasing the context the reader just applied.
  setActiveEntryFilter(activeReaderEntryFilter());
});
if (els.deleteBtn) els.deleteBtn.addEventListener('click', onDeleteEntry);
if (els.editBtn) els.editBtn.addEventListener('click', () => {
  const id = els.detailDlg?.dataset?.entryId; if (!id) return;
  const e = db.entries.find(x => x.id === id);
  els.detailDlg.close(); openEntryModal(e);
});

// ── Optimistic import ──────────────────────────────────────────────
// A local-mode save with new files renders its card immediately (the images are
// already blob: URLs) and writes the blobs + persists + queues the sync op in the
// background, so the user can keep working while it finishes. pendingImports gates
// a beforeunload warning while any durable write is still in flight.
const pendingImports = new Set();
window.addEventListener('beforeunload', function (e) {
  if (pendingImports.size) { e.preventDefault(); e.returnValue = ''; }
});
function afterPost() {
  if (els.entryDlg) els.entryDlg.close();
  workingTagDrafts.clear();
  updateBackupNudge();
  if (window.MemoOcr && typeof window.MemoOcr.commitSuggestedTags === 'function') window.MemoOcr.commitSuggestedTags();
  if (window.MemoOcr && typeof window.MemoOcr.onModalClose === 'function') window.MemoOcr.onModalClose();
}
// Fade the "importing…" badge off a card once its files are durably saved.
function clearImportBadge(id) {
  const card = els.feed && els.feed.querySelector('.card[data-id="' + id + '"]');
  const badge = card && card.querySelector('.import-badge');
  if (!badge) return;
  badge.classList.add('done');
  setTimeout(function () { try { badge.remove(); } catch (_e) {} }, 450);
}

function attachmentStoredPaths(entry) {
  return (entry && Array.isArray(entry.attachments) ? entry.attachments : [])
    .map(attachment => attachment && attachment.storedPath)
    .filter(Boolean);
}

// _storedPaths is deliberately image-only because StateDb serializes it into
// the images column. Blob maintenance and sync uploads need the wider union.
function entryStoredBlobPaths(entry) {
  return Array.from(new Set([
    ...((entry && Array.isArray(entry._storedPaths)) ? entry._storedPaths : []),
    ...attachmentStoredPaths(entry)
  ].filter(Boolean)));
}

function normalizeImageMetaPath(value) {
  let path = String(value || '');
  if (!path || /^(blob:|data:)/i.test(path)) return '';
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) path = new URL(path, window.location && window.location.href).pathname;
  } catch (_e) {}
  path = path.split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/^\/+/, '');
  return path.indexOf('uploads/') === 0 ? path : '';
}

function stableImagePaths(entry) {
  const stored = Array.isArray(entry && entry._storedPaths) ? entry._storedPaths : [];
  const images = Array.isArray(entry && entry.images) ? entry.images : [];
  return stored.concat(images);
}

// Original EXIF backups belong to an owned image, never just to the memo. Keep
// keys normalized and discard records as soon as their image is removed or
// replaced so sensitive original metadata cannot linger invisibly or sync on.
function pruneEntryImageMeta(entry, finalPaths) {
  if (!entry) return {};
  const source = entry.imageMeta && typeof entry.imageMeta === 'object' && !Array.isArray(entry.imageMeta)
    ? entry.imageMeta : {};
  const keep = new Set((finalPaths || stableImagePaths(entry)).map(normalizeImageMetaPath).filter(Boolean));
  const pruned = {};
  Object.entries(source).forEach(([key, record]) => {
    const normalized = normalizeImageMetaPath(key);
    if (!normalized || !keep.has(normalized)) return;
    if (pruned[normalized] && record && typeof record === 'object') {
      pruned[normalized] = { ...pruned[normalized], ...record };
    } else {
      pruned[normalized] = record;
    }
  });
  entry.imageMeta = pruned;
  return pruned;
}

function patchDirectPreviewReferences(replacements) {
  if (!replacements.length) return;
  const byUrl = new Map(replacements.map(replacement => [replacement.from, replacement.to]));
  document.querySelectorAll('[src],[data-src],[href]').forEach(node => {
    ['src', 'data-src', 'href'].forEach(attribute => {
      const current = node.getAttribute(attribute);
      const replacement = current && byUrl.get(current);
      if (replacement) node.setAttribute(attribute, replacement);
    });
  });
}

async function handoffSavedPreviews(ctx, stateDb) {
  const replacements = [];
  const imageWrites = ctx.imageWrites || [];

  // Acquire cache-owned display URLs one slot at a time. The durable rel path
  // remains entry._storedPaths' source of truth and StateDb records the entry as
  // an owner so invalidation can restore that path before revoking the URL.
  if (stateDb && typeof stateDb.hydrateImageAt === 'function') {
    for (const write of imageWrites) {
      if (!write || !write.previewUrl || !write.storedPath) continue;
      let replacement = null;
      try { replacement = await stateDb.hydrateImageAt(ctx.entry, write.index, write.storedPath); } catch (_e) {}
      if (replacement && replacement !== write.previewUrl) {
        replacements.push({ from: write.previewUrl, to: replacement });
      }
    }
  }

  // Non-image attachments are consumed through their stable storedPath. Their
  // modal preview URLs have no owner after the durable rewrite and can go too.
  (ctx.extraToWrite || []).forEach(write => {
    if (!write || !write.previewUrl || !write.att || !write.att.url) return;
    if (write.previewUrl !== write.att.url) replacements.push({ from: write.previewUrl, to: write.att.url });
  });

  patchDirectPreviewReferences(replacements);
  replacements.forEach(replacement => {
    try { URL.revokeObjectURL(replacement.from); } catch (_e) {}
  });
}

// Durably persist a local-mode entry: write any new blobs (in parallel), fix up
// attachment paths, prune blobs removed during an edit, then saveAll + queue the
// sync op. Awaited for text-only saves; fire-and-forget for saves with new files.
async function persistLocalEntry(ctx) {
  const { entry, isNew, filesToWrite, extraToWrite, priorStoredPaths } = ctx;
  const imageWrites = ctx.imageWrites || filesToWrite.map((file, index) => ({ file, index }));
  const imageStoredPaths = Array.isArray(ctx.imageStoredPaths) ? ctx.imageStoredPaths : [];
  const priorBlobPaths = Array.from(new Set([
    ...(priorStoredPaths || []),
    ...(ctx.priorAttachmentPaths || [])
  ].filter(Boolean)));
  const stateDbSave = getStateDb();
  try {
    if (stateDbSave && typeof stateDbSave.writeBlob === 'function') {
      const d = new Date(entry.ts);
      const dateFolderName = todayFolder(entry.ts);
      const hhmm = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
      let fileOrdinal = 0;
      const relFor = (f) => {
        const ext = (f.name.split('.').pop() || 'dat').toLowerCase();
        const baseName = f.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'file';
        // A batch can contain same-named files within one minute. Include entry
        // identity and a per-entry ordinal so durable blobs never overwrite.
        const entryPart = String(entry.id || uid()).replace(/[^a-z0-9_-]+/gi, '').slice(-12) || 'entry';
        fileOrdinal += 1;
        return `uploads/${dateFolderName}/${hhmm}_${entryPart}_${fileOrdinal}_${baseName}.${ext}`;
      };
      if (filesToWrite.length || extraToWrite.length) {
        // Independent I/O → write them all at once instead of one-await-at-a-time.
        const imgJobs = imageWrites.map(async (write) => {
          const rel = relFor(write.file);
          await stateDbSave.writeBlob(rel, write.file);
          write.storedPath = rel;
          imageStoredPaths[write.index] = rel;
        });
        const attachmentJobs = extraToWrite.map(async (write) => {
          const rel = relFor(write.file);
          await stateDbSave.writeBlob(rel, write.file);
          write.att.storedPath = rel;
          write.att.url = stateDbSave.relToUrl(rel);
        });
        await Promise.all([...imgJobs, ...attachmentJobs]);
      }
      // Images and attachments have separate persisted metadata. Never place an
      // attachment path in _storedPaths: StateDb maps that array to images.
      entry._storedPaths = imageStoredPaths.filter(Boolean);
    } else if (filesToWrite.length || extraToWrite.length) {
      // No usable blob store but there ARE files to persist. Falling through
      // here is what corrupted a synced entry: the attachment kept its session
      // -local blob: URL, the op was built from that, and the server ended up
      // storing a URL that means nothing anywhere (and dies on reload) while the
      // file itself was never uploaded. Fail instead — the catch below keeps the
      // entry flagged _importing so a re-save retries.
      throw new Error('Local blob store unavailable; refusing to save files as session-only blob: URLs.');
      const keptBlobPaths = entryStoredBlobPaths(entry);
      // Free blobs for files the user removed during this edit.
      for (const sp of priorBlobPaths) { if (!keptBlobPaths.includes(sp)) { try { await stateDbSave.deleteBlob(sp); } catch (_e) {} } }
    }
    pruneEntryImageMeta(entry);
    recomputeTags();
    saveAll();
    const operationQueue = getOperationQueue();
    if (operationQueue && MODE !== 'server') {
      const opData = { description: entry.description, category: entry.category, tags: entry.tags, imageMeta: entry.imageMeta || {}, ts: entry.ts, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
      // Carry durable rel paths so the sync push can resolve them to uploaded
      // server URLs (images/attachments) before send. Deliberately NO `images`
      // key here, so the immediate local apply keeps the display (blob:) URLs.
      opData._storedPaths = Array.isArray(entry._storedPaths) ? entry._storedPaths.slice() : [];
      opData._attachments = (Array.isArray(entry.attachments) ? entry.attachments : [])
        .map(a => ({ name: a.name, type: a.type, storedPath: a.storedPath || null, url: a.url }));
      const filesToUpload = entryStoredBlobPaths(entry);
      if (filesToUpload.length > 0) opData._filesToUpload = filesToUpload;
      if (window.MEMO_VARIANT === 'finance') { opData.purchaseDate = entry.purchaseDate; opData.sheet = entry.sheet; opData.items = entry.items; opData.tax = entry.tax; opData.total = entry.total; }
      // The op queue reads the payload from op.data (uploads + push both do);
      // passing it flat silently dropped the entry data and its files on sync.
      await operationQueue.addOperation(isNew ? 'create' : 'update', entry.id, { data: opData }, { deferCheckpoint: !!ctx.propagateFailure });
    }
    // A local create is idempotently merged by OperationQueue into a fresh object.
    // Rebind before transferring URLs so the object still held by db.entries is
    // the one whose preview/importing state changes.
    const liveEntry = db.entries.find(candidate => candidate && candidate.id === entry.id) || entry;
    ctx.entry = liveEntry;
    // Do not release caller-owned previews until both the blob write and journal
    // update have succeeded. Failed reviewed items therefore remain retryable.
    await handoffSavedPreviews(ctx, stateDbSave);
    delete liveEntry._importing;
    if (liveEntry !== entry) delete entry._importing;
    clearImportBadge(liveEntry.id);
    return liveEntry;
  } catch (err) {
    console.error('[import] persist failed for', entry.id, err);
    try { renderFeed(); } catch (_e) {}   // keep the (still _importing) entry visible so a re-save can retry
    // Normal entry saves stay optimistic and surface a retryable importing card.
    // The batch reviewer, however, must keep its dialog open and retain the
    // failed source file, so let that caller handle the failure explicitly.
    if (ctx.propagateFailure) throw err;
  } finally {
    pendingImports.delete(entry.id);
  }
}

async function flushPersistence() {
  const stateDb = getStateDb();
  if (stateDb && typeof stateDb.flush === 'function') await stateDb.flush();
}

// Persist a byte-level edit to one of an entry's existing media files (EXIF is
// the first caller).  This deliberately reuses the normal update journal shape:
// per-image metadata is saved in SQLite, and every owned file path is available
// to the sync uploader so the server snapshot cannot retain stale image bytes.
async function persistEntryMediaMutation(entry) {
  if (!entry || !entry.id) throw new Error('A live entry is required.');
  pruneEntryImageMeta(entry);
  entry.updatedAt = new Date().toISOString();
  saveAll();
  await flushPersistence();
  const operationQueue = getOperationQueue();
  if (operationQueue && MODE !== 'server') {
    const opData = {
      description: entry.description,
      category: entry.category,
      tags: entry.tags || [],
      imageMeta: entry.imageMeta || {},
      ts: entry.ts,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      _storedPaths: Array.isArray(entry._storedPaths) ? entry._storedPaths.slice() : [],
      _attachments: (Array.isArray(entry.attachments) ? entry.attachments : []).map(a => ({
        name: a.name, type: a.type, storedPath: a.storedPath || null, url: a.url
      }))
    };
    const paths = entryStoredBlobPaths(entry);
    if (paths.length) opData._filesToUpload = paths;
    await operationQueue.addOperation('update', entry.id, { data: opData });
    // addOperation stores the queue through StateDb's debounced settings write.
    // Commit that new journal record before reporting the byte edit complete.
    await flushPersistence();
  }
  renderFeed();
  return entry;
}

async function onSaveEntry() {
  const description = els.desc ? els.desc.value.trim() : '';
  const category = (els.categoryInput && els.categoryInput.value) ? els.categoryInput.value : 'Uncategorized';
  const ts = Date.now();
  const tags = [...workingTags];
  if (!description && modalImages.length === 0 && modalFilesExtra.length === 0) { if (window.MemoShell) window.MemoShell.toast('Please enter a description or add at least one file.', { kind: 'error' }); return; }

  let entry = editingId ? db.entries.find(e => e.id === editingId) : { id: uid(), images: [], attachments: [] };
  const isNew = !editingId;
  entry.description = description;
  entry.category = category;
  entry.tags = tags;
  entry.ts = isNew ? ts : entry.ts;
  
  // Update timestamps
  if (isNew) {
    entry.createdAt = new Date(ts).toISOString();
    entry.updatedAt = new Date(ts).toISOString();
  } else {
    // Keep createdAt, update updatedAt
    entry.updatedAt = new Date().toISOString();
  }
  
  // Clear conflict flags when user edits an entry
  if (entry._hasConflict) {
    delete entry._hasConflict;
    delete entry._conflictClientVersion;
    delete entry._conflictResolvedAt;
  }

  // Variant may add/modify fields (e.g., finance data)
  if (window.MemoVariant && typeof window.MemoVariant.collectAdditionalFields === 'function') {
    window.MemoVariant.collectAdditionalFields(entry, isNew);
  }

  // Build images for submit:
  let imagesFinal = [];
  let attachmentsFinal = [];
  modalImages.forEach(mi => { if (mi.existing) imagesFinal.push(mi.src); });
  const filesToSave = modalImages.filter(mi => mi.file);
  const extraToSave = modalFilesExtra.filter(f => f.file);

  if (MODE === 'server') {
    const serverImagePaths = modalImages.filter(mi => mi.existing).map(mi => mi.storedPath || mi.src);
    for (let i = 0; i < filesToSave.length; i++) {
      const f = filesToSave[i].file;
      const res = await ServerAPI.upload(f);
      if (res && res.url) {
        let savedUrl = res.url;
        try { if (/^https?:\/\//i.test(savedUrl)) savedUrl = new URL(savedUrl).pathname; } catch(_e) {}
        imagesFinal.push(savedUrl);
        serverImagePaths.push(savedUrl);
      }
    }
    for (let i = 0; i < extraToSave.length; i++) {
      const f = extraToSave[i].file;
      const res = await ServerAPI.upload(f);
      if (res && res.url) {
        // Normalize to relative path in case server returned an absolute URL
        let savedUrl = res.url;
        try { if (/^https?:\/\//i.test(savedUrl)) savedUrl = new URL(savedUrl).pathname; } catch(_e) {}
        attachmentsFinal.push({ name: f.name, url: savedUrl, type: f.type || 'application/octet-stream' });
      }
    }
    entry.images = imagesFinal;
    entry.attachments = attachmentsFinal.concat(
      modalFilesExtra.filter(f => f.existing && f.url).map(f => ({ name: f.name, url: f.url, type: f.type || 'application/octet-stream' }))
    );
    pruneEntryImageMeta(entry, serverImagePaths);

    let saved;
    if (isNew) saved = await ServerAPI.create(entry);
    else saved = await ServerAPI.update(entry.id, entry);

    if (isNew) db.entries.push(saved);
    else {
      const i = db.entries.findIndex(e => e.id === entry.id);
      if (i >= 0) db.entries[i] = saved;
    }
    
    // Mark as modified for sync
    const syncManager = getSyncManager();
    if (syncManager && typeof syncManager.markModified === 'function') {
      syncManager.markModified(saved.id);
    }
  } else {
    // ── LOCAL mode: assemble the entry for display, then persist durably ──
    const priorStoredPaths = Array.isArray(entry._storedPaths) ? entry._storedPaths.slice() : [];
    const priorAttachmentPaths = attachmentStoredPaths(entry);
    entry.images = [];
    entry.attachments = [];
    const filesToWrite = [];     // new image File objects to write
    const imageWrites = [];      // new images with their display slot + preview ownership
    const extraToWrite = [];     // new non-image files: { file, att } (att fixed up post-write)
    const imageStoredPaths = []; // image-only durable rel paths, aligned to entry.images
    modalImages.forEach((mi, index) => {
      entry.images.push(mi.src);                        // blob: (new) or stored path (existing) — for display
      if (mi.file) {
        filesToWrite.push(mi.file);
        imageWrites.push({ file: mi.file, index, previewUrl: mi.src });
      } else if (mi.existing && mi.storedPath) {
        imageStoredPaths[index] = mi.storedPath;
      }
    });
    modalFilesExtra.forEach(f => {
      if (f.file) {
        // Show the attachment now with its blob: URL; persistLocalEntry rewrites
        // url/storedPath to the durable path once the blob is written.
        const att = { name: f.name, url: f.url, type: f.type || 'application/octet-stream' };
        entry.attachments.push(att);
        extraToWrite.push({ file: f.file, att, previewUrl: f.url });
      } else if (f.existing) {
        entry.attachments.push({ name: f.name, url: f.url, storedPath: f.storedPath, type: f.type || 'application/octet-stream' });
      }
    });

    // In-memory insert so the card can render before durable I/O finishes.
    if (isNew) db.entries.push(entry);
    else { const i = db.entries.findIndex(e => e.id === entry.id); if (i >= 0) db.entries[i] = entry; }

    const ctx = {
      entry, isNew, filesToWrite, imageWrites, imageStoredPaths, extraToWrite,
      priorStoredPaths, priorAttachmentPaths
    };

    if (filesToWrite.length || extraToWrite.length) {
      // Optimistic: render the card now (blob: URLs), then write blobs + persist in
      // the background so the user can leave the modal and keep working.
      entry._importing = true;
      pendingImports.add(entry.id);
      recomputeTags();
      renderFeed();
      afterPost();
      persistLocalEntry(ctx);      // fire-and-forget; the badge fades out on completion
      return;
    }

    // No new files → nothing slow to await; persist synchronously.
    await persistLocalEntry(ctx);
    recomputeTags();
    renderFeed();
    afterPost();
    return;
  }

  if (els.entryDlg) els.entryDlg.close();
  workingTagDrafts.clear();
  recomputeTags(); saveAll();
  renderFeed();
  updateBackupNudge();

  // OCR hook – commit suggested tags and clear draft after post
  if (window.MemoOcr && typeof window.MemoOcr.commitSuggestedTags === 'function') {
    window.MemoOcr.commitSuggestedTags();
  }
  if (window.MemoOcr && typeof window.MemoOcr.onModalClose === 'function') {
    window.MemoOcr.onModalClose();
  }
}

// Create exactly one new entry from a reviewed file without touching the normal
// entry dialog or OCR draft. This is intentionally narrow: batch-review UI owns
// its temporary state, while this core API owns the established server/local
// persistence and operation-queue semantics.
async function createReviewedEntry(review) {
  const file = review && review.file;
  if (!file || !file.type || !file.type.startsWith('image/')) throw new Error('A supported image file is required.');
  const ts = Date.now();
  const category = (review.category || 'Uncategorized').trim() || 'Uncategorized';
  const tags = Array.from(new Set((review.tags || []).map(t => String(t || '').trim()).filter(Boolean)));
  ensureCategory(category);
  tags.forEach(t => { if (!settings.tags.includes(t)) settings.tags.push(t); });
  const entry = {
    id: uid(),
    description: String(review.description || '').trim(),
    category,
    tags,
    ts,
    createdAt: new Date(ts).toISOString(),
    updatedAt: new Date(ts).toISOString(),
    images: [],
    attachments: []
  };

  if (MODE === 'server') {
    const res = await ServerAPI.upload(file);
    if (!res || !res.url) throw new Error('Image upload failed.');
    let savedUrl = res.url;
    try { if (/^https?:\/\//i.test(savedUrl)) savedUrl = new URL(savedUrl).pathname; } catch (_e) {}
    entry.images = [savedUrl];
    const saved = await ServerAPI.create(entry);
    db.entries.push(saved);
    const syncManager = getSyncManager();
    if (syncManager && typeof syncManager.markModified === 'function') syncManager.markModified(saved.id);
    recomputeTags(); saveAll(); renderFeed(); updateBackupNudge();
    return saved;
  }

  const previewUrl = review.previewUrl || URL.createObjectURL(file);
  if (!review.previewUrl) review.previewUrl = previewUrl;
  entry.images = [previewUrl];
  entry._importing = true;
  db.entries.push(entry);
  pendingImports.add(entry.id);
  recomputeTags();
  refreshCategoryControls();
  renderFeed();
  // The same durable writer used by normal entry saves writes the blob, updates
  // its local path, persists state, and queues the create operation.
  try {
    const persistedEntry = await persistLocalEntry({
      entry,
      isNew: true,
      filesToWrite: [file],
      imageWrites: [{ file, index: 0, previewUrl }],
      imageStoredPaths: [],
      extraToWrite: [],
      priorStoredPaths: [],
      priorAttachmentPaths: [],
      propagateFailure: true
    });
    // A failed final batch checkpoint may re-render completed review cards.
    // Point that surface at the entry's cache-owned URL; the original reviewer
    // preview has already been revoked by the successful handoff above.
    if (persistedEntry.images[0] && persistedEntry.images[0] !== previewUrl) {
      review.previewUrl = persistedEntry.images[0];
      review._cacheOwnedPreview = true;
    }
    updateBackupNudge();
    return persistedEntry;
  } catch (error) {
    // A failed reviewed item must remain retryable. Remove its optimistic entry
    // and any partial journal/blob state before the reviewer reports the error.
    const index = db.entries.findIndex(candidate => candidate.id === entry.id);
    if (index >= 0) db.entries.splice(index, 1);

    const operationQueue = getOperationQueue();
    if (operationQueue && Array.isArray(operationQueue.queue)) {
      const before = operationQueue.queue.length;
      operationQueue.queue = operationQueue.queue.filter(operation => operation.entryId !== entry.id);
      if (operationQueue.queue.length !== before && typeof operationQueue.saveQueue === 'function') {
        try { operationQueue.saveQueue(); } catch (_queueError) {}
      }
    }

    const stateDb = getStateDb();
    if (stateDb && typeof stateDb.deleteBlob === 'function') {
      for (const storedPath of entryStoredBlobPaths(entry)) {
        try { await stateDb.deleteBlob(storedPath); } catch (_deleteError) {}
      }
    }
    recomputeTags();
    try { saveAll(); } catch (_saveError) {}
    try { renderFeed(); } catch (_renderError) {}
    updateBackupNudge();
    throw error;
  }
}

async function onDeleteEntry() {
  const id = els.detailDlg?.dataset?.entryId; if (!id) return;

  const entry = db.entries.find(e => e.id === id);
  if (!entry) return;

  // Soft delete: mark as deleted instead of removing
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  entry.deletedAt = now;
  entry.deletedBy = MODE === 'server' ? 'server' : 'local';
  entry.permanentDeleteAt = now + thirtyDays;
  entry.updatedAt = now;

  if (MODE === 'server') {
    await ServerAPI.update(id, {
      deletedAt: entry.deletedAt,
      deletedBy: entry.deletedBy,
      permanentDeleteAt: entry.permanentDeleteAt,
      updatedAt: entry.updatedAt
    });
  }

  recomputeTags(); saveAll();
  
  // Add to operation queue for sync (for local/file mode)
  const operationQueue = getOperationQueue();
  if (operationQueue && MODE !== 'server') {
    console.log('📋 Adding delete operation to queue:', id);
    await operationQueue.addOperation('delete', id);
  }
  
  els.detailDlg?.close();
  renderFeed();
  updateRecycleBinBadge();
  nativeHaptic('destructiveSuccess');
  // Reversible (goes to the recycle bin), so no confirm — offer Undo instead.
  if (window.MemoShell && window.MemoShell.toast) {
    window.MemoShell.toast('Moved to recycle bin', {
      action: { label: 'Undo', onClick: function () { restoreEntry(id); } }
    });
  }
}

// ── Batch operations (select mode) ──────────────────────────────────────────
// Soft-delete every id (to the recycle bin), reusing the same op-queue / server
// semantics as the single-entry delete.
async function batchDeleteEntries(ids) {
  if (!ids || !ids.length) return;
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const oq = getOperationQueue();
  let deletedCount = 0;
  for (const id of ids) {
    const entry = db.entries.find(e => e.id === id);
    if (!entry || entry.deletedAt) continue;
    deletedCount++;
    entry.deletedAt = now;
    entry.deletedBy = MODE === 'server' ? 'server' : 'local';
    entry.permanentDeleteAt = now + thirtyDays;
    entry.updatedAt = now;
    if (MODE === 'server') {
      try { await ServerAPI.update(id, { deletedAt: entry.deletedAt, deletedBy: entry.deletedBy, permanentDeleteAt: entry.permanentDeleteAt, updatedAt: entry.updatedAt }); } catch (_e) {}
    } else if (oq) {
      try { await oq.addOperation('delete', id); } catch (_e) {}
    }
  }
  recomputeTags(); saveAll(); renderFeed(); updateRecycleBinBadge();
  if (deletedCount) nativeHaptic('destructiveSuccess');
}

// Apply a category / tag change to every id. patch = { category?, addTags?[], removeTags?[] }.
async function batchApplyEntries(ids, patch) {
  if (!ids || !ids.length || !patch) return;
  const now = Date.now();
  const oq = getOperationQueue();
  if (patch.category != null && patch.category !== '') ensureCategory(patch.category);
  for (const id of ids) {
    const entry = db.entries.find(e => e.id === id);
    if (!entry || entry.deletedAt) continue;
    if (patch.category != null && patch.category !== '') entry.category = patch.category;
    // Privacy "Safe" flag (memo only) — a presentation gate synced LWW like any
    // other field; the receiver applies it via Object.assign on the update op.
    if (patch.safe != null) entry.safe = !!patch.safe;
    // Favourite flag — a plain per-entry boolean, synced LWW like any other field.
    if (patch.favorite != null) entry.favorite = !!patch.favorite;
    let tags = Array.isArray(entry.tags) ? entry.tags.slice() : [];
    if (patch.removeTags && patch.removeTags.length) tags = tags.filter(t => patch.removeTags.indexOf(t) < 0);
    if (patch.addTags && patch.addTags.length) patch.addTags.forEach(t => { if (t && tags.indexOf(t) < 0) tags.push(t); });
    entry.tags = tags;
    entry.updatedAt = now;
    if (MODE === 'server') {
      try { await ServerAPI.update(id, { category: entry.category, tags: entry.tags, updatedAt: now, safe: entry.safe, favorite: entry.favorite }); } catch (_e) {}
    } else if (oq) {
      const opData = { description: entry.description, category: entry.category, tags: entry.tags, ts: entry.ts, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
      if (entry.safe != null) opData.safe = entry.safe;
      if (entry.favorite != null) opData.favorite = entry.favorite;
      if (window.MEMO_VARIANT === 'finance') { opData.purchaseDate = entry.purchaseDate; opData.sheet = entry.sheet; opData.items = entry.items; opData.tax = entry.tax; opData.total = entry.total; }
      try { await oq.addOperation('update', id, { data: opData }); } catch (_e) {}
    }
  }
  recomputeTags(); refreshCategoryControls(); saveAll(); renderFeed();
}

// =======================
// Recycle Bin Functions
// =======================
function updateRecycleBinBadge() {
  if (!els.recycleBinBtn) return;
  const deletedCount = db.entries.filter(e => e.deletedAt !== null && e.deletedAt !== undefined).length;
  const binWord = (window.MemoI18n && window.MemoI18n.t) ? window.MemoI18n.t('bin') : 'Bin';
  // Red count dot on the trash icon (the header is icon-only now); the label
  // stays in the DOM for accessibility but is hidden by CSS.
  const badge = deletedCount > 0 ? `<span class="hdr-badge">${deletedCount > 99 ? '99+' : deletedCount}</span>` : '';
  els.recycleBinBtn.innerHTML = `<span class="hdr-ic"><span class="svg-icon svg-icon-trash"></span>${badge}</span><span class="btn-label">${binWord}</span>`;
}

// Re-render dynamically-built chrome when the UI language changes (memo-i18n.js
// re-applies static data-i18n nodes itself; these are the JS-rendered ones).
document.addEventListener('memo:localechange', () => {
  try { updateRecycleBinBadge(); } catch (_e) {}
  try { if (typeof renderFeed === 'function') renderFeed(); } catch (_e) {}
});

async function restoreEntry(entryId) {
  const entry = db.entries.find(e => e.id === entryId);
  if (!entry || !entry.deletedAt) return;
  
  // Clear deletion markers
  entry.deletedAt = null;
  entry.deletedBy = null;
  entry.permanentDeleteAt = null;
  entry.updatedAt = Date.now();
  
  if (MODE === 'server') {
    await ServerAPI.restore(entryId);
  }
  
  saveAll();
  renderFeed();
  renderRecycleBin();
  updateRecycleBinBadge();
}

async function permanentlyDeleteEntry(entryId, options) {
  const entry = db.entries.find(e => e.id === entryId);
  if (!entry) return;

  // Perform actual deletion (remove files and entry)
  if (MODE === 'server') {
    await ServerAPI.removePermanent(entryId);
  } else {
    // Offline-independent: free the entry's app-private image and attachment blobs.
    const sdb = getStateDb();
    if (sdb && typeof sdb.deleteBlob === 'function') {
      for (const sp of entryStoredBlobPaths(entry)) { try { await sdb.deleteBlob(sp); } catch (_e) {} }
    }
  }

  // Remove from entries array
  db.entries = db.entries.filter(e => e.id !== entryId);
  recomputeTags();
  saveAll();
  renderFeed();
  renderRecycleBin();
  updateRecycleBinBadge();
  if (!options || options.haptic !== false) nativeHaptic('destructiveSuccess');
}

async function emptyRecycleBin() {
  const deleted = db.entries.filter(e => e.deletedAt !== null);
  const shell = window.MemoShell;

  if (deleted.length === 0) {
    if (shell) shell.toast('Recycle bin is already empty.');
    return;
  }

  const ok = shell
    ? await shell.confirm(`Permanently delete all ${deleted.length} item${deleted.length === 1 ? '' : 's'} in the recycle bin? This cannot be undone.`, { danger: true, okLabel: 'Delete all' })
    : true;
  if (!ok) return;

  // Delete each entry permanently
  for (const entry of deleted) {
    await permanentlyDeleteEntry(entry.id, { haptic: false });
  }
  nativeHaptic('destructiveSuccess');

  if (shell) shell.toast(`${deleted.length} item${deleted.length === 1 ? '' : 's'} permanently deleted.`, { kind: 'success' });
  renderRecycleBin();
}

function buildRecycleCard(e) {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // deletedAt/permanentDeleteAt may be a ms number or (from sync) an ISO string —
    // parse both, and degrade gracefully instead of printing "NaN days".
    const ms = (v) => { const n = Number(v); return Number.isFinite(n) ? n : (v ? Date.parse(v) : NaN); };
    const delAt = ms(e.deletedAt), permAt = ms(e.permanentDeleteAt);
    const deletedAgo = Number.isFinite(delAt) ? Math.max(0, Math.floor((now - delAt) / DAY)) : null;
    const daysLeft = Number.isFinite(permAt) ? Math.max(0, Math.floor((permAt - now) / DAY)) : null;

    const card = document.createElement('div');
    card.className = 'card deleted';
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.innerHTML = '<span class="svg-icon svg-icon-trash"></span> ';
    const deletedText = deletedAgo == null ? 'Deleted recently'
      : (deletedAgo === 0 ? 'Deleted today' : `Deleted ${deletedAgo} day(s) ago`);
    meta.appendChild(document.createTextNode(`${e.category || 'Uncategorized'} • ${deletedText}`));

    const descriptionRow = document.createElement('div');
    descriptionRow.style.margin = '8px 0';
    const description = document.createElement('strong');
    const descriptionText = e.description || '(No description)';
    description.textContent = descriptionText.substring(0, 100) + (descriptionText.length > 100 ? '...' : '');
    descriptionRow.appendChild(description);

    const expiry = document.createElement('div');
    expiry.className = 'muted';
    expiry.style.color = '#f59e0b';
    expiry.textContent = daysLeft == null ? 'Auto-deletes after 30 days' : `Auto-delete in: ${daysLeft} days`;

    const tags = document.createElement('div');
    tags.className = 'tagsline';
    tags.style.marginTop = '6px';
    (e.tags || []).forEach(t => {
      const pill = document.createElement('span');
      pill.className = 'tagpill';
      pill.textContent = '#' + t;
      tags.appendChild(pill);
    });

    const actions = document.createElement('div');
    actions.className = 'inline';
    actions.style.cssText = 'margin-top:10px;gap:8px';
    const restore = document.createElement('button');
    restore.className = 'primary restore-btn';
    restore.dataset.id = e.id;
    restore.textContent = 'Restore';
    const permanent = document.createElement('button');
    permanent.className = 'danger delete-perm-btn';
    permanent.dataset.id = e.id;
    permanent.textContent = 'Delete Permanently';
    actions.append(restore, permanent);
    card.append(meta, descriptionRow, expiry, tags, actions);
    
    card.querySelector('.restore-btn').addEventListener('click', () => {
      restoreEntry(e.id);
    });
    
    card.querySelector('.delete-perm-btn').addEventListener('click', async () => {
      const ok = window.MemoShell ? await window.MemoShell.confirm('Permanently delete this entry? This cannot be undone.', { danger: true, okLabel: 'Delete' }) : true;
      if (ok) await permanentlyDeleteEntry(e.id);
    });
    return card;
}

// The in-feed bin shares one bounded, keyed renderer between Memo and Finance.
let trashFeedState = null;
function releaseTrashFeed() {
  trashFeedState?.observer?.disconnect();
  trashFeedState = null;
}
function renderTrashFeed(deleted) {
  const feed = els.feed;
  if (!feed) return;
  const variant = window.MEMO_VARIANT;
  if (!trashFeedState || trashFeedState.variant !== variant || trashFeedState.feed !== feed) {
    releaseTrashFeed();
    trashFeedState = { variant, feed, count: RECYCLE_PAGE_SIZE, cards: new Map(), observer: null };
  }
  const state = trashFeedState;
  state.observer?.disconnect();
  state.observer = null;
  const nextCards = new Map();
  const nodes = [];
  const count = typeof IntersectionObserver === 'function' ? state.count : deleted.length;
  for (const entry of deleted.slice(0, count)) {
    // Include the day so relative expiry labels advance without replacing cards
    // on an ordinary sync or resume during the same day.
    const sig = JSON.stringify([entry.description, entry.category, entry.tags,
      entry.deletedAt, entry.permanentDeleteAt, Math.floor(Date.now() / 86400000)]);
    const cached = state.cards.get(entry.id);
    const node = cached?.sig === sig ? cached.node : buildRecycleCard(entry);
    node.dataset.id = entry.id;
    nextCards.set(entry.id, { sig, node });
    nodes.push(node);
  }
  state.cards = nextCards;
  if (!deleted.length) {
    const empty = feed.querySelector('.trash-empty-state') || document.createElement('div');
    empty.className = 'muted trash-empty-state';
    empty.style.cssText = 'grid-column:1 / -1;text-align:center;padding:40px 20px';
    empty.textContent = 'Recycle bin is empty.';
    nodes.push(empty);
  }
  if (count < deleted.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'recycle-window-sentinel feed-window-sentinel';
    nodes.push(sentinel);
    state.observer = new IntersectionObserver(items => {
      if (trashFeedState !== state || !sentinel.isConnected ||
          window.MEMO_VARIANT !== variant || !window.MemoVariant?.isTrashView?.() ||
          !items.some(item => item.isIntersecting)) return;
      state.count += RECYCLE_PAGE_SIZE;
      window.MemoVariant.renderFeed();
    }, { rootMargin: '600px 0px' });
    state.observer.observe(sentinel);
  }
  window.MemoDom.reconcile(feed, nodes);
}
window.addEventListener('pagehide', event => {
  if (window.MemoLifecycle?.retain(event) || event.persisted) return;
  releaseTrashFeed();
});

function releaseRecycleWindow() {
  if (recycleWindowObserver) recycleWindowObserver.disconnect();
  recycleWindowObserver = null;
}

function installRecycleWindowSentinel(deleted, renderedCount) {
  if (!els.recycleBinFeed || renderedCount >= deleted.length || typeof IntersectionObserver !== 'function') return;
  const sentinel = document.createElement('div');
  sentinel.className = 'recycle-window-sentinel feed-window-sentinel';
  els.recycleBinFeed.appendChild(sentinel);
  recycleWindowObserver = new IntersectionObserver(items => {
    if (!items.some(item => item.isIntersecting)) return;
    recycleWindowObserver.disconnect();
    recycleWindowObserver = null;
    sentinel.remove();
    const end = Math.min(renderedCount + RECYCLE_PAGE_SIZE, deleted.length);
    const fragment = document.createDocumentFragment();
    for (let index = renderedCount; index < end; index += 1) fragment.appendChild(buildRecycleCard(deleted[index]));
    els.recycleBinFeed.appendChild(fragment);
    installRecycleWindowSentinel(deleted, end);
  }, { rootMargin: '600px 0px' });
  recycleWindowObserver.observe(sentinel);
}

function renderRecycleBin() {
  if (!els.recycleBinFeed) return;
  releaseRecycleWindow();

  const deleted = db.entries
    .filter(e => e.deletedAt !== null && e.deletedAt !== undefined) // ← Only truly deleted entries
    .sort((a, b) => b.deletedAt - a.deletedAt);

  els.recycleBinFeed.innerHTML = '';
  if (deleted.length === 0) {
    els.recycleBinFeed.innerHTML = '<div class="muted" style="text-align:center;padding:40px 20px">Recycle bin is empty.</div>';
    return;
  }

  const initialCount = typeof IntersectionObserver === 'function'
    ? Math.min(RECYCLE_PAGE_SIZE, deleted.length)
    : deleted.length;
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < initialCount; index += 1) fragment.appendChild(buildRecycleCard(deleted[index]));
  els.recycleBinFeed.appendChild(fragment);
  installRecycleWindowSentinel(deleted, initialCount);
  updateRecycleBinBadge();
}

async function cleanupExpiredDeletes() {
  const now = Date.now();
  const permanentlyDeleted = [];
  
  const toDelete = db.entries.filter(e => {
    if (e.permanentDeleteAt && now >= e.permanentDeleteAt) {
      permanentlyDeleted.push(e);
      return true;
    }
    return false;
  });

  if (toDelete.length === 0) return;
  
  console.log(`Auto-deleting ${toDelete.length} expired entries from recycle bin...`);
  
  for (const entry of toDelete) {
    await permanentlyDeleteEntry(entry.id, { haptic: false });
  }
  
  console.log(`Auto-deleted ${toDelete.length} expired entries`);
}

// Recycle bin event listeners
if (els.recycleBinBtn) {
  els.recycleBinBtn.addEventListener('click', () => {
    // The memo variant shows the bin as a feed view (like Safe); other variants
    // fall back to the dialog.
    if (window.MemoVariant && typeof window.MemoVariant.toggleTrash === 'function') {
      window.MemoVariant.toggleTrash();
      return;
    }
    renderRecycleBin();
    if (els.recycleBinDlg) els.recycleBinDlg.showModal();
  });
}
if (els.closeRecycleBin) {
  els.closeRecycleBin.addEventListener('click', () => {
    releaseRecycleWindow();
    if (els.recycleBinDlg) els.recycleBinDlg.close();
  });
}
if (els.recycleBinDlg) els.recycleBinDlg.addEventListener('close', releaseRecycleWindow);
if (els.emptyRecycleBin) {
  els.emptyRecycleBin.addEventListener('click', emptyRecycleBin);
}
window.addEventListener('pagehide', event => {
  if (window.MemoLifecycle?.retain(event) || (event && event.persisted)) return;
  releaseRecycleWindow();
  if (expiredDeleteInterval) clearInterval(expiredDeleteInterval);
  expiredDeleteInterval = null;
});

// =======================
// End Recycle Bin Functions
// =======================

// =======================
// Detail view dispatcher
// =======================
function openDetail(id) {
  if (window.MemoVariant && typeof window.MemoVariant.openDetail === 'function') {
    return window.MemoVariant.openDetail(id);
  }
}

// =======================
// Lightweight Lightbox (stub)
function openLightbox(id, idx) { /* plug in your existing lightbox code here */ }

// =======================
// Tag Manager (core)
// Tag edits only replace entries' tag lists. Each edit records just the
// entries it changed, with their previous lists by id, so Undo restores those
// tags without copying the whole notebook or undoing newer edits to anything
// else, and the server page updates only the entries that changed.
let tagUndoStack = [];
function retag(change) {
  const changed = [], before = [];
  for (const e of db.entries) {
    if (!e.tags || !e.tags.length) continue;
    const next = change(e.tags);
    if (next.length === e.tags.length && next.every((x, i) => x === e.tags[i])) continue;
    before.push([e.id, e.tags]);
    e.tags = next;
    changed.push(e);
  }
  if (before.length) {
    tagUndoStack.push(before);
    if (els.tagMgrUndo) els.tagMgrUndo.disabled = false;
  }
  return changed;
}
async function doUndo() {
  const last = tagUndoStack.pop();
  if (!last) return;
  const byId = new Map(db.entries.map(e => [e.id, e]));
  const restored = [];
  for (const [id, tags] of last) {
    const e = byId.get(id);
    if (e) { e.tags = tags; restored.push(e); }
  }
  if (MODE === 'server') await Promise.all(restored.map(en => ServerAPI.update(en.id, { tags: en.tags })));
  recomputeTags(); saveAll(); refreshFilterTagsList(); buildTagManager(); renderFeed();
  if (els.tagMgrUndo && tagUndoStack.length === 0) els.tagMgrUndo.disabled = true;
}
if (els.tagMgrUndo) els.tagMgrUndo.addEventListener('click', doUndo);

if (els.manageTagsLink) els.manageTagsLink.addEventListener('click', () => {
  if (els.tagManager) els.tagManager.classList.toggle('hidden');
});
if (els.tagMgrClose) els.tagMgrClose.addEventListener('click', () => els.tagManager.classList.add('hidden'));

function buildTagManager() {
  const list = settings.tags || [];
  if (!els.tagMgrList) return;
  els.tagMgrList.innerHTML = '';
  if (list.length === 0) {
    els.tagMgrList.innerHTML = `<div class="muted">No tags yet.</div>`;
    return;
  }
  list.forEach(t => {
    const row = document.createElement('div');
    row.className = 'tagrow';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = t;
    input.dataset.old = t;
    const count = document.createElement('div');
    count.className = 'count';
    count.textContent = String(settings.tagCounts[t] || 0);
    const saveButton = document.createElement('button');
    saveButton.className = 'ghost';
    saveButton.dataset.act = 'save';
    saveButton.textContent = 'Rename/Merge';
    const deleteButton = document.createElement('button');
    deleteButton.className = 'danger';
    deleteButton.dataset.act = 'delete';
    deleteButton.textContent = 'Delete';
    row.append(input, count, saveButton, deleteButton);
    row.querySelector('[data-act=save]').addEventListener('click', async () => {
      const from = input.dataset.old;
      const to = input.value.trim();
      if (!to || to === from) return;
      // A rename onto an existing tag merges them, without duplicates.
      const changed = retag(tags => [...new Set(tags.map(x => x === from ? to : x))]);
      if (MODE === 'server') {
        await Promise.all(changed.map(en => ServerAPI.update(en.id, { tags: en.tags })));
      }
      recomputeTags(); saveAll(); refreshFilterTagsList(); buildTagManager(); renderFeed();
    });
    row.querySelector('[data-act=delete]').addEventListener('click', async () => {
      const okRemove = window.MemoShell ? await window.MemoShell.confirm(`Remove tag “${t}” from all entries?`, { danger: true, okLabel: 'Remove' }) : true;
      if (!okRemove) return;
      const changed = retag(tags => tags.filter(x => x !== t));
      if (MODE === 'server') {
        await Promise.all(changed.map(en => ServerAPI.update(en.id, { tags: en.tags })));
      }
      recomputeTags(); saveAll(); refreshFilterTagsList(); buildTagManager(); renderFeed();
    });
    els.tagMgrList.appendChild(row);
  });
}

function refreshFilterTagsList() {
  if (!els.filterTagSearch || !els.filterTags) return;
  const q = els.filterTagSearch.value.toLowerCase().trim();
  const list = (settings.tags || []).filter(t => t.toLowerCase().includes(q));
  els.filterTags.innerHTML = '';
  list.forEach(t => {
    const label = document.createElement('label');
    label.className = 'check-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.tag = t;
    input.checked = activeFilters.tags.has(t);
    const text = document.createElement('span');
    text.className = 'cr-text';
    text.textContent = '#' + t;
    const count = document.createElement('span');
    count.className = 'badge';
    count.textContent = String(settings.tagCounts[t] || 0);
    label.append(input, text, count);
    els.filterTags.appendChild(label);
  });
  els.filterTags.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const t = e.target.dataset.tag;
      if (e.target.checked) activeFilters.tags.add(t); else activeFilters.tags.delete(t);
      updateFilterIndicator();
    });
  });
}

// =======================
// FAB & helpers
// =======================
if (els.fab) els.fab.addEventListener('click', () => openEntryModal());
if (els.addCategoryBtn) els.addCategoryBtn.addEventListener('click', addCategory);
if (els.newCategory) els.newCategory.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } });
function addCategory() {
  const c = els.newCategory.value.trim();
  if (!c) return;
  if (!settings.categories.includes(c)) settings.categories.push(c);
  els.newCategory.value = '';
  saveAll(); refreshCategoryControls();
  if (els.categoryInput) els.categoryInput.value = c;
}

// =======================
// Feed rendering dispatcher – Variant must implement
// =======================
function renderFeed() {
  window.MemoLifecycle?.trace('render', { variant: MEMO_VARIANT, reason: window.__memoRenderReason || 'view' });
  if (window.MemoVariant && typeof window.MemoVariant.renderFeed === 'function') {
    return window.MemoVariant.renderFeed();
  }
}

// =======================
// Boot – called by variant after defining MemoVariant
// =======================
// Local-only data lives in the browser/app and is lost if site data is cleared.
// Nudge the user to back up (or connect a server) until they've done one of those.
function updateBackupNudge() {
  const id = 'backupNudge';
  let el = document.getElementById(id);
  const main = document.querySelector('main');
  if (!main) return;

  let backedUp = false, hasServer = false, snoozedAt = 0;
  try {
    backedUp = localStorage.getItem('memo_backed_up') === '1';
    hasServer = !!localStorage.getItem('memo_server_url');
    snoozedAt = parseInt(localStorage.getItem('memo_backup_snooze') || '0', 10);
  } catch (_e) {}
  const snoozed = snoozedAt && (Date.now() - snoozedAt < 7 * 24 * 60 * 60 * 1000);
  const show = MODE !== 'server' && !hasServer && !backedUp && !snoozed && db.entries.length > 0;

  if (!show) { if (el) el.remove(); return; }
  if (el) return; // already visible

  el = document.createElement('div');
  el.id = id;
  el.className = 'backup-nudge';
  el.innerHTML =
    `<span class="bn-ic"><span class="svg-icon svg-icon-save"></span></span>` +
    `<span class="bn-text">${window.Capacitor?.isNativePlatform?.()
      ? 'Your notes are only on this phone. Export a backup or connect a server, so a lost phone or an uninstall does not take them with it.'
      : 'Your data is only on this device — clearing browser data would erase it. Export a backup or connect a server.'}</span>` +
    `<button class="bn-export">Export backup</button>` +
    `<button class="bn-dismiss" title="Remind me in a week">Later</button>`;
  main.insertBefore(el, main.firstChild);

  el.querySelector('.bn-export').addEventListener('click', () => {
    const exportBtn = document.getElementById('exportDataBtn');
    if (exportBtn) exportBtn.click();           // runs the ZIP export (sets memo_backed_up)
    else if (els.settingsBtn) els.settingsBtn.click();
  });
  el.querySelector('.bn-dismiss').addEventListener('click', () => {
    try { localStorage.setItem('memo_backup_snooze', String(Date.now())); } catch (_e) {}
    el.remove();
  });
}
window.updateBackupNudge = updateBackupNudge;

async function coreInit() {
  // Bring up the in-browser SQLite engine before first load (no-op if OPFS/
  // Capacitor storage is unavailable — loadAll() then uses localStorage).
  const stateDbSvc = getService('stateDb', window.MemoStateDb);
  if (stateDbSvc && typeof stateDbSvc.init === 'function') {
    try {
      await stateDbSvc.init();
      const health = typeof stateDbSvc.getMetadataHealth === 'function'
        ? stateDbSvc.getMetadataHealth() : null;
      if (health && health.recoveredFrom && window.MemoShell && typeof window.MemoShell.toast === 'function') {
        window.MemoShell.toast('Local data recovered from the last known-good database snapshot.', {
          kind: 'warning', ms: 9000
        });
      }
    } catch (e) {
      console.warn('StateDb init failed:', e);
      if (window.MemoShell && typeof window.MemoShell.toast === 'function') {
        window.MemoShell.toast(
          'The local database could not be opened safely. Existing files were left untouched; restore or export recovery is required.',
          { kind: 'error', ms: 15000 }
        );
      }
    }
  }
  loadAll();
  // Pending edits must survive pure-local restarts too, before any server has
  // been configured. Initializing only after detection used to overwrite them.
  if (!getOperationQueue()?.deviceId) getOperationQueue()?.init();
  refreshCategoryControls();
  window.MemoRestore?.prepare(MEMO_VARIANT);
  installMountedImageHydration();
  renderFeed();
  updateBackupNudge();
  await window.MemoRestore?.ready();
  if (els.fsStatus) els.fsStatus.textContent = settings.fsEnabled ? 'enabled' : 'disabled';

  // OCR: fire onModalClose when dialog closes (ESC or backdrop click)
  if (els.entryDlg) {
    els.entryDlg.addEventListener('close', () => {
      workingTagDrafts.clear();
      if (window.MemoOcr && typeof window.MemoOcr.onModalClose === 'function') window.MemoOcr.onModalClose();
    });
  }

  // Clean up expired deleted entries (30+ days old)
  cleanupExpiredDeletes().catch(err => console.warn('cleanupExpiredDeletes failed:', err));
  updateRecycleBinBadge();

  // Set up daily cleanup with explicit page-lifecycle ownership.
  if (expiredDeleteInterval) clearInterval(expiredDeleteInterval);
  expiredDeleteInterval = setInterval(cleanupExpiredDeletes, 24 * 60 * 60 * 1000);

  await detectMode();

  // ── One local-first model ────────────────────────────────────────────
  // We already rendered from the local SQLite store (loadAll above) — that's the
  // single source of truth in EVERY case now. If a sync server is reachable we let
  // the op-queue run the initial sync: a cold/empty client pulls a server snapshot
  // (needsFullSync → applySnapshot), a warm client pulls only ops since
  // lastServerOpId. No full `/api/memos` re-fetch, no re-download of images already
  // stored locally. The op-queue repaints (via applyServerState) when data lands.
  // Start the background sync whenever a remote server is configured — not only
  // in same-origin 'server' mode. A native build runs in 'capacitor' mode (local
  // SQLite is the source of truth) yet still reconciles with its remote apiBase.
  const serverReachable = getMode() === 'server' || !!(getApiBase() && getApiBase().trim() !== '');
  if (serverReachable) {
    $$('[data-hide-when-server]').forEach(el => el.hidden = true);
    settings.fsEnabled = false;
    if (els.fsStatus) els.fsStatus.textContent = 'disabled';
    // Sync indicator only when a *remote* server is configured (not same-origin direct).
    const syncStatusEl = document.getElementById('syncStatus');
    if (syncStatusEl && getApiBase() && getApiBase().trim() !== '') syncStatusEl.style.display = 'flex';

    try {
      const syncManager = getSyncManager();
      if (syncManager && typeof syncManager.init === 'function') await syncManager.init();
    } catch (e) {
      console.warn('Sync init failed; continuing on local data.', e);
    }
    // Pages just render local data. Hydrate mounted images from the local blob
    // store in server mode too — otherwise a native build shows /uploads/ URLs
    // that can't load until a full-sync happens to run. The background sync
    // repaints when new data lands.
    installMountedImageHydration();
  } else {
    // Pure local (offline / no server reachable): the SQLite store is authoritative.
    // Keep offscreen entries as stable /uploads paths. The mounted-image observer
    // and MemoLazy resolve only the first visible/appended window on demand.
    installMountedImageHydration();
  }

  ensureFilterUiBootstrapped();
  updateBackupNudge();


}

function ensureFilterUiBootstrapped() {
  setTimeout(() => {
    if (window.MemoFilterBootstrapped) {
      console.log('🔍 Filter UI script already bootstrapped');
      return;
    }
    if (window.__memoFilterRetryRequested) {
      console.warn('🔍 Filter UI retry already requested');
      return;
    }
    window.__memoFilterRetryRequested = true;
    console.warn('🔍 Filter UI script missing; retrying dynamic load');
    const script = document.createElement('script');
    script.src = '/static/js/memo/memo-filter.js?v=3';
    script.onload = () => {
      console.log('🔍 Dynamic memo-filter.js load complete; bootstrapped=', !!window.MemoFilterBootstrapped);
    };
    script.onerror = () => {
      console.error('🔍 Dynamic memo-filter.js load failed');
    };
    document.body.appendChild(script);
  }, 250);
}

// ── Single-page shell: one memo-core instance, two screens (memo / finance) ──
// coreInit() brings up the SQLite engine + sync ONCE. switchVariant() then flips
// the active variant in place — reloading that variant's entries from the local
// store (pre-warmed by background sync) and repainting — with no page reload and
// no second engine init. In the classic multi-page build the variant module
// still calls MemoCore.start() directly, so this path is inert there.
let __coreStarted = false;
let __coreStartPromise = null;
async function startCore() {
  // Variant modules and test/app shells can both request startup during the
  // same DOMContentLoaded turn. Share the in-flight initialization instead of
  // letting later callers return while SQLite/mode detection can still replace
  // their view state underneath them.
  if (__coreStartPromise) return __coreStartPromise;
  __coreStarted = true;
  __coreStartPromise = coreInit().then(async () => {
    if (!window.__MEMO_SPA__) { await window.MemoPrivacy?.initialize(); await window.MemoDraft?.restore(); await window.MemoRestore?.restoreDetail(); }
  });
  return __coreStartPromise;
}
async function switchVariant(v) {
  v = (v === 'finance') ? 'finance' : 'default';
  if (__coreStartPromise) await __coreStartPromise;
  // Resume even when the internal variant already matches if the global was
  // hijacked by another view (planner sets window.MEMO_VARIANT='planner'); we
  // still need to re-point the store/queue back to this memo variant.
  if (__coreStarted && v === MEMO_VARIANT && window.MEMO_VARIANT === v) return;
  const oq = (typeof window !== 'undefined') ? window.OperationQueue : null;
  if (__coreStarted) {
    // Persist the outgoing variant's pending writes AND its op-queue (queue +
    // pull cursor are per-variant) before repointing the store to the new one.
    try { await flushPersistence(); } catch (_e) {}
    try { if (oq && oq.saveQueue) oq.saveQueue(); } catch (_e) {}
  }
  MEMO_VARIANT = v;
  window.MEMO_VARIANT = v;
  try { localStorage.setItem('memo_variant', v); } catch (_e) {}
  // Point the shared MemoVariant hook at the active variant module.
  if (window.MemoVariantRegistry && window.MemoVariantRegistry[v]) {
    window.MemoVariant = window.MemoVariantRegistry[v];
  }
  if (!__coreStarted) { await startCore(); return; }
  // Engine + sync already running: load the incoming variant's op-queue (so
  // pending ops + pull cursor track it), then its data, then paint.
  try { if (oq && oq.reloadQueue) oq.reloadQueue(); } catch (_e) {}
  loadAll();
  refreshCategoryControls();
  // The category/folder drill is per-variant: reset to root on every switch so
  // one variant's selected spending category doesn't carry into the other (it
  // used to leak in as the memo breadcrumb). renderFeed() then hides the
  // breadcrumb and shows all entries.
  if (els.categoryFilter) els.categoryFilter.value = '__ALL__';
  window.MemoRestore?.prepare(v);
  renderFeed();
  await window.MemoRestore?.ready();
  document.dispatchEvent(new CustomEvent('memo:variant-changed', { detail: { variant: v } }));
}

// Expose a tiny API for variants
window.MemoCore = {
  start: startCore,
  switchVariant: switchVariant,
  getVariant: getVariant,
  getState: () => ({ db, settings, activeFilters, els }),
  captureDraft: () => {
    if (!els.entryDlg?.open) return null;
    return { entry: editingId ? db.entries.find(e => e.id === editingId) : null,
      tags: [...workingTags], images: modalImages.map(item => ({ ...item })), files: modalFilesExtra.map(item => ({ ...item })),
      fields: [...els.entryDlg.querySelectorAll('input[id], textarea[id], select[id]')]
        .filter(node => node.type !== 'file').map(node => ({ id: node.id, value: node.value, checked: node.checked })),
      variant: window.MemoVariant?.captureDraft?.() };
  },
  restoreDraft: draft => {
    openEntryModal(draft.entry || null);
    window.MemoVariant?.restoreDraft?.(draft.variant);
    for (const field of draft.fields || []) {
      const node = document.getElementById(field.id);
      if (node && els.entryDlg.contains(node)) { node.value = field.value; if ('checked' in node) node.checked = field.checked; }
    }
    workingTags = new Set(draft.tags || []); renderTagChips();
    modalImages = draft.images || []; modalFilesExtra = draft.files || [];
    rebuildDragGrid(); renderExtraAttachmentsList();
  },
  setActiveEntryFilter: setActiveEntryFilter,
  getActiveEntryFilter: () => activeFilters.entryId || null,
  isImage: (u) => {
    // Accept blob URLs (created from local files)
    if ((u || '').startsWith('blob:')) return true;
    // Accept data URLs for images
    if ((u || '').startsWith('data:image/')) return true;
    // Check file extension
    return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(u || '');
  },
  // Is THIS ATTACHMENT an image? Classify by its declared MIME type first and
  // only sniff the URL when there is no type.
  //
  // isImage() above answers "can this URL be displayed as an image", and it says
  // yes to every blob: URL — correct for a freshly-picked photo, wrong for an
  // attachment. A PDF whose url is still blob: was therefore judged an image,
  // excluded from the attachment list, and (not being in entry.images either)
  // rendered NOWHERE: a receipt that silently disappeared from the card.
  isImageAttachment: (a) => {
    if (!a) return false;
    if (a.type) return String(a.type).startsWith('image/');
    const u = a.storedPath || a.url || '';
    if (u.startsWith('blob:')) return false;   // unknown type + opaque URL → treat as a file
    return window.MemoCore.isImage(u);
  },
  saveAll: saveAll,
  renderFeed: () => window.MemoVariant && window.MemoVariant.renderFeed && window.MemoVariant.renderFeed(),
  applyServerState: applyServerState,   // op-queue calls this after applying a snapshot / pulled ops
  batchDelete: batchDeleteEntries,
  batchApply: batchApplyEntries,
  restore: restoreEntry,   // clears deletedAt + re-renders; used by Undo snackbars in variants
  recomputeTags: recomputeTags,   // privacy toggles call this so the tag list re-projects
  // Recycle-bin-as-a-view (memo variant renders these in the feed, not a dialog).
  buildRecycleCard: buildRecycleCard,
  renderTrashFeed,
  releaseTrashFeed,
  emptyRecycleBin: emptyRecycleBin,
  deletedEntries: () => db.entries.filter(e => e.deletedAt != null).sort((a, b) => b.deletedAt - a.deletedAt),
  createReviewedEntry: createReviewedEntry,
  flushPersistence: flushPersistence,
  persistEntryMediaMutation: persistEntryMediaMutation,
  pruneEntryImageMeta: pruneEntryImageMeta,
  hydrateMountedImages: hydrateMountedImages,
  __mountedImageHydrationReady: () => mountedImageHydrationReady,
  // Add File objects (images/PDFs) to the currently-open entry modal — lets the
  // panel-images tool drop a combined image straight into a new entry.
  addImages: (files) => addImageFiles(files)
};

// Expose key functions globally so memo-ocr.js (loaded later) can patch them
window.openEntryModal = openEntryModal;
window.addImageFiles = addImageFiles; // used by memo-capture.js (hold-for-camera)
window.onSaveEntry = onSaveEntry;
window.renderTagChips = renderTagChips;
window.ensureCategory = ensureCategory;
// Entry-modal draft state is module-scoped; expose controlled access for picker modules.
Object.defineProperty(window, 'workingTags', {
  get: function () { return workingTags; },
  set: function (v) { workingTags = v; },
  configurable: true,
});
Object.defineProperty(window, 'workingTagDrafts', {
  get: function () { return workingTagDrafts; },
  set: function (v) { workingTagDrafts = v instanceof Set ? v : new Set(v || []); },
  configurable: true,
});
Object.defineProperty(window, 'modalImages', {
  get: function () { return modalImages; },
  set: function (v) { modalImages = v; },
  configurable: true,
});
Object.defineProperty(window, 'modalFilesExtra', {
  get: function () { return modalFilesExtra; },
  set: function (v) { modalFilesExtra = v; },
  configurable: true,
});

// Render list of non-image attachments below drag grid
function renderExtraAttachmentsList() {
  const hostParent = els.dragGrid ? els.dragGrid.parentElement : null;
  if (!hostParent) return;
  let box = hostParent.querySelector('#extraAttachments');
  if (!box) {
    box = document.createElement('div');
    box.id = 'extraAttachments';
    box.style.display = 'grid';
    box.style.gap = '6px';
    box.style.marginTop = '8px';
    hostParent.appendChild(box);
  }
  if (!modalFilesExtra.length) { box.innerHTML = ''; return; }
  box.innerHTML = '';
  const heading = document.createElement('div');
  heading.className = 'muted';
  heading.style.gridColumn = '1/-1';
  heading.textContent = 'Other files';
  box.appendChild(heading);
  modalFilesExtra.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'attach-row';
    row.dataset.idx = String(i);
    row.style.cssText = 'display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--border);padding:6px 10px;border-radius:10px;font-size:13px';
    const icon = document.createElement('span');
    icon.className = 'svg-icon svg-icon-file';
    const link = document.createElement('a');
    link.href = f.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.cssText = 'color:var(--accent);text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    link.textContent = f.name;
    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.dataset.act = 'remove';
    remove.title = 'Remove';
    remove.textContent = '×';
    row.append(icon, link, remove);
    box.appendChild(row);
  });
  box.querySelectorAll('button[data-act=remove]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const idx = parseInt(btn.closest('.attach-row').dataset.idx,10);
      const it = modalFilesExtra[idx];
      try { if (it?.file && it.url?.startsWith('blob:')) URL.revokeObjectURL(it.url); } catch{}
      modalFilesExtra.splice(idx,1);
      renderExtraAttachmentsList();
    });
  });
}

