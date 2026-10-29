// Phones in landscape keep their proportions (memo-viewport.js): the page is
// drawn at short-side/480, so it lays out like a ~480 px tall window. Portrait,
// and screens without touch, stay at scale 1. Also: the finance table drops an
// Images column nothing would fill, and dialogs use the landscape height.
const { test, expect } = require('@playwright/test');

const ZENFONE = { deviceScaleFactor: 2.75, isMobile: true, hasTouch: true };

async function open(page, path = '/finance.html') {
  await page.goto(path);
  await page.waitForFunction(() => window.MemoViewport && document.readyState === "complete", null, { timeout: 15000 });
}

test.describe('phone in landscape', () => {
  test.use({ ...ZENFONE, viewport: { width: 873, height: 393 } });

  test('is drawn at 0.82, laying out like a 1064 x 479 window', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => [MemoViewport.scale(), innerWidth, innerHeight, document.documentElement.classList.contains('scaled-landscape')]))
      .toEqual([0.82, 1064, 479, true]);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /initial-scale=0\.82, minimum-scale=0\.82, maximum-scale=0\.82/);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  });

  test('the planner page scales the same way', async ({ page }) => {
    await open(page, '/planner.html');
    expect(await page.evaluate(() => [MemoViewport.scale(), innerWidth])).toEqual([0.82, 1064]);
  });

  test('the finance table hides an empty Images column; a dialog uses the height', async ({ page }) => {
    await open(page);
    await page.waitForFunction(() => window.MemoVariant && window.MemoStateDb?.ready(), null, { timeout: 15000 });
    const seed = async (images) => page.evaluate(async (images) => {
      window.MemoStateDb.saveEntries([{ id: 'r1', description: 'Gas', category: 'Transport', sheet: 'General', tags: [], images, attachments: [], purchaseDate: '2026-10-02', items: [], tax: 0, total: 58.2, ts: Date.now() }], 'finance');
      await window.MemoStateDb.flush();
      window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('finance') || [];
      window.MemoVariant.renderFeed();
    }, images);
    await seed([]);
    await expect(page.locator('#feed .listtable thead th.col-images')).toBeHidden();
    expect(await page.locator('#feed tr.month-row td.month-toggle').getAttribute('colspan')).toBe('2');
    await seed(['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=']);
    await expect(page.locator('#feed .listtable thead th.col-images')).toBeVisible();
    expect(await page.locator('#feed tr.month-row td.month-toggle').getAttribute('colspan')).toBe('3');

    await page.click('#fab');
    const content = page.locator('#entryDlg[open] .modal .content');
    await expect(content).toBeVisible();
    const h = await content.evaluate(el => parseFloat(getComputedStyle(el).maxHeight));
    expect(h).toBeGreaterThan(340);   // was 68vh = 267 px before
  });
});

test.describe('left at scale 1', () => {
  test.describe('phone in portrait', () => {
    test.use({ ...ZENFONE, viewport: { width: 393, height: 873 } });
    test('portrait', async ({ page }) => {
      await open(page);
      expect(await page.evaluate(() => [MemoViewport.scale(), innerWidth])).toEqual([1, 393]);
    });
  });
  test.describe('a short window on a computer', () => {
    test.use({ viewport: { width: 873, height: 393 } });
    test('no touch screen', async ({ page }) => {
      await open(page);
      expect(await page.evaluate(() => [MemoViewport.scale(), innerWidth])).toEqual([1, 873]);
    });
  });
});

test('keyboard up on a phone: the bottom bar and + button step aside, then come back', async ({ browser }) => {
  const context = await browser.newContext({ ...ZENFONE, viewport: { width: 393, height: 873 } });
  const page = await context.newPage();
  await open(page, '/index.html');
  await page.evaluate(() => MemoAppReady);
  await page.evaluate(() => MemoSpaShell.switchTo('planner'));
  await page.waitForSelector('#plTab-todos');
  await page.click('#plTab-todos');
  const nav = page.locator('#primaryNav');
  await expect(nav).toBeVisible();
  // Focus alone (a hardware keyboard, say) changes nothing.
  await page.focus('#todoInput');
  await expect(nav).toBeVisible();
  // The on-screen keyboard takes the lower part of the screen.
  await page.setViewportSize({ width: 393, height: 480 });
  await expect(page.locator('html')).toHaveClass(/kb-open/);
  await expect(nav).toBeHidden();
  // Keyboard down again.
  await page.setViewportSize({ width: 393, height: 873 });
  await expect(page.locator('html')).not.toHaveClass(/kb-open/);
  await expect(nav).toBeVisible();
  // Tapping a button while typing: the field loses focus first, and the bar
  // stays away until the keyboard has really gone (the page is tall again).
  await page.focus('#todoInput');
  await page.setViewportSize({ width: 393, height: 480 });
  await expect(page.locator('html')).toHaveClass(/kb-open/);
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(100);
  await expect(page.locator('html')).toHaveClass(/kb-open/);
  await page.setViewportSize({ width: 393, height: 873 });
  await expect(page.locator('html')).not.toHaveClass(/kb-open/);
  // A short window with nothing being typed in keeps the bar.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.setViewportSize({ width: 393, height: 480 });
  await expect(nav).toBeVisible();
  await context.close();
});
