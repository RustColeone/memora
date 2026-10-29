// Durable editor drafts are separate from entries and are never synchronized.
(function (global) {
  let generation = 0, frame = 0, restoring = false, files = new WeakMap();
  let pending = Promise.resolve();
  let lastError = null;
  const key = variant => 'memo_editor_draft_' + variant;
  async function settled() {
    // A newer autosave can supersede this snapshot while its blobs are writing.
    // Explicit callers must wait for that replacement checkpoint too.
    let checkpoint;
    do { checkpoint = pending; await checkpoint; } while (checkpoint !== pending);
  }
  function save() {
    const db = global.MemoStateDb, draft = global.MemoCore?.captureDraft?.();
    if (restoring || !draft || !db?.ready()) return pending;
    const variant = global.MEMO_VARIANT, epoch = ++generation;
    async function media(item) {
      const copy = { ...item }; delete copy.file;
      if (item.file) {
        if (!files.has(item.file)) {
          const path = 'drafts/' + global.MemoContracts.createId();
          files.set(item.file, db.writeBlob(path, item.file).then(() => path).catch(error => {
            files.delete(item.file); throw error;
          }));
        }
        copy.draftPath = await files.get(item.file);
        copy.name = item.file.name; copy.type = item.file.type;
      } else {
        copy.storedPath = item.storedPath || db.relForBlobUrl?.(item.src || item.url);
        copy.url = item.url || item.src;
      }
      delete copy.src;
      if (copy.url?.startsWith('blob:')) delete copy.url;
      return copy;
    }
    pending = pending.then(async () => {
      draft.images = await Promise.all(draft.images.map(media));
      draft.files = await Promise.all(draft.files.map(media));
      if (epoch !== generation) return;
      const previous = db.getItem(key(variant));
      db.setItem(key(variant), draft);
      await db.flush();
      const keep = new Set([...draft.images, ...draft.files].map(item => item.draftPath));
      for (const item of [...(previous?.images || []), ...(previous?.files || [])]) {
        if (item.draftPath && !keep.has(item.draftPath)) await db.deleteBlob(item.draftPath);
      }
      lastError = null;
    }).catch(error => {
      lastError = error;
      global.MemoShell?.toast('The draft could not be saved on this device. Keep the editor open and retry.', { kind: 'error' });
      console.warn('Draft persistence failed', error);
    });
    return settled();
  }
  async function clear() {
    ++generation; files = new WeakMap();
    const db = global.MemoStateDb, variant = global.MEMO_VARIANT;
    if (!db?.ready()) return;
    await pending;
    const draft = db.getItem(key(variant));
    db.setItem(key(variant), null); await db.flush();
    for (const item of [...(draft?.images || []), ...(draft?.files || [])]) if (item.draftPath) await db.deleteBlob(item.draftPath);
  }
  async function restore() {
    const db = global.MemoStateDb, variant = global.MEMO_VARIANT;
    if (!db?.ready() || variant === 'planner') return;
    const draft = db.getItem(key(variant));
    if (!draft || document.getElementById('entryDlg')?.open) return;
    if (global.MemoPrivacy && !await global.MemoPrivacy.ensureVariantAccess(variant)) return;
    restoring = true;
    try {
      async function media(item) {
        const copy = { ...item }, path = item.draftPath || item.storedPath;
        if (item.draftPath) {
          const blob = await db.readBlob(path);
          if (!blob) throw new Error('Draft attachment is missing');
          copy.file = new File([blob], item.name || 'attachment', { type: item.type || blob.type });
          files.set(copy.file, Promise.resolve(path));
        }
        copy.src = path ? await db.blobUrl(path) : item.url;
        copy.url = copy.src || item.url;
        return copy;
      }
      draft.images = await Promise.all(draft.images.map(media));
      draft.files = await Promise.all(draft.files.map(media));
      global.MemoCore.restoreDraft(draft);
    } catch (error) {
      global.MemoShell?.toast('The saved draft needs attention. Its data has been retained.', { kind: 'error' });
      console.warn('Draft restore failed', error);
    } finally { restoring = false; }
  }
  function schedule() {
    if (frame || restoring) return;
    frame = requestAnimationFrame(() => { frame = 0; save(); });
  }
  document.addEventListener('input', event => { if (event.target.closest?.('#entryDlg')) schedule(); });
  document.addEventListener('change', event => { if (event.target.closest?.('#entryDlg')) schedule(); });
  document.addEventListener('close', event => {
    if (event.target.id === 'entryDlg' && !document.hidden && global.MemoLifecycle?.isActive() !== false) clear().catch(console.warn);
  }, true);
  global.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  global.addEventListener('load', () => {
    const dialog = document.getElementById('entryDlg');
    if (dialog) new MutationObserver(schedule).observe(dialog, { childList: true, subtree: true });
  }, { once: true });
  async function saveChecked() { await save(); if (lastError) throw lastError; }
  global.MemoDraft = { save, saveChecked, clear, restore };
})(window);
