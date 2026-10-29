const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function bootMemo(page) {
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoMotion && window.MemoLazy && window.MemoCore && window.MemoStateDb?.ready()
      && window.MemoFilterBootstrapped,
    null,
    { timeout: 15000 },
  );
  await page.evaluate(() => window.MemoAppReady);
}

test('rapid view transitions commit only the newest render', async ({ page }) => {
  await bootMemo(page);
  const result = await page.evaluate(async () => {
    const feed = document.createElement('div');
    feed.className = 'feed';
    document.body.appendChild(feed);
    const calls = [];
    window.MemoMotion.viewTransition(feed, () => calls.push('stale'));
    window.MemoMotion.viewTransition(feed, () => calls.push('latest'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      calls,
      leaving: feed.classList.contains('feed-leaving'),
    };
  });
  expect(result.calls).toEqual(['latest']);
  expect(result.leaving).toBe(false);
});

test('a reduced-motion intent cancels an older native view-transition commit', async ({ page }) => {
  await bootMemo(page);
  await page.evaluate(async () => {
    window.__nativeTransitionProbe = { calls: [], pendingCommit: null, skipped: 0 };
    document.startViewTransition = update => {
      window.__nativeTransitionProbe.pendingCommit = update;
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise(() => {}),
        skipTransition() { window.__nativeTransitionProbe.skipped += 1; },
      };
    };
    window.MemoMotion.viewTransition(
      document.getElementById('feed'),
      () => window.__nativeTransitionProbe.calls.push('stale'),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    window.MemoMotion.viewTransition(
      document.getElementById('feed'),
      () => window.__nativeTransitionProbe.calls.push('latest'),
    );
    await window.__nativeTransitionProbe.pendingCommit();
    return window.__nativeTransitionProbe;
  });
  expect(result.calls).toEqual(['latest']);
  expect(result.skipped).toBe(1);
});

test('rapid search input is coalesced to one settled render', async ({ page }) => {
  await bootMemo(page);
  const renders = await page.evaluate(async () => {
    let count = 0;
    const original = window.MemoVariant.renderFeed;
    window.MemoVariant.renderFeed = () => { count += 1; };
    const search = document.getElementById('searchBox');
    for (let i = 0; i < 50; i += 1) {
      search.value = `query-${i}`;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise(resolve => setTimeout(resolve, 140));
    window.MemoVariant.renderFeed = original;
    return count;
  });
  expect(renders).toBe(1);
});

test('IME composition does not render incomplete search text', async ({ page }) => {
  await bootMemo(page);
  const result = await page.evaluate(async () => {
    let count = 0;
    const original = window.MemoVariant.renderFeed;
    window.MemoVariant.renderFeed = () => { count += 1; };
    const search = document.getElementById('searchBox');
    search.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const value of ['n', 'ni', 'nih']) {
      search.value = value;
      search.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    }
    await new Promise(resolve => setTimeout(resolve, 140));
    const during = count;
    search.value = '日本';
    search.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
    await new Promise(resolve => setTimeout(resolve, 140));
    window.MemoVariant.renderFeed = original;
    return { during, after: count };
  });
  expect(result).toEqual({ during: 0, after: 1 });
});

test('an older stagger cleanup cannot cancel a newer entrance', async ({ page }) => {
  await bootMemo(page);
  const active = await page.evaluate(async () => {
    const item = document.createElement('div');
    document.body.appendChild(item);
    window.MemoMotion.stagger([item], 'pop');
    await new Promise(resolve => setTimeout(resolve, 820));
    window.MemoMotion.stagger([item], 'pop');
    // The first run's 900ms fallback fires while this newer run still owns the
    // element. It must not remove the newer entrance class.
    await new Promise(resolve => setTimeout(resolve, 120));
    return item.classList.contains('motion-pop');
  });
  expect(active).toBe(true);
});

test('staggering a feed page does not force layout once per item', async ({ page }) => {
  await bootMemo(page);
  const reads = await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    let count = 0;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        count += 1;
        return descriptor.get.call(this);
      },
    });
    const items = Array.from({ length: 60 }, () => {
      const item = document.createElement('article');
      document.body.appendChild(item);
      return item;
    });
    window.MemoMotion.stagger(items, 'pop');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', descriptor);
    return count;
  });
  expect(reads).toBeLessThanOrEqual(1);
});

test('reduced motion suppresses legacy transitions and indefinite animation', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await bootMemo(page);
  const result = await page.evaluate(() => {
    const button = document.createElement('button');
    const image = document.createElement('img');
    image.className = 'lazy-img';
    const sync = document.createElement('div');
    sync.className = 'sync-status syncing';
    const icon = document.createElement('span');
    icon.id = 'syncIcon';
    sync.appendChild(icon);
    document.body.append(button, image, sync);
    const durations = value => value.split(',').map(part => parseFloat(part) || 0);
    return {
      button: durations(getComputedStyle(button).transitionDuration),
      image: durations(getComputedStyle(image).transitionDuration),
      spinner: durations(getComputedStyle(icon).animationDuration),
      iterations: getComputedStyle(icon).animationIterationCount,
    };
  });
  for (const values of [result.button, result.image, result.spinner]) {
    expect(Math.max(...values)).toBeLessThanOrEqual(0.001);
  }
  expect(result.iterations).not.toBe('infinite');
  await context.close();
});

test('dialog motion locks the exact scroll position and restores opener focus', async ({ page }) => {
  await bootMemo(page);
  const opened = await page.evaluate(async () => {
    const opener = document.getElementById('filtersBtn');
    opener.focus();
    const dialog = document.getElementById('filtersDlg');
    dialog.showModal();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      open: dialog.open,
      bodyPosition: document.body.style.position,
      labelled: !!(dialog.getAttribute('aria-label') || dialog.getAttribute('aria-labelledby')),
      activeInside: dialog.contains(document.activeElement),
    };
  });
  expect(opened).toEqual({ open: true, bodyPosition: 'fixed', labelled: true, activeInside: true });

  const immediate = await page.evaluate(() => {
    const dialog = document.getElementById('filtersDlg');
    dialog.close();
    return { open: dialog.open, closing: dialog.classList.contains('closing') };
  });
  expect(immediate).toEqual({ open: true, closing: true });
  await page.waitForFunction(() => !document.getElementById('filtersDlg').open);
  const closed = await page.evaluate(() => ({
    bodyPosition: document.body.style.position,
    activeId: document.activeElement?.id,
    closing: document.getElementById('filtersDlg').classList.contains('closing'),
  }));
  expect(closed).toEqual({ bodyPosition: '', activeId: 'filtersBtn', closing: false });
});

test('dialog chrome uses a consistent theme-aware keyboard focus ring', async ({ page }) => {
  await bootMemo(page);
  const focusRing = await page.evaluate(() => {
    const dialog = document.getElementById('filtersDlg');
    dialog.showModal();
    const close = dialog.querySelector('.modal-close');
    close.focus();
    const style = getComputedStyle(close);
    return {
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      color: style.outlineColor,
    };
  });
  expect(focusRing.style).toBe('solid');
  expect(focusRing.width).toBeGreaterThanOrEqual(2);
  expect(focusRing.color).not.toBe('rgb(0, 0, 0)');
});

test('dialog backdrop fades with compositor opacity instead of background paint', async ({ page }) => {
  await bootMemo(page);
  const properties = await page.evaluate(() => {
    const dialog = document.getElementById('filtersDlg');
    dialog.showModal();
    return getComputedStyle(dialog, '::backdrop').transitionProperty
      .split(',').map(value => value.trim());
  });
  expect(properties).toContain('opacity');
  expect(properties).not.toContain('background');
  expect(properties).not.toContain('background-color');
});

test('rapid dialog reopen cancels an in-flight close', async ({ page }) => {
  await bootMemo(page);
  const result = await page.evaluate(async () => {
    const dialog = document.getElementById('filtersDlg');
    dialog.showModal();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    dialog.close();
    dialog.showModal();
    await new Promise(resolve => setTimeout(resolve, 220));
    const state = { open: dialog.open, closing: dialog.classList.contains('closing') };
    dialog.close();
    return state;
  });
  expect(result).toEqual({ open: true, closing: false });
});

test('showModal is idempotent and preserves the original external opener', async ({ page }) => {
  await bootMemo(page);
  const result = await page.evaluate(async () => {
    const opener = document.getElementById('filtersBtn');
    const dialog = document.getElementById('filtersDlg');
    opener.focus();
    dialog.showModal();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const inside = dialog.querySelector('input, button');
    inside.focus();
    let threw = false;
    try { dialog.showModal(); } catch (_error) { threw = true; }
    const inlineOpacity = dialog.style.opacity;
    const inlineTransform = dialog.style.transform;
    dialog.close();
    await new Promise(resolve => setTimeout(resolve, 220));
    return {
      threw,
      inlineOpacity,
      inlineTransform,
      activeId: document.activeElement && document.activeElement.id,
    };
  });
  expect(result).toEqual({
    threw: false,
    inlineOpacity: '',
    inlineTransform: '',
    activeId: 'filtersBtn',
  });
});

test('phone pickers are bottom sheets with a drag-to-dismiss handle', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await bootMemo(page);
  await page.evaluate(() => document.getElementById('filtersDlg').showModal());
  await page.waitForFunction(() => document.getElementById('filtersDlg').open);
  await page.waitForFunction(() => {
    const rect = document.getElementById('filtersDlg').getBoundingClientRect();
    return Math.abs(innerHeight - rect.bottom) < 1;
  });
  const geometry = await page.evaluate(() => {
    const dialog = document.getElementById('filtersDlg');
    const handle = dialog.querySelector(':scope > .sheet-drag-handle');
    const rect = dialog.getBoundingClientRect();
    const rowGaps = Array.from(dialog.querySelectorAll('.content > .row')).flatMap(row => {
      const visible = Array.from(row.children).filter(child => getComputedStyle(child).display !== 'none');
      return visible.slice(1).map((child, index) => child.getBoundingClientRect().top - visible[index].getBoundingClientRect().bottom);
    });
    const labelHeights = Array.from(dialog.querySelectorAll('.content > .row > label'))
      .map(label => label.getBoundingClientRect().height);
    return {
      mobileSheet: dialog.classList.contains('mobile-sheet'),
      handleDisplay: handle && getComputedStyle(handle).display,
      width: Math.round(rect.width),
      bottomGap: Math.round(innerHeight - rect.bottom),
      maxRowGap: Math.max(0, ...rowGaps),
      maxLabelHeight: Math.max(0, ...labelHeights),
    };
  });
  expect(geometry.mobileSheet).toBe(true);
  expect(geometry.handleDisplay).toBe('flex');
  expect(geometry.width).toBe(390);
  expect(Math.abs(geometry.bottomGap)).toBeLessThanOrEqual(1);
  expect(geometry.maxRowGap).toBeLessThanOrEqual(16);
  expect(geometry.maxLabelHeight).toBeLessThanOrEqual(32);

  const handle = page.locator('#filtersDlg > .sheet-drag-handle');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 210, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => !document.getElementById('filtersDlg').open);
});

test('a short, fast phone-sheet flick dismisses below the distance threshold', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await bootMemo(page);
  await page.evaluate(() => document.getElementById('filtersDlg').showModal());
  const handle = page.locator('#filtersDlg > .sheet-drag-handle');
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await handle.dispatchEvent('pointerdown', {
    pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y,
  });
  await handle.dispatchEvent('pointermove', {
    pointerId: 41, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y + 40,
  });
  await handle.dispatchEvent('pointerup', {
    pointerId: 41, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y + 40,
  });
  await page.waitForFunction(
    () => !document.getElementById('filtersDlg').open,
    null,
    { timeout: 3000 },
  );
});

test('pressed lightbox navigation retains its vertical centering transform', async ({ page }) => {
  await bootMemo(page);
  await page.evaluate(() => {
    const surface = document.createElement('div');
    surface.style.cssText = 'position:fixed;inset:0;z-index:9999';
    const button = document.createElement('button');
    button.id = 'motionTestLbPrev';
    button.className = 'lbbtn lbprev';
    button.textContent = 'Previous';
    surface.appendChild(button);
    document.body.appendChild(surface);
  });
  const button = page.locator('#motionTestLbPrev');
  const box = await button.boundingBox();
  const normalY = await button.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).m42);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const pressed = await button.evaluate(element => {
    const style = getComputedStyle(element);
    const matrix = new DOMMatrix(style.transform);
    return { y: matrix.m42, scale: parseFloat(style.scale) || 1 };
  });
  await page.mouse.up();
  expect(Math.abs(pressed.y - normalY)).toBeLessThanOrEqual(1);
  expect(pressed.scale).toBeLessThan(1);
});

test('lazy image hydration prunes detached observer targets', async ({ page }) => {
  await page.addInitScript(() => {
    window.__lazyObservers = [];
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); window.__lazyObservers.push(this); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    };
  });
  await bootMemo(page);
  const detached = await page.evaluate(() => {
    const makeRoot = count => {
      const root = document.createElement('div');
      for (let i = 0; i < count; i += 1) {
        const img = document.createElement('img');
        img.dataset.src = `/uploads/lazy-${i}.png`;
        root.appendChild(img);
      }
      document.body.appendChild(root);
      window.MemoLazy.hydrate(root);
      return root;
    };
    const oldRoot = makeRoot(20);
    oldRoot.remove();
    makeRoot(7);
    return window.__lazyObservers.reduce(
      (count, observer) => count + [...observer.targets].filter(target => !target.isConnected).length,
      0,
    );
  });
  expect(detached).toBe(0);
});

test('finance owns only its latest totals observer', async ({ page }) => {
  await page.addInitScript(() => {
    window.__financeObservers = [];
    window.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.targets = new Set();
        this.disconnected = false;
        window.__financeObservers.push(this);
      }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); this.disconnected = true; }
    };
  });
  await page.goto('/finance.html');
  await page.waitForFunction(() => window.MemoVariant && window.MemoStateDb?.ready(), null, { timeout: 15000 });
  const active = await page.evaluate(() => {
    for (let i = 0; i < 20; i += 1) window.MemoVariant.renderFeed();
    return window.__financeObservers.filter(observer => !observer.disconnected && observer.targets.size).length;
  });
  expect(active).toBe(1);
});

test('motion CSS avoids broad transition-all declarations', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/static/css/memo.css'), 'utf8');
  expect(css).not.toMatch(/transition\s*:\s*all\b/i);
  expect(css).not.toMatch(/transition\s*:\s*(?:\d*\.)?\d+(?:ms|s)\b/i);
  expect(css).not.toMatch(/\.motion-pop\s*\{[^}]*will-change/s);
});
