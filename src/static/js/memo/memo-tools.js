// memo-tools.js — the per-image Tools sheet and the helpers image tools share.
//
// Ported from ImageDB's image-tools.js. In ImageDB an entry is one image; in
// Memora an entry holds several, so a tool works on a *target*: one image of
// one entry —
//   { id, entryId, index, storedPath, url, mime, caption, safe }
// (id is "entryId:index", so the ported tools can key on it). The sheet shows
// a strip to pick the image when the entry has more than one.
//
// Tools never change the original. A result is either shared, or added to the
// entry through the normal entry form (the same hand-off the Image Editor
// uses), so nothing is saved until the person reviews it and taps Post.
(function (global) {
  'use strict';

  const $id = id => document.getElementById(id);
  const dialog = () => $id('imageToolsDlg');

  const GROUPS = [
    ['edit', 'Edit'],
    ['text', 'Text'],
    ['share', 'Share safely'],
    ['find', 'Find'],
  ];
  const MAX_SUGGESTED = 3;
  const tools = [];
  let current = null;        // { entryId, index } the sheet is open for

  // Memora's dictionary is keyed by the English text, so the fallback is the key.
  // A few ImageDB phrasings read differently here.
  const WORDING = {
    toolSaveCopy: 'Add to this entry',
    toolSavedCopy: 'Added to the entry. Review it and tap Post.',
  };
  function tr(key, fallback, vars) {
    const text = WORDING[key] || fallback || key;
    const i18n = global.MemoI18n;
    const out = i18n && typeof i18n.t === 'function' ? i18n.t(text, vars) : text;
    if (out && out !== text) return out;
    return vars ? String(text).replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match)) : text;
  }
  function toast(message, kind) { global.MemoShell?.toast?.(message, kind ? { kind } : undefined); }

  function entries() { return global.MemoCore?.getState?.().db.entries || []; }
  function entryById(id) { return entries().find(entry => String(entry.id) === String(id)) || null; }
  function isImageRef(ref) { return global.MemoCore?.isImage ? global.MemoCore.isImage(ref) : /\.(png|jpe?g|gif|webp|avif|bmp|heic)$/i.test(ref || ''); }
  function canView(entry) { return !!entry && !entry.deletedAt && (!global.MemoPrivacy || global.MemoPrivacy.canViewEntry(entry)); }

  const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic', avif: 'image/avif' };
  function mimeOf(ref) {
    const ext = String(ref || '').split(/[?#]/)[0].split('.').pop().toLowerCase();
    return EXT_MIME[ext] || '';
  }
  function relOf(ref) {
    if (!ref || typeof ref !== 'string' || /^(blob:|data:|https?:)/i.test(ref)) return null;
    const sdb = global.MemoStateDb;
    let path = ref.split('?')[0].split('#')[0];
    if (sdb && typeof sdb.urlToRel === 'function') path = sdb.urlToRel(path) || path;
    path = path.replace(/^\/+/, '');
    return /^uploads\//.test(path) ? path : null;
  }

  // The images of an entry, as tool targets (non-image attachments excluded).
  function targetsFor(entry) {
    if (!entry) return [];
    const images = Array.isArray(entry.images) ? entry.images : [];
    const stored = Array.isArray(entry._storedPaths) ? entry._storedPaths : [];
    const out = [];
    images.forEach((ref, index) => {
      if (!isImageRef(ref) && !isImageRef(stored[index])) return;
      const storedPath = relOf(stored[index]) || relOf(ref);
      out.push({
        id: entry.id + ':' + index, entryId: entry.id, index,
        ref, storedPath, url: ref,
        mime: mimeOf(storedPath || ref),
        caption: String(entry.description || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        safe: !!entry.safe,
      });
    });
    return out;
  }
  function targetFor(entryId, index) {
    const list = targetsFor(entryById(entryId));
    return list.find(target => target.index === Number(index)) || list[0] || null;
  }
  // From a Library picker descriptor ({ entryId, index, storedPath, url, mime }).
  function targetFromPick(pick) {
    if (!pick) return null;
    const fromEntry = pick.entryId != null ? targetFor(pick.entryId, pick.index) : null;
    if (fromEntry) return fromEntry;
    return { id: 'pick:' + Date.now(), entryId: null, index: 0, ref: pick.url, url: pick.url,
      storedPath: relOf(pick.storedPath) || relOf(pick.url), mime: pick.mime || mimeOf(pick.storedPath || pick.url),
      caption: '', safe: !!pick.safe };
  }

  /**
   * Registers a tool.
   *   id, group, icon (svg-icon-* class or markup), label: [key, fallback],
   *   available(target), suggested(target), run(target)
   */
  function register(tool) {
    if (!tool || !tool.id || tools.some(existing => existing.id === tool.id)) return;
    tools.push(Object.assign({ available: () => true, suggested: () => false }, tool));
  }

  function iconMarkup(icon) {
    if (!icon) return '';
    return /^svg-icon-/.test(icon) ? '<span class="svg-icon ' + icon + '"></span>' : icon;
  }

  function toolButton(tool, target) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'image-tool';
    button.dataset.tool = tool.id;
    const icon = document.createElement('span');
    icon.className = 'image-tool-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = iconMarkup(tool.icon);
    const label = document.createElement('span');
    label.className = 'image-tool-label';
    label.textContent = tr(tool.label[0], tool.label[1]);
    button.append(icon, label);
    button.addEventListener('click', () => {
      const live = target.entryId != null ? targetFor(target.entryId, target.index) : target;
      close();
      if (live) Promise.resolve().then(() => tool.run(live)).catch(error => {
        console.warn('[Tools] ' + tool.id + ' failed:', error);
        toast(friendlyError(error), 'error');
      });
    });
    return button;
  }

  function section(titleText, buttons, key) {
    const block = document.createElement('section');
    block.className = 'image-tools-section';
    block.dataset.group = key;
    const heading = document.createElement('h4');
    heading.textContent = titleText;
    const grid = document.createElement('div');
    grid.className = 'image-tools-grid';
    grid.append(...buttons);
    block.append(heading, grid);
    return block;
  }

  function render(target) {
    const list = $id('imageToolsList');
    list.replaceChildren();
    const safely = (fn, fallback) => { try { return fn(); } catch (_e) { return fallback; } };
    const usable = tools.filter(tool => safely(() => tool.available(target), false));
    const suggested = usable.filter(tool => safely(() => tool.suggested(target), false)).slice(0, MAX_SUGGESTED);
    if (suggested.length) list.append(section(tr('Suggested for this image'), suggested.map(tool => toolButton(tool, target)), 'suggested'));
    const shown = new Set(suggested.map(tool => tool.id));
    for (const [key, title] of GROUPS) {
      const group = usable.filter(tool => tool.group === key && !shown.has(tool.id));
      if (group.length) list.append(section(tr(title), group.map(tool => toolButton(tool, target)), key));
    }
    if (!list.children.length) {
      const empty = document.createElement('p');
      empty.className = 'image-tools-empty';
      empty.textContent = tr('No tools are available for this image.');
      list.append(empty);
    }
  }

  const previewUrls = [];
  function releasePreviews() { previewUrls.splice(0).forEach(url => { try { URL.revokeObjectURL(url); } catch (_e) {} }); }
  // A displayable URL for a target (stored blobs get a fresh object URL).
  async function displayUrl(target) {
    if (target.storedPath && global.MemoStateDb?.readBlob && global.MemoContracts?.getMode?.() !== 'server') {
      const blob = await global.MemoStateDb.readBlob(target.storedPath).catch(() => null);
      if (blob) { const url = URL.createObjectURL(blob); previewUrls.push(url); return url; }
    }
    return target.url || '';
  }

  function renderStrip(entry, active) {
    const strip = $id('imageToolsStrip');
    const all = targetsFor(entry);
    strip.replaceChildren();
    strip.hidden = all.length < 2;
    if (all.length < 2) return;
    all.forEach(target => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'image-tools-thumb';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(target.index === active.index));
      button.setAttribute('aria-label', tr('Image {n}', null, { n: all.indexOf(target) + 1 }));
      const img = document.createElement('img');
      img.alt = '';
      button.append(img);
      void displayUrl(target).then(url => { if (url) img.src = url; });
      button.addEventListener('click', () => void open(entry.id, target.index));
      strip.append(button);
    });
  }

  /** Opens the Tools sheet for one image of an entry. */
  async function open(entryId, index = 0) {
    const entry = entryById(entryId);
    if (!canView(entry) || document.body.classList.contains('privacy-locked')) return false;
    const target = targetFor(entryId, index);
    if (!target) { toast(tr('This entry has no images.')); return false; }
    current = { entryId: entry.id, index: target.index };
    document.getElementById('detailMenuPopup')?.classList.remove('open');
    releasePreviews();
    const preview = $id('imageToolsPreview');
    preview.removeAttribute('src');
    preview.alt = target.caption || '';
    void displayUrl(target).then(url => { if (current && current.index === target.index && url) preview.src = url; });
    renderStrip(entry, target);
    render(target);
    showDialog(dialog());
    return true;
  }
  function openTarget(target) {
    if (!target) return false;
    if (target.entryId != null) return open(target.entryId, target.index);
    // A picked image without an entry (should not happen): run the sheet on it.
    current = null;
    releasePreviews();
    $id('imageToolsStrip').hidden = true;
    void displayUrl(target).then(url => { if (url) $id('imageToolsPreview').src = url; });
    render(target);
    showDialog(dialog());
    return true;
  }
  function close() { const d = dialog(); if (d && d.open) d.close(); }

  // ── shared helpers for tool modules ───────────────────────
  const TOOL_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/heic']);
  // A still image stored on this phone, which the native tools can read.
  function storedImage(target) {
    return !!target && !!target.storedPath && TOOL_MIMES.has(String(target.mime || '').toLowerCase());
  }
  function stillImage(target) {
    return !!target && String(target.mime || '').toLowerCase() !== 'image/gif';
  }
  function isNative() { return !!global.Capacitor?.isNativePlatform?.(); }

  function errorCode(error) {
    const code = String(error?.code || error?.errorCode || '').trim();
    if (code) return code.slice(0, 160);
    const match = String(error?.message || error || '').match(/[A-Z]+_[A-Z0-9_]+/);
    return (match?.[0] || 'TOOL_FAILED').slice(0, 160);
  }
  function friendlyError(error) {
    const code = errorCode(error);
    if (/APP_ONLY/.test(code)) return tr('toolAppOnly', 'This tool works on images stored in the Android app.');
    if (/PLAY_SERVICES|UNSUPPORTED/.test(code)) return tr('toolUnsupported', 'This tool needs Google Play services, which is unavailable on this device.');
    if (/MODEL|DOWNLOAD|NETWORK/.test(code)) return tr('toolNeedsModel', 'The on-device model is not ready yet. Connect to the internet once and try again.');
    if (/FILE_NOT_FOUND|MISSING|INVALID_PATH/.test(code)) return tr('toolMissingFile', 'The stored image could not be found.');
    if (/TIMEOUT/.test(code)) return tr('toolTimeout', 'That took too long. Try again when the phone is less busy.');
    if (/BUSY/.test(code)) return tr('toolBusy', 'Another tool is still working. Try again in a moment.');
    return tr('toolFailed', 'That tool could not run on this image.');
  }

  async function bounded(promise, ms, code) {
    let timer = 0;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
      })]);
    } finally { clearTimeout(timer); }
  }

  /** Calls an ImageInsights method on the target's stored file. */
  async function callNative(method, target, options = {}, ms = 120000) {
    const plugin = global.Capacitor?.Plugins?.ImageInsights;
    if (!isNative() || !plugin?.[method] || !target?.storedPath) throw Object.assign(new Error('Android only'), { code: 'TOOL_APP_ONLY' });
    return bounded(plugin[method](Object.assign({}, options, { path: target.storedPath })), ms, 'TOOL_TIMEOUT');
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Shows a dialog, even if it is still closing from a previous tool.
  function showDialog(dlg) {
    if (!dlg) return;
    if (dlg.classList.contains('closing')) {
      dlg.addEventListener('close', () => { if (!dlg.open) dlg.showModal(); }, { once: true });
    } else if (!dlg.open) dlg.showModal();
  }

  // Result sheet (codes, translation, cut-out preview).
  const result = {
    open(title) {
      $id('toolResultTitle').textContent = title;
      $id('toolResultBody').replaceChildren();
      $id('toolResultActions').replaceChildren();
      showDialog($id('toolResultDlg'));
      return result;
    },
    busy(text) {
      const row = element('div', 'tool-busy');
      row.append(element('span', 'tool-spinner'), element('span', '', text));
      $id('toolResultBody').replaceChildren(row);
      $id('toolResultActions').replaceChildren();
    },
    show(...nodes) { $id('toolResultBody').replaceChildren(...nodes); },
    message(text, tone = '') {
      const p = element('p', 'tool-message', text);
      if (tone) p.dataset.tone = tone;
      result.show(p);
    },
    actions(list) {
      $id('toolResultActions').replaceChildren(...list.map(item => {
        const button = element('button', item.primary ? 'primary' : 'ghost', item.label);
        button.type = 'button';
        button.addEventListener('click', item.run);
        return button;
      }));
    },
    get isOpen() { return !!$id('toolResultDlg')?.open; },
    close() { const d = $id('toolResultDlg'); if (d && d.open) d.close(); },
  };

  // Full-screen editor (Privacy blur, Scan document).
  const editor = {
    open(title, hint = '') {
      $id('toolEditorTitle').textContent = title;
      $id('toolEditorHint').textContent = hint;
      $id('toolEditorOptions').replaceChildren();
      $id('toolEditorActions').replaceChildren();
      $id('toolEditorOverlay').replaceChildren();
      editor.busy(false);
      showDialog($id('toolEditorDlg'));
      return editor;
    },
    get canvas() { return $id('toolEditorCanvas'); },
    get overlay() { return $id('toolEditorOverlay'); },
    get stage() { return $id('toolEditorStage'); },
    busy(text) {
      $id('toolEditorBusy').hidden = !text;
      if (text) $id('toolEditorBusyText').textContent = text;
    },
    hint(text) { $id('toolEditorHint').textContent = text; },
    options(nodes) { $id('toolEditorOptions').replaceChildren(...nodes); },
    actions(list) {
      $id('toolEditorActions').replaceChildren(...list.map(item => {
        const button = element('button', item.primary ? 'primary' : 'ghost', item.label);
        button.type = 'button';
        if (item.id) button.id = item.id;
        button.addEventListener('click', item.run);
        return button;
      }));
    },
    get isOpen() { return !!$id('toolEditorDlg')?.open; },
    close() { const d = $id('toolEditorDlg'); if (d && d.open) d.close(); },
    onClose: null,
  };

  /** Full-resolution image element for a target (EXIF orientation applied by the WebView). */
  async function loadFullImage(target) {
    let src = '';
    let owned = false;
    if (target.storedPath && global.MemoStateDb?.readBlob && global.MemoContracts?.getMode?.() !== 'server') {
      const blob = await global.MemoStateDb.readBlob(target.storedPath).catch(() => null);
      if (blob) { src = URL.createObjectURL(blob); owned = true; }
    }
    if (!src) src = target.url || '';
    if (!src) throw Object.assign(new Error('missing'), { code: 'TOOL_FILE_NOT_FOUND' });
    const image = new Image();
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';
    image.src = src;
    try { await image.decode(); }
    catch (_e) { throw Object.assign(new Error('missing'), { code: 'TOOL_FILE_NOT_FOUND' }); }
    finally { if (owned) setTimeout(() => URL.revokeObjectURL(src), 60000); }
    return image;
  }

  function canvasBlob(canvas, mime = 'image/jpeg', quality = 0.92) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('encode failed')), mime, quality));
  }
  function base64Blob(base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  }
  function extFor(mime) { return mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg'); }

  function closeToolSurfaces() {
    close(); result.close(); editor.close();
    global.MemoReader?.close?.();
    const detail = $id('detailDlg'); if (detail?.open) detail.close();
    global.MemoAdvancedTools?.close?.();
  }
  function canAddToEntry() {
    return global.MEMO_VARIANT !== 'planner' && typeof global.openEntryModal === 'function' && !!global.MemoCore?.addImages;
  }

  /**
   * Adds a tool's output to the source image's entry through the entry form:
   * the person reviews it and taps Post (the Image Editor's hand-off). With no
   * live source entry, the output starts a new entry instead.
   */
  async function saveCopy(source, blob, { caption, tool } = {}) {
    if (!canAddToEntry()) throw Object.assign(new Error('Open Memo or Finance to save this image.'), { code: 'TOOL_APP_ONLY' });
    const type = blob.type || 'image/jpeg';
    const base = String(caption || tool || 'image').replace(/[^\w -]+/g, '_').trim().slice(0, 50) || 'image';
    const file = new File([blob], `${base}-${tool || 'tool'}.${extFor(type)}`, { type });
    const entry = source?.entryId != null ? entryById(source.entryId) : null;
    if (entry && !canView(entry)) throw new Error(tr('This image is no longer available.'));
    closeToolSurfaces();
    global.openEntryModal(entry || null);
    if (!entry && caption) { const desc = $id('desc'); if (desc && !desc.value) desc.value = caption; }
    await global.MemoCore.addImages([file]);
    await global.MemoDraft?.saveChecked?.().catch?.(() => {});
    toast(tr(entry ? 'toolSavedCopy' : 'New entry started. Review it and tap Post.', entry ? '' : 'New entry started. Review it and tap Post.'), 'success');
    return entry;
  }

  /** Shares a tool's output through the phone's share sheet. */
  async function shareBlob(source, blob, caption) {
    const crop = global.MemoCrop;
    if (!crop?.shareBlob) throw new Error('Sharing is unavailable');
    await crop.shareBlob(blob, String(caption || 'image').replace(/[^\w -]+/g, '_').slice(0, 50) || 'image');
    return true;
  }

  async function copyText(value) {
    try {
      const Clipboard = global.Capacitor?.Plugins?.Clipboard;
      if (Clipboard?.write) await Clipboard.write({ string: value });
      else await navigator.clipboard.writeText(value);
      toast(tr('Copied to clipboard'), 'success');
    } catch (_e) {
      toast(tr('Could not copy.'), 'error');
    }
  }

  function run(toolId, target) {
    const tool = tools.find(item => item.id === toolId);
    if (tool && target) return tool.run(target);
    return null;
  }

  // ── wiring ─────────────────────────────────────────────────
  function wire() {
    $id('imageToolsClose')?.addEventListener('click', close);
    $id('toolResultClose')?.addEventListener('click', () => result.close());
    $id('toolEditorClose')?.addEventListener('click', () => editor.close());
    dialog()?.addEventListener('close', () => { current = null; releasePreviews(); });
    $id('toolEditorDlg')?.addEventListener('close', () => {
      const handler = editor.onClose;
      editor.onClose = null;
      if (typeof handler === 'function') handler();
    });
    document.addEventListener('memo:privacy-locked', () => { close(); result.close(); editor.close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoTools = {
    register, open, openTarget, close, run, targetsFor, targetFor, targetFromPick,
    list: () => tools.map(tool => tool.id),
    available: target => tools.filter(tool => { try { return tool.available(target); } catch (_e) { return false; } }).map(tool => tool.id),
    // helpers for tool modules
    tr, toast, element, result, editor, storedImage, stillImage, isNative, callNative, friendlyError, errorCode,
    loadFullImage, canvasBlob, base64Blob, saveCopy, shareBlob, copyText, canAddToEntry, closeToolSurfaces, showDialog,
  };
})(window);
