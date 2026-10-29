// Non-destructive still-image editing with a local recovery journal.
(function (global) {
  'use strict';
  const t = (key, vars) => global.MemoI18n.t(key, vars);
  function message(node, key) { node.dataset.i18n = key; node.textContent = t(key); }
  let statusArgs = ['', false];
  const G = global.MemoImageGeometry, C = global.MemoImageColor;
  const MAX_BYTES = 32 * 1024 * 1024, MAX_PIXELS = 24 * 1024 * 1024, OUTPUT_PIXELS = 12 * 1024 * 1024;
  let run = 0, source = null, sourceUrl = '', target = null, sourceName = 'image', sourceType = 'image/png';
  let ops = [], redo = [], draft = null, selection = null, dragging = null, comparing = false, busy = false, frame = 0, cancelLoad;
  let sourceBlob = null, sessionId = null, sessionVariant = null, savedSignature = '', recovery = null, nextInput = null;
  let checkpointVersion = 0, opening = false, discarding = false;
  let view = null, bins = null, curveDrag = -1, lastCurveTap = { index: -1, at: 0 };
  const dlg = document.createElement('dialog');
  dlg.id = 'imageEditorDlg'; dlg.className = 'mie-dialog'; dlg.setAttribute('aria-labelledby', 'mieTitle');
  dlg.innerHTML = `<div class="modal mie-modal">
    <header><strong id="mieTitle" data-i18n="Image Editor">Image Editor</strong><span class="spacer"></span><div class="mie-steps-wrap"><button id="mieSteps" aria-haspopup="true" aria-expanded="false" aria-controls="mieStepsMenu" title="Steps" data-i18n-title="Steps"><span class="svg-icon svg-icon-list-check"></span><span class="mie-step-count" id="mieStepCount">0</span></button><div class="mie-steps-menu" id="mieStepsMenu" role="menu" hidden></div></div><button id="mieUndo" title="Undo" data-i18n-title="Undo" aria-label="Undo" data-i18n-aria="Undo">↶</button><button id="mieRedo" title="Redo" data-i18n-title="Redo" aria-label="Redo" data-i18n-aria="Redo">↷</button><button id="mieClose" class="modal-close" aria-label="Close Image Editor" data-i18n-aria="Close Image Editor">×</button></header>
    <div class="mie-workspace">
      <div class="mie-stage" id="mieStage"><div id="mieEmpty"><strong data-i18n="Make an image your own">Make an image your own</strong><p data-i18n="Crop, rotate, or adjust a still image. Your original stays intact.">Crop, rotate, or adjust a still image. Your original stays intact.</p><div class="mie-sources"><button id="mieDevice" data-i18n="From device">From device</button><button id="mieLibrary" data-i18n="From library">From library</button></div><p class="muted" data-i18n="JPEG, PNG, or WebP · up to 32 MB / 24 megapixels">JPEG, PNG, or WebP · up to 32 MB / 24 megapixels</p></div><div id="mieImage" hidden><canvas id="mieCanvas" aria-label="Edited image preview" data-i18n-aria="Edited image preview"></canvas><div id="mieCrop" hidden tabindex="0" role="group" aria-label="Crop selection. Arrow keys move; Shift and arrow keys resize." data-i18n-aria="Crop selection. Arrow keys move; Shift and arrow keys resize."></div></div></div>
      <aside class="mie-controls" aria-label="Image tools" data-i18n-aria="Image tools">
        <div class="mie-controls-scroll">
        <div class="mie-tool-tabs"><button id="mieCropTool" aria-pressed="false" data-i18n="Crop">Crop</button><button id="mieAdjustTool" aria-pressed="false" data-i18n="Adjust">Adjust</button><button id="mieCurvesTool" aria-pressed="false" data-i18n="Curves">Curves</button></div>
        <div class="mie-geometry"><button id="mieRotateLeft" aria-label="Rotate left" data-i18n-aria="Rotate left" data-i18n="↶ Rotate">↶ Rotate</button><button id="mieRotateRight" aria-label="Rotate right" data-i18n-aria="Rotate right" data-i18n="Rotate ↷">Rotate ↷</button><button id="mieFlipH" data-i18n="Flip horizontal">Flip horizontal</button><button id="mieFlipV" data-i18n="Flip vertical">Flip vertical</button></div>
        <div id="mieCropControls" hidden><label><span data-i18n="Aspect ratio">Aspect ratio</span><select id="mieRatio"><option value="0" data-i18n="Free">Free</option><option value="1" data-i18n="Square">Square</option><option value="1.3333333333">4:3</option><option value="1.5">3:2</option><option value="1.7777777778">16:9</option></select></label><p class="muted" data-i18n="Drag inside to move; drag a corner to resize. Drag outside for a new crop. Arrows move; Shift + arrows resize.">Drag inside to move; drag a corner to resize. Drag outside for a new crop. Arrows move; Shift + arrows resize.</p></div>
        <div id="mieAdjustControls" hidden><div class="mie-looks" id="mieLooks" role="group" aria-label="Looks" data-i18n-aria="Looks">${C.PRESETS.map(preset => `<button type="button" class="mie-look" data-preset="${preset.name}" aria-pressed="false" data-i18n="${preset.name}">${t(preset.name)}</button>`).join('')}</div>${C.ADJUSTMENTS.map(a => `<label><span data-i18n="${a.label}">${t(a.label)}</span><output id="mie${a.label}Value">0</output><input id="mie${a.label}" data-key="${a.key}" aria-label="${t(a.label)}" data-i18n-aria="${a.label}" type="range" min="${a.min}" max="${a.max}" value="0"${a.bipolar ? ' class="mie-bipolar"' : ''}></label>`).join('')}</div>
        <div id="mieCurvesControls" hidden><div class="mie-channels" role="radiogroup" aria-label="Curve" data-i18n-aria="Curve">${C.CHANNELS.map(ch => `<button type="button" class="mie-ch" data-channel="${ch}" role="radio" aria-checked="false"><canvas width="34" height="34" aria-hidden="true"></canvas><span${ch === 'rgb' ? ' data-i18n="All"' : ''}>${ch === 'rgb' ? t('All') : ch.toUpperCase()}</span></button>`).join('')}</div><div class="mie-pad-wrap" id="miePadWrap"><canvas id="mieCurvePad" class="mie-curve-pad" width="480" height="480" role="img" aria-label="Tone curve" data-i18n-aria="Tone curve"></canvas></div><p class="muted" data-i18n="Tap to add a point and drag it. Double-tap a point, or drag it off the square, to remove it.">Tap to add a point and drag it. Double-tap a point, or drag it off the square, to remove it.</p><button type="button" id="mieCurvesReset" data-i18n="Reset all curves">Reset all curves</button></div>
        </div>
        <div id="mieToolActions" class="mie-tool-actions" hidden><button id="mieCancelTool" data-i18n="cancel">Cancel</button><button id="mieApply" class="primary" data-i18n="apply">Apply</button></div>
      </aside>
    </div>
    <div class="mie-viewing" id="mieViewing" hidden><span id="mieViewingText"></span><button type="button" id="mieBackToLatest" data-i18n="Back to latest">Back to latest</button></div>
    <p id="mieStatus" role="status" aria-live="polite"></p>
    <p id="mieDraftStatus" class="muted" role="status"></p>
    <div class="actions mie-footer"><button id="mieOriginal" aria-pressed="false" data-i18n="Original">Original</button><span class="spacer"></span><button id="mieDownload" data-i18n="Save to device">Save to device</button><button id="mieSave" class="primary" data-i18n="Save copy">Save copy</button></div>
    <input id="mieFile" type="file" accept="image/jpeg,image/png,image/webp" hidden>
  </div>`;
  document.body.append(dlg);
  const el = id => dlg.querySelector('#' + id), canvas = el('mieCanvas');
  el('mieCrop').innerHTML = ['nw', 'ne', 'sw', 'se'].map(corner => `<span class="mie-handle" data-corner="${corner}" aria-hidden="true"></span>`).join('');
  const recoveryPanel = document.createElement('div');
  recoveryPanel.id = 'mieRecovery'; recoveryPanel.hidden = true;
  recoveryPanel.innerHTML = '<strong data-i18n="Unfinished image edit">Unfinished image edit</strong><p data-i18n="Resume your saved edit, or discard it to start another.">Resume your saved edit, or discard it to start another.</p><div class="mie-sources"><button id="mieResume" class="primary" data-i18n="Resume editing">Resume editing</button><button id="mieDiscardRecovery" data-i18n="Discard edit">Discard edit</button></div>';
  el('mieStage').append(recoveryPanel);
  const leaveDlg = document.createElement('dialog');
  leaveDlg.id = 'mieLeaveDlg'; leaveDlg.className = 'memo-confirm-dlg'; leaveDlg.setAttribute('aria-labelledby', 'mieLeaveTitle');
  leaveDlg.innerHTML = '<div class="modal"><header><strong id="mieLeaveTitle" data-i18n="Keep your unfinished edit?">Keep your unfinished edit?</strong></header><div class="content"><p data-i18n="Your original is unchanged. You can keep this edit on this device and finish it later.">Your original is unchanged. You can keep this edit on this device and finish it later.</p><p id="mieLeaveStatus" role="status"></p></div><div class="actions"><button id="mieDiscard" class="danger" data-i18n="Discard edit">Discard edit</button><button id="mieKeepDraft" data-i18n="Keep draft &amp; close">Keep draft &amp; close</button><button id="mieKeepEditing" class="primary" autofocus data-i18n="Keep editing">Keep editing</button></div></div>';
  document.body.append(leaveDlg);
  global.MemoI18n.apply(dlg); global.MemoI18n.apply(leaveDlg);
  document.addEventListener('memo:localechange', () => { update(); if (source && !statusArgs[1] && statusArgs[0].startsWith('Copy:')) summary(); else status(...statusArgs); });
  const nativeClose = dlg.close.bind(dlg);
  // Every normal close path (Back, Escape, dialog chrome) uses the same guard.
  dlg.close = () => { void requestClose(); };
  function signature() { return JSON.stringify({ ops, draft, selection, ratio: draft?.type === 'crop' ? el('mieRatio').value : '0' }); }
  function dirty() { return !!source && signature() !== savedSignature; }
  async function checkpoint() {
    if (!source || !sessionId || discarding) return;
    const epoch = run, version = ++checkpointVersion;
    const recipe = { version: 1, id: sessionId, variant: sessionVariant, target, name: sourceName, ops, redo, draft, selection, ratio: el('mieRatio').value, savedSignature };
    message(el('mieDraftStatus'), 'Saving edit on this device…');
    try {
      if (dirty() || redo.length) await global.MemoImageDraft.save(recipe, sourceBlob);
      else await global.MemoImageDraft.clear(sessionVariant, sessionId);
      if (epoch === run && version === checkpointVersion) message(el('mieDraftStatus'), dirty() ? 'Edit saved on this device' : '');
    } catch (error) {
      if (epoch === run && version === checkpointVersion) message(el('mieDraftStatus'), 'Could not save this edit. Keep it open and retry.');
      throw error;
    }
  }
  function changed() { void checkpoint().catch(() => {}); }
  function status(text, error = false, vars) { statusArgs = [text, error, vars]; el('mieStatus').textContent = t(text, vars); el('mieStatus').classList.toggle('mie-error', error); }
  function entry() {
    if (!target) return null;
    if (target.variant !== global.MEMO_VARIANT) throw new Error('Return to the original section to edit this image.');
    const current = global.MemoCore?.getState().db.entries.find(item => item.id === target.entryId);
    if (!current || current.deletedAt || (global.MemoPrivacy && !global.MemoPrivacy.canViewEntry(current))) throw new Error('This image is no longer available.');
    const refs = [...(current.images || []), ...(current._storedPaths || [])].map(global.MemoDom.assetKey);
    if (target.ref && !refs.includes(global.MemoDom.assetKey(target.ref))) throw new Error('The source image changed. Reopen it from the entry.');
    return current;
  }
  function canSaveEntry() { return !!global.MemoCore && (global.MEMO_VARIANT !== 'planner' || !!global.MemoSpaShell); }
  function update() {
    const ready = !!source && !busy;
    dlg.querySelectorAll('.mie-controls button, .mie-controls input, .mie-controls select').forEach(node => { node.disabled = !ready || comparing; });
    const earlier = view != null;
    el('mieUndo').disabled = !ready || !ops.length || !!draft || earlier;
    el('mieRedo').disabled = !ready || !redo.length || !!draft || earlier;
    el('mieSteps').disabled = !ready || !!draft || !ops.length || comparing;
    el('mieStepCount').textContent = String(ops.length);
    el('mieViewing').hidden = !earlier || !source;
    if (earlier) el('mieViewingText').textContent = view === 0
      ? t('Showing the original. A new edit replaces all {total} steps.', { total: ops.length })
      : t('Showing step {n} of {total}. A new edit replaces the steps after it.', { n: view, total: ops.length });
    if (!ready || draft) toggleSteps(false);
    el('mieOriginal').disabled = !ready;
    el('mieOriginal').setAttribute('aria-pressed', String(comparing));
    el('mieSave').disabled = !ready || !!draft || !ops.length || !canSaveEntry() || comparing || earlier;
    el('mieDownload').disabled = !ready || !!draft || !ops.length || comparing || earlier;
    message(el('mieSave'), target ? 'Add copy to entry' : 'Save copy');
    el('mieSave').hidden = !canSaveEntry();
    el('mieLibrary').hidden = !global.MemoLibraryPicker || global.MEMO_VARIANT === 'planner';
    el('mieCropTool').setAttribute('aria-pressed', String(draft?.type === 'crop'));
    el('mieAdjustTool').setAttribute('aria-pressed', String(draft?.type === 'adjust'));
    el('mieCurvesTool').setAttribute('aria-pressed', String(draft?.type === 'curves'));
    el('mieCropControls').hidden = draft?.type !== 'crop';
    el('mieAdjustControls').hidden = draft?.type !== 'adjust';
    el('mieCurvesControls').hidden = draft?.type !== 'curves';
    dlg.classList.toggle('mie-curves-mode', draft?.type === 'curves');
    dlg.querySelector('.mie-geometry').hidden = !!draft;
    el('mieToolActions').hidden = !draft;
    el('mieCrop').hidden = draft?.type !== 'crop' || comparing;
    el('mieCropTool').disabled ||= !!draft && draft.type !== 'crop';
    el('mieAdjustTool').disabled ||= !!draft && draft.type !== 'adjust';
    el('mieCurvesTool').disabled ||= !!draft && draft.type !== 'curves';
    dlg.querySelectorAll('.mie-geometry button').forEach(node => { node.disabled ||= !!draft; });
  }
  function render(list, maxEdge, maxPixels) {
    const geometry = G.resolve(list), size = G.size(geometry, source.naturalWidth, source.naturalHeight);
    const scale = Math.min(1, maxEdge / Math.max(size.width, size.height), Math.sqrt(maxPixels / (size.width * size.height)));
    const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(size.width * scale)); out.height = Math.max(1, Math.round(size.height * scale));
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(out.width / 2, out.height / 2); ctx.rotate(geometry.turns * Math.PI / 2); ctx.scale(geometry.flipH ? -1 : 1, geometry.flipV ? -1 : 1);
    const crop = geometry.crop, width = crop.w * source.naturalWidth, height = crop.h * source.naturalHeight;
    ctx.drawImage(source, crop.x * source.naturalWidth, crop.y * source.naturalHeight, width, height, -width * scale / 2, -height * scale / 2, width * scale, height * scale);
    // Colour in stack order: runs of dials share one filter pass, curves are per pixel.
    return C.applyColour(out, list.filter(op => op.type === 'adjust' || op.type === 'curves'));
  }
  // The steps on screen: all of them, or up to the one picked in Steps.
  function visible() { return view == null ? ops : ops.slice(0, view); }
  function fit() {
    if (!source) return;
    const stage = el('mieStage'), ratio = canvas.width / canvas.height;
    const width = Math.min(stage.clientWidth - 24, (stage.clientHeight - 24) * ratio);
    el('mieImage').style.width = Math.max(1, width) + 'px';
    el('mieImage').style.height = Math.max(1, width / ratio) + 'px';
    cropOverlay();
  }
  function cropOverlay() {
    if (!selection) return;
    const box = el('mieCrop');
    box.style.left = selection.x * 100 + '%'; box.style.top = selection.y * 100 + '%';
    box.style.width = selection.w * 100 + '%'; box.style.height = selection.h * 100 + '%';
  }
  function paint() {
    frame = 0; if (!source || !dlg.open) return;
    try {
      const base = comparing ? [] : visible();
      const list = draft?.type === 'adjust' || draft?.type === 'curves' ? [...base, draft] : base;
      if (draft?.type === 'curves' && !bins) { const under = render(base, 1600, 1600 * 1600); bins = C.histogram(under); under.width = under.height = 1; }
      const preview = render(list, 1600, 1600 * 1600);
      canvas.width = preview.width; canvas.height = preview.height;
      canvas.getContext('2d').drawImage(preview, 0, 0); preview.width = preview.height = 1;
      fit(); drawCurves();
    } catch (error) { status(error.message, true); }
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(paint); }
  function summary() {
    if (!source) return;
    const size = G.size(G.resolve(visible()), source.naturalWidth, source.naturalHeight);
    const scale = Math.min(1, 8192 / Math.max(size.width, size.height), Math.sqrt(OUTPUT_PIXELS / (size.width * size.height)));
    status('Copy: {width} × {height}{limit} · Original kept', false, { width: Math.round(size.width * scale), height: Math.round(size.height * scale), limit: scale < 1 ? t(' · reduced to fit the export limit') : '' });
  }
  function push(op) {
    if (view != null) { ops = ops.slice(0, view); view = null; }
    if (ops.length >= 100) { status('Undo a step before adding more edits.', true); return; }
    ops.push(op); redo = []; summary(); update(); schedule(); changed();
  }
  function tool(type) {
    if (!source || busy || draft) return;
    comparing = false;
    draft = type === 'curves' ? { type, params: { channel: 'rgb', curves: C.newCurves() } } : { type, params: type === 'adjust' ? C.neutral() : {} };
    bins = null;
    if (type === 'crop') { el('mieRatio').value = '0'; selection = { x: .1, y: .1, w: .8, h: .8 }; }
    else if (type === 'adjust') syncDials();
    update(); schedule(); changed(); if (type === 'crop') el('mieCrop').focus();
  }
  function cancelTool() { draft = null; selection = null; dragging = null; update(); schedule(); changed(); }
  function reset() {
    ++run; cancelLoad?.(); cancelLoad = null; cancelAnimationFrame(frame); frame = 0;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    source = null; sourceUrl = ''; target = null; ops = []; redo = []; draft = null; selection = null; dragging = null; busy = false; comparing = false;
    view = null; bins = null; curveDrag = -1; toggleSteps(false);
    sourceBlob = null; sessionId = null; sessionVariant = null; recovery = null; nextInput = null; discarding = false;
    canvas.width = canvas.height = 1;
    el('mieImage').hidden = true; el('mieEmpty').hidden = false;
    el('mieFile').value = ''; recoveryPanel.hidden = true; message(el('mieDraftStatus'), ''); status(''); update();
  }
  // Inspect dimensions before asking the WebView to allocate decoded pixels.
  // A compressed file can be small while its decoded bitmap is enormous.
  async function inspectImage(blob) {
    const data = new DataView(await blob.arrayBuffer());
    const tag = offset => offset + 4 <= data.byteLength ? String.fromCharCode(...new Uint8Array(data.buffer, offset, 4)) : '';
    let width = 0, height = 0, type = 'image/png';
    if (data.byteLength >= 24 && data.getUint32(0) === 0x89504e47 && tag(12) === 'IHDR') {
      width = data.getUint32(16); height = data.getUint32(20);
      for (let offset = 8; offset + 12 <= data.byteLength;) {
        if (tag(offset + 4) === 'acTL') throw new Error('Choose a still PNG; animated PNG is not supported.');
        offset += 12 + data.getUint32(offset);
      }
    } else if (data.byteLength >= 12 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
      const uint24 = offset => data.getUint8(offset) | data.getUint8(offset + 1) << 8 | data.getUint8(offset + 2) << 16;
      for (let offset = 12; offset + 8 <= data.byteLength;) {
        const name = tag(offset), size = data.getUint32(offset + 4, true), start = offset + 8;
        if (start + size > data.byteLength) break;
        if (name === 'VP8X' && size >= 10) {
          if (data.getUint8(start) & 2) throw new Error('Choose a still image; animated WebP is not supported.');
          width = uint24(start + 4) + 1; height = uint24(start + 7) + 1;
        } else if (!width && name === 'VP8 ' && size >= 10) {
          width = data.getUint16(start + 6, true) & 0x3fff; height = data.getUint16(start + 8, true) & 0x3fff;
        } else if (!width && name === 'VP8L' && size >= 5) {
          const bits = data.getUint32(start + 1, true);
          width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
        }
        offset = start + size + (size & 1);
      }
    } else if (data.byteLength >= 4 && data.getUint16(0) === 0xffd8) {
      type = 'image/jpeg';
      for (let offset = 2; offset + 4 <= data.byteLength;) {
        if (data.getUint8(offset++) !== 0xff) break;
        while (offset < data.byteLength && data.getUint8(offset) === 0xff) offset++;
        if (offset + 3 > data.byteLength) break;
        const marker = data.getUint8(offset++), size = data.getUint16(offset);
        if (marker === 0xda || marker === 0xd9 || size < 2 || offset + size > data.byteLength) break;
        if (size >= 7 && [0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
          height = data.getUint16(offset + 3); width = data.getUint16(offset + 5); break;
        }
        offset += size;
      }
    }
    if (!width || !height) throw new Error('Choose a valid JPEG, PNG, or WebP still image. Use GIF Editor for animations.');
    if (width * height > MAX_PIXELS || Math.max(width, height) > 16384) throw new Error('Choose an image up to 24 megapixels and 16,384 pixels per side.');
    return type;
  }
  async function load(input, restore = null) {
    reset(); const epoch = run; busy = true; update(); status('Opening image…');
    try {
      let blob;
      if (input instanceof Blob) { blob = input; sourceName = input.name || 'image'; }
      else {
        target = input.entryId ? { ...input, variant: input.variant || global.MEMO_VARIANT } : null;
        const current = target ? entry() : null;
        const ref = target?.ref || current?._storedPaths?.[input.index] || current?.images?.[input.index] || input.url;
        const path = ref && (global.MemoStateDb?.relForBlobUrl?.(ref) || global.MemoStateDb?.urlToRel?.(ref));
        blob = input.blob || (path ? await global.MemoStateDb?.readBlob(path) : null);
        if (!blob && ref) blob = await global.MemoCrop.srcToBlob(ref);
        sourceName = input.name || 'image';
      }
      if (epoch !== run || !dlg.open) return;
      if (!blob || !blob.size) throw new Error('The original image could not be loaded.');
      if (blob.size > MAX_BYTES) throw new Error('Choose an image smaller than 32 MB.');
      const type = await inspectImage(blob);
      if (epoch !== run) return;
      sourceType = type; sourceUrl = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((resolve, reject) => {
        let timer;
        const finish = error => { clearTimeout(timer); img.onload = img.onerror = null; cancelLoad = null; error ? reject(error) : resolve(); };
        cancelLoad = () => { img.src = ''; finish(new Error('Image loading cancelled.')); };
        img.onload = () => finish(); img.onerror = () => finish(new Error('This image could not be decoded.'));
        timer = setTimeout(() => { img.src = ''; finish(new Error('Image decoding took too long. Try a smaller image.')); }, 15000);
        img.src = sourceUrl;
      });
      if (epoch !== run || !dlg.open) return;
      if (!img.naturalWidth || img.naturalWidth * img.naturalHeight > MAX_PIXELS || Math.max(img.naturalWidth, img.naturalHeight) > 16384) throw new Error('Choose an image up to 24 megapixels and 16,384 pixels per side.');
      if (target) { entry(); target.ref = global.MemoDom.assetKey(target.ref); }
      source = img; sourceBlob = blob; sessionId = restore?.id || global.MemoContracts.createId(); sessionVariant = global.MEMO_VARIANT || 'default';
      savedSignature = signature();
      if (restore) {
        ops = restore.ops; redo = restore.redo; draft = restore.draft; selection = restore.selection;
        savedSignature = restore.savedSignature; sourceName = restore.name; el('mieRatio').value = restore.ratio;
        if (draft?.type === 'adjust') { draft.params = { ...C.neutral(), ...draft.params }; syncDials(); }
        message(el('mieDraftStatus'), 'Saved edit restored');
      }
      el('mieImage').hidden = false; el('mieEmpty').hidden = true; summary(); paint();
    } catch (error) {
      if (epoch !== run) return;
      if (sourceUrl) URL.revokeObjectURL(sourceUrl); sourceUrl = ''; target = null;
      status(error.message, true);
    } finally { if (epoch === run) { busy = false; update(); } }
  }
  async function forceClose() {
    if (!dlg.open) { reset(); return; }
    if (leaveDlg.open) leaveDlg.close();
    await new Promise(resolve => { dlg.addEventListener('close', resolve, { once: true }); nativeClose(); });
  }
  async function requestClose() {
    if (!dlg.open || leaveDlg.open) return;
    if (busy && source) { status('Please wait for the current save to finish.'); return; }
    if (!dirty()) { await forceClose(); return; }
    message(document.getElementById('mieLeaveStatus'), '');
    leaveDlg.showModal(); document.getElementById('mieKeepEditing').focus();
  }
  function suspend() {
    // Capture synchronously, then hide immediately; privacy never waits on IO.
    changed();
    if (leaveDlg.open) leaveDlg.close();
    if (dlg.open) nativeClose();
    reset();
  }
  async function leave(discard) {
    const epoch = run;
    discarding = discard;
    const buttons = leaveDlg.querySelectorAll('button'); buttons.forEach(button => { button.disabled = true; });
    try {
      if (discard) await global.MemoImageDraft.clear(sessionVariant, sessionId);
      else await checkpoint();
      if (epoch === run) await forceClose();
    } catch (_) { if (epoch === run) message(document.getElementById('mieLeaveStatus'), 'Could not update the saved edit. Keep editing, or retry.'); }
    finally { if (epoch === run) discarding = false; buttons.forEach(button => { button.disabled = false; }); }
  }
  async function encodeCopy(out, type) {
    if (global.Worker && global.OffscreenCanvas && global.createImageBitmap) {
      let worker, bitmap;
      try {
        bitmap = await createImageBitmap(out);
        worker = new Worker('/static/js/memo/memo-image-encode-worker.js');
        return await new Promise((resolve, reject) => {
          worker.onmessage = event => event.data.blob ? resolve(event.data.blob) : reject(new Error(event.data.error));
          worker.onerror = () => reject(new Error('Image encoding failed.'));
          worker.postMessage({ bitmap, type, quality: .95 }, [bitmap]);
        });
      } catch (_) {
        // Older WebViews or unavailable worker assets retain the compatible
        // encoder. Both paths keep recovery until durable delivery succeeds.
      } finally { bitmap?.close(); worker?.terminate(); }
    }
    return new Promise((resolve, reject) => out.toBlob(value => value ? resolve(value) : reject(new Error('Image encoding failed.')), type, .95));
  }
  async function exportCopy(device) {
    if (!source || busy || draft || !ops.length || view != null) return;
    const epoch = run, originalTarget = target && { ...target }, exportedSignature = signature(), exportedId = sessionId, exportedVariant = sessionVariant;
    busy = true; update(); status('Preparing copy…');
    const timings = global.MemoImageExportTimings = { started: performance.now() };
    let phase = timings.started;
    let out, handingOff = false;
    try {
      if (target) entry();
      await checkpoint();
      timings.checkpointMs = performance.now() - phase; phase = performance.now();
      if (epoch !== run || !dlg.open) return;
      status('Rendering copy…');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      out = render(ops, 8192, OUTPUT_PIXELS);
      timings.renderMs = performance.now() - phase; phase = performance.now();
      status('Encoding image…');
      const blob = await encodeCopy(out, sourceType);
      timings.encodeMs = performance.now() - phase; phase = performance.now();
      if (epoch !== run || !dlg.open) return;
      const current = target ? entry() : null;
      const name = sourceName.replace(/\.[^.]+$/, '').replace(/[^\w -]/g, '_').slice(0, 60) + '-edited' + (blob.type === 'image/jpeg' ? '.jpg' : '.png');
      if (device) {
        // Follow the app's existing release policy; protected images stay inside
        // their protected entry unless explicitly released through that workflow.
        if (current?.safe) throw new Error('Save this copy inside its protected entry.');
        status('Saving copy…');
        const destination = await global.MemoCrop.saveToPhone(blob, name.replace(/\.[^.]+$/, ''));
        timings.saveMs = performance.now() - phase;
        if (epoch === run) {
          if (destination === 'gallery') {
            savedSignature = exportedSignature;
            await global.MemoImageDraft.clear(exportedVariant, exportedId);
            message(el('mieDraftStatus'), ''); status('Copy saved to device. Original kept.');
          } else {
            status('Download started. Your edit is kept for recovery.');
          }
        }
      } else {
        const file = new File([blob], name, { type: blob.type });
        handingOff = true;
        await forceClose();
        if (global.MEMO_VARIANT === 'planner') await global.MemoSpaShell.switchTo('default');
        if (originalTarget && global.MEMO_VARIANT !== originalTarget.variant) return;
        if (global.MemoPrivacy && !await global.MemoPrivacy.ensureVariantAccess(global.MEMO_VARIANT)) return;
        if (dlg.open || (current && (!global.MemoCore.getState().db.entries.includes(current) || current.deletedAt || (global.MemoPrivacy && !global.MemoPrivacy.canViewEntry(current))))) return;
        global.MemoReader?.close?.();
        const detail = document.getElementById('detailDlg'); if (detail?.open) detail.close();
        global.openEntryModal(current || null);
        await global.MemoCore.addImages([file]);
        await global.MemoDraft.saveChecked();
        await global.MemoImageDraft.clear(exportedVariant, exportedId);
        global.MemoShell?.toast(t('Edited copy added. Review and save the entry.'), { kind: 'success' });
      }
    } catch (error) {
      if (epoch === run) status(error.message, true);
      else if (handingOff) global.MemoShell?.toast(t(error.message), { kind: 'error' });
    }
    finally { timings.totalMs = performance.now() - timings.started; if (out) out.width = out.height = 1; if (epoch === run) { busy = false; update(); } }
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }
  function constrain(rect) {
    const ratio = Number(el('mieRatio').value);
    if (ratio) rect.h = rect.w * canvas.width / canvas.height / ratio;
    const scale = Math.min(1, 1 / Math.max(rect.w, rect.h)); rect.w *= scale; rect.h *= scale;
    if (ratio) {
      const factor = canvas.width / canvas.height / ratio;
      rect.w = Math.max(Math.min(.02, 1 / factor), rect.w); rect.h = rect.w * factor;
    } else { rect.w = Math.max(.02, Math.min(1, rect.w)); rect.h = Math.max(.02, Math.min(1, rect.h)); }
    rect.x = Math.max(0, Math.min(1 - rect.w, rect.x)); rect.y = Math.max(0, Math.min(1 - rect.h, rect.y));
    return rect;
  }
  el('mieImage').addEventListener('pointerdown', event => {
    if (draft?.type !== 'crop' || comparing || dragging || event.button !== 0) return;
    event.preventDefault();
    const corner = event.target.closest('[data-corner]')?.dataset.corner;
    dragging = { start: point(event), id: event.pointerId, original: { ...selection }, mode: corner || (event.target.closest('#mieCrop') ? 'move' : 'draw') };
    el('mieImage').setPointerCapture(event.pointerId); el('mieCrop').focus();
  });
  el('mieImage').addEventListener('pointermove', event => {
    if (!dragging || dragging.id !== event.pointerId) return;
    const p = point(event), a = dragging.start, old = dragging.original, mode = dragging.mode;
    if (mode === 'move') {
      selection = { ...old, x: Math.max(0, Math.min(1 - old.w, old.x + p.x - a.x)), y: Math.max(0, Math.min(1 - old.h, old.y + p.y - a.y)) };
    } else {
      // Opposite corner stays fixed; use deltas so a large touch target never
      // makes the crop jump to the finger's initial contact position.
      const west = mode === 'draw' ? p.x < a.x : mode.includes('w');
      const north = mode === 'draw' ? p.y < a.y : mode.includes('n');
      const anchor = mode === 'draw' ? a : { x: old.x + (west ? old.w : 0), y: old.y + (north ? old.h : 0) };
      const availableW = west ? anchor.x : 1 - anchor.x, availableH = north ? anchor.y : 1 - anchor.y;
      if (!availableW || !availableH) return;
      let w = mode === 'draw' ? Math.abs(p.x - a.x) : old.w + (west ? -1 : 1) * (p.x - a.x);
      let h = mode === 'draw' ? Math.abs(p.y - a.y) : old.h + (north ? -1 : 1) * (p.y - a.y);
      const ratio = Number(el('mieRatio').value);
      if (ratio) {
        const factor = canvas.width / canvas.height / ratio;
        // Follow whichever axis the finger changes most, in displayed pixels.
        if (Math.abs((p.y - a.y) * canvas.height) > Math.abs((p.x - a.x) * canvas.width)) w = h / factor;
        const max = Math.min(availableW, availableH / factor);
        w = Math.max(Math.min(.02, max), Math.min(max, w)); h = w * factor;
      } else {
        w = Math.max(Math.min(.02, availableW), Math.min(availableW, w));
        h = Math.max(Math.min(.02, availableH), Math.min(availableH, h));
      }
      selection = { x: west ? anchor.x - w : anchor.x, y: north ? anchor.y - h : anchor.y, w, h };
    }
    cropOverlay();
  });
  ['pointerup','pointercancel','lostpointercapture'].forEach(type => el('mieImage').addEventListener(type, event => {
    if (dragging?.id !== event.pointerId) return;
    dragging = null; changed();
  }));
  el('mieCrop').addEventListener('keydown', event => {
    if (!selection || !event.key.startsWith('Arrow')) return;
    event.preventDefault(); const horizontal = /Left|Right/.test(event.key), delta = /Left|Up/.test(event.key) ? -.01 : .01;
    if (event.shiftKey && !horizontal && Number(el('mieRatio').value)) selection.w += delta * canvas.height / canvas.width * Number(el('mieRatio').value);
    else selection[horizontal ? (event.shiftKey ? 'w' : 'x') : (event.shiftKey ? 'h' : 'y')] += delta;
    selection = constrain(selection); cropOverlay(); changed();
  });
  el('mieRatio').onchange = () => { if (selection) { selection = constrain(selection); cropOverlay(); changed(); } };
  el('mieApply').onclick = () => {
    if (draft?.type === 'crop') { const rect = selection; draft = null; selection = null; push({ type: 'crop', params: G.crop(rect, 1, 1, ops) }); }
    else if (draft) {
      const op = draft; draft = null;
      const empty = op.type === 'adjust' ? C.isNeutral(op.params) : op.type === 'curves' ? C.curvesAreIdentity(op.params) : true;
      if (!empty) push(op); else { update(); schedule(); changed(); }
    }
  };
  el('mieCancelTool').onclick = cancelTool;
  el('mieCropTool').onclick = () => tool('crop'); el('mieAdjustTool').onclick = () => tool('adjust'); el('mieCurvesTool').onclick = () => tool('curves');
  // ── Adjust: six dials and looks ──
  function dialText(a, value) { return (value > 0 && a.bipolar ? '+' : '') + value + a.unit; }
  function syncDials() {
    if (draft?.type !== 'adjust') return;
    C.ADJUSTMENTS.forEach(a => { const value = Number(draft.params[a.key]) || 0; el('mie' + a.label).value = String(value); el('mie' + a.label + 'Value').value = dialText(a, value); });
    dlg.querySelectorAll('.mie-look').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === draft.params.preset)));
  }
  C.ADJUSTMENTS.forEach(a => {
    el('mie' + a.label).oninput = () => {
      if (draft?.type !== 'adjust') return;
      draft.params[a.key] = Number(el('mie' + a.label).value);
      delete draft.params.preset;       // hand-tuned from here on
      syncDials(); schedule(); changed();
    };
  });
  el('mieLooks').addEventListener('click', event => {
    const b = event.target.closest('.mie-look'); if (!b || draft?.type !== 'adjust') return;
    const preset = C.PRESETS.find(x => x.name === b.dataset.preset);
    // Tapping the look that is on takes it off again.
    draft.params = draft.params.preset === preset.name ? C.neutral() : { ...C.neutral(), ...preset.params, preset: preset.name };
    syncDials(); schedule(); changed();
  });
  // ── Curves: four curves (All, R, G, B) over a histogram ──
  const HIT = .06, DOUBLE_TAP = 400;
  function activeCurve() {
    if (draft?.type !== 'curves') return null;
    const channel = draft.params.channel || 'rgb';
    draft.params.curves ||= C.newCurves();
    return (draft.params.curves[channel] ||= [[0, 0], [1, 1]]);
  }
  function drawCurves() {
    if (draft?.type !== 'curves') return;
    const set = C.curveSet(draft.params), channel = draft.params.channel || 'rgb';
    C.drawPad(el('mieCurvePad'), channel, activeCurve(), bins);
    dlg.querySelectorAll('.mie-ch').forEach(b => {
      const ch = b.dataset.channel;
      b.setAttribute('aria-checked', String(ch === channel));
      b.classList.toggle('edited', !C.channelIsIdentity(set[ch]));
      C.drawThumb(b.querySelector('canvas'), ch, set[ch]);
    });
    el('mieCurvesReset').disabled = C.curvesAreIdentity(draft.params);
  }
  dlg.querySelector('.mie-channels').addEventListener('click', event => {
    const b = event.target.closest('.mie-ch'); if (!b || draft?.type !== 'curves') return;
    draft.params.channel = b.dataset.channel; drawCurves(); changed();
  });
  el('mieCurvesReset').onclick = () => { if (draft?.type !== 'curves') return; draft.params.curves = C.newCurves(); drawCurves(); schedule(); changed(); };
  function padPoint(event) {
    const r = el('mieCurvePad').getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, 1 - (event.clientY - r.top) / r.height)),
      outside: event.clientX < r.left - 34 || event.clientX > r.right + 34 || event.clientY < r.top - 34 || event.clientY > r.bottom + 34 };
  }
  // The wrapper adds a touch margin round the pad, so the two end points in
  // its corners are as easy to grab as any other; positions come from the pad.
  const padArea = el('miePadWrap');
  padArea.addEventListener('pointerdown', event => {
    const points = activeCurve(); if (!points || comparing) return;
    event.preventDefault();
    const pos = padPoint(event);
    let index = points.findIndex(([px, py]) => Math.abs(px - pos.x) < HIT && Math.abs(py - pos.y) < HIT);
    // Double-tap removes an inner point; the two ends always stay.
    if (index > 0 && index < points.length - 1) {
      const now = Date.now();
      if (lastCurveTap.index === index && now - lastCurveTap.at < DOUBLE_TAP) {
        points.splice(index, 1); lastCurveTap = { index: -1, at: 0 }; curveDrag = -1; schedule(); changed(); return;
      }
      lastCurveTap = { index, at: now };
    } else lastCurveTap = { index: -1, at: 0 };
    if (index === -1) { points.push([pos.x, pos.y]); points.sort((a, b) => a[0] - b[0]); index = points.findIndex(p => p[0] === pos.x && p[1] === pos.y); }
    curveDrag = index;
    padArea.setPointerCapture?.(event.pointerId);
    schedule();
  });
  padArea.addEventListener('pointermove', event => {
    const points = activeCurve(); if (!points || curveDrag < 0) return;
    event.preventDefault();
    const pos = padPoint(event), end = curveDrag === 0 || curveDrag === points.length - 1;
    const x = end ? points[curveDrag][0] : pos.x;
    points[curveDrag] = [x, pos.y]; points.sort((a, b) => a[0] - b[0]);
    curveDrag = points.findIndex(p => p[0] === x && p[1] === pos.y);
    schedule();
  });
  ['pointerup', 'pointercancel'].forEach(type => padArea.addEventListener(type, event => {
    const points = activeCurve();
    // Dragged off the square: that point goes.
    if (points && curveDrag > 0 && curveDrag < points.length - 1 && type === 'pointerup' && padPoint(event).outside) points.splice(curveDrag, 1);
    if (curveDrag !== -1) { curveDrag = -1; schedule(); changed(); }
    try { padArea.releasePointerCapture?.(event.pointerId); } catch (_) {}
  }));
  // ── Steps: look at any earlier step, remove one, or edit on from there ──
  function toggleSteps(force) {
    const menu = el('mieStepsMenu'); if (!menu) return;
    const open = force != null ? force : menu.hidden;
    if (open && (!source || draft || busy || !ops.length)) return;
    menu.hidden = !open; el('mieSteps').setAttribute('aria-expanded', String(open));
    if (open) renderSteps();
  }
  function renderSteps() {
    const menu = el('mieStepsMenu'); menu.innerHTML = '';
    const shown = view == null ? ops.length : view;
    const row = (label, limit, index) => {
      const line = document.createElement('div'); line.className = 'mie-step' + (limit === shown ? ' current' : '');
      const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'mie-step-pick'; pick.setAttribute('role', 'menuitemradio');
      pick.setAttribute('aria-checked', String(limit === shown));
      pick.innerHTML = '<span class="mie-step-n"></span><span class="mie-step-l"></span>';
      pick.firstChild.textContent = index == null ? '' : String(index + 1); pick.lastChild.textContent = label;
      pick.onclick = () => setView(limit);
      line.append(pick);
      if (index != null) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'mie-step-remove ghost';
        remove.setAttribute('aria-label', t('Remove step {n}', { n: index + 1 })); remove.innerHTML = '<span class="svg-icon svg-icon-trash"></span>';
        remove.onclick = event => { event.stopPropagation(); removeStep(index); };
        line.append(remove);
      }
      menu.append(line);
    };
    row(t('Original'), 0, null);
    ops.forEach((op, index) => {
      const [key, vars] = C.stepLabel(op);
      if (vars && Array.isArray(vars.channels)) vars.channels = vars.channels.map(k => k === 'rgb' ? t('All') : k.toUpperCase()).join(', ');
      row(t(key, vars), index + 1, index);
    });
  }
  function setView(limit) { view = limit >= ops.length ? null : Math.max(0, limit); comparing = false; toggleSteps(false); summary(); update(); schedule(); }
  function removeStep(index) {
    ops.splice(index, 1); redo = [];
    if (view != null && index < view) view--;
    if (view != null && view >= ops.length) view = null;
    if (!ops.length) { toggleSteps(false); el('mieSteps').focus(); }
    else {
      renderSteps();
      // Keep focus in the list: on the step that moved up into this place, or the last one.
      const rows = el('mieStepsMenu').querySelectorAll('.mie-step-remove');
      (rows[Math.min(index, rows.length - 1)] || el('mieSteps')).focus();
    }
    summary(); update(); schedule(); changed();
  }
  el('mieSteps').onclick = event => { event.stopPropagation(); toggleSteps(); };
  el('mieBackToLatest').onclick = () => setView(ops.length);
  dlg.addEventListener('click', event => { if (!el('mieStepsMenu').hidden && !event.target.closest('.mie-steps-wrap')) toggleSteps(false); });
  // Escape closes the Steps list first (not the editor), wherever focus is.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !dlg.open || el('mieStepsMenu').hidden) return;
    event.preventDefault(); event.stopPropagation(); toggleSteps(false); el('mieSteps').focus();
  }, true);
  el('mieRotateLeft').onclick = () => push({ type: 'rotate', params: { turns: 3 } });
  el('mieRotateRight').onclick = () => push({ type: 'rotate', params: { turns: 1 } });
  el('mieFlipH').onclick = () => push({ type: 'flip', params: { axis: 'h' } }); el('mieFlipV').onclick = () => push({ type: 'flip', params: { axis: 'v' } });
  el('mieUndo').onclick = () => { if (ops.length) redo.push(ops.pop()); comparing = false; update(); summary(); schedule(); changed(); };
  el('mieRedo').onclick = () => { if (redo.length) ops.push(redo.pop()); comparing = false; update(); summary(); schedule(); changed(); };
  el('mieOriginal').onclick = () => { comparing = !comparing; update(); schedule(); };
  el('mieDevice').onclick = () => el('mieFile').click();
  el('mieFile').onchange = () => { const file = el('mieFile').files[0]; if (file) void load(file); };
  el('mieLibrary').onclick = () => global.MemoLibraryPicker.open({ mode: 'single', filter: 'image', title: t('Choose an image to edit'), onDone: value => { if (dlg.open && value) void load(value); } });
  el('mieClose').onclick = () => void requestClose(); el('mieSave').onclick = () => void exportCopy(false); el('mieDownload').onclick = () => void exportCopy(true);
  document.getElementById('mieKeepEditing').onclick = () => leaveDlg.close();
  document.getElementById('mieKeepDraft').onclick = () => void leave(false);
  document.getElementById('mieDiscard').onclick = () => void leave(true);
  el('mieResume').onclick = async () => {
    const saved = recovery;
    if (!saved) return;
    if (saved.version !== 1 || !Array.isArray(saved.ops) || !Array.isArray(saved.redo)) { status('This saved edit could not be restored. Its data has been retained.', true); return; }
    if (global.MemoPrivacy && !await global.MemoPrivacy.ensureVariantAccess(saved.variant)) return;
    if (!dlg.open || saved !== recovery) return;
    if (saved.target) {
      target = saved.target;
      try { entry(); } catch (error) { target = null; status(t(error.message) + ' ' + t('The saved edit has been retained.'), true); return; }
    }
    const epoch = run;
    try {
      const stored = await global.MemoImageDraft.read(saved.variant);
      if (epoch !== run || !dlg.open) return;
      if (!stored?.blob || stored.id !== saved.id) throw new Error('The saved image source is unavailable.');
      if (saved.target) { target = saved.target; entry(); }
      await load(saved.target ? { ...saved.target, blob: stored.blob, name: saved.name } : new File([stored.blob], saved.name, {type:stored.blob.type}), saved);
    } catch (error) { if (epoch === run) status(t(error.message) + ' ' + t('The saved edit has been retained.'), true); }
  };
  el('mieDiscardRecovery').onclick = async () => {
    const saved = recovery, input = nextInput, epoch = run;
    if (!saved) return;
    const discard = await global.MemoShell.confirm(t('Discard the saved image edit? Your original will be kept.'), { title: t('Discard image edit'), okLabel: t('Discard edit'), cancelLabel: t('Keep draft'), danger: true });
    if (!discard || epoch !== run) return;
    try {
      await global.MemoImageDraft.clear(saved.variant, saved.id);
      if (epoch !== run) return;
      reset(); if (input) await load(input);
    } catch (_) { status('Could not discard the saved edit. Please retry.', true); }
  };
  dlg.addEventListener('close', reset);
  dlg.addEventListener('cancel', event => { event.preventDefault(); void requestClose(); });
  new ResizeObserver(fit).observe(el('mieStage'));
  document.addEventListener('memo:privacy-locked', suspend);
  document.addEventListener('visibilitychange', () => { if (document.hidden) changed(); });
  global.addEventListener('pagehide', event => { changed(); if (!global.MemoLifecycle?.retain(event) && !event.persisted) reset(); });
  global.MemoImageEditorImpl = { open: async input => {
    // Do not replace a user's unfinished entry with another image-editing flow.
    if (document.getElementById('entryDlg')?.open) { global.MemoShell?.toast(t('Save or close the current entry before opening Image Editor.')); return; }
    if (dlg.open || opening) return;
    opening = true;
    try {
      reset(); const epoch = run, variant = global.MEMO_VARIANT || 'default';
      if (global.MemoPrivacy && !await global.MemoPrivacy.ensureVariantAccess(variant)) return;
      if (epoch !== run) return;
      const saved = await global.MemoImageDraft.read(variant, false);
      if (epoch !== run || variant !== (global.MEMO_VARIANT || 'default')) return;
      dlg.showModal(); update();
      if (saved) { recovery = saved; nextInput = input; recoveryPanel.hidden = false; el('mieEmpty').hidden = true; el('mieResume').focus(); }
      else if (input) await load(input);
    } catch (error) { global.MemoShell?.toast(t('Image edit recovery is unavailable: {error}', { error: t(error.message) }), { kind: 'error' }); }
    finally { opening = false; }
  }, close: requestClose, suspend, checkpoint };
})(window);
