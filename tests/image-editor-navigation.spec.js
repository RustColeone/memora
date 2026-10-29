const { test, expect } = require('@playwright/test');

async function boot(page, path = 'index.html') {
  await page.goto('/' + path);
  await page.evaluate(() => window.MemoAppReady || window.MemoCore?.start() || window.Planner?.ready);
}
async function fixture(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 80, 80); ctx.fillStyle = '#0000ff'; ctx.fillRect(80, 0, 80, 80);
    return canvas.toDataURL('image/png');
  });
}
async function openDevice(page) {
  await page.click('#hamburgerBtn'); await page.click('#mobileAdvancedToolsBtn'); await page.click('#advancedImageEditorBtn');
  await expect(page.locator('#imageEditorDlg')).toHaveAttribute('open', '');
  const url = await fixture(page);
  await page.setInputFiles('#mieFile', { name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') });
  await expect(page.locator('#mieStatus')).toContainText('160 × 80');
}

test('editor loads on demand and crops original pixels with undo, redo, and comparison', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(() => !!window.MemoImageEditorImpl)).toBe(false);
  await openDevice(page);
  await page.click('#mieRotateRight');
  await expect.poll(() => page.locator('#mieCanvas').evaluate(c => [c.width, c.height])).toEqual([80, 160]);
  await page.click('#mieOriginal');
  await expect.poll(() => page.locator('#mieCanvas').evaluate(c => [c.width, c.height])).toEqual([160, 80]);
  await page.click('#mieOriginal');
  await page.click('#mieUndo');
  await expect(page.locator('#mieSave')).toBeDisabled();
  await page.click('#mieRedo');
  await page.click('#mieCropTool');
  await page.locator('#mieCrop').focus(); await page.keyboard.press('ArrowRight');
  await page.click('#mieApply');
  await expect.poll(() => page.locator('#mieCanvas').evaluate(c => [c.width, c.height])).toEqual([64, 128]);
  await page.click('#mieUndo');
  await expect.poll(() => page.locator('#mieCanvas').evaluate(c => [c.width, c.height])).toEqual([80, 160]);
  await page.click('#mieAdjustTool');
  await page.locator('#mieSaturation').focus(); await page.keyboard.press('Home');
  await page.click('#mieApply');
  await expect.poll(() => page.locator('#mieCanvas').evaluate(c => {
    const [r,g,b] = c.getContext('2d').getImageData(10,10,1,1).data; return Math.max(r,g,b)-Math.min(r,g,b);
  })).toBeLessThanOrEqual(1);
  await page.click('#mieClose');
  await expect(page.locator('#mieLeaveDlg')).toBeVisible();
  await page.click('#mieDiscard');
  await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open', '');
  await page.evaluate(() => MemoImageEditor.open());
  await expect(page.locator('#mieEmpty')).toBeVisible();
  await expect(page.locator('#mieUndo')).toBeDisabled();
});

for (const viewport of [{width:360,height:640},{width:844,height:390}]) {
  test(`editor controls remain reachable at ${viewport.width} × ${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport); await boot(page); await openDevice(page);
    await page.click('#mieCropTool');
    for (const id of ['mieApply','mieClose','mieSave']) {
      const box = await page.locator('#' + id).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
    const box = await page.locator('#mieCanvas').boundingBox(); expect(box.width).toBeGreaterThan(90); expect(box.height).toBeGreaterThan(45);
    await page.screenshot({ path: testInfo.outputPath('editor.png') });
    await page.keyboard.press('Escape'); await expect(page.locator('#mieLeaveDlg')).toBeVisible();
    await page.click('#mieKeepEditing'); await page.click('#mieCancelTool');
    await expect(page.locator('#mieToolActions')).toBeHidden();
    await expect(page.locator('#imageEditorDlg')).toHaveAttribute('open', '');
  });
}

test('edited finance receipt returns to its existing entry and persists without changing amounts or original bytes', async ({ page }) => {
  await boot(page); await page.click('#primaryNav [data-variant="finance"]');
  await expect(page.locator('#primaryNav [data-variant="finance"]')).toHaveAttribute('aria-current','page');
  const png = await fixture(page);
  await page.evaluate(async data => {
    const blob = await (await fetch(data)).blob(); const path = 'uploads/test/original.png';
    await MemoStateDb.writeBlob(path, blob);
    const item = {id:'editor-receipt', description:'Original receipt', category:'Uncategorized', sheet:'General', purchaseDate:'2026-09-17', images:['/'+path], _storedPaths:[path], tags:['kept'], attachments:[], items:[{name:'Item',amount:1,unitPrice:40,totalPrice:40}], price:40,tax:4,total:44,ts:Date.now()};
    MemoCore.getState().db.entries = [item]; MemoStateDb.saveEntries([item], 'finance'); await MemoStateDb.flush();
    await MemoImageEditor.openEntry(item);
  }, png);
  await expect(page.locator('#mieStatus')).toContainText('160 × 80');
  await page.click('#mieRotateRight'); await page.click('#mieSave');
  await expect(page.locator('#entryDlg')).toHaveAttribute('open','');
  await expect(page.locator('#dragGrid .dragitem')).toHaveCount(2);
  await page.click('#saveBtn'); await expect(page.locator('#entryDlg')).not.toHaveAttribute('open','');
  const saved = await page.evaluate(async () => {
    await MemoCore.flushPersistence(); const entries = MemoStateDb.loadEntries('finance'); const item = entries[0];
    const original = await MemoStateDb.readBlob('uploads/test/original.png');
    const edited = await MemoStateDb.readBlob(item._storedPaths[1]);
    return {count:entries.length,id:item.id,total:Number(item.total),tax:Number(item.tax),sheet:item.sheet,images:item._storedPaths.length,original:await new Promise(resolve => {const r=new FileReader();r.onload=()=>resolve(r.result);r.readAsDataURL(original);}),bytes:edited.size};
  });
  expect(saved).toMatchObject({count:1,id:'editor-receipt',total:44,tax:4,sheet:'General',images:2,original:png});
  expect(saved.bytes).toBeGreaterThan(0);
  await page.reload(); await page.evaluate(() => MemoAppReady);
  expect(await page.evaluate(() => MemoStateDb.loadEntries('finance')[0]._storedPaths.length)).toBe(2);
});

test('library selection edits the original entry and rejects a deleted source', async ({ page }) => {
  await boot(page);
  const png = await fixture(page);
  await page.evaluate(async data => {
    const path = 'uploads/editor-library.png';
    await MemoStateDb.writeBlob(path, await (await fetch(data)).blob());
    MemoCore.getState().db.entries = [{id:'library-edit', description:'Library source', category:'Uncategorized', tags:[], images:['/'+path], _storedPaths:[path], ts:Date.now()}];
    await MemoImageEditor.open();
  }, png);
  await page.click('#mieLibrary'); await page.locator('.libpick-image[data-media-key]').click(); await page.click('#libPickDone');
  await expect(page.locator('#mieStatus')).toContainText('160 × 80');
  await page.click('#mieFlipH');
  await expect(page.locator('#mieSave')).toHaveText('Add copy to entry');
  await page.evaluate(() => { MemoCore.getState().db.entries[0].deletedAt = Date.now(); });
  await page.click('#mieSave');
  await expect(page.locator('#mieStatus')).toContainText('no longer available');
  await expect(page.locator('#entryDlg')).not.toHaveAttribute('open', '');
});

test('privacy locking while editor scripts load cancels the pending open', async ({ page }) => {
  await boot(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/memo-image-geometry.js', async route => { await gate; await route.continue(); });
  await page.evaluate(() => { window.__editorOpen = MemoImageEditor.open(); document.dispatchEvent(new Event('memo:privacy-locked')); });
  release();
  await page.evaluate(() => window.__editorOpen);
  await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
});

test('image headers reject oversized bitmaps before decoding and accept JPEG and WebP', async ({ page }) => {
  await boot(page); await page.evaluate(() => MemoImageEditor.open());
  const png = Buffer.from((await fixture(page)).split(',')[1], 'base64');
  png.writeUInt32BE(30000, 16); // Deliberately oversized IHDR; it must never reach the decoder.
  await page.evaluate(() => { window.__editorUrls = 0; const create = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { ++window.__editorUrls; return create(blob); }; });
  await page.setInputFiles('#mieFile', {name:'huge.png', mimeType:'image/png', buffer:png});
  await expect(page.locator('#mieStatus')).toContainText('24 megapixels');
  expect(await page.evaluate(() => window.__editorUrls)).toBe(0);
  for (const type of ['image/jpeg','image/webp']) {
    const data = await page.evaluate(type => { const c = document.createElement('canvas'); c.width=40; c.height=20; return c.toDataURL(type); }, type);
    await page.setInputFiles('#mieFile', {name:'small.'+type.split('/')[1], mimeType:type, buffer:Buffer.from(data.split(',')[1],'base64')});
    await expect(page.locator('#mieStatus')).toContainText('40 × 20');
  }
});

test('privacy lock cancels the editor and revokes its source without deleting the original', async ({ page }) => {
  await boot(page); await openDevice(page); await page.click('#mieRotateRight');
  await page.evaluate(() => { window.__revokedEditor = []; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { __revokedEditor.push(url); revoke(url); }; document.dispatchEvent(new Event('memo:privacy-locked')); });
  await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
  expect(await page.evaluate(() => __revokedEditor.length)).toBeGreaterThan(0);
  await page.evaluate(() => MemoImageEditor.open()); await expect(page.locator('#mieSave')).toBeDisabled();
});

test('primary navigation preserves the SPA document and view state, including Planner tools', async ({ page }) => {
  await boot(page); await page.setViewportSize({width:390,height:844});
  await page.evaluate(() => { window.__sameDocument = {}; MemoCore.getState().els.searchBox.value = 'remember'; });
  await page.click('#primaryNav [data-variant="finance"]');
  await expect(page.locator('#primaryNav [data-variant="finance"]')).toHaveAttribute('aria-current','page');
  await expect(page.locator('#sheetBtnName')).toBeVisible();
  await page.click('#primaryNav [data-variant="planner"]');
  await expect(page.locator('#primaryNav [data-variant="planner"]')).toHaveAttribute('aria-current','page');
  await openDevice(page); await page.click('#mieRotateRight');
  const download = page.waitForEvent('download'); await page.click('#mieDownload'); expect((await download).suggestedFilename()).toMatch(/edited\.png$/);
  await page.click('#mieClose');
  await page.click('#mieKeepDraft');
  await page.click('#primaryNav [data-variant="default"]');
  await expect(page.locator('#searchBox')).toHaveValue('remember');
  expect(await page.evaluate(() => !!window.__sameDocument)).toBe(true);
  await expect(page).toHaveURL(/index\.html$/);
});
