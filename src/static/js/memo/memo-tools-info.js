// memo-tools-info.js — "Image information" plus Memora's existing per-image
// editors, registered into the Tools sheet so one sheet lists everything that
// can be done with an image. The information is read on the device from the
// stored file (MemoExifEdit parses the JPEG header); nothing is changed.
(function (global) {
  'use strict';
  const T = global.MemoTools;
  if (!T) return;
  const { tr, element, result } = T;

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[unit];
  }
  function formatDate(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    try { return date.toLocaleString(global.MemoI18n?.getLocale?.() || undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_e) { return date.toISOString(); }
  }
  // EXIF "2026:10:14 09:12:30" → a local date.
  function exifDate(value) {
    const match = String(value || '').match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    return match ? new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] || 0)) : null;
  }
  const MIME_NAMES = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/gif': 'GIF', 'image/heic': 'HEIC', 'image/bmp': 'BMP', 'image/avif': 'AVIF' };

  async function storedBlob(target) {
    if (target.storedPath && global.MemoStateDb?.readBlob && global.MemoContracts?.getMode?.() !== 'server') {
      const blob = await global.MemoStateDb.readBlob(target.storedPath).catch(() => null);
      if (blob) return blob;
    }
    try { const response = await fetch(target.url); return response.ok ? await response.blob() : null; }
    catch (_e) { return null; }
  }

  async function collect(target) {
    const entry = global.MemoCore?.getState?.().db.entries.find(item => String(item.id) === String(target.entryId));
    const blob = await storedBlob(target);
    const rows = [];
    const add = (label, value) => { if (value != null && value !== '') rows.push([label, String(value)]); };
    const mime = (blob && blob.type) || target.mime;
    add(tr('Type'), MIME_NAMES[mime] || mime || '');
    if (blob) add(tr('File size'), formatBytes(blob.size));
    try {
      const image = await T.loadFullImage(target);
      add(tr('Dimensions'), `${image.naturalWidth} × ${image.naturalHeight}` +
        ` (${(image.naturalWidth * image.naturalHeight / 1e6).toFixed(1)} MP)`);
    } catch (_e) { /* a broken file still shows what is known */ }
    if (entry?.ts) add(tr('Added to Memora'), formatDate(entry.ts));
    const camera = [];
    if (blob && /jpe?g/i.test(mime) && global.MemoExifEdit?.readEmbedded) {
      try {
        const info = global.MemoExifEdit.readEmbedded(new Uint8Array(await blob.arrayBuffer()));
        const fields = info.fields || {};
        add(tr('Taken'), formatDate(exifDate(fields.dateTime)));
        add(tr('Camera'), [fields.make, fields.model].filter(Boolean).join(' ').trim());
        add(tr('Software'), fields.software);
        add(tr('Description in the file'), fields.description);
        add(tr('Location in the file'), info.hasExif ? (info.hasGps ? tr('Yes — removed only if you strip it') : tr('No')) : '');
        if (info.hasGps) camera.push('gps');
      } catch (_e) { /* not a readable JPEG header */ }
    }
    add(tr('Stored as'), target.storedPath ? target.storedPath.split('/').pop() : '');
    return { rows, gps: camera.includes('gps') };
  }

  async function showInformation(target) {
    result.open(tr('Image information'));
    result.busy(tr('Reading the file…'));
    const info = await collect(target);
    if (!result.isOpen) return;
    const grid = element('dl', 'tool-info-grid');
    for (const [label, value] of info.rows) {
      grid.append(element('dt', '', label), element('dd', '', value));
    }
    result.show(grid);
    const actions = [];
    if (global.MemoExifEditor?.openForEntry && /jpe?g/i.test(target.mime) && target.entryId != null) {
      actions.push({ label: info.gps ? tr('Remove location…') : tr('Edit metadata'), primary: info.gps, run: () => {
        result.close();
        global.MemoExifEditor.openForEntry(target.entryId, target.index);
      } });
    }
    result.actions(actions);
  }

  const INFO_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.1"/></svg>';

  T.register({
    id: 'image-info', group: 'find', icon: INFO_ICON,
    label: ['', 'Image information'],
    run: showInformation,
  });
  T.register({
    id: 'image-editor', group: 'edit', icon: 'svg-icon-edit',
    label: ['', 'Image Editor'],
    available: target => !!global.MemoImageEditor && target.entryId != null && T.stillImage(target),
    run: target => {
      const entry = global.MemoCore?.getState?.().db.entries.find(item => String(item.id) === String(target.entryId));
      if (entry) global.MemoImageEditor.openEntry(entry, target.index);
    },
  });
  T.register({
    id: 'edit-metadata', group: 'share', icon: 'svg-icon-settings',
    label: ['', 'Edit metadata'],
    available: target => !!global.MemoExifEditor?.openForEntry && target.entryId != null && /jpe?g/i.test(target.mime || ''),
    run: target => global.MemoExifEditor.openForEntry(target.entryId, target.index),
  });
})(window);
