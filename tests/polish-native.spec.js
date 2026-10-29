const { test, expect } = require('@playwright/test');

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9TAAAAABJRU5ErkJggg==';

test('shared toast appears above the current dialog and dismisses', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoShell && window.MemoView, null, { timeout: 15000 });

  await page.evaluate(() => {
    document.getElementById('mobileAdjustViewBtn').click();
    window.MemoShell.toast('Saved safely.', { kind: 'success', ms: 800 });
  });

  const toast = page.locator('#memoToast');
  await expect(toast).toHaveText('Saved safely.');
  await expect(toast).toHaveClass(/memo-toast-success/);
  await expect(toast).toHaveClass(/visible/);
  await page.waitForTimeout(1800);
  await expect(toast).not.toHaveClass(/visible/);
});

test('Android share payload opens a memo draft with the received image and text', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoShare && window.openEntryModal, null, { timeout: 15000 });

  const result = await page.evaluate(async (payload) => {
    window.Capacitor = window.Capacitor || {};
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    window.Capacitor.Plugins.ShareReceiver = {
      consumePendingShare: async () => payload,
    };
    await window.MemoShare.consumePendingShare();
    return {
      open: document.getElementById('entryDlg').open,
      description: document.getElementById('desc').value,
      imageCount: document.querySelectorAll('#dragGrid .dragitem').length,
      toast: document.getElementById('memoToast').textContent,
    };
  }, { text: 'Shared note', files: [{ name: 'shared.png', mime: 'image/png', base64: ONE_PIXEL_PNG }] });

  expect(result.open).toBe(true);
  expect(result.description).toBe('Shared note');
  expect(result.imageCount).toBe(1);
  expect(result.toast).toContain('Added shared file');
});

test('bounded native share staging is consumed and released after import', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoShare && window.openEntryModal, null, { timeout: 15000 });

  const result = await page.evaluate(async (dataUrl) => {
    let releasedToken = null;
    window.Capacitor = window.Capacitor || {};
    window.Capacitor.convertFileSrc = () => dataUrl;
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    window.Capacitor.Plugins.ShareReceiver = {
      consumePendingShare: async () => ({
        text: 'Staged share',
        token: '11111111-1111-1111-1111-111111111111',
        files: [{ filePath: '/private/cache/shared.png', name: 'shared.png', mime: 'image/png', size: 68 }],
      }),
      releasePendingShare: async ({ token }) => { releasedToken = token; },
    };
    const consumed = await window.MemoShare.consumePendingShare();
    return {
      consumed,
      releasedToken,
      description: document.getElementById('desc').value,
      imageCount: document.querySelectorAll('#dragGrid .dragitem').length,
    };
  }, ONE_PIXEL_PNG);

  expect(result).toEqual({
    consumed: true,
    releasedToken: '11111111-1111-1111-1111-111111111111',
    description: 'Staged share',
    imageCount: 1,
  });
});

test('Finance remains open until a native warm-share event arrives', async ({ page }) => {
  await page.goto('/finance.html');
  await page.waitForFunction(() => window.MemoShare && window.MEMO_VARIANT === 'finance', null, { timeout: 15000 });

  expect(new URL(page.url()).pathname).toBe('/finance.html');
});

test('a genuine share at the native root URL opens a draft without replacing the document', async ({ page }) => {
  await page.goto('/'); await page.evaluate(() => MemoAppReady);
  await page.evaluate(() => {
    window.__shareDocument = true;
    window.Capacitor = { Plugins: { ShareReceiver: { consumePendingShare: async () => ({text:'Root share',files:[]}) } } };
    dispatchEvent(new Event('memoShareReceived'));
  });
  await expect(page.locator('#entryDlg')).toHaveAttribute('open','');
  await expect(page.locator('#desc')).toHaveValue('Root share');
  expect(await page.evaluate(() => window.__shareDocument)).toBe(true);
  await expect(page).toHaveURL(/\/$/);
});

test('open dialogs lock background scrolling', async ({ page }) => {
  await page.goto('/planner.html');
  await page.waitForFunction(() => window.MemoShell && document.getElementById('calAddBtn') && window.Planner?.setTab, null, { timeout: 15000 });
  await page.click('#plTab-calendar');

  await page.locator('#calAddBtn').click();
  await expect(page.locator('body')).toHaveClass(/dialog-open/);
  await expect(page.locator('html')).toHaveClass(/dialog-open/);
  await expect(page.locator('body')).toHaveCSS('overflow-y', 'hidden');

  await page.evaluate(() => document.querySelector('dialog[open]').close());
  await expect(page.locator('body')).not.toHaveClass(/dialog-open/);
});

test('Planner calendar uses compact day cells on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/planner.html');
  await page.waitForFunction(() => window.Planner?.setTab, null, { timeout: 15000 });
  await page.click('#plTab-calendar');
  await page.waitForSelector('.cal-month-grid .cal-day');

  const cells = await page.locator('.cal-month-grid .cal-day').evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().height));
  expect(Math.max(...cells)).toBeLessThanOrEqual(42);
});

test('native image clipboard is preferred when the Capacitor plugin is available', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCrop, null, { timeout: 15000 });

  const copied = await page.evaluate(async () => {
    let call = null;
    window.Capacitor = window.Capacitor || {};
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    window.Capacitor.Plugins.ClipboardImage = {
      copyImage: async (payload) => { call = payload; },
    };
    await window.MemoCrop.copyBlob(new Blob(['image-bytes'], { type: 'image/png' }));
    return call;
  });

  expect(copied.mime).toBe('image/png');
  expect(copied.base64).toMatch(/^data:image\/png;base64,/);
});

test('page switcher dismisses on outside press and Escape without blocking links', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoShell, null, { timeout: 15000 });

  await page.locator('#brandMenuButton').click();
  await expect(page.locator('#brandMenu')).toHaveClass(/show/);
  await expect(page.locator('#brandMenuButton')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('main').click({ position: { x: 8, y: 8 } });
  await expect(page.locator('#brandMenu')).not.toHaveClass(/show/);

  await page.locator('#brandMenuButton').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#brandMenu')).not.toHaveClass(/show/);

  await page.locator('#brandMenuButton').click();
  await page.locator('#brandMenu a[href="finance.html"]').click();
  await page.waitForFunction(() => window.MEMO_VARIANT === 'finance');
  await expect(page.locator('body')).toHaveClass(/finance-variant/);
  await expect(page).toHaveURL(/index\.html$/);
});

test('central back dismisses transient UI and then the topmost dialog', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoShell && window.MemoView, null, { timeout: 15000 });
  const result = await page.evaluate(() => {
    window.MemoShell.openBrandMenu();
    const menuFirst = window.MemoShell.handleSystemBack();
    const menuClosed = !document.getElementById('brandMenu').classList.contains('show');
    document.getElementById('viewSettingsDlg').showModal();
    const dialogClosed = window.MemoShell.handleSystemBack();
    const dialog = document.getElementById('viewSettingsDlg');
    return {
      menuFirst,
      menuClosed,
      dialogClosed,
      dialogOpen: dialog.open,
      dialogClosing: dialog.classList.contains('closing'),
    };
  });
  expect(result).toEqual({
    menuFirst: true,
    menuClosed: true,
    dialogClosed: true,
    dialogOpen: true,
    dialogClosing: true,
  });
  await page.waitForFunction(() => !document.getElementById('viewSettingsDlg').open);
});
