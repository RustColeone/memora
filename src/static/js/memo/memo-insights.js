// memo-insights.js — background on-device analysis of stored images (labels,
// face count, QR/barcode count, embeddings) and what is built on it: search by
// what is in a photo, smart albums, Find similar, suggested tags and organize
// suggestions. Ported from ImageDB's auto-organize.js.
//
// Everything runs on the phone through the native ImageInsights plugin (ML Kit
// and LiteRT via Google Play services). Results are regenerable metadata kept
// apart from the person's own tags and folders (table image_insights, keyed by
// stored path; embeddings in MemoSimilarity): never synced or backed up, and
// nothing is applied to an entry without the person tapping a suggestion.
(function (global) {
  'use strict';

  const SUPPORTED = /\.(jpe?g|png|webp)$/i;
  const ANALYZER_VERSION = 2;              // matches ImageInsightsPlugin.ANALYZER_VERSION
  const PERSIST_BATCH = 12;
  const PERSIST_INTERVAL_MS = 8000;
  const PACE_MS = 150;
  const PREPARE_RETRY_MS = 5 * 60 * 1000;
  const NATIVE_ANALYSIS_TIMEOUT_MS = 45000;
  const NATIVE_PREPARE_TIMEOUT_MS = 200000;
  const SUGGESTION_MIN_IMAGES = 5;
  const SIMILAR_MIN_SCORE = 0.2;
  const SIMILAR_RELATIVE_CUT = 0.5;
  // Labels too generic to be worth a tag or a suggestion (ImageDB's list).
  const GENERIC_LABELS = new Set([16, 17, 57, 59, 66, 69, 78, 91, 112, 132, 139, 143, 149, 152, 175, 176, 185,
    196, 204, 209, 211, 216, 226, 239, 246, 253, 289, 297, 303, 319, 350, 384, 386, 402, 414, 425]);
  const ENABLED_KEY = 'auto_organize';
  const DISMISSED_KEY = 'auto_suggest_dismissed';

  const $id = id => document.getElementById(id);
  const t = (text, vars) => (global.MemoI18n?.t ? global.MemoI18n.t(text, vars) : text);
  const toast = (message, kind) => global.MemoShell?.toast?.(message, kind ? { kind } : undefined);
  const labels = () => global.MemoAutoLabels;
  const sdb = () => global.MemoStateDb;

  let insights = null;          // path -> record, loaded on first use
  let revision = 0;
  let state = 'idle';           // idle | preparing | running | waiting | unsupported | appOnly | off
  let running = false;
  let runId = 0;
  let kickTimer = 0;
  let pending = [];
  let lastPersistAt = 0;
  let prepared = false;
  let embedderReady = null;
  let prepareFailedAt = 0;
  const failedThisSession = new Map();
  const embeddingTried = new Set();
  const analyzedThisSession = new Set();

  function plugin() { return global.Capacitor?.isNativePlatform?.() ? global.Capacitor?.Plugins?.ImageInsights || null : null; }
  function enabled() { const value = sdb()?.ready?.() ? sdb().getItem(ENABLED_KEY) : null; return value !== false; }
  function locked() { return document.body.classList.contains('privacy-locked'); }

  // ── store ──────────────────────────────────────────────────
  function ensureLoaded() {
    if (insights) return insights;
    insights = new Map();
    if (!sdb()?.ready?.() || !sdb().loadImageInsights) return insights;
    for (const record of sdb().loadImageInsights()) insights.set(record.path, record);
    revision++;
    return insights;
  }
  function forPath(path) { return path ? ensureLoaded().get(path) || null : null; }
  function forTarget(target) {
    const record = forPath(target?.storedPath);
    return record && record.status === 'ready' ? record : null;
  }
  function entryPaths(entry) {
    const stored = Array.isArray(entry?._storedPaths) && entry._storedPaths.length ? entry._storedPaths : (entry?.images || []);
    return stored.map(ref => (typeof ref === 'string' ? (sdb()?.urlToRel?.(ref) || ref) : '')).filter(rel => /^uploads\//.test(rel));
  }
  function entryInsights(entry) {
    return entryPaths(entry).map(forPath).filter(record => record && record.status === 'ready');
  }
  const mimeOf = path => (/\.png$/i.test(path) ? 'image/png' : (/\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg'));

  // ── what the rest of the app asks ──────────────────────────
  function albumsForEntry(entry) {
    const out = new Set();
    for (const path of entryPaths(entry)) {
      const record = forPath(path);
      if (record) labels()?.albumsForInsight(record, mimeOf(path)).forEach(key => out.add(key));
    }
    return [...out];
  }
  function entryMatchesSearch(entry, query) {
    if (!query || !labels()) return false;
    return entryInsights(entry).some(record => labels().insightMatches(record, query));
  }
  function suggestedTags(entry, limit = 4) {
    if (!labels()) return [];
    return labels().suggestedTags(entryInsights(entry), entry.tags, limit + 4)
      .filter(item => !GENERIC_LABELS.has(item.index)).slice(0, limit);
  }

  // ── analysis runner ────────────────────────────────────────
  function targets() {
    const list = sdb()?.listImagePaths?.() || [];
    const seen = new Set();
    const out = [];
    const store = ensureLoaded();
    for (const item of list) {
      if (seen.has(item.path) || !SUPPORTED.test(item.path)) continue;
      seen.add(item.path);
      if (analyzedThisSession.has(item.path)) continue;
      const record = store.get(item.path);
      if (!record || record.analyzerVersion < ANALYZER_VERSION) { if ((failedThisSession.get(item.path) || 0) < 2) out.push(item.path); continue; }
      if (record.status === 'error') { if ((failedThisSession.get(item.path) || 0) < 1) out.push(item.path); continue; }
      // Labels are present but the embedding is missing: analyze once more.
      if (embedderReady !== false && global.MemoSimilarity?.loaded?.() && !global.MemoSimilarity.has(item.path) && !embeddingTried.has(item.path)) out.push(item.path);
    }
    return out;
  }
  function stats() {
    const list = sdb()?.listImagePaths?.() || [];
    const seen = new Set();
    let total = 0, analyzed = 0, failed = 0;
    const store = ensureLoaded();
    for (const item of list) {
      if (seen.has(item.path) || !SUPPORTED.test(item.path)) continue;
      seen.add(item.path);
      total++;
      const record = store.get(item.path);
      if (record?.status === 'ready' && record.analyzerVersion >= ANALYZER_VERSION) analyzed++;
      else if (record?.status === 'error') failed++;
    }
    return { total, analyzed, failed, pending: Math.max(0, total - analyzed - failed) };
  }
  function livePaths() { return new Set((sdb()?.listImagePaths?.() || []).map(item => item.path)); }

  function errorCode(error) {
    const code = String(error?.code || error?.errorCode || '').trim();
    if (code) return code.slice(0, 160);
    const match = String(error?.message || error || '').match(/INSIGHTS_[A-Z0-9_]+/);
    return (match?.[0] || 'INSIGHTS_FAILED').slice(0, 160);
  }
  async function bounded(operation, code, ms) {
    let timer = null;
    try {
      return await Promise.race([Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms); })]);
    } finally { clearTimeout(timer); }
  }
  function setState(next) { state = next; renderStatus(); }

  async function ensurePrepared(localRun) {
    if (prepared) return true;
    if (prepareFailedAt && Date.now() - prepareFailedAt < PREPARE_RETRY_MS) return false;
    setState('preparing');
    try {
      const result = await bounded(() => plugin().prepare(), 'INSIGHTS_PREPARE_TIMED_OUT', NATIVE_PREPARE_TIMEOUT_MS);
      if (localRun !== runId) return false;
      prepared = result?.state === 'ready';
      embedderReady = !!result?.embedder;
      if (!prepared) throw Object.assign(new Error('not ready'), { code: 'INSIGHTS_MODEL_NOT_READY' });
      prepareFailedAt = 0;
      return true;
    } catch (error) {
      if (localRun !== runId) return false;
      prepareFailedAt = Date.now();
      setState(/PLAY_SERVICES|UNSUPPORTED/.test(errorCode(error)) ? 'unsupported' : 'waiting');
      return false;
    }
  }

  function toRecord(path, result) {
    return {
      path, status: 'ready',
      labels: (result?.labels || []).map(item => [item.i, item.c]).filter(([index, score]) => Number.isFinite(index) && Number.isFinite(score)),
      faces: result?.faces || 0, codes: result?.codes || 0, faceArea: result?.faceArea || 0, camera: !!result?.camera,
      width: result?.width || 0, height: result?.height || 0, analyzerVersion: ANALYZER_VERSION, analyzedAt: Date.now(),
    };
  }
  async function commitPending(force = false) {
    if (!pending.length) return;
    if (!force && pending.length < PERSIST_BATCH && Date.now() - lastPersistAt < PERSIST_INTERVAL_MS) return;
    const live = livePaths();
    const batch = pending.filter(record => live.has(record.path));
    pending = [];
    lastPersistAt = Date.now();
    if (!batch.length) return;
    try { sdb().upsertImageInsights(batch); }
    catch (error) { console.warn('[Insights] could not save results; they will be recomputed:', error); return; }
    const store = ensureLoaded();
    batch.forEach(record => store.set(record.path, record));
    revision++;
    notifyUpdated();
  }
  function notifyUpdated() {
    try { document.dispatchEvent(new CustomEvent('memo:insights-updated')); } catch (_e) {}
    const search = $id('searchBox')?.value?.trim();
    if (smart || search) global.MemoCore?.renderFeed?.();
    renderStatus();
    renderOpenSurfaces();
  }

  async function run() {
    if (running || !enabled() || locked() || document.visibilityState === 'hidden') return;
    const native = plugin();
    if (!native?.analyzeStoredImage) { setState('appOnly'); return; }
    if (!sdb()?.ready?.()) return;
    running = true;
    await global.MemoSimilarity?.load?.().catch(() => {});
    running = false;
    if (!enabled() || locked() || document.visibilityState === 'hidden') return;
    let queue = targets();
    if (!queue.length) {
      if (global.MemoSimilarity?.loaded?.()) global.MemoSimilarity.prune(livePaths());
      setState('idle');
      return;
    }
    const localRun = ++runId;
    running = true;
    try {
      if (!(await ensurePrepared(localRun))) return;
      queue = targets();
      setState('running');
      for (const path of queue) {
        if (localRun !== runId || !enabled() || locked() || document.visibilityState === 'hidden') break;
        try {
          const result = await bounded(() => native.analyzeStoredImage({ path, embedding: true }), 'INSIGHTS_NATIVE_TIMED_OUT', NATIVE_ANALYSIS_TIMEOUT_MS);
          if (localRun !== runId) break;
          analyzedThisSession.add(path);
          embeddingTried.add(path);
          if (result?.embedding) await global.MemoSimilarity?.put?.(path, result.embedding);
          pending.push(toRecord(path, result));
        } catch (error) {
          const code = errorCode(error);
          if (/MODEL_NOT_READY|PLAY_SERVICES|MODEL_DOWNLOAD/.test(code)) {
            prepared = false; prepareFailedAt = Date.now(); setState('waiting'); break;
          }
          failedThisSession.set(path, (failedThisSession.get(path) || 0) + 1);
          embeddingTried.add(path);
          if (!/BUSY|INTERRUPTED/.test(code)) pending.push({ path, status: 'error', errorCode: code, analyzerVersion: ANALYZER_VERSION, analyzedAt: Date.now() });
        }
        await commitPending();
        renderStatus();
        await new Promise(resolve => setTimeout(resolve, PACE_MS));
      }
      await commitPending(true);
    } finally {
      running = false;
      if (localRun === runId && state === 'running') setState('idle');
      await commitPending(true).catch(() => {});
      void global.MemoSimilarity?.flush?.();
    }
    if (localRun === runId && enabled() && targets().length && state !== 'waiting') kick(1500);
  }
  function kick(delay = 1500) {
    if (!enabled()) { setState('off'); return; }
    const override = Number(global.__MEMO_TEST_OVERRIDES?.autoOrganizeDelayMs);
    if (Number.isFinite(override) && override >= 0) delay = Math.min(delay, override);
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => { void run(); }, delay);
  }
  function stop() { runId++; clearTimeout(kickTimer); running = false; }

  // ── smart views on the Memo feed ───────────────────────────
  // { autoAlbum } | { similarTo: { entryId, path, scores } } | saved-search
  // extras { days, missingDescription, missingTags, missingFolder }.
  let smart = null;
  function smartView() { return smart; }
  function hasSmartConditions(rule = smart) {
    return !!(rule && (rule.autoAlbum || rule.similarTo || rule.days || rule.missingDescription || rule.missingTags || rule.missingFolder));
  }
  function entryScore(entry, rule = smart) {
    if (!rule?.similarTo) return -1;
    if (String(entry.id) === String(rule.similarTo.entryId)) return 2;
    let best = -1;
    for (const path of entryPaths(entry)) best = Math.max(best, rule.similarTo.scores.get(path) ?? -1);
    return best;
  }
  function matchesSmart(entry, rule = smart, now = Date.now()) {
    if (!rule) return true;
    if (rule.autoAlbum && !albumsForEntry(entry).includes(rule.autoAlbum)) return false;
    if (rule.similarTo && entryScore(entry, rule) < 0) return false;
    if (rule.missingDescription && String(entry.description || '').trim()) return false;
    if (rule.missingTags && (entry.tags || []).length) return false;
    if (rule.missingFolder && entry.category && entry.category !== 'Uncategorized') return false;
    if (rule.days) {
      const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - rule.days + 1);
      if (!(entry.ts >= start.getTime())) return false;
    }
    return true;
  }
  function bannerText(rule = smart) {
    if (!rule) return '';
    if (rule.similarTo) return t('Entries with images similar to the one you picked, most similar first.');
    if (rule.autoAlbum) return t('Smart album: {name}', { name: labels()?.albumName(rule.autoAlbum) || rule.autoAlbum });
    if (rule.name) return t('Saved search: {name}', { name: rule.name });
    return '';
  }
  function updateBanner() {
    let banner = $id('smartViewBanner');
    const feed = $id('feed');
    if (!banner && feed?.parentNode) {
      banner = document.createElement('div');
      banner.id = 'smartViewBanner';
      banner.className = 'smart-view-banner';
      banner.setAttribute('role', 'status');
      const text = document.createElement('span');
      text.className = 'smart-view-text';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'ghost smart-view-clear';
      clear.textContent = t('Show all');
      clear.addEventListener('click', () => setSmartView(null));
      banner.append(text, clear);
      feed.parentNode.insertBefore(banner, feed);
    }
    if (!banner) return;
    const text = global.MEMO_VARIANT === 'default' ? bannerText() : '';
    banner.querySelector('.smart-view-text').textContent = text;
    banner.hidden = !text;
  }
  function closeOverlays() {
    for (const id of ['autoOrganizeDlg', 'savedSearchDlg', 'advancedToolsDlg', 'imageToolsDlg', 'toolResultDlg']) {
      const dialog = $id(id); if (dialog?.open) dialog.close();
    }
    global.MemoReader?.close?.();
    const detail = $id('detailDlg'); if (detail?.open) detail.close();
    global.MemoShell?.closeMenu?.();
  }
  async function setSmartView(rule) {
    if (rule && global.MEMO_VARIANT !== 'default' && global.MemoSpaShell?.switchTo) await global.MemoSpaShell.switchTo('default');
    smart = rule || null;
    if (smart) closeOverlays();
    global.MemoCore?.renderFeed?.();
    updateBanner();
    if (smart) global.scrollTo(0, 0);
  }
  function openAutoAlbum(key) {
    if (global.MemoFilter?.reset) global.MemoFilter.reset();
    void setSmartView({ autoAlbum: key });
  }

  // ── Find similar ───────────────────────────────────────────
  async function findSimilar(target) {
    const path = target?.storedPath;
    if (!path) return false;
    try { await global.MemoSimilarity?.load?.(); } catch (_e) {}
    if (!global.MemoSimilarity?.has?.(path)) {
      toast(plugin()
        ? t('This image has not been analyzed yet. Auto-organize will get to it shortly.')
        : t('Find similar works in the Android app.'));
      kick(200);
      return false;
    }
    const visible = (global.MemoCore?.getState?.().db.entries || [])
      .filter(entry => !entry.deletedAt && (!global.MemoPrivacy || global.MemoPrivacy.canViewEntry(entry)));
    const candidates = new Set(visible.flatMap(entryPaths));
    // MobileNet-V3 cosines are low in absolute terms: a true match scores about
    // 0.3 and unrelated images stay under about 0.12 (ImageDB's calibration).
    const raw = await global.MemoSimilarity.similar(path, { candidates, limit: 80, minScore: SIMILAR_MIN_SCORE });
    const cut = raw.length ? Math.max(SIMILAR_MIN_SCORE, raw[0].score * SIMILAR_RELATIVE_CUT) : 1;
    const results = raw.filter(item => item.score >= cut);
    if (!results.length) { toast(t('No similar images found.')); return false; }
    const scores = new Map(results.map(item => [item.blobId, item.score]));
    await setSmartView({ similarTo: { entryId: target.entryId, path, scores } });
    return true;
  }

  // ── suggested tags and chips in an entry's detail view ─────
  function renderDetail(entry) {
    const content = $id('detailContent');
    if (!content || !entry) return;
    let host = $id('detailAutoSuggest');
    if (!host) {
      host = document.createElement('div');
      host.id = 'detailAutoSuggest';
      host.className = 'auto-suggest';
      const tagsLine = content.querySelector('.tagsline');
      if (tagsLine) tagsLine.after(host); else content.append(host);
    }
    host.replaceChildren();
    const tags = suggestedTags(entry);
    const records = entryInsights(entry);
    const firstTarget = global.MemoTools?.targetsFor?.(entry)?.[0] || null;
    const canSimilar = !!firstTarget?.storedPath && (!!plugin() || global.MemoSimilarity?.has?.(firstTarget.storedPath));
    const codes = records.some(record => record.codes > 0);
    if (!tags.length && !canSimilar && !codes) { host.hidden = true; return; }
    host.hidden = false;
    if (tags.length) {
      const label = document.createElement('span');
      label.className = 'auto-suggest-label';
      label.textContent = t('Suggested');
      host.append(label);
      for (const item of tags) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'auto-suggest-chip';
        chip.textContent = '+ ' + item.name;
        chip.setAttribute('aria-label', t('Add tag {tag}', { tag: item.name }));
        chip.addEventListener('click', async () => {
          chip.disabled = true;
          await global.MemoCore.batchApply([entry.id], { addTags: [item.name] });
          const live = global.MemoCore.getState().db.entries.find(candidate => candidate.id === entry.id);
          if (live && $id('detailDlg')?.open) global.MemoVariant?.openDetail?.(live.id);
        });
        host.append(chip);
      }
    }
    if (codes && global.MemoTools) {
      const target = global.MemoTools.targetsFor(entry).find(item => (forPath(item.storedPath)?.codes || 0) > 0);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'auto-suggest-chip auto-similar-btn';
      chip.id = 'detailCodeChip';
      chip.textContent = '▦ ' + t('QR code');
      chip.addEventListener('click', () => { if (target) void global.MemoTools.run('read-codes', target); });
      host.append(chip);
    }
    if (canSimilar) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'auto-suggest-chip auto-similar-btn';
      chip.id = 'detailFindSimilarBtn';
      chip.textContent = t('Find similar');
      chip.addEventListener('click', () => void findSimilar(firstTarget));
      host.append(chip);
    }
  }

  // ── organize suggestions ───────────────────────────────────
  function dismissed() {
    const value = sdb()?.getItem?.(DISMISSED_KEY);
    return new Set(Array.isArray(value) ? value : []);
  }
  function memoEntries() {
    return (global.MEMO_VARIANT === 'default' ? (global.MemoCore?.getState?.().db.entries || []) : [])
      .filter(entry => !entry.deletedAt && (!global.MemoPrivacy || global.MemoPrivacy.canViewEntry(entry)));
  }
  function suggestions() {
    if (locked() || !labels()) return [];
    const skip = dismissed();
    const entries = memoEntries();
    const out = [];
    // 1. Move uncategorized entries of a smart album into a real folder.
    for (const def of labels().albums) {
      if (def.key === 'people') continue;
      const key = 'album:' + def.key;
      if (skip.has(key)) continue;
      const members = entries.filter(entry => (entry.category || 'Uncategorized') === 'Uncategorized' && albumsForEntry(entry).includes(def.key));
      if (members.length >= SUGGESTION_MIN_IMAGES) {
        const name = labels().albumName(def.key);
        out.push({ key, kind: 'album', album: def.key, entries: members,
          text: t('{n} uncategorized entries look like {name}.', { n: members.length, name }),
          action: t('Make a “{name}” folder', { name }) });
      }
    }
    // 2. Tag entries that share a confident label.
    const byLabel = new Map();
    for (const entry of entries) {
      for (const item of labels().suggestedTags(entryInsights(entry), entry.tags, 6)) {
        if (GENERIC_LABELS.has(item.index) || item.score < 0.75) continue;
        if (!byLabel.has(item.index)) byLabel.set(item.index, { name: item.name, entries: [] });
        byLabel.get(item.index).entries.push(entry);
      }
    }
    const tagSuggestions = [...byLabel.entries()]
      .filter(([index, value]) => value.entries.length >= SUGGESTION_MIN_IMAGES && !skip.has('tag:' + index))
      .sort((a, b) => b[1].entries.length - a[1].entries.length)
      .slice(0, 3)
      .map(([index, value]) => ({ key: 'tag:' + index, kind: 'tag', tag: value.name, entries: value.entries,
        text: t('{n} entries show “{tag}” but are not tagged with it.', { n: value.entries.length, tag: value.name }),
        action: t('Tag them “{tag}”', { tag: value.name }) }));
    out.sort((a, b) => b.entries.length - a.entries.length);
    return [...out.slice(0, 2), ...tagSuggestions].slice(0, 4);
  }
  async function applySuggestion(item) {
    const ids = item.entries.map(entry => entry.id);
    if (item.kind === 'tag') {
      const ok = await global.MemoShell.confirm(t('Add the tag “{tag}” to {n} entries?', { tag: item.tag, n: ids.length }), { okLabel: t('Apply') });
      if (!ok) return;
      await global.MemoCore.batchApply(ids, { addTags: [item.tag] });
    } else {
      const name = labels().albumName(item.album);
      const ok = await global.MemoShell.confirm(t('Move {n} uncategorized entries into a “{name}” folder?', { n: ids.length, name }), { okLabel: t('Apply') });
      if (!ok) return;
      await global.MemoCore.batchApply(ids, { category: name });
    }
    toast(t('Done'), 'success');
    renderOpenSurfaces();
  }
  function dismissSuggestion(item) {
    const next = [...dismissed(), item.key].slice(-200);
    sdb()?.setItem?.(DISMISSED_KEY, next);
    renderOpenSurfaces();
  }

  // ── Auto-organize dialog ───────────────────────────────────
  function statusText() {
    const s = stats();
    if (!enabled()) return t('Auto-organize is off. Nothing is analyzed.');
    if (state === 'appOnly' || !plugin()) return t('Auto-organize works in the Android app. It analyzes images on the phone, never on a server.');
    if (state === 'unsupported') return t('Auto-organize needs Google Play services, which is unavailable on this device.');
    if (state === 'preparing') return t('Preparing the on-device models with Google Play services…');
    if (state === 'waiting') return t('Waiting for the on-device models to download. Memora will retry when the phone is online.');
    if (!s.total) return t('Add images and they will be organized automatically.');
    if (s.pending && (state === 'running' || running)) return t('Analyzing… {done} of {total} images', { done: s.analyzed, total: s.total });
    if (s.pending) return t('{done} of {total} images analyzed. The rest continue while Memora is open.', { done: s.analyzed, total: s.total });
    return t('All {total} images are analyzed.', { total: s.total });
  }
  function renderStatus() {
    const dialog = $id('autoOrganizeDlg');
    if (!dialog?.open) return;
    const s = stats();
    $id('autoOrganizeStatus').textContent = statusText();
    const show = enabled() && !!plugin() && s.total > 0 && s.pending > 0;
    $id('autoOrganizeProgress').hidden = !show;
    if (show) $id('autoOrganizeProgressFill').style.width = `${Math.round(s.analyzed / s.total * 100)}%`;
    $id('autoOrganizeToggle').checked = enabled();
    $id('autoOrganizeClearBtn').disabled = !ensureLoaded().size && !global.MemoSimilarity?.size?.();
  }
  function albumCounts() {
    const counts = new Map((labels()?.albums || []).map(def => [def.key, 0]));
    for (const entry of memoEntries()) for (const key of albumsForEntry(entry)) counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }
  function renderAlbums(container) {
    if (!container || !labels()) return;
    container.replaceChildren();
    const counts = albumCounts();
    const shown = labels().albums.filter(def => counts.get(def.key) >= labels().minAlbumImages);
    const section = container.closest('[data-auto-albums-section]') || container;
    section.hidden = !shown.length;
    for (const def of shown) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'auto-album-chip';
      button.dataset.autoAlbum = def.key;
      const name = document.createElement('span');
      name.textContent = labels().albumName(def.key);
      const count = document.createElement('span');
      count.className = 'auto-album-count';
      count.textContent = String(counts.get(def.key));
      button.append(name, count);
      button.addEventListener('click', () => openAutoAlbum(def.key));
      container.append(button);
    }
  }
  function renderSuggestions(container) {
    if (!container) return;
    container.replaceChildren();
    const items = suggestions();
    container.hidden = !items.length;
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'auto-suggestion';
      row.dataset.suggestion = item.key;
      const text = document.createElement('p');
      text.textContent = item.text;
      const actions = document.createElement('div');
      actions.className = 'auto-suggestion-actions';
      const apply = document.createElement('button');
      apply.type = 'button'; apply.className = 'primary'; apply.textContent = item.action;
      apply.addEventListener('click', () => void applySuggestion(item));
      const later = document.createElement('button');
      later.type = 'button'; later.className = 'ghost'; later.textContent = t('Not now');
      later.addEventListener('click', () => dismissSuggestion(item));
      actions.append(apply, later);
      row.append(text, actions);
      container.append(row);
    }
  }
  function renderOpenSurfaces() {
    if ($id('autoOrganizeDlg')?.open) {
      renderStatus();
      renderAlbums($id('autoOrganizeAlbums'));
      renderSuggestions($id('autoOrganizeSuggestions'));
    }
    if ($id('savedSearchDlg')?.open) renderAlbums($id('savedSearchAlbums'));
    const detail = $id('detailDlg');
    if (detail?.open && global.MEMO_VARIANT === 'default') {
      const entry = (global.MemoCore?.getState?.().db.entries || []).find(item => String(item.id) === String(detail.dataset.entryId));
      if (entry) renderDetail(entry);
    }
  }
  function openDialog() {
    const dialog = $id('autoOrganizeDlg');
    if (!dialog || locked()) return;
    global.MemoAdvancedTools?.close?.();
    global.MemoShell?.closeMenu?.();
    if (global.MemoTools?.showDialog) global.MemoTools.showDialog(dialog); else if (!dialog.open) dialog.showModal();
    renderOpenSurfaces();
    kick(300);
  }
  function setEnabled(on) {
    sdb()?.setItem?.(ENABLED_KEY, !!on);
    if (on) kick(200); else { stop(); setState('off'); }
    renderStatus();
  }
  async function clearData() {
    const ok = await global.MemoShell.confirm(t('Remove all auto-organize results from this phone? Your own tags and folders are not affected. If auto-organize stays on, images are analyzed again.'),
      { okLabel: t('Clear results'), danger: true });
    if (!ok) return;
    stop();
    try { sdb().deleteImageInsights('all'); await global.MemoSimilarity?.clear?.(); } catch (error) { toast(error.message, 'error'); }
    insights = new Map();
    revision++;
    failedThisSession.clear(); embeddingTried.clear(); analyzedThisSession.clear();
    if (smart?.autoAlbum || smart?.similarTo) await setSmartView(null);
    renderOpenSurfaces();
    if (enabled()) kick(1500);
  }

  // ── wiring ─────────────────────────────────────────────────
  function wire() {
    $id('autoOrganizeClose')?.addEventListener('click', () => $id('autoOrganizeDlg').close());
    $id('autoOrganizeToggle')?.addEventListener('change', event => setEnabled(event.target.checked));
    $id('autoOrganizeClearBtn')?.addEventListener('click', () => void clearData());
    $id('advancedAutoOrganizeBtn')?.addEventListener('click', () => openDialog());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { stop(); void commitPending(true); }
      else kick(2500);
    });
    document.addEventListener('memo:privacy-locked', () => {
      stop();
      const host = $id('detailAutoSuggest'); if (host) { host.replaceChildren(); host.hidden = true; }
      ['autoOrganizeSuggestions', 'autoOrganizeAlbums', 'savedSearchAlbums'].forEach(id => $id(id)?.replaceChildren());
    });
    document.addEventListener('memo:variant-changed', () => updateBanner());
    Promise.resolve(global.MemoAppReady).then(() => { ensureLoaded(); kick(4000); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoTools?.register({
    id: 'find-similar', group: 'find',
    icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="12" height="12" rx="2"/><rect x="8.5" y="8.5" width="12" height="12" rx="2"/></svg>',
    label: ['', 'Find similar'],
    available: target => !!target?.storedPath && global.MEMO_VARIANT === 'default'
      && (!!plugin() || !!global.MemoSimilarity?.has?.(target.storedPath)),
    run: target => findSimilar(target),
  });

  global.MemoInsights = {
    forTarget, forPath, entryInsights, albumsForEntry, entryMatchesSearch, suggestedTags,
    kick, stop, stats, state: () => state, revision: () => revision, open: openDialog,
    findSimilar, smartView, setSmartView, hasSmartConditions, matchesSmart, entryScore, updateBanner, openAutoAlbum,
    renderDetail, renderAlbums, suggestions, entryPaths,
    // tests: put a record without the native plugin
    _put(records) { const store = ensureLoaded(); sdb().upsertImageInsights(records); records.forEach(record => store.set(record.path, Object.assign({ status: 'ready', analyzerVersion: ANALYZER_VERSION }, record))); revision++; notifyUpdated(); },
  };
})(window);
