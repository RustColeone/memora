/** =======================
         * Data model
         * =======================
         */
const DB_KEY = 'memo_db_v1';
const SETTINGS_KEY = 'memo_settings_v1';

let db = ({ entries: [] });
let settings = ({ categories: ['Uncategorized'], tags: [], tagCounts: {}, fsEnabled: false, memoDirHandle: undefined });

const els = {
    feed: document.getElementById('feed'),
    fab: document.getElementById('fab'),
    entryDlg: document.getElementById('entryDlg'),
    detailDlg: document.getElementById('detailDlg'),
    dlgTitle: document.getElementById('dlgTitle'),
    desc: document.getElementById('desc'),
    images: document.getElementById('images'),
    categoryInput: document.getElementById('categoryInput'),
    newCategory: document.getElementById('newCategory'),
    addCategoryBtn: document.getElementById('addCategoryBtn'),
    tagInput: document.getElementById('tagInput'),
    tagDropdown: document.getElementById('tagDropdown'),
    tagChips: document.getElementById('tagChips'),
    cancelBtn: document.getElementById('cancelBtn'),
    saveBtn: document.getElementById('saveBtn'),
    categoryFilter: document.getElementById('categoryFilter'),
    searchBox: document.getElementById('searchBox'),
    filtersBtn: document.getElementById('filtersBtn'),
    chooseDirBtn: document.getElementById('chooseDirBtn'),
    fsStatus: document.getElementById('fsStatus'),
    detailContent: document.getElementById('detailContent'),
    deleteBtn: document.getElementById('deleteBtn'),
    editBtn: document.getElementById('editBtn'),
    closeDetailBtn: document.getElementById('closeDetailBtn'),
    dragGrid: document.getElementById('dragGrid'),
    filtersDlg: document.getElementById('filtersDlg'),
    dateFrom: document.getElementById('dateFrom'),
    dateTo: document.getElementById('dateTo'),
    quickThisMonth: document.getElementById('quickThisMonth'),
    quickClearDates: document.getElementById('quickClearDates'),
    filterCats: document.getElementById('filterCats'),
    filterTagSearch: document.getElementById('filterTagSearch'),
    filterTags: document.getElementById('filterTags'),
    filtersReset: document.getElementById('filtersReset'),
    filtersCancel: document.getElementById('filtersCancel'),
    filtersApply: document.getElementById('filtersApply'),
    manageTagsLink: document.getElementById('manageTagsLink'),
    tagManager: document.getElementById('tagManager'),
    tagMgrList: document.getElementById('tagMgrList'),
    tagMgrUndo: document.getElementById('tagMgrUndo'),
    tagMgrClose: document.getElementById('tagMgrClose'),
    lightbox: document.getElementById('lightbox'),
    lbImg: document.getElementById('lbImg'),
    lbPrev: document.getElementById('lbPrev'),
    lbNext: document.getElementById('lbNext'),
    lbClose: document.getElementById('lbClose'),
    lbCounter: document.getElementById('lbCounter'),
    calendarDlg: document.getElementById('calendarDlg'),
    calendarBtn: document.getElementById('calendarBtn'),
    calPrev: document.getElementById('calPrev'),
    calNext: document.getElementById('calNext'),
    calHeading: document.getElementById('calHeading'),
    calView: document.getElementById('calView'),
    calGrid: document.getElementById('calGrid'),
    calApply: document.getElementById('calApply'),
    calCancel: document.getElementById('calCancel'),
    calUp: document.getElementById('calUp'),
    calPickDay: document.getElementById('calPickDay'),
    calLegend: document.getElementById('calLegend'),
    calDrill: document.getElementById('calDrill'),
    calClearSel: document.getElementById('calClearSel'),
};

let workingTags = new Set();
let editingId = null;
let modalImages = []; // [{src, file?, existing}]
let dragSrcIdx = null;

let activeFilters = { dateFrom: null, dateTo: null, cats: new Set(), tags: new Set() };

/* ---------- storage ---------- */
function loadAll() {
    try { const raw = localStorage.getItem(DB_KEY); if (raw) db = JSON.parse(raw); } catch (e) { db = { entries: [] }; }
    try { const raw = localStorage.getItem(SETTINGS_KEY); if (raw) settings = JSON.parse(raw); } catch (e) { }
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
        req.onupgradeneeded = () => {
            req.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function idbPut(key, val) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
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
// Revoke old blob: URLs to avoid leaks (optional, but good hygiene)
let urlBucket = [];
function revokeAllObjectURLs() {
    for (const u of urlBucket) { URL.revokeObjectURL(u); }
    urlBucket = [];
}
// Resolve "2025-08-15/2025-08-15_post_01.jpg" -> blob URL via File System Access API
async function urlFromStoredPath(rootDir, storedPath) {
    const parts = (storedPath || '').split('/').filter(Boolean);
    if (!parts.length) throw new Error('Bad storedPath');
    let dir = rootDir;
    for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i]);
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await fh.getFile();
    const url = URL.createObjectURL(file);
    urlBucket.push(url);
    return url;
}
// Read memo.json from the chosen folder; return a normalized object
async function readMemoJson(rootDir) {
    try {
        const fileHandle = await rootDir.getFileHandle('memo.json');
        const file = await fileHandle.getFile();
        return JSON.parse(await file.text());
    } catch (e) {
        // If not found or unreadable, start fresh
        return { entries: [] };
    }
}
// Hydrate in-memory DB + UI from disk
async function loadFromFolder(dirHandle) {
    const ok = await ensurePermission(dirHandle, 'read');
    if (!ok) { alert('Permission to read the chosen folder was denied.'); return; }

    settings.memoDirHandle = dirHandle;
    settings.fsEnabled = true;
    els.fsStatus.textContent = 'enabled';
    saveAll(); // note: we strip the handle out of localStorage in saveAll()

    const data = await readMemoJson(dirHandle);

    // Build db.entries using real file URLs
    revokeAllObjectURLs();
    const entries = [];
    for (const rec of (data.entries || [])) {
        const imgs = [];
        for (const im of (rec.images || [])) {
            if (im?.storedPath) {
                try { imgs.push(await urlFromStoredPath(dirHandle, im.storedPath)); }
                catch (err) { console.warn('Missing image on disk:', im?.storedPath); }
            }
        }
        entries.push({
            id: rec.id,
            description: rec.description || '',
            category: rec.category || 'Uncategorized',
            tags: rec.tags || [],
            ts: rec.ts || Date.now(),
            images: imgs,
        });
    }
    db.entries = entries;

    // Rebuild categories from disk data (fallback to Uncategorized)
    const cats = Array.from(new Set(entries.map(e => e.category))).sort();
    settings.categories = cats.length ? cats : ['Uncategorized'];

    // Refresh tags & UI
    recomputeTags();
    saveAll();
    refreshCategoryControls();
    renderFeed();
}

/* ---------- utils ---------- */
function uid() { return 'e_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function fmtDate(ts) { const d = new Date(ts); return d.toLocaleString(); }
function slug(s) { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function todayFolder(ts) { const d = new Date(ts); const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const dd = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${dd}`; }

/* ---------- UI init ---------- */
function refreshCategoryControls() {
    const { categories } = settings;
    els.categoryFilter.innerHTML = `<option value="__ALL__">All categories</option>` + categories.map(c => `<option value="${c}">${c}</option>`).join('');
    els.categoryInput.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join('');
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

/* Category Add: click or Enter */
function addCategory() {
    const c = els.newCategory.value.trim();
    if (!c) return;
    if (!settings.categories.includes(c)) settings.categories.push(c);
    els.newCategory.value = '';
    saveAll(); refreshCategoryControls();
    els.categoryInput.value = c;
}
els.addCategoryBtn.addEventListener('click', addCategory);
els.newCategory.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } });

function refreshFilterTagsList() {
    const q = els.filterTagSearch.value.toLowerCase().trim();
    const list = settings.tags.filter(t => t.toLowerCase().includes(q));
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
function renderTagChips() {
    els.tagChips.innerHTML = '';
    for (const t of workingTags) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.innerHTML = `${t} <button title="Remove tag">×</button>`;
        c.querySelector('button').addEventListener('click', () => { workingTags.delete(t); renderTagChips(); });
        els.tagChips.appendChild(c);
    }
}

/* ---------- feed (4 thumbs, +N only when >4) ---------- */
function renderFeed() {
    const q = els.searchBox.value.toLowerCase().trim();
    const cat = els.categoryFilter.value;
    const df = activeFilters.dateFrom ? new Date(activeFilters.dateFrom).getTime() : null;
    const dt = activeFilters.dateTo ? (new Date(activeFilters.dateTo).getTime() + 24 * 3600 * 1000 - 1) : null;

    const filtered = db.entries
        .filter(e => (cat === '__ALL__' ? true : e.category === cat))
        .filter(e => activeFilters.cats.size ? activeFilters.cats.has(e.category) : true)
        .filter(e => {
            if (df && e.ts < df) return false;
            if (dt && e.ts > dt) return false;
            if (activeFilters.tags.size && !e.tags?.some(t => activeFilters.tags.has(t))) return false;
            if (!q) return true;
            const inDesc = e.description.toLowerCase().includes(q);
            const inTags = (e.tags || []).some(t => t.toLowerCase().includes(q));
            return inDesc || inTags;
        })
        .sort((a, b) => b.ts - a.ts);

    els.feed.innerHTML = '';
    for (const e of filtered) {
        const card = document.createElement('div');
        card.className = 'card';

        const count = e.images?.length || 0;
        const thumbs = [];
        if (count <= 4) {
            for (let i = 0; i < count; i++) {
                thumbs.push(`<span class="twrap"><img data-eid="${e.id}" data-idx="${i}" src="${e.images[i]}" alt=""></span>`);
            }
        } else {
            // show first 3, then "+N" where N = count-3 (>=2)
            for (let i = 0; i < 3; i++) {
                thumbs.push(`<span class="twrap"><img data-eid="${e.id}" data-idx="${i}" src="${e.images[i]}" alt=""></span>`);
            }
            const extra = count - 3;
            thumbs.push(`<div class="more" data-eid="${e.id}" data-idx="3">+${extra}</div>`);
        }

        card.innerHTML = `
                    <div class="muted">${fmtDate(e.ts)} • ${e.category}</div>
                    <div title="${e.description}">${e.description.length > 120 ? e.description.slice(0, 120) + '…' : e.description}</div>
                    <div class="thumbs">${(count ? thumbs.join('') : '<span class="muted">No images</span>')}</div>
                    <div class="tagsline">${(e.tags || []).map(t => `<span class="tagpill">#${t}</span>`).join('')}</div>
                    <div class="inline"><button class="ghost">Open</button></div>
                `;
        card.querySelector('button').addEventListener('click', () => openDetail(e.id));
        card.querySelectorAll('.thumbs img').forEach(img => {
            img.addEventListener('click', () => openLightbox(e.id, parseInt(img.dataset.idx, 10)));
        });
        const more = card.querySelector('.thumbs .more');
        if (more) { more.addEventListener('click', () => openLightbox(e.id, parseInt(more.dataset.idx, 10))); }
        els.feed.appendChild(card);
    }

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'muted';
        empty.textContent = 'No entries. Click the + button to add one, or adjust filters.';
        els.feed.appendChild(empty);
    }
    // After render feed change filter indicator
    updateFilterIndicator();
}

/* ---------- modal: create/edit ---------- */
function openEntryModal(entry = null) {
    editingId = entry ? entry.id : null;
    els.dlgTitle.textContent = entry ? 'Edit Entry' : 'New Entry';
    els.desc.value = entry ? entry.description : '';
    workingTags = new Set(entry ? (entry.tags || []) : []);
    renderTagChips();

    refreshCategoryControls();
    if (entry) { ensureCategory(entry.category); els.categoryInput.value = entry.category; }
    else { els.categoryInput.value = settings.categories[0] || 'Uncategorized'; }

    modalImages = [];
    if (entry?.images?.length) { entry.images.forEach(src => modalImages.push({ src, existing: true })); }
    els.images.value = '';
    rebuildDragGrid();

    els.entryDlg.showModal();
}
function ensureCategory(c) {
    if (!settings.categories.includes(c)) {
        settings.categories.push(c);
        saveAll(); refreshCategoryControls();
    }
}

/* tag dropdown */
let dropActiveIndex = -1;
function openTagDropdown(items, createText) {
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
function closeTagDropdown() { els.tagDropdown.classList.add('hidden'); dropActiveIndex = -1; }
function updateDropActive() {
    const items = [...els.tagDropdown.querySelectorAll('.dropitem')];
    items.forEach((el, i) => el.classList.toggle('active', i === dropActiveIndex));
}
function selectDropItem(el) {
    if (el.dataset.create === '1') { addTag(els.tagInput.value); }
    else { addTag(el.querySelector('span').textContent); }
    els.tagInput.value = ''; closeTagDropdown(); els.tagInput.focus();
}
function addTag(t) {
    const val = (t || '').trim();
    if (!val) return;
    workingTags.add(val);
    renderTagChips();
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
    } else if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const len = els.tagDropdown.querySelectorAll('.dropitem').length;
        dropActiveIndex = (dropActiveIndex + (e.key === 'ArrowDown' ? 1 : -1) + len) % len;
        updateDropActive();
    } else if (e.key === 'Escape') { closeTagDropdown(); }
});
document.addEventListener('click', (e) => { if (!els.tagDropdown.contains(e.target) && e.target !== els.tagInput) closeTagDropdown(); });

/* drag grid */
function rebuildDragGrid() {
    els.dragGrid.innerHTML = '';
    modalImages.forEach((it, idx) => {
        const d = document.createElement('div');
        d.className = 'dragitem';
        d.draggable = true;
        d.innerHTML = `<span class="handle" title="Drag to reorder">⋮⋮ ${idx + 1}</span><img src="${it.src}" alt="">`;
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
els.images.addEventListener('change', async () => {
    for (const f of els.images.files) {
        const url = URL.createObjectURL(f);
        modalImages.push({ src: url, file: f, existing: false });
    }
    rebuildDragGrid();
});

/* cancel/save */
els.cancelBtn.addEventListener('click', () => els.entryDlg.close());
els.saveBtn.addEventListener('click', async () => {
    const description = els.desc.value.trim();
    const category = els.categoryInput.value || 'Uncategorized';
    const ts = Date.now();
    const tags = [...workingTags];
    if (!description && modalImages.length === 0) { alert('Please enter a description or add at least one image.'); return; }

    let entry = editingId ? db.entries.find(e => e.id === editingId) : { id: uid(), images: [] };
    const isNew = !editingId;
    entry.description = description;
    entry.category = category;
    entry.tags = tags;
    entry.ts = isNew ? ts : entry.ts;

    entry.images = [];
    const filesToSave = [];
    modalImages.forEach(mi => { entry.images.push(mi.src); if (mi.file) filesToSave.push(mi); });

    if (settings.fsEnabled && settings.memoDirHandle && filesToSave.length) {
        const dateFolderName = todayFolder(entry.ts);
        const dateDir = await getOrCreateDir(settings.memoDirHandle, dateFolderName);
        const base = slug(description || 'memo');
        for (let i = 0; i < filesToSave.length; i++) {
            const f = filesToSave[i].file;
            const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
            const newName = `${dateFolderName}_${base || 'post'}_${String(i + 1).padStart(2, '0')}.${ext}`;
            const fileHandle = await dateDir.getFileHandle(newName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(await f.arrayBuffer());
            await writable.close();
            await updateMemoJson(settings.memoDirHandle, entry, { storedPath: `${dateFolderName}/${newName}`, originalName: f.name });
        }
    }

    if (isNew) db.entries.push(entry);
    recomputeTags(); saveAll();
    els.entryDlg.close();
    renderFeed();
});

/* FS helpers */
function fsSupported() { return 'showDirectoryPicker' in window; }
els.chooseDirBtn.addEventListener('click', async () => {
    if (!fsSupported()) { alert('Use Chrome/Edge desktop for File System Access API.'); return; }
    try {
        const dir = await window.showDirectoryPicker({ id: 'memo_root' });
        settings.memoDirHandle = dir;
        settings.fsEnabled = true;
        els.fsStatus.textContent = 'enabled';
        await idbPut(IDB_KEY_ROOT, settings.memoDirHandle); // persist across reloads
        await loadFromFolder(settings.memoDirHandle); // hydrate immediately from disk
        saveAll();
    } catch (e) { console.warn(e); }
});
async function getOrCreateDir(root, name) { return await root.getDirectoryHandle(name, { create: true }); }
async function updateMemoJson(rootDir, entry, imgInfo) {
    const filename = 'memo.json';
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
        data.entries.push(rec);
    } else {
        rec.description = entry.description; rec.category = entry.category; rec.tags = entry.tags; rec.ts = entry.ts;
    }
    if (imgInfo?.storedPath) rec.images.push({ storedPath: imgInfo.storedPath, originalName: imgInfo.originalName });
    const w = await jsonHandle.createWritable(); await w.write(JSON.stringify(data, null, 2)); await w.close();
}

/* ---------- detail (+ reorder) ---------- */
function openDetail(id) {
    const e = db.entries.find(x => x.id === id);
    if (!e) return;
    const imgs = (e.images || []).map((src, i) => `<img data-eid="${e.id}" data-idx="${i}" src="${src}" alt="">`).join('');
    els.detailContent.innerHTML = `
                <div class="muted">${fmtDate(e.ts)} • ${e.category}</div>
                <h3>${e.description ? e.description.replace(/</g, '&lt;') : '(No description)'}</h3>
                <div class="tagsline">${(e.tags || []).map(t => `<span class="tagpill">#${t}</span>`).join('')}</div>
                <div class="thumbs" id="detailThumbs" style="margin-top:10px">${imgs || '<span class="muted">No images</span>'}</div>
                <div class="muted">Tip: Click to view. Drag to reorder (saves on drop).</div>
            `;
    const cont = els.detailContent.querySelector('#detailThumbs');
    let startIdx = null;
    cont.querySelectorAll('img').forEach((im, idx) => {
        im.draggable = true;
        im.addEventListener('dragstart', () => { startIdx = idx; im.style.opacity = .5; });
        im.addEventListener('dragend', () => { im.style.opacity = 1; startIdx = null; });
        im.addEventListener('dragover', (ev) => ev.preventDefault());
        im.addEventListener('drop', (ev) => {
            ev.preventDefault();
            const dst = idx; if (startIdx === null || startIdx === dst) return;
            const arr = e.images.slice(); const item = arr.splice(startIdx, 1)[0]; arr.splice(dst, 0, item);
            e.images = arr; saveAll(); openDetail(e.id);
        });
        im.addEventListener('click', () => openLightbox(e.id, idx));
    });
    els.detailDlg.dataset.entryId = id;
    els.detailDlg.showModal();
}
els.closeDetailBtn.addEventListener('click', () => els.detailDlg.close());
els.deleteBtn.addEventListener('click', () => {
    const id = els.detailDlg.dataset.entryId; if (!id) return;
    if (!confirm('Delete this entry?')) return;
    db.entries = db.entries.filter(e => e.id !== id);
    recomputeTags(); saveAll(); els.detailDlg.close(); renderFeed();
});
els.editBtn.addEventListener('click', () => {
    const id = els.detailDlg.dataset.entryId; if (!id) return;
    const e = db.entries.find(x => x.id === id);
    els.detailDlg.close(); openEntryModal(e);
});




/* Tag Manager (inline, undo) */
let tagUndoStack = [];
function snapshotEntries() { return JSON.parse(JSON.stringify(db.entries)); }
function pushUndo() { tagUndoStack.push({ entriesSnapshot: snapshotEntries() }); els.tagMgrUndo.disabled = false; }
function doUndo() {
    const last = tagUndoStack.pop();
    if (!last) return;
    db.entries = last.entriesSnapshot;
    recomputeTags(); saveAll(); refreshFilterTagsList(); buildTagManager(); renderFeed();
    if (tagUndoStack.length === 0) els.tagMgrUndo.disabled = true;
}
els.tagMgrUndo.addEventListener('click', doUndo);

els.manageTagsLink.addEventListener('click', () => {
    els.tagManager.classList.toggle('hidden');
});
els.tagMgrClose.addEventListener('click', () => els.tagManager.classList.add('hidden'));

function buildTagManager() {
    const list = settings.tags;
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
        row.querySelector('[data-act=save]').addEventListener('click', () => {
            const from = input.dataset.old;
            const to = input.value.trim();
            if (!to || to === from) return;
            pushUndo();
            for (const e of db.entries) { if (e.tags) { e.tags = e.tags.map(x => x === from ? to : x); } }
            recomputeTags(); saveAll(); refreshFilterTagsList(); buildTagManager(); renderFeed();
        });
        row.querySelector('[data-act=delete]').addEventListener('click', () => {
            if (!confirm(`Remove tag “${t}” from all posts?`)) return;
            pushUndo();
            for (const e of db.entries) { if (e.tags) { e.tags = e.tags.filter(x => x !== t); } }
            recomputeTags(); saveAll(); refreshFilterTagsList(); buildTagManager(); renderFeed();
        });
        els.tagMgrList.appendChild(row);
    });
}





/* ---------- FAB & init ---------- */
els.fab.addEventListener('click', () => openEntryModal());

(async function init() {
    loadAll();
    refreshCategoryControls();
    els.fsStatus.textContent = settings.fsEnabled ? 'enabled' : 'disabled';

    // If we previously chose a folder, try to restore it and hydrate first.
    try {
        const persisted = await idbGet(IDB_KEY_ROOT);
        if (persisted && await ensurePermission(persisted, 'read')) {
            await loadFromFolder(persisted);
            return; // disk-first render done
        }
    } catch (e) { console.warn('No persisted folder or cannot restore:', e); }

    // Fallback to browser-local data
    renderFeed();
})();

