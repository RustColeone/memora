const { test, expect } = require('@playwright/test');

// The reworked Planner: folder tabs, Today, repeating events, Undo after
// delete, past-day habit ticks, inline to-do editing and project cards.

async function open(page) {
  await page.goto('/planner.html');
  await page.waitForSelector('#todayBody .pl-card', { timeout: 15000 });
}
const isoOffset = (page, days) => page.evaluate((n) => {
  const d = new Date(); d.setDate(d.getDate() + n); return Planner.Store.Dates.iso(d);
}, days);

test('the chosen tab is kept across a reload', async ({ page }) => {
  await open(page);
  await expect(page.locator('#plTab-today')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#plPanel-calendar')).toBeHidden();
  await page.click('#plTab-calendar');
  await expect(page.locator('#plPanel-calendar')).toBeVisible();
  await expect(page.locator('#plPanel-today')).toBeHidden();
  await page.reload();
  await page.waitForSelector('#calBody .cal-day, #calBody .cal-timewrap', { timeout: 15000 });
  await expect(page.locator('#plTab-calendar')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#plPanel-calendar')).toBeVisible();
});

test('Today lists today’s events, what is due and coming up', async ({ page }) => {
  await open(page);
  const yesterday = await isoOffset(page, -1), today = await isoOffset(page, 0), soon = await isoOffset(page, 2);
  await page.evaluate(({ yesterday, today, soon }) => {
    const S = Planner.Store;
    S.addEvent({ title: 'Standup', date: today, start: '00:00', end: '00:01' });
    S.addEvent({ title: 'Dentist', date: soon, start: '15:00', end: '16:00' });
    S.addTodo({ title: 'Late report', due: yesterday });
    S.addTodo({ title: 'Someday', due: '' });
  }, { yesterday, today, soon });
  const card = page.locator('#todayBody .pl-today-card');
  await expect(card.locator('.pl-ev-row', { hasText: 'Standup' })).toHaveCount(1);
  await expect(card.locator('.pl-due-row', { hasText: 'Late report' }).locator('.pl-late')).toHaveText('Yesterday');
  await expect(card.locator('.pl-due-row', { hasText: 'Someday' })).toHaveCount(0);
  await expect(page.locator('#todayBody .pl-up-card .pl-up-row', { hasText: 'Dentist' })).toHaveCount(1);
  // Ticking from Today finishes the to-do.
  await card.locator('.pl-due-row', { hasText: 'Late report' }).locator('.todo-check').click();
  await expect(card.locator('.pl-due-row', { hasText: 'Late report' })).toHaveCount(0);
  // A row opens what it shows.
  await page.locator('#todayBody .pl-up-row', { hasText: 'Dentist' }).click();
  await expect(page.locator('#eventDlg')).toBeVisible();
  await expect(page.locator('#evTitle')).toHaveValue('Dentist');
});

test('a weekly event saved from the dialog comes round every week', async ({ page }) => {
  await open(page);
  const today = await isoOffset(page, 0), nextWeek = await isoOffset(page, 7), tomorrow = await isoOffset(page, 1);
  await page.click('#plTab-calendar');
  await page.click('#calAddBtn');
  await expect(page.locator('#eventDlg')).toBeVisible();
  await page.fill('#evTitle', 'Piano lesson');
  await page.locator('#evRepeatChips .pl-chip[data-value="weekly"]').click();
  await expect(page.locator('#evUntilRow')).toBeVisible();
  await page.click('#evSaveBtn');
  await expect(page.locator('#eventDlg')).toBeHidden();
  await page.waitForFunction(() => Planner.Store.state.events.some((x) => x.title === 'Piano lesson'));
  const r = await page.evaluate(({ today, nextWeek, tomorrow }) => {
    const S = Planner.Store, e = S.state.events.find((x) => x.title === 'Piano lesson');
    return {
      repeat: e.repeat, date: e.date,
      onNextWeek: S.eventsForDate(nextWeek).some((x) => x.id === e.id),
      onTomorrow: S.eventsForDate(tomorrow).some((x) => x.id === e.id),
      copy: S.eventsForDate(nextWeek).find((x) => x.id === e.id),
      today,
    };
  }, { today, nextWeek, tomorrow });
  expect(r.repeat).toBe('weekly');
  expect(r.date).toBe(today);
  expect(r.onNextWeek).toBe(true);
  expect(r.onTomorrow).toBe(false);
  expect(r.copy).toMatchObject({ date: nextWeek, seriesDate: today });
});

test('deleting one day of a repeating event skips only that day', async ({ page }) => {
  await open(page);
  const yesterday = await isoOffset(page, -1), today = await isoOffset(page, 0), tomorrow = await isoOffset(page, 1);
  await page.evaluate((d) => Planner.Store.addEvent({ title: 'Walk', date: d, start: '23:58', end: '23:59', repeat: 'daily' }), yesterday);
  await page.locator('#todayBody .pl-ev-row', { hasText: 'Walk' }).click();
  await expect(page.locator('#evDeleteBtn')).toBeVisible();
  await page.click('#evDeleteBtn');
  await expect(page.locator('#memoConfirmDlg')).toBeVisible();
  await page.locator('#memoConfirmDlg .memo-confirm-secondary').click();   // Only that day
  await expect(page.locator('#todayBody .pl-ev-row', { hasText: 'Walk' })).toHaveCount(0);
  const r = await page.evaluate(({ yesterday, today, tomorrow }) => {
    const S = Planner.Store, e = S._entries.find((x) => x.title === 'Walk');
    return { deleted: !!e.deletedAt, skip: e.skip,
      days: [yesterday, today, tomorrow].map((d) => S.eventsForDate(d).some((x) => x.id === e.id)) };
  }, { yesterday, today, tomorrow });
  expect(r.deleted).toBe(false);
  expect(r.skip).toEqual([today]);
  expect(r.days).toEqual([true, false, true]);
});

test('a deleted to-do can be brought back with Undo, and goes for good after', async ({ page }) => {
  await open(page);
  await page.click('#plTab-todos');
  await page.fill('#todoInput', 'Return library books');
  await page.click('#todoAddBtn');
  const row = page.locator('#todoList .todo-item', { hasText: 'Return library books' });
  await expect(row).toHaveCount(1);
  await row.locator('.todo-main').click();
  await page.click('#tdEdDel');
  await expect(row).toHaveCount(0);
  const undo = page.locator('.memo-toast .memo-toast-action');
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(row).toHaveCount(1);
  // Delete again and let it commit.
  await row.locator('.todo-main').click();
  await page.click('#tdEdDel');
  await expect(row).toHaveCount(0);
  const gone = await page.evaluate(() => {
    const S = Planner.Store; S.flushPending();
    return { pending: S.pendingKeys().length, deleted: !!S._entries.find((x) => x.title === 'Return library books').deletedAt };
  });
  expect(gone).toEqual({ pending: 0, deleted: true });
});

test('to-dos: due chips on add, then edit in place', async ({ page }) => {
  await open(page);
  const tomorrow = await isoOffset(page, 1), today = await isoOffset(page, 0);
  await page.click('#plTab-todos');
  await expect(page.locator('#todoDueChips .pl-chip[data-value="today"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#todoDueChips .pl-chip[data-value="tomorrow"]').click();
  await page.locator('#todoDueChips .pl-hi').click();
  await page.fill('#todoInput', 'Call the plumber');
  await page.press('#todoInput', 'Enter');
  await page.fill('#todoInput', 'Water plants');
  await page.press('#todoInput', 'Enter');
  const saved = await page.evaluate(() => Planner.Store.state.todos.map((x) => ({ title: x.title, due: x.due, priority: x.priority })));
  expect(saved).toEqual(expect.arrayContaining([
    { title: 'Call the plumber', due: tomorrow, priority: 'high' },
    { title: 'Water plants', due: tomorrow, priority: 'normal' },
  ]));
  // The chosen day sticks for the next one; High does not.
  await expect(page.locator('#todoDueChips .pl-hi')).toHaveAttribute('aria-pressed', 'false');

  const row = page.locator('#todoList .todo-item', { hasText: 'Call the plumber' });
  await row.locator('.todo-main').click();
  await expect(page.locator('#tdEdTitle')).toBeFocused();
  await page.fill('#tdEdTitle', 'Call the plumber about the sink');
  await page.locator('#tdEdDue .pl-chip[data-value="today"]').click();
  await page.click('#tdEdDone');
  await expect(page.locator('#tdEdTitle')).toHaveCount(0);
  const edited = await page.evaluate(() => Planner.Store.state.todos.find((x) => x.title.startsWith('Call the plumber')));
  expect(edited).toMatchObject({ title: 'Call the plumber about the sink', due: today });
});

test('habits: a past day can be ticked, later days cannot', async ({ page }) => {
  await open(page);
  await page.evaluate(() => Planner.Store.addHabit({ name: 'Stretch', type: 'check' }));
  await page.click('#plTab-habits');
  const card = page.locator('#habitsGrid .habit-card', { hasText: 'Stretch' });
  const dots = card.locator('.week-dot');
  await expect(dots).toHaveCount(7);
  const todayIndex = await page.evaluate(() => (new Date().getDay() + 6) % 7);
  await expect(dots.locator('xpath=self::*[@disabled]')).toHaveCount(6 - todayIndex);
  await dots.nth(0).click();
  await expect(dots.nth(0)).toHaveAttribute('aria-pressed', 'true');
  const monday = await page.evaluate(() => Planner.Store.Dates.iso(Planner.Store.Dates.startOfWeek(new Date())));
  expect(await page.evaluate((d) => Planner.Store.isHabitDoneOn(Planner.Store.state.habits.find((h) => h.name === 'Stretch'), d), monday)).toBe(true);
  await dots.nth(0).click();
  await expect(dots.nth(0)).toHaveAttribute('aria-pressed', 'false');
});

test('projects: lanes on the timeline, cards with milestones', async ({ page }) => {
  await open(page);
  const start = await isoOffset(page, -3), end = await isoOffset(page, 40);
  await page.evaluate(({ start, end }) => {
    Planner.Store.addProject({ name: 'Kitchen', start, end });
    Planner.Store.addProject({ name: 'Garden', start, end });
  }, { start, end });
  await page.click('#plTab-projects');
  // A new project starts at its name.
  await page.click('#addProjectBtn');
  await expect(page.locator('#pjName')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#projTimeline .gantt-row')).toHaveCount(2);
  await expect(page.locator('#projTimeline .gantt-today')).toHaveCount(1);
  await page.locator('#projTimeline .gantt-row', { hasText: 'Kitchen' }).click();
  const card = page.locator('.pl-proj-card.open');
  await expect(card).toContainText('Kitchen');
  await card.locator('.pl-ms-title').fill('Order cabinets');
  await card.locator('.pl-ms-add button[type="submit"]').click();
  await expect(card.locator('.pl-ms-row', { hasText: 'Order cabinets' })).toHaveCount(1);
  await expect(card.locator('.pl-ms-title')).toBeFocused();
  await expect(page.locator('#projTimeline .gantt-row', { hasText: 'Kitchen' }).locator('.gantt-ms')).toHaveCount(1);
  // The next milestone shows up among the to-dos.
  await page.click('#plTab-todos');
  await expect(page.locator('#todoList', { hasText: 'Order cabinets' })).toHaveCount(1);
  // Zoom out to months.
  await page.click('#plTab-projects');
  await page.locator('#projZoom [data-value="months"], #projZoom button', { hasText: 'Months' }).first().click();
  expect(await page.evaluate(() => Planner.Store.state.ui.projZoom)).toBe('months');
});

test('repeating reminders are set for each time the event comes round', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => MemoAppReady);
  const r = await page.evaluate(() => {
    const d = new Date(); d.setDate(d.getDate() - 2);
    const start = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    MemoStateDb.saveDocs('planner', [
      { id: 'daily-1', kind: 'event', title: 'Pills', date: start, start: '08:00', repeat: 'daily', remindBefore: 10 },
      { id: 'once-1', kind: 'event', title: 'Flight', date: '2031-01-02', start: '06:00', remindBefore: 60 },
      { id: 'quiet-1', kind: 'event', title: 'No alarm', date: start, start: '09:00', repeat: 'daily' },
    ]);
    return MemoPlannerReminders.events();
  });
  const daily = r.filter((x) => x.id === 'daily-1');
  expect(daily).toHaveLength(1);    // one alarm, moved on by the phone
  expect(daily[0].dates).toHaveLength(31);   // today and the next 30 days
  expect(new Set(daily[0].dates).size).toBe(31);
  expect(daily[0]).toMatchObject({ date: daily[0].dates[0], start: '08:00', remindBefore: 10 });
  expect(r.filter((x) => x.id === 'once-1')).toHaveLength(1);
  expect(r.some((x) => x.id.startsWith('quiet-1'))).toBe(false);
  expect(JSON.stringify(r)).not.toContain('Pills');
});

test('phone in landscape: the folder tabs move down the left side', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 873, height: 393 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await open(page);
  const tabs = await page.locator('#plTabs').boundingBox();
  const panel = await page.locator('#plPanel-today').boundingBox();
  const dir = await page.locator('#plTabs').evaluate((n) => getComputedStyle(n).flexDirection);
  expect(dir).toBe('column');
  expect(tabs.x + tabs.width).toBeLessThanOrEqual(panel.x + 1);
  // Upright, the tabs sit on top again.
  await page.setViewportSize({ width: 393, height: 873 });
  await expect.poll(() => page.locator('#plTabs').evaluate((n) => getComputedStyle(n).flexDirection)).toBe('row');
  const tabs2 = await page.locator('#plTabs').boundingBox();
  const panel2 = await page.locator('#plPanel-today').boundingBox();
  expect(tabs2.y + tabs2.height).toBeLessThanOrEqual(panel2.y + 1);
  await context.close();
});
