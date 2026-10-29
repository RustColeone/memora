// Personal client-side AI key (memo-ai-key.js / memo-ai-client.js) — lets a user
// call OpenAI/Gemini/DeepSeek directly from the browser/app with no sync server.
// No real network/keys are used here: provider endpoints are mocked via page.route().
const { test, expect } = require('@playwright/test');

async function waitForBoot(page) {
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready() && window.MemoCore && window.MemoAiKey && window.MemoAiClient,
    null,
    { timeout: 15000 }
  );
}

async function openSettings(page) {
  await page.evaluate(() => document.getElementById('mobileSettingsBtn').click());
  await page.waitForFunction(() => document.getElementById('settingsDlg').open, null, { timeout: 5000 });
  await page.evaluate(() => {
    const sec = document.getElementById('clientAiKeySection');
    if (sec) sec.classList.remove('collapsed');
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await waitForBoot(page);
  await page.evaluate(() => window.MemoAiKey.clearAll());
});

test('Settings points personal AI keys to the Vault and shows the default key', async ({ page }) => {
  await openSettings(page);
  await expect(page.locator('#clientAiKeySection')).toBeVisible();
  await expect(page.locator('#clientAiKeySection input[type=password]')).toHaveCount(0); // no plain-text key fields any more
  await expect(page.locator('#clientAiKeyStatus')).toContainText('No AI key yet');
  await page.evaluate(() => document.getElementById('settingsDlg').close());
  await page.evaluate(async () => {
    await window.MemoVault.setup('settings test pw');
    await window.MemoVault.save({ type: 'ai-key', provider: 'gemini', apiKey: 'AIza-x', isDefault: true });
  });
  await openSettings(page);
  await expect(page.locator('#clientAiKeyStatus')).toContainText('Gemini');
  await page.click('#openVaultAiKeys');
  await expect(page.locator('#vaultDlg')).toHaveAttribute('open', '');
  await expect(page.locator('#settingsDlg')).not.toHaveAttribute('open', '');
});

test('MemoAiKey.supportsVision matches the server vision_capable rule', async ({ page }) => {
  const result = await page.evaluate(() => ({
    openai: window.MemoAiKey.supportsVision('openai'),
    gemini: window.MemoAiKey.supportsVision('gemini'),
    deepseek: window.MemoAiKey.supportsVision('deepseek'),                    // default model: deepseek-flash
    deepseekFlash: window.MemoAiKey.supportsVision('deepseek', 'deepseek-flash'),
    deepseekPro: window.MemoAiKey.supportsVision('deepseek', 'deepseek-v4-pro'),
    anthropic: window.MemoAiKey.supportsVision('anthropic'),
    custom: window.MemoAiKey.supportsVision('custom', 'llava'),
  }));
  expect(result).toEqual({ openai: true, gemini: true, deepseek: true, deepseekFlash: true, deepseekPro: false, anthropic: true, custom: false });
});

async function openEntryModal(page) {
  // The FAB sits fixed at the viewport's bottom-right corner; headless Edge's
  // hit-testing at that exact corner is unreliable, so click it via the DOM
  // directly (same approach openSettings() above uses) rather than page.click().
  await page.evaluate(() => document.getElementById('fab').click());
  await page.waitForSelector('#entryDlg[open]');
}

async function closeEntryModal(page) {
  await page.click('#cancelBtn');
  await page.waitForFunction(() => !document.getElementById('entryDlg').open);
}

test('OCR bar appears for a key that reads photos with no server, and disables for a chat-only key', async ({ page }) => {
  // No key configured: bar stays hidden even though the modal opens fine.
  await openEntryModal(page);
  await expect(page.locator('#ocrBarRow')).toBeHidden();
  await closeEntryModal(page);

  // OpenAI key configured: bar visible, button enabled.
  await page.evaluate(() => {
    window.MemoAiKey.setProvider('openai');
    window.MemoAiKey.setKey('openai', 'sk-test');
  });
  await openEntryModal(page);
  await expect(page.locator('#ocrBarRow')).toBeVisible();
  await expect(page.locator('#ocrAnalyseBtn')).toBeEnabled();
  await closeEntryModal(page);

  // DeepSeek's default (Flash) reads photos too.
  await page.evaluate(() => {
    window.MemoAiKey.setProvider('deepseek');
    window.MemoAiKey.setKey('deepseek', 'sk-test-ds');
  });
  await openEntryModal(page);
  await expect(page.locator('#ocrAnalyseBtn')).toBeEnabled();
  await closeEntryModal(page);

  // DeepSeek Pro is chat-only: bar visible, but the analyse button is disabled.
  await page.evaluate(async () => {
    await window.MemoVault.setup('ocr test password');
    await window.MemoVault.save({ type: 'ai-key', provider: 'deepseek', apiKey: 'sk-test-pro', model: 'deepseek-v4-pro', isDefault: true });
  });
  await openEntryModal(page);
  await expect(page.locator('#ocrBarRow')).toBeVisible();
  await expect(page.locator('#ocrAnalyseBtn')).toBeDisabled();
  await expect(page.locator('#ocrStatusText')).toHaveText('(This key is chat-only)');
});

test('MemoAiClient response parser matches server _parse_llm_response fidelity', async ({ page }) => {
  const fenced = await page.evaluate(() => window.MemoAiClient._parseAnalyzeResponse(
    '```json\n{"description":"Test desc","category":"Work","tags":["a","b"]}\n```',
    'default'
  ));
  expect(fenced).toEqual({ description: 'Test desc', category: 'Work', tags: ['a', 'b'] });

  const missingFields = await page.evaluate(() => window.MemoAiClient._parseAnalyzeResponse('{}', 'default'));
  expect(missingFields).toEqual({ description: 'Analyzed content', category: 'Uncategorized', tags: [] });

  const invalidJson = await page.evaluate(() => window.MemoAiClient._parseAnalyzeResponse('not json at all', 'default'));
  expect(invalidJson).toEqual({ description: 'File uploaded - LLM analysis pending', category: 'Uncategorized', tags: ['needs-review'] });

  const financeDefaults = await page.evaluate(() => window.MemoAiClient._parseAnalyzeResponse('{}', 'finance'));
  expect(financeDefaults).toEqual({
    description: 'Analyzed content', category: 'Uncategorized', tags: [],
    purchaseDate: '', price: 0, tax: 0, total: 0, adjustment: 0, items: [],
  });

  const financeItems = await page.evaluate(() => window.MemoAiClient._parseAnalyzeResponse(JSON.stringify({
    description: 'Groceries', category: 'Groceries', tags: ['food'],
    purchaseDate: '2025-01-15', price: 45.5, tax: 3.64, total: 49.14,
    items: [
      { name: 'Apples', description: '', amount: 2, unitPrice: 3.99, totalPrice: 7.98 },
      'not-an-object',
      42,
      { name: 'Milk', amount: 'bad', unitPrice: 4.49, totalPrice: 4.49 },
    ],
  }), 'finance'));
  expect(financeItems.items).toEqual([
    { name: 'Apples', description: '', amount: 2, unitPrice: 3.99, totalPrice: 7.98 },
    { name: 'Milk', description: '', amount: 1, unitPrice: 4.49, totalPrice: 4.49 },
  ]);
});

test('MemoAiClient.analyzeImages() rejects a chat-only key (DeepSeek Pro)', async ({ page }) => {
  await page.evaluate(async () => {
    await window.MemoVault.setup('analyze test password');
    await window.MemoVault.save({ type: 'ai-key', provider: 'deepseek', apiKey: 'sk-ds-test', model: 'deepseek-v4-pro', isDefault: true });
  });
  const errorMsg = await page.evaluate(async () => {
    try {
      await window.MemoAiClient.analyzeImages([], '', 'default');
      return null;
    } catch (e) { return e.message; }
  });
  expect(errorMsg).toContain('chat-only');
});

test('MemoAiClient.chat() builds the OpenAI request shape and parses the reply', async ({ page }) => {
  await page.evaluate(() => {
    window.MemoAiKey.setProvider('openai');
    window.MemoAiKey.setKey('openai', 'sk-test-key');
  });

  let capturedBody = null;
  let capturedAuth = null;
  await page.route('**://api.openai.com/**', async (route) => {
    capturedBody = route.request().postDataJSON();
    capturedAuth = route.request().headers()['authorization'];
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Mocked reply!' } }] }),
    });
  });

  const reply = await page.evaluate(() => window.MemoAiClient.chat(
    [{ role: 'user', content: 'earlier message' }, { role: 'assistant', content: 'earlier reply' }],
    'What did I just say?',
    "ID=1 | date=2025-01-01 | ts=123 | category=Test | tags= | desc='hi'"
  ));

  expect(reply).toBe('Mocked reply!');
  expect(capturedAuth).toBe('Bearer sk-test-key');
  expect(capturedBody.model).toBe('gpt-6-luna');               // the default OpenAI model
  // A reasoning model: no temperature, and max_completion_tokens instead of max_tokens.
  expect(capturedBody).not.toHaveProperty('temperature');
  expect(capturedBody).not.toHaveProperty('max_tokens');
  expect(capturedBody.max_completion_tokens).toBe(1500);
  expect(capturedBody.messages[0].role).toBe('system');
  expect(capturedBody.messages[0].content).toContain('User-selected context entries');
  expect(capturedBody.messages[capturedBody.messages.length - 1]).toEqual({ role: 'user', content: 'What did I just say?' });
});

test('MemoAiClient.analyzeImages() builds the Gemini request shape and parses the reply', async ({ page }) => {
  await page.evaluate(() => {
    window.MemoAiKey.setProvider('gemini');
    window.MemoAiKey.setKey('gemini', 'gem-test-key');
  });

  let capturedBody = null;
  let capturedUrl = '';
  await page.route('**generativelanguage.googleapis.com**', async (route) => {
    capturedUrl = route.request().url();
    capturedBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"description":"A scanned photo","category":"Personal","tags":["x"]}' }] } }],
      }),
    });
  });

  const result = await page.evaluate(async () => {
    // 1x1 transparent PNG — just enough to exercise the File -> base64 path.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const file = new File([arr], 'test.png', { type: 'image/png' });
    return window.MemoAiClient.analyzeImages([file], 'Analyse this', 'default');
  });

  expect(result).toEqual({ description: 'A scanned photo', category: 'Personal', tags: ['x'] });
  expect(capturedUrl).toContain('key=gem-test-key');
  expect(capturedBody.systemInstruction.parts[0].text).toContain('reads, transcribes');
  expect(capturedBody.contents[0].parts[0].text).toBe('Analyse this');
  expect(capturedBody.contents[0].parts[1].inlineData.mimeType).toBe('image/png');
});

test('finance.html also renders the client AI key section', async ({ page }) => {
  await page.goto('/finance.html');
  await page.waitForFunction(
    () => window.MemoAiKey && document.getElementById('clientAiKeySection'),
    null, { timeout: 15000 }
  );
  await openSettings(page);
  await expect(page.locator('#clientAiKeySection')).toBeVisible();
  await expect(page.locator('#openVaultAiKeys')).toBeVisible();
});

test('Claude and custom keys from the Vault: request shapes, and a contact can pick its key', async ({ page }) => {
  const calls = [];
  await page.route('**://api.anthropic.com/**', async (route) => {
    calls.push({ url: route.request().url(), headers: route.request().headers(), body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Hi from Claude' }] }) });
  });
  await page.route('**://llm.example.test/**', async (route) => {
    calls.push({ url: route.request().url(), headers: route.request().headers(), body: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'Hi from custom' } }] }) });
  });
  const replies = await page.evaluate(async () => {
    await window.MemoVault.setup('ai test password');
    const claude = await window.MemoVault.save({ type: 'ai-key', provider: 'anthropic', apiKey: 'sk-ant-test', isDefault: true });
    const custom = await window.MemoVault.save({ type: 'ai-key', provider: 'custom', apiKey: 'sk-custom', baseUrl: 'https://llm.example.test/v1/', model: 'my-model' });
    await window.MemoVault.setDefaultAiKey(claude);
    window.MemoVault.lock();
    const a = await window.MemoAiClient.chat([{ role: 'assistant', content: 'earlier reply' }], 'Hello', '', { system: 'Be Mei.' });
    const b = await window.MemoAiClient.chat([], 'Hello custom', '', { keyId: custom });
    return [a, b];
  });
  expect(replies).toEqual(['Hi from Claude', 'Hi from custom']);
  const [claudeCall, customCall] = calls;
  // The official SDK: the person's key, browser access, the default refusal fallback.
  expect(claudeCall.headers['x-api-key']).toBe('sk-ant-test');
  expect(claudeCall.headers['anthropic-version']).toBe('2023-06-01');
  expect(claudeCall.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  expect(claudeCall.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
  expect(claudeCall.body.fallbacks).toBe('default');
  expect(claudeCall.body.model).toBe('claude-sonnet-5-5');   // the default Claude model
  expect(claudeCall.body.max_tokens).toBe(16000);
  expect(claudeCall.body).not.toHaveProperty('temperature');   // current models reject sampling params
  expect(claudeCall.body.system).toBe('Be Mei.');
  // A leading assistant turn is dropped: Claude conversations start with the user.
  expect(claudeCall.body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  expect(customCall.url).toBe('https://llm.example.test/v1/chat/completions');
  expect(customCall.headers.authorization).toBe('Bearer sk-custom');
  expect(customCall.body.model).toBe('my-model');
});
