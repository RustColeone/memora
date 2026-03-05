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
// Variant detection (default|finance). Prefer explicit window.MEMO_VARIANT or <meta name="memo-variant" content="finance">.
const MEMO_VARIANT = (function(){
  if (typeof window !== 'undefined' && window.MEMO_VARIANT) return String(window.MEMO_VARIANT).toLowerCase();
  const meta = (typeof document !== 'undefined') ? document.querySelector('meta[name="memo-variant"]') : null;
  const mval = meta?.getAttribute('content');
  const metaVariant = (mval || '').trim().toLowerCase();
  if (metaVariant === 'finance' || metaVariant === 'default') return metaVariant;
  let storedVariant = '';
  try { storedVariant = (localStorage.getItem('memo_variant') || '').trim().toLowerCase(); } catch (_ignored) {}
  return (storedVariant === 'finance' || storedVariant === 'default') ? storedVariant : 'default';
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
// Variant-aware local storage keys (back-compat reads legacy DB_KEY if present)
const DB_KEY = (MEMO_VARIANT === 'finance') ? 'memo_finance_db_v1' : 'memo_db_v1';
const SETTINGS_KEY = 'memo_settings_v1';
const CHAT_KEY = (MEMO_VARIANT === 'finance') ? 'chat_finance_v1' : 'chat_default_v1';

let MODE = 'detecting'; // 'server' | 'local' | 'capacitor'
setMode(MODE);
window.MEMO_VARIANT = MEMO_VARIANT; // Make MEMO_VARIANT accessible globally
let db = ({ entries: [] });
let settings = ({ categories: ['Uncategorized'], tags: [], tagCounts: {}, fsEnabled: false, memoDirHandle: undefined });

let workingTags = new Set();
let editingId = null;
let modalImages = []; // [{src, file?, existing, storedPath?}]
let modalFilesExtra = []; // non-image attachments (e.g. pdf) [{name, url, file?, existing, storedPath?, type}]
let dragSrcIdx = null;

let activeFilters = { dateFrom: null, dateTo: null, cats: new Set(), tags: new Set() };

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
function loadAll() {
  try { const raw = localStorage.getItem(DB_KEY); if (raw) db = JSON.parse(raw); } catch (e) { db = { entries: [] }; }
  try { const raw = localStorage.getItem(SETTINGS_KEY); if (raw) settings = JSON.parse(raw); } catch (e) { /* ignore */ }
  if (!Array.isArray(settings.categories) || !settings.categories.length) settings.categories = ['Uncategorized'];
  recomputeTags();
}
function saveAll() {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, memoDirHandle: undefined }));
  
  // Also save to file system if folder is selected
  if (settings.fsEnabled && settings.memoDirHandle) {
    console.log('💾 Saving to local file system...');
    writeEntriesToFS(settings.memoDirHandle, db).then(() => {
      console.log('✅ Saved to local memos.json');
    }).catch(err => {
      console.error('❌ Failed to save to local file system:', err);
    });
  }
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
async function ensureWritePermission(dirHandle) {
  try { return await ensurePermission(dirHandle, 'readwrite'); } catch { return false; }
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
  // Try reading from data/ folder first (preferred location matching server structure)
  try {
    const dataDir = await rootDir.getDirectoryHandle('data');
    const primary = await readTextFileIfExists(dataDir, variantDataFileName());
    if (primary) {
      try { 
        const parsed = JSON.parse(primary);
        // Handle both server format (array) and old format ({entries: []})
        if (Array.isArray(parsed)) {
          return { entries: parsed };
        }
        return parsed;
      } catch { 
        return { entries: [] }; 
      }
    }
  } catch {
    // data/ folder doesn't exist, fall back to root
  }
  
  // Fall back to root directory (legacy location)
  const primary = await readTextFileIfExists(rootDir, variantDataFileName());
  const legacy = primary == null ? await readTextFileIfExists(rootDir, 'memo.json') : null;
  const raw = primary ?? legacy;
  if (!raw) return { entries: [] };
  try { 
    const parsed = JSON.parse(raw);
    // Handle both server format (array) and old format ({entries: []})
    if (Array.isArray(parsed)) {
      return { entries: parsed };
    }
    return parsed;
  } catch { 
    return { entries: [] }; 
  }
}

async function writeEntriesToFS(rootDir, data) {
  // Write to data/ folder (matching server structure)
  const dataDir = await rootDir.getDirectoryHandle('data', { create: true });
  const name = variantDataFileName();
  const fh = await dataDir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  
  // Clone data to avoid modifying the in-memory state
  const dataClone = JSON.parse(JSON.stringify(data || { entries: [] }));
  
  // Clean up entries for persistence:
  // 1. Convert _storedPaths to proper /uploads/ paths for images
  // 2. Remove internal _storedPaths and other local-only fields
  if (dataClone.entries && Array.isArray(dataClone.entries)) {
    dataClone.entries.forEach(entry => {
      // Restore images paths from _storedPaths if available needed for server symmetry
      if (entry._storedPaths && Array.isArray(entry._storedPaths) && entry._storedPaths.length > 0) {
        entry.images = entry._storedPaths.map(sp => sp.startsWith('uploads/') ? `/${sp}` : `/uploads/${sp}`);
      }
      
      // Cleanup internal fields
      delete entry._storedPaths;
      delete entry._hasConflict;
      delete entry._conflictClientVersion;
      delete entry._conflictResolvedAt;
      
      // Ensure attachments also use the correct path format if they have storedPath
      if (entry.attachments && Array.isArray(entry.attachments)) {
        entry.attachments.forEach(att => {
          if (att.storedPath) {
            att.url = att.storedPath.startsWith('uploads/') ? `/${att.storedPath}` : `/uploads/${att.storedPath}`;
            delete att.storedPath;
          }
        });
      }
    });
  }
  
  await w.write(JSON.stringify(dataClone.entries, null, 2)); // Save as array
  await w.close();
}

// -----------------------
// Hashbook (local FS) for de-duplication
async function readHashbookFS(rootDir) {
  // Try reading from data/ folder first
  try {
    const dataDir = await rootDir.getDirectoryHandle('data');
    const raw = await readTextFileIfExists(dataDir, HASHBOOK_FILE);
    if (raw) {
      try { const obj = JSON.parse(raw); return (obj && typeof obj === 'object') ? obj : {}; } catch { return {}; }
    }
  } catch {
    // data/ folder doesn't exist, fall back to root
  }
  
  // Fall back to root directory
  const raw = await readTextFileIfExists(rootDir, HASHBOOK_FILE);
  if (!raw) return {};
  try { const obj = JSON.parse(raw); return (obj && typeof obj === 'object') ? obj : {}; } catch { return {}; }
}
async function writeHashbookFS(rootDir, obj) {
  // Write to data/ folder (matching server structure)
  const dataDir = await rootDir.getDirectoryHandle('data', { create: true });
  const fh = await dataDir.getFileHandle(HASHBOOK_FILE, { create: true });
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
      // Handle both server format ("/uploads/DATE/FILE") and storedPath format
      let sp = null;
      if (typeof im === 'string') {
        // Server URL format: "/uploads/DATE/FILE"
        if (im.startsWith('/uploads/')) {
          // Map /uploads/foo to uploads/foo for local FS lookup
          sp = im.substring(1);
        } else {
          sp = im;
        }
      } else if (im && typeof im === 'object' && im.storedPath) {
        // Old storedPath format
        sp = im.storedPath;
      }
      
      if (sp) {
        try { 
          const blobUrl = await urlFromStoredPath(dirHandle, sp); 
          imgs.push(blobUrl); 
          storedPaths.push(sp);
        }
        catch (err) { 
          // Silently skip missing images
          console.warn('Could not load local image:', sp, err);
          // If we can't load the blob, keep the original string so it's not lost on save
          // but we can't display it. 
          // However, if we save this, "images" will have the string, which is what we want for persistence anyway.
          // But in memory, "images" is used for <img> src.
        }
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
      // Include server metadata fields
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      deletedAt: rec.deletedAt,
      deletedBy: rec.deletedBy,
      permanentDeleteAt: rec.permanentDeleteAt
    };
    // Handle attachments - convert url or storedPath to blob URLs
    if (Array.isArray(rec.attachments)) {
      const attachments = [];
      for (const att of rec.attachments) {
        // Handle both server format (url field) and old format (storedPath field)
        let sp = att.storedPath;
        if (!sp && att.url) {
          // Convert server URL to storedPath
          if (att.url.startsWith('/uploads/')) {
             sp = att.url.substring(1);
          } else {
             sp = att.url;
          }
        }
        
        if (sp) {
          try {
            const blobUrl = await urlFromStoredPath(dirHandle, sp);
            attachments.push({
              name: att.name,
              url: blobUrl,
              storedPath: sp,
              type: att.type || 'application/octet-stream'
            });
          } catch (err) {
            // Keep original if file not found locally
            console.log(`⚠️ Attachment not found: ${sp}`);
            attachments.push(att);
          }
        } else {
            attachments.push(att);
        }
      }
      if (attachments.length > 0) {
        base.attachments = attachments;
      }
      console.log(`📎 Entry ${rec.id}: loaded ${attachments.length} attachments from ${rec.attachments.length} in JSON`);
    }
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

// NOTE: Folder selection has been moved to the Settings panel (memo-settings.js)
// The chooseDirBtn event listener is now handled there for better organization
// Original code preserved below for reference:
/*
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
*/

// =======================
// Capacitor Filesystem support (when in native app)
// =======================
const CapFS = (function(){
  let Filesystem = null;
  let Directory = null;
  function ready(){
    try {
      if (!window.Capacitor) return false;
      // Capacitor v5 style import surface
      Filesystem = window.Capacitor.Plugins?.Filesystem || window.Capacitor?.Filesystem || null;
      Directory = window.Capacitor?.Filesystem?.Directory || window.Capacitor?.Plugins?.Filesystem?.Directory || { Data: 'DATA' };
      return !!Filesystem && typeof Filesystem.readFile === 'function';
    } catch { return false; }
  }
  async function ensureDirs(folder){
    try {
      await Filesystem.mkdir({ path: folder, directory: Directory.Data, recursive: true });
    } catch (e) { /* exists */ }
  }
  function dataFilePath(){ return variantDataFileName(); }
  function chatFilePath(){ return chatDataFileName(); }
  const HASH_PATH = HASHBOOK_FILE;
  async function readJSON(path){
    try {
      const { data } = await Filesystem.readFile({ path, directory: Directory.Data, encoding: 'utf8' });
      return JSON.parse(data || 'null');
    } catch { return null; }
  }
  async function writeJSON(path, obj){
    const txt = JSON.stringify(obj, null, 2);
    await Filesystem.writeFile({ path, data: txt, directory: Directory.Data, encoding: 'utf8', recursive: true });
  }
  async function readEntries(){
    const data = await readJSON(dataFilePath());
    // Support both formats: direct array (server format) or {entries: []} wrapper
    if (Array.isArray(data)) {
      return { entries: data };
    }
    return data && data.entries ? data : { entries: [] };
  }
  async function writeEntries(data){
    // Write as direct array to match server format (not {entries: []})
    const entries = data && Array.isArray(data.entries) ? data.entries : [];
    await writeJSON(dataFilePath(), entries);
  }
  async function readHash(){ return (await readJSON(HASH_PATH)) || {}; }
  async function writeHash(obj){ await writeJSON(HASH_PATH, obj || {}); }
  async function fileExists(path){
    try { await Filesystem.stat({ path, directory: Directory.Data }); return true; } catch { return false; }
  }
  async function removeFile(path){
    try { await Filesystem.deleteFile({ path, directory: Directory.Data }); } catch {}
    // Attempt remove parent folder if empty is optional; skip for simplicity
  }
  async function writeBinary(path, data){
    // data: Blob or Uint8Array
    let base64;
    if (data instanceof Blob) {
      base64 = await blobToBase64(data);
    } else if (data instanceof Uint8Array) {
      base64 = btoa(String.fromCharCode(...data));
    } else if (data && data.buffer) {
      base64 = btoa(String.fromCharCode(...new Uint8Array(data.buffer)));
    } else {
      throw new Error('Unsupported data type for writeBinary');
    }
    await Filesystem.writeFile({ path, data: base64, directory: Directory.Data, encoding: 'base64', recursive: true });
  }
  async function blobToBase64(blob){
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const res = r.result;
        const b64 = String(res).split(',')[1] || '';
        resolve(b64);
      };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  async function urlFor(path){
    // In webview, we can load file through Filesystem.getUri (on Android) or use capacitor:// scheme
    try {
      if (typeof Filesystem.getUri === 'function') {
        const { uri } = await Filesystem.getUri({ directory: Directory.Data, path });
        return uri;
      }
    } catch {}
    // Fallback: read as base64
    try {
      const { data } = await Filesystem.readFile({ path, directory: Directory.Data, encoding: 'base64' });
      // Guess type by extension
      const ext = (path.split('.').pop() || 'png').toLowerCase();
      const mime = (/pdf$/.test(ext)) ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return `data:${mime};base64,${data}`;
    } catch { return '';
    }
  }
  return { ready, readEntries, writeEntries, readHash, writeHash, fileExists, removeFile, writeBinary, urlFor, Directory, readJSON, writeJSON };
})();

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
      const isImg = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(att.url);
      if (isImg) {
        if (!modalImages.some(mi => mi.src === att.url)) modalImages.push({ src: att.url, existing: true, storedPath: att.storedPath || null });
      } else {
        modalFilesExtra.push({ name: att.name || att.url.split('/').pop(), url: att.url, existing: true, storedPath: att.storedPath || null, type: att.type || 'application/octet-stream' });
      }
    });
  }
  if (els.images) els.images.value = '';
  rebuildDragGrid();
  renderExtraAttachmentsList();

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
  if (!description && modalImages.length === 0 && modalFilesExtra.length === 0) { alert('Please enter a description or add at least one file.'); return; }

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
    for (let i = 0; i < filesToSave.length; i++) {
      const f = filesToSave[i].file;
      const res = await ServerAPI.upload(f);
      if (res && res.url) imagesFinal.push(res.url);
    }
    for (let i = 0; i < extraToSave.length; i++) {
      const f = extraToSave[i].file;
      const res = await ServerAPI.upload(f);
      if (res && res.url) attachmentsFinal.push({ name: f.name, url: res.url, type: f.type || 'application/octet-stream' });
    }
    entry.images = imagesFinal;
    entry.attachments = attachmentsFinal.concat(
      modalFilesExtra.filter(f => f.existing && f.url).map(f => ({ name: f.name, url: f.url, type: f.type || 'application/octet-stream' }))
    );

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
  } else if (MODE === 'capacitor' && CapFS.ready()) {
    // Native app private storage
    entry.images = [];
    entry.attachments = [];
    const filesToWrite = [];
    const extraFilesToWrite = [];
    const keptStoredPaths = [];
    modalImages.forEach(mi => {
      entry.images.push(mi.src);
      if (mi.file) filesToWrite.push(mi); else if (mi.existing && mi.storedPath) keptStoredPaths.push(mi.storedPath);
    });
    modalFilesExtra.forEach(f => { if (f.file) extraFilesToWrite.push(f); else if (f.existing && f.storedPath) keptStoredPaths.push(f.storedPath); });

    const dateFolderName = todayFolder(entry.ts);
    const base = slug(description || 'memo');
    const book = await CapFS.readHash();

    const capHandleOne = async (fObj, idx, prefix) => {
      const f = fObj.file;
      const ext = (f.name.split('.').pop() || 'dat').toLowerCase();
      const hash = await computeSHA256(f);
      let usedStoredPath = null;
      const existing = (hash && book[hash] && book[hash].storedPath) ? book[hash].storedPath : null;
      if (existing && await CapFS.fileExists(existing)) {
        usedStoredPath = existing;
        book[hash].count = Math.max(1, parseInt(book[hash].count || 1, 10) + 1);
      } else {
        // Use HHMM_originalname.ext format to match server
        const d = new Date(entry.ts);
        const hhmm = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
        const baseName = f.name.replace(/\.[^.]+$/, ''); // Remove extension
        const newName = `${hhmm}_${baseName}.${ext}`;
        const relPath = `${dateFolderName}/${newName}`;
        await CapFS.writeBinary(relPath, await f.arrayBuffer());
        usedStoredPath = relPath;
        if (hash) book[hash] = { storedPath: usedStoredPath, count: 1 };
      }
      keptStoredPaths.push(usedStoredPath);
      if (!f.type?.startsWith('image/')) {
        entry.attachments.push({ name: f.name, url: usedStoredPath, storedPath: usedStoredPath, type: f.type || 'application/octet-stream' });
      }
    };
    for (let i = 0; i < filesToWrite.length; i++) await capHandleOne(filesToWrite[i], i, 'img');
    for (let i = 0; i < extraFilesToWrite.length; i++) await capHandleOne(extraFilesToWrite[i], i, 'file');
    // include existing non-image attachments that were not removed
    modalFilesExtra.filter(f => f.existing && !f.file).forEach(f => {
      entry.attachments.push({ name: f.name, url: f.url, storedPath: f.storedPath, type: f.type || 'application/octet-stream' });
    });
    // Persist hashbook
    await CapFS.writeHash(book);
    // Sync JSON record with exactly kept stored paths
    const existingEntry = db.entries.find(e => e.id === entry.id);
    const originalPaths = Array.isArray(existingEntry?._storedPaths) ? existingEntry._storedPaths : [];
    const removed = originalPaths.filter(sp => sp && !keptStoredPaths.includes(sp));
    for (const sp of removed) { try { await capDecrementAndMaybeDelete(sp); } catch (e) { console.warn('Cap remove failed', sp, e); } }
    await capReplaceMemoRecordImages(entry, keptStoredPaths, entry.attachments || []);
    entry._storedPaths = keptStoredPaths.slice();

    if (isNew) db.entries.push(entry);
    else {
      const i = db.entries.findIndex(e => e.id === entry.id);
      if (i >= 0) db.entries[i] = entry;
    }
    recomputeTags(); saveAll();
  } else {
    entry.images = [];
    entry.attachments = [];
    const filesToWrite = [];
    const keptStoredPaths = [];
    const extraFilesToWrite = [];
    modalImages.forEach(mi => {
      entry.images.push(mi.src);
      if (mi.file) filesToWrite.push(mi); else if (mi.existing && mi.storedPath) keptStoredPaths.push(mi.storedPath);
    });
    modalFilesExtra.forEach(f => { if (f.file) extraFilesToWrite.push(f); else if (f.existing && f.storedPath) keptStoredPaths.push(f.storedPath); });

    if (settings.fsEnabled && settings.memoDirHandle && (filesToWrite.length || extraFilesToWrite.length)) {
      const canWrite = await ensureWritePermission(settings.memoDirHandle);
      if (!canWrite) {
        alert('Cannot write to the chosen folder (permission denied). The entry will be saved in browser storage only.');
      }
      const dateFolderName = todayFolder(entry.ts);
      const dateDir = await getOrCreateDir(settings.memoDirHandle, dateFolderName);
      const base = slug(description || 'memo');

      // Load hashbook for de-duplication
      const book = await readHashbookFS(settings.memoDirHandle);

      const handleOne = async (fObj, idx, prefix) => {
        const f = fObj.file;
        const ext = (f.name.split('.').pop() || 'dat').toLowerCase();
        const hash = await computeSHA256(f);
        let usedStoredPath = null;
        if (canWrite && hash && book[hash] && book[hash].storedPath && await storedPathExists(settings.memoDirHandle, book[hash].storedPath)) {
          usedStoredPath = book[hash].storedPath;
          book[hash].count = Math.max(1, parseInt(book[hash].count || 1, 10) + 1);
        } else if (canWrite) {
          // Use HHMM_originalname.ext format to match server
          const d = new Date(entry.ts);
          const hhmm = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
          const baseName = f.name.replace(/\.[^.]+$/, ''); // Remove extension
          const newName = `${hhmm}_${baseName}.${ext}`;
          const fileHandle = await dateDir.getFileHandle(newName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(await f.arrayBuffer());
          await writable.close();
          usedStoredPath = `${dateFolderName}/${newName}`;
          if (hash) book[hash] = { storedPath: usedStoredPath, count: 1 };
        }
        if (canWrite) {
          await writeHashbookFS(settings.memoDirHandle, book);
          keptStoredPaths.push(usedStoredPath);
          if (!f.type?.startsWith('image/')) {
            entry.attachments.push({ name: f.name, url: usedStoredPath, storedPath: usedStoredPath, type: f.type || 'application/octet-stream' });
          }
        } else if (!f.type?.startsWith('image/')) {
          entry.attachments.push({ name: f.name, url: fObj.url, type: f.type || 'application/octet-stream' });
        }
      };
      for (let i = 0; i < filesToWrite.length; i++) await handleOne(filesToWrite[i], i, 'img');
      for (let i = 0; i < extraFilesToWrite.length; i++) await handleOne(extraFilesToWrite[i], i, 'file');
      // include existing non-image attachments that were not removed
      modalFilesExtra.filter(f => f.existing && !f.file).forEach(f => {
        entry.attachments.push({ name: f.name, url: f.url, storedPath: f.storedPath, type: f.type || 'application/octet-stream' });
      });
    }

    // Update FS JSON record to match exactly the kept/new stored paths
    if (settings.fsEnabled && settings.memoDirHandle) {
      const canWrite = await ensureWritePermission(settings.memoDirHandle);
      if (!canWrite) {
        // Skip FS JSON sync if we cannot write; rely on localStorage only
      } else {
      const originalPaths = Array.isArray((db.entries.find(e => e.id === entry.id)?._storedPaths)) ? (db.entries.find(e => e.id === entry.id)._storedPaths) : [];
      const removed = originalPaths.filter(sp => sp && !keptStoredPaths.includes(sp));
      // Decrement hashbook and delete files for removed paths
      for (const sp of removed) { try { await decrementAndMaybeDelete(settings.memoDirHandle, sp); } catch (e) { console.warn('Failed to cleanup removed image', sp, e); } }
      await replaceMemoRecordImages(settings.memoDirHandle, entry, keptStoredPaths, entry.attachments || []);
      entry._storedPaths = keptStoredPaths.slice();
      }
    }

    if (isNew) db.entries.push(entry);
    else {
      const i = db.entries.findIndex(e => e.id === entry.id);
      if (i >= 0) db.entries[i] = entry;
    }
    recomputeTags(); saveAll();
    
    // Add to operation queue for sync (for local/file mode)
    const operationQueue = getOperationQueue();
    if (operationQueue && MODE !== 'server') {
      console.log('📋 Adding operation to queue:', isNew ? 'create' : 'update', entry.id);
      const opData = {
        description: entry.description,
        category: entry.category,
        tags: entry.tags,
        ts: entry.ts,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      };
      
      // Add file references if they exist
      if (entry._storedPaths && entry._storedPaths.length > 0) {
        opData._filesToUpload = entry._storedPaths;
      }
      
      if (window.MEMO_VARIANT === 'finance') {
        opData.purchaseDate = entry.purchaseDate;
        opData.items = entry.items;
        opData.tax = entry.tax;
        opData.total = entry.total;
      }
      
      if (isNew) {
        await operationQueue.addOperation('create', entry.id, opData);
      } else {
        await operationQueue.addOperation('update', entry.id, opData);
      }
    }
  }

  if (els.entryDlg) els.entryDlg.close();
  recomputeTags(); saveAll();
  renderFeed();
}

async function onDeleteEntry() {
  const id = els.detailDlg?.dataset?.entryId; if (!id) return;
  if (!confirm('Move this entry to recycle bin?')) return;

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
}

// =======================
// Recycle Bin Functions
// =======================
function updateRecycleBinBadge() {
  if (!els.recycleBinBtn) return;
  const deletedCount = db.entries.filter(e => e.deletedAt !== null && e.deletedAt !== undefined).length;
  if (deletedCount > 0) {
    els.recycleBinBtn.innerHTML = `🗑️ Bin (${deletedCount})`;
  } else {
    els.recycleBinBtn.innerHTML = `🗑️ Bin`;
  }
}

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

async function permanentlyDeleteEntry(entryId) {
  const entry = db.entries.find(e => e.id === entryId);
  if (!entry) return;

  // Perform actual deletion (remove files and entry)
  if (MODE === 'server') {
    await ServerAPI.removePermanent(entryId);
  } else if (MODE === 'capacitor' && CapFS.ready()) {
    if (entry && Array.isArray(entry._storedPaths)) {
      for (const sp of entry._storedPaths) {
        try { await capDecrementAndMaybeDelete(sp); } catch (e) { console.warn('Cap delete failed', sp, e); }
      }
      await capRemoveMemoRecord(entryId);
    }
  } else {
    if (entry && settings.fsEnabled && settings.memoDirHandle && Array.isArray(entry._storedPaths)) {
      for (const sp of entry._storedPaths) {
        try { await decrementAndMaybeDelete(settings.memoDirHandle, sp); } catch (e) { console.warn('Failed to delete image', sp, e); }
      }
      await removeMemoRecord(settings.memoDirHandle, entryId);
    }
  }

  // Remove from entries array
  db.entries = db.entries.filter(e => e.id !== entryId);
  recomputeTags();
  saveAll();
  renderRecycleBin();
  updateRecycleBinBadge();
}

async function emptyRecycleBin() {
  const deleted = db.entries.filter(e => e.deletedAt !== null);
  
  if (deleted.length === 0) {
    alert('Recycle bin is already empty.');
    return;
  }

  if (!confirm(`Permanently delete all ${deleted.length} items in recycle bin? This cannot be undone!`)) {
    return;
  }
  
  // Delete each entry permanently
  for (const entry of deleted) {
    await permanentlyDeleteEntry(entry.id);
  }
  
  alert(`${deleted.length} items permanently deleted.`);
  renderRecycleBin();
}

function renderRecycleBin() {
  if (!els.recycleBinFeed) return;

  const deleted = db.entries
    .filter(e => e.deletedAt !== null && e.deletedAt !== undefined) // ← Only truly deleted entries
    .sort((a, b) => b.deletedAt - a.deletedAt);
  
  els.recycleBinFeed.innerHTML = '';
  
  if (deleted.length === 0) {
    els.recycleBinFeed.innerHTML = '<div class="muted" style="text-align:center;padding:40px 20px">Recycle bin is empty.</div>';
    return;
  }
  
  deleted.forEach(e => {
    const now = Date.now();
    const deletedAgo = Math.floor((now - e.deletedAt) / (24 * 60 * 60 * 1000));
    const daysLeft = Math.max(0, Math.floor((e.permanentDeleteAt - now) / (24 * 60 * 60 * 1000)));
    
    const card = document.createElement('div');
    card.className = 'card deleted';
    card.innerHTML = `
      <div class="muted">🗑️ ${e.category} • Deleted ${deletedAgo} day(s) ago</div>
      <div style="margin:8px 0"><strong>${(e.description || '(No description)').substring(0, 100)}${e.description && e.description.length > 100 ? '...' : ''}</strong></div>
      <div class="muted" style="color:#f59e0b">Auto-delete in: ${daysLeft} days</div>
      <div class="tagsline" style="margin-top:6px">${(e.tags || []).map(t => `<span class="tagpill">#${t}</span>`).join('')}</div>
      <div class="inline" style="margin-top:10px;gap:8px">
        <button class="primary restore-btn" data-id="${e.id}">Restore</button>
        <button class="danger delete-perm-btn" data-id="${e.id}">Delete Permanently</button>
      </div>
    `;
    
    card.querySelector('.restore-btn').addEventListener('click', () => {
      restoreEntry(e.id);
    });
    
    card.querySelector('.delete-perm-btn').addEventListener('click', () => {
      if (confirm('Permanently delete this entry? Cannot be undone!')) {
        permanentlyDeleteEntry(e.id);
      }
    });
    
    els.recycleBinFeed.appendChild(card);
  });
  
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
    await permanentlyDeleteEntry(entry.id);
  }
  
  console.log(`Auto-deleted ${toDelete.length} expired entries`);
}

// Recycle bin event listeners
if (els.recycleBinBtn) {
  els.recycleBinBtn.addEventListener('click', () => {
    renderRecycleBin();
    if (els.recycleBinDlg) els.recycleBinDlg.showModal();
  });
}
if (els.closeRecycleBin) {
  els.closeRecycleBin.addEventListener('click', () => {
    if (els.recycleBinDlg) els.recycleBinDlg.close();
  });
}
if (els.emptyRecycleBin) {
  els.emptyRecycleBin.addEventListener('click', emptyRecycleBin);
}

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
  renderFeed();
  if (els.fsStatus) els.fsStatus.textContent = settings.fsEnabled ? 'enabled' : 'disabled';

  // Clean up expired deleted entries (30+ days old)
  cleanupExpiredDeletes().catch(err => console.warn('cleanupExpiredDeletes failed:', err));
  updateRecycleBinBadge();

  // Set up daily cleanup
  setInterval(cleanupExpiredDeletes, 24 * 60 * 60 * 1000);

  await detectMode();

  if (MODE === 'server') {
    $$('[data-hide-when-server]').forEach(el => el.hidden = true);
    settings.fsEnabled = false;
    if (els.fsStatus) els.fsStatus.textContent = 'disabled';
    
    // Show sync status indicator ONLY if we have a remote server configured
    // Don't show it if we're accessing the server directly (API_BASE is empty)
    const hasRemoteServer = getApiBase() && getApiBase().trim() !== '';
    const syncStatusEl = document.getElementById('syncStatus');
    if (syncStatusEl && hasRemoteServer) {
      syncStatusEl.style.display = 'flex';
    }

    try {
      const memos = await Promise.race([
        ServerAPI.list(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('memos list timeout')), 5000))
      ]);
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
      
      // Initialize sync manager for server mode
      const syncManager = getSyncManager();
      if (syncManager && typeof syncManager.init === 'function') {
        await syncManager.init();
        // Perform initial sync after a brief delay
        if (typeof syncManager.performSync === 'function') {
          setTimeout(() => syncManager.performSync(), 1000);
        }
      }
    } catch (e) {
      console.error('Failed to load memos from server; falling back to local.', e);
      setMode('local');
      renderFeed();
    }
  } else {
    // Capacitor: load from app-private storage
    if (MODE === 'capacitor' && CapFS.ready()) {
      // Hide browser-only UI
      try {
        if (els.chooseDirBtn) els.chooseDirBtn.hidden = true;
        const hintEl = document.getElementById('fsHint') || document.querySelector('.toolbar .hint');
        if (hintEl) hintEl.hidden = true;
      } catch {}
      try {
        const data = await CapFS.readEntries();
        revokeAllObjectURLs();
        const entries = [];
        for (const rec of (data.entries || [])) {
          const imgs = [];
          const storedPaths = [];
          const fsImgs = Array.isArray(rec.images) ? rec.images : [];
          for (const im of fsImgs) {
            const sp = (im && typeof im === 'object') ? im.storedPath : (typeof im === 'string' ? im : null);
            if (sp) {
              try { const u = await CapFS.urlFor(sp); if (u) { imgs.push(u); storedPaths.push(sp); } } catch {}
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
          if (MEMO_VARIANT === 'finance') {
            base.purchaseDate = rec.purchaseDate || (rec.ts ? new Date(rec.ts).toISOString().slice(0,10) : '');
            base.price = rec.price || 0; base.tax = rec.tax || ''; base.adjustment = rec.adjustment || 0; base.total = rec.total || 0;
          }
          // Attachments (non-images)
          if (Array.isArray(rec.attachments)) {
            base.attachments = rec.attachments.map(a => ({ name: a.name, url: a.storedPath || a.url, storedPath: a.storedPath || a.url, type: a.type || 'application/octet-stream' }));
          }
          entries.push(base);
        }
        db.entries = entries;
        const cats = Array.from(new Set(entries.map(e => e.category))).sort();
        settings.categories = cats.length ? cats : ['Uncategorized'];
        settings.fsEnabled = true; // native always has private storage
        if (els.fsStatus) els.fsStatus.textContent = 'enabled';
        recomputeTags(); saveAll();
        refreshCategoryControls();
        renderFeed();
        // Initialize Chat in Cap mode
        initChatUI();
        return;
      } catch (e) { console.warn('Capacitor load failed, falling back to local:', e); }
    }
    try {
      const persisted = await idbGet(IDB_KEY_ROOT);
      if (persisted && await ensurePermission(persisted, 'read')) {
        await loadFromFolder(persisted);
        initChatUI(); // Initialize Chat before returning
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
  isImage: (u) => {
    // Accept blob URLs (created from local files)
    if ((u || '').startsWith('blob:')) return true;
    // Accept data URLs for images
    if ((u || '').startsWith('data:image/')) return true;
    // Check file extension
    return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(u || '');
  },
  saveAll: saveAll,
  renderFeed: () => window.MemoVariant && window.MemoVariant.renderFeed && window.MemoVariant.renderFeed(),
  // File System Access API helpers
  fsSupported: fsSupported,
  loadFromFolder: loadFromFolder,
  ensurePermission: ensurePermission,
  readEntriesFromFS: readEntriesFromFS,
  urlFromStoredPath: urlFromStoredPath,
  idbPut: idbPut,
  IDB_KEY_ROOT: IDB_KEY_ROOT,
  writeEntriesToFS: writeEntriesToFS
};

// ===== Helpers needed by local FS write path =====
async function getOrCreateDir(root, name) { return await root.getDirectoryHandle(name, { create: true }); }
async function updateMemoJson(rootDir, entry, imgInfo) {
  // Write to data/ folder (matching server structure)
  const dataDir = await rootDir.getDirectoryHandle('data', { create: true });
  const filename = variantDataFileName();
  let jsonHandle;
  try { 
    jsonHandle = await dataDir.getFileHandle(filename); 
  } catch {
    jsonHandle = await dataDir.getFileHandle(filename, { create: true });
    const w = await jsonHandle.createWritable(); 
    await w.write(JSON.stringify([], null, 2)); // Empty array in server format
    await w.close();
  }
  const file = await jsonHandle.getFile();
  let data = { entries: [] };
  try { 
    const parsed = JSON.parse(await file.text());
    // Handle both server format (array) and old format ({entries: []})
    if (Array.isArray(parsed)) {
      data = { entries: parsed };
    } else {
      data = parsed;
    }
  } catch { }
  
  let rec = data.entries.find(x => x.id === entry.id);
  if (!rec) {
    rec = { 
      id: entry.id, 
      description: entry.description, 
      category: entry.category, 
      tags: entry.tags || [], 
      ts: entry.ts, 
      createdAt: entry.createdAt || new Date(entry.ts).toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      deletedBy: null,
      permanentDeleteAt: null,
      images: [],
      attachments: []
    };
    if (MEMO_VARIANT === 'finance') {
      rec.purchaseDate = entry.purchaseDate; 
      rec.price = entry.price; 
      rec.tax = entry.tax; 
      rec.adjustment = entry.adjustment; 
      rec.total = entry.total;
    }
    data.entries.push(rec);
  } else {
    rec.description = entry.description; 
    rec.category = entry.category; 
    rec.tags = entry.tags || []; 
    rec.ts = entry.ts;
    rec.updatedAt = new Date().toISOString();
    if (MEMO_VARIANT === 'finance') {
      rec.purchaseDate = entry.purchaseDate; 
      rec.price = entry.price; 
      rec.tax = entry.tax; 
      rec.adjustment = entry.adjustment; 
      rec.total = entry.total;
    }
  }
  
  if (imgInfo?.storedPath) {
    const sp = imgInfo.storedPath;
    const serverUrl = `/uploads/${sp}`;
    // Check if this image already exists (compare server URLs)
    const exists = (rec.images || []).includes(serverUrl);
    if (!exists) {
      rec.images.push(serverUrl);
    }
  }
  
  // Write in server format (array, not object)
  const w = await jsonHandle.createWritable(); 
  await w.write(JSON.stringify(data.entries, null, 2)); 
  await w.close();
}

async function replaceMemoRecordImages(rootDir, entry, storedPaths, attachments) {
  // Write to data/ folder (matching server structure)
  const dataDir = await rootDir.getDirectoryHandle('data', { create: true });
  const name = variantDataFileName();
  const fh = await dataDir.getFileHandle(name, { create: true });
  const file = await fh.getFile();
  let data = { entries: [] };
  try { 
    const parsed = JSON.parse(await file.text());
    // Handle both server format (array) and old format ({entries: []})
    if (Array.isArray(parsed)) {
      data = { entries: parsed };
    } else {
      data = parsed;
    }
  } catch { }
  
  let rec = data.entries.find(x => x.id === entry.id);
  if (!rec) {
    rec = { 
      id: entry.id, 
      description: entry.description, 
      category: entry.category, 
      tags: entry.tags || [], 
      ts: entry.ts,
      createdAt: entry.createdAt || new Date(entry.ts).toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      deletedBy: null,
      permanentDeleteAt: null,
      images: [],
      attachments: []
    };
    if (MEMO_VARIANT === 'finance') { 
      rec.purchaseDate = entry.purchaseDate; 
      rec.price = entry.price; 
      rec.tax = entry.tax; 
      rec.adjustment = entry.adjustment; 
      rec.total = entry.total; 
    }
    data.entries.push(rec);
  } else {
    rec.description = entry.description; 
    rec.category = entry.category; 
    rec.tags = entry.tags || []; 
    rec.ts = entry.ts;
    rec.updatedAt = new Date().toISOString();
    if (MEMO_VARIANT === 'finance') { 
      rec.purchaseDate = entry.purchaseDate; 
      rec.price = entry.price; 
      rec.tax = entry.tax; 
      rec.adjustment = entry.adjustment; 
      rec.total = entry.total; 
    }
  }
  
  // Use server URL format for images
  rec.images = (storedPaths || []).filter(Boolean).map(sp => `/uploads/${sp}`);
  
  if (attachments && attachments.length) {
    rec.attachments = attachments.map(a => ({ 
      name: a.name, 
      url: a.storedPath ? `/uploads/${a.storedPath}` : a.url,
      type: a.type 
    }));
  } else {
    rec.attachments = [];
  }
  
  // Write in server format (array, not object)
  const w = await fh.createWritable(); 
  await w.write(JSON.stringify(data.entries, null, 2)); 
  await w.close();
}

// ===== Capacitor equivalents for JSON updates and cleanup =====
async function capUpdateMemoJson(entry, imgInfo) {
  if (!(MODE === 'capacitor' && CapFS.ready())) return;
  let data = await CapFS.readEntries();
  let rec = (data.entries || []).find(x => x.id === entry.id);
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
    if (!exists) { rec.images = rec.images || []; rec.images.push({ storedPath: sp, originalName: imgInfo.originalName }); }
  }
  await CapFS.writeEntries(data);
}

async function capReplaceMemoRecordImages(entry, storedPaths, attachments) {
  if (!(MODE === 'capacitor' && CapFS.ready())) return;
  let data = await CapFS.readEntries();
  let rec = (data.entries || []).find(x => x.id === entry.id);
  if (!rec) {
    rec = { id: entry.id, description: entry.description, category: entry.category, tags: entry.tags, ts: entry.ts, images: [] };
    if (MEMO_VARIANT === 'finance') { rec.purchaseDate = entry.purchaseDate; rec.price = entry.price; rec.tax = entry.tax; rec.adjustment = entry.adjustment; rec.total = entry.total; }
    data.entries.push(rec);
  } else {
    rec.description = entry.description; rec.category = entry.category; rec.tags = entry.tags; rec.ts = entry.ts;
    if (MEMO_VARIANT === 'finance') { rec.purchaseDate = entry.purchaseDate; rec.price = entry.price; rec.tax = entry.tax; rec.adjustment = entry.adjustment; rec.total = entry.total; }
  }
  rec.images = (storedPaths || []).filter(Boolean).map(sp => ({ storedPath: sp }));
  if (attachments && attachments.length) { rec.attachments = attachments.map(a => ({ name: a.name, storedPath: a.storedPath || a.url, type: a.type })); }
  await CapFS.writeEntries(data);
}

async function capRemoveMemoRecord(id) {
  if (!(MODE === 'capacitor' && CapFS.ready())) return;
  let data = await CapFS.readEntries();
  data.entries = (data.entries || []).filter(x => x.id !== id);
  await CapFS.writeEntries(data);
}

async function capDecrementAndMaybeDelete(storedPath) {
  if (!(MODE === 'capacitor' && CapFS.ready())) return;
  const book = await CapFS.readHash();
  const h = findHashByStoredPath(book, storedPath);
  if (!h) return;
  const rec = book[h];
  const cnt = Math.max(0, parseInt(rec.count || 0, 10) - 1);
  if (cnt === 0) { try { await CapFS.removeFile(storedPath); } catch {} delete book[h]; }
  else { rec.count = cnt; book[h] = rec; }
  await CapFS.writeHash(book);
}
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
  box.innerHTML = '<div class="muted" style="grid-column:1/-1">Other files</div>' + modalFilesExtra.map((f,i)=>{
    return `<div class="attach-row" data-idx="${i}" style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--border);padding:6px 10px;border-radius:10px;font-size:13px;">
      <span>📄</span>
      <a href="${f.url}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name}</a>
      <button class="ghost" data-act="remove" title="Remove">×</button>
    </div>`;
  }).join('');
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
  
  // Add file attachments if present
  if (msg.files && msg.files.length > 0) {
    const filesDiv = document.createElement('div');
    filesDiv.style.marginTop = '8px';
    filesDiv.style.display = 'flex';
    filesDiv.style.gap = '8px';
    filesDiv.style.flexWrap = 'wrap';
    
    msg.files.forEach(fileUrl => {
      const fileBtn = document.createElement('button');
      fileBtn.className = 'ghost';
      fileBtn.style.padding = '4px 8px';
      fileBtn.style.fontSize = '11px';
      
      const fileName = fileUrl.split('/').pop();
      const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(fileUrl);
      
      fileBtn.textContent = `${isImage ? '🖼️' : '📎'} ${fileName}`;
      fileBtn.onclick = () => {
        if (isImage) {
          // Open in lightbox if available
          if (window.openImagePreview) {
            window.openImagePreview(fileUrl);
          } else {
            window.open((getApiBase() || '') + fileUrl, '_blank');
          }
        } else {
          window.open((getApiBase() || '') + fileUrl, '_blank');
        }
      };
      
      filesDiv.appendChild(fileBtn);
    });
    
    bubble.appendChild(filesDiv);
  }
  
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
  console.log('💬 initChatUI called');
  if (!els.chatBtn) console.warn('💬 chatBtn not found in DOM');
  if (!els.chatDlg) console.warn('💬 chatDlg not found in DOM');
  if (!els.chatHistory) console.warn('💬 chatHistory not found in DOM');

  if (!els.chatBtn || !els.chatDlg || !els.chatHistory) return;

  // Setup file upload button for AI entry creation
  const chatAddFileBtn = document.getElementById('chatAddFileBtn');
  const chatFileInput = document.getElementById('chatFileInput');
  
  if (chatAddFileBtn && chatFileInput) {
    // Only show if server is connected
    const hasRemoteServer = MODE === 'server' || (getApiBase() && getApiBase().trim() !== '');
    chatAddFileBtn.style.display = hasRemoteServer ? 'flex' : 'none';
    
    chatAddFileBtn.addEventListener('click', () => {
      chatFileInput.click();
    });
    
    chatFileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      
      try {
        setChatDisabled(true, 'Creating entry from files...');
        const result = await ServerAPI.chatCreateEntry(files);
        
        // Render the new messages
        if (result.messages) {
          result.messages.forEach(msg => {
            els.chatHistory.appendChild(createChatMsgElement(msg));
          });
        }
        
        // Refresh feed to show new entry
        if (result.entry && window.MemoCore && window.MemoCore.getState) {
          const { db } = window.MemoCore.getState();
          db.entries.unshift(result.entry);
          if (window.MemoCore.renderFeed) window.MemoCore.renderFeed();
        }
        
        els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
        setChatDisabled(false);
      } catch (err) {
        console.error('Failed to create entry from files:', err);
        const errMsg = { role: 'assistant', content: `Failed to create entry: ${err.message}` };
        els.chatHistory.appendChild(createChatMsgElement(errMsg));
        setChatDisabled(false);
      }
      
      // Clear input
      e.target.value = '';
    });
  }

  async function openChat() {
    console.log('💬 openChat clicked');
    els.chatHistory.innerHTML = '<div class="muted" style="padding:10px;text-align:center">Loading chat...</div>';
    els.chatDlg.showModal();
    console.log('💬 chatDlg shown');
    
    // Use server chat if we have a remote server configured (MODE === 'server' OR API_BASE is set)
    const apiBase = getApiBase();
    const hasRemoteServer = MODE === 'server' || (apiBase && apiBase.trim() !== '');
    console.log(`💬 Chat mode: ${hasRemoteServer ? 'SERVER' : 'LOCAL'} (MODE=${MODE}, API_BASE=${getApiBase()})`);
    
    if (hasRemoteServer) {
      try {
        console.log('💬 Fetching server chat history...');
        const serverHistory = await ServerAPI.chatList();
        console.log(`💬 Server returned ${serverHistory ? serverHistory.length : 0} messages`);
        
        let finalHistory = serverHistory || [];

        // Sync/Merge server history to local storage
        if (settings.fsEnabled || (getMode() === 'capacitor')) {
          try {
             console.log('💬 Reading local chat for merge...');
             const localHistory = await LocalChat.list();
             if (localHistory && localHistory.length > 0) {
                 const map = new Map();
                 localHistory.forEach(m => { if(m && m.id) map.set(m.id, m); });
                 (serverHistory || []).forEach(m => { if(m && m.id) map.set(m.id, m); });
                 
                 finalHistory = Array.from(map.values()).sort((a, b) => {
                     const ta = a.ts || ''; 
                     const tb = b.ts || '';
                     if (ta < tb) return -1;
                     if (ta > tb) return 1;
                     return 0;
                 });
                 console.log(`💬 Merged Local(${localHistory.length}) + Server(${serverHistory ? serverHistory.length : 0}) -> ${finalHistory.length}`);
             }
             console.log('💬 Syncing merged chat to local storage');
             LocalChat.save(finalHistory).catch(err => console.warn('Failed to sync chat to local:', err));
          } catch (merr) {
             console.warn('💬 Chat merge warning:', merr);
             // Fallback to just saving server history if read fails
             LocalChat.save(finalHistory).catch(e=>e);
          }
        }
        
        renderChatHistory(finalHistory);
        setChatDisabled(false);
      } catch (e) {
        console.error('💬 Failed to load server chat:', e);
        // Fallback: load local history if server fails
        try {
           console.log('💬 Attempting fallback to local history');
           const local = await LocalChat.list();
           if (local && local.length) {
              console.log(`💬 Local fallback has ${local.length} messages`);
              renderChatHistory(local);
              setChatDisabled(true, 'Server unreachable. Showing local history (read-only).');
           } else {
              console.log('💬 Local fallback empty');
              renderChatHistory([]);
              setChatDisabled(true, 'Unable to load chat history. Server might be unreachable.');
           }
        } catch(ex) {
           console.error('💬 Local fallback failed:', ex);
           renderChatHistory([]);
           setChatDisabled(true, 'Unable to load chat history.');
        }
      }
    } else {
      try {
        console.log('💬 Fetching local chat history...');
        const history = await LocalChat.list();
        console.log(`💬 Local returned ${history ? history.length : 0} messages`);
        renderChatHistory(history);
        setChatDisabled(false);
      } catch (e) {
        console.error('💬 Failed to load local chat:', e);
        renderChatHistory([]);
        setChatDisabled(true, 'Chat unavailable.');
      }
    }
    
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
    
    // Use server chat if we have a remote server configured (MODE === 'server' OR API_BASE is set)
    const hasRemoteServer = MODE === 'server' || (getApiBase() && getApiBase().trim() !== '');
    
    try {
      if (hasRemoteServer) {
        const res = await ServerAPI.chatSend(text);
        const msgs = res && res.messages ? res.messages : [];
        const assistant = msgs.find(m => m.role === 'assistant');
        if (assistant) els.chatHistory.appendChild(createChatMsgElement(assistant));
        
        // Sync new state to local storage with MERGE logic
        ServerAPI.chatList().then(async serverHistory => {
             try {
                const localHistory = await LocalChat.list();
                const map = new Map();
                (localHistory || []).forEach(m => { if(m && m.id) map.set(m.id, m); });
                (serverHistory || []).forEach(m => { if(m && m.id) map.set(m.id, m); });
                 
                const merged = Array.from(map.values()).sort((a, b) => {
                     const ta = a.ts || ''; const tb = b.ts || '';
                     if (ta < tb) return -1;
                     if (ta > tb) return 1;
                     return 0;
                });
                await LocalChat.save(merged);
             } catch (e) {
                console.warn('Background chat merge failed', e);
                if (serverHistory) LocalChat.save(serverHistory).catch(e=>e);
             }
        }).catch(e => console.warn('Background chat sync failed', e));

      } else {
        const { messages } = await LocalChat.send(text);
        const assistant = messages.find(m => m.role === 'assistant');
        if (assistant) els.chatHistory.appendChild(createChatMsgElement(assistant));
      }
      els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
    } catch (e) {
      console.error('Failed to send chat message:', e);
      const errMsg = { role: 'assistant', content: 'Failed to send. Please try again.' };
      els.chatHistory.appendChild(createChatMsgElement(errMsg));
    } finally {
      els.chatInput.disabled = false; els.chatSendBtn.disabled = false;
      els.chatInput.focus();
    }
  }

  async function doClear() {
    // Use server chat if we have a remote server configured (MODE === 'server' OR API_BASE is set)
    const hasRemoteServer = MODE === 'server' || (getApiBase() && getApiBase().trim() !== '');
    
    try {
      if (hasRemoteServer) {
        await ServerAPI.chatClear(); 
        // Also clear local copy
        await LocalChat.clear();
      } else {
        await LocalChat.clear();
      }
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
    if (MODE === 'capacitor' && CapFS.ready()) {
      const raw = await (async () => {
        try { const data = await CapFS.readEntries(); /* ensure file space exists */ } catch {}
        try { const j = await CapFS.readJSON ? CapFS.readJSON(chatDataFileName()) : null; return j; } catch { return null; }
      })();
      return Array.isArray(raw) ? raw : [];
    }
    if (settings.fsEnabled && settings.memoDirHandle) {
      const raw = await readTextFileIfExists(settings.memoDirHandle, chatDataFileName());
      if (!raw) {
        // Create empty chat file to ensure persistence exists
        const canWrite = await ensureWritePermission(settings.memoDirHandle);
        if (canWrite) {
          const fh = await settings.memoDirHandle.getFileHandle(chatDataFileName(), { create: true });
          const w = await fh.createWritable(); await w.write(JSON.stringify([], null, 2)); await w.close();
        }
        return [];
      }
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
    if (MODE === 'capacitor' && CapFS.ready()) {
      // Store chat as JSON array
      try {
        await (async () => {
          const txt = JSON.stringify(msgs, null, 2);
          await (window.Capacitor.Plugins?.Filesystem || window.Capacitor.Filesystem).writeFile({ path: chatDataFileName(), data: txt, directory: CapFS.Directory.Data, encoding: 'utf8', recursive: true });
        })();
      } catch {}
      return { messages: [user, bot] };
    }
    if (settings.fsEnabled && settings.memoDirHandle) {
      const canWrite = await ensureWritePermission(settings.memoDirHandle);
      if (canWrite) {
        const fh = await settings.memoDirHandle.getFileHandle(chatDataFileName(), { create: true });
        const w = await fh.createWritable(); await w.write(JSON.stringify(msgs, null, 2)); await w.close();
      } else {
        // As a fallback, store in localStorage if permission denied
        localStorage.setItem(CHAT_KEY, JSON.stringify(msgs));
      }
    } else {
      localStorage.setItem(CHAT_KEY, JSON.stringify(msgs));
    }
    return { messages: [user, bot] };
  },
  async save(messages) {
    if (MODE === 'capacitor' && CapFS.ready()) {
      try {
        await (window.Capacitor.Plugins?.Filesystem || window.Capacitor.Filesystem).writeFile({
          path: chatDataFileName(),
          data: JSON.stringify(messages, null, 2),
          directory: CapFS.Directory.Data,
          encoding: 'utf8',
          recursive: true
        });
      } catch (e) { console.warn('Capacitor chat save failed', e); }
      return;
    }
    if (settings.fsEnabled && settings.memoDirHandle) {
      const canWrite = await ensureWritePermission(settings.memoDirHandle);
      if (canWrite) {
        const fh = await settings.memoDirHandle.getFileHandle(chatDataFileName(), { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(messages, null, 2));
        await w.close();
      } else {
        localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
      }
    } else {
      localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
    }
  },
  async clear() {
    if (MODE === 'capacitor' && CapFS.ready()) {
      try {
        await (window.Capacitor.Plugins?.Filesystem || window.Capacitor.Filesystem).writeFile({ path: chatDataFileName(), data: JSON.stringify([], null, 2), directory: CapFS.Directory.Data, encoding: 'utf8', recursive: true });
      } catch {}
      return [];
    }
    if (settings.fsEnabled && settings.memoDirHandle) {
      const canWrite = await ensureWritePermission(settings.memoDirHandle);
      if (canWrite) {
        const fh = await settings.memoDirHandle.getFileHandle(chatDataFileName(), { create: true });
        const w = await fh.createWritable(); await w.write(JSON.stringify([], null, 2)); await w.close();
      } else {
        localStorage.setItem(CHAT_KEY, JSON.stringify([]));
      }
    } else {
      localStorage.setItem(CHAT_KEY, JSON.stringify([]));
    }
    return [];
  },
  // Explicitly save messages to local storage/FS (e.g. sync from server)
  async save(messages) {
    if (!messages || !Array.isArray(messages)) return;
    
    if (MODE === 'capacitor' && CapFS.ready()) {
      try {
        const txt = JSON.stringify(messages, null, 2);
        await (window.Capacitor.Plugins?.Filesystem || window.Capacitor.Filesystem).writeFile({ path: chatDataFileName(), data: txt, directory: CapFS.Directory.Data, encoding: 'utf8', recursive: true });
      } catch (e) { console.warn('LocalChat save failed (Capacitor)', e); }
      return;
    }
    
    if (settings.fsEnabled && settings.memoDirHandle) {
      try {
        const canWrite = await ensureWritePermission(settings.memoDirHandle);
        if (canWrite) {
          const fh = await settings.memoDirHandle.getFileHandle(chatDataFileName(), { create: true });
          const w = await fh.createWritable(); 
          await w.write(JSON.stringify(messages, null, 2)); 
          await w.close();
        } else {
          localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
        }
      } catch (e) { console.warn('LocalChat save failed (FS)', e); }
    } else {
      try { localStorage.setItem(CHAT_KEY, JSON.stringify(messages)); } catch(e) {}
    }
  }
};
