// Load the still-image editor only when it is requested.
(function (global) {
  const t = key => global.MemoI18n.t(key);
  let loading;
  let request = 0;
  document.addEventListener('memo:privacy-locked', () => { ++request; });
  function script(name) {
    return new Promise((resolve, reject) => {
      const node = document.createElement('script');
      node.src = '/static/js/memo/' + name + '.js';
      node.onload = resolve;
      node.onerror = () => { node.remove(); reject(new Error(t('The Image Editor could not load. Please try again.'))); };
      document.body.append(node);
    });
  }
  async function open(source) {
    const epoch = ++request;
    try {
      if (!loading) loading = (async () => {
        if (!global.MemoImageGeometry) await script('memo-image-geometry');
        if (!global.MemoImageColor) await script('memo-image-color');
        if (!global.MemoImageEditorImpl) await script('memo-image-editor');
      })().catch(error => { loading = null; throw error; });
      await loading;
      if (epoch !== request) return;
      return global.MemoImageEditorImpl.open(source);
    } catch (error) { global.MemoShell?.toast(error.message, { kind: 'error' }); }
  }
  function openEntry(entry, index = 0) {
    return open({ entryId: entry.id, index, ref: entry._storedPaths?.[index] || entry.images?.[index],
      variant: global.MEMO_VARIANT, name: 'image' });
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('#advancedImageEditorBtn')) return;
    global.MemoAdvancedTools?.close();
    void open();
  });
  global.MemoImageEditor = { open, openEntry };
  let noticeVariant;
  async function reflectDraft() {
    if (!global.MemoImageDraft) return;
    const variant = global.MEMO_VARIANT || 'default';
    try {
      const saved = await global.MemoImageDraft.read(variant, false);
      if (variant !== (global.MEMO_VARIANT || 'default')) return;
      const button = document.getElementById('advancedImageEditorBtn');
      const description = button?.querySelector('small');
      if (description) {
        description.dataset.i18n = saved ? 'Unfinished edit saved on this device' : 'Crop, rotate, adjust light and colour, tune curves, and save a copy.';
        description.textContent = t(description.dataset.i18n);
      }
      if (saved && noticeVariant !== variant && !document.getElementById('imageEditorDlg')?.open) {
        noticeVariant = variant;
        global.MemoShell?.toast(t('Unfinished image edit available in All tools.'));
      }
    } catch (_) { /* The editor reports persistence failures when opened. */ }
  }
  global.addEventListener('load', () => { Promise.resolve(global.MemoAppReady).then(reflectDraft); }, {once:true});
  document.addEventListener('memo:variant-changed', reflectDraft);
  document.addEventListener('memo:localechange', reflectDraft);
  document.addEventListener('memo:image-draft-changed', reflectDraft);
})(window);
