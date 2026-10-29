// Shared context menu (long-press / right-click) + dialog ✕ close + detail ··· menu
// + the reader top-layer stacking fix. Right-click drives the same code path as the
// touch long-press (both call MemoCtx.showMenu), so it's the deterministic way to test.
const { test, expect } = require('@playwright/test');
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function seed(page, memos, categories = [], timeSplit = false) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready() && window.MemoMotion && window.MemoFilterBootstrapped && window.MemoCtx, null, { timeout: 15000 });
  await page.evaluate(async ({ memos, categories, timeSplit }) => {
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    const st = window.MemoCore.getState();
    st.db.entries = window.MemoStateDb.loadEntries('default') || [];
    st.settings.timeSplit = { enabled: timeSplit, period: 'month' };
    categories.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; document.getElementById('categoryFilter').appendChild(o); });
    window.MemoCore.renderFeed();
  }, { memos, categories, timeSplit });
}
const menuTexts = page => page.evaluate(() =>
  [...document.querySelectorAll('#ctxMenu.open .ctx-item')].map(b => b.textContent.trim()));

test('long-press/right-click an entry card opens a context menu (not select mode)', async ({ page }) => {
  await seed(page, [{ id: 'm1', description: 'loose', category: 'Uncategorized', tags: [], images: [IMG, IMG], ts: 3000 }]);
  await page.waitForSelector('#feed .card[data-id="m1"]');
  await page.click('#feed .card[data-id="m1"]', { button: 'right' });
  await page.waitForSelector('#ctxMenu.open');
  // Did NOT enter select mode directly.
  expect(await page.evaluate(() => document.body.classList.contains('select-mode'))).toBe(false);
  const texts = await menuTexts(page);
  expect(texts).toEqual(expect.arrayContaining(['Edit', 'Select', 'Copy image', 'Save to Phone', 'Share image', 'Delete']));
});

test('a long-press (pointer hold) opens the menu WITHOUT also opening detail, and dismisses on outside click', async ({ page }) => {
  await seed(page, [{ id: 'm1', description: 'loose', category: 'Uncategorized', tags: [], images: [IMG], ts: 3000 }]);
  const box = await page.locator('#feed .card[data-id="m1"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForSelector('#ctxMenu.open', { timeout: 2000 });   // menu appears after the 500ms hold
  await page.mouse.up();                                            // the release click must be swallowed…
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => document.getElementById('detailDlg').open)).toBe(false);   // …so detail did NOT open
  expect(await page.evaluate(() => document.body.classList.contains('select-mode'))).toBe(false);
  expect(await page.evaluate(() => !!document.querySelector('#ctxMenu.open'))).toBe(true);     // menu still open (not inert-dead)
  // outside click dismisses it
  await page.evaluate(() => document.body.click());
  await page.waitForFunction(() => !document.querySelector('#ctxMenu.open'), null, { timeout: 2000 });
});

test('cards suppress selection + drag so a mouse-hold long-press survives (Chrome/Edge)', async ({ page }) => {
  await seed(page, [{ id: 'm1', description: 'loose', category: 'Uncategorized', tags: [], images: [IMG], ts: 3000 }]);
  const card = page.locator('#feed .card[data-id="m1"]');
  expect(await card.evaluate(el => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect)).toBe('none');
  const dragPrevented = await card.evaluate(el => {
    const ev = new Event('dragstart', { cancelable: true, bubbles: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(dragPrevented).toBe(true);
});

test('the Select item enters the fancy select toolbar', async ({ page }) => {
  await seed(page, [{ id: 'm1', description: 'loose', category: 'Uncategorized', tags: [], images: [IMG], ts: 3000 }]);
  await page.click('#feed .card[data-id="m1"]', { button: 'right' });
  await page.waitForSelector('#ctxMenu.open');
  await page.evaluate(() => [...document.querySelectorAll('#ctxMenu.open .ctx-item')].find(b => b.textContent.trim() === 'Select').click());
  await page.waitForFunction(() => document.body.classList.contains('select-mode'));
  expect(await page.evaluate(() => document.getElementById('feed').classList.contains('selecting'))).toBe(true);
});

test('a folder context menu can rename the category', async ({ page }) => {
  await seed(page, [
    { id: 'w1', description: 'a', category: 'Work', tags: [], images: [IMG], ts: 3000 },
    { id: 'w2', description: 'b', category: 'Work', tags: [], images: [IMG], ts: 2000 },
  ], ['Work']);
  await page.waitForSelector('#feed .folder-card');
  const texts0 = await (async () => { await page.click('#feed .folder-card', { button: 'right' }); await page.waitForSelector('#ctxMenu.open'); return menuTexts(page); })();
  expect(texts0).toEqual(expect.arrayContaining(['Select folder', 'Rename folder', 'Delete folder']));
  await page.evaluate(() => [...document.querySelectorAll('#ctxMenu.open .ctx-item')].find(b => b.textContent.trim() === 'Rename folder').click());
  await page.locator('#memoConfirmDlg .memo-confirm-input').fill('Job');
  await page.locator('#memoConfirmDlg .memo-confirm-ok').click();
  await page.waitForFunction(() => {
    const es = window.MemoCore.getState().db.entries;
    return es.filter(e => e.category === 'Job').length === 2 && !es.some(e => e.category === 'Work');
  }, null, { timeout: 4000 });
});

test('every dialog gets a top-right ✕ that closes it', async ({ page }) => {
  await seed(page, [{ id: 'm1', description: 'x', category: 'Uncategorized', tags: [], images: [IMG], ts: 3000 }]);
  await page.click('#feed .card[data-id="m1"]');   // open detail
  await page.waitForFunction(() => document.getElementById('detailDlg').open === true);
  expect(await page.evaluate(() => !!document.querySelector('#detailDlg .modal header .modal-close'))).toBe(true);
  await page.click('#detailDlg .modal-close');
  await page.waitForFunction(() => document.getElementById('detailDlg').open === false);
});

test('the detail ··· overflow menu lists Combine / GIF for a multi-image entry', async ({ page }) => {
  await seed(page, [{ id: 'm1', description: 'x', category: 'Uncategorized', tags: [], images: [IMG, IMG], ts: 3000 }]);
  await page.click('#feed .card[data-id="m1"]');
  await page.waitForFunction(() => document.getElementById('detailDlg').open === true);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('detailMenuBtn')).display !== 'none')).toBe(true);
  await page.click('#detailMenuBtn');
  await page.waitForSelector('#detailMenuPopup.open');
  const items = await page.evaluate(() => [...document.querySelectorAll('#detailMenuPopup.open .modal-menu-item')].map(b => b.textContent.trim()));
  expect(items.join(' ')).toMatch(/Combine to panel/);
  expect(items.join(' ')).toMatch(/Create GIF/);
});

test('the reader opens above the detail modal and stays interactive (not inert)', async ({ page }) => {
  await seed(page, [{ id: 'm1', description: 'x', category: 'Uncategorized', tags: [], images: [IMG, IMG], ts: 3000 }]);
  await page.click('#feed .card[data-id="m1"]');
  await page.waitForFunction(() => document.getElementById('detailDlg').open === true);
  await page.evaluate(() => {
    const e = window.MemoCore.getState().db.entries.find(x => x.id === 'm1');
    window.MemoReader.open(e, 0);
  });
  // The reader is the ACTIVE top-layer modal (a <dialog> shown with showModal)…
  await page.waitForFunction(() => {
    const r = document.getElementById('urDlg');
    return r && r.open === true;
  }, null, { timeout: 4000 });
  expect(await page.evaluate(() => document.getElementById('detailDlg').open)).toBe(true);   // detail underneath, restored on close
  // …and its buttons are interactive — a tap reveals the chrome (the reader opens
  // immersive), then clicking Close (would fail if the reader were inert behind
  // the detail modal) closes the reader.
  await page.click('#urScroll');
  await page.waitForFunction(() => document.getElementById('urDlg').classList.contains('bars-shown'), null, { timeout: 4000 });
  await page.click('#urCloseBtn');
  await page.waitForFunction(() => document.getElementById('urDlg').open === false, null, { timeout: 4000 });
});
