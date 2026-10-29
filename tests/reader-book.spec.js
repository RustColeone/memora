// Book reader — MemoReader adapter over the shared UniversalReader (#urDlg):
// images, scroll/LTR/RTL modes, navigation, and that it replaced the lightbox.
const { test, expect } = require('@playwright/test');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoReader && window.UniversalReader && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
}
async function seed(page, images = [PNG, PNG, PNG]) {
  await page.evaluate(async (sources) => {
    const memos = [{ id: 'r1', description: 'Three page memo', category: 'Work', tags: [], images: sources, ts: Date.now() }];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    const sel = document.getElementById('categoryFilter');
    if (![...sel.options].some(o => o.value === 'Work')) { const o = document.createElement('option'); o.value = 'Work'; o.textContent = 'Work'; sel.appendChild(o); }
    sel.value = 'Work'; window.MemoCore.renderFeed();
  }, images);
}
const openR1 = (page, idx) => page.evaluate((i) => {
  const e = window.MemoCore.getState().db.entries.find(x => x.id === 'r1');
  window.MemoReader.open(e, i);
}, idx);

test('reader opens with the entry pages, progress reflects count', async ({ page }) => {
  const imageBody = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="1200"><rect width="200" height="1200" fill="#777"/></svg>');
  await page.route('**/reader-page-*.svg', async route => {
    if (route.request().url().endsWith('/reader-page-0.svg')) {
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    await route.fulfill({ contentType: 'image/svg+xml', body: imageBody });
  });
  await boot(page);
  await seed(page, ['/reader-page-0.svg', '/reader-page-1.svg', '/reader-page-2.svg']);
  await openR1(page, 1);
  // the dialog mounts on first open; a requested page beats the (empty) saved position
  await page.waitForFunction(() => {
    const s = window.MemoReader.__state();
    const progress = document.getElementById('urProgress');
    return s.opened && s.pageCount === 3 && s.idx === 1 && progress && progress.value === '2';
  }, null, { timeout: 10000 });
  // Lazy image layout above the requested page must not pull the continuous
  // reader back to page one after it has briefly reported the requested page.
  await page.waitForFunction(() => {
    const pages = [...document.querySelectorAll('#urScroll img.ur-page')];
    return pages.length === 3 && pages.every(img => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 10000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const r = await page.evaluate(() => ({
    dlgOpen: document.getElementById('urDlg').open,
    pages: document.querySelectorAll('#urScroll img.ur-page').length,
    progressMax: document.getElementById('urProgress').max,
    progressVal: document.getElementById('urProgress').value,
    entryId: window.MemoReader.__state().entryId,
    idx: window.MemoReader.__state().idx,
    requestedVisible: (() => {
      const viewport = document.getElementById('urScroll').getBoundingClientRect();
      const requested = document.querySelector('#urScroll img.ur-page[data-idx="1"]');
      if (!requested) return false;
      const rect = requested.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    })(),
  }));
  expect(r.dlgOpen).toBe(true);
  expect(r.pages).toBe(3);
  expect(r.progressMax).toBe('3');
  expect(r.progressVal).toBe('2');
  expect(r.idx).toBe(1);
  expect(r.requestedVisible).toBe(true);
  expect(r.entryId).toBe('r1');
});

test('initial-page anchoring clamps and yields to explicit navigation', async ({ page }) => {
  const imageBody = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="1200"><rect width="200" height="1200" fill="#777"/></svg>');
  let releaseFirstPage;
  const firstPageGate = new Promise(resolve => { releaseFirstPage = resolve; });
  await page.route('**/reader-clamp-*.svg', async route => {
    if (route.request().url().endsWith('/reader-clamp-0.svg')) {
      await firstPageGate;
    }
    await route.fulfill({ contentType: 'image/svg+xml', body: imageBody });
  });
  await boot(page);
  await seed(page, ['/reader-clamp-0.svg', '/reader-clamp-1.svg', '/reader-clamp-2.svg']);
  await openR1(page, 99);
  await page.waitForFunction(() => window.MemoReader.__state().idx === 2, null, { timeout: 10000 });
  await page.evaluate(() => {
    const progress = document.getElementById('urProgress');
    progress.value = '1';
    progress.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.MemoReader.__state().idx === 0, null, { timeout: 10000 });
  releaseFirstPage();
  await page.waitForFunction(() => {
    const pages = [...document.querySelectorAll('#urScroll img.ur-page')];
    return pages.length === 3 && pages.every(img => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 10000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => ({
    idx: window.MemoReader.__state().idx,
    progress: document.getElementById('urProgress').value,
  }))).toEqual({ idx: 0, progress: '1' });
});

test('the lightbox is retired: card thumbnails open the reader, not the lightbox', async ({ page }) => {
  await boot(page);
  await seed(page);
  const r = await page.evaluate(() => ({
    noLightboxEl: document.getElementById('lightbox') === null,
    stubOnly: typeof window.openLightbox === 'function' && /plug in/.test(window.openLightbox.toString()), // only the no-op stub remains
  }));
  expect(r.noLightboxEl).toBe(true);   // lightbox markup no longer on the page
  expect(r.stubOnly).toBe(true);       // real lightbox module not loaded
  // Click a card thumbnail → reader opens.
  await page.waitForSelector('#feed .card[data-id="r1"] .thumbs img');
  await page.click('#feed .card[data-id="r1"] .thumbs img');
  await page.waitForFunction(() => window.MemoReader.__state().opened, null, { timeout: 10000 });
  expect(await page.evaluate(() => document.getElementById('urDlg').open)).toBe(true);
  expect(await page.evaluate(() => window.MemoCore.getActiveEntryFilter())).toBe('r1');

  // Privacy and generic dialog-stack teardown can close the native reader
  // dialog without going through MemoReader.close(); location cleanup still
  // has to run in that path.
  await page.evaluate(() => document.getElementById('urDlg').close());
  await page.waitForFunction(() => window.MemoCore.getActiveEntryFilter() === null);
  expect(await page.evaluate(() => window.MemoReader.__state().opened)).toBe(false);
});

test('closing a reader stacked over detail restores detail context until detail closes', async ({ page }) => {
  await boot(page);
  await seed(page);
  await page.evaluate(() => window.MemoVariant.openDetail('r1'));
  await expect(page.locator('#detailDlg')).toBeVisible();
  expect(await page.evaluate(() => window.MemoCore.getActiveEntryFilter())).toBe('r1');

  await page.locator('#detailThumbs img').first().click();
  await page.waitForFunction(() => window.MemoReader.__state().opened, null, { timeout: 10000 });
  await page.evaluate(() => window.MemoReader.close());
  await page.waitForFunction(() => !window.MemoReader.__state().opened, null, { timeout: 5000 });
  expect(await page.evaluate(() => ({
    detailOpen: document.getElementById('detailDlg').open,
    context: window.MemoCore.getActiveEntryFilter(),
  }))).toEqual({ detailOpen: true, context: 'r1' });

  await page.evaluate(() => document.getElementById('detailDlg').close());
  await page.waitForFunction(() => window.MemoCore.getActiveEntryFilter() === null);
});

test('reading modes switch, persist, and re-render (scroll ↔ paged)', async ({ page }) => {
  await boot(page);
  await seed(page);
  await openR1(page, 0);
  // default scroll strip stacks all pages
  await page.waitForFunction(() => document.querySelectorAll('#urScroll.ur-continuous .ur-strip img.ur-page').length === 3, null, { timeout: 10000 });
  await page.evaluate(() => document.querySelector('#urModes [data-mode="ltr"]').click());
  // paged mode builds a 3-cell carousel; the centre cell holds the current page
  await page.waitForFunction(() => !!document.querySelector('#urScroll.ur-paged .ur-cell[data-pos="center"] img.ur-page'), null, { timeout: 10000 });
  const res = await page.evaluate(() => ({
    stored: localStorage.getItem('memoReaderMode'),
    active: document.querySelector('#urModes .ur-mode.active').getAttribute('data-mode'),
    mode: window.MemoReader.__state().mode,
  }));
  expect(res.stored).toBe('ltr');   // modechange persisted by the adapter
  expect(res.active).toBe('ltr');
  expect(res.mode).toBe('ltr');
});

test('navigation: progress slider + arrow keys (reading order in LTR and RTL)', async ({ page }) => {
  await boot(page);
  await seed(page);
  await openR1(page, 0);
  await page.waitForFunction(() => window.MemoReader.__state().opened && window.MemoReader.__state().pageCount === 3, null, { timeout: 10000 });
  await page.evaluate(() => document.querySelector('#urModes [data-mode="ltr"]').click());
  await page.waitForFunction(() => !!document.querySelector('#urScroll.ur-paged'), null, { timeout: 10000 });
  // progress slider jump → page 3 (0-indexed 2)
  await page.evaluate(() => {
    const pr = document.getElementById('urProgress');
    pr.value = '3'; pr.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.MemoReader.__state().idx === 2, null, { timeout: 5000 });
  // ArrowLeft in LTR → previous page
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => window.MemoReader.__state().idx === 1, null, { timeout: 5000 });
  // RTL mirrors the track, arrows keep reading order: ArrowRight → next page.
  // (A mode re-render restarts at page 1, so navigate back to page 2 first.)
  await page.evaluate(() => document.querySelector('#urModes [data-mode="rtl"]').click());
  await page.waitForFunction(() => window.MemoReader.__state().mode === 'rtl', null, { timeout: 5000 });
  await page.waitForTimeout(200); // let the rtl re-render settle
  await page.evaluate(() => window.MemoReader.goTo(1));
  await page.waitForFunction(() => window.MemoReader.__state().idx === 1, null, { timeout: 5000 });
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.MemoReader.__state().idx === 2, null, { timeout: 5000 });
  expect(await page.evaluate(() => window.MemoReader.__state().idx)).toBe(2);
});

test('close tears the reader down', async ({ page }) => {
  await boot(page);
  await seed(page);
  await openR1(page, 0);
  await page.waitForFunction(() => window.MemoReader.__state().opened, null, { timeout: 10000 });
  await page.evaluate(() => window.MemoReader.close());
  const r = await page.evaluate(() => ({
    opened: window.MemoReader.__state().opened,
    dlgOpen: document.getElementById('urDlg').open,
    stripEmpty: document.getElementById('urScroll').children.length === 0,
  }));
  expect(r.opened).toBe(false);
  expect(r.dlgOpen).toBe(false);
  expect(r.stripEmpty).toBe(true);
});
