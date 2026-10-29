// memo-batch-import.js — deliberate per-image review before importing.
//
// Normal multi-file attachment handling remains in memo-core: it creates one
// entry containing several files. This opt-in tool creates a separate entry for
// each reviewed card and delegates all durable persistence to MemoCore.
(function (global) {
  'use strict';

  var items = [];
  var busy = false;
  var createdCount = 0;

  function el(id) { return document.getElementById(id); }
  function dlg() { return el('batchImportReviewDlg'); }
  function uid() { return 'batch_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9); }
  function imageFiles(files) {
    return Array.prototype.filter.call(files || [], function (file) {
      return file && (file.type || '').toLowerCase().indexOf('image/') === 0;
    });
  }
  function safeDescription(file) {
    var name = String((file && file.name) || 'Image').replace(/\.[^.]+$/, '');
    return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Image';
  }
  function escHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function cleanTags(value) {
    var seen = Object.create(null);
    return String(value || '').split(',').map(function (tag) { return tag.trim(); }).filter(function (tag) {
      if (!tag || seen[tag.toLowerCase()]) return false;
      seen[tag.toLowerCase()] = true;
      return true;
    });
  }
  function state() {
    try { return global.MemoCore.getState(); } catch (_e) { return { settings: { categories: [], tags: [] } }; }
  }
  function categories() {
    var list = ((state().settings || {}).categories || []).slice();
    if (list.indexOf('Uncategorized') < 0) list.unshift('Uncategorized');
    return list;
  }
  function updateCategoryOptions() {
    var select = el('batchImportBulkCategory');
    if (!select) return;
    var previous = select.value;
    select.innerHTML = categories().map(function (cat) {
      return '<option value="' + escHtml(cat) + '">' + escHtml(cat) + '</option>';
    }).join('');
    if (previous && Array.prototype.some.call(select.options, function (option) { return option.value === previous; })) select.value = previous;
  }
  function updateCount() {
    var count = el('batchImportCount');
    if (!count) return;
    var selected = items.filter(function (item) { return item.selected && !item._completed; }).length;
    count.textContent = selected + ' selected of ' + items.length + ' image' + (items.length === 1 ? '' : 's');
  }
  function setStatus(message, bad) {
    var status = el('batchImportStatus');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = bad ? 'var(--danger)' : '';
  }
  function defaultCategory() {
    try {
      var variant = global.MemoVariant;
      var preferred = variant && typeof variant.preferredNewCategory === 'function' ? variant.preferredNewCategory() : null;
      return preferred || 'Uncategorized';
    } catch (_e) { return 'Uncategorized'; }
  }
  function addFiles(files) {
    var accepted = imageFiles(files);
    accepted.forEach(function (file) {
      items.push({
        tempId: uid(), file: file, previewUrl: URL.createObjectURL(file),
        description: safeDescription(file), category: defaultCategory(), tags: [], selected: true
      });
    });
    updateCategoryOptions();
    render();
    return accepted.length;
  }
  function render() {
    var list = el('batchImportList');
    if (!list) return;
    updateCount();
    if (!items.length) {
      list.innerHTML = '<p class="muted">No images remain. Add more images or cancel this review.</p>';
      return;
    }
    list.innerHTML = items.map(function (item) {
      var locked = !!item._completed;
      return '<article class="batch-import-card' + (item.selected ? '' : ' unselected') + (locked ? ' completed' : '') + '" data-batch-id="' + escHtml(item.tempId) + '">'
        + '<img src="' + escHtml(item.previewUrl) + '" alt="">'
        + '<div class="batch-import-fields">'
        + '<div class="batch-import-card-head"><label><input class="batch-import-selected" type="checkbox"' + (item.selected ? ' checked' : '') + (locked ? ' disabled' : '') + '> ' + (locked ? 'Finishing save' : 'Include') + '</label>'
        + '<span class="batch-import-card-name" title="' + escHtml(item.file.name) + '">' + escHtml(item.file.name) + '</span>'
        + '<button type="button" class="ghost batch-import-remove" title="Remove image" aria-label="Remove image"' + (locked ? ' disabled' : '') + '>×</button></div>'
        + '<input class="batch-import-description" aria-label="Description" value="' + escHtml(item.description) + '" placeholder="Description"' + (locked ? ' disabled' : '') + '>'
        + '<select class="batch-import-category" aria-label="Folder"' + (locked ? ' disabled' : '') + '>' + categoryOptions(item.category) + '</select>'
        + '<input class="batch-import-tags" aria-label="Tags" value="' + escHtml(item.tags.join(', ')) + '" placeholder="tags, comma-separated"' + (locked ? ' disabled' : '') + '>'
        + '</div></article>';
    }).join('');
  }
  function categoryOptions(selected) {
    return categories().map(function (cat) {
      return '<option value="' + escHtml(cat) + '"' + (cat === selected ? ' selected' : '') + '>' + escHtml(cat) + '</option>';
    }).join('');
  }
  function findItem(node) {
    var card = node && node.closest && node.closest('[data-batch-id]');
    if (!card) return null;
    return items.filter(function (item) { return item.tempId === card.dataset.batchId; })[0] || null;
  }
  function revoke(item) {
    // Cache-owned URLs belong to StateDb and may also back an entry/card. Only
    // revoke previews still owned by this review dialog.
    if (item && item._cacheOwnedPreview) return;
    try { if (item && item.previewUrl) URL.revokeObjectURL(item.previewUrl); } catch (_e) {}
  }
  function clearItems() {
    items.forEach(revoke);
    items = [];
    createdCount = 0;
  }
  function hasPendingFlush() {
    return items.some(function (item) { return item._completed; });
  }
  function close() {
    if (busy) return;
    if (hasPendingFlush()) {
      setStatus('Finish the durable save before closing this review.', true);
      return;
    }
    clearItems();
    var dialog = dlg();
    if (dialog && dialog.open) dialog.close();
  }
  function open(files) {
    if (busy) return;
    clearItems();
    var accepted = addFiles(files);
    if (!accepted) {
      if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast('Choose one or more image files to review.');
      return;
    }
    var dialog = dlg();
    if (dialog && !dialog.open) dialog.showModal();
    setStatus('Each retained image will become its own entry. Nothing is saved until you confirm.');
  }
  function selectAll(selected) {
    items.forEach(function (item) { if (!item._completed) item.selected = selected; });
    render();
  }
  function applyCategory() {
    var select = el('batchImportBulkCategory');
    if (!select) return;
    var value = select.value || 'Uncategorized';
    items.forEach(function (item) { if (item.selected && !item._completed) item.category = value; });
    render();
  }
  function applyTags(remove) {
    var input = el('batchImportBulkTags');
    var tags = cleanTags(input && input.value);
    if (!tags.length) { setStatus('Enter one or more comma-separated tags first.', true); return; }
    var lookup = Object.create(null);
    tags.forEach(function (tag) { lookup[tag.toLowerCase()] = tag; });
    items.forEach(function (item) {
      if (!item.selected || item._completed) return;
      if (remove) item.tags = item.tags.filter(function (tag) { return !lookup[tag.toLowerCase()]; });
      else {
        var existing = Object.create(null);
        item.tags.forEach(function (tag) { existing[tag.toLowerCase()] = true; });
        tags.forEach(function (tag) { if (!existing[tag.toLowerCase()]) { existing[tag.toLowerCase()] = true; item.tags.push(tag); } });
      }
    });
    render();
  }
  async function flushPersistence() {
    if (global.MemoCore && typeof global.MemoCore.flushPersistence === 'function') {
      await global.MemoCore.flushPersistence();
      global.OperationQueue?.processQueue();
    }
  }
  function finishSuccess() {
    var count = createdCount;
    clearItems();
    var dialog = dlg();
    if (dialog && dialog.open) dialog.close();
    if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast('Created ' + count + ' separate entr' + (count === 1 ? 'y' : 'ies') + '.');
  }
  async function confirm() {
    if (busy) return;
    var retained = items.filter(function (item) { return item.selected && !item._completed; });
    var awaitingFlush = items.some(function (item) { return item._completed; });
    if (!retained.length && !awaitingFlush) { setStatus('Select at least one image to create entries.', true); return; }
    if (!global.MemoCore || typeof global.MemoCore.createReviewedEntry !== 'function') { setStatus('Import service is not ready yet.', true); return; }
    busy = true;
    var button = el('batchImportConfirmBtn');
    if (button) button.disabled = true;
    var stage = awaitingFlush ? 'flush' : 'create';
    setStatus(awaitingFlush ? 'Finishing the durable save…' : 'Creating ' + retained.length + ' entr' + (retained.length === 1 ? 'y' : 'ies') + '…');
    try {
      // A prior metadata flush may have failed after all blob writes completed.
      // Retry that single checkpoint before creating any remaining review cards.
      if (awaitingFlush) {
        await flushPersistence();
        items = items.filter(function (item) { return !item._completed; });
        render();
        retained = items.filter(function (item) { return item.selected; });
        if (!retained.length) { finishSuccess(); return; }
        stage = 'create';
        setStatus('Creating ' + retained.length + ' entr' + (retained.length === 1 ? 'y' : 'ies') + '…');
      }
      // Run in order so an offline/mobile device is not asked to decode and write
      // an unbounded number of large images simultaneously.
      for (var index = 0; index < retained.length; index++) {
        await global.MemoCore.createReviewedEntry(retained[index]);
        retained[index]._completed = true;
        retained[index].selected = false;
        createdCount += 1;
        setStatus('Created ' + (index + 1) + ' of ' + retained.length + ' entries…');
      }
      // Blob writes and queue updates above are intentionally sequential, while
      // the expensive SQLite snapshot is coalesced into one final durable flush.
      stage = 'flush';
      setStatus('Finishing the durable save…');
      await flushPersistence();
      finishSuccess();
    } catch (error) {
      var reported = error;
      // If one file failed, checkpoint every earlier completed item before
      // removing it from the reviewer. The failed and unattempted files remain
      // visible and retryable without duplicating successful entries.
      if (stage === 'create' && items.some(function (item) { return item._completed; })) {
        try {
          await flushPersistence();
          items = items.filter(function (item) { return !item._completed; });
        } catch (flushError) {
          reported = flushError;
        }
      }
      render();
      setStatus('Import stopped: ' + ((reported && reported.message) || reported || 'Unknown error'), true);
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  }
  function wire() {
    var launch = el('batchImportInput');
    if (launch) launch.addEventListener('change', function () { open(launch.files); launch.value = ''; });
    var addMore = el('batchImportAddMoreInput');
    if (addMore) addMore.addEventListener('change', function () { addFiles(addMore.files); addMore.value = ''; });
    var list = el('batchImportList');
    if (list) {
      list.addEventListener('input', function (event) {
        var item = findItem(event.target); if (!item) return;
        if (event.target.classList.contains('batch-import-description')) item.description = event.target.value;
        if (event.target.classList.contains('batch-import-tags')) item.tags = cleanTags(event.target.value);
      });
      list.addEventListener('change', function (event) {
        var item = findItem(event.target); if (!item) return;
        if (event.target.classList.contains('batch-import-selected')) { item.selected = event.target.checked; render(); }
        if (event.target.classList.contains('batch-import-category')) item.category = event.target.value || 'Uncategorized';
      });
      list.addEventListener('click', function (event) {
        if (!event.target.closest || !event.target.closest('.batch-import-remove')) return;
        var item = findItem(event.target); if (!item) return;
        revoke(item);
        items = items.filter(function (candidate) { return candidate !== item; });
        render();
      });
    }
    bind('batchImportSelectAllBtn', function () { selectAll(true); });
    bind('batchImportSelectNoneBtn', function () { selectAll(false); });
    bind('batchImportApplyCategoryBtn', applyCategory);
    bind('batchImportAddTagsBtn', function () { applyTags(false); });
    bind('batchImportRemoveTagsBtn', function () { applyTags(true); });
    bind('batchImportCancelBtn', close);
    bind('batchImportConfirmBtn', confirm);
    var dialog = dlg();
    if (dialog) dialog.addEventListener('cancel', function (event) {
      if (busy || hasPendingFlush()) {
        event.preventDefault();
        if (hasPendingFlush()) setStatus('Finish the durable save before closing this review.', true);
      }
    });
    if (dialog) dialog.addEventListener('close', function () { if (!busy) clearItems(); });
  }
  function bind(id, handler) { var node = el(id); if (node) node.addEventListener('click', handler); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.addEventListener('beforeunload', function (event) {
    if (!busy && !hasPendingFlush()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  global.MemoBatchImport = { open: open, close: close, addFiles: addFiles, __items: function () { return items; } };
})(window);
