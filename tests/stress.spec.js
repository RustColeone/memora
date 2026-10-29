// Stress: large libraries and fast repeated actions. Budgets are generous
// (they catch "seconds", not "milliseconds"), so the suite stays steady on a
// busy machine.
const { test, expect } = require('@playwright/test');
test.describe.configure({ timeout: 120000 });

async function bootMemo(page, path = '/index.html') {
  await page.goto(path);
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready() && window.MemoVariant && (window.MemoAppReady || window.MemoFinanceEntry), null, { timeout: 20000 });
  await page.evaluate(() => window.MemoAppReady);
}

test('5,000 memos: the feed opens fast, search finds one, and all come back after a reload', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await bootMemo(page);
  const t = await page.evaluate(async () => {
    const cats = ['Work', 'Home', 'Travel', 'Ideas', 'Receipts'];
    const memos = Array.from({ length: 5000 }, (_, i) => ({ id: 's' + i, description: (i === 4321 ? 'needle-4321 ' : '') + 'Note number ' + i + ' about ' + cats[i % 5].toLowerCase(),
      category: i % 5 === 0 && i !== 4321 ? cats[(i / 5) % 5 | 0] : '', tags: ['t' + (i % 40)], images: [], attachments: [], ts: Date.now() - i * 60000 }));
    let t0 = performance.now();
    window.MemoStateDb.importBundle({ version: 1, memos, finance: [], planner: [] }, 'replace');
    await window.MemoStateDb.flush();
    const save = performance.now() - t0;
    const st = window.MemoCore.getState();
    st.db.entries = window.MemoStateDb.loadEntries('default');
    st.settings.timeSplit = { enabled: false, period: 'month' };
    const select = document.getElementById('categoryFilter'); if (select) select.value = '__ALL__';
    t0 = performance.now();
    window.MemoVariant.renderFeed();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const render = performance.now() - t0;
    return { save, render, cards: document.querySelectorAll('#feed .card[data-id]').length };
  });
  await page.waitForFunction(() => document.querySelectorAll('#feed .card[data-id]').length > 0, null, { timeout: 10000 });
  t.cards = await page.locator('#feed .card[data-id]').count();
  console.log('memo 5k', JSON.stringify(t));
  expect(t.render).toBeLessThan(1500);
  expect(t.cards).toBeLessThanOrEqual(120);           // drawn in windows, not all 5,000
  const box = page.locator('#searchBox');
  if (!(await box.isVisible())) await page.click('#searchToggleBtn');
  const t0 = Date.now();
  await box.fill('needle-4321');
  await expect(page.locator('#feed .card[data-id]')).toHaveCount(1, { timeout: 5000 });
  const searchMs = Date.now() - t0;
  console.log('search ms', searchMs);
  expect(searchMs).toBeLessThan(3000);
  await page.reload();
  await page.waitForFunction(() => window.MemoCore && window.MemoAppReady, null, { timeout: 20000 });
  await page.evaluate(() => window.MemoAppReady);
  await page.waitForFunction(() => window.MemoCore.getState().db.entries.length === 5000, null, { timeout: 20000 });
  expect(errors).toEqual([]);
});

test('3,000 purchases with lines: the list draws in windows and the totals add up', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await bootMemo(page, '/finance.html');
  const r = await page.evaluate(async () => {
    const day = (i) => { const d = new Date(2026, 9, 20); d.setDate(d.getDate() - (i % 365)); return d.toISOString().slice(0, 10); };
    let sum = 0;
    const finance = Array.from({ length: 3000 }, (_, i) => {
      const items = Array.from({ length: 1 + (i % 6) }, (_, k) => ({ name: 'Item ' + k, amount: 1 + (k % 3), unitPrice: 1.25 + k, totalPrice: (1 + (k % 3)) * (1.25 + k) }));
      const total = Math.round(items.reduce((s, x) => s + x.totalPrice, 0) * 100) / 100;
      sum += total;
      return { id: 'f' + i, description: 'Shop ' + i, category: ['Groceries', 'Transport', 'Books'][i % 3], sheet: 'General', tags: [], images: [], attachments: [],
        purchaseDate: day(i), items, total, ts: Date.now() - i * 1000, details: { store: 'Store ' + (i % 50) } };
    });
    window.MemoStateDb.importBundle({ version: 1, memos: [], finance, planner: [] }, 'replace');
    await window.MemoStateDb.flush();
    const st = window.MemoCore.getState();
    st.db.entries = window.MemoStateDb.loadEntries('finance');
    const t0 = performance.now();
    window.MemoVariant.renderFeed();
    const render = performance.now() - t0;
    const stored = st.db.entries.reduce((s, e) => s + Number(e.total || 0), 0);
    return { render, rows: document.querySelectorAll('tr.entry-row').length, sum: Math.round(sum * 100) / 100, stored: Math.round(stored * 100) / 100, count: st.db.entries.length };
  });
  console.log('finance 3k', JSON.stringify(r));
  expect(r.count).toBe(3000);
  expect(r.stored).toBe(r.sum);
  expect(r.render).toBeLessThan(2000);
  expect(r.rows).toBeGreaterThan(0);
  expect(r.rows).toBeLessThan(3000);
  expect(errors).toEqual([]);
});

test('a full Planner year: every tab draws quickly and reminders stay bounded', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/planner.html');
  await page.waitForSelector('#todayBody .pl-card', { timeout: 20000 });
  await page.evaluate(async () => {
    const S = Planner.Store, D = S.Dates, today = new Date();
    const iso = (n) => D.iso(D.addDays(today, n));
    const docs = [];
    const reps = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
    for (let i = 0; i < 1500; i++) {
      const rep = i < 300 ? reps[i % 5] : '';
      docs.push({ id: 'ev' + i, kind: 'event', title: 'Event ' + i, date: iso((i % 365) - 180), start: String(8 + (i % 10)).padStart(2, '0') + ':00', end: String(9 + (i % 10)).padStart(2, '0') + ':00',
        repeat: rep, repeatUntil: rep && i % 3 === 0 ? iso(200) : '', remindBefore: i % 4 === 0 ? 10 : 0, color: S.COLORS[i % S.COLORS.length] });
    }
    for (let i = 0; i < 800; i++) docs.push({ id: 'td' + i, kind: 'todo', title: 'Task ' + i, due: i % 5 === 0 ? '' : iso((i % 60) - 20), done: i % 7 === 0, priority: i % 9 === 0 ? 'high' : 'normal' });
    for (let i = 0; i < 60; i++) docs.push({ id: 'pj' + i, kind: 'project', name: 'Project ' + i, start: iso(-30 + i), end: iso(30 + i * 3), color: S.COLORS[i % S.COLORS.length],
      milestones: Array.from({ length: 10 }, (_, k) => ({ id: 'm' + i + '-' + k, title: 'Step ' + k, due: iso(-30 + i + k * 6), done: k < 3 })) });
    for (let i = 0; i < 40; i++) docs.push({ id: 'hb' + i, kind: 'habit', name: 'Habit ' + i, type: ['check', 'count', 'timer'][i % 3], color: S.COLORS[i % S.COLORS.length],
      logs: Array.from({ length: 365 }, (_, k) => ({ date: iso(-k), count: k % 2 ? 1 : 0, durationMin: 10 })).filter((l) => l.count) });
    window.MemoStateDb.saveDocs('planner', docs);
    await window.MemoStateDb.flush();
  });
  await page.reload();
  await page.waitForSelector('#todayBody .pl-card', { timeout: 20000 });
  const times = {};
  for (const tab of ['today', 'calendar', 'todos', 'projects', 'habits']) {
    const t0 = Date.now();
    await page.click('#plTab-' + tab);
    await expect(page.locator('#plPanel-' + tab)).toBeVisible();
    times[tab] = Date.now() - t0;
  }
  console.log('planner tab ms', JSON.stringify(times));
  for (const [tab, ms] of Object.entries(times)) expect(ms, tab).toBeLessThan(2500);
  // Flip through two years of months.
  await page.click('#plTab-calendar');
  await page.evaluate(() => { Planner.Store.state.ui.calRange = 'month'; Planner.Store.persist(); Planner.Store.emit('change'); });
  const nav = await page.evaluate(async () => {
    const next = document.querySelector('#plPanel-calendar .cal-nav button:last-child, #calNext');
    const t0 = performance.now();
    for (let i = 0; i < 24; i++) { next.click(); await new Promise((r) => requestAnimationFrame(r)); }
    return performance.now() - t0;
  });
  console.log('24 months ms', Math.round(nav));
  expect(nav).toBeLessThan(8000);
  const rem = await page.evaluate(() => {
    const t0 = performance.now();
    const list = window.MemoPlannerReminders ? window.MemoPlannerReminders.events() : [];
    return { ms: performance.now() - t0, total: list.length, unique: new Set(list.map((x) => x.id)).size,
      max: Math.max(0, ...list.map((x) => (x.dates || [x.date]).length)) };
  });
  console.log('reminders', JSON.stringify(rem));
  expect(rem.max).toBeLessThanOrEqual(40);
  expect(rem.unique).toBe(rem.total);   // one alarm per event
  expect(rem.ms).toBeLessThan(2000);
  expect(errors).toEqual([]);
});

test('fast hands: 100 tab switches, 30 dialog open/close by tapping outside, 30 quick deletes', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/planner.html');
  await page.waitForSelector('#todayBody .pl-card', { timeout: 20000 });
  const tabs = ['today', 'calendar', 'todos', 'projects', 'habits'];
  for (let i = 0; i < 100; i++) await page.click('#plTab-' + tabs[i % 5], { delay: 0 });
  await expect(page.locator('#plTab-habits')).toHaveAttribute('aria-selected', 'true');
  expect(await page.locator('.pl-panels > .pl-panel:not([hidden])').count()).toBe(1);

  await page.click('#plTab-calendar');
  for (let i = 0; i < 30; i++) {
    await page.click('#calAddBtn');
    await expect(page.locator('#eventDlg')).toHaveAttribute('open', '');
    await page.mouse.click(195, 12);
    await expect(page.locator('#eventDlg')).not.toHaveAttribute('open', '');
  }
  expect(await page.evaluate(() => document.querySelectorAll('dialog[open]').length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains('dialog-open'))).toBe(false);

  await page.evaluate(() => { for (let i = 0; i < 30; i++) Planner.Store.addTodo({ title: 'Quick ' + i, due: '' }); });
  await page.click('#plTab-todos');
  for (let i = 0; i < 30; i++) {
    await page.locator('#todoList .todo-item', { hasText: 'Quick ' + i }).first().locator('.todo-main').click();
    await page.click('#tdEdDel');
  }
  await expect(page.locator('#todoList .todo-item', { hasText: 'Quick' })).toHaveCount(0);
  const r = await page.evaluate(() => { const S = Planner.Store; S.flushPending(); return { pending: S.pendingKeys().length, alive: S.state.todos.filter((x) => x.title.startsWith('Quick')).length }; });
  expect(r).toEqual({ pending: 0, alive: 0 });
  expect(errors).toEqual([]);
});

test('a very long note in many scripts saves and comes back exactly', async ({ page }) => {
  await bootMemo(page);
  const text = ('Hello שלום مرحبا 你好 こんにちは 안녕 Привет 👋🏽 é — ').repeat(220).slice(0, 10000);
  const r = await page.evaluate(async (text) => {
    const tags = Array.from({ length: 50 }, (_, i) => 'tag-' + i + '-标签');
    window.MemoStateDb.importBundle({ version: 1, memos: [{ id: 'long-1', description: text, category: 'Work', tags, images: [], attachments: [], ts: Date.now() }], finance: [], planner: [] }, 'replace');
    await window.MemoStateDb.flush();
    return tags.length;
  }, text);
  await page.reload();
  await page.waitForFunction(() => window.MemoCore && window.MemoAppReady, null, { timeout: 20000 });
  await page.evaluate(() => window.MemoAppReady);
  const back = await page.evaluate(() => { const e = window.MemoCore.getState().db.entries.find((x) => x.id === 'long-1'); return { d: e.description, tags: e.tags.length }; });
  expect(back.d).toBe(text);
  expect(back.tags).toBe(r);
  await page.evaluate(() => window.MemoVariant.openDetail('long-1'));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(1);
});
