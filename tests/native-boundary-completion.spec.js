const { test, expect } = require('@playwright/test');

async function installNativeUiMock(page) {
  await page.addInitScript(() => {
    window.__nativeUiCalls = [];
    window.Capacitor = {
      // Keep the page on its normal browser storage path while exposing only
      // the native UI bridge under test.
      isNativePlatform: () => false,
      getPlatform: () => 'web',
      Plugins: {
        NativeUi: {
          setSystemBars: async payload => { window.__nativeUiCalls.push({ method: 'setSystemBars', payload }); },
          haptic: async payload => { window.__nativeUiCalls.push({ method: 'haptic', payload }); return { performed: true }; },
        },
      },
    };
  });
}

for (const setup of [
  { name: 'memo', path: '/index.html', save: '#saveServerUrl' },
  { name: 'planner', path: '/planner.html', save: '#saveServerUrlBtn' },
]) {
  test(`${setup.name} HTTP server setup shows the interception risk and requires explicit confirmation`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(setup.path);
    await page.waitForFunction(saveSelector => window.MemoShell && document.querySelector(saveSelector), setup.save);
    await page.evaluate(() => document.getElementById('settingsDlg').showModal());
    const serverSection = page.locator('#serverSyncSection');
    if (await serverSection.evaluate(section => section.classList.contains('collapsed'))) {
      await serverSection.locator('h3').click();
    }

    const warning = page.locator('#serverTransportWarning');
    await page.fill('#serverUrlInput', 'http://192.168.1.100:5050');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(/not encrypted/i);
    await expect(warning).toContainText(/observe or modify/i);

    await page.evaluate(() => {
      window.__httpConfirmations = [];
      window.confirm = message => { window.__httpConfirmations.push(message); return false; };
    });
    await page.click(setup.save);

    const result = await page.evaluate(() => ({
      messages: window.__httpConfirmations,
      saved: localStorage.getItem('memo_server_url'),
    }));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/unencrypted|intercepted/i);
    expect(result.saved).toBeNull();
  });
}

test('native system bars follow dark/light theme with matching icon contrast', async ({ page }) => {
  await installNativeUiMock(page);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoNativeUi && window.MemoShell);

  await expect.poll(async () => page.evaluate(() =>
    window.__nativeUiCalls.filter(call => call.method === 'setSystemBars').at(-1)?.payload,
  )).toMatchObject({
    backgroundColor: '#17181b',
    statusBarColor: '#17181b',
    navigationBarColor: '#17181b',
    darkIcons: false,
  });

  await page.evaluate(() => window.MemoShell.setTheme('light'));
  await expect.poll(async () => page.evaluate(() =>
    window.__nativeUiCalls.filter(call => call.method === 'setSystemBars').at(-1)?.payload,
  )).toMatchObject({
    backgroundColor: '#f8fafc',
    statusBarColor: '#f8fafc',
    navigationBarColor: '#f8fafc',
    darkIcons: true,
  });
});

test('native haptics fire only for completed semantic actions', async ({ page }) => {
  await installNativeUiMock(page);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoNativeUi && window.MemoCtx && window.MemoSelect && window.MemoCore);

  await page.evaluate(() => {
    const target = document.createElement('div');
    target.id = 'nativeHapticHoldTarget';
    document.body.appendChild(target);
    window.MemoCtx.attachLongPress(target, () => {});
  });
  await page.dispatchEvent('#nativeHapticHoldTarget', 'pointerdown', {
    pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 10, clientY: 10,
  });
  await page.waitForTimeout(550);
  await page.dispatchEvent('#nativeHapticHoldTarget', 'pointerup', {
    pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 10, clientY: 10,
  });

  await page.evaluate(() => window.MemoSelect.enter('haptic-selection', false));
  await page.evaluate(async () => {
    const state = window.MemoCore.getState();
    state.db.entries.push({
      id: 'haptic-delete', description: 'Delete me', category: 'General', tags: [], images: [], attachments: [],
      ts: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
    });
    await window.MemoCore.batchDelete(['haptic-delete']);
  });

  const types = await page.evaluate(() => window.__nativeUiCalls
    .filter(call => call.method === 'haptic')
    .map(call => call.payload.type));
  expect(types).toEqual(['longPress', 'selection', 'destructiveSuccess']);
});

test('native UI bridge silently ignores unsupported haptic semantics', async ({ page }) => {
  await installNativeUiMock(page);
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoNativeUi);

  const result = await page.evaluate(async () => {
    const ignored = await window.MemoNativeUi.haptic('ordinaryTap');
    const accepted = await window.MemoNativeUi.haptic('selection');
    return { ignored, accepted, calls: window.__nativeUiCalls.filter(call => call.method === 'haptic') };
  });

  expect(result.ignored).toBe(false);
  expect(result.accepted).toBe(true);
  expect(result.calls.map(call => call.payload.type)).toEqual(['selection']);
});
