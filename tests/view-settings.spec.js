const { test, expect } = require('@playwright/test');

// The card-size control lives inside the hamburger menu, so drive it via the DOM
// (the click handler fires regardless of the menu being open) rather than a
// visibility-gated page.click.
test('card size: applies a body class, changes the grid density, and persists', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoView && /cards-/.test(document.body.className), null, { timeout: 15000 });
  expect(await page.evaluate(() => document.body.className)).toContain('cards-m'); // default

  const before = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--card-min').trim());
  const after = await page.evaluate(() => {
    document.querySelector('#cardSizeCtrl button[data-size="xl"]').click();
    return {
      cls: document.body.className,
      stored: localStorage.getItem('memoCardSize'),
      min: getComputedStyle(document.body).getPropertyValue('--card-min').trim(),
      active: document.querySelector('#cardSizeCtrl button[data-size="xl"]').classList.contains('active'),
    };
  });
  expect(after.cls).toContain('cards-xl');
  expect(after.stored).toBe('xl');
  expect(after.active).toBe(true);
  expect(after.min).not.toBe(before); // grid density actually changed (420px vs 280px)

  await page.reload();
  await page.waitForFunction(() => window.MemoView && /cards-/.test(document.body.className), null, { timeout: 15000 });
  expect(await page.evaluate(() => document.body.className)).toContain('cards-xl'); // persisted
});

test('date format: formatDate honours the setting, re-renders cards, and persists', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoAppReady);
  await page.evaluate(() => window.MemoAppReady);
  await page.waitForFunction(() => window.MemoView && window.MemoCore, null, { timeout: 15000 });

  // Fixed timestamp so every format is deterministic. 2020-01-15 09:05 local.
  const ts = new Date(2020, 0, 15, 9, 5, 0).getTime();
  const fmts = await page.evaluate((ts) => {
    const out = {};
    for (const f of ['auto', 'mdy', 'dmy', 'ymd', 'rel']) {
      window.MemoView.setDateFormat(f);
      out[f] = { stored: localStorage.getItem('memoDateFormat'), text: window.MemoView.formatDate(ts) };
    }
    return out;
  }, ts);
  expect(fmts.mdy.stored).toBe('mdy');
  expect(fmts.mdy.text).toBe('01/15/2020');                  // MM/DD/YYYY
  expect(fmts.dmy.text).toBe('15/01/2020');                  // DD/MM/YYYY
  expect(fmts.ymd.text).toBe('2020/01/15');                  // YYYY/MM/DD
  expect(fmts.auto.text).toContain(':');                     // locale date+time

  // Relative: recent → "N units ago"; older than a week → falls back to a plain date.
  const rel = await page.evaluate(() => {
    window.MemoView.setDateFormat('rel');
    const DAY = 86400000;
    return {
      now: window.MemoView.formatDate(Date.now()),
      threeDays: window.MemoView.formatDate(Date.now() - 3 * DAY),
      twoHours: window.MemoView.formatDate(Date.now() - 2 * 3600000),
      lastYear: window.MemoView.formatDate(Date.now() - 400 * DAY),
    };
  });
  expect(rel.now).toBe('just now');
  expect(rel.threeDays).toBe('3 days ago');
  expect(rel.twoHours).toBe('2 hours ago');
  expect(rel.lastYear).not.toContain('ago');                 // week+ → plain date

  // Seed one entry, navigate into its folder, and confirm the card date reflects ISO.
  const cardText = await page.evaluate(async (ts) => {
    const bundle = { version: 1, memos: [{ id: 'd1', description: 'x', category: 'Work', tags: [], images: [], ts }], finance: [] };
    window.MemoStateDb.importBundle(bundle, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    const sel = document.getElementById('categoryFilter');
    if (![...sel.options].some(o => o.value === 'Work')) { const o = document.createElement('option'); o.value = 'Work'; o.textContent = 'Work'; sel.appendChild(o); }
    sel.value = 'Work';
    window.MemoView.setDateFormat('ymd');   // setDateFormat re-renders the feed
    const card = document.querySelector('#feed .card[data-id="d1"] .muted');
    return card ? card.textContent : '';
  }, ts);
  expect(cardText).toContain('2020/01/15');

  const selValue = await page.evaluate(() => document.getElementById('dateFmtSelect').value);
  expect(selValue).toBe('ymd');

  await page.reload();
  await page.waitForFunction(() => window.MemoView, null, { timeout: 15000 });
  expect(await page.evaluate(() => window.MemoView.getDateFormat())).toBe('ymd'); // persisted
});

test('Adjust View exposes named controls, radio state, and roving keyboard selection', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoView && window.MemoCore, null, { timeout: 15000 });
  await page.evaluate(() => document.getElementById('mobileAdjustViewBtn').click());
  await expect(page.locator('#viewSettingsDlg')).toHaveAttribute('open', '');

  const sizeGroup = page.getByRole('radiogroup', { name: 'Card size' });
  await expect(sizeGroup).toBeAttached();
  await expect(sizeGroup.getByRole('radio', { name: 'M' })).toHaveAttribute('aria-checked', 'true');
  expect(await sizeGroup.locator('[role="radio"][tabindex="0"]').count()).toBe(1);

  await sizeGroup.getByRole('radio', { name: 'M' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(sizeGroup.getByRole('radio', { name: 'L', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(sizeGroup.getByRole('radio', { name: 'L', exact: true })).toBeFocused();
  await expect(page.locator('body')).toHaveClass(/cards-l/);

  const timeToggle = page.getByRole('checkbox', { name: 'Group by time' });
  await expect(timeToggle).toBeAttached();
  await expect(timeToggle).toBeChecked();

  const periodGroup = page.getByRole('radiogroup', { name: 'Period' });
  await expect(periodGroup.getByRole('radio', { name: 'Month' })).toHaveAttribute('aria-checked', 'true');
  expect(await periodGroup.locator('[role="radio"][tabindex="0"]').count()).toBe(1);
  await periodGroup.getByRole('radio', { name: 'Month' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(periodGroup.getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true');
  await expect(periodGroup.getByRole('radio', { name: 'Week' })).toBeFocused();
  expect(await page.evaluate(() => window.MemoCore.getState().settings.timeSplit.period)).toBe('week');

  await timeToggle.focus();
  await page.keyboard.press('Space');
  await expect(timeToggle).not.toBeChecked();
  await expect(periodGroup).toHaveAttribute('aria-disabled', 'true');
  expect(await periodGroup.locator('button:disabled').count()).toBe(4);
});
