const { test, expect } = require('@playwright/test');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function boot(page, path = 'index.html') {
  await page.goto('/' + path);
  await page.waitForFunction(() => window.MemoShell && window.MemoMotion && window.MemoCtx, null, { timeout: 15000 });
}

async function seedMemo(page) {
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
  await page.evaluate(async (png) => {
    const memos = [{
      id: 'a11y-entry', description: 'Accessible entry', category: 'Work',
      tags: ['common'], images: [png, png], ts: Date.now(),
    }];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    const state = window.MemoCore.getState();
    state.db.entries = window.MemoStateDb.loadEntries('default') || [];
    state.settings.tags = ['common', 'available'];
    state.settings.categories = ['Work'];
    const category = document.getElementById('categoryFilter');
    if (![...category.options].some(option => option.value === 'Work')) {
      const option = document.createElement('option');
      option.value = 'Work'; option.textContent = 'Work'; category.appendChild(option);
    }
    category.value = 'Work';
    window.MemoCore.renderFeed();
  }, PNG);
  await page.waitForSelector('#feed .card[data-id="a11y-entry"]');
}

test('nested dialogs expose only the active modal and restore the nested opener', async ({ page }) => {
  await boot(page);

  await page.evaluate(() => {
    const outerOpener = document.getElementById('filtersBtn');
    outerOpener.focus();
    document.getElementById('filtersDlg').showModal();
    document.getElementById('filtersApply').focus();
    document.getElementById('tagPickerDlg').showModal();
  });

  await expect(page.locator('#filtersDlg')).toHaveAttribute('aria-hidden', 'true');
  expect(await page.locator('#filtersDlg').evaluate(dialog => dialog.inert)).toBe(true);
  await expect(page.locator('#tagPickerDlg')).not.toHaveAttribute('aria-hidden', 'true');
  expect(await page.locator('#tagPickerDlg').evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);

  await page.evaluate(() => document.getElementById('tagPickerDlg').close());
  await page.waitForFunction(() => !document.getElementById('tagPickerDlg').open);
  await expect(page.locator('#filtersDlg')).not.toHaveAttribute('aria-hidden', 'true');
  expect(await page.locator('#filtersDlg').evaluate(dialog => dialog.inert)).toBe(false);
  await expect(page.locator('#filtersApply')).toBeFocused();

  await page.evaluate(() => document.getElementById('filtersDlg').close());
  await page.waitForFunction(() => !document.getElementById('filtersDlg').open);
  await expect(page.locator('#filtersBtn')).toBeFocused();
});

test('brand and shared context menus follow the ARIA menu keyboard model', async ({ page }) => {
  await boot(page);

  const brandButton = page.locator('#brandMenuButton');
  await brandButton.click();
  await expect(brandButton).toHaveAttribute('aria-controls', 'brandMenu');
  await expect(brandButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#brandMenu')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#brandMenu [role="menuitem"]').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('#brandMenu [role="menuitem"]').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(brandButton).toBeFocused();
  await expect(brandButton).toHaveAttribute('aria-expanded', 'false');

  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.id = 'contextMenuInvoker';
    opener.textContent = 'Open actions';
    document.body.appendChild(opener);
    opener.focus();
    window.MemoCtx.showMenu(40, 40, [
      { html: 'First action', onClick: function () {} },
      { sep: true },
      { html: 'Last action', onClick: function () {} },
    ]);
  });
  await expect(page.locator('#ctxMenu')).toHaveAttribute('role', 'menu');
  await expect(page.locator('#ctxMenu')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#ctxMenu')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#ctxMenu [role="menuitem"]').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('#ctxMenu [role="menuitem"]').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#contextMenuInvoker')).toBeFocused();
  await expect(page.locator('#ctxMenu')).toHaveAttribute('aria-hidden', 'true');
});

test('accessibility observers survive a persisted page lifecycle', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const lifecycleEvent = (type) => {
      const event = new Event(type);
      Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event);
    };
    lifecycleEvent('pagehide');
    lifecycleEvent('pageshow');

    const dialog = document.createElement('dialog');
    dialog.id = 'lifecycleDialog';
    dialog.setAttribute('open', '');
    dialog.innerHTML = '<div class="modal"><header><strong>Lifecycle dialog</strong></header></div>';
    document.body.appendChild(dialog);

    const wrap = document.createElement('div');
    wrap.className = 'modal-menu-wrap';
    wrap.innerHTML = '<button id="lifecycleMenuButton" class="modal-menu" aria-label="Lifecycle actions"></button>'
      + '<div id="lifecycleMenu" class="modal-menu-popup open"><button class="modal-menu-item">Action</button></div>';
    document.body.appendChild(wrap);
  });
  await expect(page.locator('#lifecycleDialog')).toHaveAttribute('aria-labelledby', 'lifecycleDialogTitle');
  await expect(page.locator('body')).toHaveClass(/dialog-open/);
  await expect(page.locator('#lifecycleMenu')).toHaveAttribute('role', 'menu');
  await expect(page.locator('#lifecycleMenuButton')).toHaveAttribute('aria-expanded', 'true');
});

test('detail and reader action popups are named menus with focus-contained keyboard dismissal', async ({ page }) => {
  await boot(page);
  await seedMemo(page);

  await page.click('#feed .card[data-id="a11y-entry"]');
  await page.waitForFunction(() => document.getElementById('detailDlg').open);
  await page.click('#detailMenuBtn');
  const detailButton = page.locator('#detailMenuBtn');
  const detailMenu = page.locator('#detailMenuPopup');
  await expect(detailButton).toHaveAttribute('aria-haspopup', 'menu');
  await expect(detailButton).toHaveAttribute('aria-expanded', 'true');
  await expect(detailMenu).toHaveAttribute('role', 'menu');
  await expect(detailMenu.locator('[role="menuitem"]').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(detailMenu.locator('[role="menuitem"]').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(detailButton).toBeFocused();
  await expect(detailButton).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('#detailDlg').evaluate(dialog => dialog.open)).toBe(true);

  await page.evaluate(() => {
    document.getElementById('detailDlg').close();
  });
  await page.waitForFunction(() => !document.getElementById('detailDlg').open);
  await page.evaluate(() => {
    const entry = window.MemoCore.getState().db.entries.find(item => item.id === 'a11y-entry');
    window.MemoReader.open(entry, 0);
  });
  await page.waitForFunction(() => document.getElementById('urDlg') && document.getElementById('urDlg').open, null, { timeout: 10000 });
  await page.evaluate(() => document.getElementById('urActionsBtn').click());
  const readerButton = page.locator('#urActionsBtn');
  const readerMenu = page.locator('#urHoldMenu');
  await expect(readerButton).toHaveAttribute('aria-haspopup', 'menu');
  await expect(readerButton).toHaveAttribute('aria-expanded', 'true');
  await expect(readerMenu).toHaveAttribute('role', 'menu');
  await expect(readerMenu.locator('[role="menuitem"]').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(readerMenu.locator('[role="menuitem"]').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(readerMenu).toBeHidden();
  await expect(readerButton).toBeFocused();
  expect(await page.locator('#urDlg').evaluate(dialog => dialog.open)).toBe(true);
});

test('interactive chips expose their action and pressed state to keyboard users', async ({ page }) => {
  await boot(page);
  await seedMemo(page);

  const selectionBar = page.locator('#selectBar');
  await expect(selectionBar).toHaveAttribute('aria-hidden', 'true');
  expect(await selectionBar.evaluate(toolbar => toolbar.inert)).toBe(true);

  await page.evaluate(() => {
    window.MemoSelect.enter('a11y-entry');
    document.getElementById('selectEdit').click();
  });
  await expect(selectionBar).toHaveAttribute('aria-hidden', 'false');
  expect(await selectionBar.evaluate(toolbar => toolbar.inert)).toBe(false);
  const sharedChip = page.locator('#batchCommonTags .tagpill.removable');
  await expect(sharedChip).toHaveJSProperty('tagName', 'BUTTON');
  await expect(sharedChip).toHaveAttribute('aria-pressed', 'false');
  await expect(sharedChip).toHaveAccessibleName('Remove common from all selected entries');
  await sharedChip.focus();
  await page.keyboard.press('Space');
  await expect(sharedChip).toHaveClass(/pending-remove/);
  await expect(sharedChip).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => {
    document.getElementById('batchEditDlg').close();
    const entry = window.MemoCore.getState().db.entries.find(item => item.id === 'a11y-entry');
    window.openEntryModal(entry);
  });
  await page.waitForFunction(() => document.getElementById('entryDlg').open);
  await expect(page.locator('#tagChips .chip button')).toHaveAccessibleName('Remove tag common');

  await page.evaluate(() => window.MemoTagPicker.open());
  const applied = page.locator('#tagPickApplied .tag-pick[data-tag="common"]');
  const available = page.locator('#tagPickAvailable .tag-pick[data-tag="available"]');
  await expect(applied).toHaveAttribute('aria-pressed', 'true');
  await expect(applied).toHaveAccessibleName('Remove tag common');
  await expect(available).toHaveAttribute('aria-pressed', 'false');
  await expect(available).toHaveAccessibleName('Add tag available');
});

test('tag suggestions expose an active-descendant combobox contract', async ({ page }) => {
  await boot(page);
  await seedMemo(page);
  await page.evaluate(() => {
    const entry = window.MemoCore.getState().db.entries.find(item => item.id === 'a11y-entry');
    window.openEntryModal(entry);
  });
  const input = page.locator('#tagInput');
  const list = page.locator('#tagDropdown');
  await expect(input).toHaveAttribute('role', 'combobox');
  await expect(input).toHaveAttribute('aria-autocomplete', 'list');
  await expect(input).toHaveAttribute('aria-controls', 'tagDropdown');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.fill('a');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toHaveAttribute('role', 'listbox');
  await expect(list.locator('[role="option"]')).not.toHaveCount(0);
  const firstId = await list.locator('[role="option"]').first().getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', firstId);
  await page.keyboard.press('ArrowDown');
  const secondId = await list.locator('[role="option"]').nth(1).getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', secondId);
  await page.keyboard.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/);
});

test('memo calendar navigation and grid controls have explicit names', async ({ page }) => {
  await boot(page);
  await page.locator('#filtersBtn').click();
  await page.locator('.filter-tab[data-tab="date"]').click();
  await expect(page.locator('#filtersDlg')).toHaveAttribute('open', '');
  await expect(page.locator('#calPrev')).toHaveAccessibleName('Previous period');
  await expect(page.locator('#calNext')).toHaveAccessibleName('Next period');
  await expect(page.locator('#calView')).toHaveAccessibleName('Calendar view');
  await expect(page.locator('#calPickDay')).toHaveAccessibleName('Choose date');
  await expect(page.locator('#calGrid')).toHaveAttribute('role', 'grid');
  await expect(page.locator('#calGrid [role="gridcell"]')).not.toHaveCount(0);
  expect(await page.locator('#calGrid [role="gridcell"][tabindex="0"]').count()).toBe(1);
});

test('planner calendar and project selectors use roving keyboard semantics', async ({ page }) => {
  await boot(page, 'planner.html');
  await page.waitForFunction(() => window.Planner && window.Planner.Store && document.querySelectorAll('.cal-day').length, null, { timeout: 15000 });
  await page.evaluate(() => {
    const store = window.Planner.Store;
    const dates = store.Dates;
    const today = new Date();
    store.addProject({
      name: 'Alpha', color: '#60a5fa', start: dates.iso(today), end: dates.iso(dates.addDays(today, 10)),
      milestones: [{ id: 'alpha-ms', title: 'Alpha review', due: dates.iso(dates.addDays(today, 3)), done: false }],
    });
    store.addProject({
      name: 'Beta', color: '#34d399', start: dates.iso(today), end: dates.iso(dates.addDays(today, 20)),
      milestones: [{ id: 'beta-ms', title: 'Beta review', due: dates.iso(dates.addDays(today, 5)), done: false }],
    });
    store.state.ui.calRange = 'month';
    store.persist();
  });
  // Folder tabs: one section at a time, arrow keys move between them.
  const tabs = page.locator('#plTabs');
  await expect(tabs).toHaveAttribute('role', 'tablist');
  await page.click('#plTab-calendar');
  await expect(page.locator('#plTab-calendar')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#plTab-calendar').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#plTab-todos')).toBeFocused();
  await expect(page.locator('#plTab-todos')).toHaveAttribute('aria-selected', 'true');
  await page.click('#plTab-calendar');

  const ranges = page.locator('#calRange');
  await expect(ranges).toHaveAttribute('role', 'radiogroup');
  await expect(ranges).toHaveAccessibleName('Calendar range');
  expect(await ranges.locator('[role="radio"][tabindex="0"]').count()).toBe(1);
  const selectedRange = ranges.locator('[role="radio"][aria-checked="true"]');
  await selectedRange.focus();
  await page.keyboard.press('ArrowRight');
  await expect(ranges.locator('[role="radio"][aria-checked="true"]')).toBeFocused();
  await ranges.locator('[role="radio"]', { hasText: 'Month' }).click();

  const monthGrid = page.locator('#calBody .cal-month-grid');
  await expect(monthGrid).toHaveAttribute('role', 'grid');
  expect(await monthGrid.locator('[role="gridcell"][tabindex="0"]').count()).toBe(1);
  const currentDate = await monthGrid.locator('[role="gridcell"][tabindex="0"]').getAttribute('data-date');
  const currentDay = monthGrid.locator(`[role="gridcell"][data-date="${currentDate}"]`);
  await currentDay.focus();
  await page.keyboard.press('ArrowRight');
  await expect(currentDay).not.toBeFocused();
  await expect(monthGrid.locator('[role="gridcell"]:focus')).toHaveCount(1);

  await page.click('#plTab-projects');
  const lanes = page.locator('#projTimeline .gantt-row');
  await expect(lanes).toHaveCount(2);
  await expect(page.locator('#projTimeline .gantt-row[aria-pressed="true"]')).toHaveCount(1);
  await lanes.first().click();
  await expect(lanes.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(lanes.nth(1)).toHaveAttribute('aria-pressed', 'false');
  const open = page.locator('.pl-proj-card.open');
  await expect(open).toHaveCount(1);
  await expect(open.locator('.pl-proj-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(open.locator('.ms-bar')).toHaveAttribute('role', 'progressbar');
  await expect(open.locator('.pl-ms-row .todo-check')).toHaveAccessibleName(/Mark .* done/);
  await expect(open.locator('.pl-ms-row .del')).toHaveAccessibleName(/Delete milestone/);

  await page.click('#addProjectBtn');
  const swatches = page.locator('#pjSwatches');
  await expect(swatches).toHaveAttribute('role', 'radiogroup');
  await expect(swatches).toHaveAccessibleName('Project colour');
  expect(await swatches.locator('[role="radio"][aria-checked="true"]').count()).toBe(1);
  await swatches.locator('[role="radio"][aria-checked="true"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(swatches.locator('[role="radio"][aria-checked="true"]')).toBeFocused();
});

test('planner habit setup has keyboard toggles, colors, and progress semantics', async ({ page }) => {
  await boot(page, 'planner.html');
  await page.waitForFunction(() => window.Planner && window.Planner.Store && document.querySelector('#habitsGrid .add-card'), null, { timeout: 15000 });
  await page.click('#plTab-habits');
  await page.evaluate(() => {
    window.Planner.Store.addHabit({
      name: 'Keyboard habit', color: '#60a5fa', type: 'check',
      targetDays: [0, 1, 2, 3, 4], timesPerWeek: 5, unit: 'time', logs: [],
    });
  });
  await expect(page.locator('#habitsGrid .progress-ring')).toHaveCount(1);
  const addHabit = page.locator('#habitsGrid .add-card');
  await expect(addHabit).toHaveJSProperty('tagName', 'BUTTON');
  await expect(addHabit).toHaveAccessibleName('New habit');
  // Past days can be ticked; later days wait.
  const dots = page.locator('#habitsGrid .habit-card').first().locator('.week-dot');
  await expect(dots).toHaveCount(7);
  await expect(dots.locator('xpath=self::*[@disabled]')).toHaveCount(await page.evaluate(() => 6 - ((new Date().getDay() + 6) % 7)));
  await expect(page.locator('#habitsGrid .h-menu').first()).toHaveAccessibleName(/options/);
  await addHabit.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#habitDlg')).toHaveAttribute('open', '');

  const types = page.locator('#hbType');
  await expect(types).toHaveAttribute('role', 'radiogroup');
  await expect(types).toHaveAccessibleName('Habit type');
  expect(await types.locator('[role="radio"][tabindex="0"]').count()).toBe(1);
  await types.locator('[role="radio"][aria-checked="true"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(types.locator('[role="radio"][aria-checked="true"]')).toBeFocused();

  const days = page.locator('#hbDays');
  await expect(days).toHaveAttribute('role', 'group');
  await expect(days).toHaveAccessibleName('Target days');
  await expect(days.locator('button').first()).toHaveAttribute('aria-pressed', /true|false/);
  await expect(days.locator('button').first()).toHaveAccessibleName('Monday');

  const colors = page.locator('#hbSwatches');
  await expect(colors).toHaveAttribute('role', 'radiogroup');
  await expect(colors).toHaveAccessibleName('Habit color');
  expect(await colors.locator('[role="radio"][aria-checked="true"]').count()).toBe(1);
  await expect(page.locator('#habitsGrid .progress-ring').first()).toHaveAttribute('role', 'progressbar');
});

for (const path of ['index.html', 'finance.html']) {
  test(`${path}: upload drop zone is keyboard-operable and category layout is a named toggle`, async ({ page }) => {
    await boot(page, path);
    await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });

    const dropzone = page.locator('#dropzone');
    await expect(dropzone).toHaveAttribute('role', 'button');
    await expect(dropzone).toHaveAttribute('tabindex', '0');
    await expect(dropzone).toHaveAttribute('aria-controls', 'images');
    await page.evaluate(() => window.openEntryModal());
    await page.waitForFunction(() => document.getElementById('entryDlg').open);
    // The purchase form keeps photos under More details.
    if (path === 'finance.html') await page.click('#fxMoreFold');
    await expect(dropzone).toHaveAccessibleName('Add images or PDF files');
    await page.evaluate(() => {
      window.__dropzoneActivations = 0;
      document.getElementById('images').click = function () { window.__dropzoneActivations += 1; };
    });
    await dropzone.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => window.__dropzoneActivations)).toBe(2);

    await page.evaluate(() => window.MemoCategoryPicker.open());
    await expect(page.locator('.catpick-viewtoggle')).toHaveAttribute('role', 'group');
    await expect(page.locator('.catpick-viewtoggle')).toHaveAccessibleName('Category layout');
    await expect(page.locator('#catPickViewList')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#catPickViewCard')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#catPickViewCard').click();
    await expect(page.locator('#catPickViewList')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#catPickViewCard')).toHaveAttribute('aria-pressed', 'true');
  });
}
