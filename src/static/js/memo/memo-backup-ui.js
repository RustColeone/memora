// memo-backup-ui.js — the shared Data Backup UI (whole-DB export + size-capped
// import), loaded by memo, finance AND planner so the backup panel is identical
// on every page, with verified backups and a single recoverable restore.
(function () {
  'use strict';
  const Contracts = window.MemoContracts || null;
  const Runtime = window.MemoRuntime || null;
  const getMode = () => Contracts ? Contracts.getMode() : (window.MODE || 'local');
  const getApiBase = () => Runtime ? Runtime.getApiBase() : (Contracts ? Contracts.getApiBase() : '');
  const getVariant = () => Contracts ? Contracts.getVariant() : (window.MEMO_VARIANT || 'default');
  const getServerAPI = () => Runtime ? Runtime.getServerAPI() : ((Contracts && Contracts.getService && Contracts.getService('serverApi')) || null);
  const isCapacitorMode = window.CAP_BOOT || window.__CAP_MODE__;

  let importExportStatus = null; // resolved in init() once the DOM is ready

  const STATUS_GLYPH_ICON = { '✓': 'check', '✅': 'check', '✗': 'x', '❌': 'x', '⏳': 'clock' };
  const escStatusHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function showStatus(element, message, type = 'info') {
    if (!element) return;
    let msg = String(message);
    const icon = STATUS_GLYPH_ICON[msg.charAt(0)];
    if (icon) { msg = msg.slice(1).replace(/^\s+/, ''); element.innerHTML = `<span class="svg-icon svg-icon-${icon}"></span> ${escStatusHtml(msg)}`; }
    else { element.textContent = msg; }
    element.className = type;
    if (element === importExportStatus) element.style.display = 'block';
  }

  // After an import, refresh whichever page hosts this module.
  function refreshAfterImport() {
    window.MemoCore?.applyServerState?.();
    if (window.MemoVariant && window.MemoVariant.renderFeed) window.MemoVariant.renderFeed();
    if (window.Planner && window.Planner.Store && window.Planner.Store.reload) window.Planner.Store.reload();
  }

  // ===== export/import (extracted from memo-settings.js) =====
    async function handleExportData() {
      // Server mode: download the unified ZIP (memosystem.json + uploads/),
      // the same format the offline app produces and imports.
      if (getMode() === 'server') {
          showStatus(importExportStatus, 'Requesting server backup...', 'info');
          try {
            await download('/api/db/export?format=zip', 'memosystem_backup.zip');
            showStatus(importExportStatus, '✓ Backup download started.', 'success');
          } catch (error) { showStatus(importExportStatus, `✗ Export failed: ${error.message}`, 'error'); }
          return;
      }

      try {
        if (!window.JSZip) {
          showStatus(importExportStatus, '✗ Export requires JSZip library. Please check your internet connection or try disabling tracking prevention for this site.', 'error');
          return;
        }
        const password = await window.MemoStorageUI.askPassword({
          title: translate('Protect this backup'), confirm: true,
          message: translate('Choose a password for this backup. Without it the backup cannot be opened, and Memora cannot recover a forgotten password.'),
        });
        if (!password) { showStatus(importExportStatus, translate('Export cancelled.'), 'info'); return; }
        const result = await exportOfflineSizeCapped(password);
        // A scoped/date-limited export is useful, but it is not a complete
        // recovery point. Only a verified full-library set clears the nudge.
        if (result && result.fullLibrary) {
          try { localStorage.setItem('memo_backed_up', '1'); } catch (_e) {}
          if (window.updateBackupNudge) window.updateBackupNudge();
        }
      } catch (error) {
        console.error('Export error:', error);
        showStatus(importExportStatus, `✗ Export failed: ${error.message}`, 'error');
      }
    }

    async function download(path, filename) {
      // Use the shared authenticated fetch wrapper rather than navigating an
      // anchor directly: navigation cannot carry the sync password header.
      const response = await fetch(getApiBase() + path);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `Download failed (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function bytesToBase64(bytes) {
      let binary = '';
      const slice = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += slice) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + slice, bytes.length)));
      }
      return btoa(binary);
    }

    // A password-protected part is sealed (memo-crypto.js) and handed to
    // MemoStorageUI: Android collects the set for one share sheet, a browser
    // downloads it. Without a password (older callers) the plain ZIP path
    // below still applies.
    async function writeArchiveBytes(bytes, filename, password) {
      if (password) {
        await window.MemoStorageUI.stage(filename + '.memora', await window.MemoCrypto.encryptWithPassword(bytes, password));
        return;
      }
      if (isCapacitorMode) {
        const Filesystem = window.Capacitor.Plugins?.Filesystem || window.Capacitor.Filesystem;
        const chunkSize = 3 * 1024 * 1024; // multiple of 3: every Base64 chunk is independently valid
        const first = bytes.subarray(0, Math.min(chunkSize, bytes.length));
        await Filesystem.writeFile({ path: filename, data: bytesToBase64(first), directory: 'DOCUMENTS', recursive: true });
        if (typeof Filesystem.appendFile === 'function') {
          for (let offset = chunkSize; offset < bytes.length; offset += chunkSize) {
            await Filesystem.appendFile({
              path: filename,
              data: bytesToBase64(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))),
              directory: 'DOCUMENTS',
            });
          }
        } else if (bytes.length > chunkSize) {
          // Older Capacitor Filesystem implementations have no append API.
          await Filesystem.writeFile({ path: filename, data: bytesToBase64(bytes), directory: 'DOCUMENTS', recursive: true });
        }
      } else {
        const blob = new Blob([bytes], { type: 'application/zip' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 30000);
        // Give browsers a task boundary between automatic part downloads.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // Offline export with per-part SIZE caps — data protection when there is no
    // sync server. Reads each entry's stored blobs straight from app-private
    // storage (MemoStateDb), greedily packs entries into size-capped parts
    // (MemoBackup.planParts), and writes each part as a self-contained ZIP
    // (its own memosystem.json + uploads/). See memo-backup.js for the rationale.
    async function exportOfflineSizeCapped(password) {
      const stateDb = window.MemoStateDb;
      if (!(stateDb && typeof stateDb.ready === 'function' && stateDb.ready() && stateDb.exportBundle)) {
        throw new Error('Offline store is not ready');
      }
      if (!window.MemoBackup) throw new Error('MemoBackup module not loaded');

      showStatus(importExportStatus, 'Preparing export…', 'info');
      const bundle = stateDb.exportBundle(); // { version, memos, finance, planner }

      // Flatten every variant into one list, annotated with variant, timestamp,
      // stored-blob rel paths and total stored bytes. Blob.size is metadata, so
      // summing sizes here copies no image bytes into memory. Planner docs carry
      // no blobs (0 bytes), but are still packed so a backup is the whole DB.
      const isoMs = (s) => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };

      // Scope controls (optional): which variants to include + a date range.
      // Absent controls or all-checked = a full backup. A dateless entry (ts 0)
      // is always kept, since a range can't meaningfully exclude it.
      const chk = (id) => { const el = document.getElementById(id); return !el || el.checked; };
      const includeVariant = { default: chk('exportInclMemos'), finance: chk('exportInclFinance'), planner: chk('exportInclPlanner') };
      const fromEl = document.getElementById('exportRangeFrom');
      const toEl = document.getElementById('exportRangeTo');
      const fromMs = fromEl && fromEl.value ? isoMs(fromEl.value) : null;
      const toMs = toEl && toEl.value ? (isoMs(toEl.value) + 86400000 - 1) : null;

      const groups = [['default', bundle.memos || []], ['finance', bundle.finance || []], ['planner', bundle.planner || []]];
      const items = [];
      const missingReferencedBlobs = [];
      for (const [variant, list] of groups) {
        if (!includeVariant[variant]) continue;
        for (const e of list) {
          const ts = (typeof e.ts === 'number' ? e.ts : isoMs(e.createdAt)) || 0;
          if (ts) {
            if (fromMs != null && ts < fromMs) continue;
            if (toMs != null && ts > toMs) continue;
          }
          const rels = window.MemoBackup.collectEntryRels(e);
          const present = [];
          let bytes = 0;
          for (const rel of rels) {
            let b = null;
            try { b = await stateDb.readBlob(rel); }
            catch (_e) { /* recorded below as an incomplete recovery point */ }
            if (b) {
              const maxMember = window.MemoBackup.getMaxImportMemberBytes();
              if (b.size > maxMember) {
                throw new Error(`Cannot export ${rel}: its ${Math.ceil(b.size / (1024 * 1024))} MiB file exceeds the ${maxMember / (1024 * 1024)} MiB safe per-file limit`);
              }
              bytes += b.size;
              present.push(rel);
            } else missingReferencedBlobs.push(rel);
          }
          items.push({ entry: e, variant, ts, rels: present, bytes });
        }
      }

      if (!items.length) {
        showStatus(importExportStatus, 'Nothing to export for the selected scope.', 'info');
        return { fullLibrary: false, parts: 0 };
      }

      // Assistant chat history (per variant) rides in part 1, scoped like the
      // entries: only included variants, and only messages inside the range.
      const chat = {};
      for (const [variant, list] of Object.entries(bundle.chat || {})) {
        if (includeVariant[variant] === false || (!(variant in includeVariant) && !(includeVariant.default && includeVariant.finance && includeVariant.planner))) continue;
        const kept = list.filter(m => { const t = isoMs(m.ts); return !t || ((fromMs == null || t >= fromMs) && (toMs == null || t <= toMs)); });
        if (kept.length) chat[variant] = kept;
      }

      const parts = window.MemoBackup.planParts(items, window.MemoBackup.getPartCap());
      const total = parts.length;
      const createdAt = new Date().toISOString();
      const stamp = createdAt.split('T')[0];
      const backupId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const setToken = backupId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || Date.now().toString(36);
      const fullScope = includeVariant.default && includeVariant.finance && includeVariant.planner
        && fromMs == null && toMs == null;
      const fullLibrary = fullScope && missingReferencedBlobs.length === 0;
      const counts = { memos: 0, finance: 0, planner: 0 };
      items.forEach(it => { counts[it.variant === 'default' ? 'memos' : it.variant]++; });
      const partRecords = [];

      for (let p = 0; p < total; p++) {
        const part = parts[p];
        const zip = new JSZip();
        const uploads = zip.folder('uploads');
        const sub = {
          version: 1,
          exported_at: createdAt,
          backup_set: { id: backupId, part: p + 1, parts: total },
          memos: [], finance: [], planner: []
        };
        // App-wide document collections (the Vault, still encrypted) ride in the first part.
        if (p === 0) { sub.chat = chat; sub.docs = bundle.docs || {}; if (includeVariant.default) sub.savedSearches = bundle.savedSearches || []; }
        const addedRels = new Set();
        let minTs = Infinity, maxTs = -Infinity;

        for (const it of part) {
          const bucket = it.variant === 'finance' ? sub.finance : (it.variant === 'planner' ? sub.planner : sub.memos);
          bucket.push(it.entry);
          if (it.ts) { if (it.ts < minTs) minTs = it.ts; if (it.ts > maxTs) maxTs = it.ts; }
          for (const rel of it.rels) {
            if (addedRels.has(rel)) continue;
            addedRels.add(rel);
            const b = await stateDb.readBlob(rel);
            if (!b) throw new Error(`Backup source disappeared while exporting: ${rel}`);
            uploads.file(rel.replace(/^uploads\//, ''), b);
          }
        }
        if (!isFinite(minTs)) { minTs = maxTs = Date.now(); }

        zip.file('memosystem.json', JSON.stringify(sub, null, 2));
        const fname = window.MemoBackup.partName(p + 1, minTs, maxTs, setToken);

        showStatus(importExportStatus, `Writing part ${p + 1} / ${total}…`, 'info');

        // STORE (level 0): media is already compressed. Generate one bounded
        // part, hash it, write it, then release it before building the next.
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
        partRecords.push({
          name: fname,
          part: p + 1,
          bytes: bytes.byteLength,
          sha256: await window.MemoBackup.sha256Bytes(bytes),
          counts: { memos: sub.memos.length, finance: sub.finance.length, planner: sub.planner.length },
        });
        await writeArchiveBytes(bytes, fname, password);
      }

      // The manifest is written last: only after every data part has generated,
      // hashed, and written successfully can this set be considered complete.
      const manifest = {
        type: 'memosystem-backup-set',
        version: 1,
        id: backupId,
        created_at: createdAt,
        full_library: fullLibrary,
        counts,
        missing_blobs: Array.from(new Set(missingReferencedBlobs)),
        parts: partRecords,
      };
      const manifestZip = new JSZip();
      manifestZip.file(window.MemoBackup.manifestFile, JSON.stringify(manifest, null, 2));
      const manifestBytes = await manifestZip.generateAsync({ type: 'uint8array', compression: 'STORE' });
      const manifestName = `memoSystem-backup-00_manifest_${stamp}_${setToken}.zip`;
      await writeArchiveBytes(manifestBytes, manifestName, password);
      if (password) await window.MemoStorageUI.finish(translate('Share backup'));

      const scopeNote = fullLibrary
        ? 'Verified full-library set.'
        : 'Scoped or incomplete set — the full-backup reminder remains active.';
      showStatus(importExportStatus, `✓ Export complete — ${total} data part${total === 1 ? '' : 's'} plus manifest written. ${scopeNote}`, 'success');
      return { fullLibrary, parts: total, manifest: manifestName };
    }


    const translate = (key, vars) => window.MemoI18n?.t(key, vars) || key;
    let restoring = false;

    async function verifyManifest(zip) {
      const member = zip.file('manifest.json');
      if (!member) return;
      const manifest = JSON.parse(await member.async('string'));
      const names = Object.keys(zip.files).filter(name => !zip.files[name].dir && name !== 'manifest.json');
      if (!Array.isArray(manifest.files) || manifest.files.length !== names.length ||
          new Set(manifest.files.map(file => file.path)).size !== names.length) throw new Error('Incomplete backup manifest');
      for (const file of manifest.files) {
        if (!names.includes(file.path)) throw new Error('Unexpected backup manifest member');
        const bytes = await zip.file(file.path).async('uint8array');
        const hash = await MemoBackup.sha256Bytes(bytes);
        if (bytes.length !== file.size || hash !== file.sha256) throw new Error('Backup checksum mismatch');
      }
    }

    function validateRecords(bundle) {
      if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || (bundle.version || 1) !== 1) throw new Error('Unsupported backup format');
      for (const key of ['memos', 'finance', 'planner']) {
        if (bundle[key] != null && (!Array.isArray(bundle[key]) || bundle[key].some(entry => !entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id)))
          throw new Error('Invalid ' + key + ' records in backup');
      }
      if (bundle.chat != null && (typeof bundle.chat !== 'object' || Array.isArray(bundle.chat) || Object.values(bundle.chat).some(list =>
        !Array.isArray(list) || list.some(m => !m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id))))
        throw new Error('Invalid chat records in backup');
      if (bundle.savedSearches != null && (!Array.isArray(bundle.savedSearches) || bundle.savedSearches.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string')))
        throw new Error('Invalid saved searches in backup');
      if (bundle.docs != null && (typeof bundle.docs !== 'object' || Array.isArray(bundle.docs) || Object.values(bundle.docs).some(list =>
        !Array.isArray(list) || list.some(d => !d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id))))
        throw new Error('Invalid document records in backup');
    }

    // Sniff each chosen file: a Memora envelope is decrypted (one password
    // for the whole set) back into the ZIP it was made from, keeping its
    // original name so the set verification below is unchanged. A database
    // file, plain or sealed, is refused: it carries no images, so restoring it
    // on another phone would look like lost photos. Backups are the one route.
    const SQLITE_MAGIC = 'SQLite format 3\u0000';
    const isSqlite = bytes => bytes.length >= 16 && String.fromCharCode.apply(null, bytes.subarray(0, 16)) === SQLITE_MAGIC;
    async function prepareImportFiles(files) {
      const out = [];
      let password = null;
      for (const file of files) {
        const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        if (window.MemoCrypto && window.MemoCrypto.hasMagic(head)) {
          const sealed = new Uint8Array(await file.arrayBuffer());
          let plain = null;
          if (password) {
            try { plain = await window.MemoCrypto.decryptWithPassword(sealed, password); } catch (_e) { password = null; }
          }
          if (!plain) {
            password = await window.MemoStorageUI.askPassword({ title: translate('Enter the backup password'), okLabel: translate('Continue'),
              check: async value => { plain = await window.MemoCrypto.decryptWithPassword(sealed, value).catch(() => { throw new Error(translate('Wrong password. Try again.')); }); } });
            if (!password) return null;
          }
          if (isSqlite(plain)) throw new Error(translate('This is a database file, not a backup. Restore a backup made with Export backup.'));
          out.push(new File([plain], file.name.replace(/\.memora$/i, ''), { type: 'application/zip' }));
        } else if (isSqlite(head)) {
          throw new Error(translate('This is a database file, not a backup. Restore a backup made with Export backup.'));
        } else out.push(file);
      }
      return { kind: 'backup', files: out };
    }

    async function handleImportData(event) {
      let selected = Array.from(event.target.files || []);
      if (!selected.length || restoring) return;
      try {
        const prepared = await prepareImportFiles(selected);
        if (!prepared) { showStatus(importExportStatus, translate('Restore cancelled. Your data is unchanged.'), 'info'); event.target.value = ''; return; }
        selected = prepared.files;
      } catch (error) {
        showStatus(importExportStatus, '✗ ' + translate('Import failed: {error}', { error: error.message }), 'error');
        event.target.value = '';
        return;
      }
      restoring = true;
      const sdb = window.MemoStateDb, queue = window.OperationQueue;
      let checkpoint, metadataChanged = false, rollbackDurable = true, paused = false, success = false;
      const written = [], localFiles = new Set();
      const controls = Array.from(document.querySelectorAll('#settingsDlg button, #settingsDlg input, #settingsDlg select'));
      const disabled = controls.map(control => control.disabled);
      controls.forEach(control => { control.disabled = true; });
      try {
        if (!window.JSZip) throw new Error('The backup reader is unavailable');
        showStatus(importExportStatus, translate('Verifying selected backup set…'), 'info');
        const selection = await MemoBackup.preflightBackupSetSelection(selected, JSZip);
        const files = selection.dataFiles;
        if (!files.length) throw new Error('No backup data parts were selected');
        const mode = await window.MemoShell.choose(translate('How would you like to restore this backup?'), {
          okLabel: translate('Replace'), okValue: 'replace', secondaryLabel: translate('Merge'), secondaryValue: 'merge',
          cancelLabel: translate('cancel'), title: translate('Restore backup')
        });
        if (!mode) { showStatus(importExportStatus, translate('Restore cancelled. Your data is unchanged.'), 'info'); return; }
        if (getMode() === 'server') {
          const form = new FormData();
          files.forEach(file => form.append('file', file));
          form.append('format', 'zip'); form.append('mode', mode);
          const response = await fetch(getApiBase() + '/api/db/import', { method: 'POST', body: form });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error || 'Server restore failed');
          await window.OperationQueue?.manualSync();
          const api = getServerAPI();
          if (window.MemoCore && api?.list) MemoCore.getState().db.entries = await api.list();
          refreshAfterImport();
          showStatus(importExportStatus, '✓ ' + translate('Import complete. Data restored.'), 'success');
          success = true; return;
        }
        if (!sdb?.ready() || !sdb.createImportCheckpoint) throw new Error('The local database is not ready');
        if (queue?.beginRestore) { await queue.beginRestore(); paused = true; }
        checkpoint = sdb.createImportCheckpoint();
        const before = { default: sdb.loadEntries('default') || [], finance: sdb.loadEntries('finance') || [], planner: sdb.loadDocs('planner') || [] };
        for (const v of (sdb.DOC_VARIANTS || ['planner'])) if (!before[v]) before[v] = sdb.loadDocs(v) || [];
        const combined = { version: 1 };
        for (let index = 0; index < files.length; index++) {
          showStatus(importExportStatus, translate('Reading part {part}/{total}…', { part: index + 1, total: files.length }), 'info');
          const zip = await JSZip.loadAsync(await MemoBackup.preflightImportFile(files[index]));
          await verifyManifest(zip);
          let bundle;
          const envelope = zip.file('memosystem.json');
          let legacy = false;
          if (envelope) bundle = JSON.parse(await envelope.async('string'));
          else {
            legacy = true; bundle = { version: 1 };
            for (const [key, name] of [['memos', 'memos.json'], ['finance', 'finance.json'], ['planner', 'planner.json']]) {
              const member = zip.file('data/' + name);
              if (member) bundle[key] = JSON.parse(await member.async('string'));
            }
            if (!Object.keys(bundle).some(key => ['memos', 'finance', 'planner'].includes(key))) throw new Error('No supported records were found in this backup');
          }
          validateRecords(bundle);
          if (selection.manifest) {
            const set = bundle.backup_set;
            if (set?.id !== selection.manifest.id || set.part !== selection.manifest.parts[index].part || set.parts !== files.length)
              throw new Error('Backup part identity changed after verification');
          }
          for (const key of ['memos', 'finance', 'planner']) if (bundle[key] != null) (combined[key] ||= []).push(...bundle[key]);
          if (bundle.chat) combined.chat = Object.assign(combined.chat || {}, bundle.chat);
          if (Array.isArray(bundle.savedSearches)) combined.savedSearches = bundle.savedSearches;
          if (bundle.docs) for (const [v, list] of Object.entries(bundle.docs)) (((combined.docs ||= {})[v]) ||= []).push(...list);
          for (const name of Object.keys(zip.files)) {
            const rel = name.startsWith('uploads/') ? name : legacy && name.startsWith('data/uploads/') ? name.slice(5) : null;
            if (!rel || zip.files[name].dir) continue;
            if (!await sdb.readBlob(rel)) {
              const blob = await zip.file(name).async('blob');
              await sdb.writeBlob(rel, blob);
              written.push(rel);
            }
            localFiles.add(rel);
          }
        }
        // Old backups can predate a section. Preserve that section when absent;
        // an explicit empty list in a current backup still means empty.
        if (mode === 'replace') for (const [key, variant] of [['memos', 'default'], ['finance', 'finance'], ['planner', 'planner']])
          if (!combined[key]) combined[key] = before[variant];
        metadataChanged = true;
        const counts = sdb.importBundle(combined, mode);
        queue?.journalRestore?.(before, mode, localFiles);
        await sdb.flush();
        if (window.MemoCore) MemoCore.getState().db.entries = sdb.loadEntries(getVariant()) || [];
        refreshAfterImport();
        window.MemoPlannerReminders?.reconcile(true)?.catch(error => console.warn('Reminder refresh failed:', error));
        showStatus(importExportStatus, '✓ ' + translate('Import complete. {memos} memos, {finance} finance, {planner} planner restored.', { memos: counts.memos, finance: counts.finance, planner: counts.planner || 0 }), 'success');
        success = true;
      } catch (error) {
        if (metadataChanged && checkpoint) {
          try { sdb.restoreImportCheckpoint(checkpoint); await sdb.flush(); }
          catch (rollbackError) { rollbackDurable = false; console.error('Restore rollback could not be saved:', rollbackError); }
        }
        if (rollbackDurable) for (const path of written.reverse()) {
          try { await sdb.deleteBlob(path); } catch (cleanupError) { console.warn('Restore file cleanup failed:', cleanupError); }
        }
        queue?.reloadRestoredQueue?.();
        if (metadataChanged && window.MemoCore) MemoCore.getState().db.entries = sdb.loadEntries(getVariant()) || [];
        refreshAfterImport();
        showStatus(importExportStatus, '✗ ' + translate('Import failed: {error}', { error: error.message }), 'error');
      } finally {
        if (paused) queue.endRestore(success);
        controls.forEach((control, index) => { control.disabled = disabled[index]; });
        restoring = false; event.target.value = '';
      }
    }

  // Keep the export button label consistent across every page.
  function updateExportLabel() {
    const btn = document.getElementById('exportDataBtn');
    if (!btn) return;
    const label = getMode() === 'server' ? 'Download Server Backup (.zip)' : translate('Export backup');
    btn.innerHTML = '<span class="svg-icon svg-icon-download"></span> ' + label;
  }

  function init() {
    importExportStatus = document.getElementById('importExportStatus');
    const exportDataBtn = document.getElementById('exportDataBtn');
    const importDataInput = document.getElementById('importDataInput');
    if (exportDataBtn) exportDataBtn.addEventListener('click', handleExportData);
    if (importDataInput) importDataInput.addEventListener('change', handleImportData);
    document.getElementById('settingsDlg')?.addEventListener('cancel', event => { if (restoring) event.preventDefault(); });
    updateExportLabel();
  }
  window.MemoBackupUI = { download, isRestoring: () => restoring };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
