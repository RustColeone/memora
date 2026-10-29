// memo-verify.js — "Verify & Repair" for the local blob library.
//
// Cross-references stored blobs (MemoStateDb.enumerateBlobs) against the paths
// entries actually reference (_storedPaths + attachments[].storedPath, across
// memos + finance, INCLUDING trashed entries — a soft-deleted entry still owns
// its blobs until purge). Reports:
//   • orphaned files — stored, referenced by nothing → safe to delete (reclaim)
//   • broken references — an entry points at a file that isn't there → repair
//     by dropping the dead link.
// Local-store only (OPFS / IndexedDB / Capacitor DATA); a no-op in server mode
// where blobs live on the server. Owns its own Settings section UI.
(function (global) {
  'use strict';
  var _last = null; // most recent scan result, for the action buttons

  function stateDb() { return global.MemoStateDb; }
  function ready() { var d = stateDb(); return !!(d && d.ready && d.ready() && d.enumerateBlobs); }

  // Every stored-path an entry references (images + non-image attachments).
  function refsOf(entry) {
    var out = [];
    if (Array.isArray(entry._storedPaths)) entry._storedPaths.forEach(function (p) { if (p) out.push(String(p)); });
    if (Array.isArray(entry.attachments)) entry.attachments.forEach(function (a) { if (a && a.storedPath) out.push(String(a.storedPath)); });
    return out;
  }
  function referencedPaths() {
    var db = stateDb(); var refs = new Set();
    if (!db) return refs;
    ['default', 'finance'].forEach(function (v) {
      (db.loadEntries(v) || []).forEach(function (e) { refsOf(e).forEach(function (p) { refs.add(p); }); });
    });
    return refs;
  }

  async function scan() {
    if (!ready()) return { supported: false, storedCount: 0, refCount: 0, orphans: [], missing: [] };
    var db = stateDb();
    var stored = (await db.enumerateBlobs()) || [];
    var storedSet = new Set(stored.map(String));
    var refs = referencedPaths();
    var orphans = stored.map(String).filter(function (p) { return !refs.has(p); });
    var missing = [];
    refs.forEach(function (p) { if (!storedSet.has(p)) missing.push(p); });
    return { supported: true, storedCount: stored.length, refCount: refs.size, orphans: orphans, missing: missing };
  }

  // Delete orphaned blobs. Returns the number removed.
  async function deleteOrphans(orphans) {
    var db = stateDb(); var n = 0;
    for (var i = 0; i < (orphans || []).length; i++) {
      try { await db.deleteBlob(orphans[i]); n++; } catch (_e) {}
    }
    return n;
  }

  // Strip any missing-path from one entry (images, _storedPaths, attachments).
  // Returns the count of references removed.
  function pruneEntry(e, miss, db) {
    var removed = 0;
    if (Array.isArray(e._storedPaths)) {
      var b0 = e._storedPaths.length;
      e._storedPaths = e._storedPaths.filter(function (p) { return !miss.has(String(p)); });
      removed += b0 - e._storedPaths.length;
    }
    if (Array.isArray(e.images)) {
      e.images = e.images.filter(function (u) { return !miss.has(db.urlToRel(u)); });
    }
    if (Array.isArray(e.attachments)) {
      var b1 = e.attachments.length;
      e.attachments = e.attachments.filter(function (a) { return !(a && a.storedPath && miss.has(String(a.storedPath))); });
      removed += b1 - e.attachments.length;
    }
    return removed;
  }

  // Remove dead references from every entry that has them, persist, and refresh
  // the live view. Returns { entries, refs } counts changed.
  function pruneMissing(missing) {
    var db = stateDb();
    var miss = new Set((missing || []).map(String));
    if (!miss.size || !db) return { entries: 0, refs: 0 };
    var changedEntries = 0, removedRefs = 0;
    ['default', 'finance'].forEach(function (v) {
      var entries = db.loadEntries(v) || [];
      var dirty = false;
      entries.forEach(function (e) { var r = pruneEntry(e, miss, db); if (r) { changedEntries++; removedRefs += r; dirty = true; } });
      if (dirty) db.saveEntries(entries, v);
    });
    // Best-effort: keep the live (current-variant) UI in sync without a reload.
    if (global.MemoCore && global.MemoCore.getState) {
      try {
        (global.MemoCore.getState().db.entries || []).forEach(function (e) { pruneEntry(e, miss, db); });
        if (global.MemoCore.renderFeed) global.MemoCore.renderFeed();
      } catch (_e) {}
    }
    return { entries: changedEntries, refs: removedRefs };
  }

  // ── Settings UI ───────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function setStatus(msg, kind) {
    var s = el('verifyStatus'); if (!s) return;
    s.textContent = msg || '';
    s.style.color = kind === 'bad' ? 'var(--danger)' : (kind === 'ok' ? 'var(--accent2)' : 'var(--muted)');
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function renderReport(res) {
    var box = el('verifyReport'); if (!box) return;
    box.style.display = 'block';
    if (!res.supported) {
      box.innerHTML = '<p class="muted" style="font-size:12px;">Local file storage isn\'t active in this mode, so there\'s nothing to scan on this device.</p>';
      return;
    }
    var healthy = res.orphans.length === 0 && res.missing.length === 0;
    box.innerHTML =
      '<div class="verify-stats">' +
        stat(res.storedCount, 'stored', '') +
        stat(res.refCount, 'referenced', '') +
        stat(res.orphans.length, 'orphaned', res.orphans.length ? 'warn' : '') +
        stat(res.missing.length, 'missing', res.missing.length ? 'bad' : '') +
      '</div>' +
      (healthy ? '<p class="verify-ok">✓ Everything checks out — no orphaned files or broken references.</p>' : '') +
      (res.orphans.length
        ? '<div class="form-row" style="margin-top:10px;"><button id="verifyDelOrphans" class="secondary" type="button"><span class="svg-icon svg-icon-trash"></span> Delete ' + plural(res.orphans.length, 'orphaned file') + '</button> <span class="muted" style="font-size:11px;">Reclaims storage; unused by any entry.</span></div>' : '') +
      (res.missing.length
        ? '<div class="form-row" style="margin-top:10px;"><button id="verifyPruneMissing" class="secondary" type="button"><span class="svg-icon svg-icon-check"></span> Repair ' + plural(res.missing.length, 'broken reference') + '</button> <span class="muted" style="font-size:11px;">Drops dead image/file links from entries.</span></div>' : '');
    var d = el('verifyDelOrphans'); if (d) d.addEventListener('click', onDeleteOrphans);
    var p = el('verifyPruneMissing'); if (p) p.addEventListener('click', onPruneMissing);
    _last = res;
  }
  function stat(num, label, kind) {
    return '<div class="vstat ' + (kind || '') + '"><span class="vnum">' + num + '</span><span class="vlbl">' + label + '</span></div>';
  }

  async function onScan() {
    if (!ready()) { renderReport({ supported: false, orphans: [], missing: [] }); return; }
    setStatus('Scanning…');
    try {
      var res = await scan();
      renderReport(res);
      setStatus(res.orphans.length || res.missing.length ? 'Scan complete — issues found.' : 'Scan complete — library is healthy.', res.missing.length ? 'bad' : 'ok');
    } catch (e) { setStatus('Scan failed: ' + (e && e.message || e), 'bad'); }
  }
  async function onDeleteOrphans() {
    if (!_last || !_last.orphans.length) return;
    var msg = 'Delete ' + plural(_last.orphans.length, 'orphaned file') + '? This frees storage and cannot be undone.';
    var ok = window.MemoShell ? await window.MemoShell.confirm(msg, { danger: true, okLabel: 'Delete' }) : confirm(msg);
    if (!ok) return;
    setStatus('Deleting…');
    var n = await deleteOrphans(_last.orphans);
    setStatus('Deleted ' + plural(n, 'file') + '.', 'ok');
    await onScan();
  }
  async function onPruneMissing() {
    if (!_last || !_last.missing.length) return;
    var msg = 'Remove ' + plural(_last.missing.length, 'broken reference') + ' from your entries?';
    var ok = window.MemoShell ? await window.MemoShell.confirm(msg, { okLabel: 'Remove' }) : confirm(msg);
    if (!ok) return;
    setStatus('Repairing…');
    var r = pruneMissing(_last.missing);
    setStatus('Repaired ' + plural(r.entries, 'entry') + ' (' + plural(r.refs, 'link') + ' removed).', 'ok');
    await onScan();
  }

  function init() {
    var btn = el('verifyScanBtn');
    if (btn) btn.addEventListener('click', onScan);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.MemoVerify = { scan: scan, deleteOrphans: deleteOrphans, pruneMissing: pruneMissing };
})(window);
