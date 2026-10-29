// Reusable memo library picker: entry grouping, individual image selection and
// one-way structural filter snapshots.
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoLibraryPicker && window.MemoCore, null, { timeout: 15000 });
  await page.evaluate(() => window.MemoCore.start());
  // The variant also auto-starts Core at DOMContentLoaded; start() shares that
  // in-flight promise, so this returns only after the store and mode probe settle.
  await page.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready());
}

function image(path) { return `/uploads/2026-08-02/${path}`; }
const JPEG_DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';
const SVG_DATA = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#d97706"/></svg>'
);

test('groups memo media, expands the +(N-3) tile, and returns image descriptors', async ({ page }) => {
  await boot(page);
  await page.evaluate((images) => {
    const state = window.MemoCore.getState();
    state.activeFilters.dateFrom = null;
    state.activeFilters.dateTo = null;
    state.activeFilters.cats.clear();
    state.activeFilters.tags.clear();
    window.MemoCore.setActiveEntryFilter(null);
    state.db.entries = [
      { id: 'many', description: 'Six reference images', category: 'Work', tags: ['panel'], ts: 20,
        images, _storedPaths: images.map(url => url.slice(1)) },
      { id: 'one', description: 'A single image', category: 'Home', tags: [], ts: 10,
        images: ['/uploads/2026-08-02/only.png'], _storedPaths: ['uploads/2026-08-02/only.png'] },
    ];
    window.__picked = null;
    window.MemoLibraryPicker.open({ mode: 'multi', filter: 'image', min: 2, onDone: value => { window.__picked = value; } });
  }, Array.from({ length: 6 }, (_, index) => image(`page-${index + 1}.jpg`)));

  await expect(page.locator('.libpick-entry')).toHaveCount(2);
  const many = page.locator('.libpick-entry[data-entry-id="many"]');
  await expect(many.locator('.libpick-image')).toHaveCount(4);
  await expect(many.locator('.libpick-more-count')).toHaveText('+3');
  await many.locator('.libpick-more').click();
  await expect(many.locator('.libpick-image[data-media-key]')).toHaveCount(6);

  await many.locator('.libpick-image[data-media-key]').nth(0).click();
  await many.locator('.libpick-image[data-media-key]').nth(4).click();
  await page.locator('#libPickDone').click();
  await page.waitForFunction(() => Array.isArray(window.__picked));

  const picked = await page.evaluate(() => window.__picked);
  expect(picked).toEqual([
    { entryId: 'many', index: 0, ref: 'uploads/2026-08-02/page-1.jpg', storedPath: 'uploads/2026-08-02/page-1.jpg',
      url: '/uploads/2026-08-02/page-1.jpg', mime: 'image/jpeg', name: 'page-1.jpg', safe: false },
    { entryId: 'many', index: 4, ref: 'uploads/2026-08-02/page-5.jpg', storedPath: 'uploads/2026-08-02/page-5.jpg',
      url: '/uploads/2026-08-02/page-5.jpg', mime: 'image/jpeg', name: 'page-5.jpg', safe: false },
  ]);
});

test('snapshots global filters and memo context without writing picker edits back', async ({ page }) => {
  await boot(page);
  await page.evaluate((jpeg) => {
    const state = window.MemoCore.getState();
    state.db.entries = [
      { id: 'current', description: 'Current Work memo', category: 'Work', tags: ['red'], ts: 30,
        images: [jpeg], _storedPaths: ['uploads/current.jpg'] },
      { id: 'second', description: 'Second Work memo', category: 'Work', tags: ['red'], ts: 20,
        images: [jpeg], _storedPaths: ['uploads/second.jpg'] },
      { id: 'other', description: 'Other memo', category: 'Home', tags: ['blue'], ts: 10,
        images: [jpeg], _storedPaths: ['uploads/other.jpg'] },
    ];
    state.activeFilters.dateFrom = null;
    state.activeFilters.dateTo = null;
    state.activeFilters.cats = new Set(['Work']);
    state.activeFilters.tags = new Set(['red']);
    state.activeFilters.tagMatch = 'any';
    window.MemoCore.setActiveEntryFilter('current');
    window.MemoLibraryPicker.open({ mode: 'single', filter: 'jpeg' });
  }, JPEG_DATA);

  await expect(page.locator('.libpick-entry')).toHaveCount(1);
  await expect(page.locator('.libpick-entry')).toHaveAttribute('data-entry-id', 'current');
  await page.locator('.libpick-chip[data-filter-kind="entry"]').click();
  expect(await page.evaluate(() => window.MemoLibraryPicker.__test.groupedEntries().map(group => group.entry.id))).toEqual(['current', 'second']);
  await expect(page.locator('.libpick-entry')).toHaveCount(2);

  // The picker now reuses the main Filters dialog in capture mode (no separate
  // libPickFilterDlg): resetting + applying there clears the picker's LOCAL filter
  // only, never the global feed filter.
  await page.locator('#libPickFilterBtn').click();
  await page.locator('#filtersReset').click();
  await page.locator('#filtersApply').click();
  await expect(page.locator('.libpick-entry')).toHaveCount(3);

  const outside = await page.evaluate(() => {
    const filters = window.MemoCore.getState().activeFilters;
    return { cats: [...filters.cats], tags: [...filters.tags], tagMatch: filters.tagMatch,
      entryId: window.MemoCore.getActiveEntryFilter(), local: window.MemoLibraryPicker.getState().filters };
  });
  expect(outside.cats).toEqual(['Work']);
  expect(outside.tags).toEqual(['red']);
  expect(outside.tagMatch).toBe('any');
  expect(outside.entryId).toBe('current');
  expect(outside.local).toMatchObject({ cats: [], tags: [], entryId: null });
});

test('keeps individual selections while local search narrows the entry list', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const state = window.MemoCore.getState();
    state.activeFilters.cats.clear(); state.activeFilters.tags.clear();
    window.MemoCore.setActiveEntryFilter(null);
    state.db.entries = [
      { id: 'alpha', description: 'Alpha memo', category: 'Work', tags: [], ts: 2, images: ['/uploads/a.png'] },
      { id: 'beta', description: 'Beta memo', category: 'Work', tags: [], ts: 1, images: ['/uploads/b.png'] },
    ];
    window.MemoLibraryPicker.open({ mode: 'multi', min: 2 });
  });

  await page.locator('.libpick-entry[data-entry-id="alpha"] .libpick-image').click();
  await page.locator('#libPickSearch').fill('Beta');
  await expect(page.locator('.libpick-entry')).toHaveCount(1);
  await expect(page.locator('#libPickCount')).toContainText('1 selected');
  await page.locator('.libpick-entry[data-entry-id="beta"] .libpick-image').click();
  await expect(page.locator('#libPickCount')).toContainText('2 selected');
  await expect(page.locator('#libPickDone')).toBeEnabled();
});

test('uses shared picker chrome with compact square thumbnails and a filter dot', async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 900, height: 760 });
  await page.evaluate((thumbnail) => {
    const state = window.MemoCore.getState();
    state.activeFilters.dateFrom = null;
    state.activeFilters.dateTo = null;
    state.activeFilters.cats = new Set(['Work']);
    state.activeFilters.tags.clear();
    window.MemoCore.setActiveEntryFilter(null);
    state.db.entries = [
      { id: 'single', description: 'Single square', category: 'Work', tags: [], ts: 2, images: [thumbnail] },
      { id: 'pair', description: 'Two squares', category: 'Work', tags: [], ts: 1, images: [thumbnail, thumbnail] },
    ];
    window.MemoLibraryPicker.open({ mode: 'multi', filter: 'image' });
  }, SVG_DATA);

  await expect(page.locator('.libpick-entry')).toHaveCount(2);
  await expect(page.locator('.libpick-entry img.lazy-loaded')).toHaveCount(3);

  const chrome = await page.evaluate(() => {
    const input = document.getElementById('libPickSearch');
    const searchIcon = document.querySelector('.lib-picker-search .svg-icon-search');
    const filter = document.getElementById('libPickFilterBtn');
    const filterIcon = filter.querySelector('.lib-picker-tool-icon');
    const breadcrumb = document.getElementById('libPickChips');
    const single = document.querySelector('.libpick-entry[data-entry-id="single"]');
    const pair = document.querySelector('.libpick-entry[data-entry-id="pair"]');
    const image = single.querySelector('img.lazy-loaded');
    const probe = document.createElement('span');
    probe.style.color = 'var(--text)';
    probe.style.backgroundColor = 'var(--danger)';
    document.body.appendChild(probe);
    const expectedText = getComputedStyle(probe).color;
    const expectedDanger = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const inputStyle = getComputedStyle(input);
    const iconStyle = getComputedStyle(searchIcon);
    const filterStyle = getComputedStyle(filter);
    const dotStyle = getComputedStyle(filterIcon, '::after');
    const entryRect = single.getBoundingClientRect();
    const pairRect = pair.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    return {
      inputColor: inputStyle.color,
      expectedText,
      inputAppearance: inputStyle.appearance,
      searchMask: iconStyle.maskImage || iconStyle.webkitMaskImage,
      filterPressed: filter.getAttribute('aria-pressed'),
      filterBackground: filterStyle.backgroundColor,
      dotContent: dotStyle.content,
      dotWidth: dotStyle.width,
      dotHeight: dotStyle.height,
      dotBackground: dotStyle.backgroundColor,
      expectedDanger,
      breadcrumbTag: breadcrumb.tagName,
      breadcrumbShared: breadcrumb.classList.contains('breadcrumb'),
      breadcrumbRoot: breadcrumb.querySelector('.libpick-breadcrumb-root')?.textContent,
      breadcrumbSeparators: breadcrumb.querySelectorAll('.bc-sep').length,
      folderCrumb: breadcrumb.querySelector('[data-filter-kind="cat"]')?.textContent,
      breadcrumbShape: Array.from(breadcrumb.children).map((node) => ({
        separator: node.classList.contains('bc-sep'),
        back: node.classList.contains('bc-back'),
        kind: node.dataset.filterKind || null,
      })),
      entryWidth: entryRect.width,
      entryFitsContent: Math.abs(entryRect.height - (single.querySelector('.libpick-entry-head').getBoundingClientRect().height
        + single.querySelector('.libpick-montage').getBoundingClientRect().height + 2)),
      pairIsNotStretched: pairRect.height < entryRect.height,
      imageWidth: imageRect.width,
      imageHeight: imageRect.height,
    };
  });

  expect(chrome.inputColor).toBe(chrome.expectedText);
  expect(chrome.inputAppearance).toBe('none');
  expect(chrome.searchMask).not.toBe('none');
  expect(chrome.filterPressed).toBe('true');
  expect(chrome.filterBackground).toBe('rgba(0, 0, 0, 0)');
  expect(chrome.dotContent).not.toBe('none');
  expect(chrome.dotWidth).toBe('8px');
  expect(chrome.dotHeight).toBe('8px');
  expect(chrome.dotBackground).toBe(chrome.expectedDanger);
  expect(chrome.breadcrumbTag).toBe('NAV');
  expect(chrome.breadcrumbShared).toBe(true);
  expect(chrome.breadcrumbRoot).toContain('Library');
  expect(chrome.breadcrumbSeparators).toBe(1);
  expect(chrome.folderCrumb).toBe('Folder: Work');
  expect(chrome.breadcrumbShape).toEqual([
    { separator: false, back: true, kind: 'all' },
    { separator: true, back: false, kind: null },
    { separator: false, back: true, kind: 'cat' },
  ]);
  expect(chrome.entryWidth).toBeLessThanOrEqual(181);
  expect(chrome.entryFitsContent).toBeLessThanOrEqual(1);
  expect(chrome.pairIsNotStretched).toBe(true);
  expect(Math.abs(chrome.imageWidth - chrome.imageHeight)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 360, height: 740 });
  const mobile = await page.evaluate(() => {
    const grid = document.getElementById('libPickGrid');
    const image = grid.querySelector('img.lazy-loaded');
    const imageRect = image.getBoundingClientRect();
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      imageWidth: imageRect.width,
      imageHeight: imageRect.height,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(mobile.columns).toBe(3);
  expect(Math.abs(mobile.imageWidth - mobile.imageHeight)).toBeLessThanOrEqual(1);
  expect(mobile.pageOverflow).toBe(0);
});

test('opening and closing a memo applies and removes the picker-only entry context', async ({ page }) => {
  await boot(page);
  await page.evaluate((jpeg) => {
    const state = window.MemoCore.getState();
    state.activeFilters.dateFrom = null;
    state.activeFilters.dateTo = null;
    state.activeFilters.cats = new Set(['Work']);
    state.activeFilters.tags = new Set(['red']);
    state.activeFilters.tagMatch = 'any';
    state.db.entries = [
      { id: 'context-memo', description: 'Open memo', category: 'Work', tags: ['red'], ts: 2,
        images: [jpeg], _storedPaths: ['uploads/context.jpg'] },
      { id: 'same-global-filter', description: 'Another memo', category: 'Work', tags: ['red'], ts: 1,
        images: [jpeg], _storedPaths: ['uploads/other.jpg'] },
    ];
    window.MemoVariant.openDetail('context-memo');
  }, JPEG_DATA);

  await expect(page.locator('#detailDlg')).toBeVisible();
  expect(await page.evaluate(() => window.MemoCore.getActiveEntryFilter())).toBe('context-memo');
  await page.locator('#detailMenuBtn').click();
  await page.locator('#detailExifBtn').click();
  await expect(page.locator('#libMediaPickerDlg')).toBeVisible();
  await expect(page.locator('.libpick-chip[data-filter-kind="entry"]')).toContainText('Open memo');
  expect(await page.evaluate(() => window.MemoLibraryPicker.__test.groupedEntries().map(group => group.entry.id))).toEqual(['context-memo']);
  await expect(page.locator('.libpick-entry')).toHaveCount(1);
  await expect(page.locator('.libpick-entry')).toHaveAttribute('data-entry-id', 'context-memo');

  await page.locator('#libPickCancel').click();
  expect(await page.evaluate(() => window.MemoCore.getActiveEntryFilter())).toBe('context-memo');
  await page.evaluate(() => document.getElementById('detailDlg').close());
  await page.waitForFunction(() => window.MemoCore.getActiveEntryFilter() === null);
  expect(await page.evaluate(() => window.MemoCore.getActiveEntryFilter())).toBeNull();
});

test('programmatic closes cancel exactly once while Safe teardown preserves the picker session', async ({ page }) => {
  await boot(page);

  await page.evaluate(() => {
    window.__pickerCancelCount = 0;
    window.MemoLibraryPicker.open({
      mode: 'single',
      onCancel: () => { window.__pickerCancelCount += 1; },
    });
  });
  await page.evaluate(() => document.getElementById('libMediaPickerDlg').close());
  await page.waitForFunction(() => window.__pickerCancelCount === 1);
  await page.evaluate(() => document.getElementById('libMediaPickerDlg').dispatchEvent(new Event('close')));
  expect(await page.evaluate(() => ({
    count: window.__pickerCancelCount,
    active: window.MemoLibraryPicker.getState().active,
  }))).toEqual({ count: 1, active: false });

  await page.evaluate(() => {
    let safeView = false;
    window.MemoPrivacy.levelOf = () => 2;
    window.MemoPrivacy.isSafeView = () => safeView;
    window.MemoPrivacy.canViewEntry = () => true;
    window.MemoPrivacy.toggleSafe = async () => {
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
      safeView = !safeView;
      document.dispatchEvent(new CustomEvent('memo:privacy-unlocked', { detail: { scope: 'safe' } }));
    };
    window.__pickerCancelCount = 0;
    window.MemoLibraryPicker.open({
      mode: 'single',
      onCancel: () => { window.__pickerCancelCount += 1; },
    });
  });
  await page.locator('#libPickSafeBtn').click();
  await expect(page.locator('#libMediaPickerDlg')).toBeVisible();
  expect(await page.evaluate(() => ({
    count: window.__pickerCancelCount,
    active: window.MemoLibraryPicker.getState().active,
  }))).toEqual({ count: 0, active: true });

  await page.evaluate(() => document.getElementById('libMediaPickerDlg').close());
  await page.waitForFunction(() => window.__pickerCancelCount === 1);
  expect(await page.evaluate(() => window.__pickerCancelCount)).toBe(1);
});
