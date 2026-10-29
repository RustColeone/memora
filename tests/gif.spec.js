// GIF editing (memo-gif.js): animate an entry's images into a GIF via the
// vendored gifenc encoder (lazy-loaded). Asserts a valid GIF89a blob, the
// contain-fit output-size cap (from the GIF header), and the detail trigger.
const { test, expect } = require('@playwright/test');

const MK = `(w,h,c)=>{const cv=document.createElement('canvas');cv.width=w;cv.height=h;const g=cv.getContext('2d');g.fillStyle=c;g.fillRect(0,0,w,h);return cv.toDataURL('image/png');}`;

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoGif && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
}

test('encode produces a valid animated GIF (GIF89a) and caps output size', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async (mk) => {
    const m = eval(mk);
    // three 600×400 frames; default maxDim 480 → long edge 600 scales to 480×320
    window.MemoGif.open([m(600, 400, '#f00'), m(600, 400, '#00f'), m(600, 400, '#0f0')]);
    const blob = await window.MemoGif.encode();
    const buf = new Uint8Array(await blob.arrayBuffer());
    return {
      type: blob.type, size: blob.size,
      magic: String.fromCharCode.apply(null, buf.slice(0, 6)),
      w: buf[6] | (buf[7] << 8),   // GIF logical-screen width  (LE uint16)
      h: buf[8] | (buf[9] << 8),   // GIF logical-screen height
    };
  }, MK);
  expect(r.type).toBe('image/gif');
  expect(r.magic).toBe('GIF89a');
  expect(r.size).toBeGreaterThan(0);
  expect(r.w).toBe(480);
  expect(r.h).toBe(320);
});

test('frame delay control feeds the encoder (larger delay ⇒ larger file is not asserted; header stays valid)', async ({ page }) => {
  await boot(page);
  const ok = await page.evaluate(async (mk) => {
    const m = eval(mk);
    window.MemoGif.open([m(80, 80, '#111'), m(80, 80, '#eee')]);
    const dl = document.getElementById('gifDelay'); dl.value = '1000'; dl.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('gifLoop').checked = false;
    const blob = await window.MemoGif.encode();
    const buf = new Uint8Array(await blob.arrayBuffer());
    return String.fromCharCode.apply(null, buf.slice(0, 6)) === 'GIF89a' && blob.size > 0;
  }, MK);
  expect(ok).toBe(true);
});

test('the detail view offers Create GIF only for multi-image entries and opens the dialog', async ({ page }) => {
  await boot(page);
  await page.evaluate(async (mk) => {
    const m = eval(mk);
    const bundle = { version: 1, finance: [], memos: [
      { id: 'g1', description: 'two', category: 'Work', tags: [], images: [m(60, 60, '#f00'), m(60, 60, '#0f0')], ts: Date.now() },
      { id: 'g2', description: 'one', category: 'Work', tags: [], images: [m(60, 60, '#00f')], ts: Date.now() - 1000 },
    ] };
    window.MemoStateDb.importBundle(bundle, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
  }, MK);

  const multi = await page.evaluate(() => {
    window.MemoVariant.openDetail('g1');
    const has = !!document.getElementById('detailGifBtn');
    document.getElementById('detailGifBtn').click();
    return { has, open: document.getElementById('gifDlg').open };
  });
  expect(multi.has).toBe(true);
  expect(multi.open).toBe(true);

  const single = await page.evaluate(() => {
    window.MemoGif.close();
    document.getElementById('detailDlg').close();
    window.MemoVariant.openDetail('g2');
    return !!document.getElementById('detailGifBtn');
  });
  expect(single).toBe(false);
});

test('imported GIF editor decodes, trims/crops, and re-encodes a GIF89a', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async (mk) => {
    const m = eval(mk);
    window.MemoGif.open([m(32, 24, '#f00'), m(32, 24, '#00f'), m(32, 24, '#0f0')]);
    const source = await window.MemoGif.encode();
    const file = new File([source], 'source.gif', { type: 'image/gif' });
    await window.MemoGifEditor.open(file);
    const before = window.MemoGifEditor.__state();
    document.getElementById('gifEditorTrimStart').value = '2';
    document.getElementById('gifEditorTrimStart').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('gifEditorFrameStep').value = '2';
    document.getElementById('gifEditorFrameStep').dispatchEvent(new Event('change', { bubbles: true }));
    const canvas = document.getElementById('gifEditorCanvas');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    const blob = await window.MemoGifEditor.encode();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      before,
      magic: String.fromCharCode.apply(null, bytes.slice(0, 6)),
      width: bytes[6] | (bytes[7] << 8),
      height: bytes[8] | (bytes[9] << 8),
      size: blob.size,
    };
  }, MK);
  expect(r.before.frameCount).toBeGreaterThanOrEqual(3);
  expect(r.before.width).toBe(32);
  expect(r.before.height).toBe(24);
  expect(r.magic).toBe('GIF89a');
  expect(r.width).toBeGreaterThan(0);
  expect(r.width).toBeLessThan(32);
  expect(r.height).toBeGreaterThan(0);
  expect(r.height).toBeLessThan(24);
  expect(r.size).toBeGreaterThan(0);
});

test('closing during GIF decode aborts stale work, revokes its URL, and clears state', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async (mk) => {
    const m = eval(mk);
    window.MemoGif.open([m(16, 12, '#f00'), m(16, 12, '#00f')]);
    const source = await window.MemoGif.encode();

    await window.MemoGifEditor.open();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const sourceFocus = document.activeElement && document.activeElement.id;

    const nativeFetch = window.fetch;
    const nativeRevoke = URL.revokeObjectURL;
    const revoked = [];
    URL.revokeObjectURL = function (url) { revoked.push(url); return nativeRevoke.call(URL, url); };
    window.fetch = function (url, options) {
      if (!String(url).startsWith('blob:')) return nativeFetch(url, options);
      return new Promise((resolve, reject) => {
        const signal = options && options.signal;
        if (signal && signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        if (signal) signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    };

    try {
      const pending = window.MemoGifEditor.open(new File([source], 'slow.gif', { type: 'image/gif' }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const editorFocus = document.activeElement && document.activeElement.id;
      const started = window.MemoGifEditor.__state().decodePending;
      const dialog = document.getElementById('gifEditorDlg');
      const closed = new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
      window.MemoGifEditor.close();
      const completed = await pending;
      await closed;
      return { sourceFocus, editorFocus, started, completed, state: window.MemoGifEditor.__state(), revoked: revoked.length };
    } finally {
      window.fetch = nativeFetch;
      URL.revokeObjectURL = nativeRevoke;
    }
  }, MK);

  expect(result.sourceFocus).toBe('gifEditorFromDeviceBtn');
  expect(result.editorFocus).toBe('gifEditorBackBtn');
  expect(result.started).toBe(true);
  expect(result.completed).toBe(false);
  expect(result.state).toMatchObject({ frameCount: 0, decodePending: false, previewActive: false });
  expect(result.revoked).toBeGreaterThanOrEqual(1);
});

test('GIF working-set budgets reject oversized files before and after decompression', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    let preDecodeCalls = 0;
    window.MemoGifDecoder = {
      parseGIF() {
        return {
          lsd: { width: 2000, height: 2000 },
          frames: Array.from({ length: 200 }, () => ({ image: { descriptor: { width: 2000, height: 2000 } } })),
        };
      },
      decompressFrames() { preDecodeCalls += 1; return []; },
    };
    let preMessage = '';
    try { await window.MemoGifEditor.open(new File([new Uint8Array([1])], 'pre.gif', { type: 'image/gif' })); }
    catch (error) { preMessage = error.message; }

    let postDecodeCalls = 0;
    window.MemoGifDecoder = {
      parseGIF() {
        return { lsd: { width: 1, height: 1 }, frames: [{ image: { descriptor: { width: 1, height: 1 } } }] };
      },
      decompressFrames() {
        postDecodeCalls += 1;
        return [{ dims: { left: 0, top: 0, width: 1, height: 1 }, patch: { byteLength: 300 * 1024 * 1024 } }];
      },
    };
    let postMessage = '';
    try { await window.MemoGifEditor.open(new File([new Uint8Array([1])], 'post.gif', { type: 'image/gif' })); }
    catch (error) { postMessage = error.message; }
    return { preDecodeCalls, postDecodeCalls, preMessage, postMessage, state: window.MemoGifEditor.__state() };
  });

  expect(result.preDecodeCalls).toBe(0);
  expect(result.postDecodeCalls).toBe(1);
  expect(result.preMessage).toContain('too large to edit safely');
  expect(result.postMessage).toContain('too large to edit safely');
  expect(result.state).toMatchObject({ frameCount: 0, decodePending: false, previewActive: false });
});

test('a replacement GIF crop previews over an existing crop through animation ticks', async ({ page }) => {
  await boot(page);
  await page.evaluate(async (mk) => {
    const m = eval(mk);
    window.MemoGif.open([m(32, 24, '#f00'), m(32, 24, '#00f'), m(32, 24, '#0f0')]);
    const delay = document.getElementById('gifDelay');
    delay.value = '100';
    delay.dispatchEvent(new Event('input', { bubbles: true }));
    const source = await window.MemoGif.encode();
    await window.MemoGifEditor.open(new File([source], 'replacement.gif', { type: 'image/gif' }));

    const canvas = document.getElementById('gifEditorCanvas');
    const rect = canvas.getBoundingClientRect();
    const point = (x, y) => ({ clientX: rect.left + rect.width * x / canvas.width, clientY: rect.top + rect.height * y / canvas.height });
    const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, ...point(x, y) }));

    // Commit an initial crop at the left of the preview.
    fire('pointerdown', 2, 2); fire('pointermove', 12, 14); fire('pointerup', 12, 14);
    // Begin a new crop on the right but keep dragging, which used to render the
    // saved left crop instead of the live selection.
    fire('pointerdown', 18, 3); fire('pointermove', 30, 16);
  }, MK);

  const dragging = await page.evaluate(() => window.MemoGifEditor.__state());
  expect(dragging.crop.x).toBeLessThan(10);
  expect(dragging.dragCrop.x).toBeGreaterThan(15);
  expect(dragging.previewCrop).toEqual(dragging.dragCrop);

  // A preview frame redraw must retain the live crop overlay rather than snap
  // back to the old persistent crop.
  await page.waitForTimeout(180);
  const afterTick = await page.evaluate(() => window.MemoGifEditor.__state());
  expect(afterTick.previewCrop).toEqual(afterTick.dragCrop);
  expect(afterTick.previewCrop.x).toBeGreaterThan(15);
});
