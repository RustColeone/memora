// Panel images (memo-panel.js): combine an entry's images into one composite.
// Asserts the canvas-stitching geometry (vertical/horizontal · resize · gap ·
// border) deterministically with known-size images, plus the detail-view trigger.
const { test, expect } = require('@playwright/test');

// Build a solid-colour PNG data URL of exact w×h in the page.
const MK = `(w,h,c)=>{const cv=document.createElement('canvas');cv.width=w;cv.height=h;const g=cv.getContext('2d');g.fillStyle=c;g.fillRect(0,0,w,h);return cv.toDataURL('image/png');}`;

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoPanel && window.MemoCore, null, { timeout: 15000 });
  await page.evaluate(() => window.MemoCore.start());
}

test('two-page workflow arranges, removes, previews, and returns to the list', async ({ page }) => {
  await boot(page);
  const initial = await page.evaluate((mkSrc) => {
    const mk = eval(mkSrc);
    const urls = [mk(50, 40, '#f00'), mk(50, 40, '#0f0'), mk(50, 40, '#00f')];
    window.MemoPanel.open(urls);
    const firstHandle = document.querySelector('.panel-card[data-panel-idx="0"] .panel-drag-handle');
    firstHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    document.querySelector('.panel-card[data-panel-idx="1"] .panel-remove-btn').click();
    return {
      page: window.MemoPanel.__state().page,
      urls: window.MemoPanel.__state().items.map(item => item.url),
      expected: [urls[1], urls[2]],
      count: document.getElementById('panelItemCount').textContent,
      combineDisabled: document.getElementById('panelCombineBtn').disabled,
    };
  }, MK);

  expect(initial.page).toBe(1);
  expect(initial.urls).toEqual(initial.expected);
  expect(initial.count).toBe('2 images');
  expect(initial.combineDisabled).toBe(false);

  await page.click('#panelCombineBtn');
  await page.waitForFunction(() => {
    const canvas = document.getElementById('panelCanvas');
    return canvas.width === 50 && canvas.height === 88;
  });
  await expect(page.locator('#panelPage2')).toBeVisible();
  await page.click('#panelBackBtn');
  await expect(page.locator('#panelPage1')).toBeVisible();
  expect(await page.evaluate(() => window.MemoPanel.__state().page)).toBe(1);
});

test('Panel page changes manage focus and collapsed options stay inert', async ({ page }) => {
  await boot(page);
  await page.evaluate((mkSrc) => {
    const mk = eval(mkSrc);
    window.MemoPanel.open([mk(20, 20, '#f00'), mk(20, 20, '#00f')]);
  }, MK);

  await page.click('#panelCombineBtn');
  await expect(page.locator('#panelOptsToggle')).toBeFocused();
  await expect(page.locator('#panelOpts')).toHaveAttribute('hidden', '');
  await expect(page.locator('#panelOpts')).toHaveAttribute('inert', '');
  await expect(page.locator('#panelOpts')).toHaveAttribute('aria-hidden', 'true');

  await page.click('#panelOptsToggle');
  await expect(page.locator('#panelOpts')).not.toHaveAttribute('hidden', '');
  await expect(page.locator('#panelOpts')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#panelOpts')).toHaveAttribute('aria-hidden', 'false');

  await page.locator('.panel-dir-btn[data-dir="vertical"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.panel-dir-btn[data-dir="horizontal"]')).toBeFocused();
  await expect(page.locator('.panel-dir-btn[data-dir="horizontal"]')).toHaveAttribute('aria-checked', 'true');
  expect((await page.evaluate(() => window.MemoPanel.__state())).options.direction).toBe('horizontal');

  await page.locator('.panel-fmt-btn[data-fmt="webp"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.panel-fmt-btn[data-fmt="png"]')).toBeFocused();
  await expect(page.locator('.panel-fmt-btn[data-fmt="png"]')).toHaveAttribute('aria-checked', 'true');

  await page.click('#panelOptsToggle');
  await expect(page.locator('#panelOpts')).toHaveAttribute('inert', '');
  await page.click('#panelBackBtn');
  await expect(page.locator('#panelCombineBtn')).toBeFocused();
});

test('the panel list adds images from device and the reusable library picker', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.MemoPanel.open());
  await page.setInputFiles('#panelFileInput', {
    name: 'device-page.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3nQAAAABJRU5ErkJggg==', 'base64'),
  });
  expect(await page.evaluate(() => window.MemoPanel.__state().items.map(item => item.label))).toEqual(['device page']);

  await page.evaluate((mkSrc) => {
    const mk = eval(mkSrc);
    window.__panelPickerOptions = null;
    window.MemoLibraryPicker.open = options => { window.__panelPickerOptions = options; };
    document.querySelector('.panel-add-library').click();
    window.__panelPickerOptions.onDone([mk(20, 10, '#a50')]);
  }, MK);
  expect(await page.evaluate(() => ({
    min: window.__panelPickerOptions.min,
    count: window.MemoPanel.__state().items.length,
    combineDisabled: document.getElementById('panelCombineBtn').disabled,
  }))).toEqual({ min: 1, count: 2, combineDisabled: false });
});

test('library picker callbacks restore the ordered draft after a Safe teardown', async ({ page }) => {
  await boot(page);
  const restored = await page.evaluate(async (mkSrc) => {
    const mk = eval(mkSrc);
    const device = new File([new Uint8Array([1, 2, 3])], 'device-page.png', { type: 'image/png' });
    const hiddenUrl = mk(16, 16, '#624');
    window.MemoCore.getState().db.entries.push({ id: 'now-hidden', description: 'Hidden after privacy switch', images: [hiddenUrl], tags: [] });
    window.MemoPrivacy.canViewEntry = entry => entry.id !== 'now-hidden';
    window.MemoPanel.open([
      device,
      mk(20, 10, '#246'),
      { url: hiddenUrl, name: 'private-page.png', mime: 'image/png', entryId: 'now-hidden', index: 0, safe: true },
    ]);
    document.querySelector('.panel-dir-btn[data-dir="horizontal"]').click();
    const gap = document.getElementById('panelGapInput');
    gap.value = '17'; gap.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.panel-fmt-btn[data-fmt="png"]').click();

    let pickerOptions;
    window.MemoLibraryPicker.open = options => { pickerOptions = options; };
    const originalDeviceUrl = window.MemoPanel.__state().items[0].url;
    document.querySelector('.panel-add-library').click();
    let closed = new Promise(resolve => document.getElementById('panelDlg').addEventListener('close', resolve, { once: true }));
    document.getElementById('panelDlg').close(); // mirrors MemoPrivacy's sensitive-surface teardown
    await closed;
    const emptyAfterTeardown = window.MemoPanel.__state().items.length;
    pickerOptions.onCancel();
    const afterCancel = window.MemoPanel.__state();

    document.querySelector('.panel-add-library').click();
    closed = new Promise(resolve => document.getElementById('panelDlg').addEventListener('close', resolve, { once: true }));
    document.getElementById('panelDlg').close();
    await closed;
    pickerOptions.onDone([{ url: mk(12, 12, '#a50'), name: 'library-page.png', mime: 'image/png', safe: true }]);
    const afterDone = window.MemoPanel.__state();
    return {
      emptyAfterTeardown,
      cancelLabels: afterCancel.items.map(item => item.label),
      cancelOptions: afterCancel.options,
      cancelFormat: afterCancel.format,
      cancelDeviceUrlChanged: afterCancel.items[0].url !== originalDeviceUrl,
      doneLabels: afterDone.items.map(item => item.label),
      doneOptions: afterDone.options,
      doneFormat: afterDone.format,
      doneSafe: afterDone.items[2].safe,
      panelOpen: document.getElementById('panelDlg').open,
    };
  }, MK);

  expect(restored.emptyAfterTeardown).toBe(0);
  expect(restored.cancelLabels).toEqual(['device page', 'Image 2']);
  expect(restored.cancelOptions).toMatchObject({ direction: 'horizontal', gap: 17 });
  expect(restored.cancelFormat).toBe('png');
  expect(restored.cancelDeviceUrlChanged).toBe(true);
  expect(restored.doneLabels).toEqual(['device page', 'Image 2', 'library page']);
  expect(restored.doneOptions).toMatchObject({ direction: 'horizontal', gap: 17 });
  expect(restored.doneFormat).toBe('png');
  expect(restored.doneSafe).toBe(true);
  expect(restored.panelOpen).toBe(true);
});

test('vertical combine with resize+gap yields the expected canvas size', async ({ page }) => {
  await boot(page);
  const dims = await page.evaluate(async (mkSrc) => {
    const mk = eval(mkSrc);
    const a = mk(100, 50, '#f00'), b = mk(200, 60, '#00f');
    window.MemoPanel.open([a, b]); // defaults: vertical, resize=true, gap=8, border=0
    const oc = await window.MemoPanel.buildCanvas(false);
    return { w: oc.width, h: oc.height };
  }, MK);
  // resize→both to maxW=200; heights 100 (=50*2) + 60, + gap 8 = 168
  expect(dims).toEqual({ w: 200, h: 168 });
});

test('horizontal combine honours gap + border from the controls', async ({ page }) => {
  await boot(page);
  const dims = await page.evaluate(async (mkSrc) => {
    const mk = eval(mkSrc);
    const a = mk(100, 50, '#f00'), b = mk(200, 60, '#00f');
    window.MemoPanel.open([a, b]);
    const setNumber = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    document.querySelector('.panel-dir-btn[data-dir="horizontal"]').click();
    setNumber('panelGapInput', 10);
    setNumber('panelBorderInput', 5);
    const oc = await window.MemoPanel.buildCanvas(false);
    return { w: oc.width, h: oc.height };
  }, MK);
  // resize→both to maxH=60; widths 120 (=100*60/50) + 200 + gap 10 = 330, +border 5*2 = 340; H 60 + 10 = 70
  expect(dims).toEqual({ w: 340, h: 70 });
});

test('resize off preserves each image at native size (union bounds)', async ({ page }) => {
  await boot(page);
  const dims = await page.evaluate(async (mkSrc) => {
    const mk = eval(mkSrc);
    window.MemoPanel.open([mk(100, 50, '#f00'), mk(200, 60, '#00f')]);
    const chk = document.getElementById('panelResizeToggle'); chk.checked = false; chk.dispatchEvent(new Event('change', { bubbles: true }));
    const gap = document.getElementById('panelGapInput'); gap.value = '0'; gap.dispatchEvent(new Event('input', { bubbles: true }));
    const oc = await window.MemoPanel.buildCanvas(false);
    return { w: oc.width, h: oc.height };
  }, MK);
  // vertical, no resize, no gap: W = max(100,200)=200; H = 50+60 = 110
  expect(dims).toEqual({ w: 200, h: 110 });
});

test('preview canvas stays within dimension and pixel budgets for tall stacks', async ({ page }) => {
  await boot(page);
  const bounds = await page.evaluate(async (mkSrc) => {
    const mk = eval(mkSrc);
    const pages = Array.from({ length: 48 }, (_, i) => mk(900, 1200, i % 2 ? '#147' : '#741'));
    window.MemoPanel.open(pages);
    const tall = await window.MemoPanel.buildCanvas(true);

    // This less-extreme stack is short enough to stay below the dimension cap;
    // its aspect ratio makes the independent total-pixel budget the limiter.
    const svg = (w, h, color) => 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/></svg>`
    );
    window.MemoPanel.open([svg(900, 1100, '#147'), svg(900, 1100, '#741'), svg(900, 1100, '#174')]);
    const budgeted = await window.MemoPanel.buildCanvas(true);
    const dimensions = canvas => ({ w: canvas.width, h: canvas.height, pixels: canvas.width * canvas.height });
    return { tall: dimensions(tall), budgeted: dimensions(budgeted) };
  }, MK);

  expect(bounds.tall.w).toBeLessThanOrEqual(460);
  expect(Math.max(bounds.tall.w, bounds.tall.h)).toBeLessThanOrEqual(2048);
  expect(bounds.tall.w).toBeGreaterThan(0);
  expect(bounds.tall.h).toBeGreaterThan(0);
  expect(bounds.budgeted.pixels).toBeLessThanOrEqual(750_000);
  expect(Math.max(bounds.budgeted.w, bounds.budgeted.h)).toBeLessThan(2048);
  expect(bounds.budgeted.pixels).toBeGreaterThan(700_000);
});

test('full-resolution export also stays within its pixel budget', async ({ page }) => {
  await boot(page);
  const bounds = await page.evaluate(async () => {
    const NativeImage = window.Image;
    const nativeDraw = CanvasRenderingContext2D.prototype.drawImage;
    window.Image = function () {
      this.naturalWidth = 10000;
      this.naturalHeight = 10000;
      this.width = 10000;
      this.height = 10000;
    };
    Object.defineProperty(window.Image.prototype, 'src', {
      configurable: true,
      set(value) { this.__src = value; queueMicrotask(() => this.onload && this.onload()); },
      get() { return this.__src || ''; },
    });
    CanvasRenderingContext2D.prototype.drawImage = function () {};
    try {
      window.MemoPanel.open(['mock://page-one', 'mock://page-two']);
      const output = await window.MemoPanel.buildCanvas(false);
      return { width: output.width, height: output.height, pixels: output.width * output.height };
    } finally {
      window.Image = NativeImage;
      CanvasRenderingContext2D.prototype.drawImage = nativeDraw;
    }
  });

  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.pixels).toBeLessThanOrEqual(32_000_000);
  expect(Math.max(bounds.width, bounds.height)).toBeLessThanOrEqual(32_767);
});

test('rapid preview changes decode each source only once per open session', async ({ page }) => {
  await boot(page);
  const counts = await page.evaluate(async (mkSrc) => {
    const NativeImage = window.Image;
    window.__panelImageInstances = 0;
    window.Image = function () {
      window.__panelImageInstances += 1;
      return new NativeImage();
    };
    window.Image.prototype = NativeImage.prototype;

    const mk = eval(mkSrc);
    const urls = [mk(100, 80, '#f00'), mk(120, 90, '#00f')];
    window.MemoPanel.open(urls);
    document.getElementById('panelCombineBtn').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const gap = document.getElementById('panelGapInput');
    for (let i = 1; i <= 12; i += 1) {
      gap.value = String(i);
      gap.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await window.MemoPanel.buildCanvas(false);
    const sameSession = window.__panelImageInstances;

    window.MemoPanel.open(urls);
    document.getElementById('panelCombineBtn').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { sameSession, nextSession: window.__panelImageInstances };
  }, MK);

  expect(counts.sameSession).toBe(2);
  expect(counts.nextSession).toBe(4);
});

test('a slow previous panel cannot replace the preview for newly opened images', async ({ page }) => {
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  let slowRequests = 0;

  await page.route('**/panel-slow-*.svg', async route => {
    slowRequests += 1;
    await slowGate;
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>',
    });
  });
  await boot(page);

  await page.evaluate(() => {
    window.__slowPanelDraws = 0;
    window.__panelCanvasAllocations = 0;
    const createElement = Document.prototype.createElement;
    Document.prototype.createElement = function (tagName, ...args) {
      if (String(tagName).toLowerCase() === 'canvas') window.__panelCanvasAllocations += 1;
      return createElement.call(this, tagName, ...args);
    };
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (String(args[0] && args[0].src).includes('/panel-slow-')) window.__slowPanelDraws += 1;
      return drawImage.apply(this, args);
    };
    window.MemoPanel.open(['/panel-slow-one.svg', '/panel-slow-two.svg']);
    document.getElementById('panelCombineBtn').click();
  });
  // The arrange-list thumbnails and canvas decoder can each request the source;
  // the lifecycle contract is that the pending canvas render becomes stale.
  await expect.poll(() => slowRequests).toBeGreaterThanOrEqual(2);

  await page.evaluate((mkSrc) => {
    const mk = eval(mkSrc);
    window.MemoPanel.open([mk(50, 100, '#00f'), mk(50, 100, '#0f0')]);
    document.getElementById('panelCombineBtn').click();
  }, MK);
  await page.waitForFunction(() => document.querySelector('#panelPreview canvas')?.width === 50);

  const allocationsBeforeRelease = await page.evaluate(() => window.__panelCanvasAllocations);
  releaseSlow();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__panelCanvasAllocations)).toBe(allocationsBeforeRelease);
  const current = await page.evaluate(() => {
    const preview = document.querySelector('#panelPreview canvas');
    return { width: preview && preview.width, height: preview && preview.height, slowDraws: window.__slowPanelDraws };
  });

  expect(current).toEqual({ width: 50, height: 208, slowDraws: 0 });
});

test('preview busy state disables actions and clears on completion, close, and error', async ({ page }) => {
  let releaseSlow;
  let slowGate = new Promise(resolve => { releaseSlow = resolve; });
  await page.route('**/panel-busy-*.svg', async route => {
    await slowGate;
    if (route.request().url().includes('error')) await route.abort();
    else await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="green"/></svg>',
    });
  });
  await boot(page);

  await page.evaluate(() => {
    window.MemoPanel.open(['/panel-busy-one.svg', '/panel-busy-two.svg']);
    document.getElementById('panelCombineBtn').click();
  });
  await expect(page.locator('#panelPreview')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#panelDownloadBtn')).toBeDisabled();
  await expect(page.locator('#panelSaveEntryBtn')).toBeDisabled();
  releaseSlow();
  await expect(page.locator('#panelPreview')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#panelDownloadBtn')).toBeEnabled();
  await expect(page.locator('#panelSaveEntryBtn')).toBeEnabled();

  slowGate = new Promise(resolve => { releaseSlow = resolve; });
  await page.evaluate(() => {
    window.MemoPanel.open(['/panel-busy-one.svg?close', '/panel-busy-two.svg?close']);
    document.getElementById('panelCombineBtn').click();
  });
  await expect(page.locator('#panelPreview')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => window.MemoPanel.close());
  await expect(page.locator('#panelDlg')).not.toHaveAttribute('open', '');
  await expect(page.locator('#panelPreview')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#panelDownloadBtn')).toBeDisabled();
  releaseSlow();

  slowGate = new Promise(resolve => { releaseSlow = resolve; });
  await page.evaluate(() => {
    window.MemoPanel.open(['/panel-busy-error.svg', '/panel-busy-ok.svg']);
    document.getElementById('panelCombineBtn').click();
  });
  releaseSlow();
  await expect(page.locator('#panelPreview')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#panelDownloadBtn')).toBeEnabled();
  await expect(page.locator('#panelPreview')).toContainText('Preview unavailable');
});

test('reopening during the close animation keeps the new panel session open', async ({ page }) => {
  await boot(page);
  await page.evaluate((mkSrc) => {
    const mk = eval(mkSrc);
    window.MemoPanel.open([mk(20, 20, '#f00'), mk(20, 20, '#00f')]);
    window.MemoPanel.close();
    window.MemoPanel.open([mk(30, 30, '#0f0'), mk(30, 30, '#ff0')]);
  }, MK);

  await expect(page.locator('#panelDlg')).toHaveAttribute('open', '');
  await expect(page.locator('#panelDlg')).not.toHaveClass(/closing/);
  await expect.poll(() => page.evaluate(() => window.MemoPanel.__state().items.length)).toBe(2);
  await page.waitForTimeout(200);
  await expect(page.locator('#panelDlg')).toHaveAttribute('open', '');
  await expect.poll(() => page.evaluate(() => window.MemoPanel.__state().items.length)).toBe(2);
});

test('full-resolution export keeps actions busy until encoding finishes', async ({ page }) => {
  await boot(page);
  await page.evaluate((mkSrc) => {
    const mk = eval(mkSrc);
    window.MemoPanel.open([mk(40, 40, '#f00'), mk(40, 40, '#00f')]);
    document.getElementById('panelCombineBtn').click();
  }, MK);
  await expect(page.locator('#panelPreview')).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => {
    window.__finishPanelEncode = null;
    HTMLAnchorElement.prototype.click = function () {};
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      window.__finishPanelEncode = () => callback(new Blob(['png'], { type: 'image/png' }));
    };
    document.getElementById('panelDownloadBtn').click();
  });

  await expect(page.locator('#panelPreview')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#panelDownloadBtn')).toBeDisabled();
  await expect(page.locator('#panelSaveEntryBtn')).toBeDisabled();
  await page.evaluate(() => window.__finishPanelEncode());
  await expect(page.locator('#panelPreview')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#panelDownloadBtn')).toBeEnabled();
  await expect(page.locator('#panelSaveEntryBtn')).toBeEnabled();
});

test('the detail view offers Combine only for multi-image entries and opens the dialog', async ({ page }) => {
  await boot(page);
  await page.evaluate(async (mkSrc) => {
    const mk = eval(mkSrc);
    const bundle = { version: 1, finance: [], memos: [
      { id: 'p1', description: 'two pages', category: 'Work', tags: [], images: [mk(60, 60, '#f00'), mk(60, 60, '#0f0')], ts: Date.now() },
      { id: 'p2', description: 'one page', category: 'Work', tags: [], images: [mk(60, 60, '#00f')], ts: Date.now() - 1000 },
    ] };
    await window.MemoStateDb.importBundle(bundle, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
  }, MK);

  const multi = await page.evaluate(() => {
    window.MemoVariant.openDetail('p1');
    const has = !!document.getElementById('detailCombineBtn');
    document.getElementById('detailCombineBtn').click();
    return { has, panelOpen: document.getElementById('panelDlg').open };
  });
  expect(multi.has).toBe(true);
  expect(multi.panelOpen).toBe(true);

  const single = await page.evaluate(() => {
    window.MemoPanel.close();
    document.getElementById('detailDlg').close();
    window.MemoVariant.openDetail('p2');
    return !!document.getElementById('detailCombineBtn');
  });
  expect(single).toBe(false);
});
