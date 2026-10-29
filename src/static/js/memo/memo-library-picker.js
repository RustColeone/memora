// memo-library-picker.js — reusable, entry-grouped picker for memo media.
//
// Memo entries can contain several images.  The picker therefore renders one
// card per entry, with an at-most-four-image montage, while selection remains
// per image slot.  Its structural filters are a one-way snapshot of MemoCore's
// applied filters: edits made here are deliberately local to this picker run.
'use strict';
(function (global) {
  var EMPTY_FILTERS = { dateFrom: null, dateTo: null, cats: [], tags: [], tagMatch: 'any', entryId: null };
  var state = {
    active: false,
    mode: 'multi',
    mediaFilter: 'image',
    min: 2,
    title: '',
    search: '',
    filters: cloneFilters(EMPTY_FILTERS),
    filterDraft: null,
    selected: new Map(),       // key (entry id + image slot) -> media record
    expanded: new Set(),       // entry ids whose >4 montage has been expanded
    onDone: null,
    onCancel: null,
    resultType: 'descriptor',
    busy: false,
    preserveClose: false,
    wired: false,
    session: 0,
  };

  function el(id) { return document.getElementById(id); }
  function core() { return global.MemoCore; }
  function privacy() { return global.MemoPrivacy; }
  function own(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }
  function asArray(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value.slice();
    if (typeof value.forEach === 'function') { var out = []; value.forEach(function (v) { out.push(v); }); return out; }
    return [value];
  }
  function uniqueStrings(value) {
    var seen = new Set();
    return asArray(value).map(function (v) { return String(v); }).filter(function (v) {
      if (!v || seen.has(v)) return false;
      seen.add(v); return true;
    });
  }
  function cloneFilters(source) {
    source = source || EMPTY_FILTERS;
    return {
      dateFrom: source.dateFrom || null,
      dateTo: source.dateTo || null,
      cats: new Set(uniqueStrings(source.cats)),
      tags: new Set(uniqueStrings(source.tags)),
      tagMatch: source.tagMatch === 'all' ? 'all' : 'any',
      entryId: source.entryId == null || source.entryId === '' ? null : String(source.entryId),
    };
  }
  function mergeFilters(base, override) {
    var out = cloneFilters(base);
    if (!override) return out;
    if (own(override, 'dateFrom')) out.dateFrom = override.dateFrom || null;
    if (own(override, 'dateTo')) out.dateTo = override.dateTo || null;
    if (own(override, 'cats')) out.cats = new Set(uniqueStrings(override.cats));
    if (own(override, 'tags')) out.tags = new Set(uniqueStrings(override.tags));
    if (own(override, 'tagMatch')) out.tagMatch = override.tagMatch === 'all' ? 'all' : 'any';
    if (own(override, 'entryId')) out.entryId = override.entryId == null || override.entryId === '' ? null : String(override.entryId);
    return out;
  }
  function serializeFilters(filters) {
    filters = filters || EMPTY_FILTERS;
    return {
      dateFrom: filters.dateFrom || null,
      dateTo: filters.dateTo || null,
      cats: asArray(filters.cats),
      tags: asArray(filters.tags),
      tagMatch: filters.tagMatch === 'all' ? 'all' : 'any',
      entryId: filters.entryId || null,
    };
  }
  function snapshotGlobalFilters(initialFilters) {
    var source = null;
    try { source = core() && core().getState && core().getState().activeFilters; } catch (_e) {}
    var snapshot = cloneFilters(source || EMPTY_FILTERS);
    // Prefer the explicit context API when present.  It tracks the open memo
    // even though entryId is intentionally not a main-feed predicate.
    try {
      var contextual = core() && core().getActiveEntryFilter && core().getActiveEntryFilter();
      if (contextual != null && contextual !== '') snapshot.entryId = String(contextual);
    } catch (_e2) {}
    return mergeFilters(snapshot, initialFilters);
  }

  function cleanPath(value) { return String(value || '').split('#')[0].split('?')[0]; }
  function extension(value) {
    var clean = cleanPath(value);
    var match = clean.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  }
  function mimeFor(value, fallback) {
    var data = String(value || '').match(/^data:([^;,]+)[;,]/i);
    if (data) return data[1].toLowerCase();
    var ext = extension(value) || extension(fallback);
    return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff',
      tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif' })[ext] || 'image/*';
  }
  function nameFor(value, index) {
    var clean = cleanPath(value);
    if (/^(blob:|data:)/i.test(clean)) return 'Image ' + (index + 1);
    var raw = clean.substring(clean.lastIndexOf('/') + 1);
    if (!raw) return 'Image ' + (index + 1);
    try { raw = decodeURIComponent(raw); } catch (_e) {}
    return raw || ('Image ' + (index + 1));
  }
  function normalizedStoredPath(stored, raw) {
    if (stored) return String(stored).replace(/^\/+/, '');
    var clean = cleanPath(raw);
    var match = clean.match(/(?:^|\/)uploads\/[^/]+\/[^/]+$/i);
    return match ? match[0].replace(/^\/+/, '') : null;
  }
  function mediaKey(entryId, index) { return String(entryId) + '\u001f' + String(index); }
  function entryImages(entry) { return entry && Array.isArray(entry.images) ? entry.images : []; }
  function mediaRecord(entry, index) {
    var raw = entryImages(entry)[index];
    if (!raw) return null;
    var stored = Array.isArray(entry._storedPaths) ? entry._storedPaths[index] : null;
    stored = normalizedStoredPath(stored, raw);
    var stableRef = stored || String(raw);
    var mime = mimeFor(stableRef, raw);
    return {
      key: mediaKey(entry.id, index),
      entry: entry,
      raw: String(raw),
      preview: String(raw || (stored ? '/' + stored : '')),
      descriptor: {
        entryId: entry.id,
        index: index,
        ref: stableRef,
        storedPath: stored,
        url: null,
        mime: mime,
        name: nameFor(stableRef || raw, index),
        safe: !!entry.safe,
      },
    };
  }
  function acceptsRecord(record, filter) {
    if (!record || !record.raw) return false;
    var mime = record.descriptor.mime;
    var ext = extension(record.descriptor.ref) || extension(record.raw);
    if (filter === 'gif') return mime === 'image/gif' || ext === 'gif' || /^data:image\/gif/i.test(record.raw);
    if (filter === 'jpeg') return mime === 'image/jpeg' || /^(jpe?g)$/i.test(ext);
    if (mime.indexOf('image/') === 0 && mime !== 'image/*') return true;
    try { if (core() && core().isImage && (core().isImage(record.raw) || core().isImage(record.descriptor.ref))) return true; } catch (_e) {}
    return /^(png|jpe?g|gif|webp|avif|bmp|svg|tiff?|heic|heif)$/i.test(ext);
  }
  function canViewEntry(entry) {
    try { return !privacy() || !privacy().canViewEntry || privacy().canViewEntry(entry); }
    catch (_e) { return false; }
  }
  function entryTimestamp(entry) {
    var raw = entry && (entry.ts != null ? entry.ts : (entry.createdAt || entry.updatedAt));
    var n = typeof raw === 'number' ? raw : new Date(raw || 0).getTime();
    return Number.isFinite(n) ? n : 0;
  }
  function dayStart(value) {
    if (!value) return null;
    var n = new Date(value).getTime();
    return Number.isFinite(n) ? n : null;
  }
  function matchesStructuralFilters(entry, filters) {
    filters = filters || state.filters;
    if (filters.entryId != null && String(entry.id) !== String(filters.entryId)) return false;
    if (filters.cats && filters.cats.size && !filters.cats.has(String(entry.category || ''))) return false;
    if (filters.tags && filters.tags.size) {
      var entryTags = new Set((entry.tags || []).map(function (tag) { return String(tag); }));
      var wanted = Array.from(filters.tags);
      var tagOkay = filters.tagMatch === 'all'
        ? wanted.every(function (tag) { return entryTags.has(tag); })
        : wanted.some(function (tag) { return entryTags.has(tag); });
      if (!tagOkay) return false;
    }
    var ts = entryTimestamp(entry);
    var from = dayStart(filters.dateFrom);
    var to = dayStart(filters.dateTo);
    if (from != null && ts < from) return false;
    if (to != null && ts > to + 24 * 60 * 60 * 1000 - 1) return false;
    return true;
  }
  function searchHaystack(entry, records) {
    var values = [entry.description, entry.category, entry.createdAt, entry.updatedAt];
    (entry.tags || []).forEach(function (tag) { values.push(tag); });
    (records || []).forEach(function (record) {
      values.push(record.descriptor.name, record.descriptor.mime, record.descriptor.ref);
    });
    return values.filter(Boolean).join('\n').toLocaleLowerCase();
  }
  function matchesSearch(entry, records, query) {
    var words = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var haystack = searchHaystack(entry, records);
    return words.every(function (word) { return haystack.indexOf(word) >= 0; });
  }
  function databaseEntries() {
    try {
      var st = core() && core().getState && core().getState();
      return st && st.db && Array.isArray(st.db.entries) ? st.db.entries : [];
    } catch (_e) { return []; }
  }
  function groupedEntries(options) {
    options = options || {};
    var filters = options.filters || state.filters;
    var query = own(options, 'search') ? options.search : state.search;
    var mediaFilter = options.mediaFilter || state.mediaFilter;
    var groups = [];
    databaseEntries().forEach(function (entry) {
      if (!entry || entry.deletedAt || !canViewEntry(entry) || !matchesStructuralFilters(entry, filters)) return;
      var records = [];
      entryImages(entry).forEach(function (_raw, index) {
        var record = mediaRecord(entry, index);
        if (acceptsRecord(record, mediaFilter)) records.push(record);
      });
      if (!records.length || !matchesSearch(entry, records, query)) return;
      groups.push({ entry: entry, records: records });
    });
    groups.sort(function (a, b) { return entryTimestamp(b.entry) - entryTimestamp(a.entry); });
    return groups;
  }
  function allCurrentRecords() {
    var records = new Map();
    databaseEntries().forEach(function (entry) {
      if (!entry || entry.deletedAt || !canViewEntry(entry)) return;
      entryImages(entry).forEach(function (_raw, index) {
        var record = mediaRecord(entry, index);
        if (acceptsRecord(record, state.mediaFilter)) records.set(record.key, record);
      });
    });
    return records;
  }

  function entryLabel(entry) {
    var description = String(entry && entry.description || '').trim().split(/\r?\n/)[0];
    if (description.length > 80) description = description.slice(0, 77) + '\u2026';
    return description || String(entry && entry.category || '') || 'Untitled memo';
  }
  function lazySource(source) {
    if (!source) return '';
    try { return global.MemoLazy && global.MemoLazy.thumbUrl ? global.MemoLazy.thumbUrl(source, 320) : source; }
    catch (_e) { return source; }
  }
  function appendImage(record, montage, extraClass) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'libpick-image' + (extraClass ? ' ' + extraClass : '');
    button.dataset.mediaKey = record.key;
    button.setAttribute('aria-label', (state.selected.has(record.key) ? 'Deselect ' : 'Select ') + record.descriptor.name);
    button.setAttribute('aria-pressed', state.selected.has(record.key) ? 'true' : 'false');
    if (state.selected.has(record.key)) button.classList.add('selected');
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.className = 'lazy-img';
    var source = lazySource(record.preview);
    if (source) img.setAttribute('data-src', source);
    button.appendChild(img);
    montage.appendChild(button);
    return button;
  }
  function renderGroup(group, grid) {
    var entry = group.entry;
    var id = String(entry.id);
    var expanded = state.expanded.has(id);
    var section = document.createElement('section');
    section.className = 'libpick-entry';
    section.dataset.entryId = id;

    var head = document.createElement('header');
    head.className = 'libpick-entry-head';
    var title = document.createElement('strong');
    title.className = 'libpick-entry-title';
    title.textContent = entryLabel(entry);
    var meta = document.createElement('span');
    meta.className = 'libpick-entry-meta';
    var category = String(entry.category || '').trim();
    meta.textContent = (category ? category + ' \u00b7 ' : '') + group.records.length + (group.records.length === 1 ? ' image' : ' images');
    head.appendChild(title); head.appendChild(meta); section.appendChild(head);

    var montage = document.createElement('div');
    montage.className = 'libpick-montage' + (expanded ? ' expanded' : '');
    var shown = expanded || group.records.length <= 4 ? group.records : group.records.slice(0, 4);
    shown.forEach(function (record, index) {
      if (!expanded && group.records.length > 4 && index === 3) {
        var more = appendImage(record, montage, 'libpick-more');
        more.dataset.expandEntry = id;
        delete more.dataset.mediaKey;
        more.removeAttribute('aria-pressed');
        more.setAttribute('aria-label', 'Show ' + (group.records.length - 3) + ' more images from ' + entryLabel(entry));
        var overlay = document.createElement('span');
        overlay.className = 'libpick-more-count';
        overlay.textContent = '+' + (group.records.length - 3);
        more.appendChild(overlay);
        var hiddenSelected = group.records.slice(3).some(function (item) { return state.selected.has(item.key); });
        more.classList.toggle('has-selection', hiddenSelected);
      } else appendImage(record, montage, '');
    });
    section.appendChild(montage);
    grid.appendChild(section);
  }
  function renderGrid() {
    var grid = el('libPickGrid');
    if (!grid) return;
    grid.replaceChildren();
    var groups = groupedEntries();
    if (!groups.length) {
      var empty = document.createElement('div');
      empty.className = 'muted libpick-empty';
      var noun = state.mediaFilter === 'gif' ? 'GIFs' : (state.mediaFilter === 'jpeg' ? 'JPEG images' : 'images');
      empty.textContent = state.filters.entryId ? 'No matching ' + noun + ' in this memo.' : 'No matching ' + noun + ' in your library.';
      grid.appendChild(empty);
    } else groups.forEach(function (group) { renderGroup(group, grid); });
    try { if (global.MemoLazy && global.MemoLazy.hydrate) global.MemoLazy.hydrate(grid); } catch (_e) {}
    updateFooter();
  }
  function updateSelectionDom() {
    var grid = el('libPickGrid');
    if (!grid) return;
    grid.querySelectorAll('.libpick-image[data-media-key]').forEach(function (button) {
      var selected = state.selected.has(button.dataset.mediaKey);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      var record = selected ? state.selected.get(button.dataset.mediaKey) : null;
      var name = record ? record.descriptor.name : (button.getAttribute('aria-label') || '').replace(/^(Select|Deselect)\s+/, '');
      button.setAttribute('aria-label', (selected ? 'Deselect ' : 'Select ') + name);
    });
    grid.querySelectorAll('.libpick-more[data-expand-entry]').forEach(function (more) {
      var id = more.dataset.expandEntry;
      var hidden = Array.from(state.selected.values()).some(function (record) {
        return String(record.descriptor.entryId) === id && record.descriptor.index >= 3;
      });
      more.classList.toggle('has-selection', hidden);
    });
  }
  function updateFooter() {
    var count = state.selected.size;
    var done = el('libPickDone');
    if (done) {
      done.disabled = state.busy || count < state.min;
      if (state.busy) done.textContent = 'Loading\u2026';
      else if (state.mode === 'single') done.textContent = count ? 'Use this image' : 'Use image';
      else done.textContent = count ? 'Use ' + count : 'Use selected';
    }
    var label = el('libPickCount');
    if (label) {
      if (state.mode === 'single') label.textContent = count ? '1 selected' : 'Pick one';
      else label.textContent = count + ' selected' + (state.min > 1 ? ' \u00b7 pick at least ' + state.min : '');
    }
  }
  function toggleRecord(key) {
    var records = allCurrentRecords();
    var record = records.get(key);
    if (!record) return;
    if (state.mode === 'single') {
      if (state.selected.has(key) && state.selected.size === 1) state.selected.clear();
      else { state.selected.clear(); state.selected.set(key, record); }
    } else if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.set(key, record);
    updateSelectionDom(); updateFooter();
  }

  function appendCrumbSeparator(container) {
    var separator = document.createElement('span');
    separator.className = 'bc-sep';
    separator.setAttribute('aria-hidden', 'true');
    separator.textContent = '\u203a';
    container.appendChild(separator);
  }
  function addChip(container, text, kind, value, label) {
    appendCrumbSeparator(container);
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bc-back libpick-chip';
    chip.dataset.filterKind = kind;
    if (value != null) chip.dataset.filterValue = String(value);
    chip.textContent = text;
    chip.setAttribute('aria-label', 'Remove ' + (label || text) + ' filter');
    chip.title = 'Remove ' + (label || text) + ' filter';
    container.appendChild(chip);
  }
  function findEntry(id) {
    return databaseEntries().find(function (entry) { return entry && String(entry.id) === String(id); }) || null;
  }
  function renderFilterChips() {
    var host = el('libPickChips');
    var filters = state.filters;
    var active = !!(filters.entryId || filters.dateFrom || filters.dateTo || filters.cats.size || filters.tags.size);
    if (host) {
      host.replaceChildren();
      if (active) {
        var root = document.createElement('button');
        root.type = 'button';
        root.className = 'bc-back libpick-chip libpick-breadcrumb-root';
        root.dataset.filterKind = 'all';
        root.textContent = '\u2039 Library';
        root.setAttribute('aria-label', 'Clear all library filters');
        root.title = 'Clear all library filters';
        host.appendChild(root);
      }
      Array.from(filters.cats).sort().forEach(function (cat) { addChip(host, 'Folder: ' + cat, 'cat', cat, 'folder ' + cat); });
      if (filters.entryId) {
        var entry = findEntry(filters.entryId);
        addChip(host, 'Memo: ' + (entry ? entryLabel(entry) : 'Current memo'), 'entry', filters.entryId, 'memo');
      }
      Array.from(filters.tags).sort().forEach(function (tag) { addChip(host, '#' + tag, 'tag', tag, 'tag ' + tag); });
      if (filters.dateFrom) addChip(host, 'From ' + filters.dateFrom, 'dateFrom', '', 'start date');
      if (filters.dateTo) addChip(host, 'Through ' + filters.dateTo, 'dateTo', '', 'end date');
      host.hidden = !active;
    }
    var filterButton = el('libPickFilterBtn');
    if (filterButton) {
      filterButton.classList.toggle('filter-active', active);
      filterButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
  function removeFilterChip(kind, value) {
    if (kind === 'all') state.filters = cloneFilters(EMPTY_FILTERS);
    else {
      var filters = state.filters;
      if (kind === 'entry') filters.entryId = null;
      else if (kind === 'cat') filters.cats.delete(String(value));
      else if (kind === 'tag') filters.tags.delete(String(value));
      else if (kind === 'dateFrom') filters.dateFrom = null;
      else if (kind === 'dateTo') filters.dateTo = null;
    }
    renderFilterChips(); renderGrid();
  }

  function settingsLists() {
    var settings = {}, entries = databaseEntries();
    try { settings = core() && core().getState && core().getState().settings || {}; } catch (_e) {}
    var cats = uniqueStrings((settings.categories || []).concat(entries.map(function (entry) { return entry && entry.category; })));
    var tags = uniqueStrings((settings.tags || []).concat.apply([], entries.map(function (entry) { return entry && entry.tags || []; })));
    return { cats: cats.sort(), tags: tags.sort() };
  }
  function renderCheckboxList(host, values, selected, kind, query) {
    if (!host) return;
    host.replaceChildren();
    var shown = values.filter(function (value) { return !query || value.toLocaleLowerCase().indexOf(query) >= 0; });
    if (!shown.length) {
      var empty = document.createElement('span'); empty.className = 'muted libpick-filter-empty';
      empty.textContent = query ? 'No matches' : 'None available'; host.appendChild(empty); return;
    }
    shown.forEach(function (value) {
      var label = document.createElement('label'); label.className = 'check-row libpick-filter-option';
      var input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(value);
      input.dataset.filterOption = kind; input.dataset.value = value;
      var text = document.createElement('span'); text.className = 'cr-text'; text.textContent = kind === 'tag' ? '#' + value : value;
      label.appendChild(input); label.appendChild(text); host.appendChild(label);
    });
  }
  function renderFilterDraft() {
    if (!state.filterDraft) return;
    var lists = settingsLists();
    renderCheckboxList(el('libPickFilterCats'), lists.cats, state.filterDraft.cats, 'cat', '');
    var search = String(el('libPickFilterTagSearch') && el('libPickFilterTagSearch').value || '').trim().toLocaleLowerCase();
    renderCheckboxList(el('libPickFilterTags'), lists.tags, state.filterDraft.tags, 'tag', search);
    var from = el('libPickDateFrom'); if (from) from.value = state.filterDraft.dateFrom || '';
    var to = el('libPickDateTo'); if (to) to.value = state.filterDraft.dateTo || '';
    var mode = el('libPickFilterTagMode');
    if (mode) mode.querySelectorAll('[data-mode]').forEach(function (button) {
      var active = button.dataset.mode === state.filterDraft.tagMatch;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  function openFilterDialog() {
    // Reuse the main Filters dialog (By Type / By Date tabs, tag pills, calendar)
    // instead of a separate picker filter dialog. "Capture" mode edits a local copy
    // and returns it here without touching the global feed filter.
    if (global.MemoFilterDialog && typeof global.MemoFilterDialog.openCapture === 'function') {
      var source = {
        dateFrom: state.filters.dateFrom, dateTo: state.filters.dateTo,
        cats: asArray(state.filters.cats), tags: asArray(state.filters.tags), tagMatch: state.filters.tagMatch,
      };
      global.MemoFilterDialog.openCapture(source, function (result) {
        if (!result) return;
        state.filters = mergeFilters(EMPTY_FILTERS, {
          dateFrom: result.dateFrom, dateTo: result.dateTo,
          cats: asArray(result.cats), tags: asArray(result.tags),
          tagMatch: result.tagMatch, entryId: state.filters.entryId,
        });
        renderFilterChips();
        renderGrid();
      });
      return;
    }
    // Fallback: the legacy in-picker dialog (only if the main dialog is unavailable).
    var dialog = el('libPickFilterDlg');
    if (!dialog) return;
    state.filterDraft = cloneFilters(state.filters);
    var search = el('libPickFilterTagSearch'); if (search) search.value = '';
    renderFilterDraft();
    if (!dialog.open) { try { dialog.showModal(); } catch (_e) { dialog.setAttribute('open', ''); } }
  }
  function closeFilterDialog(apply) {
    var dialog = el('libPickFilterDlg');
    if (apply && state.filterDraft) {
      var from = el('libPickDateFrom'), to = el('libPickDateTo');
      state.filterDraft.dateFrom = from && from.value || null;
      state.filterDraft.dateTo = to && to.value || null;
      if (state.filterDraft.dateFrom && state.filterDraft.dateTo && state.filterDraft.dateFrom > state.filterDraft.dateTo) {
        var swap = state.filterDraft.dateFrom; state.filterDraft.dateFrom = state.filterDraft.dateTo; state.filterDraft.dateTo = swap;
      }
      state.filters = cloneFilters(state.filterDraft);
      renderFilterChips(); renderGrid();
    }
    state.filterDraft = null;
    if (dialog && dialog.open) { try { dialog.close(); } catch (_e) { dialog.removeAttribute('open'); } }
  }

  function updateSafeButton() {
    var button = el('libPickSafeBtn');
    if (!button) return;
    var level = 1;
    try {
      var variant = core() && core().getVariant ? core().getVariant() : (global.MEMO_VARIANT || 'default');
      var memoActive = !variant || variant === 'default' || variant === 'memo';
      level = memoActive && privacy() && privacy().levelOf ? privacy().levelOf() : 1;
    } catch (_e) {}
    button.hidden = level < 2;
    var active = false;
    try { active = !!(privacy() && privacy().isSafeView && privacy().isSafeView()); } catch (_e2) {}
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    var label = active ? 'Close Safe' : 'Open Safe';
    button.setAttribute('aria-label', label); button.title = label;
  }
  function prunePrivacyHiddenSelections() {
    var current = allCurrentRecords();
    Array.from(state.selected.keys()).forEach(function (key) { if (!current.has(key)) state.selected.delete(key); });
  }
  async function toggleSafe() {
    if (state.busy || !privacy() || typeof privacy().toggleSafe !== 'function') return;
    var dialog = el('libMediaPickerDlg');
    state.preserveClose = true;
    try { await privacy().toggleSafe(); } catch (_e) {}
    state.preserveClose = false;
    if (!state.active) return;
    prunePrivacyHiddenSelections();
    updateSafeButton(); renderGrid();
    var locked = !!(document.body && document.body.classList.contains('privacy-locked'));
    if (dialog && !dialog.open && !locked) {
      try { dialog.showModal(); } catch (_e2) { dialog.setAttribute('open', ''); }
    }
  }

  function resolveUrl(record) {
    var raw = record.raw;
    if (/^(https?:|blob:|data:)/i.test(raw)) return Promise.resolve(raw);
    var stored = record.descriptor.storedPath;
    var sdb = global.MemoStateDb;
    if (stored && sdb && typeof sdb.blobUrl === 'function') {
      return Promise.resolve(sdb.blobUrl(stored)).then(function (url) { return url || raw || ('/' + stored); }, function () { return raw || ('/' + stored); });
    }
    return Promise.resolve(raw || record.descriptor.ref);
  }
  function publicDescriptor(record, url) {
    var source = record.descriptor;
    return { entryId: source.entryId, index: source.index, ref: source.ref, storedPath: source.storedPath,
      url: url || source.ref, mime: source.mime, name: source.name, safe: source.safe };
  }
  function closeMainDialog() {
    var filters = el('libPickFilterDlg');
    if (filters && filters.open) { try { filters.close(); } catch (_e) { filters.removeAttribute('open'); } }
    var dialog = el('libMediaPickerDlg');
    if (dialog && dialog.open) { try { dialog.close(); } catch (_e2) { dialog.removeAttribute('open'); } }
  }
  function cancel() {
    if (!state.active) return;
    var callback = state.onCancel;
    state.active = false; state.onDone = null; state.onCancel = null; state.filterDraft = null;
    closeMainDialog();
    if (callback) { try { callback(); } catch (_e) {} }
  }
  async function finish() {
    if (!state.active || state.busy || state.selected.size < state.min) return;
    var current = allCurrentRecords();
    var records = Array.from(state.selected.keys()).map(function (key) { return current.get(key); }).filter(Boolean);
    // A deletion or privacy-scope change may invalidate a prior selection.  Do
    // not return hidden/stale media even though normal search/filter narrowing
    // intentionally preserves selection.
    if (records.length < state.min) {
      prunePrivacyHiddenSelections(); updateSelectionDom(); updateFooter(); return;
    }
    state.busy = true; updateFooter();
    var session = state.session;
    try {
      var resolved = await Promise.all(records.map(async function (record) {
        return publicDescriptor(record, await resolveUrl(record));
      }));
      if (!state.active || session !== state.session) return;
      var callback = state.onDone;
      var mode = state.mode;
      var resultType = state.resultType;
      state.active = false; state.onDone = null; state.onCancel = null;
      closeMainDialog();
      var result = mode === 'single' ? resolved[0] : resolved;
      if (resultType === 'url') result = mode === 'single' ? resolved[0].url : resolved.map(function (item) { return item.url; });
      if (callback) callback(result);
    } catch (error) {
      if (session !== state.session) return;
      if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast('Could not load the selected image.', { kind: 'error' });
      try { console.warn('[MemoLibraryPicker] selection resolution failed', error); } catch (_e) {}
    } finally {
      if (session === state.session) { state.busy = false; updateFooter(); }
    }
  }

  function open(options) {
    options = options || {};
    wire();
    state.session++;
    state.active = true;
    state.mode = options.mode === 'single' ? 'single' : 'multi';
    state.mediaFilter = options.filter === 'gif' ? 'gif' : (options.filter === 'jpeg' ? 'jpeg' : 'image');
    var requestedMin = Number(options.min);
    state.min = state.mode === 'single' ? 1 : (Number.isFinite(requestedMin) && requestedMin > 0 ? Math.floor(requestedMin) : 2);
    state.title = options.title || (state.mediaFilter === 'gif' ? 'Pick a GIF from Library' :
      (state.mediaFilter === 'jpeg' ? 'Pick a JPEG from Library' : 'Pick from Library'));
    state.search = '';
    state.filters = snapshotGlobalFilters(options.initialFilters);
    state.filterDraft = null;
    state.selected.clear(); state.expanded.clear();
    state.onDone = typeof options.onDone === 'function' ? options.onDone : null;
    state.onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
    state.resultType = options.resultType === 'url' || options.returnType === 'url' || options.legacyUrls ? 'url' : 'descriptor';
    state.busy = false; state.preserveClose = false;

    var title = el('libPickTitle'); if (title) title.textContent = state.title;
    var search = el('libPickSearch'); if (search) search.value = '';
    updateSafeButton(); renderFilterChips(); renderGrid();
    var dialog = el('libMediaPickerDlg');
    if (dialog && !dialog.open) { try { dialog.showModal(); } catch (_e) { dialog.setAttribute('open', ''); } }
  }

  function wire() {
    if (state.wired) return;
    var grid = el('libPickGrid');
    if (grid) grid.addEventListener('click', function (event) {
      var more = event.target.closest && event.target.closest('.libpick-more[data-expand-entry]');
      if (more) { state.expanded.add(String(more.dataset.expandEntry)); renderGrid(); return; }
      var button = event.target.closest && event.target.closest('.libpick-image[data-media-key]');
      if (button) toggleRecord(button.dataset.mediaKey);
    });
    var search = el('libPickSearch');
    if (search) search.addEventListener('input', function () { state.search = search.value || ''; renderGrid(); });
    var chips = el('libPickChips');
    if (chips) chips.addEventListener('click', function (event) {
      var chip = event.target.closest && event.target.closest('.libpick-chip[data-filter-kind]');
      if (chip) removeFilterChip(chip.dataset.filterKind, chip.dataset.filterValue);
    });
    var filterButton = el('libPickFilterBtn'); if (filterButton) filterButton.addEventListener('click', openFilterDialog);
    var safe = el('libPickSafeBtn'); if (safe) safe.addEventListener('click', function () { void toggleSafe(); });
    var done = el('libPickDone'); if (done) done.addEventListener('click', function () { void finish(); });
    ['libPickCancel', 'libPickClose'].forEach(function (id) { var button = el(id); if (button) button.addEventListener('click', cancel); });

    var filterDialog = el('libPickFilterDlg');
    var filterCats = el('libPickFilterCats'), filterTags = el('libPickFilterTags');
    function filterOptionChange(event) {
      if (!state.filterDraft) return;
      var input = event.target.closest && event.target.closest('input[data-filter-option]');
      if (!input) return;
      var set = input.dataset.filterOption === 'cat' ? state.filterDraft.cats : state.filterDraft.tags;
      if (input.checked) set.add(input.dataset.value); else set.delete(input.dataset.value);
    }
    if (filterCats) filterCats.addEventListener('change', filterOptionChange);
    if (filterTags) filterTags.addEventListener('change', filterOptionChange);
    var tagSearch = el('libPickFilterTagSearch'); if (tagSearch) tagSearch.addEventListener('input', renderFilterDraft);
    ['libPickDateFrom', 'libPickDateTo'].forEach(function (id) {
      var input = el(id);
      if (input) input.addEventListener('change', function () {
        if (!state.filterDraft) return;
        state.filterDraft[id === 'libPickDateFrom' ? 'dateFrom' : 'dateTo'] = input.value || null;
      });
    });
    var mode = el('libPickFilterTagMode');
    if (mode) mode.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('[data-mode]');
      if (!button || !state.filterDraft) return;
      state.filterDraft.tagMatch = button.dataset.mode === 'all' ? 'all' : 'any'; renderFilterDraft();
    });
    var reset = el('libPickFilterReset'); if (reset) reset.addEventListener('click', function () { state.filterDraft = cloneFilters(EMPTY_FILTERS); renderFilterDraft(); });
    ['libPickFilterCancel', 'libPickFilterClose'].forEach(function (id) { var button = el(id); if (button) button.addEventListener('click', function () { closeFilterDialog(false); }); });
    var apply = el('libPickFilterApply'); if (apply) apply.addEventListener('click', function () { closeFilterDialog(true); });
    if (filterDialog) {
      filterDialog.addEventListener('cancel', function (event) { event.preventDefault(); closeFilterDialog(false); });
      filterDialog.addEventListener('close', function () { state.filterDraft = null; });
    }
    var dialog = el('libMediaPickerDlg');
    if (dialog) {
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); cancel(); });
      dialog.addEventListener('close', function () {
        if (state.active && !state.preserveClose) {
          // Native/system Back and generic dialog-stack dismissal call
          // dialog.close() directly, so they do not pass through the visible
          // Cancel controls. Route every ordinary close through the same API
          // path so callers can restore their parent tool. cancel() marks the
          // session inactive before attempting another close, which keeps this
          // close event from recursing or invoking the callback twice.
          cancel();
        }
      });
    }
    document.addEventListener('memo:privacy-unlocked', function () {
      if (state.active) { updateSafeButton(); prunePrivacyHiddenSelections(); renderGrid(); }
    });
    document.addEventListener('memo:privacy-locked', function () {
      if (state.active) { updateSafeButton(); prunePrivacyHiddenSelections(); }
    });
    state.wired = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoLibraryPicker = {
    open: open,
    close: cancel,
    refresh: function () { if (state.active) { updateSafeButton(); renderFilterChips(); renderGrid(); } },
    getState: function () {
      return { active: state.active, mode: state.mode, filter: state.mediaFilter, min: state.min, search: state.search,
        filters: serializeFilters(state.filters), selectedKeys: Array.from(state.selected.keys()), expandedEntryIds: Array.from(state.expanded) };
    },
    setLocalFilters: function (filters) {
      state.filters = mergeFilters(state.filters, filters || {}); renderFilterChips(); renderGrid();
    },
    __test: {
      cloneFilters: cloneFilters,
      mergeFilters: mergeFilters,
      serializeFilters: serializeFilters,
      mimeFor: mimeFor,
      mediaKey: mediaKey,
      mediaRecord: mediaRecord,
      acceptsRecord: acceptsRecord,
      matchesStructuralFilters: matchesStructuralFilters,
      matchesSearch: matchesSearch,
      groupedEntries: groupedEntries,
      resolveUrl: resolveUrl,
      toggleRecord: toggleRecord,
      finish: finish,
      render: function () { renderFilterChips(); renderGrid(); },
    },
  };
})(window);
