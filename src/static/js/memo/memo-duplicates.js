// memo-duplicates.js — Duplicates: find entries that hold the same or nearly
// the same image, one pair at a time, and decide what to keep.
//
// Same approach as ImageDB's duplicate-review.js, sized for Memora's entries:
//   • exact — two entries point at the same stored image (Memora stores equal
//     bytes once), found from the rows;
//   • near — a 64-bit dHash (brightness of neighbouring pixels in a 9 × 8
//     grey sample of the cached thumbnail) within 3 bits. dHash runs in the
//     page, so this works without the Android app too. Candidates come from
//     four 16-bit bands: two hashes within 3 bits always share one band.
// "Keep both" is remembered so the pair does not come back. Removing an entry
// moves it to the Bin (30 days, with Undo); nothing is deleted outright.
(function (global) {
  'use strict';

  const DHASH_VERSION = 1;
  const DHASH_DISTANCE = 3;
  const MAX_PAIRS = 5000;
  const MAX_BUCKET = 400;          // a band shared by more images is too common to compare
  const KEEP_KEY = 'duplicate_keep_pairs';
  const CONCURRENCY = 2;

  const $id = id => document.getElementById(id);
  const t = (text, vars) => (global.MemoI18n?.t ? global.MemoI18n.t(text, vars) : text);
  const toast = (message, options) => global.MemoShell?.toast?.(message, options);
  const sdb = () => global.MemoStateDb;

  let run = 0;
  let pairs = [];
  let index = 0;
  let busy = false;
  let hashes = null;               // path -> hex

  function visibleEntries() {
    return (global.MemoCore?.getState?.().db.entries || [])
      .filter(entry => !entry.deletedAt && (!global.MemoPrivacy || global.MemoPrivacy.canViewEntry(entry)));
  }
  function pathsOf(entry) { return global.MemoInsights?.entryPaths?.(entry) || []; }
  const pairKey = (a, b) => [String(a), String(b)].sort().join('|');
  function keptPairs() { const value = sdb()?.getItem?.(KEEP_KEY); return new Set(Array.isArray(value) ? value : []); }
  function rememberKeep(a, b) { sdb()?.setItem?.(KEEP_KEY, [...keptPairs(), pairKey(a, b)].slice(-5000)); }

  // ── dHash ──────────────────────────────────────────────────
  function loadHashes() {
    if (hashes) return hashes;
    hashes = new Map();
    for (const row of sdb()?.loadImageHashes?.() || []) if (row.version === DHASH_VERSION) hashes.set(row.path, row.dhash);
    return hashes;
  }
  async function imageFor(path) {
    let url = await global.MemoThumbs?.urlFor?.(path).catch(() => null);
    let owned = false;
    if (!url) {
      const blob = await sdb()?.readBlob?.(path).catch(() => null);
      if (!blob) return null;
      url = URL.createObjectURL(blob); owned = true;
    }
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    try { await image.decode(); return image; }
    catch (_e) { return null; }
    finally { if (owned) setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  function dhashOf(image) {
    const canvas = document.createElement('canvas');
    canvas.width = 9; canvas.height = 8;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, 9, 8);
    const data = ctx.getImageData(0, 0, 9, 8).data;
    const grey = (x, y) => { const i = (y * 9 + x) * 4; return data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114; };
    let hex = '';
    for (let y = 0; y < 8; y++) {
      let byte = 0;
      for (let x = 0; x < 8; x++) byte = (byte << 1) | (grey(x, y) > grey(x + 1, y) ? 1 : 0);
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  }
  function hamming(a, b) {
    let distance = 0;
    for (let i = 0; i < 16; i += 4) {
      let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16);
      while (x) { distance += x & 1; x >>>= 1; }
    }
    return distance;
  }
  async function ensureHashes(paths, onProgress, localRun) {
    const store = loadHashes();
    const missing = paths.filter(path => !store.has(path));
    let done = 0;
    const fresh = [];
    const worker = async () => {
      while (missing.length && localRun === run) {
        const path = missing.shift();
        const image = await imageFor(path);
        if (image) { const dhash = dhashOf(image); store.set(path, dhash); fresh.push({ path, dhash, version: DHASH_VERSION }); }
        done++;
        if (done % 8 === 0) onProgress(done, done + missing.length);
        if (fresh.length >= 40) sdb()?.putImageHashes?.(fresh.splice(0));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (fresh.length) sdb()?.putImageHashes?.(fresh);
    return store;
  }

  // ── pairs ──────────────────────────────────────────────────
  async function findPairs(onProgress, localRun) {
    const entries = visibleEntries();
    const owners = new Map();                  // path -> [entry]
    for (const entry of entries) for (const path of pathsOf(entry)) {
      if (!owners.has(path)) owners.set(path, []);
      if (!owners.get(path).includes(entry)) owners.get(path).push(entry);
    }
    const kept = keptPairs();
    const seen = new Set();
    const out = [];
    const add = (a, b, kind, path) => {
      if (a.id === b.id || out.length >= MAX_PAIRS) return;
      const key = pairKey(a.id, b.id);
      if (seen.has(key) || kept.has(key)) return;
      seen.add(key);
      out.push({ a, b, kind, path });
    };
    // Exact: one stored image in two entries.
    for (const [path, list] of owners) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(list[i], list[j], 'exact', path);
    // Near: dHash within DHASH_DISTANCE bits.
    const paths = [...owners.keys()].filter(path => /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(path));
    const store = await ensureHashes(paths, onProgress, localRun);
    if (localRun !== run) return [];
    const bands = [new Map(), new Map(), new Map(), new Map()];
    for (const path of paths) {
      const hash = store.get(path);
      if (!hash) continue;
      for (let band = 0; band < 4; band++) {
        const key = hash.slice(band * 4, band * 4 + 4);
        if (!bands[band].has(key)) bands[band].set(key, []);
        bands[band].get(key).push(path);
      }
    }
    for (const band of bands) for (const bucket of band.values()) {
      if (bucket.length < 2 || bucket.length > MAX_BUCKET) continue;
      for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
        const p = bucket[i], q = bucket[j];
        if (hamming(store.get(p), store.get(q)) > DHASH_DISTANCE) continue;
        for (const a of owners.get(p)) for (const b of owners.get(q)) add(a, b, 'near', p);
      }
    }
    return out;
  }

  // ── UI ─────────────────────────────────────────────────────
  function formatDate(ms) {
    try { return new Date(ms).toLocaleDateString(global.MemoI18n?.getLocale?.() || undefined, { dateStyle: 'medium' }); }
    catch (_e) { return ''; }
  }
  function card(entry, side) {
    const box = document.createElement('div');
    box.className = 'duplicate-card';
    box.dataset.side = side;
    const image = document.createElement('img');
    image.alt = '';
    const path = pathsOf(entry)[0];
    if (path) void Promise.resolve(global.MemoThumbs?.urlFor?.(path)).then(url => url || sdb()?.blobUrl?.(path)).then(url => { if (url) image.src = url; }).catch(() => {});
    const text = document.createElement('div');
    text.className = 'duplicate-card-text';
    const title = document.createElement('strong');
    title.textContent = String(entry.description || '').replace(/\s+/g, ' ').trim().slice(0, 90) || t('(No description)');
    const meta = document.createElement('span');
    const count = pathsOf(entry).length;
    meta.textContent = [formatDate(entry.ts), entry.category || 'Uncategorized', count > 1 ? t('{n} images', { n: count }) : ''].filter(Boolean).join(' · ');
    text.append(title, meta);
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'primary duplicate-keep';
    keep.textContent = t('Keep this one');
    keep.addEventListener('click', () => void decide(side === 'a' ? 'keepA' : 'keepB'));
    box.append(image, text, keep);
    return box;
  }
  function render() {
    const host = $id('duplicatePair');
    host.replaceChildren();
    const pair = pairs[index];
    $id('duplicateReviewActions').hidden = !pair;
    if (!pair) {
      $id('duplicateReviewStatus').textContent = pairs.length ? t('All pairs reviewed.') : t('No duplicate images were found.');
      return;
    }
    $id('duplicateReviewStatus').textContent = t('{kind} · pair {n} of {total}', {
      kind: pair.kind === 'exact' ? t('Same image') : t('Nearly the same image'), n: index + 1, total: pairs.length });
    host.append(card(pair.a, 'a'), card(pair.b, 'b'));
  }
  async function decide(choice) {
    if (busy) return;
    const pair = pairs[index];
    if (!pair) return;
    busy = true;
    try {
      if (choice === 'both') rememberKeep(pair.a.id, pair.b.id);
      else if (choice === 'keepA' || choice === 'keepB') {
        const drop = choice === 'keepA' ? pair.b : pair.a;
        await global.MemoCore.batchDelete([drop.id]);
        toast(t('Moved to the Bin'), { action: { label: t('Undo'), onClick: () => global.MemoCore.restore && global.MemoCore.restore(drop.id) } });
        // Pairs that involve the removed entry are settled too.
        pairs = pairs.filter((other, at) => at <= index || (other.a.id !== drop.id && other.b.id !== drop.id));
      }
      index++;
      render();
    } finally { busy = false; }
  }
  async function scan() {
    const localRun = ++run;
    pairs = []; index = 0;
    $id('duplicatePair').replaceChildren();
    $id('duplicateReviewActions').hidden = true;
    const progress = $id('duplicateProgress'), fill = $id('duplicateProgressFill');
    $id('duplicateReviewStatus').textContent = t('Looking for duplicates…');
    progress.hidden = false; fill.style.width = '0%';
    try {
      pairs = await findPairs((done, total) => {
        if (localRun !== run) return;
        $id('duplicateReviewStatus').textContent = t('Comparing images… {done} of {total}', { done, total });
        fill.style.width = `${Math.round(done / Math.max(1, total) * 100)}%`;
      }, localRun);
    } catch (error) {
      console.warn('[Duplicates] scan failed:', error);
      if (localRun === run) $id('duplicateReviewStatus').textContent = t('That tool could not run on this image.');
      return;
    } finally { if (localRun === run) progress.hidden = true; }
    if (localRun !== run || !$id('duplicateReviewDlg').open) return;
    render();
  }
  function open() {
    const dialog = $id('duplicateReviewDlg');
    if (!dialog || document.body.classList.contains('privacy-locked')) return;
    global.MemoAdvancedTools?.close?.();
    global.MemoShell?.closeMenu?.();
    if (global.MemoTools?.showDialog) global.MemoTools.showDialog(dialog); else if (!dialog.open) dialog.showModal();
    void scan();
  }

  function wire() {
    $id('advancedDuplicatesBtn')?.addEventListener('click', open);
    $id('duplicateReviewClose')?.addEventListener('click', () => $id('duplicateReviewDlg').close());
    $id('duplicateKeepBoth')?.addEventListener('click', () => void decide('both'));
    $id('duplicateSkip')?.addEventListener('click', () => void decide('skip'));
    $id('duplicateReviewDlg')?.addEventListener('close', () => { run++; pairs = []; });
    document.addEventListener('memo:privacy-locked', () => { const d = $id('duplicateReviewDlg'); if (d?.open) d.close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoDuplicates = { open, findPairs: () => findPairs(() => {}, run), dhashOf, hamming,
    // Fingerprints for other tools (Clean up similar photos), cached like ours.
    hashes: (paths, onProgress) => ensureHashes(paths, onProgress || (() => {}), run), _pairs: () => pairs.map(p => ({ a: p.a.id, b: p.b.id, kind: p.kind })) };
})(window);
