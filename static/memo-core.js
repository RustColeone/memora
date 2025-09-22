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
const API_BASE = (typeof window !== "undefined" && window.API_BASE) ? window.API_BASE : ""; // e.g. "http://localhost:5000"
// Variant detection (default|finance). Prefer explicit window.MEMO_VARIANT or <meta name="memo-variant" content="finance">.
const MEMO_VARIANT = (function(){
  if (typeof window !== 'undefined' && window.MEMO_VARIANT) return String(window.MEMO_VARIANT).toLowerCase();
  const meta = (typeof document !== 'undefined') ? document.querySelector('meta[name="memo-variant"]') : null;
  const mval = meta?.getAttribute('content');
  const v = (mval || '').trim().toLowerCase();
  return (v === 'finance' || v === 'default') ? v : 'default';
})();

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
  chatDlg: $('#chatDlg'),
  chatHistory: $('#chatHistory'),
  chatInput: $('#chatInput'),
  chatSendBtn: $('#chatSendBtn'),
  chatClearBtn: $('#chatClearBtn'),
  chatCloseBtn: $('#chatCloseBtn'),
  lightbox: $('#lightbox'),
  lbImg: $('#lbImg'),
  lbPrev: $('#lbPrev'),
  lbNext: $('#lbNext'),
  lbClose: $('#lbClose'),
  lbCounter: $('#lbCounter'),
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
  dropzone: $('#dropzone')
};

// No-op hook (memo-filter.js may override visually)
function updateFilterIndicator() { /* optional hook in your app; safe no-op here */ }

// =======================
// State
// =======================
// Variant-aware local storage keys (back-compat reads legacy DB_KEY if present)
const DB_KEY = (MEMO_VARIANT === 'finance') ? 'memo_finance_db_v1' : 'memo_db_v1';
const SETTINGS_KEY = 'memo_settings_v1';
const CHAT_KEY = (MEMO_VARIANT === 'finance') ? 'chat_finance_v1' : 'chat_default_v1';

let MODE = 'detecting'; // 'server' or 'local'
let db = ({ entries: [] });
let settings = ({ categories: ['Uncategorized'], tags: [], tagCounts: {}, fsEnabled: false, memoDirHandle: undefined });

let workingTags = new Set();
let editingId = null;
let modalImages = []; // [{src, file?, existing}]
let dragSrcIdx = null;

let activeFilters = { dateFrom: null, dateTo: null, cats: new Set(), tags: new Set() };

// =======================
// Server detection & API
// =======================
async function detectMode() {
  try {
    const r = await fetch(`${API_BASE}/api/config`, { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      MODE = (j && j.server) ? 'server' : 'local';
      return MODE;
    }
  } catch (e) { /* ignore */ }
  MODE = 'local';
  return MODE;
}

const ServerAPI = {
  async list() {
    const qp = MEMO_VARIANT === 'default' ? '' : `?variant=${encodeURIComponent(MEMO_VARIANT)}`;
    const r = await fetch(`${API_BASE}/api/memos${qp}`);
    if (!r.ok) throw new Error('Failed to fetch memos');
    return r.json();
  },
  async create(memo) {
    const qp = MEMO_VARIANT === 'default' ? '' : `?variant=${encodeURIComponent(MEMO_VARIANT)}`;
    const r = await fetch(`${API_BASE}/api/memos${qp}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(memo)
    });
    if (!r.ok) throw new Error('Failed to create memo');
    return r.json();
  },
  async update(id, patch) {
    const qp = MEMO_VARIANT === 'default' ? '' : `?variant=${encodeURIComponent(MEMO_VARIANT)}`;
    const r = await fetch(`${API_BASE}/api/memos/${encodeURIComponent(id)}${qp}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!r.ok) throw new Error('Failed to update memo');
    return r.json();
  },
  async remove(id) {
    const qp = MEMO_VARIANT === 'default' ? '' : `?variant=${encodeURIComponent(MEMO_VARIANT)}`;
    const r = await fetch(`${API_BASE}/api/memos/${encodeURIComponent(id)}${qp}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('Failed to delete memo');
  },
  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('Upload failed');
    return r.json(); // { url: "/uploads/..." }
  },
  // Chat API
  async chatList() {
    const qp = MEMO_VARIANT === 'default' ? '' : `?variant=${encodeURIComponent(MEMO_VARIANT)}`;
    const r = await fetch(`${API_BASE}/api/chat${qp}`);
    if (!r.ok) throw new Error('Failed to fetch chat history');
    return r.json(); // [ {id, role, content, ts}, ... ]
  },
  async chatSend(message) {
    const qp = MEMO_VARIANT === 'default' ? '' : `?variant=${encodeURIComponent(MEMO_VARIANT)}`;
    const r = await fetch(`${API_BASE}/api/chat${qp}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    if (!r.ok) throw new Error('Failed to send chat message');
    return r.json(); // { messages: [ userMsg, botMsg ] }
  },
  async chatClear() {
    const qp = MEMO_VARIANT === 'default' ? '' : `?variant=${encodeURIComponent(MEMO_VARIANT)}`;
    const r = await fetch(`${API_BASE}/api/chat${qp}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('Failed to clear chat');
    return r.json(); // []
  }
};

// =======================
// Local storage + FS Access
// =======================
function loadAll() {
  try { const raw = localStorage.getItem(DB_KEY); if (raw) db = JSON.parse(raw); } catch (e) { db = { entries: [] }; }
  try { const raw = localStorage.getItem(SETTINGS_KEY); if (raw) settings = JSON.parse(raw); } catch (e) { /* ignore */ }
  if (!Array.isArray(settings.categories) || !settings.categories.length) settings.categories = ['Uncategorized'];
  recomputeTags();
}
function saveAll() {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, memoDirHandle: undefined }));
}
function recomputeTags() {
  const counts = {};
  for (const e of db.entries) { for (const t of (e.tags || [])) counts[t] = (counts[t] || 0) + 1; }
  const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  settings.tags = tags;
  settings.tagCounts = counts;
}

const IDB_DB_NAME = 'memo_fs';
const IDB_STORE = 'handles';
const IDB_KEY_ROOT = 'rootDirHandle';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key, val) {
  const dbx = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = dbx.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const dbx = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = dbx.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Request/confirm FS permissions
async function ensurePermission(handle, mode = 'read') {
  if (!handle || !handle.queryPermission) return false;
  const query = await handle.queryPermission({ mode });
  if (query === 'granted') return true;
  const req = await handle.requestPermission({ mode });
  return req === 'granted';
}
// Revoke old blob: URLs to avoid leaks
let urlBucket = [];
function revokeAllObjectURLs() { for (const u of urlBucket) { URL.revokeObjectURL(u); } urlBucket = []; }
// Resolve stored path -> object URL (local FS mode)
async function urlFromStoredPath(rootDir, storedPath) {
  const parts = (storedPath || '').split('/').filter(Boolean);
  if (!parts.length) throw new Error('Bad storedPath');
  let dir = rootDir;
  for (let i = 0; i < parts.length - 1; i++) { dir = await dir.getDirectoryHandle(parts[i]); }
  const fh = await dir.getFileHandle(parts[parts.length - 1]);
  const file = await fh.getFile();
  const url = URL.createObjectURL(file);
  urlBucket.push(url);
  return url;
}
// Read memo.json from disk
// -----------------------
// FS data files (variant parity with server.py)
// default: memos.json, finance: finance.json. Also support legacy memo.json for read-only back-compat.
function variantDataFileName() { return (MEMO_VARIANT === 'finance') ? 'finance.json' : 'memos.json'; }
function chatDataFileName() { return (MEMO_VARIANT === 'finance') ? 'chat_finance.json' : 'chat.json'; }
const HASHBOOK_FILE = 'hashbook.json';

async function readTextFileIfExists(dir, name) {
  try { const fh = await dir.getFileHandle(name); const f = await fh.getFile(); return await f.text(); } catch { return null; }
}

async function readEntriesFromFS(rootDir) {
  // Try primary file; if missing, try legacy memo.json
  const primary = await readTextFileIfExists(rootDir, variantDataFileName());
  const legacy = primary == null ? await readTextFileIfExists(rootDir, 'memo.json') : null;
  const raw = primary ?? legacy;
  if (!raw) return { entries: [] };
  try { return JSON.parse(raw); } catch { return { entries: [] }; }
}

async function writeEntriesToFS(rootDir, data) {
  const name = variantDataFileName();
  const fh = await rootDir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(data || { entries: [] }, null, 2));
  await w.close();
}

// -----------------------
// Hashbook (local FS) for de-duplication
async function readHashbookFS(rootDir) {
  const raw = await readTextFileIfExists(rootDir, HASHBOOK_FILE);
  if (!raw) return {};
  try { const obj = JSON.parse(raw); return (obj && typeof obj === 'object') ? obj : {}; } catch { return {}; }
}
async function writeHashbookFS(rootDir, obj) {
  const fh = await rootDir.getFileHandle(HASHBOOK_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(obj || {}, null, 2));
  await w.close();
}
async function computeSHA256(file) {
  try {
    const buf = await file.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(hash);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
async function storedPathExists(rootDir, storedPath) {
  try {
    const parts = (storedPath || '').split('/').filter(Boolean);
    if (!parts.length) return false;
    let dir = rootDir;
    for (let i = 0; i < parts.length - 1; i++) { dir = await dir.getDirectoryHandle(parts[i]); }
    await dir.getFileHandle(parts[parts.length - 1]);
    return true;
  } catch { return false; }
}
// Hydrate db from local folder
async function loadFromFolder(dirHandle) {
  const ok = await ensurePermission(dirHandle, 'read');
  if (!ok) { alert('Permission to read the chosen folder was denied.'); return; }
  settings.memoDirHandle = dirHandle;
  settings.fsEnabled = true;
  if (els.fsStatus) els.fsStatus.textContent = 'enabled';
  saveAll();
  const data = await readEntriesFromFS(dirHandle);
  revokeAllObjectURLs();
  const entries = [];
  for (const rec of (data.entries || [])) {
    const imgs = [];
    const storedPaths = [];
    const fsImgs = Array.isArray(rec.images) ? rec.images : [];
    for (const im of fsImgs) {
      const sp = (im && typeof im === 'object') ? im.storedPath : (typeof im === 'string' ? im : null);
      if (sp) {
        try { imgs.push(await urlFromStoredPath(dirHandle, sp)); storedPaths.push(sp); }
        catch (err) { console.warn('Missing image on disk:', sp); }
      }
    }
    const base = {
      id: rec.id,
      description: rec.description || '',
      category: rec.category || 'Uncategorized',
      tags: rec.tags || [],
      ts: rec.ts || Date.now(),
      images: imgs,
      _storedPaths: storedPaths,
    };
    // Finance fields pass-through
    if (MEMO_VARIANT === 'finance') {
      base.purchaseDate = rec.purchaseDate || (rec.ts ? new Date(rec.ts).toISOString().slice(0,10) : '');
      base.price = rec.price || 0;
      base.tax = rec.tax || '';
      base.adjustment = rec.adjustment || 0;
      base.total = rec.total || 0;
    }
    entries.push(base);
  }
  db.entries = entries;
  const cats = Array.from(new Set(entries.map(e => e.category))).sort();
  settings.categories = cats.length ? cats : ['Uncategorized'];
  recomputeTags();
  saveAll();
  refreshCategoryControls();
  renderFeed();
}

function fsSupported() { return 'showDirectoryPicker' in window; }
if (els.chooseDirBtn) {
  els.chooseDirBtn.addEventListener('click', async () => {
    if (!fsSupported()) { alert('Use Chrome/Edge desktop for File System Access API.'); return; }
    try {
      const dir = await window.showDirectoryPicker({ id: 'memo_root' });
      settings.memoDirHandle = dir;
      settings.fsEnabled = true;
      if (els.fsStatus) els.fsStatus.textContent = 'enabled';
      await idbPut(IDB_KEY_ROOT, settings.memoDirHandle);
      await loadFromFolder(settings.memoDirHandle);
      saveAll();
    } catch (e) { console.warn(e); }
  });
}

// =======================
// Utils
// =======================
function uid() { return 'e_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function fmtDate(ts) { const d = new Date(ts); return d.toLocaleString(); }
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
  const { categories } = settings;
  if (els.categoryFilter) {
    els.categoryFilter.innerHTML = `<option value="__ALL__">All categories</option>` + categories.map(c => `<option value="${c}">${c}</option>`).join('');
  }
  if (els.categoryInput) {
    els.categoryInput.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('');
  }
  if (els.filterCats) {
    els.filterCats.innerHTML = categories.map(c => `
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0">
        <input type="checkbox" data-cat="${c}" ${activeFilters.cats.has(c) ? 'checked' : ''}/>
        <span>${c}</span>
      </label>`).join('');
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
    c.innerHTML = `${t} <button title="Remove tag">×</button>`;
    c.querySelector('button').addEventListener('click', () => { workingTags.delete(t); renderTagChips(); });
    els.tagChips.appendChild(c);
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
  renderTagChips();

  refreshCategoryControls();
  if (entry) { ensureCategory(entry.category); if (els.categoryInput) els.categoryInput.value = entry.category; }
  else if (els.categoryInput) { els.categoryInput.value = settings.categories[0] || 'Uncategorized'; }

  // Variant hook (e.g., set finance fields)
  if (window.MemoVariant && typeof window.MemoVariant.openEntryModalHook === 'function') {
    window.MemoVariant.openEntryModalHook(entry);
  }

  modalImages = [];
  if (entry?.images?.length) {
    const stored = Array.isArray(entry._storedPaths) ? entry._storedPaths : [];
    entry.images.forEach((src, i) => {
      modalImages.push({ src, existing: true, storedPath: stored[i] || null });
    });
  }
  if (els.images) els.images.value = '';
  rebuildDragGrid();

  if (els.entryDlg) els.entryDlg.showModal();
}

// Tag chips/dropdown
let dropActiveIndex = -1;
function openTagDropdown(items, createText) {
  if (!els.tagDropdown) return;
  if (items.length === 0 && !createText) { els.tagDropdown.classList.add('hidden'); return; }
  els.tagDropdown.innerHTML = '';
  if (createText) {
    const n = document.createElement('div');
    n.className = 'dropitem active';
    n.dataset.create = '1';
    n.innerHTML = `<span>Create tag “${createText}”</span>`;
    els.tagDropdown.appendChild(n);
  }
  items.forEach((t) => {
    const d = document.createElement('div');
    d.className = 'dropitem';
    d.innerHTML = `<span>${t}</span><span class="muted">${settings.tagCounts[t] || 0}</span>`;
    els.tagDropdown.appendChild(d);
  });
  els.tagDropdown.classList.remove('hidden');
  dropActiveIndex = 0;
  updateDropActive();

  els.tagDropdown.querySelectorAll('.dropitem').forEach((el) => {
    el.addEventListener('mousedown', (ev) => { ev.preventDefault(); selectDropItem(el); });
    el.addEventListener('touchstart', (ev) => { ev.preventDefault(); selectDropItem(el); }, { passive: false });
    el.addEventListener('pointerdown', (ev) => { if (ev.pointerType !== 'mouse') { ev.preventDefault(); selectDropItem(el); } });
  });
}
function closeTagDropdown() { if (els.tagDropdown) els.tagDropdown.classList.add('hidden'); dropActiveIndex = -1; }
function updateDropActive() {
  if (!els.tagDropdown) return;
  const items = [...els.tagDropdown.querySelectorAll('.dropitem')];
  items.forEach((el, i) => el.classList.toggle('active', i === dropActiveIndex));
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
  workingTags.add(val);
  renderTagChips();
}
if (els.tagInput) {
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
    } else if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const len = els.tagDropdown.querySelectorAll('.dropitem').length;
      dropActiveIndex = (dropActiveIndex + (e.key === 'ArrowDown' ? 1 : -1) + len) % len;
      updateDropActive();
    } else if (e.key === 'Escape') { closeTagDropdown(); }
  });
  document.addEventListener('click', (e) => { if (!els.tagDropdown.contains(e.target) && e.target !== els.tagInput) closeTagDropdown(); });
}

// Drag grid
function rebuildDragGrid() {
  if (!els.dragGrid) return;
  els.dragGrid.innerHTML = '';
  modalImages.forEach((it, idx) => {
    const d = document.createElement('div');
    d.className = 'dragitem';
    d.draggable = true;
  d.innerHTML = `
                <button class="delimg" title="Remove image" aria-label="Remove image" data-idx="${idx}">×</button>
                <span class="handle" title="Drag to reorder">⋮⋮ ${idx + 1}</span>
                <img src="${it.src}" alt="">
            `;
    d.querySelector('.delimg').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = idx;
      const item = modalImages[i];
      try { if (item?.file && item?.src?.startsWith?.('blob:')) URL.revokeObjectURL(item.src); } catch { }
      modalImages.splice(i, 1);
      rebuildDragGrid();
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
    if (!f || !f.type?.startsWith('image/')) continue;
    const url = URL.createObjectURL(f);
    modalImages.push({ src: url, file: f, existing: false });
  }
  rebuildDragGrid();
}

if (els.images) {
  els.images.addEventListener('change', () => {
    addImageFiles(els.images.files);
    els.images.value = ''; // allow selecting same file again
  });
}

if (els.dropzone && els.images) {
  els.dropzone.addEventListener('click', () => els.images.click());
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
        if (f && f.type?.startsWith('image/')) files.push(f);
      }
    }
    if (files.length) addImageFiles(files);
  });
}

// ============= Save / Delete =============
if (els.cancelBtn) els.cancelBtn.addEventListener('click', () => els.entryDlg.close());
if (els.saveBtn) els.saveBtn.addEventListener('click', onSaveEntry);
if (els.closeDetailBtn) els.closeDetailBtn.addEventListener('click', () => els.detailDlg.close());
if (els.deleteBtn) els.deleteBtn.addEventListener('click', onDeleteEntry);
if (els.editBtn) els.editBtn.addEventListener('click', () => {
  const id = els.detailDlg?.dataset?.entryId; if (!id) return;
  const e = db.entries.find(x => x.id === id);
  els.detailDlg.close(); openEntryModal(e);
});

async function onSaveEntry() {
  const description = els.desc ? els.desc.value.trim() : '';
  const category = (els.categoryInput && els.categoryInput.value) ? els.categoryInput.value : 'Uncategorized';
  const ts = Date.now();
  const tags = [...workingTags];
  if (!description && modalImages.length === 0) { alert('Please enter a description or add at least one image.'); return; }

  let entry = editingId ? db.entries.find(e => e.id === editingId) : { id: uid(), images: [] };
  const isNew = !editingId;
  entry.description = description;
  entry.category = category;
  entry.tags = tags;
  entry.ts = isNew ? ts : entry.ts;

  // Variant may add/modify fields (e.g., finance data)
  if (window.MemoVariant && typeof window.MemoVariant.collectAdditionalFields === 'function') {
    window.MemoVariant.collectAdditionalFields(entry, isNew);
  }

  // Build images for submit:
  let imagesFinal = [];
  modalImages.forEach(mi => { if (mi.existing) imagesFinal.push(mi.src); });
  const filesToSave = modalImages.filter(mi => mi.file);

  if (MODE === 'server') {
    for (let i = 0; i < filesToSave.length; i++) {
      const f = filesToSave[i].file;
      const res = await ServerAPI.upload(f);
      if (res && res.url) imagesFinal.push(res.url);
    }
    entry.images = imagesFinal;

    let saved;
    if (isNew) saved = await ServerAPI.create(entry);
    else saved = await ServerAPI.update(entry.id, entry);

    if (isNew) db.entries.push(saved);
    else {
      const i = db.entries.findIndex(e => e.id === entry.id);
      if (i >= 0) db.entries[i] = saved;
    }
  } else {
    entry.images = [];
    const filesToWrite = [];
    const keptStoredPaths = [];
    modalImages.forEach(mi => {
      entry.images.push(mi.src);
      if (mi.file) filesToWrite.push(mi); else if (mi.existing && mi.storedPath) keptStoredPaths.push(mi.storedPath);
    });

    if (settings.fsEnabled && settings.memoDirHandle && filesToWrite.length) {
      const dateFolderName = todayFolder(entry.ts);
      const dateDir = await getOrCreateDir(settings.memoDirHandle, dateFolderName);
      const base = slug(description || 'memo');

      // Load hashbook for de-duplication
      const book = await readHashbookFS(settings.memoDirHandle);

      for (let i = 0; i < filesToWrite.length; i++) {
        const f = filesToWrite[i].file;
        const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
        const hash = await computeSHA256(f);
        let usedStoredPath = null;
        if (hash && book[hash] && book[hash].storedPath && await storedPathExists(settings.memoDirHandle, book[hash].storedPath)) {
          // Reuse existing file
          usedStoredPath = book[hash].storedPath;
          book[hash].count = Math.max(1, parseInt(book[hash].count || 1, 10) + 1);
        } else {
          // Write new file
          const newName = `${dateFolderName}_${base || 'post'}_${String(i + 1).padStart(2, '0')}.${ext}`;
          const fileHandle = await dateDir.getFileHandle(newName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(await f.arrayBuffer());
          await writable.close();
          usedStoredPath = `${dateFolderName}/${newName}`;
          if (hash) book[hash] = { storedPath: usedStoredPath, count: 1 };
        }
        await writeHashbookFS(settings.memoDirHandle, book);
        keptStoredPaths.push(usedStoredPath);
      }
    }

    // Update FS JSON record to match exactly the kept/new stored paths
    if (settings.fsEnabled && settings.memoDirHandle) {
      const originalPaths = Array.isArray((db.entries.find(e => e.id === entry.id)?._storedPaths)) ? (db.entries.find(e => e.id === entry.id)._storedPaths) : [];
      const removed = originalPaths.filter(sp => sp && !keptStoredPaths.includes(sp));
      // Decrement hashbook and delete files for removed paths
      for (const sp of removed) { try { await decrementAndMaybeDelete(settings.memoDirHandle, sp); } catch (e) { console.warn('Failed to cleanup removed image', sp, e); } }
      await replaceMemoRecordImages(settings.memoDirHandle, entry, keptStoredPaths);
      entry._storedPaths = keptStoredPaths.slice();
    }

    if (isNew) db.entries.push(entry);
    else {
      const i = db.entries.findIndex(e => e.id === entry.id);
      if (i >= 0) db.entries[i] = entry;
    }
    recomputeTags(); saveAll();
  }

  if (els.entryDlg) els.entryDlg.close();
  recomputeTags(); saveAll();
  renderFeed();
}

async function onDeleteEntry() {
  const id = els.detailDlg?.dataset?.entryId; if (!id) return;
  if (!confirm('Delete this entry?')) return;

  if (MODE === 'server') {
    await ServerAPI.remove(id);
  } else {
    // Local mode: cleanup files via hashbook
    const entry = db.entries.find(e => e.id === id);
    if (entry && settings.fsEnabled && settings.memoDirHandle && Array.isArray(entry._storedPaths)) {
      for (const sp of entry._storedPaths) {
        try { await decrementAndMaybeDelete(settings.memoDirHandle, sp); } catch (e) { console.warn('Failed to delete image', sp, e); }
      }
      // Remove record from FS JSON
      await removeMemoRecord(settings.memoDirHandle, id);
    }
  }
  db.entries = db.entries.filter(e => e.id !== id);
  recomputeTags(); saveAll();
  els.detailDlg?.close(); renderFeed();
}

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
let tagUndoStack = [];
function snapshotEntries() { return JSON.parse(JSON.stringify(db.entries)); }
function pushUndo() { tagUndoStack.push({ entriesSnapshot: snapshotEntries() }); if (els.tagMgrUndo) els.tagMgrUndo.disabled = false; }
function doUndo() {
  const last = tagUndoStack.pop();
  if (!last) return;
  db.entries = last.entriesSnapshot;
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
    row.innerHTML = `
      <input type="text" value="${t}" data-old="${t}" />
      <div class="count">${settings.tagCounts[t] || 0}</div>
      <button class="ghost" data-act="save">Rename/Merge</button>
      <button class="danger" data-act="delete">Delete</button>
    `;
    const input = row.querySelector('input');
    row.querySelector('[data-act=save]').addEventListener('click', async () => {
      const from = input.dataset.old;
      const to = input.value.trim();
      if (!to || to === from) return;
      pushUndo();
      for (const e of db.entries) { if (e.tags) { e.tags = e.tags.map(x => x === from ? to : x); } }
      if (MODE === 'server') {
        await Promise.all(db.entries.map(en => ServerAPI.update(en.id, { tags: en.tags })));
      }
      recomputeTags(); saveAll(); refreshFilterTagsList(); buildTagManager(); renderFeed();
    });
    row.querySelector('[data-act=delete]').addEventListener('click', async () => {
      if (!confirm(`Remove tag “${t}” from all posts?`)) return;
      pushUndo();
      for (const e of db.entries) { if (e.tags) { e.tags = e.tags.filter(x => x !== t); } }
      if (MODE === 'server') {
        await Promise.all(db.entries.map(en => ServerAPI.update(en.id, { tags: en.tags })));
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
  els.filterTags.innerHTML = list.map(t => `
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0;justify-content:space-between">
      <span style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" data-tag="${t}" ${activeFilters.tags.has(t) ? 'checked' : ''}/>
        <span>#${t}</span>
      </span>
      <span class="muted">${settings.tagCounts[t] || 0}</span>
    </label>`).join('');
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
  if (window.MemoVariant && typeof window.MemoVariant.renderFeed === 'function') {
    return window.MemoVariant.renderFeed();
  }
}

// =======================
// Boot – called by variant after defining MemoVariant
// =======================
async function coreInit() {
  loadAll();
  refreshCategoryControls();
  if (els.fsStatus) els.fsStatus.textContent = settings.fsEnabled ? 'enabled' : 'disabled';

  await detectMode();

  if (MODE === 'server') {
    $$('[data-hide-when-server]').forEach(el => el.hidden = true);
    settings.fsEnabled = false;
    if (els.fsStatus) els.fsStatus.textContent = 'disabled';

    try {
      const memos = await ServerAPI.list();
      db.entries = (memos || []).map(m => {
        if (window.MemoVariant && typeof window.MemoVariant.normalizeServerMemo === 'function') {
          return window.MemoVariant.normalizeServerMemo(m);
        }
        // default normalization
        return {
          id: m.id,
          description: m.description || '',
          category: m.category || 'Uncategorized',
          tags: m.tags || [],
          ts: m.ts || Date.now(),
          images: m.images || [],
        };
      });
      const cats = Array.from(new Set(db.entries.map(e => e.category))).sort();
      settings.categories = cats.length ? cats : ['Uncategorized'];
      recomputeTags(); saveAll();
      refreshCategoryControls();
      renderFeed();
    } catch (e) {
      console.error('Failed to load memos from server; falling back to local.', e);
      MODE = 'local';
      renderFeed();
    }
  } else {
    try {
      const persisted = await idbGet(IDB_KEY_ROOT);
      if (persisted && await ensurePermission(persisted, 'read')) {
        await loadFromFolder(persisted);
        return;
      }
    } catch (e) { console.warn('No persisted folder or cannot restore:', e); }
    renderFeed();
  }

  // Initialize Chat wiring after mode detection
  initChatUI();
}

// Expose a tiny API for variants
window.MemoCore = {
  start: coreInit,
  getState: () => ({ db, settings, activeFilters, els }),
};

// ===== Helpers needed by local FS write path =====
async function getOrCreateDir(root, name) { return await root.getDirectoryHandle(name, { create: true }); }
async function updateMemoJson(rootDir, entry, imgInfo) {
  const filename = variantDataFileName();
  let jsonHandle;
  try { jsonHandle = await rootDir.getFileHandle(filename); }
  catch {
    jsonHandle = await rootDir.getFileHandle(filename, { create: true });
    const w = await jsonHandle.createWritable(); await w.write(JSON.stringify({ entries: [] }, null, 2)); await w.close();
  }
  const file = await jsonHandle.getFile();
  let data = { entries: [] };
  try { data = JSON.parse(await file.text()); } catch { }
  let rec = data.entries.find(x => x.id === entry.id);
  if (!rec) {
    rec = { id: entry.id, description: entry.description, category: entry.category, tags: entry.tags, ts: entry.ts, images: [] };
    if (MEMO_VARIANT === 'finance') {
      rec.purchaseDate = entry.purchaseDate; rec.price = entry.price; rec.tax = entry.tax; rec.adjustment = entry.adjustment; rec.total = entry.total;
    }
    data.entries.push(rec);
  } else {
    rec.description = entry.description; rec.category = entry.category; rec.tags = entry.tags; rec.ts = entry.ts;
    if (MEMO_VARIANT === 'finance') {
      rec.purchaseDate = entry.purchaseDate; rec.price = entry.price; rec.tax = entry.tax; rec.adjustment = entry.adjustment; rec.total = entry.total;
    }
  }
  if (imgInfo?.storedPath) {
    const sp = imgInfo.storedPath;
    const exists = (rec.images || []).some(im => (im && typeof im === 'object' ? im.storedPath : im) === sp);
    if (!exists) rec.images.push({ storedPath: sp, originalName: imgInfo.originalName });
  }
  const w = await jsonHandle.createWritable(); await w.write(JSON.stringify(data, null, 2)); await w.close();
}

async function replaceMemoRecordImages(rootDir, entry, storedPaths) {
  const name = variantDataFileName();
  const fh = await rootDir.getFileHandle(name, { create: true });
  const file = await fh.getFile();
  let data = { entries: [] };
  try { data = JSON.parse(await file.text()); } catch { }
  let rec = data.entries.find(x => x.id === entry.id);
  if (!rec) {
    rec = { id: entry.id, description: entry.description, category: entry.category, tags: entry.tags, ts: entry.ts, images: [] };
    if (MEMO_VARIANT === 'finance') { rec.purchaseDate = entry.purchaseDate; rec.price = entry.price; rec.tax = entry.tax; rec.adjustment = entry.adjustment; rec.total = entry.total; }
    data.entries.push(rec);
  } else {
    rec.description = entry.description; rec.category = entry.category; rec.tags = entry.tags; rec.ts = entry.ts;
    if (MEMO_VARIANT === 'finance') { rec.purchaseDate = entry.purchaseDate; rec.price = entry.price; rec.tax = entry.tax; rec.adjustment = entry.adjustment; rec.total = entry.total; }
  }
  rec.images = (storedPaths || []).filter(Boolean).map(sp => ({ storedPath: sp }));
  const w = await fh.createWritable(); await w.write(JSON.stringify(data, null, 2)); await w.close();
}

function findHashByStoredPath(book, sp) {
  for (const [h, rec] of Object.entries(book || {})) {
    if (rec && typeof rec === 'object' && rec.storedPath === sp) return h;
  }
  return null;
}

async function decrementAndMaybeDelete(rootDir, storedPath) {
  const book = await readHashbookFS(rootDir);
  const h = findHashByStoredPath(book, storedPath);
  if (!h) return; // not tracked
  const rec = book[h];
  const cnt = Math.max(0, parseInt(rec.count || 0, 10) - 1);
  if (cnt === 0) {
    // delete the file and remove mapping
    try { await deleteStoredPath(rootDir, storedPath); } catch {}
    delete book[h];
  } else {
    rec.count = cnt; book[h] = rec;
  }
  await writeHashbookFS(rootDir, book);
}

async function deleteStoredPath(rootDir, storedPath) {
  const parts = (storedPath || '').split('/').filter(Boolean);
  if (parts.length < 2) return;
  const folder = parts[0]; const fname = parts.slice(1).join('/');
  let parent = await rootDir.getDirectoryHandle(folder);
  // Only one-level deep path expected; if nested, walk deeper
  const fnameParts = fname.split('/').filter(Boolean);
  for (let i = 0; i < fnameParts.length - 1; i++) { parent = await parent.getDirectoryHandle(fnameParts[i]); }
  await parent.removeEntry(fnameParts[fnameParts.length - 1]);
  // Best-effort remove empty first-level date folder
  if (fnameParts.length === 1) {
    try { await rootDir.removeEntry(folder); } catch {}
  }
}

async function removeMemoRecord(rootDir, id) {
  const name = variantDataFileName();
  try {
    const fh = await rootDir.getFileHandle(name, { create: true });
    const file = await fh.getFile();
    let data = { entries: [] };
    try { data = JSON.parse(await file.text()); } catch { }
    data.entries = (data.entries || []).filter(x => x.id !== id);
    const w = await fh.createWritable(); await w.write(JSON.stringify(data, null, 2)); await w.close();
  } catch (e) { console.warn('removeMemoRecord failed', e); }
}

// =======================
// Chat UI (core)
// =======================
function createChatMsgElement(msg) {
  const wrap = document.createElement('div');
  wrap.className = `chat-msg ${msg.role === 'user' ? 'user' : 'assistant'}`;
  const role = document.createElement('div');
  role.className = 'chat-role';
  role.textContent = msg.role === 'user' ? 'You' : 'Assistant';
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = msg.content || '';
  wrap.appendChild(role);
  wrap.appendChild(bubble);
  return wrap;
}

function renderChatHistory(messages) {
  if (!els.chatHistory) return;
  els.chatHistory.innerHTML = '';
  (messages || []).forEach(m => {
    els.chatHistory.appendChild(createChatMsgElement(m));
  });
  // scroll to bottom
  els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

function setChatDisabled(disabled, hint) {
  if (!els.chatInput || !els.chatSendBtn) return;
  els.chatInput.disabled = disabled;
  els.chatSendBtn.disabled = disabled;
  if (disabled && hint && els.chatHistory) {
    const msg = { role: 'assistant', content: hint };
    els.chatHistory.appendChild(createChatMsgElement(msg));
  }
}

function initChatUI() {
  if (!els.chatBtn || !els.chatDlg || !els.chatHistory) return;

  async function openChat() {
    els.chatHistory.innerHTML = '';
    if (MODE === 'server') {
      try {
        const history = await ServerAPI.chatList();
        renderChatHistory(history);
        setChatDisabled(false);
      } catch (e) {
        renderChatHistory([]);
        setChatDisabled(true, 'Unable to load chat history.');
      }
    } else {
      try {
        const history = await LocalChat.list();
        renderChatHistory(history);
        setChatDisabled(false);
      } catch (e) {
        renderChatHistory([]);
        setChatDisabled(true, 'Chat unavailable.');
      }
    }
    els.chatDlg.showModal();
    if (!els.chatInput.disabled) {
      els.chatInput.focus();
    }
  }

  async function doSend() {
    if (!els.chatInput || !els.chatHistory) return;
    const text = (els.chatInput.value || '').trim();
    if (!text) return;
    // optimistic user append
    const userMsg = { role: 'user', content: text };
    els.chatHistory.appendChild(createChatMsgElement(userMsg));
    els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    els.chatInput.value = '';
    els.chatInput.disabled = true; els.chatSendBtn.disabled = true;
    try {
      if (MODE === 'server') {
        const res = await ServerAPI.chatSend(text);
        const msgs = res && res.messages ? res.messages : [];
        const assistant = msgs.find(m => m.role === 'assistant');
        if (assistant) els.chatHistory.appendChild(createChatMsgElement(assistant));
      } else {
        const { messages } = await LocalChat.send(text);
        const assistant = messages.find(m => m.role === 'assistant');
        if (assistant) els.chatHistory.appendChild(createChatMsgElement(assistant));
      }
      els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    } catch (e) {
      const errMsg = { role: 'assistant', content: 'Failed to send. Please try again.' };
      els.chatHistory.appendChild(createChatMsgElement(errMsg));
    } finally {
      els.chatInput.disabled = false; els.chatSendBtn.disabled = false;
      els.chatInput.focus();
    }
  }

  async function doClear() {
    try {
      if (MODE === 'server') await ServerAPI.chatClear(); else await LocalChat.clear();
      els.chatHistory.innerHTML = '';
    } catch (e) {
      const m = { role: 'assistant', content: 'Failed to clear history.' };
      els.chatHistory.appendChild(createChatMsgElement(m));
    }
  }

  els.chatBtn.addEventListener('click', openChat);
  if (els.chatCloseBtn) els.chatCloseBtn.addEventListener('click', () => els.chatDlg.close());
  if (els.chatSendBtn) els.chatSendBtn.addEventListener('click', doSend);
  if (els.chatInput) els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSend(); }
  });
  if (els.chatClearBtn) els.chatClearBtn.addEventListener('click', doClear);
}

// =======================
// Local Chat (no server): FS if available, else localStorage
const LocalChat = {
  async list() {
    if (settings.fsEnabled && settings.memoDirHandle) {
      const raw = await readTextFileIfExists(settings.memoDirHandle, chatDataFileName());
      if (!raw) return [];
      try { return JSON.parse(raw) || []; } catch { return []; }
    }
    try { const raw = localStorage.getItem(CHAT_KEY); return raw ? (JSON.parse(raw) || []) : []; } catch { return []; }
  },
  async send(message) {
    const now = new Date().toISOString();
    const user = { id: uid(), role: 'user', content: message, ts: now };
    const bot = { id: uid(), role: 'assistant', content: 'FEATURE NOT SUPPORTED YET', ts: new Date().toISOString() };
    const msgs = await this.list();
    msgs.push(user, bot);
    if (settings.fsEnabled && settings.memoDirHandle) {
      const fh = await settings.memoDirHandle.getFileHandle(chatDataFileName(), { create: true });
      const w = await fh.createWritable(); await w.write(JSON.stringify(msgs, null, 2)); await w.close();
    } else {
      localStorage.setItem(CHAT_KEY, JSON.stringify(msgs));
    }
    return { messages: [user, bot] };
  },
  async clear() {
    if (settings.fsEnabled && settings.memoDirHandle) {
      const fh = await settings.memoDirHandle.getFileHandle(chatDataFileName(), { create: true });
      const w = await fh.createWritable(); await w.write(JSON.stringify([], null, 2)); await w.close();
    } else {
      localStorage.setItem(CHAT_KEY, JSON.stringify([]));
    }
    return [];
  }
};
