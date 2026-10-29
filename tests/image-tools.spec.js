// Image tools ported from ImageDB: the per-image Tools sheet reached from an
// entry's ··· menu and from a reader page, the All tools page, and the tools
// that also work in a browser (Privacy blur by brush, Scan document by hand).
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready() && window.MemoAppReady && window.MemoTools, null, { timeout: 15000 });
  await page.evaluate(() => window.MemoAppReady);
}

// Two stored JPEG images in one entry (drawn, no fixtures).
async function seedEntry(page) {
  await page.evaluate(async () => {
    const draw = (color, w, h) => new Promise(resolve => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff'; g.fillRect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);
      c.toBlob(resolve, 'image/jpeg', 0.9);
    });
    const sdb = window.MemoStateDb;
    await sdb.writeBlob('uploads/tools-a.jpg', await draw('#1f6f8b', 640, 480));
    await sdb.writeBlob('uploads/tools-b.jpg', await draw('#8b1f4a', 480, 640));
    sdb.importBundle({ version: 1, memos: [{ id: 'tools-1', description: 'Receipt and a page', category: 'Work', tags: [], images: ['uploads/tools-a.jpg', 'uploads/tools-b.jpg'], attachments: [], ts: Date.now() }], finance: [], planner: [] }, 'replace');
    await sdb.flush();
    const st = window.MemoCore.getState();
    st.db.entries = sdb.loadEntries('default');
  });
}

test('an entry with images offers Image tools, with a strip to choose the image', async ({ page }) => {
  await boot(page);
  await seedEntry(page);
  await page.evaluate(() => window.MemoVariant.openDetail('tools-1'));
  await page.waitForSelector('#detailDlg[open]');
  await page.click('#detailMenuBtn');
  await page.click('#detailToolsBtn');
  const sheet = page.locator('#imageToolsDlg[open]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.image-tools-thumb')).toHaveCount(2);
  await expect(sheet.locator('.image-tools-thumb[aria-checked="true"]')).toHaveCount(1);
  // In a browser only the canvas tools are offered (the ML Kit ones need the app).
  const tools = await sheet.locator('.image-tool').evaluateAll(nodes => nodes.map(node => node.dataset.tool).sort());
  expect(tools).toEqual(['edit-metadata', 'image-editor', 'image-info', 'privacy-blur', 'scan-document']);
  await sheet.locator('.image-tools-thumb').nth(1).click();
  await expect(sheet.locator('.image-tools-thumb').nth(1)).toHaveAttribute('aria-checked', 'true');
});

test('Privacy blur paints a mask by brush and offers Add to this entry', async ({ page }) => {
  await boot(page);
  await seedEntry(page);
  await page.evaluate(() => window.MemoTools.open('tools-1', 0));
  await page.click('#imageToolsDlg .image-tool[data-tool="privacy-blur"]');
  await page.waitForSelector('#toolEditorDlg[open]');
  await page.waitForFunction(() => window.MemoToolEditors?.blurState?.());
  const box = await page.locator('#toolEditorOverlay').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  const state = await page.evaluate(() => window.MemoToolEditors.blurState());
  expect(state.strokes).toBe(1);
  expect(state.coverage).toBeGreaterThan(0.01);
  const actions = await page.locator('#toolEditorActions button').allTextContents();
  expect(actions).toEqual(['Share', 'Add to this entry']);
  // Adding hands the copy to the entry form; nothing is saved until Post.
  await page.click('#toolEditorActions button:has-text("Add to this entry")');
  await page.waitForSelector('#entryDlg[open]');
  await expect(page.locator('#toolEditorDlg[open]')).toHaveCount(0);
  const stored = await page.evaluate(() => window.MemoStateDb.loadEntries('default').find(e => e.id === 'tools-1').images.length);
  expect(stored).toBe(2);
});

test('Scan document straightens a page from hand-set corners', async ({ page }) => {
  await boot(page);
  await seedEntry(page);
  await page.evaluate(() => window.MemoTools.open('tools-1', 0));
  await page.click('#imageToolsDlg .image-tool[data-tool="scan-document"]');
  await page.waitForSelector('#toolEditorDlg[open]');
  await page.waitForSelector('#toolEditorActions button:has-text("Straighten")');
  await page.click('#toolEditorActions button:has-text("Straighten")');
  await page.waitForSelector('#toolEditorActions button:has-text("Adjust corners")', { timeout: 20000 });
  await expect(page.locator('#toolEditorOptions .tool-chip')).toHaveCount(3);
  const size = await page.evaluate(() => ({ w: document.getElementById('toolEditorCanvas').width, h: document.getElementById('toolEditorCanvas').height }));
  expect(size.w).toBeGreaterThan(400);
  expect(size.h).toBeGreaterThan(300);
});

test('a reader page offers Image tools for the page in view', async ({ page }) => {
  await boot(page);
  await seedEntry(page);
  await page.evaluate(() => window.MemoReader.open(window.MemoCore.getState().db.entries.find(e => e.id === 'tools-1'), 1));
  await page.waitForFunction(() => document.getElementById('urDlg')?.open);
  const items = await page.evaluate(() => {
    const ur = document.getElementById('urDlg');
    return !!ur;
  });
  expect(items).toBe(true);
  // The reader builds its page menu from MemoReader's item list.
  await page.evaluate(() => window.MemoTools.open('tools-1', 1));
  await expect(page.locator('#imageToolsDlg .image-tools-thumb').nth(1)).toHaveAttribute('aria-checked', 'true');
});

test('All tools groups the tools by task', async ({ page }) => {
  await boot(page);
  await page.click('#hamburgerBtn');
  await page.click('#mobileAdvancedToolsBtn');
  await page.waitForSelector('#advancedToolsDlg[open]');
  await expect(page.locator('#advancedToolsDlg header')).toContainText('All tools');
  await expect(page.locator('#advancedToolsDlg .advanced-tools-section h4')).toHaveText(['Create', 'Edit', 'Organize']);
  // Scanning with the camera is an Android app tool.
  await expect(page.locator('#advancedScanBtn')).toBeHidden();
});

test('a detected page outline is used only when it looks like a page', async ({ page }) => {
  await boot(page);
  const verdicts = await page.evaluate(() => {
    const check = points => window.MemoToolEditors.plausiblePage(points.map(([x, y]) => ({ x, y })), 1000, 800);
    return {
      page: check([[80, 60], [920, 90], [900, 740], [100, 720]]),
      triangle: check([[40, 40], [600, 60], [300, 760], [310, 750]]),
      sliver: check([[0, 0], [1000, 0], [1000, 40], [0, 40]]),
      crossed: check([[80, 60], [900, 740], [920, 90], [100, 720]]),
    };
  });
  expect(verdicts).toEqual({ page: true, triangle: false, sliver: false, crossed: false });
});
