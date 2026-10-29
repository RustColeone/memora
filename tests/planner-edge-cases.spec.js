const { test, expect } = require('@playwright/test');

// Edge cases around the Planner rebuild and the receipt reader: odd dates,
// odd input, quick repeated actions and small screens.

async function open(page) {
  await page.goto('/planner.html');
  await page.waitForSelector('#todayBody .pl-card', { timeout: 15000 });
}
const iso = (page, days) => page.evaluate((n) => { const d = new Date(); d.setDate(d.getDate() + n); return Planner.Store.Dates.iso(d); }, days);

test('repeats land on the right days at month ends, leap days and weekends', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const S = Planner.Store, on = (e, d) => S.occursOn(e, d);
    const monthly31 = { repeat: 'monthly', date: '2026-01-31' };
    const leap = { repeat: 'yearly', date: '2024-02-29' };
    const weekdays = { repeat: 'weekdays', date: '2026-10-19' };            // a Monday
    const until = { repeat: 'daily', date: '2026-10-01', repeatUntil: '2026-10-05', skip: ['2026-10-03'] };
    return {
      monthly31: ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'].map((d) => on(monthly31, d)),
      leap: ['2025-02-28', '2025-03-01', '2028-02-29'].map((d) => on(leap, d)),
      weekdays: ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'].map((d) => on(weekdays, d)),
      until: ['2026-09-30', '2026-10-01', '2026-10-03', '2026-10-05', '2026-10-06'].map((d) => on(until, d)),
      oneOff: [on({ date: '2026-10-01' }, '2026-10-01'), on({ date: '2026-10-01', repeat: 'bogus' }, '2026-10-02')],
    };
  });
  // A "31st" series only shows in months that have a 31st.
  expect(r.monthly31).toEqual([false, true, false, true]);
  expect(r.leap).toEqual([false, false, true]);
  expect(r.weekdays).toEqual([true, false, false, true]);
  expect(r.until).toEqual([false, true, false, true, false]);
  expect(r.oneOff).toEqual([true, false]);
});

test('skipping a day twice keeps one entry; repeats count on the calendar', async ({ page }) => {
  await open(page);
  const today = await iso(page, 0), tomorrow = await iso(page, 1);
  const r = await page.evaluate(({ today, tomorrow }) => {
    const S = Planner.Store;
    S.addEvent({ title: 'Meds', date: today, start: '08:00', end: '08:15', repeat: 'daily' });
    const e = S.state.events.find((x) => x.title === 'Meds');
    S.skipOccurrence(e.id, tomorrow); S.skipOccurrence(e.id, tomorrow);
    const counts = S.countByDate(today, tomorrow);
    return { skip: S.findEntry(e.id).skip, today: counts[today] || 0, tomorrow: counts[tomorrow] || 0 };
  }, { today, tomorrow });
  expect(r).toEqual({ skip: [tomorrow], today: 1, tomorrow: 0 });
});

test('titles with markup show as text everywhere', async ({ page }) => {
  await open(page);
  const today = await iso(page, 0), later = await iso(page, 3);
  const evil = '<img src=x onerror="window.__pwned=1">Party';
  await page.evaluate(({ evil, today, later }) => {
    const S = Planner.Store;
    window.__pwned = 0;
    S.addEvent({ title: evil, date: today, start: '23:58', end: '23:59' });
    S.addEvent({ title: evil, date: later, start: '10:00', end: '11:00', repeat: 'weekly' });
    S.addTodo({ title: evil, due: today });
    const p = S.addProject({ name: evil, start: today, end: later });
    S.addMilestone(p.id, { title: evil, due: later });
    S.addHabit({ name: evil, type: 'check' });
  }, { evil, today, later });
  for (const tab of ['today', 'calendar', 'todos', 'projects', 'habits']) {
    await page.click('#plTab-' + tab);
    await expect(page.locator('#plPanel-' + tab)).toBeVisible();
    await expect(page.locator('#plPanel-' + tab + ' img[src="x"]')).toHaveCount(0);
  }
  await page.click('#plTab-today');
  await expect(page.locator('#todayBody').getByText(evil).first()).toBeVisible();
  expect(await page.evaluate(() => window.__pwned)).toBe(0);
});

test('a blank to-do is not added; a very long one wraps instead of widening the page', async ({ page }) => {
  await open(page);
  await page.click('#plTab-todos');
  const before = await page.evaluate(() => Planner.Store.state.todos.length);
  await page.fill('#todoInput', '    ');
  await page.click('#todoAddBtn');
  expect(await page.evaluate(() => Planner.Store.state.todos.length)).toBe(before);
  await page.fill('#todoInput', 'Supercalifragilistic'.repeat(12));
  await page.press('#todoInput', 'Enter');
  await expect(page.locator('#todoList .todo-item')).toHaveCount(before + 1);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(1);
});

test('two quick deletes: Undo brings back the last one, the first still goes', async ({ page }) => {
  await open(page);
  await page.click('#plTab-todos');
  for (const title of ['First chore', 'Second chore']) { await page.fill('#todoInput', title); await page.press('#todoInput', 'Enter'); }
  for (const title of ['First chore', 'Second chore']) {
    await page.locator('#todoList .todo-item', { hasText: title }).locator('.todo-main').click();
    await page.click('#tdEdDel');
    await expect(page.locator('#todoList .todo-item', { hasText: title })).toHaveCount(0);
  }
  await page.locator('.memo-toast .memo-toast-action').click();
  await expect(page.locator('#todoList .todo-item', { hasText: 'Second chore' })).toHaveCount(1);
  await expect(page.locator('#todoList .todo-item', { hasText: 'First chore' })).toHaveCount(0);
  const r = await page.evaluate(() => {
    const S = Planner.Store; S.flushPending();
    const f = (t) => S._entries.find((x) => x.title === t);
    return [!!f('First chore').deletedAt, !!f('Second chore').deletedAt];
  });
  expect(r).toEqual([true, false]);
});

test('leaving the page while Undo is showing still deletes', async ({ page }) => {
  await open(page);
  await page.evaluate(() => Planner.Store.addTodo({ title: 'Leave me', due: '' }));
  await page.click('#plTab-todos');
  await page.locator('#todoList .todo-item', { hasText: 'Leave me' }).locator('.todo-main').click();
  await page.click('#tdEdDel');
  const r = await page.evaluate(() => {
    const S = Planner.Store;
    const pendingBefore = S.pendingKeys().length;
    window.dispatchEvent(new Event('pagehide'));
    return { pendingBefore, pendingAfter: S.pendingKeys().length, deleted: !!S._entries.find((x) => x.title === 'Leave me').deletedAt };
  });
  expect(r).toEqual({ pendingBefore: 1, pendingAfter: 0, deleted: true });
});

test('deleting a whole series asks, then Undo brings every day back', async ({ page }) => {
  await open(page);
  const yesterday = await iso(page, -1), today = await iso(page, 0);
  await page.evaluate((d) => Planner.Store.addEvent({ title: 'Gym', date: d, start: '23:58', end: '23:59', repeat: 'daily' }), yesterday);
  await page.locator('#todayBody .pl-ev-row', { hasText: 'Gym' }).click();
  await page.click('#evDeleteBtn');
  await page.locator('#memoConfirmDlg .memo-confirm-ok').click();      // Every time
  await expect(page.locator('#todayBody .pl-ev-row', { hasText: 'Gym' })).toHaveCount(0);
  await page.locator('.memo-toast .memo-toast-action').click();
  await expect(page.locator('#todayBody .pl-ev-row', { hasText: 'Gym' })).toHaveCount(1);
  expect(await page.evaluate((d) => Planner.Store.eventsForDate(d).some((x) => x.title === 'Gym'), today)).toBe(true);
});

test('an end time before the start still saves a short event', async ({ page }) => {
  await open(page);
  await page.click('#plTab-calendar');
  await page.click('#calAddBtn');
  await page.fill('#evTitle', 'Backwards');
  await page.fill('#evStart', '14:00');
  await page.locator('#evDurChips .pl-chip[data-value="custom"]').click();
  await page.fill('#evEnd', '13:00');
  await page.click('#evSaveBtn');
  await page.waitForFunction(() => Planner.Store.state.events.some((x) => x.title === 'Backwards'));
  const e = await page.evaluate(() => Planner.Store.state.events.find((x) => x.title === 'Backwards'));
  expect([e.start, e.end]).toEqual(['14:00', '14:15']);
});

test('a project whose end is before its start does not break the timeline', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await open(page);
  const a = await iso(page, 10), b = await iso(page, -10);
  await page.evaluate(({ a, b }) => {
    Planner.Store.addProject({ name: 'Backwards project', start: a, end: b });
    Planner.Store.addProject({ name: 'No dates', start: '', end: '' });
  }, { a, b });
  await page.click('#plTab-projects');
  await expect(page.locator('#projCards .pl-proj-card')).toHaveCount(2);
  const widths = await page.locator('#projTimeline .gantt-bar').evaluateAll((bars) => bars.map((x) => getComputedStyle(x).width));
  for (const w of widths) expect(w).not.toContain('NaN');
  expect(await page.locator('#projTimeline').innerText()).not.toMatch(/NaN|Invalid Date|undefined/);
  expect(await page.locator('#projCards').innerText()).not.toMatch(/NaN|Invalid Date|undefined/);
  expect(errors).toEqual([]);
});

test('Chinese: tabs and Today read in Chinese', async ({ page }) => {
  await open(page);
  await page.evaluate(() => MemoI18n.choose('zh'));
  await expect(page.locator('#plTab-calendar')).toContainText('日历');
  await expect(page.locator('#plTab-habits')).toContainText('习惯');
  await expect(page.locator('#todayBody .pl-up-card h2')).toHaveText('即将到来');
  await page.evaluate(() => MemoI18n.choose('en'));
  await expect(page.locator('#plTab-calendar')).toContainText('Calendar');
});

test('a 320px phone: every tab fits without sideways scrolling', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await open(page);
  await page.evaluate((d) => {
    const S = Planner.Store;
    S.addEvent({ title: 'A rather long event title that keeps going', date: d, start: '09:00', end: '10:00' });
    S.addProject({ name: 'Renovate the whole house', start: d, end: d });
    S.addHabit({ name: 'Read a chapter of a long book', type: 'count' });
  }, await iso(page, 0));
  for (const tab of ['today', 'calendar', 'todos', 'projects', 'habits']) {
    await page.click('#plTab-' + tab);
    await expect(page.locator('#plPanel-' + tab)).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, tab).toBeLessThanOrEqual(1);
  }
  // All five tabs stay on screen.
  const boxes = await page.locator('#plTabs .pl-tab').evaluateAll((tabs) => tabs.map((x) => x.getBoundingClientRect().right));
  for (const right of boxes) expect(right).toBeLessThanOrEqual(321);
  await context.close();
});

test('reminders skip the days taken out and stop at the end date', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => MemoAppReady);
  const r = await page.evaluate(() => {
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    MemoStateDb.saveDocs('planner', [
      { id: 'short', kind: 'event', date: day(0), start: '07:00', repeat: 'daily', repeatUntil: day(4), skip: [day(2)], remindAtStart: true },
      { id: 'gone', kind: 'event', date: day(0), start: '07:00', repeat: 'daily', remindBefore: 5, deletedAt: new Date().toISOString() },
    ]);
    return { list: MemoPlannerReminders.events().map((x) => [x.id, x.dates]), days: [0, 1, 2, 3, 4].map(day) };
  });
  expect(r.list).toEqual([['short', [0, 1, 3, 4].map((i) => r.days[i])]]);
});

test('receipt reader: empty input, thousands and comma decimals', async ({ page }) => {
  await page.goto('/finance.html');
  await page.waitForFunction(() => window.MemoReceipt);
  const r = await page.evaluate(() => {
    const P = window.MemoReceipt.parse;
    const brief = (x) => ({ total: x.total, items: x.items.map((i) => [i.name, i.totalPrice]), mismatch: x.mismatch });
    return {
      empty: brief(P({ text: '' })),
      none: brief(P()),
      onlyStore: brief(P({ text: 'CORNER SHOP' })),
      thousands: brief(P({ text: 'BEST STORE\nTV 1,299.99\nCABLE 12.00\nTAX 107.24\nTOTAL 1,419.23' })),
      euro: brief(P({ text: 'MEDIAMARKT\nFernseher 1.299,99\nKabel 12,00\nSUMME 1.311,99' })),
    };
  });
  expect(r.empty).toEqual({ total: null, items: [], mismatch: false });
  expect(r.none).toEqual({ total: null, items: [], mismatch: false });
  expect(r.onlyStore).toEqual({ total: null, items: [], mismatch: false });
  expect(r.thousands).toEqual({ total: 1419.23, items: [['Tv', 1299.99], ['Cable', 12]], mismatch: false });
  expect(r.euro).toEqual({ total: 1311.99, items: [['Fernseher', 1299.99], ['Kabel', 12]], mismatch: false });
});
