// The Vault: secure notes and AI keys, encrypted on the device (memo-vault.js).
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoVault && window.MemoStateDb?.ready() && window.MemoVaultUi, null, { timeout: 15000 });
}
const vaultDocs = page => page.evaluate(() => window.MemoStateDb.loadDocs('vault'));

test('set up, store a note encrypted, copy one line, lock and unlock', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  await page.click('#hamburgerBtn');
  await expect(page.locator('#mobileVaultBtn')).toBeVisible();
  await page.click('#mobileVaultBtn');
  await expect(page.locator('#vaultDlg')).toHaveAttribute('open', '');
  // Mismatched passwords are refused; short ones too (minlength).
  await page.fill('#vaultDlg input[name=password]', 'correct horse');
  await page.fill('#vaultDlg input[name=confirm]', 'correct horsf');
  await page.click('#vaultDlg button[type=submit]');
  await expect(page.locator('#vaultDlg .vault-error')).toContainText('different');
  await page.fill('#vaultDlg input[name=password]', 'correct horse');
  await page.fill('#vaultDlg input[name=confirm]', 'correct horse');
  await page.click('#vaultDlg button[type=submit]');
  await expect(page.locator('#vaultDlg .vault-status')).toContainText('Unlocked');

  await page.click('#vaultDlg [data-act=add-note]');
  await page.fill('#vaultDlg input[name=title]', 'Home Wi-Fi');
  await page.fill('#vaultDlg textarea[name=content]', 'SSID: Maple-Home-5G\nPASS: hunter2-secret\nNotes are a whole line');
  await page.click('#vaultDlg button[type=submit]');
  await expect(page.locator('#vaultDlg .vault-card-title')).toHaveText('Home Wi-Fi');

  // Nothing readable at rest: not the title, not the content.
  const raw = JSON.stringify(await vaultDocs(page));
  expect(raw).not.toContain('Home Wi-Fi');
  expect(raw).not.toContain('hunter2');
  expect(raw).toContain('vault-keyring');

  // Expanded: PASS is masked, each line copies only its value.
  await page.click('#vaultDlg .vault-card-head');
  await expect(page.locator('#vaultDlg .vault-line')).toHaveCount(3);
  await expect(page.locator('#vaultDlg .vault-line').nth(1).locator('.vault-v')).toHaveText('••••••••');
  await page.locator('#vaultDlg .vault-line').nth(1).locator('.vault-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('hunter2-secret');
  await page.locator('#vaultDlg .vault-line').nth(2).locator('.vault-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Notes are a whole line');
  await page.click('#vaultDlg [data-act=reveal]');
  await expect(page.locator('#vaultDlg .vault-line').nth(1).locator('.vault-v')).toHaveText('hunter2-secret');

  // Lock: content is gone from the screen; a wrong password is refused.
  await page.click('#vaultDlg [data-act=lock]');
  await expect(page.locator('#vaultDlg .vault-locked')).toBeVisible();
  expect(await page.locator('#vaultDlg').textContent()).not.toContain('hunter2');
  await page.fill('#vaultDlg input[name=password]', 'wrong password');
  await page.click('#vaultDlg button[type=submit]');
  await expect(page.locator('#vaultDlg .vault-error')).toContainText('Wrong password');
  await page.fill('#vaultDlg input[name=password]', 'correct horse');
  await page.click('#vaultDlg button[type=submit]');
  await expect(page.locator('#vaultDlg .vault-card-title')).toHaveText('Home Wi-Fi');

  // Every change went through the sync queue of the vault collection.
  const queued = await page.evaluate(() => window.OperationQueue.context('vault').state.queue.map(op => op.type + ':' + op.entryId.slice(0, 6)));
  expect(queued.filter(op => op.startsWith('create:')).length).toBe(2); // keyring + note
});

test('a changed password opens the same items; a restart and 5 minutes away both lock', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    await window.MemoVault.setup('first password');
    await window.MemoVault.save({ type: 'note', title: 'Bike lock', content: 'CODE: 4321' });
    await window.MemoVault.changePassword('second password');
    window.MemoVault.lock();
  });
  const refused = await page.evaluate(() => window.MemoVault.unlock('first password').then(() => 'opened', e => e.code));
  expect(refused).toBe('wrong-password');
  const items = await page.evaluate(async () => { await window.MemoVault.unlock('second password'); return (await window.MemoVault.list()).items.map(i => i.title); });
  expect(items).toEqual(['Bike lock']);
  // Hidden for 5+ minutes locks; a short switch-away does not.
  const lockedAfter = await page.evaluate(() => {
    const realNow = Date.now;
    const hide = (hidden, at) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Date.now = () => at;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const t0 = realNow();
    hide(true, t0); hide(false, t0 + 60000);
    const shortAway = window.MemoVault.isUnlocked();
    hide(true, t0 + 70000); hide(false, t0 + 70000 + window.MemoVault.RELOCK_MS);
    Date.now = realNow;
    return { shortAway, longAway: window.MemoVault.isUnlocked() };
  });
  expect(lockedAfter).toEqual({ shortAway: true, longAway: false });
  // The key never persists: after a reload the vault is locked again.
  await page.reload();
  await page.waitForFunction(() => window.MemoVault && window.MemoStateDb?.ready());
  expect(await page.evaluate(() => [window.MemoVault.exists(), window.MemoVault.isUnlocked()])).toEqual([true, false]);
});

test('AI keys: saved in the Vault, used while locked, old plain keys moved in', async ({ page }) => {
  await boot(page);
  // An older build left a plain-text key behind.
  await page.evaluate(() => { localStorage.setItem('memo_ai_key_provider', 'deepseek'); localStorage.setItem('memo_ai_key_deepseek', 'sk-legacy-123'); });
  expect(await page.evaluate(() => window.MemoAiKey.getActiveKey().key)).toBe('sk-legacy-123');
  await page.evaluate(() => window.MemoVault.setup('a vault password'));
  const after = await page.evaluate(() => ({ plain: localStorage.getItem('memo_ai_key_deepseek'), active: window.MemoAiKey.getActiveKey() }));
  expect(after.plain).toBe(null);
  expect(after.active).toMatchObject({ provider: 'deepseek', key: 'sk-legacy-123', model: 'deepseek-flash' });

  // Add Gemini through the screen and make it the default.
  await page.evaluate(() => window.MemoVaultUi.open());
  await page.click('#vaultDlg [data-act=add-key]');
  // A new key starts on DeepSeek's low-cost Flash model, which also reads photos.
  await expect(page.locator('#vaultDlg select[name=provider]')).toHaveValue('deepseek');
  await expect(page.locator('#vaultDlg input[name=model]')).toHaveAttribute('placeholder', 'deepseek-flash');
  await page.selectOption('#vaultDlg select[name=provider]', 'gemini');
  await page.fill('#vaultDlg input[name=apiKey]', 'AIza-test-key');
  await page.check('#vaultDlg input[name=isDefault]');
  await page.click('#vaultDlg button[type=submit]');
  await expect(page.locator('#vaultDlg .vault-key-row:not(.vault-key-add)')).toHaveCount(2);
  await expect(page.locator('#vaultDlg .vault-key-row').first()).toContainText('Default');
  // A custom provider needs its address.
  await page.click('#vaultDlg [data-act=add-key]');
  await page.selectOption('#vaultDlg select[name=provider]', 'custom');
  await expect(page.locator('#vaultDlg input[name=baseUrl]')).toBeVisible();

  // Locked, the AI still has its key — and it never sits in plain localStorage.
  await page.evaluate(() => window.MemoVault.lock());
  const locked = await page.evaluate(() => ({ active: window.MemoAiKey.getActiveKey(), configured: window.MemoAiKey.isConfigured(),
    plain: Object.keys(localStorage).map(k => localStorage.getItem(k)).join('|') }));
  expect(locked.active).toMatchObject({ provider: 'gemini', key: 'AIza-test-key' });
  expect(locked.configured).toBe(true);
  expect(locked.plain).not.toContain('AIza-test-key');
  expect(JSON.stringify(await vaultDocs(page))).not.toContain('AIza-test-key');
});

test('backups carry the vault still encrypted, and a restore brings it back', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    await window.MemoVault.setup('backup password');
    await window.MemoVault.save({ type: 'note', title: 'Locker', content: 'PIN: 0000' });
  });
  const bundle = await page.evaluate(() => window.MemoStateDb.exportBundle());
  expect(bundle.docs.vault.length).toBe(2);
  expect(JSON.stringify(bundle)).not.toContain('Locker');
  const restored = await page.evaluate(async (b) => {
    window.MemoVault.lock();
    window.MemoStateDb.importBundle({ version: 1, memos: [], finance: [], docs: { vault: [] } }, 'replace');
    const emptied = window.MemoVault.exists();
    window.MemoStateDb.importBundle(b, 'merge');
    await window.MemoVault.unlock('backup password');
    return { emptied, titles: (await window.MemoVault.list()).items.map(i => i.title) };
  }, bundle);
  expect(restored).toEqual({ emptied: false, titles: ['Locker'] });
});

test('the vault syncs only with a server that lists the collection', async ({ page }) => {
  await boot(page);
  const seen = [];
  await page.route('**/sync-test/**', async route => {
    const url = new URL(route.request().url());
    seen.push(url.pathname + (url.searchParams.get('variant') ? '?' + url.searchParams.get('variant') : ''));
    if (url.pathname.endsWith('/api/config')) return route.fulfill({ json: { server: true, authRequired: false } }); // an older server
    if (url.pathname.endsWith('/api/operations/pull')) return route.fulfill({ json: { operations: [], lastOpId: 0, needsFullSync: false } });
    return route.fulfill({ json: { success: true, operations: [] } });
  });
  const collections = await page.evaluate(() => window.OperationQueue.serverCollections(location.origin + '/sync-test'));
  expect(collections).toEqual(['default', 'finance', 'planner']);
  expect(seen.some(p => p.endsWith('?vault'))).toBe(false);
});

test('a new Vault after "Delete Vault" opens with its own password', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(async () => {
    await window.MemoVault.setup('old password');
    await window.MemoVault.save({ type: 'note', title: 'Old', content: 'x' });
    await window.MemoVault.erase();
    const afterErase = window.MemoVault.exists();
    await window.MemoVault.setup('new password');
    window.MemoVault.lock();
    await window.MemoVault.unlock('new password');
    return { afterErase, exists: window.MemoVault.exists(), items: (await window.MemoVault.list()).items.length };
  });
  expect(out).toEqual({ afterErase: false, exists: true, items: 0 });
});
