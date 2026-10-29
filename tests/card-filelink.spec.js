// Regression: on a touch device (pointer: coarse) the global "taller buttons for
// touch" rule (min-height:42px) used to hit the PDF file-link <button>s on a card,
// leaving ~25px of empty space below each filename — a big vertical gap between
// stacked PDFs. File links are text links, not tap targets, so they're now exempt.
const { test, expect } = require('@playwright/test');
test.use({ isMobile: true, hasTouch: true, viewport: { width: 412, height: 800 } });

test('coarse-pointer: PDF file-links stack tightly (not force-sized to 42px), real buttons stay 42px', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
  await page.evaluate(async () => {
    const memos = [{
      id: 'r1', description: 'buck-boost', category: 'Work', tags: [], images: [],
      attachments: [
        { name: 'jlcpcb-invoice-sepic-buck-boost.pdf', storedPath: 'a', url: '/a', type: 'application/pdf' },
        { name: 'jlcpcb-invoice-sepic-buck-boost-2.pdf', storedPath: 'b', url: '/b', type: 'application/pdf' },
      ], ts: 3000,
    }];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    const sel = document.getElementById('categoryFilter'); const o = document.createElement('option'); o.value = 'Work'; o.textContent = 'Work'; sel.appendChild(o); sel.value = 'Work'; window.MemoCore.renderFeed();
  });
  await page.waitForSelector('#feed .card[data-id="r1"] .filelink-pdf');
  const r = await page.evaluate(() => {
    const links = [...document.querySelectorAll('#feed .card[data-id="r1"] .filelink')];
    const realBtn = document.getElementById('filtersBtn');
    return {
      coarse: window.matchMedia('(pointer: coarse)').matches,
      linkHeights: links.map(l => Math.round(l.getBoundingClientRect().height)),
      gapPx: Math.round(links[1].getBoundingClientRect().top - links[0].getBoundingClientRect().bottom),
      realButtonMinH: realBtn ? getComputedStyle(realBtn).minHeight : 'n/a',
    };
  });
  expect(r.coarse).toBe(true);                        // the repro condition really is active
  r.linkHeights.forEach(h => expect(h).toBeLessThan(28)); // one text line, not a 42px block
  expect(r.gapPx).toBeLessThanOrEqual(6);             // stacked tight
  expect(r.realButtonMinH).toBe('42px');              // genuine tap targets keep the touch size
});
