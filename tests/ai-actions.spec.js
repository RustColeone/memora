// What AI contacts can do (memo-ai-tools.js + memo-chats.js cards). Provider
// calls are mocked with scripted turns: each test says what the "model" asks
// for, and checks what the app ran, showed and saved. Reading needs no tap;
// every change is a card that does nothing until it is tapped.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// A real 1×1 PNG, so the browser can decode and shrink it.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// Gemini mock: `script` is a list of turns; a turn is { call: [name, args] },
// { calls: [[name, args], …] } or { text }. Every request is recorded.
async function mockGemini(page, script) {
  const requests = [];
  await page.route('**://generativelanguage.googleapis.com/**', async route => {
    const body = route.request().postDataJSON();
    body.url = route.request().url();
    requests.push(body);
    const turn = script[Math.min(requests.length - 1, script.length - 1)];
    const calls = turn.calls || (turn.call ? [turn.call] : []);
    const parts = calls.length ? calls.map(([name, args]) => ({ functionCall: { name, args } })) : [{ text: turn.text }];
    await route.fulfill({ json: { candidates: [{ content: { role: 'model', parts } }] } });
  });
  return requests;
}

async function boot(page, { key = 'gemini', model = '' } = {}) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoChats && window.MemoAiTools && window.MemoStateDb?.ready() && window.MemoCore, null, { timeout: 15000 });
  await page.evaluate(async ({ key, model, day }) => {
    window.MemoStateDb.importBundle({ version: 1, finance: [
      { id: 'k1', description: 'Shinkansen ticket', category: 'Travel', tags: ['kyoto'], images: [], ts: Date.now() - 5e6, purchaseDate: day, total: 128 },
      { id: 'k2', description: 'Ryokan Hanaya', category: 'Travel', tags: ['kyoto'], images: [], ts: Date.now() - 4e6, purchaseDate: day, total: 310 },
      { id: 'k3', description: 'Kinokuniya books', category: 'Books', tags: ['kyoto'], images: [], ts: Date.now() - 3e6, purchaseDate: day, total: 41.2 },
      { id: 's1', description: 'Starbucks', category: 'Food', tags: [], images: [], ts: Date.now() - 2e6, purchaseDate: day, total: 5.2 }],
    memos: [
      { id: 'mall', description: 'Mall parking: blue zone, row F', category: 'Car', tags: [], images: [], ts: Date.now() - 86400e3 }] }, 'replace');
    await window.MemoVault.setup('ai spec password');
    await window.MemoVault.save({ type: 'note', title: 'Bank', content: 'PIN: 4242-vault-secret' });
    if (key) await window.MemoVault.save({ type: 'ai-key', provider: key, apiKey: key === 'anthropic' ? 'sk-ant-spec' : 'spec-key', model, isDefault: true });
    await window.MemoChats.ensureAssistant();
  }, { key, model, day: today() });
}
async function ask(page, chatId, text) {
  await page.evaluate(id => { window.__askChat = id; window.MemoChats.openChat(id); }, chatId);
  await page.fill('#chatScreen .chat-input', text);
  await page.keyboard.press('Enter');
  await page.waitForFunction(t => window.MemoChats.messagesFor(window.MemoChats.contacts().length && document.querySelector('#chatScreen') ? window.__askChat : '')
    .some(m => m.role === 'user' && m.text === t) && !window.MemoChats.busy(), text);
}
const finance = page => page.evaluate(() => window.MemoStateDb.loadEntries('finance'));
const memos = page => page.evaluate(() => window.MemoStateDb.loadEntries('default'));
const card = page => page.locator('#chatScreen .act').last();

test('reading needs no tap: search and sums run on the device and leave a quiet trace', async ({ page }) => {
  const requests = await mockGemini(page, [
    { calls: [['spending_summary', { from: today(), to: today(), category: 'travel' }], ['search', { query: 'parking' }]] },
    { text: '$438.00 on travel today. You parked in the blue zone.' }]);
  await boot(page);
  await ask(page, 'assistant', 'What did I spend on travel today, and where did I park?');
  await expect(page.locator('#chatScreen .chat-msg:not(.mine) .chat-bubble').last()).toContainText('$438.00');
  expect(requests[0].url).toContain('/models/gemini-3.8-flash:generateContent');   // the default Gemini model (free tier)
  const tools = requests[0].tools[0].functionDeclarations.map(f => f.name);
  expect(tools).toEqual(expect.arrayContaining(['search', 'get_item', 'spending_summary', 'propose_note', 'propose_purchase', 'propose_reminder', 'propose_move_to_bin']));
  expect(requests[0].tools[0].functionDeclarations[0].parameters.type).toBe('OBJECT');   // Gemini's schema dialect
  // The tool results went back to the model as function responses.
  const answers = requests[1].contents[requests[1].contents.length - 1].parts.map(p => p.functionResponse);
  expect(answers[0].name).toBe('spending_summary');
  expect(answers[0].response.total).toBe(438);
  expect(answers[1].response.items[0].id).toBe('mall');
  // The model's own turn went back unchanged, before the results.
  expect(requests[1].contents[requests[1].contents.length - 2].parts[0].functionCall.name).toBe('spending_summary');
  await expect(page.locator('#chatScreen .chat-trace').last()).toContainText('Added up spending');
  await expect(page.locator('#chatScreen .chat-trace').last()).toContainText('Searched everything');
  await expect(page.locator('#chatScreen .act')).toHaveCount(0);
  expect(JSON.stringify(requests)).not.toContain('4242-vault-secret');
});

test('a new note is a card: nothing is saved until Add, and Undo takes it back', async ({ page }) => {
  await mockGemini(page, [{ call: ['propose_note', { text: 'Parked at B2 pillar 14', category: 'Car' }] }, { text: 'Tap to add it.' }]);
  await boot(page);
  const before = (await memos(page)).length;
  await ask(page, 'assistant', 'note that I parked at B2 pillar 14');
  await expect(card(page)).toContainText('New note');
  await expect(card(page)).toContainText('Parked at B2 pillar 14');
  expect((await memos(page)).length).toBe(before);
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Added · Parked at B2 pillar 14');
  // The finished card keeps its title above the outcome line, inside the card.
  const box = await card(page).evaluate(el => ({ head: el.querySelector('.act-head').getBoundingClientRect().bottom, done: el.querySelector('.act-done').getBoundingClientRect().top,
    undo: el.querySelector('.act-undo').getBoundingClientRect().right, card: el.getBoundingClientRect().right }));
  expect(box.done).toBeGreaterThanOrEqual(box.head - 1);
  expect(box.undo).toBeLessThanOrEqual(box.card);
  const saved = (await memos(page)).find(e => e.description === 'Parked at B2 pillar 14');
  expect(saved && !saved.deletedAt && saved.category === 'Car').toBeTruthy();
  // The card's outcome lives on the message, so other devices see it too.
  const status = await page.evaluate(() => window.MemoChats.messagesFor('assistant').filter(m => m.actions).pop().actions[0].status);
  expect(status).toBe('done');
  expect(await page.evaluate(id => window.OperationQueue.context('default').state.queue.some(op => op.entryId === id && op.type === 'create'), saved.id)).toBe(true);
  await card(page).locator('[data-act=card-undo]').click();
  await expect(card(page).locator('.act-done')).toContainText('Undone');
  expect((await memos(page)).find(e => e.id === saved.id).deletedAt).toBeTruthy();
});

test('organize: the card lists every item; unticked ones are left alone; Undo restores tags', async ({ page }) => {
  await mockGemini(page, [{ call: ['propose_changes', { page: 'spending', ids: ['k1', 'k2', 'k3', 'nope'], add_tags: ['travel'], summary: 'Add tag #travel' }] }, { text: 'Untick anything that is not from the trip.' }]);
  await boot(page);
  await ask(page, 'assistant', 'Tag my Kyoto receipts as travel');
  await expect(card(page).locator('.act-item')).toHaveCount(3);           // the made-up id is dropped
  await expect(card(page).locator('[data-act=card-apply]')).toHaveText('Apply to 3');
  await card(page).locator('.act-item', { hasText: 'Kinokuniya' }).click();
  await expect(card(page).locator('[data-act=card-apply]')).toHaveText('Apply to 2');
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Changed 2');
  const tagsOf = async () => Object.fromEntries((await finance(page)).map(e => [e.id, e.tags]));
  expect(await tagsOf()).toMatchObject({ k1: ['kyoto', 'travel'], k2: ['kyoto', 'travel'], k3: ['kyoto'] });
  await card(page).locator('[data-act=card-undo]').click();
  await expect(card(page).locator('.act-done')).toContainText('Undone');
  expect(await tagsOf()).toMatchObject({ k1: ['kyoto'], k2: ['kyoto'], k3: ['kyoto'] });
});

test('delete only ever goes to the Bin, behind a red button, and Undo restores it', async ({ page }) => {
  await mockGemini(page, [{ call: ['propose_move_to_bin', { page: 'spending', ids: ['s1'], reason: 'Duplicate receipt' }] }, { text: 'Keeping the first one.' }]);
  await boot(page);
  await ask(page, 'assistant', 'Delete the duplicate Starbucks receipt');
  await expect(card(page)).toContainText('Starbucks');
  await expect(card(page).locator('[data-act=card-apply]')).toHaveClass(/act-danger/);
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Moved 1 to the Bin');
  expect((await finance(page)).find(e => e.id === 's1').deletedAt).toBeTruthy();
  await card(page).locator('[data-act=card-undo]').click();
  await expect(card(page).locator('.act-done')).toContainText('Undone');
  expect((await finance(page)).find(e => e.id === 's1').deletedAt).toBeFalsy();
});

test('a reminder becomes a Planner event that alerts at the time; Edit changes the card first', async ({ page }) => {
  await mockGemini(page, [{ call: ['propose_reminder', { what: 'Call the bank', date: today(), time: '15:00' }] }, { text: '' }]);
  await boot(page);
  await ask(page, 'assistant', 'Remind me at 3pm to call the bank');
  await expect(card(page)).toContainText('Reminder');
  await expect(card(page)).toContainText('Call the bank');
  await card(page).locator('[data-act=card-edit]').click();
  await card(page).locator('input[name=title]').fill('Call the bank about the card');
  await card(page).locator('input[name=start]').fill('16:30');
  await card(page).locator('[data-act=card-save]').click();
  await expect(card(page)).toContainText('Call the bank about the card');
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Set');
  const ev = await page.evaluate(() => window.MemoStateDb.loadDocs('planner').find(d => d.title === 'Call the bank about the card'));
  expect(ev).toMatchObject({ kind: 'event', date: today(), start: '16:30', end: '17:00', allDay: false, remindAtStart: true, remindBefore: 0 });
  const alarm = await page.evaluate(() => window.MemoPlannerReminders.events().find(e => e.start === '16:30'));
  expect(alarm.remindBefore).toBe(0);   // the native alarm fires at the start time
});

test('memory goes to the Me page only with a tap, and to-dos can be unticked', async ({ page }) => {
  await mockGemini(page, [
    { calls: [['propose_memory', { fact: 'Vegetarian on weekdays.' }], ['propose_todos', { todos: [{ title: 'Buy tofu' }, { title: 'Buy spinach' }] }]] },
    { text: 'Noted, and here is the list.' }]);
  await boot(page);
  await ask(page, 'assistant', 'Remember I am vegetarian on weekdays, and add tofu and spinach to my list');
  const cards = page.locator('#chatScreen .act');
  await expect(cards).toHaveCount(2);
  expect(await page.evaluate(() => window.MemoChats.me().about || '')).toBe('');
  await cards.nth(0).locator('[data-act=card-apply]').click();
  await expect(cards.nth(0).locator('.act-done')).toContainText('Added to your Me page');
  expect(await page.evaluate(() => window.MemoChats.me().about)).toBe('Vegetarian on weekdays.');
  await cards.nth(1).locator('.act-item', { hasText: 'spinach' }).click();
  await cards.nth(1).locator('[data-act=card-apply]').click();
  const todos = await page.evaluate(() => window.MemoStateDb.loadDocs('planner').filter(d => d.kind === 'todo' && !d.deletedAt).map(d => d.title));
  expect(todos).toEqual(['Buy tofu']);
  await cards.nth(0).locator('[data-act=card-undo]').click();
  await expect(cards.nth(0).locator('.act-done')).toContainText('Undone');
  expect(await page.evaluate(() => window.MemoChats.me().about)).toBe('');
});

test('on the Planner page the chat sheet keeps its own look (full width, plain Undo)', async ({ page }) => {
  await mockGemini(page, [{ call: ['propose_todos', { todos: [{ title: 'Buy tofu' }] }] }, { text: 'Here.' }]);
  await boot(page);
  await page.evaluate(() => window.MemoSpaShell.switchTo('planner'));
  await page.waitForFunction(() => document.querySelector('.planner-page'));
  await ask(page, 'assistant', 'add tofu');
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-undo')).toBeVisible();
  const look = await page.evaluate(() => {
    const dlg = document.getElementById('chatScreen'), undo = dlg.querySelector('.act-undo');
    return { width: dlg.getBoundingClientRect().width, vw: innerWidth, undoBg: getComputedStyle(undo).backgroundColor, undoPad: getComputedStyle(undo).paddingTop };
  });
  expect(Math.round(look.width)).toBe(look.vw);
  expect(look.undoBg).toBe('rgba(0, 0, 0, 0)');
  expect(look.undoPad).toBe('0px');
});

test('a contact gets only the tools its Read and Change ticks allow', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(async () => {
    const T = window.MemoAiTools;
    const mei = { id: 'c_mei', kind: 'contact', name: 'Mei', canRead: { notes: true, spending: true }, canChange: { notes: true, spending: false, plans: true } };
    const ctx = T.context(mei);
    const names = T.specs(ctx).map(s => s.name);
    return {
      names,
      perms: T.perms(mei),
      planSearch: T.exec(ctx, 'search', { page: 'plans', query: 'x' }),
      purchase: T.exec(ctx, 'propose_purchase', { description: 'x', total: 1 }),
      quiet: T.specs(T.context(mei, { canPropose: false })).map(s => s.name),
      oldAssistant: T.perms({ id: 'assistant', canRead: { notes: true, spending: true, plans: true } }).change
    };
  });
  expect(out.names).toEqual(['search', 'get_item', 'spending_summary', 'propose_note', 'propose_changes', 'propose_move_to_bin']);   // no Me change ticked
  expect(out.perms.change.plans).toBe(false);          // Change needs Read
  expect(out.planSearch.error).toBeTruthy();
  expect(out.purchase.error).toMatch(/Unknown tool/);
  expect(out.quiet).toEqual(['search', 'get_item', 'spending_summary']);
  expect(out.oldAssistant).toEqual({ notes: true, spending: true, plans: true, me: true });
  // The editor: Change is off until Read is ticked, and both are saved.
  await page.evaluate(() => window.MemoChats.openEditor(null, 'contact'));
  const dlg = page.locator('#chatContactDlg');
  await dlg.locator('input[name=name]').fill('Chef Bo');
  await expect(dlg.locator('input[name=change_plans]')).toBeDisabled();
  await dlg.locator('input[name=can_plans]').check();
  await dlg.locator('input[name=change_plans]').check();
  await dlg.locator('input[name=can_spending]').uncheck();
  await expect(dlg.locator('input[name=change_spending]')).toBeDisabled();
  await dlg.locator('button[type=submit]').click();
  const saved = await page.evaluate(() => window.MemoChats.contacts().find(c => c.name === 'Chef Bo'));
  expect(saved.canRead).toMatchObject({ notes: true, spending: false, plans: true, me: true });
  expect(saved.canChange).toMatchObject({ notes: false, spending: false, plans: true, me: false });
});

test('in a group only the @mentioned contact may propose; the others just talk', async ({ page }) => {
  const requests = await mockGemini(page, [{ text: 'ok' }]);
  await boot(page);
  await page.evaluate(async () => {
    const add = (id, name) => window.OperationQueue.addOperation('create', id, { data: { id, kind: 'contact', name, persona: '', canRead: { notes: true, plans: true }, canChange: { plans: true } } }, { variant: 'contacts' });
    await add('c_bo', 'Chef Bo'); await add('c_mei', 'Mei');
    await window.OperationQueue.addOperation('create', 'g1', { data: { id: 'g1', kind: 'group', name: 'House crew', members: ['c_bo', 'c_mei'] } }, { variant: 'contacts' });
  });
  await ask(page, 'g1', 'hello all');
  const toolsBy = () => requests.map(r => ({ who: r.systemInstruction.parts[0].text.match(/You are ([^,]+),/)[1], propose: r.tools[0].functionDeclarations.some(f => f.name.startsWith('propose_')) }));
  expect(toolsBy()).toEqual([{ who: 'Chef Bo', propose: true }, { who: 'Mei', propose: false }]);   // nobody named: the first who may change
  requests.length = 0;
  await ask(page, 'g1', '@Mei add tofu to my list');
  expect(toolsBy()).toEqual([{ who: 'Mei', propose: true }]);
});

test('a photo goes to a vision model and the tapped card keeps it with the purchase', async ({ page }) => {
  const requests = await mockGemini(page, [
    { call: ['propose_purchase', { description: 'Menya Kouji', total: 31.85, tax: 5.35, category: 'Food', date: today(), use_photo: true,
      items: [{ name: 'Tonkotsu ramen', amount: 1, unitPrice: 18, totalPrice: 18 }] }] },
    { text: 'A receipt from Menya Kouji.' }]);
  await boot(page);
  await page.evaluate(() => window.MemoChats.openChat('assistant'));
  const png = Buffer.from(PNG, 'base64');
  await page.setInputFiles('#chatScreen .chat-attach-input', { name: 'receipt.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#chatScreen .chat-photo-chip')).toBeVisible();
  await page.fill('#chatScreen .chat-input', 'add this');
  await page.keyboard.press('Enter');
  await expect(card(page)).toContainText('Add purchase from photo');
  await expect(card(page)).toContainText('Photo kept with the item');
  const parts = requests[0].contents[requests[0].contents.length - 1].parts;
  expect(parts.some(p => p.inlineData && p.inlineData.mimeType === 'image/jpeg')).toBe(true);
  await expect(page.locator('#chatScreen .chat-msg.mine .chat-photo')).toBeVisible();
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Added');
  const saved = (await finance(page)).find(e => e.description === 'Menya Kouji');
  expect(saved).toMatchObject({ total: 31.85, tax: 5.35, price: 26.5, category: 'Food', purchaseDate: today() });
  expect(saved._storedPaths[0]).toMatch(/^uploads\/\d{4}-\d{2}-\d{2}\/chat_m_.*\.png$/);
  const op = await page.evaluate(id => window.OperationQueue.context('finance').state.queue.find(o => o.entryId === id), saved.id);
  expect(op.data._filesToUpload).toEqual(saved._storedPaths);   // the photo uploads with the purchase on sync
});

test('Claude: tools go through the official SDK and the assistant turn goes back unchanged', async ({ page }) => {
  const requests = [];
  await page.route('**://api.anthropic.com/**', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (requests.length === 1) {
      await route.fulfill({ json: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'parking' } }] } });
    } else {
      await route.fulfill({ json: { id: 'msg_2', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'Blue zone, row F.' }] } });
    }
  });
  await boot(page, { key: 'anthropic' });
  await ask(page, 'assistant', 'where did I park?');
  await expect(page.locator('#chatScreen .chat-msg:not(.mine) .chat-bubble').last()).toContainText('Blue zone, row F.');
  expect(requests[0].tools.find(t => t.name === 'search').input_schema.type).toBe('object');
  expect(requests[0].temperature).toBeUndefined();
  const [assistantTurn, results] = requests[1].messages.slice(-2);
  expect(assistantTurn.content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig-1' });
  expect(results.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
  expect(JSON.parse(results.content[0].content).items[0].id).toBe('mall');
});

test('OpenAI-compatible keys use tool_calls; a chat-only key gets the photo as words', async ({ page }) => {
  const requests = [];
  await page.route('**://api.deepseek.com/**', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const message = requests.length === 1
      ? { role: 'assistant', content: '', reasoning_content: 'thinking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query":"parking"}' } }] }
      : { role: 'assistant', content: 'Row F.' };
    await route.fulfill({ json: { choices: [{ message }] } });
  });
  await boot(page, { key: 'deepseek', model: 'deepseek-v4-pro' });   // Pro is chat-only; Flash would see the photo
  await page.evaluate(() => window.MemoChats.openChat('assistant'));
  const png = Buffer.from(PNG, 'base64');
  await page.setInputFiles('#chatScreen .chat-attach-input', { name: 'p.png', mimeType: 'image/png', buffer: png });
  await page.fill('#chatScreen .chat-input', 'where did I park?');
  await page.keyboard.press('Enter');
  await expect(page.locator('#chatScreen .chat-msg:not(.mine) .chat-bubble').last()).toContainText('Row F.');
  expect(requests[0].tools[0]).toMatchObject({ type: 'function', function: { name: 'search' } });
  const last = requests[0].messages[requests[0].messages.length - 1];
  expect(typeof last.content).toBe('string');
  expect(last.content).toContain('this AI cannot see photos');
  const follow = requests[1].messages.slice(-2);
  expect(follow[0]).toMatchObject({ role: 'assistant', reasoning_content: 'thinking', tool_calls: [{ id: 'call_1' }] });
  expect(follow[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
});

test('OpenAI reasoning models (gpt-6-luna) call tools with reasoning_effort "none"; older models keep sampling', async ({ page }) => {
  const requests = [];
  await page.route('**://api.openai.com/**', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const message = body.messages.some(m => m.role === 'tool')
      ? { role: 'assistant', content: 'Row F.' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'search', arguments: '{"query":"parking"}' } }] };
    await route.fulfill({ json: { choices: [{ message }] } });
  });
  await boot(page, { key: 'openai' });
  await ask(page, 'assistant', 'where did I park?');
  await expect(page.locator('#chatScreen .chat-msg:not(.mine) .chat-bubble').last()).toContainText('Row F.');
  expect(requests[0]).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'none' });
  expect(requests[0]).not.toHaveProperty('temperature');
  expect(requests[1].messages.slice(-1)[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_9' });
  // A model picked by hand that is not a reasoning model gets no reasoning_effort.
  requests.length = 0;
  await page.evaluate(() => window.OperationQueue.addOperation('update', 'assistant', { data: { model: 'gpt-4o' } }, { variant: 'contacts' }));
  await ask(page, 'assistant', 'and again?');
  expect(requests[0].model).toBe('gpt-4o');
  expect(requests[0]).not.toHaveProperty('reasoning_effort');
});

test('"Your server\'s AI": with no key on the device the Assistant runs each step on the server', async ({ page }) => {
  const steps = [];
  await boot(page, { key: null });
  expect(await page.evaluate(() => window.MemoChats.aiReady())).toBe(false);
  await page.route('**/api/config', route => route.fulfill({ json: { server: true, authRequired: false, collections: ['default', 'finance', 'planner'], ai: { available: true, vision: false } } }));
  await page.route('**/api/ai/step', async route => {
    const body = route.request().postDataJSON();
    steps.push(body);
    await route.fulfill({ json: steps.length === 1
      ? { text: '', calls: [{ id: 'x1', name: 'propose_note', args: { text: 'Server-side idea' } }], raw: { role: 'assistant', tool_calls: [{ id: 'x1' }] } }
      : { text: 'Card ready.', calls: [], raw: null } });
  });
  await page.evaluate(() => window.MemoChats.refreshServerAi());
  await page.waitForFunction(() => window.MemoChats.aiReady());
  await page.evaluate(() => window.MemoChats.ensureAssistant());
  await ask(page, 'assistant', 'save an idea');
  await expect(page.locator('#chatScreen .chat-head-who small')).toContainText('Your server’s AI');
  await expect(card(page)).toContainText('Server-side idea');
  expect(steps[0].tools.some(t => t.name === 'propose_note')).toBe(true);
  expect(steps[1].messages.slice(-2)).toEqual([
    { role: 'assistant', content: '', calls: [{ id: 'x1', name: 'propose_note', args: { text: 'Server-side idea' } }], raw: { role: 'assistant', tool_calls: [{ id: 'x1' }] } },
    { role: 'tool', id: 'x1', name: 'propose_note', result: expect.objectContaining({ ok: true, card: 'a1' }) }]);
  // The card still waits for a tap, and applies on this device like any card.
  expect((await memos(page)).some(e => e.description === 'Server-side idea')).toBe(false);
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Added');
  expect((await memos(page)).some(e => e.description === 'Server-side idea')).toBe(true);
});

// ── Reliability: cards across devices, Undo after later edits, gone items, failures ──
test('the same card applied twice (another device, or again after Undo) makes one item, not two', async ({ page }) => {
  await mockGemini(page, [{ call: ['propose_note', { text: 'One note only' }] }, { text: 'Tap to add.' }]);
  await boot(page);
  await ask(page, 'assistant', 'note this');
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Added');
  // A second device that still showed the card as pending applies it too.
  await page.evaluate(async () => {
    const m = window.MemoChats.messagesFor('assistant').filter(x => x.actions).pop();
    await window.MemoAiTools.apply(m.actions[0], { key: m.id + '_' + m.actions[0].id });
  });
  const copies = async () => (await memos(page)).filter(e => e.description === 'One note only' && !e.deletedAt).length;
  expect(await copies()).toBe(1);
  // Undo, then apply again: the same note comes back, still one.
  await card(page).locator('[data-act=card-undo]').click();
  await expect(card(page).locator('.act-done')).toContainText('Undone');
  expect(await copies()).toBe(0);
  await page.evaluate(async () => {
    const m = window.MemoChats.messagesFor('assistant').filter(x => x.actions).pop();
    await window.MemoAiTools.apply(m.actions[0], { key: m.id + '_' + m.actions[0].id });
  });
  expect(await copies()).toBe(1);
});

test('Undo takes back only what the card did: later edits and other tags stay', async ({ page }) => {
  await mockGemini(page, [{ call: ['propose_changes', { page: 'spending', ids: ['k1'], add_tags: ['travel'], category: 'Trips' }] }, { text: 'Done.' }]);
  await boot(page);
  await ask(page, 'assistant', 'tag the shinkansen ticket');
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Changed 1');
  // Later, by hand: another tag, and a different category.
  await page.evaluate(() => window.OperationQueue.addOperation('update', 'k1', { data: { tags: ['kyoto', 'travel', 'mine'], category: 'Rail' } }, { variant: 'finance' }));
  await card(page).locator('[data-act=card-undo]').click();
  await expect(card(page).locator('.act-done')).toContainText('Undone');
  const k1 = (await finance(page)).find(e => e.id === 'k1');
  expect(k1.tags).toEqual(['kyoto', 'mine']);   // the card's tag is gone, the hand-added one stays
  expect(k1.category).toBe('Rail');              // changed since, so Undo leaves it
});

test('a card whose items are gone by the time it is tapped says so and changes nothing', async ({ page }) => {
  await mockGemini(page, [{ call: ['propose_move_to_bin', { page: 'spending', ids: ['s1'] }] }, { text: 'Card ready.' }]);
  await boot(page);
  await ask(page, 'assistant', 'bin the starbucks one');
  await page.evaluate(() => window.OperationQueue.addOperation('delete', 's1', {}, { variant: 'finance' }));   // deleted elsewhere first
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Nothing to change: those items are gone');
  await expect(card(page).locator('[data-act=card-undo]')).toHaveCount(0);
});

test('a provider failing mid-reply keeps the question, saves no half-made card, and a retry works', async ({ page }) => {
  let calls = 0;
  await page.route('**://generativelanguage.googleapis.com/**', async route => {
    calls++;
    if (calls === 1) return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'propose_note', args: { text: 'Half made' } } }] } }] } });
    if (calls === 2) return route.fulfill({ status: 503, json: { error: { message: 'The model is overloaded.' } } });
    if (calls === 3) return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'propose_note', args: { text: 'Second try' } } }] } }] } });
    return route.fulfill({ json: { candidates: [{ content: { role: 'model', parts: [{ text: 'Here it is.' }] } }] } });
  });
  await boot(page);
  await ask(page, 'assistant', 'save a note');
  await expect(page.locator('#chatScreen .chat-error')).toContainText('overloaded');
  const after = await page.evaluate(() => window.MemoChats.messagesFor('assistant').map(m => m.role + (m.actions ? ':cards' : '')));
  expect(after).toEqual(['user']);
  await expect(page.locator('#chatScreen .act')).toHaveCount(0);
  await ask(page, 'assistant', 'try again');
  await expect(card(page)).toContainText('Second try');
});

test('an outside agent thread shows its cards, has no message box, and a tap applies them', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    // What the server writes for POST /api/agent/v1/proposals (api/agent_routes.py).
    await window.OperationQueue.addOperation('create', 'agent_ab12', { data: { id: 'agent_ab12', kind: 'agent', name: 'Mailbox receipts', avatar: { letter: 'M' } } }, { variant: 'contacts' });
    await window.OperationQueue.addOperation('create', 'm_agent_1', { data: { id: 'm_agent_1', chatId: 'agent_ab12', role: 'assistant', authorId: 'agent_ab12',
      text: 'Found a receipt in your mailbox.', at: Date.now(), createdAt: new Date().toISOString(),
      actions: [{ id: 'a1', status: 'pending', type: 'create', page: 'spending', items: [{ description: 'Menya Kouji', total: 31.85, tax: 0, category: 'Food', purchaseDate: '2026-10-17', tags: [], items: [] }] }] } }, { variant: 'messages' });
    window.MemoChats.openChat('agent_ab12');
  });
  await expect(page.locator('#chatScreen .chat-head-who small')).toHaveText('Outside agent');
  await expect(page.locator('#chatScreen .chat-input')).toHaveCount(0);
  await expect(page.locator('#chatScreen .chat-agent-note')).toContainText('nothing changes until you tap one');
  await expect(card(page)).toContainText('Menya Kouji');
  expect((await finance(page)).some(e => e.description === 'Menya Kouji')).toBe(false);
  await card(page).locator('[data-act=card-apply]').click();
  await expect(card(page).locator('.act-done')).toContainText('Added');
  expect((await finance(page)).find(e => e.description === 'Menya Kouji')).toMatchObject({ total: 31.85, category: 'Food' });
  expect(await page.evaluate(() => window.MemoChats.contacts().some(c => c.kind === 'agent'))).toBe(true);
});

