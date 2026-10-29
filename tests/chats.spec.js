// AI contacts, groups and the Me profile (memo-chats.js). Provider calls are
// mocked: the mock answers as whichever contact the system prompt names.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function boot(page, { key = true } = {}) {
  const calls = [];
  await page.route('**://generativelanguage.googleapis.com/**', async route => {
    const body = route.request().postDataJSON();
    const system = body.systemInstruction.parts[0].text;
    const name = system.match(/You are ([^,]+),/)[1];
    calls.push({ name, system, contents: body.contents });
    await route.fulfill({ json: { candidates: [{ content: { parts: [{ text: name + ' says hi' }] } }] } });
  });
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoChats && window.MemoStateDb?.ready() && window.MemoCore, null, { timeout: 15000 });
  await page.evaluate(async (withKey) => {
    window.MemoStateDb.importBundle({ version: 1, finance: [
      { id: 'f1', description: 'Ramen night', category: 'Food', tags: [], images: [], ts: Date.now(), purchaseDate: new Date().toISOString().slice(0, 10), total: 42.5 }],
    memos: [
      { id: 'mall', description: 'Mall parking: blue zone, row F', category: 'Car', tags: [], images: [], ts: Date.now() - 86400e3 },
      { id: 'cake', description: 'Birthday cake recipe', category: 'Food', tags: [], images: [], ts: Date.now() - 2 * 86400e3 }] }, 'replace');
    await window.MemoVault.setup('chat spec password');
    await window.MemoVault.save({ type: 'note', title: 'Bank', content: 'PIN: 9999-vault-secret' });
    if (withKey) await window.MemoVault.save({ type: 'ai-key', provider: 'gemini', apiKey: 'AIza-spec', isDefault: true });
  }, key);
  return calls;
}
async function addContact(page, fields) {
  return page.evaluate(async (f) => {
    const id = 'c_' + f.name.toLowerCase().replace(/\W/g, '');
    await window.OperationQueue.addOperation('create', id, { data: Object.assign({ id, kind: 'contact', persona: '', keyId: null, model: '',
      canRead: { notes: true, spending: true, plans: true }, avatar: { color: '#7aa2ff' } }, f) }, { variant: 'contacts' });
    return id;
  }, fields);
}

test('Assistant appears with an AI key, and the old chat history moves in once', async ({ page }) => {
  await boot(page, { key: false });
  await page.evaluate(() => window.MemoStateDb.setItem('chat_default', [
    { id: 'o1', role: 'user', content: 'old question', ts: '2026-01-02T10:00:00Z' },
    { id: 'o2', role: 'assistant', content: 'old answer', ts: '2026-01-02T10:00:05Z' }]));
  await page.evaluate(() => window.MemoChats.ensureAssistant());
  expect(await page.evaluate(() => window.MemoChats.contacts().length)).toBe(0);
  await page.evaluate(async () => {
    await window.MemoVault.save({ type: 'ai-key', provider: 'gemini', apiKey: 'AIza-late', isDefault: true });
    await window.MemoChats.ensureAssistant();
    await window.MemoChats.ensureAssistant();
  });
  const out = await page.evaluate(() => ({ contacts: window.MemoChats.contacts().map(c => c.name),
    thread: window.MemoChats.messagesFor('assistant').map(m => m.role + ':' + m.text) }));
  expect(out).toEqual({ contacts: ['Assistant'], thread: ['user:old question', 'assistant:old answer'] });
  // The old Chat button opens the Assistant thread.
  await page.evaluate(() => document.getElementById('chatBtn')?.click());
  await expect(page.locator('#chatScreen')).toHaveAttribute('open', '');
  await expect(page.locator('#chatScreen .chat-bubble')).toHaveCount(2);
});

test('a reply is built from Memora rules, Me, the personality, and only what the contact may read', async ({ page }) => {
  const calls = await boot(page);
  await page.evaluate(async () => {
    await window.OperationQueue.addOperation('create', 'me', { data: { id: 'me', kind: 'me', name: 'Leo', about: 'Lives in Vancouver.', instructions: 'Use metric.' } }, { variant: 'contacts' });
  });
  const mei = await addContact(page, { name: 'Mei', persona: 'A clumsy but devoted maid.', canRead: { notes: true, spending: false, plans: false } });
  await page.evaluate(id => window.MemoChats.openChat(id), mei);
  await page.fill('#chatScreen .chat-input', 'Where did I park at the mall? And what about ramen?');
  await page.keyboard.press('Enter');
  await expect(page.locator('#chatScreen .chat-msg:not(.mine) .chat-bubble')).toContainText('Mei says hi');
  const system = calls[0].system;
  expect(system).toContain('Never invent notes');
  expect(system).toContain('Leo');
  expect(system).toContain('Lives in Vancouver.');
  expect(system).toContain('Use metric.');
  expect(system).toContain('A clumsy but devoted maid.');
  expect(system).toContain('Mall parking: blue zone, row F');
  expect(system).not.toContain('Ramen night');       // spending is off for Mei
  expect(system).not.toContain('9999-vault-secret'); // the Vault never goes to an AI
  // The matched note is offered as a reference under the reply.
  await expect(page.locator('#chatScreen .chat-ref')).toContainText('Mall parking');
  // Both messages are documents in the synced messages collection.
  const queued = await page.evaluate(() => window.OperationQueue.context('messages').state.queue.length);
  expect(queued).toBe(2);
});

test('groups: everyone answers once in turn, an @mention picks one, others read as named turns', async ({ page }) => {
  const calls = await boot(page);
  const a = await addContact(page, { name: 'Chef Bo' });
  const b = await addContact(page, { name: 'Mei' });
  await page.evaluate(async ([x, y]) => {
    await window.OperationQueue.addOperation('create', 'g_crew', { data: { id: 'g_crew', kind: 'group', name: 'House crew', members: [x, y] } }, { variant: 'contacts' });
    await window.MemoChats.send('g_crew', 'What should I cook tonight?');
  }, [a, b]);
  expect(calls.map(c => c.name)).toEqual(['Chef Bo', 'Mei']);
  // Mei saw Chef Bo's reply as a named user turn, not as her own words.
  const meiTurns = calls[1].contents.map(c => c.role + ':' + c.parts[0].text);
  expect(meiTurns).toContain('user:Chef Bo: Chef Bo says hi');
  expect(calls[1].system).toContain('group chat named "House crew"');
  await page.evaluate(() => window.MemoChats.send('g_crew', '@Mei can you help?'));
  expect(calls.map(c => c.name)).toEqual(['Chef Bo', 'Mei', 'Mei']);
  const thread = await page.evaluate(() => window.MemoChats.messagesFor('g_crew').map(m => m.authorId));
  expect(thread).toEqual(['me', a, b, 'me', b]);
});

test('Discover lists at most 5 recent chats and every contact; Me shows at the top of the menu', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    await window.MemoChats.ensureAssistant();
    for (let i = 0; i < 7; i++) {
      const id = 'c' + i;
      await window.OperationQueue.addOperation('create', id, { data: { id, kind: 'contact', name: 'Friend ' + i, canRead: {} } }, { variant: 'contacts' });
      await window.OperationQueue.addOperation('create', 'm' + i, { data: { chatId: id, role: 'user', authorId: 'me', text: 'hi ' + i, at: Date.now() + i } }, { variant: 'messages' });
    }
    window.MemoDiscover.open();
  });
  await expect(page.locator('.chat-row')).toHaveCount(5);
  await expect(page.locator('.chat-row').first()).toContainText('Friend 6');
  await expect(page.locator('.chat-person:not(.chat-person-new)')).toHaveCount(8); // Assistant + 7
  await page.evaluate(() => window.MemoDiscover.close());
  await page.evaluate(() => window.MemoChats.openMe());
  await page.fill('#meDlg input[name=name]', 'Leo');
  await page.click('#meDlg button[type=submit]');
  await page.click('#hamburgerBtn');
  await expect(page.locator('#mobileMenu .menu-profile')).toContainText('Leo');
  await page.click('#mobileMenu .menu-profile');
  await expect(page.locator('#meDlg')).toHaveAttribute('open', '');
});

test('contacts and messages travel in backups', async ({ page }) => {
  await boot(page);
  const id = await addContact(page, { name: 'Mei' });
  await page.evaluate(i => window.MemoChats.send(i, 'hello'), id);
  const bundle = await page.evaluate(() => window.MemoStateDb.exportBundle());
  expect(bundle.docs.contacts.map(c => c.name)).toContain('Mei');
  expect(bundle.docs.messages.map(m => m.text)).toEqual(expect.arrayContaining(['hello', 'Mei says hi']));
});
