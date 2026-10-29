// Multi-select + batch edit (memo variant): memo-select.js drives selection
// state + the toolbar + the batch-edit dialog; MemoCore.batchApply/batchDelete
// do the mutations. These assert the mechanics end-to-end with seeded entries,
// no network needed (local mode — tests/static-server.js 404s /api/).
const { test, expect } = require('@playwright/test');

// Seed five memo entries under a 'Work' folder and navigate into it so the feed
// shows entry cards (the root view collapses categories into folder cards).
// m0..m2 share the tag 'common'; each of m0..m2 also has a unique x<i> tag.
async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoSelect && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(),
    null, { timeout: 15000 }
  );
  await page.evaluate(async () => {
    const bundle = { version: 1, memos: [], finance: [] };
    for (let i = 0; i < 5; i++) {
      bundle.memos.push({
        id: 'm' + i, description: 'entry ' + i, category: 'Work',
        tags: i < 3 ? ['common', 'x' + i] : ['common'],
        images: [], ts: Date.now() - i * 1000,
      });
    }
    window.MemoStateDb.importBundle(bundle, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    const sel = document.getElementById('categoryFilter');
    if (![...sel.options].some(o => o.value === 'Work')) {
      const o = document.createElement('option'); o.value = 'Work'; o.textContent = 'Work'; sel.appendChild(o);
    }
    sel.value = 'Work';           // navigate into the folder → entry cards render
    window.MemoCore.renderFeed();
  });
  await page.waitForSelector('#feed .card[data-id="m0"]');
}

test('toggle enters select mode, marks cards, opens the toolbar with a live count', async ({ page }) => {
  await boot(page);
  const res = await page.evaluate(() => {
    window.MemoSelect.toggle('m0');
    window.MemoSelect.toggle('m1');
    return {
      active: window.MemoSelect.active(),
      selectedCards: document.querySelectorAll('#feed .card.selected').length,
      feedSelecting: document.getElementById('feed').classList.contains('selecting'),
      bodyMode: document.body.classList.contains('select-mode'),
      barOpen: document.getElementById('selectBar').classList.contains('open'),
      count: document.getElementById('selectCount').textContent,
      m0Selected: document.querySelector('#feed .card[data-id="m0"]').classList.contains('selected'),
      delEnabled: !document.getElementById('selectDelete').disabled,
    };
  });
  expect(res.active).toBe(true);
  expect(res.selectedCards).toBe(2);
  expect(res.feedSelecting).toBe(true);
  expect(res.bodyMode).toBe(true);
  expect(res.barOpen).toBe(true);
  expect(res.count).toBe('2 selected');
  expect(res.m0Selected).toBe(true);
  expect(res.delEnabled).toBe(true);
});

test('in select mode a card click toggles selection instead of opening detail', async ({ page }) => {
  await boot(page);
  const res = await page.evaluate(() => {
    window.MemoSelect.enter('m0');                 // active, m0 selected
    document.querySelector('#feed .card[data-id="m1"]').click(); // should select m1, not open detail
    return {
      m1Selected: document.querySelector('#feed .card[data-id="m1"]').classList.contains('selected'),
      anyDialogOpen: !!document.querySelector('dialog[open]'),
      count: document.getElementById('selectCount').textContent,
    };
  });
  expect(res.m1Selected).toBe(true);
  expect(res.anyDialogOpen).toBe(false);
  expect(res.count).toBe('2 selected');
});

test('invert selects the complement; None clears; Exit leaves select mode', async ({ page }) => {
  await boot(page);
  const res = await page.evaluate(() => {
    window.MemoSelect.enter('m0');                 // m0 selected
    document.getElementById('selectInvert').click(); // → m1..m4 (4)
    const afterInvert = document.querySelectorAll('#feed .card.selected').length;
    document.getElementById('selectNone').click();
    const afterNone = document.querySelectorAll('#feed .card.selected').length;
    document.getElementById('selectExit').click();
    return {
      afterInvert, afterNone,
      active: window.MemoSelect.active(),
      barOpen: document.getElementById('selectBar').classList.contains('open'),
      feedSelecting: document.getElementById('feed').classList.contains('selecting'),
    };
  });
  expect(res.afterInvert).toBe(4);
  expect(res.afterNone).toBe(0);
  expect(res.active).toBe(false);
  expect(res.barOpen).toBe(false);
  expect(res.feedSelecting).toBe(false);
});

test('batch apply moves the category, adds a tag, and removes a shared tag', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    await window.MemoCore.batchApply(['m0', 'm1'], { category: 'Archive', addTags: ['batched'], removeTags: ['common'] });
  });
  const res = await page.evaluate(() => {
    const es = window.MemoCore.getState().db.entries;
    const m0 = es.find(e => e.id === 'm0'), m1 = es.find(e => e.id === 'm1'), m4 = es.find(e => e.id === 'm4');
    return {
      m0cat: m0.category, m1cat: m1.category, m4cat: m4.category,
      m0tags: m0.tags, m1tags: m1.tags, m4tags: m4.tags,
    };
  });
  expect(res.m0cat).toBe('Archive');
  expect(res.m1cat).toBe('Archive');
  expect(res.m4cat).toBe('Work');                  // untouched
  expect(res.m0tags).toContain('batched');
  expect(res.m0tags).not.toContain('common');
  expect(res.m1tags).toContain('batched');
  expect(res.m4tags).toContain('common');          // untouched
});

test('batch delete moves entries to the recycle bin (soft delete)', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => { await window.MemoCore.batchDelete(['m2', 'm3']); });
  const res = await page.evaluate(() => {
    const es = window.MemoCore.getState().db.entries;
    const m2 = es.find(e => e.id === 'm2');
    return {
      m2deleted: !!m2.deletedAt,
      m2perm: !!m2.permanentDeleteAt,
      live: es.filter(e => !e.deletedAt).length,
      renderedCards: document.querySelectorAll('#feed .card[data-id]').length,
    };
  });
  expect(res.m2deleted).toBe(true);
  expect(res.m2perm).toBe(true);
  expect(res.live).toBe(3);                         // 5 seeded − 2 deleted
  expect(res.renderedCards).toBe(3);                // feed re-rendered without them
});

test('batch-edit dialog surfaces only tags shared by ALL selected, and removes marked ones', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.MemoSelect.enter();
    ['m0', 'm1', 'm2'].forEach(id => window.MemoSelect.toggle(id)); // all three share 'common'
    document.getElementById('selectEdit').click();                   // opens + populates the dialog
  });
  await page.waitForSelector('#batchEditDlg[open]');
  const chips = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#batchCommonTags .tagpill.removable')).map(c => c.getAttribute('data-tag'))
  );
  expect(chips).toEqual(['common']);               // x0/x1/x2 are NOT shared by all three

  await page.evaluate(async () => {
    document.querySelector('#batchCommonTags .tagpill.removable').classList.add('pending-remove');
    document.getElementById('batchAddTag').value = 'grp';
    document.getElementById('batchEditApply').click();
  });
  await page.waitForFunction(() => !document.getElementById('batchEditDlg').open);
  const res = await page.evaluate(() => {
    const es = window.MemoCore.getState().db.entries;
    return ['m0', 'm1', 'm2'].map(id => es.find(e => e.id === id)).map(e => ({
      hasCommon: e.tags.includes('common'), hasGrp: e.tags.includes('grp'),
    }));
  });
  res.forEach(r => { expect(r.hasCommon).toBe(false); expect(r.hasGrp).toBe(true); });
});
