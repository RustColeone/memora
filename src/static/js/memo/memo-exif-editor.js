// memo-exif-editor.js — MemoSystem embedded-JPEG metadata editor.
//
// DOM contract (all IDs except metadataEditorStatus/metadataEditorFileName are
// required for the complete UI):
//   metadataEditorDlg, metadataEditorTitle, metadataEditorClose,
//   metadataEmbeddedNote, metadataUnsupported, metadataEmbeddedFields,
//   metadataDescription, metadataCreator, metadataCopyright,
//   metadataCapturedAt, metadataReadonlySection, metadataReadonlyGrid,
//   metadataPrivacyActions, metadataStripBtn, metadataRevertBtn,
//   metadataEditorCancel, metadataEditorSave
// Optional: metadataEditorStatus, metadataEditorFileName, advancedExifLibBtn.
//
// Load order: MemoStateDb + MemoCore + MemoLibraryPicker + MemoExifEdit, then
// this file. The picker should return one descriptor shaped like:
//   { entryId, index, ref, storedPath, url, mime, name }
// Legacy URL-only picker results are resolved against the live entry list too.
(function (global) {
  'use strict';

  var LIMITS = { description: 4000, creator: 500, copyright: 500 };
  var active = null;
  var activeBytes = null;
  var activeRun = 0;
  var busy = false;

  function el(id) { return document.getElementById(id); }
  function editorDialog() { return el('metadataEditorDlg'); }
  function core() { return global.MemoCore; }
  function stateDb() { return global.MemoStateDb; }
  function exif() { return global.MemoExifEdit; }

  function entries() {
    try { return (core() && core().getState().db.entries) || []; }
    catch (_error) { return []; }
  }

  function variant() {
    try {
      if (core() && typeof core().getVariant === 'function') return core().getVariant();
    } catch (_error) {}
    return global.MEMO_VARIANT === 'finance' ? 'finance' : 'default';
  }

  function mode() {
    try {
      if (global.MemoContracts && typeof global.MemoContracts.getMode === 'function') {
        return global.MemoContracts.getMode();
      }
    } catch (_error) {}
    return global.MODE || 'local';
  }

  function toast(message, options) {
    if (global.MemoShell && typeof global.MemoShell.toast === 'function') {
      global.MemoShell.toast(message, options || {});
      return;
    }
    setStatus(message, options && options.kind === 'error');
  }

  function setStatus(message, bad) {
    var node = el('metadataEditorStatus');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
    node.style.color = bad ? 'var(--danger)' : '';
  }

  function setBusy(value, message) {
    busy = !!value;
    var editable = !!(active && active.supported && activeBytes);
    var save = el('metadataEditorSave');
    if (save) save.disabled = busy || !editable;
    var strip = el('metadataStripBtn');
    if (strip) strip.disabled = busy || !editable;
    var revert = el('metadataRevertBtn');
    if (revert) revert.disabled = busy || !editable || !hasBackup(active && active.entry, active && active.metaKey);
    ['metadataEditorCancel', 'metadataEditorClose'].forEach(function (id) {
      var node = el(id); if (node) node.disabled = busy;
    });
    if (message !== undefined) setStatus(message, false);
  }

  function showDialog() {
    var dialog = editorDialog();
    if (!dialog || dialog.open) return !!dialog;
    try { dialog.showModal(); }
    catch (_error) { dialog.setAttribute('open', ''); }
    return true;
  }

  function closeDialog() {
    if (busy) return false;
    var dialog = editorDialog();
    if (!dialog || !dialog.open) return true;
    try { dialog.close(); }
    catch (_error) { dialog.removeAttribute('open'); }
    return true;
  }

  function canViewEntry(entry) {
    if (!entry || entry.deletedAt) return false;
    try {
      if (global.MemoPrivacy && typeof global.MemoPrivacy.canViewEntry === 'function') {
        return !!global.MemoPrivacy.canViewEntry(entry);
      }
    } catch (_error) { return false; }
    return true;
  }

  function localDbReady(db) {
    return !!(db && typeof db.ready === 'function' && db.ready()
      && typeof db.readBlob === 'function' && typeof db.writeBlob === 'function');
  }

  function normalizeStoredPath(value, db) {
    if (!value || typeof value !== 'string' || /^(blob:|data:)/i.test(value)) return '';
    var path = value;
    if (db && typeof db.urlToRel === 'function') {
      try { path = db.urlToRel(path); } catch (_error) {}
    } else {
      try {
        if (/^[a-z][a-z0-9+.-]*:/i.test(path)) path = new URL(path, global.location && global.location.href).pathname;
      } catch (_error) {}
      path = path.replace(/^\/+/, '');
    }
    path = String(path || '').split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/^\/+/, '');
    if (path.indexOf('uploads/') !== 0 || path.indexOf('\0') >= 0) return '';
    var parts = path.split('/');
    if (parts.some(function (part) { return !part || part === '.' || part === '..'; })) return '';
    return path;
  }

  function entryPaths(entry, db) {
    var stored = Array.isArray(entry && entry._storedPaths) ? entry._storedPaths : [];
    var images = Array.isArray(entry && entry.images) ? entry.images : [];
    var count = Math.max(stored.length, images.length);
    var output = [];
    for (var index = 0; index < count; index++) {
      output.push(normalizeStoredPath(stored[index], db) || normalizeStoredPath(images[index], db));
    }
    return output;
  }

  function firstSelection(value) {
    if (Array.isArray(value)) return value[0] || null;
    if (value && Array.isArray(value.items)) return value.items[0] || null;
    if (value && value.selection) return firstSelection(value.selection);
    return value || null;
  }

  function findStringTarget(ref, liveEntries, db) {
    var normalizedRef = normalizeStoredPath(ref, db);
    for (var entryIndex = 0; entryIndex < liveEntries.length; entryIndex++) {
      var entry = liveEntries[entryIndex];
      if (!canViewEntry(entry)) continue;
      var paths = entryPaths(entry, db);
      for (var imageIndex = 0; imageIndex < Math.max(paths.length, (entry.images || []).length); imageIndex++) {
        if ((entry.images && entry.images[imageIndex] === ref)
            || (normalizedRef && paths[imageIndex] === normalizedRef)) {
          return { entry: entry, index: imageIndex, storedPath: paths[imageIndex] || '', ref: ref };
        }
      }
    }
    return null;
  }

  // Re-resolve every descriptor against live state. A stable path wins over a
  // stale slot index after the user reorders an entry's images.
  function resolveTarget(input) {
    input = firstSelection(input);
    var db = stateDb();
    var liveEntries = entries();
    var found = null;
    if (typeof input === 'string') {
      found = findStringTarget(input, liveEntries, db);
      if (!found) return { supported: false, reason: 'The selected library image is no longer available.' };
    } else if (input && typeof input === 'object') {
      if (input.target && typeof input.target === 'object') input = input.target;
      var entryId = input.entryId || (input.entry && input.entry.id) || input.memoId || '';
      var entry = liveEntries.find(function (candidate) { return candidate && candidate.id === entryId; });
      if (!entry || !canViewEntry(entry)) {
        return { supported: false, reason: 'The selected image is not available in the current privacy view.' };
      }
      var paths = entryPaths(entry, db);
      var requestedPath = normalizeStoredPath(input.storedPath || input.path || '', db);
      var requestedIndex = Number(input.index);
      var index = Number.isInteger(requestedIndex) && requestedIndex >= 0 ? requestedIndex : -1;
      if (requestedPath) {
        var currentIndex = paths.indexOf(requestedPath);
        if (currentIndex < 0) {
          return { supported: false, reason: 'This image has moved or was replaced since it was selected.' };
        }
        index = currentIndex;
      }
      if (index < 0 && input.ref) {
        index = (entry.images || []).indexOf(input.ref);
        if (index < 0) index = paths.indexOf(normalizeStoredPath(input.ref, db));
      }
      if (index < 0 || index >= Math.max(paths.length, (entry.images || []).length)) {
        return { supported: false, reason: 'The selected image slot no longer exists.' };
      }
      found = {
        entry: entry,
        index: index,
        storedPath: paths[index] || '',
        ref: input.ref || input.url || input.src || (entry.images && entry.images[index]) || '',
        name: input.name || '',
        mime: input.mime || input.type || ''
      };
    }
    if (!found) return { supported: false, reason: 'Choose a JPEG from your memo library first.' };

    var path = found.storedPath;
    var fileName = found.name;
    if (!fileName && path) {
      try { fileName = decodeURIComponent(path.split('/').pop()); }
      catch (_error) { fileName = path.split('/').pop(); }
    }
    var result = {
      entryId: found.entry.id,
      entry: found.entry,
      index: found.index,
      ref: found.ref,
      storedPath: path,
      metaKey: path || ('slot:' + found.index),
      name: fileName || ('Image ' + (found.index + 1)),
      mime: found.mime || '',
      supported: false,
      reason: ''
    };
    if (mode() === 'server') {
      result.reason = 'This image is stored on the server. Embedded metadata editing is currently available for JPEGs kept in this device\'s local library.';
    } else if (!path) {
      result.reason = 'This linked or temporary image has no writable local file. Save it into the memo library before editing its embedded metadata.';
    } else if (!localDbReady(db)) {
      result.reason = 'Local image storage is unavailable right now. The image was left unchanged.';
    } else {
      result.supported = true;
    }
    return result;
  }

  function exifDateToLocal(value) {
    var match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(value || '');
    return match ? match[1] + '-' + match[2] + '-' + match[3] + 'T' + match[4] + ':' + match[5] : '';
  }

  function localToExifDate(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
    return match ? match[1] + ':' + match[2] + ':' + match[3] + ' ' + match[4] + ':' + match[5] + ':00' : '';
  }

  function u8ToBase64(bytes) {
    var binary = '';
    var chunk = 0x8000;
    for (var offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  function base64ToU8(value) {
    var binary = atob(value || '');
    var output = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index++) output[index] = binary.charCodeAt(index);
    return output;
  }

  function imageMetaRecord(entry, key) {
    var map = entry && entry.imageMeta;
    var record = map && typeof map === 'object' ? map[key] : null;
    return record && typeof record === 'object' ? record : null;
  }

  function hasBackup(entry, key) {
    var record = imageMetaRecord(entry, key);
    return !!(record && typeof record.embeddedBackup === 'string');
  }

  function cloneImageMeta(entry) {
    var source = entry && entry.imageMeta && typeof entry.imageMeta === 'object' ? entry.imageMeta : {};
    var output = {};
    Object.keys(source).forEach(function (key) {
      var value = source[key];
      output[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.assign({}, value)
        : value;
    });
    return output;
  }

  function setImageMetaRecord(entry, key, record) {
    var map = cloneImageMeta(entry);
    if (record && Object.keys(record).length) map[key] = record;
    else delete map[key];
    entry.imageMeta = Object.keys(map).length ? map : {};
  }

  function renderReadonly(rows) {
    var grid = el('metadataReadonlyGrid');
    if (grid) {
      grid.replaceChildren();
      rows.forEach(function (row) {
        var key = document.createElement('div');
        key.className = 'image-info-key';
        key.textContent = row[0];
        var value = document.createElement('div');
        value.className = 'image-info-value';
        value.textContent = row[1];
        grid.append(key, value);
      });
    }
    var section = el('metadataReadonlySection');
    if (section) section.hidden = !rows.length;
  }

  function resetFields() {
    ['metadataDescription', 'metadataCreator', 'metadataCopyright', 'metadataCapturedAt'].forEach(function (id) {
      var input = el(id);
      if (input) input.value = '';
    });
    renderReadonly([]);
    var fields = el('metadataEmbeddedFields');
    if (fields) fields.hidden = true;
    var unsupported = el('metadataUnsupported');
    if (unsupported) { unsupported.hidden = true; unsupported.textContent = ''; }
    var strip = el('metadataStripBtn');
    if (strip) strip.hidden = true;
    var revert = el('metadataRevertBtn');
    if (revert) revert.hidden = true;
    var privacy = el('metadataPrivacyActions');
    if (privacy) privacy.hidden = true;
    var fileName = el('metadataEditorFileName');
    if (fileName) fileName.textContent = '';
  }

  function renderUnsupported(reason, target) {
    activeBytes = null;
    var fields = el('metadataEmbeddedFields');
    if (fields) fields.hidden = true;
    var unsupported = el('metadataUnsupported');
    if (unsupported) { unsupported.hidden = false; unsupported.textContent = reason; }
    renderReadonly([]);
    var privacy = el('metadataPrivacyActions');
    if (privacy) privacy.hidden = true;
    var save = el('metadataEditorSave');
    if (save) save.disabled = true;
    var fileName = el('metadataEditorFileName');
    if (fileName) fileName.textContent = target && target.name || '';
    setStatus(reason, true);
  }

  function renderEmbedded(target, bytes) {
    var engine = exif();
    var embedded = engine.readEmbedded(bytes);
    var fields = embedded.fields || {};
    var node = el('metadataDescription'); if (node) node.value = fields.description || '';
    node = el('metadataCreator'); if (node) node.value = fields.artist || '';
    node = el('metadataCopyright'); if (node) node.value = fields.copyright || '';
    node = el('metadataCapturedAt'); if (node) node.value = exifDateToLocal(fields.dateTime);
    var fieldsHost = el('metadataEmbeddedFields');
    if (fieldsHost) fieldsHost.hidden = false;
    var unsupported = el('metadataUnsupported');
    if (unsupported) unsupported.hidden = true;
    renderReadonly([
      ['Camera make', fields.make],
      ['Camera model', fields.model],
      ['Software', fields.software]
    ].filter(function (row) { return !!row[1]; }));
    var privacy = el('metadataPrivacyActions');
    if (privacy) privacy.hidden = false;
    var strip = el('metadataStripBtn');
    if (strip) strip.hidden = !(embedded.hasGps || embedded.hasDevice);
    var revert = el('metadataRevertBtn');
    if (revert) revert.hidden = !hasBackup(target.entry, target.metaKey);
    var save = el('metadataEditorSave');
    if (save) save.disabled = false;
    var fileName = el('metadataEditorFileName');
    if (fileName) fileName.textContent = target.name || '';
    setStatus('', false);
  }

  async function loadTarget(input, run) {
    var target = resolveTarget(input);
    active = target;
    activeBytes = null;
    if (!target.supported) {
      if (run === activeRun) renderUnsupported(target.reason, target);
      return false;
    }
    var db = stateDb();
    var blob;
    try { blob = await db.readBlob(target.storedPath); }
    catch (_error) { blob = null; }
    if (run !== activeRun) return false;
    if (!blob) {
      target.supported = false;
      target.reason = 'The local image file is missing or cannot be read. The image was left unchanged.';
      renderUnsupported(target.reason, target);
      return false;
    }
    var bytes = new Uint8Array(await blob.arrayBuffer());
    if (run !== activeRun) return false;
    if (!exif() || !exif().isJpeg(bytes)) {
      target.supported = false;
      target.reason = 'Embedded-metadata editing is available for JPEG images. This file was left unchanged.';
      renderUnsupported(target.reason, target);
      return false;
    }
    target.mime = blob.type || target.mime || 'image/jpeg';
    activeBytes = bytes;
    renderEmbedded(target, bytes);
    return true;
  }

  async function open(input) {
    if (!editorDialog()) {
      toast('The embedded metadata editor is unavailable right now.', { kind: 'error' });
      return false;
    }
    var run = ++activeRun;
    active = null;
    activeBytes = null;
    resetFields();
    showDialog();
    setBusy(true, 'Reading embedded metadata…');
    try { return await loadTarget(input, run); }
    catch (error) {
      if (run === activeRun) renderUnsupported('Could not read this image safely. The image was left unchanged.', active);
      console.error('[EXIF editor] open failed:', error);
      return false;
    } finally {
      if (run === activeRun) setBusy(false);
    }
  }

  function resolveLiveActive() {
    if (!active) return { supported: false, reason: 'No image is selected.' };
    return resolveTarget({
      entryId: active.entryId,
      index: active.index,
      storedPath: active.storedPath,
      ref: active.ref,
      name: active.name,
      mime: active.mime
    });
  }

  async function persistEntryState(db) {
    if (!localDbReady(db) || typeof db.saveEntries !== 'function') {
      throw new Error('The local metadata database is unavailable.');
    }
    db.saveEntries(entries(), variant());
    if (typeof db.flush === 'function') await db.flush();
  }

  async function refreshImage(target, db) {
    try {
      if (typeof db.hydrateImageAt === 'function') {
        await db.hydrateImageAt(target.entry, target.index, target.storedPath);
      } else if (typeof db.blobUrl === 'function') {
        var url = await db.blobUrl(target.storedPath);
        if (url && target.entry.images) target.entry.images[target.index] = url;
      }
    } catch (error) {
      // Cache refresh is recoverable: the stable stored path remains valid and
      // normal mounted-image hydration will retry it. Never turn a durable byte
      // rewrite into a failed metadata transaction because a Blob URL failed.
      console.warn('[EXIF editor] image cache refresh will retry later:', error);
    }
    try { if (core() && typeof core().renderFeed === 'function') core().renderFeed(); } catch (_error) {}
    try {
      if (core() && typeof core().hydrateMountedImages === 'function') await core().hydrateMountedImages(document);
    } catch (_error) {}
  }

  // MemoCore owns the media-update journal shape. It saves + flushes SQLite,
  // queues rewritten media for upload, and repaints the feed. Keep a local-only
  // fallback so the editor remains safe during partial/older-script loads.
  async function persistMediaMutation(target, db) {
    // Establish the local commit independently of the journal helper. If queue
    // setup fails afterwards, the successfully rewritten local JPEG and its
    // revert backup must not be reported as a failed/corrupt edit.
    await persistEntryState(db);
    if (core() && typeof core().persistEntryMediaMutation === 'function') {
      try { await core().persistEntryMediaMutation(target.entry); }
      catch (error) {
        console.warn('[EXIF editor] edit is durable locally, but media sync could not be queued:', error);
        try {
          global.dispatchEvent(new CustomEvent('memo:exif-sync-pending', {
            detail: { entryId: target.entryId, index: target.index, storedPath: target.storedPath }
          }));
        } catch (_eventError) {}
      }
      return;
    }
    try { if (core() && typeof core().renderFeed === 'function') core().renderFeed(); } catch (_error) {}
  }

  async function notifyMutation(target, action) {
    try {
      global.dispatchEvent(new CustomEvent('memo:exif-updated', {
        detail: {
          action: action,
          entryId: target.entryId,
          index: target.index,
          storedPath: target.storedPath
        }
      }));
    } catch (_error) {}
  }

  async function applyEmbeddedEdit(strip) {
    if (busy) return false;
    var target = resolveLiveActive();
    var db = stateDb();
    var engine = exif();
    if (!target.supported || !engine || !localDbReady(db)) {
      renderUnsupported(target.reason || 'This image cannot be edited locally.', target);
      return false;
    }
    setBusy(true, strip ? 'Removing EXIF GPS data and selected camera identifiers…' : 'Saving embedded metadata…');
    try {
      var blob = await db.readBlob(target.storedPath);
      if (!blob) throw new Error('The stored JPEG is unavailable.');
      var bytes = new Uint8Array(await blob.arrayBuffer());
      if (!engine.isJpeg(bytes)) throw new Error('The stored file is no longer a JPEG.');

      // Persist the original segments BEFORE touching the source blob. Empty
      // string is an intentional backup: it means the original had no embedded
      // metadata and revert must remove all newly-created metadata segments.
      var record = Object.assign({}, imageMetaRecord(target.entry, target.metaKey) || {});
      if (typeof record.embeddedBackup !== 'string') {
        var captured = engine.captureMetadataSegments(bytes) || new Uint8Array(0);
        record.embeddedBackup = u8ToBase64(captured);
        record.embeddedBackupCapturedAt = new Date().toISOString();
        setImageMetaRecord(target.entry, target.metaKey, record);
        await persistEntryState(db);
      }

      var description = el('metadataDescription');
      var creator = el('metadataCreator');
      var copyright = el('metadataCopyright');
      var capturedAt = el('metadataCapturedAt');
      var edits = {
        description: String(description && description.value || '').trim().slice(0, LIMITS.description),
        artist: String(creator && creator.value || '').trim().slice(0, LIMITS.creator),
        copyright: String(copyright && copyright.value || '').trim().slice(0, LIMITS.copyright),
        dateTime: localToExifDate(capturedAt && capturedAt.value || '')
      };
      if (strip) { edits.stripGps = true; edits.stripDevice = true; }
      var output = engine.writeEmbedded(bytes, edits);
      if (!output) throw new Error('EXIF rewrite failed.');
      await db.writeBlob(target.storedPath, new Blob([output], { type: blob.type || target.mime || 'image/jpeg' }));

      record = Object.assign({}, imageMetaRecord(target.entry, target.metaKey) || record);
      record.embeddedEditedAt = new Date().toISOString();
      setImageMetaRecord(target.entry, target.metaKey, record);
      target.entry.updatedAt = record.embeddedEditedAt;
      await refreshImage(target, db);
      await persistMediaMutation(target, db);
      await notifyMutation(target, strip ? 'strip' : 'save');
      busy = false;
      closeDialog();
      toast(strip
        ? 'EXIF GPS data and selected camera identifiers removed. XMP and IPTC were not changed.'
        : 'Embedded metadata updated.');
      return true;
    } catch (error) {
      console.error('[EXIF editor] save failed:', error);
      var revert = el('metadataRevertBtn');
      if (revert && hasBackup(target.entry, target.metaKey)) revert.hidden = false;
      setStatus('Could not update embedded metadata. The original backup was kept.', true);
      toast('Could not update embedded metadata.', { kind: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function revertEmbedded() {
    if (busy) return false;
    var target = resolveLiveActive();
    var db = stateDb();
    var engine = exif();
    var record = target.supported && imageMetaRecord(target.entry, target.metaKey);
    if (!target.supported || !engine || !record || typeof record.embeddedBackup !== 'string') return false;
    setBusy(true, 'Restoring original embedded metadata…');
    try {
      var blob = await db.readBlob(target.storedPath);
      if (!blob) throw new Error('The stored JPEG is unavailable.');
      var bytes = new Uint8Array(await blob.arrayBuffer());
      var output = engine.restoreMetadataSegments(bytes, base64ToU8(record.embeddedBackup));
      if (!output) throw new Error('Embedded metadata restore failed.');
      await db.writeBlob(target.storedPath, new Blob([output], { type: blob.type || target.mime || 'image/jpeg' }));

      var nextRecord = Object.assign({}, record);
      delete nextRecord.embeddedBackup;
      delete nextRecord.embeddedBackupCapturedAt;
      delete nextRecord.embeddedEditedAt;
      setImageMetaRecord(target.entry, target.metaKey, nextRecord);
      target.entry.updatedAt = new Date().toISOString();
      await refreshImage(target, db);
      await persistMediaMutation(target, db);
      await notifyMutation(target, 'revert');
      busy = false;
      closeDialog();
      toast('Reverted to the original embedded metadata.');
      return true;
    } catch (error) {
      console.error('[EXIF editor] revert failed:', error);
      setStatus('Could not restore the original embedded metadata.', true);
      toast('Could not revert embedded metadata.', { kind: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function pickFromLibrary(options) {
    options = options || {};
    var picker = global.MemoLibraryPicker;
    if (!picker || typeof picker.open !== 'function') {
      toast('The library picker is unavailable right now.', { kind: 'error' });
      return false;
    }
    picker.open({
      mode: 'single',
      filter: 'jpeg',
      mediaType: 'jpeg',
      selectionUnit: 'image',
      returnDescriptors: true,
      min: 1,
      title: options.title || 'Pick a JPEG from your library',
      onDone: function (selection, descriptor) {
        var target = firstSelection(descriptor || selection);
        if (target) void open(target);
      }
    });
    return true;
  }

  function openForEntry(entryId, index) {
    return open({ entryId: entryId, index: Number.isInteger(index) ? index : 0 });
  }

  function wire() {
    var close = el('metadataEditorClose');
    if (close) close.addEventListener('click', closeDialog);
    var cancel = el('metadataEditorCancel');
    if (cancel) cancel.addEventListener('click', closeDialog);
    var save = el('metadataEditorSave');
    if (save) save.addEventListener('click', function () { void applyEmbeddedEdit(false); });
    var strip = el('metadataStripBtn');
    if (strip) strip.addEventListener('click', function () { void applyEmbeddedEdit(true); });
    var revert = el('metadataRevertBtn');
    if (revert) revert.addEventListener('click', function () { void revertEmbedded(); });
    var library = el('advancedExifLibBtn');
    if (library) library.addEventListener('click', function () { pickFromLibrary(); });
    var dialog = editorDialog();
    if (dialog) {
      dialog.addEventListener('cancel', function (event) { if (busy) event.preventDefault(); });
      dialog.addEventListener('close', function () {
        activeRun++;
        active = null;
        activeBytes = null;
        setStatus('', false);
      });
    }
    global.addEventListener('memo:open-exif-editor', function (event) {
      if (event && event.detail) void open(event.detail);
      else pickFromLibrary();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoExifEditor = {
    open: open,
    openForEntry: openForEntry,
    pickFromLibrary: pickFromLibrary,
    save: function () { return applyEmbeddedEdit(false); },
    stripPrivacy: function () { return applyEmbeddedEdit(true); },
    revert: revertEmbedded,
    resolveTarget: resolveTarget,
    getCurrentTarget: function () {
      if (!active) return null;
      return {
        entryId: active.entryId,
        index: active.index,
        ref: active.ref,
        storedPath: active.storedPath,
        metaKey: active.metaKey,
        name: active.name,
        mime: active.mime,
        supported: active.supported,
        reason: active.reason
      };
    }
  };
})(window);
