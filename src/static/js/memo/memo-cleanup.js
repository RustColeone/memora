// memo-cleanup.js — Clean up similar photos. Ported from ImageDB's
// similar-cleanup.js.
//
// Groups entries whose images' on-device embeddings are close (bursts,
// retakes, the same screenshot saved twice with small changes), suggests the
// entry to keep in each group — the one with the largest image, newest on a
// tie — and moves the rest to the Bin in one confirmed step (30 days, Undo).
// Entries that hold the very same stored image are Duplicates' job.
(function (global) {
  'use strict';

  // Calibrated by ImageDB on device: unrelated photos score < 0.12, two
  // different dogs ≈ 0.29, retakes and recompressed copies far higher.
  const GROUP_SCORE = 0.6;
  // Memora holds many photos of paper (receipts, notes, whiteboards), and the
  // embedding scores two different white pages ≈ 0.8. A retake also keeps the
  // picture's layout, so the 64-bit brightness fingerprint must agree too:
  // measured on a Zenfone 9, a retake 0 bits apart, two different pages 19.
  const MAX_LAYOUT_BITS = 12;
  const PROJECTED_DIM = 64;
  const MAX_IMAGES = 4000;
  const $id = id => document.getElementById(id);
  const t = (text, vars) => (global.MemoI18n?.t ? global.MemoI18n.t(text, vars) : text);
  let groups = [];
  let running = 0;

  function visibleEntries() {
    return (global.MemoCore?.getState?.().db.entries || [])
      .filter(entry => !entry.deletedAt && (!global.MemoPrivacy || global.MemoPrivacy.canViewEntry(entry)));
  }
  const pathsOf = entry => global.MemoInsights?.entryPaths?.(entry) || [];

  // Deterministic random projection (±1) so candidate pairs are found quickly.
  function projector(dim) {
    let seed = 0x9e3779b9;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const matrix = new Int8Array(PROJECTED_DIM * dim);
    for (let i = 0; i < matrix.length; i++) matrix[i] = random() < 0.5 ? -1 : 1;
    return vector => {
      const out = new Float32Array(PROJECTED_DIM);
      let norm = 0;
      for (let p = 0; p < PROJECTED_DIM; p++) {
        let sum = 0;
        const row = p * dim;
        for (let i = 0; i < dim; i++) sum += matrix[row + i] * vector[i];
        out[p] = sum; norm += sum * sum;
      }
      norm = Math.sqrt(norm) || 1;
      for (let p = 0; p < PROJECTED_DIM; p++) out[p] /= norm;
      return out;
    };
  }

  async function findGroups(onProgress) {
    const index = global.MemoSimilarity;
    await index.load();
    // One item per (entry, image) with a vector; entries are what get grouped.
    const items = [];
    const seenPaths = new Set();
    for (const entry of visibleEntries().sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
      for (const path of pathsOf(entry)) {
        if (items.length >= MAX_IMAGES) break;
        if (index.has(path) && !seenPaths.has(entry.id + '|' + path)) { seenPaths.add(entry.id + '|' + path); items.push({ entry, path, vector: index.vector(path) }); }
      }
    }
    const project = projector(index.dim);
    const projected = items.map(item => project(item.vector));
    const layout = global.MemoDuplicates?.hashes ? await global.MemoDuplicates.hashes([...new Set(items.map(item => item.path))]) : new Map();
    const sameLayout = (a, b) => { const ha = layout.get(a), hb = layout.get(b); return !ha || !hb || global.MemoDuplicates.hamming(ha, hb) <= MAX_LAYOUT_BITS; };
    const entryIds = [...new Set(items.map(item => item.entry.id))];
    const slot = new Map(entryIds.map((id, i) => [id, i]));
    const parent = entryIds.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < items.length; i++) {
      const pi = projected[i];
      for (let j = i + 1; j < items.length; j++) {
        if (items[i].entry.id === items[j].entry.id || items[i].path === items[j].path) continue;
        const pj = projected[j];
        let approx = 0;
        for (let p = 0; p < PROJECTED_DIM; p++) approx += pi[p] * pj[p];
        if (approx < GROUP_SCORE - 0.15) continue;
        let dot = 0;
        const vi = items[i].vector, vj = items[j].vector;
        for (let d = 0; d < vi.length; d++) dot += vi[d] * vj[d];
        if (dot / (127 * 127) >= GROUP_SCORE && sameLayout(items[i].path, items[j].path)) parent[find(slot.get(items[i].entry.id))] = find(slot.get(items[j].entry.id));
      }
      if (i % 64 === 0) { onProgress?.(i / Math.max(1, items.length)); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    const byRoot = new Map();
    const entryById = new Map(items.map(item => [item.entry.id, item.entry]));
    entryIds.forEach((id, i) => {
      const root = find(i);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(entryById.get(id));
    });
    const pixels = entry => Math.max(0, ...pathsOf(entry).map(path => {
      const record = global.MemoInsights?.forPath?.(path);
      return (record?.width || 0) * (record?.height || 0);
    }));
    return [...byRoot.values()]
      .filter(group => group.length > 1)
      .map(group => ({ entries: group, keep: new Set([[...group].sort((a, b) => pixels(b) - pixels(a) || (b.ts || 0) - (a.ts || 0))[0].id]) }))
      .sort((a, b) => b.entries.length - a.entries.length);
  }

  const binCount = () => groups.reduce((sum, group) => sum + group.entries.filter(entry => !group.keep.has(entry.id)).length, 0);

  function render() {
    const list = $id('similarCleanupList');
    list.replaceChildren();
    for (const group of groups) {
      const row = document.createElement('div');
      row.className = 'cleanup-group';
      for (const entry of group.entries) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'cleanup-tile';
        const kept = group.keep.has(entry.id);
        tile.dataset.keep = String(kept);
        tile.setAttribute('aria-pressed', String(kept));
        const label = String(entry.description || '').trim().slice(0, 60) || t('Entry');
        tile.setAttribute('aria-label', `${label}: ${kept ? t('Keep') : t('Bin')}`);
        const image = document.createElement('img');
        image.alt = '';
        const path = pathsOf(entry)[0];
        if (path) void Promise.resolve(global.MemoThumbs?.urlFor?.(path)).then(url => url || global.MemoStateDb?.blobUrl?.(path)).then(url => { if (url) image.src = url; }).catch(() => {});
        const badge = document.createElement('span');
        badge.className = 'cleanup-badge';
        badge.textContent = kept ? t('Keep') : t('Bin');
        tile.append(image, badge);
        tile.addEventListener('click', () => {
          if (group.keep.has(entry.id)) { if (group.keep.size > 1) group.keep.delete(entry.id); }   // always keep one
          else group.keep.add(entry.id);
          render();
        });
        row.append(tile);
      }
      list.append(row);
    }
    const count = binCount();
    $id('similarCleanupStatus').textContent = !groups.length ? t('No similar photos were found.')
      : groups.length === 1 ? t('1 group of similar photos. Tap a photo to keep it or move it to the Bin.')
        : t('{groups} groups of similar photos. Tap a photo to keep it or move it to the Bin.', { groups: groups.length });
    const apply = $id('similarCleanupApply');
    apply.hidden = !groups.length;
    apply.disabled = !count;
    apply.textContent = t('Move {n} to the Bin', { n: count });
  }

  async function scan() {
    const runId = ++running;
    groups = [];
    $id('similarCleanupList').replaceChildren();
    $id('similarCleanupApply').hidden = true;
    const status = $id('similarCleanupStatus');
    const native = !!global.Capacitor?.isNativePlatform?.();
    if (!global.MemoSimilarity || !native) { status.textContent = t('Clean up similar photos works in the Android app, after Auto-organize has analyzed your images.'); return; }
    status.textContent = t('Comparing photos…');
    try {
      groups = await findGroups(progress => { if (runId === running) status.textContent = t('Comparing photos… {n}%', { n: Math.round(progress * 100) }); });
    } catch (error) {
      console.warn('[Cleanup] scan failed:', error);
      if (runId === running) status.textContent = t('That tool could not run on this image.');
      return;
    }
    if (runId !== running || !$id('similarCleanupDlg').open) return;
    render();
    const pending = global.MemoInsights?.stats?.().pending || 0;
    if (pending) {
      const note = document.createElement('p');
      note.className = 'tool-message';
      note.textContent = t('{n} photos are still being analyzed and are not compared yet.', { n: pending });
      $id('similarCleanupList').prepend(note);
    }
  }

  async function applyCleanup() {
    const ids = groups.flatMap(group => group.entries.filter(entry => !group.keep.has(entry.id)).map(entry => entry.id));
    if (!ids.length) return;
    const ok = await global.MemoShell.confirm(t('Move {n} entries to the Bin? You can restore them from the Bin for 30 days.', { n: ids.length }),
      { okLabel: t('Move to the Bin'), danger: true });
    if (!ok) return;
    await global.MemoCore.batchDelete(ids);
    global.MemoShell?.toast?.(t('Moved {n} entries to the Bin', { n: ids.length }), { action: { label: t('Undo'), onClick: () => ids.forEach(id => global.MemoCore.restore && global.MemoCore.restore(id)) } });
    void scan();
  }

  function open() {
    const dialog = $id('similarCleanupDlg');
    if (!dialog || document.body.classList.contains('privacy-locked')) return;
    global.MemoAdvancedTools?.close?.();
    global.MemoShell?.closeMenu?.();
    if (global.MemoTools?.showDialog) global.MemoTools.showDialog(dialog); else if (!dialog.open) dialog.showModal();
    void scan();
  }

  function wire() {
    $id('advancedCleanupBtn')?.addEventListener('click', open);
    $id('similarCleanupClose')?.addEventListener('click', () => $id('similarCleanupDlg').close());
    $id('similarCleanupApply')?.addEventListener('click', () => void applyCleanup());
    $id('similarCleanupDlg')?.addEventListener('close', () => { running++; groups = []; });
    document.addEventListener('memo:privacy-locked', () => { const d = $id('similarCleanupDlg'); if (d?.open) d.close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoCleanup = { open, findGroups };
})(window);
