const { test, expect } = require('@playwright/test');

async function bootWithCountedEntries(page, entries) {
  await page.clock.setFixedTime(new Date('2026-07-18T12:00:00-07:00'));
  await page.goto('/index.html');
  await page.evaluate(() => window.MemoAppReady);
  await page.waitForFunction(
    () => window.MemoCore && window.MemoStateDb?.ready() && window.MemoFilterBootstrapped,
    null,
    { timeout: 15000 },
  );
  await page.evaluate((seed) => {
    window.__calendarIndexVisits = 0;
    window.__calendarEntries = seed;
    const counted = new Proxy(window.__calendarEntries, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          return function* countedIterator() {
            for (let index = 0; index < target.length; index += 1) {
              window.__calendarIndexVisits += 1;
              yield target[index];
            }
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    window.MemoCore.getState().db.entries = counted;
  }, entries);
}

function entry(id, iso, overrides = {}) {
  return {
    id,
    description: id,
    category: 'Uncategorized',
    tags: [],
    images: [],
    ts: new Date(iso).getTime(),
    ...overrides,
  };
}

async function openCalendar(page) {
  await page.locator('#filtersBtn').click();
  await page.locator('.filter-tab[data-tab="date"]').click();
  await expect(page.locator('#filtersDlg')).toHaveAttribute('open', '');
}

async function closeCalendar(page) {
  await page.evaluate(() => document.getElementById('filtersDlg').close());
  await expect(page.locator('#filtersDlg')).not.toHaveAttribute('open', '');
}

test('calendar builds one date/month/hour index per open and reuses it for every render', async ({ page }) => {
  const entries = [];
  for (let index = 0; index < 240; index += 1) {
    const hour = String(index % 24).padStart(2, '0');
    entries.push(entry(`july-${index}`, `2026-07-18T${hour}:15:00-07:00`));
  }
  for (let index = 0; index < 80; index += 1) {
    entries.push(entry(`august-${index}`, `2026-08-03T09:${String(index % 60).padStart(2, '0')}:00-07:00`));
  }
  await bootWithCountedEntries(page, entries);
  await openCalendar(page);

  expect(await page.evaluate(() => window.__calendarIndexVisits)).toBe(entries.length);

  // Navigation and view switches all rerender the grid. Day view also proves the
  // hourly buckets came from the same initial pass rather than a day-specific scan.
  await page.locator('#calNext').click();
  await page.locator('#calPrev').click();
  await page.locator('#calView').selectOption('year');
  await page.locator('#calView').selectOption('month');
  await page.evaluate(() => {
    const picker = document.getElementById('calPickDay');
    picker.value = '2026-07-18';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#calGrid .hourcell')).toHaveCount(24);
  expect(await page.locator('#calGrid .hourcell .badge').allTextContents()).toEqual(new Array(24).fill('10'));

  // Return to the month and exercise the pointer-selection rerender path twice.
  await page.locator('#calView').selectOption('month');
  await page.evaluate(() => {
    const firstCurrentMonthCell = () => document.querySelector('#calGrid .calcell:not(.disabled)');
    firstCurrentMonthCell().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    firstCurrentMonthCell().dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, buttons: 1 }));
    firstCurrentMonthCell().dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });

  expect(await page.evaluate(() => window.__calendarIndexVisits)).toBe(entries.length);
  await closeCalendar(page);
});

test('closing discards the index and reopening reflects entries added between opens', async ({ page }) => {
  const entries = [
    entry('first', '2026-07-18T08:00:00-07:00'),
    entry('second', '2026-07-18T09:00:00-07:00'),
  ];
  await bootWithCountedEntries(page, entries);
  await openCalendar(page);
  expect(await page.evaluate(() => window.__calendarIndexVisits)).toBe(2);
  await closeCalendar(page);

  await page.evaluate(() => {
    window.__calendarEntries.push({
      id: 'added-after-close',
      description: 'added after close',
      category: 'Uncategorized',
      tags: [],
      images: [],
      ts: new Date('2026-07-19T10:00:00-07:00').getTime(),
    });
  });
  await openCalendar(page);

  expect(await page.evaluate(() => window.__calendarIndexVisits)).toBe(5); // 2 first open + 3 second open
  const addedDayCount = await page.evaluate(() => {
    const cell = Array.from(document.querySelectorAll('#calGrid .calcell:not(.disabled)'))
      .find(candidate => candidate.querySelector('.title')?.textContent === '19');
    return cell && cell.querySelector('.count')?.textContent;
  });
  expect(addedDayCount).toBe('1');
  await closeCalendar(page);
});

test('calendar counts exclude soft-deleted entries from month, day, and hour totals', async ({ page }) => {
  const entries = [
    entry('live', '2026-07-18T08:15:00-07:00'),
    entry('deleted-same-day', '2026-07-18T09:15:00-07:00', {
      deletedAt: '2026-07-18T10:00:00.000Z',
    }),
    entry('deleted-only-day', '2026-07-19T10:15:00-07:00', {
      deletedAt: '2026-07-19T11:00:00.000Z',
    }),
  ];
  await bootWithCountedEntries(page, entries);
  await openCalendar(page);

  const dayCounts = await page.evaluate(() => Object.fromEntries(
    Array.from(document.querySelectorAll('#calGrid .calcell:not(.disabled)')).map((cell) => [
      cell.querySelector('.title')?.textContent,
      cell.querySelector('.count')?.textContent,
    ]),
  ));
  expect(dayCounts['18']).toBe('1');
  expect(dayCounts['19']).toBe('');

  await page.locator('#calView').selectOption('year');
  const julyCount = await page.evaluate(() => {
    const july = Array.from(document.querySelectorAll('#calGrid .calcell'))
      .find((cell) => cell.querySelector('.title')?.textContent === 'Jul');
    return july?.querySelector('.count')?.textContent;
  });
  expect(julyCount).toBe('1');

  await page.evaluate(() => {
    const picker = document.getElementById('calPickDay');
    picker.value = '2026-07-18';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const hourCounts = await page.locator('#calGrid .hourcell .badge').allTextContents();
  expect(hourCounts[8]).toBe('1');
  expect(hourCounts[9]).toBe('0');
  expect(hourCounts.reduce((total, value) => total + Number(value), 0)).toBe(1);
});

test('calendar grids expose selected state and support roving keyboard navigation', async ({ page }) => {
  await bootWithCountedEntries(page, [
    entry('morning', '2026-07-18T08:15:00-07:00'),
  ]);
  await openCalendar(page);

  const grid = page.locator('#calGrid');
  await expect(grid).toHaveAttribute('role', 'grid');
  await expect(grid).toHaveAttribute('aria-label', /July 2026/i);
  await expect(grid.locator('.calcell')).toHaveCount(42);
  expect(await grid.locator('.calcell[role="gridcell"][aria-selected]').count()).toBe(42);
  expect(await grid.locator('.calcell[tabindex="0"]').count()).toBe(1);

  const day18 = grid.locator('.calcell:not(.disabled)').filter({
    has: page.locator('.title', { hasText: /^18$/ }),
  });
  await day18.focus();
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => document.activeElement?.querySelector('.title')?.textContent)).toBe('19');
  await page.keyboard.press('Space');
  await expect(grid.locator('.calcell:not(.disabled)').filter({
    has: page.locator('.title', { hasText: /^19$/ }),
  })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#calApply')).toBeEnabled();

  await page.locator('#calView').selectOption('year');
  await expect(grid).toHaveAttribute('aria-label', /2026.*month/i);
  expect(await grid.locator('.calcell[role="gridcell"][aria-selected]').count()).toBe(12);
  expect(await grid.locator('.calcell[tabindex="0"]').count()).toBe(1);
  const july = grid.locator('.calcell').filter({
    has: page.locator('.title', { hasText: /^Jul$/ }),
  });
  await july.focus();
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => document.activeElement?.querySelector('.title')?.textContent)).toBe('Aug');
  await page.keyboard.press('Enter');
  await expect(page.locator('#calView')).toHaveValue('month');

  await page.evaluate(() => {
    const picker = document.getElementById('calPickDay');
    picker.value = '2026-07-18';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(grid).toHaveAttribute('aria-label', /July 18, 2026.*hour/i);
  expect(await grid.locator('.hourcell[role="gridcell"][aria-selected="false"]').count()).toBe(24);
  expect(await grid.locator('.hourcell[tabindex="0"]').count()).toBe(1);
  await grid.locator('.hourcell').first().focus();
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => document.activeElement?.querySelector('.label')?.textContent)).toBe('01');
});
