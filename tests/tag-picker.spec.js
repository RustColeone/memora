// Phase 2 — two-panel tag picker. Applied tags on top, available below; tapping a
// pill moves it across and edits window.workingTags + the inline #tagChips.
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready() && window.MemoTagPicker, null, { timeout: 15000 });
}
async function openModal(page) {
  await page.evaluate(() => document.getElementById('fab').click());
  await page.waitForSelector('#entryDlg[open]');
}
const panelCounts = (page) => page.evaluate(() => ({
  av: document.querySelectorAll('#tagPickAvailable .tag-pick').length,
  ap: document.querySelectorAll('#tagPickApplied .tag-pick').length,
}));

test('tap-to-move between panels edits workingTags + inline chips; search + Enter-to-add work', async ({ page }) => {
  await boot(page);
  await openModal(page);                       // new entry → workingTags empty
  await page.evaluate(() => {
    const s = window.MemoCore.getState().settings;
    s.tags = ['alpha', 'beta', 'gamma']; s.tagCounts = { alpha: 3, beta: 1, gamma: 2 };
  });
  await page.evaluate(() => window.MemoTagPicker.open());
  await page.waitForSelector('#tagPickerDlg[open]');
  expect(await panelCounts(page)).toEqual({ av: 3, ap: 0 });

  // available → applied
  await page.click('#tagPickAvailable .tag-pick[data-tag="beta"]');
  await page.waitForFunction(() => window.workingTags.has('beta'));
  expect(await panelCounts(page)).toEqual({ av: 2, ap: 1 });
  expect(await page.evaluate(() => [...document.querySelectorAll('#tagChips .chip')].some(c => c.textContent.includes('beta')))).toBe(true);

  // applied → available (removes it)
  await page.click('#tagPickApplied .tag-pick[data-tag="beta"]');
  await page.waitForFunction(() => !window.workingTags.has('beta'));
  expect(await panelCounts(page)).toEqual({ av: 3, ap: 0 });

  // search filters both panels
  await page.fill('#tagPickSearch', 'al');
  await page.evaluate(() => document.getElementById('tagPickSearch').dispatchEvent(new Event('input')));
  expect((await panelCounts(page)).av).toBe(1);   // only 'alpha'

  // Enter in the search box adds a brand-new tag straight to applied
  await page.fill('#tagPickSearch', 'delta');
  await page.press('#tagPickSearch', 'Enter');
  await page.waitForFunction(() => window.workingTags.has('delta'));
  expect(await page.evaluate(() => [...document.querySelectorAll('#tagChips .chip')].some(c => c.textContent.includes('delta')))).toBe(true);
});

test('a new tag moves to Available before Done, then only associated drafts survive', async ({ page }) => {
  await boot(page);
  await openModal(page);
  await page.evaluate(() => window.MemoTagPicker.open());

  await page.fill('#tagPickSearch', 'draft-tag');
  await page.press('#tagPickSearch', 'Enter');
  await page.waitForSelector('#tagPickApplied .tag-pick[data-tag="draft-tag"]');
  expect(await page.evaluate(() => window.workingTagDrafts.has('draft-tag'))).toBe(true);

  // The previously missing destination now exists, allowing the existing FLIP
  // transition to move this fresh tag from Applied to Available.
  await page.click('#tagPickApplied .tag-pick[data-tag="draft-tag"]');
  await page.waitForSelector('#tagPickAvailable .tag-pick[data-tag="draft-tag"]');
  expect(await page.evaluate(() => ({
    applied: window.workingTags.has('draft-tag'),
    draft: window.workingTagDrafts.has('draft-tag'),
  }))).toEqual({ applied: false, draft: true });

  // Escape/system Back returns to the entry editor without finalizing the
  // selection. The temporary option must still be present when reopening.
  await page.evaluate(() => document.getElementById('tagPickerDlg').close());
  await page.waitForFunction(() => !document.getElementById('tagPickerDlg').open);
  expect(await page.evaluate(() => window.workingTagDrafts.has('draft-tag'))).toBe(true);
  await page.evaluate(() => window.MemoTagPicker.open());
  await page.waitForSelector('#tagPickAvailable .tag-pick[data-tag="draft-tag"]');

  // Done finalizes the picker decision: an unassociated draft is not promoted
  // into the derived global settings catalog and disappears on the next open.
  await page.click('#tagPickClose');
  await page.waitForFunction(() => !document.getElementById('tagPickerDlg').open);
  expect(await page.evaluate(() => window.workingTagDrafts.has('draft-tag'))).toBe(false);

  await page.evaluate(() => window.MemoTagPicker.open());
  await page.fill('#tagPickSearch', 'kept-tag');
  await page.press('#tagPickSearch', 'Enter');
  await page.click('#tagPickClose');
  await page.waitForFunction(() => !document.getElementById('tagPickerDlg').open);
  expect(await page.evaluate(() => ({
    applied: window.workingTags.has('kept-tag'),
    draft: window.workingTagDrafts.has('kept-tag'),
    global: window.MemoCore.getState().settings.tags.includes('kept-tag'),
  }))).toEqual({ applied: true, draft: true, global: false });

  await page.fill('#desc', 'Persist a new tag');
  await page.click('#saveBtn');
  await page.waitForFunction(() => !document.getElementById('entryDlg').open);
  await page.waitForFunction(() => window.MemoCore.getState().settings.tags.includes('kept-tag'));
  expect(await page.evaluate(() => ({
    persisted: window.MemoCore.getState().db.entries.some(entry => (entry.tags || []).includes('kept-tag')),
    drafts: window.workingTagDrafts.size,
  }))).toEqual({ persisted: true, drafts: 0 });
});
