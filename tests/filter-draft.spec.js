const { test, expect } = require('@playwright/test');

async function bootWithAppliedFilters(page) {
  await page.clock.setFixedTime(new Date('2026-08-05T12:00:00'));
  await page.goto('/index.html');
  await page.evaluate(() => window.MemoAppReady);
  await page.waitForFunction(
    () => window.MemoCore && window.MemoStateDb?.ready() && window.MemoFilterBootstrapped,
    null,
    { timeout: 15000 },
  );
  await page.evaluate(() => {
    const state = window.MemoCore.getState();
    state.settings.categories = ['Uncategorized', 'Work', 'Home'];
    state.settings.tags = ['urgent', 'kept'];
    state.settings.tagCounts = { urgent: 2, kept: 1 };
    state.activeFilters.dateFrom = '2026-07-01';
    state.activeFilters.dateTo = '2026-07-31';
    state.activeFilters.cats.clear();
    state.activeFilters.favorite = true;
    state.activeFilters.tags.clear();
    state.activeFilters.tags.add('urgent');
  });
}

async function openFilters(page) {
  await page.locator('#filtersBtn').click();
  await expect(page.locator('#filtersDlg')).toHaveAttribute('open', '');
}

async function closeFiltersWith(page, selector) {
  await page.locator(selector).click();
  await expect(page.locator('#filtersDlg')).not.toHaveAttribute('open', '');
}

async function snapshot(page) {
  return page.evaluate(() => {
    const applied = window.MemoCore.getState().activeFilters;
    return {
      applied: {
        dateFrom: applied.dateFrom,
        dateTo: applied.dateTo,
        favorite: applied.favorite,
        tags: Array.from(applied.tags).sort(),
      },
      controls: {
        dateFrom: document.getElementById('dateFrom').value,
        dateTo: document.getElementById('dateTo').value,
        favorite: document.getElementById('filterFavorites').checked,
        tags: Array.from(document.querySelectorAll('#filterTagApplied [data-tag]'), el => el.dataset.tag).sort(),
      },
    };
  });
}

const ORIGINAL = {
  dateFrom: '2026-07-01',
  dateTo: '2026-07-31',
  favorite: true,
  tags: ['urgent'],
};

test('Reset changes only the draft and Cancel restores it on rapid reopen cycles', async ({ page }) => {
  await bootWithAppliedFilters(page);
  await openFilters(page);

  expect(await snapshot(page)).toEqual({ applied: ORIGINAL, controls: ORIGINAL });

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.locator('#filtersReset').click();
    expect(await snapshot(page)).toEqual({
      applied: ORIGINAL,
      controls: { dateFrom: '', dateTo: '', favorite: false, tags: [] },
    });

    await closeFiltersWith(page, '#filtersCancel');
    expect((await snapshot(page)).applied).toEqual(ORIGINAL);

    await openFilters(page);
    expect(await snapshot(page)).toEqual({ applied: ORIGINAL, controls: ORIGINAL });
  }

  await closeFiltersWith(page, '#filtersCancel');
});

test('Apply atomically commits the open draft and the next open reflects it', async ({ page }) => {
  await bootWithAppliedFilters(page);
  await openFilters(page);
  await page.locator('#filtersReset').click();

  await page.locator('#filterTagAvailable [data-tag="kept"]').click();
  await page.locator('#filterFavorites').check();
  await page.locator('.filter-tab[data-tab="date"]').click();
  await page.locator('#calGrid [data-cal-key="day:2026-08-05"]').focus();
  await page.keyboard.press('Enter');
  expect((await snapshot(page)).applied).toEqual(ORIGINAL);
  // The date-tab action commits the selected range and the same tag/favourite draft.
  await closeFiltersWith(page, '#calApply');

  const draft = {
    dateFrom: '2026-08-05',
    dateTo: '2026-08-05',
    favorite: true,
    tags: ['kept'],
  };
  expect((await snapshot(page)).applied).toEqual(draft);

  await openFilters(page);
  expect(await snapshot(page)).toEqual({ applied: draft, controls: draft });
  await closeFiltersWith(page, '#filtersCancel');
});
