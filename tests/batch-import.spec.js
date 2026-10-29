const { test, expect } = require('@playwright/test');

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9TAAAAABJRU5ErkJggg==';

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoBatchImport && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
}

test('batch import review is opt-in, edits selected metadata, and creates separate entries', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async (png) => {
    const raw = await fetch(png).then((response) => response.blob());
    const a = new File([raw], 'first-image.png', { type: 'image/png' });
    const b = new File([raw], 'second_image.png', { type: 'image/png' });
    window.MemoBatchImport.open([a, b, new File(['not an image'], 'note.txt', { type: 'text/plain' })]);
    const initial = window.MemoBatchImport.__items().map((item) => item.description);
    const cards = document.querySelectorAll('.batch-import-card');
    cards[0].querySelector('.batch-import-description').value = 'First reviewed';
    cards[0].querySelector('.batch-import-description').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('batchImportBulkTags').value = 'receipt, reviewed';
    document.getElementById('batchImportAddTagsBtn').click();
    document.getElementById('batchImportBulkCategory').value = 'Uncategorized';
    document.getElementById('batchImportApplyCategoryBtn').click();
    await document.getElementById('batchImportConfirmBtn').click();
    return initial;
  }, ONE_PIXEL_PNG);
  await page.waitForFunction(() => !document.getElementById('batchImportReviewDlg').open);
  const entries = await page.evaluate(() => window.MemoCore.getState().db.entries
    .filter((entry) => entry.description === 'First reviewed' || entry.description === 'second image')
    .map((entry) => ({ description: entry.description, tags: entry.tags, images: entry.images.length })));
  expect(result).toEqual(['first image', 'second image']);
  expect(entries).toHaveLength(2);
  expect(entries[0].tags).toEqual(expect.arrayContaining(['receipt', 'reviewed']));
  expect(entries.every((entry) => entry.images === 1)).toBe(true);
});

test('cancelling batch review makes no entries', async ({ page }) => {
  await boot(page);
  const count = await page.evaluate(async (png) => {
    const raw = await fetch(png).then((response) => response.blob());
    const before = window.MemoCore.getState().db.entries.length;
    window.MemoBatchImport.open([new File([raw], 'cancel.png', { type: 'image/png' })]);
    document.getElementById('batchImportCancelBtn').click();
    return { before, after: window.MemoCore.getState().db.entries.length };
  }, ONE_PIXEL_PNG);
  await page.waitForFunction(() => !document.getElementById('batchImportReviewDlg').open);
  expect(count.after).toBe(count.before);
});
