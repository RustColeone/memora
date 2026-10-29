// One presentation for Memo, Finance, and Planner; the queue owns sync work.
(function (global) {
  'use strict';
  const t = (key, vars) => global.MemoI18n.t(key, vars);
  const dlg = document.createElement('dialog');
  dlg.id = 'syncStatusDlg'; dlg.className = 'sync-details'; dlg.setAttribute('aria-labelledby', 'syncDetailsTitle');
  dlg.innerHTML = `<div class="modal"><header><strong id="syncDetailsTitle" data-i18n="Sync & backup"></strong><button class="modal-close" data-i18n-aria="close" id="syncDetailsClose">×</button></header>
    <div class="content"><p id="syncLocalState" role="status"></p><p id="syncServerState" role="status"></p>
    <dl><dt data-i18n="Pending changes"></dt><dd id="syncPendingCount"></dd><dt data-i18n="Last successful sync"></dt><dd id="syncLastSuccess"></dd></dl>
    <p id="syncExplanation" class="muted"></p><p id="syncFilesState" role="status"></p><button id="syncFilesRetry" data-i18n="Retry file downloads"></button><ul id="syncIssues"></ul></div><div class="actions"><button id="syncDetailsSettings" data-i18n="Sync & backup settings"></button><button id="syncRetry" class="primary"></button></div></div>`;
  document.body.append(dlg);
  const el = id => dlg.querySelector('#' + id);
  function snapshot() {
    const q = global.OperationQueue, base = (global.MemoRuntime?.getApiBase?.() || global.MemoContracts?.getApiBase?.() || '').replace(/\/$/, '');
    const configured = !!base || (global.MemoRuntime?.getMode?.() || global.MODE) === 'server';
    const variants = global.MemoStateDb?.ready() ? ['default', 'finance', 'planner'] : [global.MEMO_VARIANT || 'default'];
    // Read without creating queue contexts: this also runs while storage boots,
    // before init() has restored the active variant's pending operations.
    const pending = variants.reduce((count, variant) => count + (q?.states.get(base + '|' + variant)?.queue || q?.readState(variant).queue || []).filter(op => !op.synced).length, 0);
    const health = global.MemoStateDb?.getMetadataHealth();
    const localError = !!health?.lastPersistError || health?.status === 'error';
    let state = !configured ? 'local' : q?.presentation?.apiBase === base ? q.presentation.status : 'idle';
    if (state === 'success' && pending) state = 'pending';
    let last = 0;
    try { last = Number(localStorage.getItem('memo_last_sync:' + base)) || 0; } catch (_) {}
    return { state, pending, last, configured, localError, saving: !!health?.pending, durable: !!global.MemoStateDb?.ready() };
  }
  const labels = { local: 'Local only', idle: 'Ready to sync', syncing: 'Syncing…', success: 'Synced', pending: 'Changes waiting to sync', offline: 'Server unavailable', auth: 'Sync password required' };
  function refresh() {
    const s = snapshot(), local = s.localError ? 'Could not save on this device. Keep the app open and retry.' : s.saving ? 'Saving on this device…' : s.durable ? 'Saved on this device' : 'On this device';
    const label = t(labels[s.state] || labels.idle);
    const assets = global.MemoOfflineFiles?.snapshot();
    el('syncFilesState').textContent = !assets?.checked ? t('Checking offline files…') : assets.pending
      ? t('Files available offline: {ready} of {total}', { ready: assets.ready, total: assets.total }) : t('All files available offline');
    el('syncFilesRetry').hidden = !assets?.pending;
    el('syncFilesRetry').disabled = !!assets?.running;
    const issues = el('syncIssues'); issues.replaceChildren();
    const addIssue = (variant, id, reason) => {
      const li = document.createElement('li');
      li.textContent = t(variant === 'default' ? 'Memo' : variant === 'finance' ? 'Finance' : 'Planner') + ' · ' + String(id).slice(0, 40) + ': ' + t(reason);
      issues.append(li);
    };
    (assets?.failed || []).slice(0, 20).forEach(file => addIssue(file.variant, file.entryId, file.reason));
    const q = global.OperationQueue, base = (global.MemoRuntime?.getApiBase?.() || '').replace(/\/$/, '');
    for (const variant of ['default', 'finance', 'planner']) {
      const queue = q?.states.get(base + '|' + variant)?.queue || q?.readState(variant)?.queue || [];
      queue.filter(op => op.rejected).slice(-20).forEach(op => addIssue(variant, op.entryId,
        'Not saved: this entry no longer exists on your server.'));
      queue.filter(op => !op.synced && op.lastError).slice(0, 20).forEach(op => addIssue(variant, op.entryId,
        /401/.test(op.lastError) ? 'Sync password required' : /file|blob|persist/i.test(op.lastError) ? 'Local file needs attention' : 'Change could not be sent. Retry sync.'));
    }
    el('syncLocalState').textContent = t(local);
    el('syncLocalState').classList.toggle('sync-save-error', s.localError);
    el('syncServerState').textContent = label;
    el('syncPendingCount').textContent = new Intl.NumberFormat(global.MemoI18n.getLocale()).format(s.pending);
    el('syncLastSuccess').textContent = s.last ? new Date(s.last).toLocaleString(global.MemoI18n.getLocale()) : t('Never');
    el('syncExplanation').textContent = t(s.state === 'auth' ? 'Check the sync password in Settings.' : s.state === 'offline' ? 'Your personal server may be away. Sync again when it is reachable.' : s.state === 'local' ? 'Connect your personal server in Settings when you want to sync.' : s.state === 'pending' ? 'Some changes could not be sent. Retry, or check Library health in Settings if they remain pending.' : 'Sync covers Memo, Finance, and Planner. Backups are managed in Settings.');
    el('syncRetry').textContent = t(s.localError ? 'Retry saving' : s.state === 'syncing' ? 'Syncing…' : 'Sync now');
    el('syncRetry').disabled = !!global.OperationQueue?.isSyncing || (!s.configured && !s.localError);
    const badge = document.getElementById('syncStatus');
    if (badge) {
      badge.style.display = s.configured || s.localError ? 'flex' : 'none';
      badge.className = 'sync-status ' + (s.localError ? 'sync-save-error' : s.state);
      badge.setAttribute('role', 'button'); badge.tabIndex = 0; badge.setAttribute('aria-haspopup', 'dialog');
      badge.title = badge.ariaLabel = t('Sync & backup') + ': ' + (s.localError ? t(local) : label);
      const icon = badge.querySelector('#syncIcon');
      if (icon) icon.innerHTML = `<span aria-hidden="true" class="svg-icon svg-icon-${s.localError ? 'x' : s.state === 'syncing' ? 'refresh' : s.state === 'success' ? 'check' : 'cloud'}"></span>`;
      const text = badge.querySelector('#syncText'); if (text) text.textContent = label;
    }
  }
  function open() {
    document.getElementById('mobileMenuClose')?.click();
    global.MemoI18n.apply(dlg); refresh(); if (!dlg.open) dlg.showModal();
  }
  el('syncDetailsClose').onclick = () => dlg.close();
  el('syncDetailsSettings').onclick = () => {
    dlg.close(); document.getElementById('mobileSettingsBtn')?.click();
    for (const id of ['exportDataBtn', 'serverUrlInput']) document.getElementById(id)?.closest('.settings-section')?.classList.remove('collapsed');
  };
  el('syncRetry').onclick = async () => {
    el('syncRetry').disabled = true;
    try { await global.MemoStateDb?.flush(); await global.OperationQueue?.manualSync(); }
    catch (_) { /* Storage health carries a durable, actionable error. */ }
    finally { refresh(); }
  };
  el('syncFilesRetry').onclick = () => global.MemoOfflineFiles?.scan(true);
  document.addEventListener('click', event => { if (event.target.closest('#syncStatus')) open(); });
  document.addEventListener('keydown', event => {
    if (event.target.id === 'syncStatus' && ['Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
  });
  ['memo:sync-state', 'memo:metadata-health', 'memo:offline-files'].forEach(name => global.addEventListener(name, refresh));
  ['memo:localechange', 'memo:variant-changed'].forEach(name => document.addEventListener(name, () => { global.MemoI18n.apply(dlg); refresh(); }));
  global.MemoSyncStatus = { refresh, open, snapshot };
  global.addEventListener('load', refresh, { once: true });
})(window);
