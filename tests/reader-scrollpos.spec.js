// Scroll-mode "flat desk" behaviour: swiping between documents keeps each
// document at the exact vertical position where you left off (the neighbours
// stay fully rendered; each book stays where it was). The reader transplants the
// live strip into a canvas cell on commit, so the scrollTop survives verbatim.
const { test, expect } = require('@playwright/test');
const MK = `(w,h,c)=>{const cv=document.createElement('canvas');cv.width=w;cv.height=h;const g=cv.getContext('2d');g.fillStyle=c;g.fillRect(0,0,w,h);g.fillStyle='#fff';g.font='bold 120px sans-serif';g.textAlign='center';g.fillText(c,w/2,h/2);return cv.toDataURL('image/png');}`;

async function seed(page) {
  await page.evaluate(async (mk) => {
    const m = eval(mk);
    const doc = (c) => [m(480, 1200, c), m(480, 1200, c), m(480, 1200, c)]; // 3 tall pages each
    const memos = [
      { id: 'A', description: 'A', category: 'Work', tags: [], images: doc('#a11'), ts: 3000 },
      { id: 'B', description: 'B', category: 'Work', tags: [], images: doc('#1a1'), ts: 2000 },
      { id: 'C', description: 'C', category: 'Work', tags: [], images: doc('#11a'), ts: 1000 },
    ];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    const sel = document.getElementById('categoryFilter'); const o = document.createElement('option'); o.value = 'Work'; o.textContent = 'Work'; sel.appendChild(o); sel.value = 'Work'; window.MemoCore.renderFeed();
  }, MK);
}
const swipe = (page, dir) => page.evaluate((dir) => {
  const sc = document.getElementById('urScroll'), r = sc.getBoundingClientRect(), y = r.top + r.height / 2;
  const pe = (t, x) => sc.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, bubbles: true, pointerType: 'touch' }));
  const from = dir < 0 ? r.left + 420 : r.left + 60, to = dir < 0 ? r.left + 40 : r.left + 440;
  pe('pointerdown', from); pe('pointermove', (from + to) / 2); pe('pointermove', to); pe('pointerup', to);
}, dir);

test('swiping to a neighbour document and back restores the exact scroll position', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoReader && window.UniversalReader && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
  await seed(page);

  // open B (middle) and scroll to 300px into page 2
  await page.evaluate(() => { const e = window.MemoCore.getState().db.entries.find(x => x.id === 'B'); window.MemoReader.open(e, 0); });
  await page.waitForFunction(() => {
    const p1 = document.querySelector('#urScroll .ur-strip img.ur-page[data-idx="1"]');
    return p1 && p1.offsetTop > 0; // pages laid out with real heights
  }, null, { timeout: 10000 });
  await page.waitForTimeout(300); // let lazy loads settle the geometry
  const target = await page.evaluate(() => {
    const sc = document.getElementById('urScroll');
    const p1 = sc.querySelector('.ur-strip img.ur-page[data-idx="1"]');
    sc.scrollTop = p1.offsetTop + 300;
    return sc.scrollTop;
  });
  await page.waitForTimeout(200); // let the scroll indicator record idx 1

  await swipe(page, -1); // → C (next)
  await page.waitForFunction(() => window.MemoReader.__state().entryId === 'C', null, { timeout: 5000 });
  expect(await page.evaluate(() => window.MemoReader.__state().idx)).toBe(0); // fresh neighbour opens at its top

  await swipe(page, 1);  // back → B
  await page.waitForFunction(() => window.MemoReader.__state().entryId === 'B', null, { timeout: 5000 });
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => ({ idx: window.MemoReader.__state().idx, scrollTop: document.getElementById('urScroll').scrollTop }));
  expect(back.idx).toBe(1);
  expect(Math.abs(back.scrollTop - target)).toBeLessThan(20); // exact reading position preserved
});
