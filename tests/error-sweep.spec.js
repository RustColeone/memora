// A tour of the main screens that fails on any uncaught exception or console
// error. Requests the static test server cannot answer (/api/…, which a real
// server or sync target would) are expected and left out.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

function watch(page) {
  const problems = [];
  page.on('pageerror', e => problems.push('uncaught: ' + (e && e.stack || e)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource: the server responded with a status of 404/.test(text)) return;   // /api/* on the static test server
    problems.push('console.error: ' + text);
  });
  return problems;
}

test('the main screens run without uncaught errors or console errors', async ({ page }) => {
  test.setTimeout(90000);
  const problems = watch(page);
  await page.route('**://generativelanguage.googleapis.com/**', route => route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello.' }] } }] } }));
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoStateDb?.ready() && window.MemoCore && window.MemoChats && window.MODE !== 'detecting', null, { timeout: 20000 });

  // Memo: add an entry through the form, open it, delete it to the Bin, restore.
  await page.waitForSelector('#fab', { state: 'attached' });
  await page.evaluate(() => document.getElementById('fab').click());
  await page.waitForSelector('#entryDlg[open]');
  await page.fill('#desc', 'Error sweep note #sweep');
  await page.click('#saveBtn');
  await expect(page.locator('#entryDlg')).not.toHaveAttribute('open', '');
  await expect(page.locator('.feed')).toContainText('Error sweep note');

  // Finance, Planner, Discover through the bottom tabs.
  for (const view of ['finance', 'planner', 'discover', 'default']) {
    await page.evaluate(v => document.querySelector('#primaryNav a[data-view="' + v + '"], #primaryNav a[href="#' + v + '"]')?.click(), view);
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => window.MemoShell.handleSystemBack());

  // Vault: set up, add a note, lock.
  await page.evaluate(async () => {
    await window.MemoVault.setup('sweep vault password');
    await window.MemoVault.save({ type: 'note', title: 'Wi-Fi', content: 'PASSWORD: sweep' });
    await window.MemoVault.save({ type: 'ai-key', provider: 'gemini', apiKey: 'AIza-sweep', isDefault: true });
    window.MemoVaultUi.open();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.MemoVault.lock(); document.getElementById('vaultDlg')?.close(); });

  // A chat round trip, then the contact editor and the Me page.
  await page.evaluate(async () => { await window.MemoChats.ensureAssistant(); window.MemoChats.openChat('assistant'); await window.MemoChats.send('assistant', 'hi'); });
  await expect(page.locator('#chatScreen .chat-msg:not(.mine) .chat-bubble').last()).toContainText('Hello.');
  await page.evaluate(() => { window.MemoChats.openEditor('assistant'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.getElementById('chatContactDlg')?.close(); document.getElementById('chatScreen')?.close(); window.MemoChats.openMe(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('meDlg')?.close());

  // Settings, About, the Bin.
  await page.evaluate(() => document.getElementById('settingsDlg').showModal());
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.getElementById('settingsDlg').close(); window.MemoAbout.open(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.getElementById('aboutDlg').close(); document.getElementById('recycleBinBtn')?.click(); });
  await page.waitForTimeout(500);

  expect(problems).toEqual([]);
});
