// Regressions: reminders stay under Android's alarm cap, and dates derived
// from a timestamp are the local calendar day, not the UTC one.
const { test, expect } = require('@playwright/test');

test('repeating reminders take one alarm each; past the cap only the soonest 400 events are handed over', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => window.MemoAppReady);
  const r = await page.evaluate(() => {
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const docs = Array.from({ length: 30 }, (_, i) => ({ id: 'daily-' + i, kind: 'event', title: 'Pill ' + i, date: day(-3), start: String(6 + (i % 12)).padStart(2, '0') + ':00', repeat: 'daily', remindBefore: 5 }));
    docs.push({ id: 'old-one', kind: 'event', title: 'Long ago', date: day(-40), start: '09:00', remindBefore: 10 });
    docs.push({ id: 'no-date', kind: 'event', title: 'Undated', start: '09:00', remindBefore: 10 });
    docs.push({ id: 'soon-one', kind: 'event', title: 'Dentist', date: day(0), start: '23:59', remindBefore: 30 });
    docs.push({ id: 'ended', kind: 'event', title: 'Course', date: day(-20), repeatUntil: day(-2), start: '09:00', repeat: 'daily', remindBefore: 5 });
    MemoStateDb.saveDocs('planner', docs);
    const few = MemoPlannerReminders.events();
    const keys = few.map((x) => x.date + ' ' + x.start);
    const pill = few.find((x) => x.id === 'daily-0');
    // Now more one-off events than Android would take.
    MemoStateDb.saveDocs('planner', Array.from({ length: 450 }, (_, i) => ({ id: 'once-' + i, kind: 'event', title: 'Once', date: day(1 + (i % 60)), start: '10:00', remindBefore: 5 })));
    const many = MemoPlannerReminders.events(), kept = new Set(many.map((x) => x.id));
    const dropped = MemoStateDb.loadDocs('planner').filter((e) => !kept.has(e.id));
    return { droppedLater: dropped.every((e) => many.every((x) => x.date <= e.date)), n: few.length, sorted: keys.every((k, i) => !i || keys[i - 1] <= k), today: day(0), last: day(30), pill,
      hasOld: few.some((x) => x.id === 'old-one'), hasUndated: few.some((x) => x.id === 'no-date'), hasEnded: few.some((x) => x.id === 'ended'),
      soon: few.find((x) => x.id === 'soon-one'), capped: many.length };
  });
  expect(r.n).toBe(31);                  // 30 repeating events and the dentist, not 30 × 31 alarms
  expect(r.sorted).toBe(true);
  expect(r.pill.date).toBe(r.today);
  expect(r.pill.dates).toHaveLength(31);
  expect(r.pill.dates[30]).toBe(r.last);
  expect(r.hasOld).toBe(false);
  expect(r.hasUndated).toBe(false);
  expect(r.hasEnded).toBe(false);
  expect(r.soon.dates).toBeUndefined();  // a one-off event has a single date
  expect(r.capped).toBe(400);
  expect(r.droppedLater).toBe(true);    // the soonest are kept
});

test.describe('evening in California', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  test('a purchase saved without a date shows the local day, not tomorrow', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-20T21:30:00-07:00') });
    await page.goto('/finance.html');
    await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready() && window.MemoVariant, null, { timeout: 15000 });
    const ts = new Date('2026-10-20T20:15:00-07:00').getTime();   // 03:15 on the 21st in UTC
    await page.evaluate(async (ts) => {
      MemoStateDb.saveEntries([{ id: 'nodate', description: 'Late snack', category: 'Food', sheet: 'General', tags: [], images: [], attachments: [], items: [], total: 4.5, ts }], 'finance');
      await MemoStateDb.flush();
      MemoCore.getState().db.entries = MemoStateDb.loadEntries('finance');
      MemoVariant.renderFeed();
    }, ts);
    const row = page.locator('tr.entry-row', { hasText: 'Late snack' });
    await expect(row).toHaveCount(1);
    const shown = await row.locator('td.col-date').innerText();
    expect(shown).toMatch(/20/);
    expect(shown).not.toMatch(/21/);
    // Opening it to edit fills in the same local day.
    await page.evaluate(() => window.openEntryModal(MemoCore.getState().db.entries.find((e) => e.id === 'nodate')));
    await expect(page.locator('#entryDate')).toHaveValue('2026-10-20');
  });
});
