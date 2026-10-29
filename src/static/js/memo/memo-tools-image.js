// memo-tools-image.js — image tools for one image of an entry: Read QR &
// barcodes, Translate, Remove background, Privacy blur and Scan document, plus
// "Scan documents" with the camera into a new entry. Ported from ImageDB's
// image-tools-more.js and image-tools-editors.js. Detection, recognition and
// translation run on the phone (ML Kit through Google Play services); the
// pixel work (pixelation, perspective correction, clean-up) runs in a canvas.
// Nothing is stored except a result the person adds to an entry.
(function (global) {
  'use strict';
  const T = global.MemoTools;
  if (!T) return;
  const { tr, element, result, editor } = T;
  const showToast = message => T.toast(message, 'error');

  // On-device analysis of the image (labels, faces, codes) when it exists.
  function insightOf(target) {
    return global.MemoInsights?.forTarget?.(target) || null;
  }
  // Paper, receipts, menus, screenshots: the text and scan tools come first.
  const DOCUMENT_LABELS = new Set([240, 273, 267, 263, 135, 121, 324]);
  function looksLikeDocument(target) {
    return !!insightOf(target)?.labels?.some(([index, score]) => DOCUMENT_LABELS.has(index) && score >= 0.55);
  }

  // ── from ImageDB image-tools-more.js ──

  // ── Read QR codes & barcodes (free) ───────────────────────
  // Barcode.TYPE_* values from ML Kit.
  const CODE_TYPES = { 1: 'contact', 2: 'email', 4: 'phone', 5: 'product', 7: 'text', 8: 'url', 9: 'wifi', 10: 'geo', 11: 'calendar', 12: 'license' };

  function codeTitle(code) {
    const type = CODE_TYPES[code.type] || 'text';
    return tr('codeType_' + type, {
      contact: 'Contact', email: 'Email', phone: 'Phone number', product: 'Product code', text: 'Text',
      url: 'Link', wifi: 'Wi-Fi network', geo: 'Location', calendar: 'Event', license: 'Driver’s licence',
    }[type]);
  }

  function safeExternalUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:', 'mailto:', 'tel:', 'geo:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }

  function codeCard(code) {
    const card = element('div', 'code-card');
    card.append(element('div', 'code-card-type', codeTitle(code)));
    const actions = element('div', 'code-card-actions');
    const add = (label, onClick, primary = false) => {
      const button = element('button', primary ? 'primary' : 'ghost', label);
      button.type = 'button';
      button.addEventListener('click', onClick);
      actions.append(button);
    };
    if (code.wifi) {
      card.append(element('div', 'code-card-value', code.wifi.ssid || ''));
      if (code.wifi.password) {
        const password = element('div', 'code-card-secret', '••••••••');
        let shown = false;
        password.addEventListener('click', () => {
          shown = !shown;
          password.textContent = shown ? code.wifi.password : '••••••••';
        });
        card.append(password);
        add(tr('codeCopyPassword', 'Copy password'), () => T.copyText(code.wifi.password), true);
      }
    } else {
      card.append(element('div', 'code-card-value', code.display || code.raw || ''));
    }
    const link = code.url ? safeExternalUrl(code.url)
      : code.phone ? safeExternalUrl('tel:' + code.phone)
      : code.email ? safeExternalUrl('mailto:' + code.email) : '';
    if (link) add(tr('codeOpen', 'Open'), () => window.open(link, '_blank', 'noopener'), !code.wifi);
    if (code.raw) add(tr('copyAction', 'Copy'), () => T.copyText(code.raw));
    card.append(actions);
    return card;
  }

  async function readCodes(entry) {
    result.open(tr('toolCodes', 'QR code & barcode'));
    result.busy(tr('codesReading', 'Looking for codes…'));
    try {
      const found = (await T.callNative('readCodes', entry))?.codes || [];
      if (!result.isOpen) return;
      if (!found.length) {
        result.message(tr('codesNone', 'No QR code or barcode was found in this image.'));
        return;
      }
      const list = element('div', 'code-list');
      list.append(...found.map(codeCard));
      result.show(list);
    } catch (error) {
      if (result.isOpen) result.message(T.friendlyError(error), 'error');
    }
  }

  T.register({
    id: 'read-codes', group: 'find', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h2.5v2.5M20.5 14v6.5H14"/></svg>',
    label: ['toolCodes', 'QR code & barcode'],
    available: target => T.isNative() && T.storedImage(target),
    suggested: target => (insightOf(target)?.codes || 0) > 0,
    run: readCodes,
  });

  // ── Translate (free) ──────────────────────────────────────
  // UI locale → ML Kit language tag.
  const LOCALE_TAGS = { en: 'en', es: 'es', fr: 'fr', de: 'de', pt: 'pt', nl: 'nl', zh: 'zh', ja: 'ja' };
  const SCRIPTS = [['auto', 'Auto'], ['latin', 'Latin'], ['chinese', '中文'], ['japanese', '日本語'], ['korean', '한국어']];

  function languageName(tag) {
    try {
      const locale = window.MemoI18n?.getLocale?.() || 'en';
      return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) || tag;
    } catch { return tag; }
  }

  // Recognition for translation only: the entry's description is not changed.
  async function recognizeOnce(target, script) {
    const ocr = window.MemoOcrNative;
    if (!T.isNative() || !ocr?.available?.()) throw Object.assign(new Error('Android only'), { code: 'TOOL_APP_ONLY' });
    result.busy(tr('translateReading', 'Reading the text…'));
    const image = await T.loadFullImage(target);
    const out = await ocr.recognize(image.src, script && script !== 'auto' ? { language: script } : {});
    return String(out?.text || '');
  }

  function select(options, value) {
    const node = element('select', 'tool-select');
    for (const [optionValue, label] of options) {
      const option = element('option', '', label);
      option.value = optionValue;
      node.append(option);
    }
    node.value = value;
    return node;
  }

  async function translateImage(entry, script = null) {
    const translator = window.Capacitor?.Plugins?.Translate;
    result.open(tr('toolTranslate', 'Translate'));
    if (!translator) { result.message(T.friendlyError({ code: 'TOOL_APP_ONLY' }), 'error'); return; }
    const scriptChoice = script || 'auto';
    let text;
    try {
      text = (await recognizeOnce(entry, scriptChoice)).trim();
    } catch (error) {
      if (result.isOpen) result.message(T.friendlyError(error), 'error');
      return;
    }
    if (!result.isOpen) return;

    const scriptSelect = select(SCRIPTS, scriptChoice);
    scriptSelect.addEventListener('change', () => void translateImage(entry, scriptSelect.value));
    const scriptRow = element('label', 'tool-field');
    scriptRow.append(element('span', '', tr('translateScript', 'Text in the image')), scriptSelect);
    if (!text) {
      result.show(element('p', 'tool-message', tr('translateNoText', 'No text was found. If the text uses another alphabet, choose it below.')), scriptRow);
      return;
    }

    result.busy(tr('translateDetecting', 'Detecting the language…'));
    let source = 'und';
    try { source = (await translator.identifyLanguage({ text })).language || 'und'; } catch (_) {}
    const { languages = [] } = await translator.getLanguages().catch(() => ({}));
    if (!result.isOpen) return;
    const locale = (window.MemoI18n?.getLocale?.() || 'en').split('-')[0];
    let target = LOCALE_TAGS[locale] || 'en';
    if (target === source) target = source === 'en' ? 'es' : 'en';
    const options = languages.map(tag => [tag, languageName(tag)]).sort((a, b) => a[1].localeCompare(b[1]));
    const sourceSelect = select([['und', tr('translateUnknown', 'Unknown')], ...options], languages.includes(source) ? source : 'und');
    const targetSelect = select(options, target);
    const original = element('pre', 'translate-text translate-original', text);
    const translated = element('pre', 'translate-text translate-output');
    const status = element('p', 'tool-message');

    const fields = element('div', 'translate-fields');
    const from = element('label', 'tool-field');
    from.append(element('span', '', tr('translateFrom', 'From')), sourceSelect);
    const to = element('label', 'tool-field');
    to.append(element('span', '', tr('translateTo', 'To')), targetSelect);
    fields.append(from, to);

    async function translateNow() {
      if (sourceSelect.value === 'und') { status.textContent = tr('translatePickSource', 'Choose the language of the text.'); return; }
      const models = await translator.getDownloadedModels().catch(() => ({ languages: [] }));
      const missing = [sourceSelect.value, targetSelect.value].filter(tag => tag !== 'en' && !(models.languages || []).includes(tag));
      status.textContent = missing.length
        ? tr('translateDownloading', 'Downloading {langs} for offline translation (about 30 MB each, once)…', { langs: missing.map(languageName).join(', ') })
        : tr('translateWorking', 'Translating…');
      translated.textContent = '';
      try {
        const output = await translator.translate({ text, source: sourceSelect.value, target: targetSelect.value });
        if (!result.isOpen) return;
        translated.textContent = output.text || '';
        status.textContent = tr('translateDone', 'Translated on this device.');
      } catch (error) {
        status.textContent = /UNSUPPORTED/.test(T.errorCode(error))
          ? tr('translateUnsupported', 'This language pair cannot be translated.')
          : tr('translateFailed', 'Translation failed. Connect to the internet once to download the language packs.');
      }
    }
    sourceSelect.addEventListener('change', () => void translateNow());
    targetSelect.addEventListener('change', () => void translateNow());

    const originalBlock = element('details', 'translate-original-block');
    originalBlock.append(element('summary', '', tr('translateOriginal', 'Original text')), original);
    result.show(fields, translated, status, originalBlock, scriptRow);
    result.actions([
      { label: tr('translateCopy', 'Copy translation'), primary: true, run: () => translated.textContent && T.copyText(translated.textContent) },
      { label: tr('translateCopyOriginal', 'Copy original'), run: () => T.copyText(text) },
    ]);
    void translateNow();
  }

  T.register({
    id: 'translate', group: 'text', icon: '<span class="image-tool-glyph">文A</span>',
    label: ['toolTranslate', 'Translate'],
    available: target => T.isNative() && !!window.Capacitor?.Plugins?.Translate && T.stillImage(target),
    suggested: target => looksLikeDocument(target),
    run: target => translateImage(target),
  });

  // ── Remove background (Advanced) ──────────────────────────
  async function removeBackground(entry) {
    const title = tr('toolCutout', 'Remove background');
    const work = async () => {
      result.open(title);
      result.busy(tr('cutoutWorking', 'Finding the subject…'));
      try {
        const output = await T.callNative('segmentSubject', entry, { mode: 'cutout' });
        if (!result.isOpen) return;
        if (!output?.found || !output.png) {
          result.message(tr('cutoutNone', 'No clear subject was found in this image.'));
          return;
        }
        const blob = T.base64Blob(output.png, 'image/png');
        const url = URL.createObjectURL(blob);
        const preview = element('div', 'cutout-preview');
        const image = element('img');
        image.src = url;
        image.alt = tr('cutoutAlt', 'Subject with the background removed');
        preview.append(image);
        result.show(preview);
        const caption = tr('cutoutCaption', '{name} (cutout)', { name: entry.caption || tr('imageLabel', 'Image') });
        const canAdd = T.canAddToEntry();
        result.actions([
          ...(canAdd ? [{ label: tr('toolSaveCopy', 'Save as new image'), primary: true, run: async () => {
            try { await T.saveCopy(entry, blob, { caption, tool: 'cutout' }); result.close(); }
            catch (error) { showToast(T.friendlyError(error)); }
          } }] : []),
          { label: tr('shareAction', 'Share'), primary: !canAdd, run: () => void T.shareBlob(entry, blob, caption).catch(error => showToast(T.friendlyError(error))) },
        ]);
        resultDlgCleanup(url);
      } catch (error) {
        if (result.isOpen) result.message(T.friendlyError(error), 'error');
      }
    };
    await work();
  }

  function resultDlgCleanup(url) {
    document.getElementById('toolResultDlg').addEventListener('close', () => URL.revokeObjectURL(url), { once: true });
  }

  // ── Scan documents with the camera (free) ─────────────────
  // Google's ML Kit document scanner (Play services) finds the page edges,
  // straightens and cleans the scan; the pages then open in the New Entry form,
  // where the person reviews them and taps Post.
  async function scanNewDocuments() {
    window.MemoShell?.closeMenu?.();
    window.MemoAdvancedTools?.close?.();
    const scanner = window.Capacitor?.Plugins?.DocumentScanner;
    if (!T.isNative() || !scanner?.scan) { showToast(T.friendlyError({ code: 'TOOL_APP_ONLY' })); return; }
    if (!T.canAddToEntry()) { showToast(tr('scanOpenMemo', 'Open Memo or Finance to scan into a new entry.')); return; }
    let output;
    try {
      output = await scanner.scan({ pageLimit: 20 });
    } catch (error) {
      showToast(tr('scanNewUnavailable', 'The document scanner is not available. It needs Google Play services and a connection the first time.'));
      return;
    }
    const pages = (output?.pages || []).filter(page => page?.data);
    if (output?.cancelled || !pages.length) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const files = pages.map((page, index) => new File([T.base64Blob(page.data, page.mime || 'image/jpeg')],
      `scan-${stamp}-page_${index + 1}.jpg`, { type: page.mime || 'image/jpeg' }));
    window.openEntryModal(null);
    const desc = document.getElementById('desc');
    if (desc && !desc.value) desc.value = tr('scanNewCaption', 'Scan {date}', { date: new Date().toLocaleDateString(window.MemoI18n?.getLocale?.() || undefined) });
    await window.MemoCore.addImages(files);
    await window.MemoDraft?.saveChecked?.()?.catch?.(() => {});
  }

  window.MemoTools.scanNewDocuments = scanNewDocuments;

  T.register({
    id: 'remove-background', group: 'edit', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8.1 7.6 20 17.5M8.1 16.4 20 6.5"/></svg>',
    label: ['toolCutout', 'Remove background'],
    available: target => T.isNative() && T.storedImage(target),
    run: removeBackground,
  });

  // ── from ImageDB image-tools-editors.js ──
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_WORK_EDGE = 3000;

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    return node;
  }

  // Lays the canvas and overlay over each other at the largest size that fits the stage.
  function layout(width, height) {
    const stage = editor.stage;
    const box = stage.getBoundingClientRect();
    const scale = Math.min((box.width - 16) / width, (box.height - 16) / height, 1);
    const cssWidth = Math.max(1, Math.floor(width * scale));
    const cssHeight = Math.max(1, Math.floor(height * scale));
    for (const node of [editor.canvas, editor.overlay]) {
      node.style.width = cssWidth + 'px';
      node.style.height = cssHeight + 'px';
    }
    editor.overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
    return { cssWidth, cssHeight };
  }

  // Pointer position in image pixels.
  function imagePoint(event, width, height) {
    const rect = editor.overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width, (event.clientX - rect.left) / rect.width * width)),
      y: Math.max(0, Math.min(height, (event.clientY - rect.top) / rect.height * height)),
    };
  }

  function workCanvas(image) {
    const scale = Math.min(1, MAX_WORK_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function outputMime(entry) {
    return String(entry.mime || '').toLowerCase() === 'image/png' ? 'image/png' : 'image/jpeg';
  }

  function chip(label, pressed, onClick, icon = '') {
    const button = element('button', 'tool-chip' + (icon ? ' with-icon' : ''));
    button.type = 'button';
    if (icon) {
      const glyph = element('span', 'tool-chip-icon');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = icon;
      button.append(glyph);
    }
    button.append(element('span', 'tool-chip-label', label));
    button.setAttribute('aria-pressed', String(!!pressed));
    button.addEventListener('click', onClick);
    return button;
  }

  // A titled group of editor controls, so related choices sit together.
  function controlSection(title, hint, nodes) {
    const section = element('section', 'tool-section');
    const head = element('div', 'tool-section-head');
    head.append(element('strong', 'tool-section-title', title));
    if (hint) head.append(element('span', 'tool-section-hint', hint));
    const row = element('div', 'tool-section-row');
    row.append(...nodes);
    section.append(head, row);
    return section;
  }

  const ICON = (paths) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const BLUR_ICONS = {
    face: ICON('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.8 3.9-5.8 7-5.8s5.8 2 7 5.8"/>'),
    text: ICON('<path d="M5 6.5h14M12 6.5V19M9 19h6"/>'),
    paint: ICON('<path d="M4.5 20c2.6 0 4.3-1.6 4.3-4.1a2.9 2.9 0 0 1 2.9-2.9"/><path d="m11.7 13 8-8a1.9 1.9 0 0 1 2.7 2.7l-8 8"/><path d="m11 12.4 2.6 2.6"/>'),
    erase: ICON('<path d="M9 20h11"/><path d="M5.2 15.3 13.9 6.6a2 2 0 0 1 2.8 0l2.7 2.7a2 2 0 0 1 0 2.8L12 19.5H9.4Z"/><path d="m9.4 11.1 5.5 5.5"/>'),
    mosaic: ICON('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1" opacity=".45"/><rect x="4" y="13" width="7" height="7" rx="1" opacity=".45"/>'),
    gaussian: ICON('<circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="12" r="6" opacity=".55"/><circle cx="12" cy="12" r="9.3" opacity=".25"/>'),
    mask: ICON('<path d="M2.5 12S6 5.6 12 5.6 21.5 12 21.5 12 18 18.4 12 18.4 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
    undo: ICON('<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>'),
  };

  // ── Privacy blur (free) ───────────────────────────────────
  // One blur mask: detected faces and text lines start in it (chips toggle
  // them), Paint adds to it and Erase removes from it. "Show mask" (or holding
  // a finger still) shows the masked area as an inverting marker; otherwise the
  // canvas shows the pixelated result that will be shared or saved.
  const HOLD_TO_PREVIEW_MS = 380;

  // Coarse blocks then a blur over them: small pixel blocks alone can leave a
  // large face recognizable.
  function pixelatedCopy(source) {
    const { width, height } = source;
    const block = Math.max(10, Math.round(Math.max(width, height) / 40));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(width / block));
    small.height = Math.max(1, Math.round(height / block));
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(source, 0, 0, small.width, small.height);
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.filter = `blur(${Math.round(block * 0.6)}px)`;
    // Draw slightly oversized so the blur does not fade in from transparent edges.
    octx.drawImage(small, -block, -block, width + block * 2, height + block * 2);
    octx.filter = 'none';
    return out;
  }

  // A strong Gaussian blur (the alternative to the mosaic look). Drawn
  // oversized so the edges do not fade in from transparency.
  function gaussianCopy(source) {
    const { width, height } = source;
    const radius = Math.max(8, Math.round(Math.max(width, height) / 45));
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const octx = out.getContext('2d');
    octx.filter = `blur(${radius}px)`;
    octx.drawImage(source, -radius, -radius, width + radius * 2, height + radius * 2);
    octx.filter = 'none';
    return out;
  }

  const BLUR_STYLE_KEY = 'memora_blur_style_v1';
  function savedBlurStyle() {
    try { return localStorage.getItem(BLUR_STYLE_KEY) === 'gaussian' ? 'gaussian' : 'mosaic'; } catch (_) { return 'mosaic'; }
  }

  function invertedCopy(source) {
    const out = document.createElement('canvas');
    out.width = source.width; out.height = source.height;
    const octx = out.getContext('2d');
    octx.drawImage(source, 0, 0);
    const image = octx.getImageData(0, 0, out.width, out.height);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i]; data[i + 1] = 255 - data[i + 1]; data[i + 2] = 255 - data[i + 2];
    }
    octx.putImageData(image, 0, 0);
    return out;
  }

  function blankLike(source) {
    const out = document.createElement('canvas');
    out.width = source.width; out.height = source.height;
    return out;
  }

  // shareFirst: opened from Share, so sharing is the main action.
  async function privacyBlur(entry, { shareFirst = false } = {}) {
    editor.open(tr('toolBlur', 'Privacy blur'), tr('blurHint', 'Hold a finger still on the image to see exactly what will be hidden.'));
    editor.busy(tr('blurFinding', 'Finding faces and text…'));
    let image, detected;
    try {
      [image, detected] = await Promise.all([
        T.loadFullImage(entry),
        T.callNative('detectRegions', entry).catch(error => {
          // Without detection the tool still works with the brush.
          if (/APP_ONLY/.test(T.errorCode(error))) return { faces: [], text: [], unavailable: true };
          throw error;
        }),
      ]);
    } catch (error) {
      editor.busy(false);
      editor.hint(T.friendlyError(error));
      return;
    }
    if (!editor.isOpen) return;
    editor.busy(false);

    const source = workCanvas(image);
    const width = source.width;
    const height = source.height;
    const canvas = editor.canvas;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    layout(width, height);
    let blurStyle = savedBlurStyle();
    const effects = {};
    const effect = () => effects[blurStyle] || (effects[blurStyle] =
      blurStyle === 'gaussian' ? gaussianCopy(source) : pixelatedCopy(source));
    const inverted = invertedCopy(source);
    const mask = blankLike(source);
    const mctx = mask.getContext('2d');
    const layer = blankLike(source);
    const lctx = layer.getContext('2d');

    const toPx = (box, pad) => {
      const padX = box.w * pad, padY = box.h * pad;
      return { x: (box.x - padX) * width, y: (box.y - padY) * height, w: (box.w + padX * 2) * width, h: (box.h + padY * 2) * height };
    };
    const regions = [
      ...(detected.faces || []).map(box => ({ kind: 'face', ...toPx(box, 0.18) })),
      ...(detected.text || []).map(box => ({ kind: 'text', ...toPx(box, 0.06) })),
    ];
    const groupOn = { face: true, text: true };
    const strokes = [];
    const maxDim = Math.max(width, height);
    let brush = Math.round(maxDim * 0.045);
    let tool = 'paint';
    let showMask = false;
    let holdPreview = false;

    function paintRegions() {
      mctx.fillStyle = '#fff';
      for (const region of regions) {
        if (!groupOn[region.kind]) continue;
        mctx.beginPath();
        if (region.kind === 'face') {
          mctx.ellipse(region.x + region.w / 2, region.y + region.h / 2, region.w / 2, region.h / 2, 0, 0, Math.PI * 2);
        } else {
          mctx.rect(region.x, region.y, region.w, region.h);
        }
        mctx.fill();
      }
    }

    function strokeSegment(stroke, from, to) {
      mctx.save();
      mctx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
      mctx.strokeStyle = '#fff';
      mctx.fillStyle = '#fff';
      mctx.lineWidth = stroke.size;
      mctx.lineCap = 'round';
      mctx.lineJoin = 'round';
      if (!to || (to.x === from.x && to.y === from.y)) {
        mctx.beginPath();
        mctx.arc(from.x, from.y, stroke.size / 2, 0, Math.PI * 2);
        mctx.fill();
      } else {
        mctx.beginPath();
        mctx.moveTo(from.x, from.y);
        mctx.lineTo(to.x, to.y);
        mctx.stroke();
      }
      mctx.restore();
    }

    function rebuildMask() {
      mctx.clearRect(0, 0, width, height);
      paintRegions();
      for (const stroke of strokes) {
        const points = stroke.points;
        strokeSegment(stroke, points[0], null);
        for (let i = 1; i < points.length; i++) strokeSegment(stroke, points[i - 1], points[i]);
      }
    }

    let frame = 0;
    function compose() {
      frame = 0;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(source, 0, 0);
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, width, height);
      lctx.drawImage(showMask || holdPreview ? inverted : effect(), 0, 0);
      lctx.globalCompositeOperation = 'destination-in';
      lctx.drawImage(mask, 0, 0);
      ctx.drawImage(layer, 0, 0);
    }
    const scheduleCompose = () => { if (!frame) frame = requestAnimationFrame(compose); };

    function coverage() {
      const data = mctx.getImageData(0, 0, width, height).data;
      let on = 0;
      for (let i = 3; i < data.length; i += 16) if (data[i] > 127) on++;
      return on / (data.length / 16);
    }

    // Brush footprint under the finger while it is down.
    const ring = svg('circle', { class: 'blur-brush-ring', r: brush / 2, cx: -9999, cy: -9999, 'vector-effect': 'non-scaling-stroke' });
    editor.overlay.replaceChildren(ring);
    const moveRing = (point, visible) => {
      ring.setAttribute('r', String(brush / 2));
      ring.setAttribute('cx', String(visible ? point.x : -9999));
      ring.setAttribute('cy', String(visible ? point.y : -9999));
      ring.classList.toggle('erase', tool === 'erase');
    };

    // While the size slider moves, its ring shows the brush in the middle of the image.
    let sizePreviewTimer = 0;
    function previewBrushSize() {
      moveRing({ x: width / 2, y: height / 2 }, true);
      clearTimeout(sizePreviewTimer);
      sizePreviewTimer = setTimeout(() => { if (!pointer) moveRing(null, false); }, 700);
    }

    function renderOptions() {
      const count = kind => regions.filter(region => region.kind === kind).length;
      const sections = [];
      const found = [];
      for (const [kind, key, fallback] of [['face', 'blurFaces', 'Faces ({n})'], ['text', 'blurText', 'Text ({n})']]) {
        if (!count(kind)) continue;
        found.push(chip(tr(key, fallback, { n: count(kind) }), groupOn[kind], () => {
          groupOn[kind] = !groupOn[kind];
          rebuildMask(); compose(); renderOptions();
        }, BLUR_ICONS[kind]));
      }
      if (found.length) {
        sections.push(controlSection(tr('blurSectionFound', 'Found'),
          tr('blurSectionFoundHint', 'Tap to blur it or keep it sharp'), found));
      }

      const size = element('input', 'blur-size');
      size.type = 'range';
      size.min = String(Math.max(4, Math.round(maxDim * 0.01)));
      size.max = String(Math.round(maxDim * 0.14));
      size.value = String(brush);
      size.setAttribute('aria-label', tr('blurBrushSize', 'Brush size'));
      size.addEventListener('input', () => { brush = Number(size.value); previewBrushSize(); });
      const sizeLabel = element('label', 'blur-size-label');
      sizeLabel.append(element('span', '', tr('blurSize', 'Size')), size);
      const undo = chip(tr('blurUndo', 'Undo'), false, () => {
        strokes.pop(); rebuildMask(); compose(); renderOptions();
      }, BLUR_ICONS.undo);
      undo.disabled = !strokes.length;
      sections.push(controlSection(tr('blurSectionBrush', 'Brush'),
        tr('blurSectionBrushHint', 'Paint adds blur, Erase keeps an area sharp'), [
          chip(tr('blurPaint', 'Paint'), tool === 'paint', () => { tool = 'paint'; renderOptions(); }, BLUR_ICONS.paint),
          chip(tr('blurErase', 'Erase'), tool === 'erase', () => { tool = 'erase'; renderOptions(); }, BLUR_ICONS.erase),
          undo,
          sizeLabel,
        ]));

      const setStyle = style => {
        blurStyle = style;
        try { localStorage.setItem(BLUR_STYLE_KEY, style); } catch (_) {}
        compose(); renderOptions();
      };
      sections.push(controlSection(tr('blurSectionEffect', 'Effect'),
        tr('blurSectionEffectHint', 'How the hidden areas look'), [
          chip(tr('blurMosaic', 'Mosaic'), blurStyle === 'mosaic', () => setStyle('mosaic'), BLUR_ICONS.mosaic),
          chip(tr('blurGaussian', 'Blur'), blurStyle === 'gaussian', () => setStyle('gaussian'), BLUR_ICONS.gaussian),
          chip(tr('blurShowMask', 'Show mask'), showMask, () => { showMask = !showMask; compose(); renderOptions(); }, BLUR_ICONS.mask),
        ]));
      editor.options(sections);
      if (!regions.length && !strokes.length) {
        editor.hint(detected.unavailable
          ? tr('blurManualOnly', 'Paint over the areas to blur.')
          : tr('blurNoneFound', 'No faces or text were found. Paint over anything you want to blur.'));
      }
    }

    // A move starts a stroke; holding still previews the mask; a tap leaves a dot.
    let pointer = null;
    const overlay = editor.overlay;
    const onDown = event => {
      if (pointer) return;
      const point = imagePoint(event, width, height);
      pointer = { id: event.pointerId, start: point, last: point, stroke: null,
        hold: setTimeout(() => { if (pointer && !pointer.stroke) { holdPreview = true; compose(); } }, HOLD_TO_PREVIEW_MS) };
      overlay.setPointerCapture?.(event.pointerId);
      moveRing(point, true);
    };
    const onMove = event => {
      if (!pointer || event.pointerId !== pointer.id) return;
      const point = imagePoint(event, width, height);
      moveRing(point, true);
      if (!pointer.stroke) {
        if (holdPreview || Math.hypot(point.x - pointer.start.x, point.y - pointer.start.y) < maxDim * 0.006) return;
        clearTimeout(pointer.hold);
        pointer.stroke = { mode: tool, size: brush, points: [pointer.start] };
        strokes.push(pointer.stroke);
        strokeSegment(pointer.stroke, pointer.start, null);
      }
      pointer.stroke.points.push(point);
      strokeSegment(pointer.stroke, pointer.last, point);
      pointer.last = point;
      scheduleCompose();
    };
    const onUp = event => {
      if (!pointer || event.pointerId !== pointer.id) return;
      clearTimeout(pointer.hold);
      const cancelled = event.type === 'pointercancel';
      if (holdPreview) {
        holdPreview = false;
      } else if (!pointer.stroke && !cancelled) {
        const dot = { mode: tool, size: brush, points: [pointer.start] };
        strokes.push(dot);
        strokeSegment(dot, pointer.start, null);
      }
      pointer = null;
      moveRing(null, false);
      compose();
      renderOptions();
    };
    overlay.addEventListener('pointerdown', onDown);
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
    overlay.addEventListener('pointercancel', onUp);
    editor.onClose = () => {
      overlay.removeEventListener('pointerdown', onDown);
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerup', onUp);
      overlay.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(frame);
      window.MemoToolEditors.blurState = null;
    };

    // The output is always the pixelated result, whatever the preview shows.
    const output = () => {
      const wasShowing = showMask;
      showMask = false; holdPreview = false;
      compose();
      const blob = T.canvasBlob(canvas, outputMime(entry), 0.92);
      showMask = wasShowing;
      return blob.finally(() => compose());
    };
    const caption = tr('blurCaption', '{name} (blurred)', { name: entry.caption || tr('imageLabel', 'Image') });
    const share = { label: tr('shareAction', 'Share'), primary: shareFirst, run: async () => {
      try { await T.shareBlob(entry, await output(), caption); } catch (error) { showToast(T.friendlyError(error)); }
    } };
    const save = { label: tr('toolSaveCopy', 'Save as new image'), primary: !shareFirst, run: async () => {
      try { await T.saveCopy(entry, await output(), { caption, tool: 'blur' }); editor.close(); }
      catch (error) { showToast(T.friendlyError(error)); }
    } };
    if (!T.canAddToEntry()) share.primary = true;
    editor.actions(!T.canAddToEntry() ? [share] : (shareFirst ? [save, share] : [share, save]));

    window.MemoToolEditors.blurState = () => ({ coverage: coverage(), strokes: strokes.length, tool, showMask, brush, style: blurStyle });
    rebuildMask();
    compose();
    renderOptions();
  }

  // ── "Share safely?" — offered before sharing an image with faces or text ──
  const SHARE_BLUR_KEY = 'memora_share_blur_offer_v1';
  const SENSITIVE_LABELS = new Set([240, 273, 267, 263, 135, 121, 324]); // receipt, paper, passport, newspaper, menu, screenshot, web page

  function offerEnabled() {
    try { return localStorage.getItem(SHARE_BLUR_KEY) !== 'off'; } catch { return true; }
  }

  function setOfferEnabled(on) {
    try { localStorage.setItem(SHARE_BLUR_KEY, on ? 'on' : 'off'); } catch (_) {}
  }

  // What the offer mentions, from analysis already on the device (nothing runs here).
  function sensitiveContent(entry) {
    if (!T.storedImage(entry)) return null;
    const insight = insightOf(entry);
    const faces = insight?.faces || 0;
    const text = !!insight?.labels?.some(([index, score]) => SENSITIVE_LABELS.has(index) && score >= 0.6);
    return faces || text ? { faces, text } : null;
  }

  /** Resolves 'share' (go ahead as is), 'blur' (Privacy blur opened) or 'cancel'. */
  function ask(entry) {
    if (!offerEnabled()) return Promise.resolve('share');
    const found = sensitiveContent(entry);
    if (!found) return Promise.resolve('share');
    return new Promise(resolve => {
      let settled = false;
      const finish = choice => { if (!settled) { settled = true; resolve(choice); } };
      const dialog = document.getElementById('toolResultDlg');
      T.result.open(tr('shareBlurTitle', 'Share safely?'));
      const message = found.faces && found.text
        ? tr('shareBlurFacesText', 'This image shows faces and text. Blur them before sharing?')
        : found.faces
          ? tr('shareBlurFaces', 'This image shows faces. Blur them before sharing?')
          : tr('shareBlurText', 'This image shows text that may be personal. Blur it before sharing?');
      const again = element('label', 'data-check');
      const box = element('input');
      box.type = 'checkbox';
      again.append(box, element('span', '', tr('shareBlurDontAsk', 'Don’t ask again')));
      T.result.show(element('p', 'tool-message', message), again,
        element('p', 'tool-editor-note', tr('shareBlurSettingHint', 'You can turn this back on in Privacy.')));
      const remember = () => { if (box.checked) setOfferEnabled(false); };
      T.result.actions([
        { label: tr('shareBlurAsIs', 'Share as is'), run: () => { remember(); finish('share'); T.result.close(); } },
        { label: tr('shareBlurFirst', 'Blur first'), primary: true, run: () => {
          remember(); finish('blur'); T.result.close(); void privacyBlur(entry, { shareFirst: true });
        } },
      ]);
      dialog.addEventListener('close', () => finish('cancel'), { once: true });
    });
  }

  window.MemoShareBlurOffer = { ask, enabled: offerEnabled, setEnabled: setOfferEnabled, sensitiveContent };
  // The switch in Privacy settings (kept on this device, like ImageDB's).
  const offerBox = document.getElementById('privacyShareBlur');
  if (offerBox) {
    const sync = () => { offerBox.checked = offerEnabled(); };
    sync();
    offerBox.addEventListener('change', () => setOfferEnabled(offerBox.checked));
    document.getElementById('privacySettingsDlg')?.addEventListener('focusin', sync);
  }

  T.register({
    id: 'privacy-blur', group: 'share', icon: BLUR_ICONS.mosaic,
    label: ['toolBlur', 'Privacy blur'],
    // Works without the Android app too: there it is a brush-only blur.
    available: T.stillImage,
    suggested: target => (insightOf(target)?.faces || 0) > 0,
    run: privacyBlur,
  });

  // ── Scan document (free) ──────────────────────────────────
  // Solves the homography that maps the output rectangle onto the source quad.
  function homography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i];
      const { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    // Gaussian elimination with partial pivoting.
    for (let col = 0; col < 8; col++) {
      let pivot = col;
      for (let row = col + 1; row < 8; row++) if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
      [A[col], A[pivot]] = [A[pivot], A[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
      if (Math.abs(A[col][col]) < 1e-12) return null;
      for (let row = col + 1; row < 8; row++) {
        const factor = A[row][col] / A[col][col];
        for (let k = col; k < 8; k++) A[row][k] -= factor * A[col][k];
        b[row] -= factor * b[col];
      }
    }
    const h = new Array(8);
    for (let row = 7; row >= 0; row--) {
      let sum = b[row];
      for (let k = row + 1; k < 8; k++) sum -= A[row][k] * h[k];
      h[row] = sum / A[row][row];
    }
    return [...h, 1];
  }

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  async function warp(source, corners, onProgress) {
    const [tl, tr_, br, bl] = corners;
    let outW = Math.max(distance(tl, tr_), distance(bl, br));
    let outH = Math.max(distance(tl, bl), distance(tr_, br));
    const cap = Math.min(1, 2400 / Math.max(outW, outH));
    outW = Math.max(16, Math.round(outW * cap));
    outH = Math.max(16, Math.round(outH * cap));
    const H = homography(
      [{ x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }],
      [tl, tr_, br, bl]);
    if (!H) throw new Error('These corners do not form a page.');
    const sw = source.width, sh = source.height;
    const input = source.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const octx = out.getContext('2d');
    const image = octx.createImageData(outW, outH);
    const data = image.data;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const d = H[6] * x + H[7] * y + 1;
        const u = (H[0] * x + H[1] * y + H[2]) / d;
        const v = (H[3] * x + H[4] * y + H[5]) / d;
        const x0 = Math.max(0, Math.min(sw - 2, Math.floor(u)));
        const y0 = Math.max(0, Math.min(sh - 2, Math.floor(v)));
        const fx = Math.max(0, Math.min(1, u - x0)), fy = Math.max(0, Math.min(1, v - y0));
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const o = (y * outW + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = input[i00 + c] + (input[i10 + c] - input[i00 + c]) * fx;
          const bottom = input[i01 + c] + (input[i11 + c] - input[i01 + c]) * fx;
          data[o + c] = top + (bottom - top) * fy;
        }
        data[o + 3] = 255;
      }
      if (y % 96 === 0) { onProgress?.(y / outH); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    octx.putImageData(image, 0, 0);
    return out;
  }

  // Stretches the paper to white and the ink to black (per channel for colour).
  function enhance(canvas, mode) {
    if (mode === 'original') return canvas;
    const ctx = canvas.getContext('2d');
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = image.data;
    const histogram = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) histogram[(data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 | 0]++;
    const total = data.length / 4;
    const percentile = p => { let sum = 0; for (let v = 0; v < 256; v++) { sum += histogram[v]; if (sum >= total * p) return v; } return 255; };
    const black = percentile(0.04);
    const white = Math.max(black + 16, percentile(0.9));
    const scale = 255 / (white - black);
    for (let i = 0; i < data.length; i += 4) {
      if (mode === 'bw') {
        const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        let value = (lum - black) * scale;
        value = 255 / (1 + Math.exp(-(value - 140) / 22)); // crisp ink, clean paper
        data[i] = data[i + 1] = data[i + 2] = value;
      } else {
        for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, (data[i + c] - black) * scale));
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  function plausiblePage(points, width, height) {
    const minSide = Math.min(width, height);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      if (distance(points[i], points[j]) < minSide * 0.2) return false;
    }
    let area = 0;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
      area += a.x * b.y - b.x * a.y;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-6) return false;
      if (!sign) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
    }
    return Math.abs(area) / 2 >= width * height * 0.15;
  }

  async function scanDocument(entry) {
    editor.open(tr('toolScan', 'Scan document'), tr('scanHint', 'Drag the corners to the edges of the page.'));
    editor.busy(tr('scanFinding', 'Finding the page…'));
    let image, found;
    try {
      [image, found] = await Promise.all([
        T.loadFullImage(entry),
        T.callNative('segmentSubject', entry, { mode: 'document' }).catch(() => null),
      ]);
    } catch (error) {
      editor.busy(false);
      editor.hint(T.friendlyError(error));
      return;
    }
    if (!editor.isOpen) return;
    editor.busy(false);
    const source = workCanvas(image);
    const width = source.width, height = source.height;
    const canvas = editor.canvas;
    const detected = found?.found && Array.isArray(found.corners) && found.corners.length === 4
      ? found.corners.map(point => ({ x: point.x * width, y: point.y * height })) : null;
    // A detected outline is used only when it looks like a page: four corners
    // well apart, a convex shape and a fair share of the image. A page that
    // already fills the photo can come back as a sliver or a triangle.
    const plausible = detected && plausiblePage(detected, width, height);
    let corners = plausible ? detected
      : [{ x: width * 0.06, y: height * 0.06 }, { x: width * 0.94, y: height * 0.06 },
        { x: width * 0.94, y: height * 0.94 }, { x: width * 0.06, y: height * 0.94 }];
    if (!plausible) editor.hint(tr('scanManual', 'Drag the corners to the edges of the page.'));
    let mode = 'clean';
    let result = null;

    function showSource() {
      result = null;
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(source, 0, 0);
      layout(width, height);
      drawHandles();
      editor.hint(tr('scanHint', 'Drag the corners to the edges of the page.'));
      editor.options([]);
      editor.actions([{ label: tr('scanStraighten', 'Straighten'), primary: true, run: () => void straighten() }]);
    }

    function drawHandles() {
      const r = Math.max(width, height) * 0.022;
      const polygon = svg('polygon', { points: corners.map(p => `${p.x},${p.y}`).join(' '), class: 'scan-outline', 'vector-effect': 'non-scaling-stroke' });
      const handles = corners.map((point, index) => {
        const group = svg('g', { class: 'scan-handle', 'data-index': index });
        group.append(svg('circle', { cx: point.x, cy: point.y, r: r * 2.2, class: 'scan-handle-hit' }),
          svg('circle', { cx: point.x, cy: point.y, r, class: 'scan-handle-dot', 'vector-effect': 'non-scaling-stroke' }));
        return group;
      });
      editor.overlay.replaceChildren(polygon, ...handles);
    }

    let dragging = null;
    const overlay = editor.overlay;
    const onDown = event => {
      if (result) return;
      const handle = event.target.closest?.('.scan-handle');
      const point = imagePoint(event, width, height);
      const index = handle ? Number(handle.dataset.index)
        : corners.reduce((best, p, i) => distance(p, point) < distance(corners[best], point) ? i : best, 0);
      if (!handle && distance(corners[index], point) > Math.max(width, height) * 0.08) return;
      dragging = { index, pointerId: event.pointerId };
      overlay.setPointerCapture?.(event.pointerId);
    };
    const onMove = event => {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      corners[dragging.index] = imagePoint(event, width, height);
      drawHandles();
    };
    const onUp = event => { if (dragging && event.pointerId === dragging.pointerId) dragging = null; };
    overlay.addEventListener('pointerdown', onDown);
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
    overlay.addEventListener('pointercancel', onUp);
    editor.onClose = () => {
      overlay.removeEventListener('pointerdown', onDown);
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerup', onUp);
      overlay.removeEventListener('pointercancel', onUp);
    };

    let straightened = null;
    async function straighten() {
      editor.busy(tr('scanWorking', 'Straightening…'));
      try {
        straightened = await warp(source, corners, progress => editor.busy(tr('scanWorkingPercent', 'Straightening… {n}%', { n: Math.round(progress * 100) })));
      } catch (error) {
        editor.busy(false);
        editor.hint(tr('scanBadCorners', 'Those corners do not outline a page. Adjust them and try again.'));
        return;
      }
      editor.busy(false);
      if (!editor.isOpen) return;
      showResult();
    }

    function showResult() {
      const copy = document.createElement('canvas');
      copy.width = straightened.width; copy.height = straightened.height;
      copy.getContext('2d').drawImage(straightened, 0, 0);
      result = enhance(copy, mode);
      canvas.width = result.width; canvas.height = result.height;
      canvas.getContext('2d').drawImage(result, 0, 0);
      layout(result.width, result.height);
      editor.overlay.replaceChildren();
      editor.hint('');
      const modes = [['original', tr('scanOriginal', 'Original')], ['clean', tr('scanClean', 'Clean')], ['bw', tr('scanBw', 'Black & white')]];
      editor.options(modes.map(([value, label]) => chip(label, value === mode, () => { mode = value; showResult(); })));
      const caption = tr('scanCaption', '{name} (scan)', { name: entry.caption || tr('imageLabel', 'Image') });
      editor.actions([
        { label: tr('scanAdjust', 'Adjust corners'), run: () => showSource() },
        { label: tr('shareAction', 'Share'), run: async () => {
          try { await T.shareBlob(entry, await T.canvasBlob(result, 'image/jpeg', 0.9), caption); } catch (error) { showToast(T.friendlyError(error)); }
        } },
        ...(T.canAddToEntry() ? [{ label: tr('toolSaveCopy', 'Save as new image'), primary: true, run: async () => {
          try { await T.saveCopy(entry, await T.canvasBlob(result, 'image/jpeg', 0.9), { caption, tool: 'scan' }); editor.close(); }
          catch (error) { showToast(T.friendlyError(error)); }
        } }] : []),
      ]);
    }

    showSource();
  }

  T.register({
    id: 'scan-document', group: 'text', icon: 'svg-icon-file',
    label: ['toolScan', 'Scan document'],
    // Page detection needs the Android app; the corners can always be set by hand.
    available: T.stillImage,
    suggested: target => looksLikeDocument(target),
    run: scanDocument,
  });

  window.MemoToolEditors = { homography, enhance, plausiblePage, blurState: null };
})(window);
