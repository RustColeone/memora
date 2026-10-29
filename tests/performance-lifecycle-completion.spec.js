const { test, expect } = require('@playwright/test');

function installControlledObservers(page) {
  return page.addInitScript(() => {
    window.__performanceObservers = [];
    class ControlledIntersectionObserver {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = new Set();
        this.disconnected = false;
        window.__performanceObservers.push(this);
      }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); this.disconnected = true; }
      takeRecords() { return []; }
    }
    window.IntersectionObserver = ControlledIntersectionObserver;
    window.__triggerPerformanceIntersection = (selector) => {
      let fired = 0;
      for (const observer of window.__performanceObservers.slice()) {
        for (const target of Array.from(observer.targets)) {
          if (!target.isConnected || !target.matches(selector)) continue;
          observer.callback([{ target, isIntersecting: true, intersectionRatio: 1 }], observer);
          fired += 1;
        }
      }
      return fired;
    };
  });
}

async function bootMemo(page, path = '/index.html') {
  await page.goto(path);
  await page.evaluate(() => window.MemoAppReady || window.MemoCore?.start());
  await page.waitForFunction(
    () => window.MemoCore && window.MemoStateDb?.ready() && window.MemoLazy && window.MemoVariant,
    null,
    { timeout: 15000 },
  );
}

test('a late lazy-path lookup cannot repaint an image requested for a newer path', async ({ page }) => {
  await installControlledObservers(page);
  await bootMemo(page);

  const result = await page.evaluate(async () => {
    const stateDb = window.MemoStateDb;
    const nativeThumbUrl = window.MemoThumbs.urlFor;
    const pending = new Map();
    window.MemoThumbs.urlFor = (path) => new Promise(resolve => pending.set(path, resolve));

    const image = document.createElement('img');
    image.id = 'stale-lazy-probe';
    image.dataset.src = '/uploads/perf-old.png';
    document.body.appendChild(image);
    window.MemoLazy.observe(image);
    window.__triggerPerformanceIntersection('#stale-lazy-probe');

    image.removeAttribute('data-lazy-done');
    image.dataset.src = '/uploads/perf-new.png';
    window.MemoLazy.observe(image);
    window.__triggerPerformanceIntersection('#stale-lazy-probe');

    pending.get('/uploads/perf-new.png')('blob:http://localhost/perf-new');
    await Promise.resolve();
    pending.get('/uploads/perf-old.png')('blob:http://localhost/perf-old');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const out = {
      src: image.getAttribute('src'),
      dataSrc: image.getAttribute('data-src'),
      done: image.dataset.lazyDone,
    };
    window.MemoThumbs.urlFor = nativeThumbUrl;
    image.remove();
    return out;
  });

  expect(result).toEqual({
    src: 'blob:http://localhost/perf-new',
    dataSrc: 'blob:http://localhost/perf-new',
    done: '1',
  });
});

test('late mounted-entry hydration cannot patch a replacement state object', async ({ page }) => {
  await bootMemo(page);
  await page.waitForFunction(() => window.MemoCore.__mountedImageHydrationReady());

  const result = await page.evaluate(async () => {
    const state = window.MemoCore.getState();
    const stateDb = window.MemoStateDb;
    const nativeHydrate = stateDb.hydrateImages;
    let resolveHydration;
    let hydrationStarted;
    const started = new Promise(resolve => { hydrationStarted = resolve; });
    const oldEntry = {
      id: 'stale-mounted-entry', description: 'old', category: 'Uncategorized', tags: [],
      _storedPaths: ['uploads/perf/shared.png'], images: ['/uploads/perf/shared.png'], ts: 1,
    };
    state.db.entries.splice(0, state.db.entries.length, oldEntry);
    stateDb.hydrateImages = entry => {
      hydrationStarted();
      return new Promise(resolve => {
        resolveHydration = () => {
          entry.images = ['blob:http://localhost/stale-mounted'];
          resolve(entry);
        };
      });
    };

    const card = document.createElement('article');
    card.dataset.id = oldEntry.id;
    const image = document.createElement('img');
    image.dataset.src = '/uploads/perf/shared.png';
    card.appendChild(image);
    document.getElementById('feed').appendChild(card);
    await started;

    state.db.entries[0] = {
      id: oldEntry.id, description: 'new', category: 'Uncategorized', tags: [],
      _storedPaths: ['uploads/perf/shared.png'], images: ['/uploads/perf/shared.png'], ts: 2,
    };
    resolveHydration();
    await Promise.resolve();
    await Promise.resolve();

    const out = { dataSrc: image.getAttribute('data-src'), src: image.getAttribute('src') };
    stateDb.hydrateImages = nativeHydrate;
    card.remove();
    return out;
  });

  expect(result).toEqual({ dataSrc: '/uploads/perf/shared.png', src: null });
});

test('finance appends bounded result windows without replacing mounted rows', async ({ page }) => {
  await installControlledObservers(page);
  await bootMemo(page, '/finance.html');

  const initial = await page.evaluate(() => {
    const state = window.MemoCore.getState();
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const entries = Array.from({ length: 125 }, (_, index) => ({
      id: `perf-fin-${index}`,
      description: `Finance ${index}`,
      category: 'Uncategorized',
      tags: [], images: [image],
      attachments: [{ name: `Receipt ${index}.pdf`, type: 'application/pdf', url: 'data:application/pdf;base64,JVBERi0xLjQ=' }],
      deletedAt: null,
      purchaseDate: `2026-${String(1 + Math.floor(index / 28)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}`,
      sheet: 'General', items: [{ name: 'Item', amount: 1, unitPrice: 1, totalPrice: 1 }],
      tax: 0, total: 1, ts: index + 1,
    }));
    window.__financeContextIds = [];
    window.__financeNativeAttachLongPress = window.MemoCtx.attachLongPress;
    window.MemoCtx.attachLongPress = node => { window.__financeContextIds.push(node.dataset.id); };
    state.db.entries.splice(0, state.db.entries.length, ...entries);
    window.MemoVariant.renderFeed();
    const rows = document.querySelectorAll('#feed tr.entry-row');
    return {
      count: rows.length,
      firstId: rows[0]?.dataset.id,
      contextRows: window.__financeContextIds.length,
      hasMore: !!document.querySelector('.finance-window-sentinel'),
    };
  });

  expect(initial).toEqual({ count: 60, firstId: 'perf-fin-124', contextRows: 60, hasMore: true });
  const appended = await page.evaluate(() => {
    const first = document.querySelector('#feed tr.entry-row');
    const boundaryMonth = document.querySelectorAll('#feed tr.entry-row')[59].dataset.month;
    document.querySelector(`#feed tr.month-row[data-month="${boundaryMonth}"]`).click();
    const fired = window.__triggerPerformanceIntersection('.finance-window-sentinel');
    const rows = Array.from(document.querySelectorAll('#feed tr.entry-row'));
    const initialRow = rows[0];
    const appendedRow = rows[119];
    const appendedId = appendedRow.dataset.id;
    appendedRow.click();
    const detailId = document.getElementById('detailDlg').dataset.entryId;
    document.getElementById('detailDlg').close();
    return {
      fired,
      count: rows.length,
      firstPreserved: rows[0] === first,
      hasMore: !!document.querySelector('.finance-window-sentinel'),
      contextRows: window.__financeContextIds.length,
      appendedId,
      detailId,
      sameCellClasses: Array.from(initialRow.cells, cell => cell.className)
        .join('|') === Array.from(appendedRow.cells, cell => cell.className).join('|'),
      mediaAndFile: !!appendedRow.querySelector('.inline-thumbs img') && !!appendedRow.querySelector('.filelink'),
      money: ['.col-price', '.col-tax', '.col-total'].map(selector => appendedRow.querySelector(selector).textContent),
      collapsedContinuation: rows.slice(60)
        .filter(row => row.dataset.month === boundaryMonth)
        .every(row => row.classList.contains('hidden-row')),
    };
  });
  expect(appended).toEqual({
    fired: 1,
    count: 120,
    firstPreserved: true,
    hasMore: true,
    contextRows: 120,
    appendedId: appended.detailId,
    detailId: appended.detailId,
    sameCellClasses: true,
    mediaAndFile: true,
    money: ['$1.00', '$0.00', '$1.00'],
    collapsedContinuation: true,
  });

  const rerenders = await page.evaluate(() => {
    window.MemoVariant.renderFeed();
    const retained = document.querySelectorAll('#feed tr.entry-row').length;
    const search = document.getElementById('searchBox');
    search.value = 'Finance';
    window.MemoVariant.renderFeed();
    return { retained, reset: document.querySelectorAll('#feed tr.entry-row').length };
  });
  expect(rerenders).toEqual({ retained: 120, reset: 60 });

  await page.setViewportSize({ width: 330, height: 700 });
  await page.waitForTimeout(220);
  const narrow = await page.evaluate(() => {
    window.MemoVariant.renderFeed();
    window.__triggerPerformanceIntersection('.finance-window-sentinel');
    const spans = Array.from(document.querySelectorAll('#feed .month-toggle'), cell => cell.colSpan);
    window.MemoCtx.attachLongPress = window.__financeNativeAttachLongPress;
    return { rows: document.querySelectorAll('#feed tr.entry-row').length, spans };
  });
  expect(narrow.rows).toBe(120);
  expect(narrow.spans.length).toBeGreaterThan(1);
  expect(narrow.spans.every(span => span === 2)).toBe(true);
});

test('album/category projection stays linear instead of rescanning once per folder', async ({ page }) => {
  await installControlledObservers(page);
  await bootMemo(page);
  const count = 180;
  const result = await page.evaluate(entryCount => {
    window.__categoryReads = 0;
    const state = window.MemoCore.getState();
    const entries = Array.from({ length: entryCount }, (_, index) => {
      const entry = {
        id: `perf-category-${index}`,
        description: `Category ${index}`,
        tags: [], images: [], attachments: [], deletedAt: null, ts: index,
      };
      Object.defineProperty(entry, 'category', {
        enumerable: true,
        get() { window.__categoryReads += 1; return `Folder ${index}`; },
      });
      return entry;
    });
    state.db.entries.splice(0, state.db.entries.length, ...entries);
    state.settings.timeSplit = { enabled: false, period: 'month' };
    document.getElementById('categoryFilter').value = '__ALL__';
    state.activeFilters.cats.clear();
    state.activeFilters.tags.clear();
    window.MemoVariant.renderFeed();
    return {
      reads: window.__categoryReads,
      folders: document.querySelectorAll('#feed .folder-card').length,
    };
  }, count);

  expect(result.folders).toBe(count);
  expect(result.reads).toBeLessThanOrEqual(count * 2);
});

for (const variantPath of ['/index.html', '/finance.html']) {
test(`${variantPath}: recycle bin retains bounded cards through refresh and removal`, async ({ page }) => {
  await installControlledObservers(page);
  await bootMemo(page, variantPath);

  await page.evaluate(() => {
    const now = Date.now();
    const state = window.MemoCore.getState();
    const entries = Array.from({ length: 125 }, (_, index) => ({
      id: `perf-bin-${index}`,
      description: `Deleted ${index}`,
      category: 'Uncategorized', tags: [], images: [], attachments: [], ts: index,
      deletedAt: now - index, permanentDeleteAt: now + 30 * 86400000,
    }));
    state.db.entries.splice(0, state.db.entries.length, ...entries);
    document.getElementById('recycleBinBtn').click();
  });
  await expect(page.locator('#feed .card.deleted')).toHaveCount(60);
  const initial = await page.evaluate(() => {
    const cards = document.querySelectorAll('#feed .card.deleted');
    return { count: cards.length, firstId: cards[0]?.querySelector('.restore-btn')?.dataset.id, hasMore: !!document.querySelector('.recycle-window-sentinel') };
  });
  expect(initial).toEqual({ count: 60, firstId: 'perf-bin-0', hasMore: true });

  const appended = await page.evaluate(() => {
    const first = document.querySelector('#feed .card.deleted');
    const fired = window.__triggerPerformanceIntersection('.recycle-window-sentinel');
    const cards = document.querySelectorAll('#feed .card.deleted');
    return {
      fired,
      count: cards.length,
      firstPreserved: cards[0] === first,
      hasMore: !!document.querySelector('.recycle-window-sentinel'),
    };
  });
  expect(appended).toEqual({ fired: 1, count: 120, firstPreserved: true, hasMore: true });
  const refreshed = await page.evaluate(() => {
    const first = document.querySelector('#feed .card.deleted');
    window.MemoVariant.renderFeed();
    return { count: document.querySelectorAll('#feed .card.deleted').length,
      same: document.querySelector('#feed .card.deleted') === first };
  });
  expect(refreshed).toEqual({ count: 120, same: true });
  await page.locator('#feed .card.deleted').first().locator('.delete-perm-btn').click();
  await page.locator('#memoConfirmDlg .memo-confirm-ok').click();
  await expect(page.locator('#feed .restore-btn[data-id="perf-bin-0"]')).toHaveCount(0);
  await expect(page.locator('#feed .card.deleted')).toHaveCount(120);
});
}

test('memo recurring intervals and capture observer release ownership on pagehide', async ({ page }) => {
  await page.addInitScript(() => {
    window.__MEMO_STATE_DB_TEST__ = true;
    const nativeSet = window.setInterval.bind(window);
    const nativeClear = window.clearInterval.bind(window);
    window.__ownedIntervals = new Map();
    window.setInterval = (callback, delay, ...args) => {
      const id = nativeSet(callback, delay, ...args);
      window.__ownedIntervals.set(id, { delay, cleared: false });
      return id;
    };
    window.clearInterval = id => {
      const record = window.__ownedIntervals.get(id);
      if (record) record.cleared = true;
      return nativeClear(id);
    };
    window.__captureObservers = [];
    window.IntersectionObserver = class {
      constructor() { this.disconnected = false; window.__captureObservers.push(this); }
      observe() {}
      unobserve() {}
      disconnect() { this.disconnected = true; }
    };
  });
  await bootMemo(page);

  const result = await page.evaluate(() => {
    window.MemoAuth.startUploadSessionRefresh('');
    window.MemoCapture.initAddCard();
    const trackedDelays = [12 * 3600 * 1000, 24 * 3600 * 1000];
    const before = Array.from(window.__ownedIntervals.values()).filter(record => trackedDelays.includes(record.delay));
    window.dispatchEvent(new Event('pagehide'));
    return {
      owned: before.map(record => record.delay).sort((a, b) => a - b),
      allCleared: before.every(record => record.cleared),
      captureDisconnected: window.__captureObservers.every(observer => observer.disconnected),
    };
  });
  expect(result).toEqual({
    owned: [12 * 3600 * 1000, 24 * 3600 * 1000],
    allCleared: true,
    captureDisconnected: true,
  });
});

test('persisted pagehide keeps frozen lifecycle ownership usable for BFCache restore', async ({ page }) => {
  await page.addInitScript(() => {
    window.__MEMO_STATE_DB_TEST__ = true;
    const nativeSet = window.setInterval.bind(window);
    const nativeClear = window.clearInterval.bind(window);
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    window.__bfcacheIntervals = new Map();
    window.__bfcacheTimeouts = new Map();
    window.setInterval = (callback, delay, ...args) => {
      const id = nativeSet(callback, delay, ...args);
      window.__bfcacheIntervals.set(id, { delay, cleared: false });
      return id;
    };
    window.clearInterval = id => {
      const record = window.__bfcacheIntervals.get(id);
      if (record) record.cleared = true;
      return nativeClear(id);
    };
    window.setTimeout = (callback, delay, ...args) => {
      const id = nativeSetTimeout(callback, delay, ...args);
      window.__bfcacheTimeouts.set(id, { delay, cleared: false });
      return id;
    };
    window.clearTimeout = id => {
      const record = window.__bfcacheTimeouts.get(id);
      if (record) record.cleared = true;
      return nativeClearTimeout(id);
    };
    window.__bfcacheObservers = [];
    window.IntersectionObserver = class {
      constructor(_callback, options) {
        this.options = options || {};
        this.disconnected = false;
        window.__bfcacheObservers.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() { this.disconnected = true; }
    };
  });
  await bootMemo(page);
  await page.waitForFunction(() => window.MemoCore.__mountedImageHydrationReady());

  const result = await page.evaluate(async () => {
    window.MemoAuth.startUploadSessionRefresh('');
    window.MemoCapture.initAddCard();
    const trackedDelays = [12 * 3600 * 1000, 24 * 3600 * 1000];
    const intervals = Array.from(window.__bfcacheIntervals.values()).filter(record => trackedDelays.includes(record.delay));
    const capture = window.__bfcacheObservers.slice().reverse()
      .find(observer => observer.options.threshold === 0.4 && !observer.disconnected);

    // Isolate this write from any bootstrap persistence, then verify that the
    // persisted pagehide owns the flush instead of leaving it to the 1 s debounce.
    await window.MemoStateDb.flush();
    const SQL = await window.initSqlJs({ locateFile: file => `/static/vendor/${file}` });
    const probeKey = `bfcache-flush-${crypto.randomUUID()}`;
    const probeValue = { token: crypto.randomUUID() };
    window.MemoStateDb.setItem(probeKey, probeValue);
    const pendingFlush = Array.from(window.__bfcacheTimeouts.values()).reverse()
      .find(record => record.delay === 1000 && !record.cleared);

    const pagehide = new Event('pagehide');
    Object.defineProperty(pagehide, 'persisted', { value: true });
    window.dispatchEvent(pagehide);
    const flushTimerClearedImmediately = !!pendingFlush && pendingFlush.cleared;

    let durableFlush = false;
    const deadline = performance.now() + 5000;
    while (!durableFlush && performance.now() < deadline) {
      try {
        const bytes = await window.MemoStateDb.__test.readDbFile(
          window.MemoStateDb.__test.constants.primary,
          true,
        );
        if (bytes) {
          const persisted = new SQL.Database(new Uint8Array(bytes));
          const statement = persisted.prepare('SELECT value FROM settings WHERE key=?');
          statement.bind([probeKey]);
          if (statement.step()) {
            durableFlush = JSON.parse(statement.getAsObject().value).token === probeValue.token;
          }
          statement.free();
          persisted.close();
        }
      } catch (_error) {}
      if (!durableFlush) await new Promise(resolve => setTimeout(resolve, 25));
    }

    return {
      intervals: intervals.length,
      anyCleared: intervals.some(record => record.cleared),
      captureDisconnected: !!capture && capture.disconnected,
      cacheDisposed: window.MemoStateDb.__test.blobUrlCacheStats().disposed,
      mountedHydrationReady: window.MemoCore.__mountedImageHydrationReady(),
      flushTimerClearedImmediately,
      durableFlush,
    };
  });
  expect(result).toEqual({
    intervals: 2,
    anyCleared: false,
    captureDisconnected: false,
    cacheDisposed: false,
    mountedHydrationReady: true,
    flushTimerClearedImmediately: true,
    durableFlush: true,
  });
});

test('planner timer intervals are released when its page lifecycle ends', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSet = window.setInterval.bind(window);
    const nativeClear = window.clearInterval.bind(window);
    window.__plannerIntervals = new Map();
    window.setInterval = (callback, delay, ...args) => {
      const id = nativeSet(callback, delay, ...args);
      window.__plannerIntervals.set(id, { delay, cleared: false });
      return id;
    };
    window.clearInterval = id => {
      const record = window.__plannerIntervals.get(id);
      if (record) record.cleared = true;
      return nativeClear(id);
    };
  });
  await page.goto('/planner.html');
  await page.waitForFunction(() => window.Planner?.Store && window.Planner?.Habits);
  await page.click('#plTab-habits');
  await page.waitForSelector('.habits-grid .habit-card');
  const result = await page.evaluate(() => {
    window.Planner.Store.addHabit({
      name: 'Lifecycle timer', type: 'timer', color: '#888888',
      targetDays: [0], timesPerWeek: 1, unit: 'time', logs: [],
    });
    window.Planner.Habits.render();
    const card = Array.from(document.querySelectorAll('.habit-card')).find(node => node.textContent.includes('Lifecycle timer'));
    card.querySelector('.h-main').click();
    const timers = Array.from(window.__plannerIntervals.values()).filter(record => record.delay === 1000);
    const persisted = new Event('pagehide');
    Object.defineProperty(persisted, 'persisted', { value: true });
    window.dispatchEvent(persisted);
    const preserved = timers.every(record => !record.cleared);
    window.dispatchEvent(new Event('pagehide'));
    return { count: timers.length, preserved, allCleared: timers.every(record => record.cleared) };
  });
  expect(result).toEqual({ count: 1, preserved: true, allCleared: true });
});

test('standalone panel previews release their owned Object URLs on pagehide', async ({ page }) => {
  await page.addInitScript(() => {
    window.__panelRevoked = [];
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { window.__panelRevoked.push(url); nativeRevoke(url); };
  });
  await bootMemo(page);
  const result = await page.evaluate(() => {
    const nativeOpen = window.MemoPanel.open;
    window.MemoPanel.open = () => {};
    window.MemoAdvancedTools.launchPanel([
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]);
    const before = window.MemoAdvancedTools.__panelUrlCount();
    window.dispatchEvent(new Event('pagehide'));
    const out = {
      before,
      after: window.MemoAdvancedTools.__panelUrlCount(),
      revoked: window.__panelRevoked.length,
    };
    window.MemoPanel.open = nativeOpen;
    return out;
  });
  expect(result).toEqual({ before: 2, after: 0, revoked: 2 });
});
