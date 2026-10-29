// Cross-entry navigation — the reader can move between documents (entries) in
// the feed's filtered order. Scroll mode eagerly builds a prev|current|next
// canvas; paged modes commit to the neighbour only at the first / last page.
const { test, expect } = require('@playwright/test');

// three distinct 1x1 PNGs so we can tell entries apart by their src
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GRN = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwAEhgGAWq2xkgAAAABJRU5ErkJggg==';
const BLU = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgYPhfDwAChwGA0EAAAAAASUVORK5CYII=';

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoReader && window.UniversalReader && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
}
async function seed3(page) {
  await page.evaluate(async ({ red, grn, blu }) => {
    const memos = [
      { id: 'e1', description: 'First', category: 'Work', tags: [], images: [red, red], ts: 3000 },
      { id: 'e2', description: 'Second', category: 'Work', tags: [], images: [grn, grn], ts: 2000 },
      { id: 'e3', description: 'Third', category: 'Work', tags: [], images: [blu, blu], ts: 1000 },
    ];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    const sel = document.getElementById('categoryFilter');
    if (![...sel.options].some(o => o.value === 'Work')) { const o = document.createElement('option'); o.value = 'Work'; o.textContent = 'Work'; sel.appendChild(o); }
    sel.value = 'Work'; window.MemoCore.renderFeed();
  }, { red: RED, grn: GRN, blu: BLU });
}
const openMid = (page) => page.evaluate(() => { const e = window.MemoCore.getState().db.entries.find(x => x.id === 'e2'); window.MemoReader.open(e, 0); });
const toPaged = async (page) => {
  await page.evaluate(() => document.querySelector('#urModes [data-mode="ltr"]').click());
  await page.waitForFunction(() => !!document.querySelector('#urScroll.ur-paged .ur-cell[data-pos="center"]'), null, { timeout: 5000 });
};
const swipeFwd = (page) => page.evaluate(() => {
  const sc = document.getElementById('urScroll'), r = sc.getBoundingClientRect(), y = r.top + r.height / 2;
  const pe = (t, x) => sc.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, bubbles: true, pointerType: 'touch' }));
  pe('pointerdown', r.left + 420); pe('pointermove', r.left + 300); pe('pointermove', r.left + 140); pe('pointermove', r.left + 40); pe('pointerup', r.left + 40);
});

test('scroll mode builds a prev|current|next document canvas with the neighbours loaded', async ({ page }) => {
  await boot(page); await seed3(page); await openMid(page);
  // scroll is the default mode → the cross-entry canvas mounts on render;
  // each neighbour cell eagerly seeds its visible page's src
  await page.waitForFunction(() => {
    const cells = document.querySelectorAll('#urDlg .ur-canvas-cell');
    if (cells.length !== 2) return false;
    const src = c => { const im = c.querySelector('img.ur-page[data-idx="0"]'); return im && im.src; };
    return !!(src(cells[0]) && src(cells[1]));
  }, null, { timeout: 5000 });
  const r = await page.evaluate(() => {
    const cells = document.querySelectorAll('#urDlg .ur-canvas-cell');
    const firstImg = c => { const im = c.querySelector('img.ur-page[data-idx="0"]'); return im ? im.src.slice(-16) : null; };
    return { count: cells.length, prev: firstImg(cells[0]), next: firstImg(cells[1]) };
  });
  const tail = s => s.slice(-16);
  expect(r.count).toBe(2);
  expect(r.prev).toBe(tail(RED)); // e1 (red), the newer neighbour above e2
  expect(r.next).toBe(tail(BLU)); // e3 (blue), the older neighbour below e2
});

test('paged mode: swiping forward past the LAST page switches to the next document', async ({ page }) => {
  await boot(page); await seed3(page); await openMid(page);
  await page.waitForFunction(() => window.MemoReader.__state().opened, null, { timeout: 10000 });
  await toPaged(page);
  await page.evaluate(() => window.MemoReader.goTo(1)); // last page of e2
  await page.waitForFunction(() => window.MemoReader.__state().idx === 1, null, { timeout: 5000 });
  await page.waitForTimeout(150);
  await swipeFwd(page);
  await page.waitForFunction(() => window.MemoReader.__state().entryId === 'e3', null, { timeout: 5000 });
  const s = await page.evaluate(() => window.MemoReader.__state());
  expect(s.entryId).toBe('e3');
  expect(s.idx).toBe(0); // lands on the first page of the next document
  expect(await page.evaluate(() => window.MemoCore.getActiveEntryFilter())).toBe('e3');
  await page.evaluate(() => window.MemoReader.close());
  await page.waitForFunction(() => window.MemoCore.getActiveEntryFilter() === null);
});

test('paged mode: a mid-document swipe turns the page, not the document', async ({ page }) => {
  await boot(page); await seed3(page); await openMid(page);
  await page.waitForFunction(() => window.MemoReader.__state().opened, null, { timeout: 10000 });
  await toPaged(page);
  await page.evaluate(() => window.MemoReader.goTo(0)); // first page of e2 (2 pages)
  await page.waitForTimeout(150);
  await swipeFwd(page);
  await page.waitForFunction(() => window.MemoReader.__state().idx === 1, null, { timeout: 5000 });
  const s = await page.evaluate(() => window.MemoReader.__state());
  expect(s.entryId).toBe('e2'); // same document
  expect(s.idx).toBe(1);        // just advanced a page
});

test('position memory: leaving a document and returning restores the page', async ({ page }) => {
  await boot(page); await seed3(page);
  // paged mode keeps idx authoritative (scroll mode would recompute from geometry)
  await openMid(page);
  await page.waitForFunction(() => window.MemoReader.__state().opened, null, { timeout: 10000 });
  await toPaged(page);
  await page.evaluate(() => window.MemoReader.goTo(1)); // e2, page 2
  await page.waitForFunction(() => window.MemoReader.__state().idx === 1, null, { timeout: 5000 });
  await page.evaluate(() => document.getElementById('urCloseBtn').click());
  await page.waitForFunction(() => !window.MemoReader.__state().opened, null, { timeout: 5000 });
  await page.evaluate(() => { const e = window.MemoCore.getState().db.entries.find(x => x.id === 'e2'); window.MemoReader.open(e, 0); }); // reopen asking for page 1…
  await page.waitForFunction(() => window.MemoReader.__state().opened && window.MemoReader.__state().idx === 1, null, { timeout: 5000 });
  const s = await page.evaluate(() => window.MemoReader.__state());
  expect(s.idx).toBe(1); // …but the saved page 2 wins
});
