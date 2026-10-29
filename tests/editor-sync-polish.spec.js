const { test, expect } = require('@playwright/test');
const fs = require('fs');
const vm = require('vm');
test.use({ hasTouch: true });

async function boot(page, path = 'index.html') {
  await page.goto('/' + path);
  await page.evaluate(() => window.MemoAppReady || window.Planner?.ready);
}
async function image(page) {
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 400;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#579'; ctx.fillRect(0, 0, 600, 400);
    const blob = await new Promise(resolve => c.toBlob(resolve));
    await MemoImageEditor.open(new File([blob], 'touch.png', { type: 'image/png' }));
  });
  await expect(page.locator('#mieStatus')).toContainText('600 × 400');
}
async function touch(page, start, end) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: end.x, y: end.y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
async function selection(page) {
  return page.evaluate(async () => { await MemoImageEditorImpl.checkpoint(); return (await MemoImageDraft.read(MEMO_VARIANT, false)).selection; });
}

test('touch moves the existing crop without changing its size and clamps it to the image', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page); await image(page); await page.click('#mieCropTool');
  const old = await selection(page), box = await page.locator('#mieCrop').boundingBox();
  await touch(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2 + 25, y: box.y + box.height / 2 + 30 });
  const moved = await selection(page);
  expect(moved.w).toBeCloseTo(old.w); expect(moved.h).toBeCloseTo(old.h);
  expect(moved.x).toBeGreaterThan(old.x); expect(moved.y).toBeGreaterThan(old.y);
  expect(moved.x + moved.w).toBeLessThanOrEqual(1); expect(moved.y + moved.h).toBeLessThanOrEqual(1);
  await page.click('#mieApply'); await expect.poll(() => page.locator('#mieCanvas').evaluate(c => [c.width,c.height])).toEqual([480,320]);
  await page.click('#mieUndo'); await expect.poll(() => page.locator('#mieCanvas').evaluate(c => [c.width,c.height])).toEqual([600,400]);
});

test('all four 44px touch handles keep their opposite corner anchored and preserve a square crop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page); await image(page);
  for (const corner of ['nw','ne','sw','se']) {
    await page.click('#mieCropTool'); await page.selectOption('#mieRatio','1');
    const old = await selection(page), handle = await page.locator(`[data-corner=${corner}]`).boundingBox();
    expect(handle.width).toBeGreaterThanOrEqual(44); expect(handle.height).toBeGreaterThanOrEqual(44);
    const start = { x: handle.x + 12 + (corner.includes('e') ? 20 : 0), y: handle.y + 12 + (corner.includes('s') ? 20 : 0) };
    await touch(page, start, { x: start.x + (corner.includes('w') ? 22 : -22), y: start.y + (corner.includes('n') ? 22 : -22) });
    const rect = await selection(page);
    expect(rect.w).toBeLessThan(old.w); expect(rect.w * 600 / (rect.h * 400)).toBeCloseTo(1, 5);
    expect(corner.includes('w') ? rect.x + rect.w : rect.x).toBeCloseTo(corner.includes('w') ? old.x + old.w : old.x,5);
    expect(corner.includes('n') ? rect.y + rect.h : rect.y).toBeCloseTo(corner.includes('n') ? old.y + old.h : old.y,5);
    await page.click('#mieCancelTool');
  }
});

test('crop keyboard resize works on both axes with an aspect ratio and survives reload', async ({ page }) => {
  await boot(page); await image(page); await page.click('#mieCropTool'); await page.selectOption('#mieRatio','1');
  const old = await selection(page);
  await page.locator('#mieCrop').focus(); await page.keyboard.press('Shift+ArrowUp');
  const smaller = await selection(page); expect(smaller.h).toBeLessThan(old.h); expect(smaller.w * 600 / smaller.h / 400).toBeCloseTo(1);
  await page.reload(); await page.evaluate(() => MemoAppReady); await page.evaluate(() => MemoImageEditor.open()); await page.click('#mieResume');
  expect(await selection(page)).toEqual(smaller);
});

test('new translations cover every supported locale with matching placeholders', () => {
  const rows = [];
  for (const file of ['memo-i18n-tools.js', 'memo-i18n-app.js'])
    vm.runInNewContext(fs.readFileSync('src/static/js/memo/' + file,'utf8'), { MemoI18n: { addMessages: value => { rows.push(...value); } } });
  expect(new Set(rows.map(row => row[0])).size).toBe(rows.length);
  for (const row of rows) {
    expect(row).toHaveLength(5);
    for (const value of row) { expect(value.trim().length).toBeGreaterThan(0); expect((value.match(/\{\w+\}/g) || []).sort()).toEqual((row[0].match(/\{\w+\}/g) || []).sort()); }
  }
});

test('lazy editor, dismissal, sync details, and SPA navigation follow live language changes', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 640 }); await boot(page);
  await page.evaluate(() => MemoI18n.choose('es')); await image(page);
  await expect(page.locator('#mieTitle')).toHaveText('Editor de imágenes'); await expect(page.locator('#mieCropTool')).toHaveText('Recortar');
  await page.click('#mieRotateRight'); await expect(page.locator('#mieDraftStatus')).toHaveText('Edición guardada en este dispositivo');
  for (const [locale, name, crop] of [['fr','Éditeur d’images','Recadrer'],['de','Bildeditor','Zuschneiden'],['zh','图像编辑器','裁剪']]) {
    await page.evaluate(value => MemoI18n.choose(value), locale);
    await expect(page.locator('#mieTitle')).toHaveText(name); await expect(page.locator('#mieCropTool')).toHaveText(crop);
  }
  await page.evaluate(() => MemoI18n.choose('de')); await page.click('#mieCropTool');
  for (const id of ['mieApply','mieClose','mieDownload','mieSave']) await expect(page.locator('#'+id)).toBeInViewport();
  await page.screenshot({ path: info.outputPath('german-crop-phone.png'), animations:'disabled' });
  await page.click('#mieClose'); await expect(page.locator('#mieLeaveTitle')).toHaveText('Unfertige Bearbeitung behalten?');
  await page.click('#mieDiscard');
  await page.click('#primaryNav [data-variant=planner]');
  await expect(page.locator('#primaryNav [data-variant=planner]')).toHaveAttribute('aria-current','page');
  await expect(page.locator('#mobileSyncBackupBtn')).toContainText('Synchronisierung und Sicherung');
  await page.click('#hamburgerBtn'); await page.click('#mobileSyncBackupBtn');
  await expect(page.locator('#syncDetailsTitle')).toHaveText('Synchronisierung und Sicherung');
  await expect(page.locator('#syncRetry')).toHaveText('Jetzt synchronisieren');
  await page.screenshot({ path: info.outputPath('german-sync-phone.png'), animations:'disabled' });
});

test('standalone Planner has a working language picker and translated lazy tools', async ({ page }) => {
  await boot(page, 'planner.html');
  await page.evaluate(() => MemoI18n.choose('zh'));
  await expect(page.locator('#languageSelect option')).toHaveCount(6);
  await page.evaluate(() => MemoImageEditor.open()); await expect(page.locator('#mieTitle')).toHaveText('图像编辑器');
  await expect(page.locator('#mieDevice')).toHaveText('从设备选择');
});

async function server(page) {
  await boot(page);
  await page.evaluate(async () => {
    await OperationQueue._flight; OperationQueue.destroy(); MemoRuntime.setApiBase('https://home.test');
    OperationQueue.pushUnsyncedOperations = async () => {};
    OperationQueue.pullServerOperations = async () => {};
  });
}
test('server away is neutral, retry is single-flight, and last successful sync survives reload and is server-scoped', async ({ page }) => {
  await server(page);
  await page.evaluate(async () => { OperationQueue.pullServerOperations = async () => { throw new Error('Away'); }; await OperationQueue.processQueue(); MemoSyncStatus.open(); });
  await expect(page.locator('#syncServerState')).toHaveText('Server unavailable');
  await expect(page.locator('#syncLocalState')).toHaveText('Saved on this device');
  await expect(page.locator('#syncLastSuccess')).toHaveText('Never');
  await expect(page.locator('#syncStatus')).not.toHaveClass(/error/);
  await page.evaluate(() => { window.__calls = 0; OperationQueue.pullServerOperations = async () => { window.__calls++; if (__calls === 1) await new Promise(resolve => { window.__release = resolve; }); }; });
  await page.click('#syncRetry'); await expect(page.locator('#syncRetry')).toBeDisabled();
  expect(await page.evaluate(() => OperationQueue.processQueue() === OperationQueue._flight)).toBe(true);
  await page.evaluate(() => __release()); await expect(page.locator('#syncServerState')).toHaveText('Synced');
  expect(await page.evaluate(() => __calls)).toBe(3);
  const last = await page.locator('#syncLastSuccess').textContent(); expect(last).not.toBe('Never');
  await page.reload(); await page.evaluate(() => MemoAppReady);
  await page.evaluate(() => { MemoRuntime.setApiBase('https://home.test'); MemoSyncStatus.open(); });
  await expect(page.locator('#syncLastSuccess')).toHaveText(last);
  await page.evaluate(() => { MemoRuntime.setApiBase('https://another.test'); MemoSyncStatus.refresh(); });
  await expect(page.locator('#syncLastSuccess')).toHaveText('Never');
});

test('pending operations across all sections and auth are shown without claiming sync success', async ({ page }) => {
  await server(page);
  await page.evaluate(async () => {
    for (const variant of ['default','finance','planner']) OperationQueue.context(variant).state.queue.push({ synced:false, entryId:variant, lastError:'Retry later' });
    await OperationQueue.processQueue(); MemoSyncStatus.open();
  });
  await expect(page.locator('#syncPendingCount')).toHaveText('3');
  await expect(page.locator('#syncServerState')).toHaveText('Changes waiting to sync');
  await expect(page.locator('#syncLastSuccess')).toHaveText('Never');
  await page.evaluate(async () => { OperationQueue.pullServerOperations = async () => { throw Object.assign(new Error('Password'), { status:401 }); }; await OperationQueue.processQueue(); });
  await expect(page.locator('#syncServerState')).toHaveText('Sync password required');
  await expect(page.locator('#syncExplanation')).toContainText('password in Settings');
  await page.click('#syncDetailsSettings'); await expect(page.locator('#settingsDlg')).toHaveAttribute('open','');
});

test('local storage failures override server success, and retry saving works without a server', async ({ page }) => {
  await server(page);
  await page.evaluate(async () => {
    await OperationQueue.processQueue();
    window.__health = MemoStateDb.getMetadataHealth;
    MemoStateDb.getMetadataHealth = () => ({ status:'error',lastPersistError:'Disk full',pending:true });
    MemoSyncStatus.open();
  });
  await expect(page.locator('#syncLocalState')).toContainText('Could not save');
  await expect(page.locator('#syncStatus')).toHaveClass(/sync-save-error/);
  await expect(page.locator('#syncRetry')).toHaveText('Retry saving');
  await page.evaluate(() => { MemoRuntime.setApiBase(''); MemoRuntime.setMode('local'); MemoSyncStatus.refresh(); MemoStateDb.flush = async () => { MemoStateDb.getMetadataHealth = __health; }; });
  await page.click('#syncRetry');
  await expect(page.locator('#syncLocalState')).toHaveText('Saved on this device');
  await expect(page.locator('#syncServerState')).toHaveText('Local only');
  await expect(page.locator('#syncRetry')).toBeDisabled();
});

test('status observation before queue initialization cannot shadow the persisted outbox', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => {
    OperationQueue.destroy(); OperationQueue.states.clear();
    MemoStateDb.setItem('memo_operation_queue_default', { queue:[{clientOpId:'persisted',synced:false}],lastServerOpId:4 });
    const pending = MemoSyncStatus.snapshot().pending, contexts = OperationQueue.states.size;
    OperationQueue.reloadQueue();
    return { pending, contexts, queue:OperationQueue.queue.map(o => o.clientOpId) };
  });
  expect(result).toEqual({ pending:1, contexts:0, queue:['persisted'] });
});
