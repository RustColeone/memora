const { test, expect } = require('@playwright/test');

function markupProbe(name) {
  return `<em data-injection-probe="${name}">literal-${name}</em>`;
}

const CARD_PAYLOAD = markupProbe('stored-card-description');
const DETAIL_DESCRIPTION = markupProbe('stored-detail-description');
const DETAIL_CATEGORY = markupProbe('stored-detail-category');
const DETAIL_TAG = markupProbe('stored-detail-tag');
const DETAIL_ATTACHMENT = markupProbe('stored-detail-attachment') + '.pdf';
const CONTROL_CATEGORY = markupProbe('entry-control-category');
const CONTROL_TAG = markupProbe('entry-control-tag');
const CONTROL_ATTACHMENT = markupProbe('entry-control-attachment') + '.pdf';
const FINANCE_DESCRIPTION = markupProbe('finance-description');
const FINANCE_CATEGORY = markupProbe('finance-category');
const FINANCE_TAG = markupProbe('finance-tag');
const FINANCE_ITEM_NAME = markupProbe('finance-item-name');
const FINANCE_ITEM_DESCRIPTION = markupProbe('finance-item-description');
const FINANCE_ATTACHMENT = markupProbe('finance-attachment') + '.pdf';

const NATIVE_FILENAME = markupProbe('native-share-filename') + '.pdf';

async function boot(page) {
  await page.waitForFunction(
    () => window.MemoCore && window.MemoVariant && window.MemoStateDb && window.MemoStateDb.ready(),
    null,
    { timeout: 15000 }
  );
  await page.evaluate(() => window.MemoAppReady || window.MemoCore.start());
}

async function replaceBundle(page, memos) {
  await page.evaluate(async (entries) => {
    window.MemoStateDb.importBundle({
      version: 1,
      memos: entries,
      finance: [],
      planner: [],
    }, 'replace');
    await window.MemoStateDb.flush();
  }, memos);
}

test('persisted memo descriptions render as literal card text without parsing markup', async ({ page }) => {
  await page.goto('/index.html');
  await boot(page);

  await replaceBundle(page, [{
    id: 'stored-card-probe-entry',
    description: CARD_PAYLOAD,
    category: 'Uncategorized',
    tags: [],
    images: [],
    attachments: [],
    ts: 1735689600000,
  }]);

  // Reload from SQLite so this covers stored data, not only an in-memory object.
  await page.reload();
  await boot(page);
  const card = page.locator('#feed .card[data-id="stored-card-probe-entry"]');
  await expect(card).toBeVisible();

  const actual = await card.evaluate((element, payload) => ({
    text: element.querySelector('.card-desc')?.textContent,
    injectedElements: element.querySelectorAll('[data-injection-probe]').length,
    expectedText: payload,
  }), CARD_PAYLOAD);

  expect(actual).toEqual({
    text: CARD_PAYLOAD,
    injectedElements: 0,
    expectedText: CARD_PAYLOAD,
  });
});

test('persisted memo detail fields render literally without parsing markup', async ({ page }) => {
  await page.goto('/index.html');
  await boot(page);

  await replaceBundle(page, [{
    id: 'stored-detail-probe-entry',
    description: DETAIL_DESCRIPTION,
    category: DETAIL_CATEGORY,
    tags: [DETAIL_TAG],
    images: [],
    attachments: [{
      name: DETAIL_ATTACHMENT,
      url: '/uploads/security-probe.pdf',
      type: 'application/pdf',
    }],
    ts: 1735689600000,
  }]);

  await page.reload();
  await boot(page);
  await page.evaluate(() => window.MemoVariant.openDetail('stored-detail-probe-entry'));
  await expect(page.locator('#detailDlg')).toHaveAttribute('open', '');

  const actual = await page.evaluate((expected) => {
    const detail = document.getElementById('detailContent');
    const metaText = detail.querySelector('.muted')?.textContent || '';
    const tagText = detail.querySelector('.tagpill')?.textContent || '';
    const attachmentText = detail.querySelector('.filelink-pdf')?.textContent.trim() || '';
    return {
      descriptionIsLiteral: detail.querySelector('h3')?.textContent === expected.description,
      categoryIsLiteral: metaText.includes(expected.category),
      tagIsLiteral: tagText === '#' + expected.tag,
      attachmentIsLiteral: attachmentText === expected.attachment,
      injectedElements: detail.querySelectorAll('[data-injection-probe]').length,
    };
  }, {
    description: DETAIL_DESCRIPTION,
    category: DETAIL_CATEGORY,
    tag: DETAIL_TAG,
    attachment: DETAIL_ATTACHMENT,
  });

  expect(actual).toEqual({
    descriptionIsLiteral: true,
    categoryIsLiteral: true,
    tagIsLiteral: true,
    attachmentIsLiteral: true,
    injectedElements: 0,
  });
});

test('stored category, tag, and attachment names stay literal in entry controls', async ({ page }) => {
  await page.goto('/index.html');
  await boot(page);

  const actual = await page.evaluate((entry) => {
    const state = window.MemoCore.getState();
    state.settings.categories = [entry.category];
    state.settings.tags = [entry.tags[0]];
    state.settings.tagCounts = { [entry.tags[0]]: 1 };
    window.openEntryModal(entry);

    const category = Array.from(document.getElementById('categoryInput').options)
      .find(option => option.value === entry.category);
    const tagChip = document.querySelector('#tagChips .chip');
    const attachment = document.querySelector('#extraAttachments a');
    return {
      categoryText: category?.textContent || '',
      tagText: tagChip?.firstChild?.textContent.trim() || '',
      attachmentText: attachment?.textContent.trim() || '',
      injectedElements: document.querySelectorAll('[data-injection-probe]').length,
    };
  }, {
    id: 'stored-entry-control-probe',
    description: 'entry control probe',
    category: CONTROL_CATEGORY,
    tags: [CONTROL_TAG],
    images: [],
    attachments: [{
      name: CONTROL_ATTACHMENT,
      url: '/uploads/entry-control-probe.pdf',
      type: 'application/pdf',
    }],
    ts: 1735689600000,
  });

  expect(actual).toEqual({
    categoryText: CONTROL_CATEGORY,
    tagText: CONTROL_TAG,
    attachmentText: CONTROL_ATTACHMENT,
    injectedElements: 0,
  });
});

test('stored finance fields stay literal in the list and detail views', async ({ page }) => {
  await page.goto('/finance.html');
  await boot(page);

  await page.evaluate(async (entry) => {
    window.MemoStateDb.importBundle({
      version: 1,
      memos: [],
      finance: [entry],
      planner: [],
    }, 'replace');
    await window.MemoStateDb.flush();
  }, {
    id: 'stored-finance-probe-entry',
    description: FINANCE_DESCRIPTION,
    category: FINANCE_CATEGORY,
    tags: [FINANCE_TAG],
    images: [],
    attachments: [{
      name: FINANCE_ATTACHMENT,
      url: '/uploads/finance-probe.pdf',
      type: 'application/pdf',
    }],
    items: [{
      name: FINANCE_ITEM_NAME,
      description: FINANCE_ITEM_DESCRIPTION,
      amount: 1,
      unitPrice: 2,
      totalPrice: 2,
    }],
    purchaseDate: '2025-01-01',
    total: 2,
    ts: 1735689600000,
  });

  await page.reload();
  await boot(page);
  const row = page.locator('#feed tr.entry-row[data-id="stored-finance-probe-entry"]');
  await expect(row).toBeVisible();
  const listResult = await row.evaluate((element) => ({
    description: element.querySelector('.desc-text')?.firstChild?.textContent || '',
    tag: element.querySelector('.tagpill')?.textContent || '',
    attachment: element.querySelector('.filelink')?.textContent.trim() || '',
    injectedElements: element.querySelectorAll('[data-injection-probe]').length,
  }));
  expect(listResult).toEqual({
    description: FINANCE_DESCRIPTION.slice(0, 60) + '…',
    tag: '#' + FINANCE_TAG,
    attachment: FINANCE_ATTACHMENT,
    injectedElements: 0,
  });

  await page.evaluate(() => window.MemoVariant.openDetail('stored-finance-probe-entry'));
  await expect(page.locator('#detailDlg')).toHaveAttribute('open', '');
  const detailResult = await page.evaluate((expected) => {
    const detail = document.getElementById('detailContent');
    const itemCells = Array.from(detail.querySelectorAll('.clamp-scroll')).map(element => element.textContent);
    return {
      description: detail.querySelector('h3')?.textContent || '',
      categoryIncluded: (detail.querySelector('.muted')?.textContent || '').includes(expected.category),
      tag: detail.querySelector('.tagpill')?.textContent || '',
      items: itemCells,
      attachment: detail.querySelector('.filelist a')?.textContent.trim() || '',
      injectedElements: detail.querySelectorAll('[data-injection-probe]').length,
    };
  }, { category: FINANCE_CATEGORY });
  expect(detailResult).toEqual({
    description: FINANCE_DESCRIPTION,
    categoryIncluded: true,
    tag: '#' + FINANCE_TAG,
    items: [FINANCE_ITEM_NAME, FINANCE_ITEM_DESCRIPTION],
    attachment: FINANCE_ATTACHMENT,
    injectedElements: 0,
  });
});

test('native shared attachment filenames render as literal draft text', async ({ page }) => {
  await page.goto('/index.html');
  await boot(page);
  await page.waitForFunction(() => window.MemoShare && window.openEntryModal);

  const actual = await page.evaluate(async (filename) => {
    window.Capacitor = window.Capacitor || {};
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    window.Capacitor.Plugins.ShareReceiver = {
      consumePendingShare: async () => ({
        text: '',
        files: [{
          name: filename,
          mime: 'application/pdf',
          base64: 'data:application/pdf;base64,JVBERi0xLjQ=',
        }],
      }),
    };

    const consumed = await window.MemoShare.consumePendingShare();
    const attachment = document.querySelector('#extraAttachments a');
    return {
      consumed,
      text: attachment?.textContent.trim() || '',
      injectedElements: document.querySelectorAll('[data-injection-probe]').length,
    };
  }, NATIVE_FILENAME);

  expect(actual).toEqual({
    consumed: true,
    text: NATIVE_FILENAME,
    injectedElements: 0,
  });
});
