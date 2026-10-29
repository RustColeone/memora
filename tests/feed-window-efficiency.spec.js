const { test, expect } = require('@playwright/test');

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function seed(page, memos, { categories = [], category = '__ALL__' } = {}) {
  // Keep infinite-scroll deterministic. MemoLazy and the feed sentinel still get
  // real observer instances, but a test explicitly chooses which target intersects.
  await page.addInitScript(() => {
    const instances = [];
    class ControlledIntersectionObserver {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = new Set();
        instances.push(this);
      }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
      takeRecords() { return []; }
    }
    window.IntersectionObserver = ControlledIntersectionObserver;
    window.__triggerIntersection = (selector) => {
      let fired = 0;
      for (const observer of instances.slice()) {
        for (const target of Array.from(observer.targets)) {
          if (!target.matches(selector)) continue;
          observer.callback([{ target, isIntersecting: true, intersectionRatio: 1 }], observer);
          fired += 1;
        }
      }
      return fired;
    };
  });

  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoCore && window.MemoStateDb?.ready() && window.MemoLazy && window.MemoFilterBootstrapped,
    null,
    { timeout: 15000 },
  );
  await page.evaluate(async ({ memos, categories, category }) => {
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    const state = window.MemoCore.getState();
    state.db.entries = window.MemoStateDb.loadEntries('default') || [];
    state.settings.timeSplit = { enabled: false, period: 'month' };
    const select = document.getElementById('categoryFilter');
    categories.forEach(value => {
      if (select.querySelector(`option[value="${value}"]`)) return;
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
    select.value = category;
    window.MemoVariant.renderFeed();
  }, { memos, categories, category });
  await page.waitForFunction(() => document.querySelectorAll('#feed .card[data-id]').length === 60);
}

function uncatMemos(count, decorate = () => ({})) {
  return Array.from({ length: count }, (_, i) => ({
    id: `w${i}`,
    description: `memo ${i}`,
    category: 'Uncategorized',
    tags: [],
    images: [IMG],
    ts: 1000 + i,
    ...decorate(i),
  }));
}

test('the next feed window appends only new cards and preserves existing DOM identity', async ({ page }) => {
  await seed(page, uncatMemos(125));

  const result = await page.evaluate(() => {
    const feed = document.getElementById('feed');
    const first = feed.querySelector('.card[data-id="w124"]');
    const sixtieth = feed.querySelector('.card[data-id="w65"]');
    let releaseCalls = 0;
    const nativeRelease = window.MemoLazy.release;
    const nativeObserve = window.MemoLazy.observe;
    const observedIds = [];
    window.MemoLazy.release = function trackedRelease(root) {
      releaseCalls += 1;
      return nativeRelease.call(this, root);
    };
    window.MemoLazy.observe = function trackedObserve(img) {
      observedIds.push(img.closest('.card[data-id]')?.dataset.id || null);
      return nativeObserve.call(this, img);
    };

    const mutations = new MutationObserver(() => {});
    mutations.observe(feed, { childList: true });
    const fired = window.__triggerIntersection('.feed-window-sentinel');
    const records = mutations.takeRecords();
    mutations.disconnect();

    const addedIds = records.flatMap(record => Array.from(record.addedNodes))
      .filter(node => node.nodeType === 1 && node.matches('.card[data-id]'))
      .map(node => node.dataset.id);
    const removedCardIds = records.flatMap(record => Array.from(record.removedNodes))
      .filter(node => node.nodeType === 1 && node.matches('.card[data-id]'))
      .map(node => node.dataset.id);
    const out = {
      fired,
      count: feed.querySelectorAll('.card[data-id]').length,
      hasMore: !!feed.querySelector('.feed-window-sentinel'),
      firstPreserved: feed.querySelector('.card[data-id="w124"]') === first,
      sixtiethPreserved: feed.querySelector('.card[data-id="w65"]') === sixtieth,
      addedIds,
      removedCardIds,
      releaseCalls,
      observedIds: observedIds.filter(Boolean),
    };
    window.MemoLazy.release = nativeRelease;
    window.MemoLazy.observe = nativeObserve;
    return out;
  });

  expect(result.fired).toBe(1);
  expect(result.count).toBe(120);
  expect(result.hasMore).toBe(true);
  expect(result.firstPreserved).toBe(true);
  expect(result.sixtiethPreserved).toBe(true);
  expect(result.removedCardIds).toEqual([]);
  expect(result.addedIds).toEqual(Array.from({ length: 60 }, (_, i) => `w${64 - i}`));
  expect(result.releaseCalls).toBe(0);
  expect(result.observedIds).toEqual(result.addedIds);
});

test('search and advanced-filter transitions reset the window, retain matching cards, and release removed lazy targets', async ({ page }) => {
  await seed(page, uncatMemos(125, i => ({
    description: i >= 55 ? `needle memo ${i}` : `memo ${i}`,
    tags: i >= 55 ? ['focus'] : [],
  })));
  await page.evaluate(() => window.__triggerIntersection('.feed-window-sentinel'));
  await page.waitForFunction(() => document.querySelectorAll('#feed .card[data-id]').length === 120);

  const search = await page.evaluate(async () => {
    const feed = document.getElementById('feed');
    const oldFirst = feed.querySelector('.card[data-id="w124"]');
    const nativeRelease = window.MemoLazy.release;
    let releaseCalls = 0;
    let releasedWhileOwned = false;
    window.MemoLazy.release = function trackedRelease(root) {
      if (root.matches?.('.card[data-id]')) releaseCalls += 1;
      releasedWhileOwned ||= root === feed || root === oldFirst;
      return nativeRelease.call(this, root);
    };
    const box = document.getElementById('searchBox');
    box.value = 'needle';
    box.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'needle' }));
    await new Promise(resolve => setTimeout(resolve, 180));
    const out = {
      count: feed.querySelectorAll('.card[data-id]').length,
      firstReplaced: feed.querySelector('.card[data-id="w124"]') !== oldFirst,
      oldDetached: !oldFirst.isConnected,
      releaseCalls,
      releasedWhileOwned,
    };
    window.MemoLazy.release = nativeRelease;
    return out;
  });
  expect(search).toEqual({
    count: 60,
    firstReplaced: false,
    oldDetached: false,
    releaseCalls: 60,
    releasedWhileOwned: false,
  });

  // Return to the unsearched feed, expand it again, then apply the tag filter.
  await page.evaluate(async () => {
    const box = document.getElementById('searchBox');
    box.value = '';
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 180));
    window.__triggerIntersection('.feed-window-sentinel');
  });
  await page.waitForFunction(() => document.querySelectorAll('#feed .card[data-id]').length === 120);

  const filtered = await page.evaluate(() => {
    const feed = document.getElementById('feed');
    const oldFirst = feed.querySelector('.card[data-id="w124"]');
    const nativeRelease = window.MemoLazy.release;
    let releaseCalls = 0;
    let releasedWhileOwned = false;
    window.MemoLazy.release = function trackedRelease(root) {
      if (root.matches?.('.card[data-id]')) releaseCalls += 1;
      releasedWhileOwned ||= root === feed || root === oldFirst;
      return nativeRelease.call(this, root);
    };
    window.MemoCore.getState().activeFilters.tags.add('focus');
    window.MemoVariant.renderFeed();
    const out = {
      count: feed.querySelectorAll('.card[data-id]').length,
      firstReplaced: feed.querySelector('.card[data-id="w124"]') !== oldFirst,
      oldDetached: !oldFirst.isConnected,
      releaseCalls,
      releasedWhileOwned,
    };
    window.MemoLazy.release = nativeRelease;
    return out;
  });
  expect(filtered).toEqual({
    count: 60,
    firstReplaced: false,
    oldDetached: false,
    releaseCalls: 60,
    releasedWhileOwned: false,
  });
});

test('category transitions fully replace the feed and reset an expanded window', async ({ page }) => {
  const work = Array.from({ length: 125 }, (_, i) => ({
    id: `work${i}`,
    description: `work ${i}`,
    category: 'Work',
    tags: [],
    images: [IMG],
    ts: 2000 + i,
  }));
  const home = Array.from({ length: 5 }, (_, i) => ({
    id: `home${i}`,
    description: `home ${i}`,
    category: 'Home',
    tags: [],
    images: [IMG],
    ts: 1000 + i,
  }));
  await seed(page, [...work, ...home], { categories: ['Work', 'Home'], category: 'Work' });
  await page.evaluate(() => window.__triggerIntersection('.feed-window-sentinel'));
  await page.waitForFunction(() => document.querySelectorAll('#feed .card[data-id]').length === 120);

  await page.evaluate(() => {
    const feed = document.getElementById('feed');
    window.__categoryOldCard = feed.querySelector('.card[data-id="work124"]');
    window.__categoryReleaseCount = 0;
    window.__categoryNativeRelease = window.MemoLazy.release;
    window.MemoLazy.release = function trackedRelease(root) {
      if (root.matches?.('.card[data-id]')) window.__categoryReleaseCount += 1;
      return window.__categoryNativeRelease.call(this, root);
    };
    const select = document.getElementById('categoryFilter');
    select.value = 'Home';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('#feed .card[data-id]').length === 5);
  expect(await page.evaluate(() => ({
    oldDetached: !window.__categoryOldCard.isConnected,
    releaseCalls: window.__categoryReleaseCount,
    ids: Array.from(document.querySelectorAll('#feed .card[data-id]'), card => card.dataset.id),
  }))).toEqual({
    oldDetached: true,
    releaseCalls: 120,
    ids: ['home4', 'home3', 'home2', 'home1', 'home0'],
  });

  await page.evaluate(() => {
    const select = document.getElementById('categoryFilter');
    select.value = 'Work';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('#feed .card[data-id]').length === 60);
  expect(await page.evaluate(() => window.__categoryReleaseCount)).toBe(125);
  await page.evaluate(() => { window.MemoLazy.release = window.__categoryNativeRelease; });
});
