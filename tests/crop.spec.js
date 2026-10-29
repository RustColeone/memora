// Crop & Share (memo-crop.js) + reader page-actions. Crop the current reader
// page → Save/Copy/Share; also "Copy page" copies the whole page. Copy-to-
// clipboard is asserted by capturing the ClipboardItem (image/png) payload.
// The reader's page menu is host-supplied: MemoReader hands UniversalReader a
// pageMenu array; the ··· button (#urActionsBtn) renders it as .ur-menu-btn
// rows, so items are addressed by label, not by id.
const { test, expect } = require('@playwright/test');

const MK = `(w,h,c)=>{const cv=document.createElement('canvas');cv.width=w;cv.height=h;const g=cv.getContext('2d');g.fillStyle=c;g.fillRect(0,0,w,h);return cv.toDataURL('image/png');}`;

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoReader && window.UniversalReader && window.MemoCrop && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
}
async function seedOne(page, w, h) {
  await page.evaluate(async ({ mk, w, h }) => {
    const m = eval(mk);
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos: [{ id: 'c1', description: 'Doc / page', category: 'Work', tags: [], images: [m(w, h, '#3b82f6')], ts: Date.now() }] }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
  }, { mk: MK, w, h });
}
// Open the reader on the seeded entry and wait until its page model is live
// (the menu's getBlob needs a rendered page).
async function openReader(page) {
  await page.evaluate(() => { window.MemoReader.open(window.MemoCore.getState().db.entries[0], 0); });
  await page.waitForFunction(() => window.MemoReader.__state().opened && window.MemoReader.__state().pageCount > 0, null, { timeout: 10000 });
}
// Click a page-menu action by its visible label via the top-bar ··· button.
const menuClick = (page, label) => page.evaluate((label) => {
  document.getElementById('urActionsBtn').click();
  const btn = [...document.querySelectorAll('#urMenuItems .ur-menu-btn')].find(b => b.textContent.includes(label));
  if (!btn) throw new Error('menu item not found: ' + label);
  btn.click();
}, label);

test('Crop & share opens from the reader page menu with the current page', async ({ page }) => {
  await boot(page);
  await seedOne(page, 300, 200);
  await openReader(page);
  await menuClick(page, 'Crop');
  await page.waitForFunction(() => document.getElementById('cropDlg').open && document.getElementById('cropCanvas').width > 0);
  const c = await page.evaluate(() => ({ w: document.getElementById('cropCanvas').width, h: document.getElementById('cropCanvas').height }));
  expect(c).toEqual({ w: 300, h: 200 }); // 300×200 fits 1:1
});

test('crop: drag a selection → Copy puts exactly that region (PNG) on the clipboard', async ({ page }) => {
  await boot(page);
  await seedOne(page, 300, 200);
  await openReader(page);
  await menuClick(page, 'Crop');
  await page.waitForFunction(() => document.getElementById('cropDlg').open && document.getElementById('cropCanvas').width > 0);
  const dims = await page.evaluate(async () => {
    let captured = null;
    navigator.clipboard.write = async (items) => { captured = await items[0].getType('image/png'); };
    const c = document.getElementById('cropCanvas'), r = c.getBoundingClientRect();
    const pe = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
    pe('pointerdown', r.left + 50, r.top + 40);
    pe('pointermove', r.left + 150, r.top + 120);
    pe('pointerup', r.left + 150, r.top + 120);
    document.getElementById('cropCopyBtn').click();
    for (let i = 0; i < 60 && !captured; i++) await new Promise(res => setTimeout(res, 50));
    if (!captured) return null;
    const bmp = await createImageBitmap(captured);
    return { type: captured.type, w: bmp.width, h: bmp.height };
  });
  expect(dims).not.toBeNull();
  expect(dims.type).toBe('image/png');
  expect(dims.w).toBe(100);   // 150-50
  expect(dims.h).toBe(80);    // 120-40
});

test('reader "Copy page" copies the whole current page to the clipboard', async ({ page }) => {
  await boot(page);
  await seedOne(page, 300, 200);
  await page.evaluate(() => {
    window.__captured = null;
    navigator.clipboard.write = async (items) => { window.__captured = await items[0].getType('image/png'); };
  });
  await openReader(page);
  await menuClick(page, 'Copy page');
  await page.waitForFunction(() => !!window.__captured, null, { timeout: 5000 });
  const dims = await page.evaluate(async () => {
    const bmp = await createImageBitmap(window.__captured);
    return { w: bmp.width, h: bmp.height };
  });
  expect(dims).toEqual({ w: 300, h: 200 }); // whole page
});

test('crop Apply zooms into the selection; Undo reverts', async ({ page }) => {
  await boot(page);
  await seedOne(page, 300, 200);
  await openReader(page);
  await menuClick(page, 'Crop');
  await page.waitForFunction(() => document.getElementById('cropDlg').open && document.getElementById('cropCanvas').width > 0);
  const res = await page.evaluate(() => {
    const undoBtn = document.getElementById('cropUndoBtn');
    const before = undoBtn.disabled;
    const c = document.getElementById('cropCanvas'), r = c.getBoundingClientRect();
    const pe = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
    pe('pointerdown', r.left + 60, r.top + 50); pe('pointermove', r.left + 200, r.top + 150); pe('pointerup', r.left + 200, r.top + 150);
    document.getElementById('cropApplyBtn').click();
    const afterApply = { undoEnabled: !undoBtn.disabled, w: c.width, h: c.height };
    document.getElementById('cropUndoBtn').click();
    return { before, afterApply, afterUndoDisabled: undoBtn.disabled, wFull: c.width };
  });
  expect(res.before).toBe(true);              // nothing to undo at first
  expect(res.afterApply.undoEnabled).toBe(true);
  expect(res.afterApply.w).toBeLessThan(300); // zoomed into the ~140×100 selection
  expect(res.afterUndoDisabled).toBe(true);   // back to the full image
  expect(res.wFull).toBe(300);
});
