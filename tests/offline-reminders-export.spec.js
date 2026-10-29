const { test, expect } = require('@playwright/test');
async function boot(page) { await page.goto('/index.html'); await page.evaluate(() => MemoAppReady); }
async function image(page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
    canvas.getContext('2d').fillRect(0, 0, 80, 60);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    await MemoImageEditor.open(new File([blob], 'export-test.png', { type: 'image/png' }));
  });
  await page.click('#mieRotateRight');
  await page.evaluate(() => MemoImageEditorImpl.checkpoint());
}

test('metadata success does not claim missing attachments are ready; retry stores bytes', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    MemoStateDb.saveEntries([{ id: 'missing-file', images: ['/uploads/test/photo.png'] }], 'default');
    await MemoStateDb.flush();
    MemoTransport.request = async () => ({ ok: false, status: 404 });
    await MemoOfflineFiles.scan(true);
    MemoSyncStatus.open();
  });
  await expect(page.locator('#syncFilesState')).toHaveText('Files available offline: 0 of 1');
  await expect(page.locator('#syncIssues')).toContainText('File missing on server');
  await page.evaluate(() => { MemoTransport.request = async () => ({ ok: true, blob: async () => new Blob(['photo-bytes']) }); });
  await page.click('#syncFilesRetry');
  await expect(page.locator('#syncFilesState')).toHaveText('All files available offline');
  expect(await page.evaluate(async () => (await MemoStateDb.readBlob('uploads/test/photo.png')).text())).toBe('photo-bytes');
});

test('missing downloads are rediscovered from persisted records after reload', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    MemoStateDb.saveEntries([{ id: 'receipt', images: ['/uploads/test/later.jpg'] }], 'finance');
    await MemoStateDb.flush();
  });
  await page.reload(); await page.evaluate(() => MemoAppReady);
  await page.evaluate(async () => { await MemoOfflineFiles.scan(false); MemoSyncStatus.open(); });
  await expect(page.locator('#syncFilesState')).toHaveText('Files available offline: 0 of 1');
  await expect(page.locator('#syncFilesRetry')).toBeEnabled();
});

test('local file write failure stays visible and retryable', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    MemoStateDb.saveEntries([{ id: 'storage-full', images: ['/uploads/test/full.png'] }], 'default');
    MemoTransport.request = async () => ({ ok: true, blob: async () => new Blob(['bytes']) });
    MemoStateDb.writeBlob = async () => { throw new Error('full'); };
    await MemoOfflineFiles.scan(true); MemoSyncStatus.open();
  });
  await expect(page.locator('#syncIssues')).toContainText('Could not store file on this device');
  await expect(page.locator('#syncFilesRetry')).toBeEnabled();
});

test('reminders use durable planner events and remove deleted schedules without exposing titles', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    window.Capacitor ||= {}; Capacitor.Plugins ||= {};
    let scheduled, pendingAtSchedule;
    Capacitor.Plugins.PlannerReminders = {
      status: async () => ({ enabled: true }),
      replace: async value => { scheduled = value.events; pendingAtSchedule = MemoStateDb.getMetadataHealth().pending; }
    };
    MemoStateDb.saveDocs('planner', [{ id: 'event-a', kind: 'event', title: 'Private event title', date: '2030-04-05', start: '12:00', remindBefore: 15 }]);
    await MemoPlannerReminders.reconcile(true);
    const first = structuredClone(scheduled);
    MemoStateDb.saveDocs('planner', [{ id: 'event-a', kind: 'event', deletedAt: new Date().toISOString(), remindBefore: 15 }]);
    await MemoPlannerReminders.reconcile(true);
    return { first, last: scheduled, pendingAtSchedule };
  });
  expect(result.first).toHaveLength(1);
  expect(result.first[0]).toMatchObject({ id: 'event-a', date: '2030-04-05', start: '12:00', remindBefore: 15 });
  expect(JSON.stringify(result.first)).not.toContain('Private event title');
  expect(result.last).toEqual([]); expect(result.pendingAtSchedule).toBe(false);
});

test('browser download retains image recovery and does not claim a confirmed save', async ({ page }) => {
  await boot(page); await image(page);
  const download = page.waitForEvent('download'); await page.click('#mieDownload'); await download;
  await expect(page.locator('#mieStatus')).toHaveText('Download started. Your edit is kept for recovery.');
  expect(await page.evaluate(async () => !!await MemoImageDraft.read('default', false))).toBe(true);
});

test('gallery failure retains recovery; confirmed gallery save clears it', async ({ page }) => {
  await boot(page); await image(page);
  await page.evaluate(() => { MemoCrop.saveToPhone = async () => { throw new Error('Gallery storage full'); }; });
  await page.click('#mieDownload'); await expect(page.locator('#mieStatus')).toHaveText('Gallery storage full');
  expect(await page.evaluate(async () => !!await MemoImageDraft.read('default', false))).toBe(true);
  await page.evaluate(() => { MemoCrop.saveToPhone = async () => 'gallery'; });
  await page.click('#mieDownload'); await expect(page.locator('#mieStatus')).toHaveText('Copy saved to device. Original kept.');
  expect(await page.evaluate(() => MemoImageDraft.read('default', false))).toBeNull();
});
