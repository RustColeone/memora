// Motion layer (memo-motion.js + the CSS motion block). Animations are visual,
// so these assert the mechanics: the staggered entrance tags items correctly,
// fires on a real view switch, and fully no-ops under prefers-reduced-motion.
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoMotion && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(),
    null, { timeout: 15000 }
  );
}

test('stagger() tags items with motion-pop + a capped --motion-i', async ({ page }) => {
  await boot(page);
  const res = await page.evaluate(() => {
    const box = document.createElement('div');
    for (let i = 0; i < 20; i++) box.appendChild(document.createElement('div'));
    document.body.appendChild(box);
    window.MemoMotion.stagger(box.children, 'pop');
    return {
      firstHasClass: box.children[0].classList.contains('motion-pop'),
      i0: box.children[0].style.getPropertyValue('--motion-i'),
      i5: box.children[5].style.getPropertyValue('--motion-i'),
      iBeyondCap: box.children[18].style.getPropertyValue('--motion-i'), // index 18 > cap 12
      tagged: box.querySelectorAll('.motion-pop').length,
    };
  });
  expect(res.firstHasClass).toBe(true);
  expect(res.i0).toBe('0');
  expect(res.i5).toBe('5');
  expect(res.iBeyondCap).toBe('12'); // capped so long lists don't crawl
  expect(res.tagged).toBe(20);
});

test("stagger() 'fade' mode uses motion-fade (opacity only, for table rows)", async ({ page }) => {
  await boot(page);
  const cls = await page.evaluate(() => {
    const box = document.createElement('div');
    box.appendChild(document.createElement('div'));
    document.body.appendChild(box);
    window.MemoMotion.stagger(box.children, 'fade');
    return {
      fade: box.children[0].classList.contains('motion-fade'),
      pop: box.children[0].classList.contains('motion-pop'),
    };
  });
  expect(cls.fade).toBe(true);
  expect(cls.pop).toBe(false);
});

test('a real view switch (category change) staggers the memo feed cards', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const bundle = { version: 1, memos: [], finance: [] };
    for (let i = 0; i < 6; i++) {
      bundle.memos.push({ id: 'm' + i, description: 'd' + i, category: 'Work', tags: [], images: [], ts: Date.now() - i * 1000 });
    }
    window.MemoStateDb.importBundle(bundle, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
  });

  // Switch into the 'Work' category — a genuine view change (not a search
  // keystroke), so the entrance should fire.
  const popped = await page.evaluate(() => {
    const sel = document.getElementById('categoryFilter');
    if (![...sel.options].some(o => o.value === 'Work')) {
      const o = document.createElement('option'); o.value = 'Work'; o.textContent = 'Work'; sel.appendChild(o);
    }
    sel.value = 'Work';
    window.MemoCore.renderFeed();
    return document.querySelectorAll('#feed .card.motion-pop').length;
  });
  expect(popped).toBeGreaterThan(0);
});

test('typing in search does NOT re-stagger (same view)', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const bundle = { version: 1, memos: [], finance: [] };
    for (let i = 0; i < 4; i++) bundle.memos.push({ id: 'm' + i, description: 'hello' + i, category: 'Uncategorized', tags: [], images: [], ts: Date.now() - i * 1000 });
    window.MemoStateDb.importBundle(bundle, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    window.MemoCore.renderFeed();          // first render at __ALL__ (may stagger)
  });
  await page.waitForTimeout(1100);         // let the entrance clean up
  const popped = await page.evaluate(() => {
    // Simulate a search keystroke: same view key, so no re-stagger.
    const box = document.getElementById('searchBox');
    box.value = 'hello';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelectorAll('#feed .card.motion-pop').length;
  });
  expect(popped).toBe(0);
});

test('prefers-reduced-motion disables the staggered entrance entirely', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoMotion, null, { timeout: 15000 });
  const res = await page.evaluate(() => {
    const box = document.createElement('div');
    for (let i = 0; i < 5; i++) box.appendChild(document.createElement('div'));
    document.body.appendChild(box);
    window.MemoMotion.stagger(box.children, 'pop');
    return { reduced: window.MemoMotion.reduced(), tagged: box.querySelectorAll('.motion-pop').length };
  });
  expect(res.reduced).toBe(true);
  expect(res.tagged).toBe(0);
  await ctx.close();
});
