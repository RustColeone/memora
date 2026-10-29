// A tap outside a dialog closes it (memo-backdrop.js); if something changed it
// asks first. Also: the entry view has a Tools button beside Edit.
const { test, expect } = require('@playwright/test');

async function boot(page, size = { width: 390, height: 844 }) {
  await page.setViewportSize(size);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready() && window.MemoAppReady && window.MemoTools && window.MemoBackdrop, null, { timeout: 15000 });
  await page.evaluate(() => window.MemoAppReady);
}
async function seed(page, withImages = true) {
  await page.evaluate(async (withImages) => {
    const draw = (color) => new Promise((resolve) => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 320, 240);
      c.toBlob(resolve, 'image/jpeg', 0.9);
    });
    const sdb = window.MemoStateDb;
    if (withImages) await sdb.writeBlob('uploads/bd-a.jpg', await draw('#1f6f8b'));
    sdb.importBundle({ version: 1, memos: [
      { id: 'bd-img', description: 'With a photo', category: 'Work', tags: [], images: withImages ? ['uploads/bd-a.jpg'] : [], attachments: [], ts: Date.now() },
      { id: 'bd-text', description: 'Just words', category: 'Work', tags: [], images: [], attachments: [], ts: Date.now() - 1000 },
    ], finance: [], planner: [] }, 'replace');
    await sdb.flush();
    window.MemoCore.getState().db.entries = sdb.loadEntries('default');
  }, withImages);
}
// A point on the dimmed area: above the dialog's panel, or beside it.
async function outsidePoint(page, sel) {
  return page.locator(sel).evaluate((dlg) => {
    const panel = [...dlg.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width && r.height)
      .reduce((a, r) => ({ top: Math.min(a.top, r.top), left: Math.min(a.left, r.left), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }), { top: 1e9, left: 1e9, right: -1, bottom: -1 });
    if (panel.top > 24) return { x: innerWidth / 2, y: panel.top / 2 };
    if (panel.left > 24) return { x: panel.left / 2, y: innerHeight / 2 };
    if (innerHeight - panel.bottom > 24) return { x: innerWidth / 2, y: (panel.bottom + innerHeight) / 2 };
    return null;
  });
}
async function tapOutside(page, sel) {
  const p = await outsidePoint(page, sel);
  expect(p, 'the dialog leaves some dimmed area to tap').not.toBeNull();
  await page.mouse.click(p.x, p.y);
}

for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`${size.width}px: a tap outside the entry view closes it; a tap inside does not`, async ({ page }) => {
    await boot(page, size); await seed(page);
    await page.evaluate(() => window.MemoVariant.openDetail('bd-img'));
    const dlg = page.locator('#detailDlg');
    await expect(dlg).toHaveAttribute('open', '');
    await page.locator('#detailContent h3').click();
    await expect(dlg).toHaveAttribute('open', '');
    await tapOutside(page, '#detailDlg');
    await expect(dlg).not.toHaveAttribute('open', '');
  });
}

test('the editor: unchanged closes at once; changed asks, Keep editing keeps the text, Discard closes', async ({ page }) => {
  await boot(page); await seed(page);
  const dlg = page.locator('#entryDlg');
  await page.evaluate(() => window.openEntryModal());
  await expect(dlg).toHaveAttribute('open', '');
  await page.waitForTimeout(100);
  await tapOutside(page, '#entryDlg');
  await expect(dlg).not.toHaveAttribute('open', '');

  await page.evaluate(() => window.openEntryModal());
  await page.waitForTimeout(100);
  await page.fill('#desc', 'Half-written thought');
  await tapOutside(page, '#entryDlg');
  const ask = page.locator('#memoConfirmDlg');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('Discard your changes?');
  await ask.locator('.memo-confirm-ok').click();                 // Keep editing
  await expect(dlg).toHaveAttribute('open', '');
  await expect(page.locator('#desc')).toHaveValue('Half-written thought');
  await tapOutside(page, '#entryDlg');
  await ask.locator('.memo-confirm-secondary').click();          // Discard
  await expect(dlg).not.toHaveAttribute('open', '');
  const saved = await page.evaluate(() => window.MemoCore.getState().db.entries.some((e) => e.description === 'Half-written thought'));
  expect(saved).toBe(false);
});

test('a drag that starts in the form and ends outside does not close it', async ({ page }) => {
  await boot(page); await seed(page);
  await page.evaluate(() => window.openEntryModal());
  await page.waitForTimeout(100);
  const box = await page.locator('#desc').boundingBox();
  const p = await outsidePoint(page, '#entryDlg');
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#entryDlg')).toHaveAttribute('open', '');
});

test('Planner: a changed event sheet asks before closing; an untouched one just closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/planner.html');
  await page.waitForSelector('#todayBody .pl-card', { timeout: 15000 });
  await page.click('#plTab-calendar');
  await page.click('#calAddBtn');
  const dlg = page.locator('#eventDlg');
  await expect(dlg).toHaveAttribute('open', '');
  await page.waitForTimeout(100);
  await tapOutside(page, '#eventDlg');
  await expect(dlg).not.toHaveAttribute('open', '');
  await page.click('#calAddBtn');
  await page.waitForTimeout(100);
  await page.locator('#evRepeatChips .pl-chip[data-value="weekly"]').click();   // a chip, not typing, is a change too
  await tapOutside(page, '#eventDlg');
  await expect(page.locator('#memoConfirmDlg')).toBeVisible();
  await page.locator('#memoConfirmDlg .memo-confirm-secondary').click();
  await expect(dlg).not.toHaveAttribute('open', '');
  expect(await page.evaluate(() => Planner.Store.state.events.length)).toBe(0);
});

test('a question dialog tapped outside answers "no"', async ({ page }) => {
  await boot(page);
  const answer = page.evaluate(() => window.MemoShell.confirm('Delete everything?'));
  await expect(page.locator('#memoConfirmDlg')).toBeVisible();
  await tapOutside(page, '#memoConfirmDlg');
  expect(await answer).toBeFalsy();
});

test('the entry view has a Tools button beside Edit when the entry has images', async ({ page }) => {
  await boot(page); await seed(page);
  await page.evaluate(() => window.MemoVariant.openDetail('bd-text'));
  await expect(page.locator('#detailToolsAction')).toBeHidden();
  await page.evaluate(() => window.MemoVariant.closeDetail());
  await page.evaluate(() => window.MemoVariant.openDetail('bd-img'));
  const tools = page.locator('#detailToolsAction');
  await expect(tools).toBeVisible();
  await expect(tools).toHaveText(/Tools/);
  await tools.click();
  await expect(page.locator('#imageToolsDlg')).toHaveAttribute('open', '');
});
