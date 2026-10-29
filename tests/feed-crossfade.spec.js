// Category navigation motion: physical folder tiles commit synchronously inside
// the circular reveal; category-picker/filter changes without a tile origin keep
// the feed-scoped View Transition at the categoryFilter change chokepoint.
const { test, expect } = require('@playwright/test');
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function boot(page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });   // headless defaults to reduce
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready() && window.MemoMotion && window.MemoFilterBootstrapped, null, { timeout: 15000 });
  await page.evaluate(async (img) => {
    const memos = [
      { id: 'a', description: 'A', category: 'Work', tags: [], images: [img], ts: 3000 },
      { id: 'b', description: 'B', category: 'Home', tags: [], images: [img], ts: 2000 },
    ];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    ['Work', 'Home'].forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; document.getElementById('categoryFilter').appendChild(o); });
    window.MemoCore.renderFeed();
  }, IMG);
}

test('entering a physical folder commits promptly for its circular reveal', async ({ page }) => {
  await boot(page);
  await page.waitForSelector('#feed .folder-card');
  await page.evaluate(() => {
    window.__feedCommitFrames = 0;
    const countFrames = () => {
      if (document.querySelector('#feed .card[data-id="a"]')) return;
      window.__feedCommitFrames += 1;
      requestAnimationFrame(countFrames);
    };
    requestAnimationFrame(countFrames);
    document.querySelector('#feed .folder-card').click();
  });
  await page.waitForSelector('#feed .card[data-id="a"]');
  const result = await page.evaluate(() => {
    const feed = document.getElementById('feed');
    return {
      category: document.getElementById('categoryFilter').value,
      commitFrames: window.__feedCommitFrames,
      leaving: feed.classList.contains('feed-leaving'),
      transitionName: getComputedStyle(feed).viewTransitionName,
    };
  });
  expect(result.category).toBe('Work');
  expect(result.commitFrames).toBeLessThanOrEqual(3);
  expect(result.leaving).toBe(false);
  expect(result.transitionName).toBe('memo-feed');
});

test('reduced-motion renders synchronously with no lingering fade class', async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForSelector('#feed .folder-card');
  await page.evaluate(() => document.querySelector('#feed .folder-card').click());
  // no fade under reduced-motion — renders straight away
  expect(await page.evaluate(() => document.getElementById('feed').classList.contains('feed-leaving'))).toBe(false);
  await page.waitForSelector('#feed .card[data-id="a"]');
});
