// The purchase form (memo-finance-entry.js) and reading receipts (memo-receipt.js):
// a one-amount purchase, receipt lines with discounts, fees and tax, the check
// that the lines add up to a typed total, store / payment / notes surviving a
// reload, Scan a receipt filling the form, and the landscape two-column layout.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 393, height: 873 }, hasTouch: true, isMobile: true });

const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

async function boot(page, entries = []) {
  await page.goto('/finance.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoVariant && window.MemoStateDb?.ready() && window.MemoFinanceEntry, null, { timeout: 15000 });
  await page.evaluate(async (entries) => {
    window.MemoStateDb.saveEntries(entries, 'finance');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('finance') || [];
    window.MemoVariant.renderFeed();
  }, entries);
}
const saved = page => page.evaluate(() => window.MemoCore.getState().db.entries.filter(e => !e.deletedAt).map(e => ({ ...e })));
async function newPurchase(page) {
  await page.click('#fab');
  await expect(page.locator('#entryDlg[open] #total')).toBeVisible();
}
async function addLine(page, kind, name, price, qty) {
  if (kind !== 'item') await page.click(`.fx-seg [data-kind="${kind}"]`);
  await page.fill('#fxAddName', name);
  if (qty != null) await page.fill('#fxAddQty', String(qty));
  await page.fill('#fxAddPrice', String(price));
  await page.press('#fxAddPrice', 'Enter');
}

test('a one-amount purchase: total, what, a category chip and Yesterday, then Save', async ({ page }) => {
  await boot(page, [{ id: 'old', description: 'Bus', category: 'Transport', sheet: 'General', tags: [], images: [], attachments: [], purchaseDate: '2026-10-01', items: [], total: 2.5, ts: 1 }]);
  await newPurchase(page);
  await expect(page.locator('#dlgTitle')).toHaveText('New purchase');
  await expect(page.locator('.fx-cat [data-cat="Transport"]')).toBeVisible();   // recent categories as chips
  await page.fill('#total', '31.85');
  await page.fill('#desc', 'Menya Kouji ramen');
  await page.click('.fx-cat [data-cat="Transport"]');
  await page.click('#fxDateChips [data-day="-1"]');
  await page.click('#saveBtn');
  await expect(page.locator('#entryDlg')).not.toHaveAttribute('open', '');
  const y = new Date(); y.setDate(y.getDate() - 1);
  const e = (await saved(page)).find(x => x.description === 'Menya Kouji ramen');
  expect([e.total, e.items, e.category, e.purchaseDate]).toEqual([31.85, [], 'Transport', ymd(y)]);
  await expect(page.locator('tr.entry-row', { hasText: 'Menya Kouji ramen' }).locator('td.col-total')).toHaveText('$31.85');
});

test('receipt lines: items, a discount before tax, a fee after it, and the total worked out', async ({ page }) => {
  await boot(page);
  await newPurchase(page);
  await page.fill('#desc', 'Groceries');
  await page.click('#fxItemsFold');
  await addLine(page, 'item', 'Milk', 4.29, 2);
  await expect(page.locator('#fxAddName')).toBeFocused();           // Enter starts the next line
  await addLine(page, 'item', 'Eggs', 6.49);
  await addLine(page, 'discount', 'Member savings', 2);
  await addLine(page, 'fee', 'Bag fee', 0.10);
  await page.fill('#tax', '8.25%');
  // (8.58 + 6.49 − 2.00) × 1.0825 + 0.10 = 14.25
  await expect(page.locator('#fxSumTotal')).toHaveText('14.25');
  await expect(page.locator('#total')).toHaveValue('14.25');
  await expect(page.locator('#fxRows .fx-row')).toHaveCount(4);
  await expect(page.locator('#fxRows .fx-row').nth(2)).toContainText('−2.00');
  await page.click('#saveBtn');
  await expect(page.locator('#entryDlg')).not.toHaveAttribute('open', '');
  const e = (await saved(page))[0];
  expect(e.total).toBe(14.25);
  expect(e.tax).toBe('8.25%');
  expect(e.items.map(i => [i.kind || 'item', i.name, i.amount, i.unitPrice, i.totalPrice])).toEqual([
    ['item', 'Milk', 2, 4.29, 8.58], ['item', 'Eggs', 1, 6.49, 6.49], ['discount', 'Member savings', 1, -2, -2], ['fee', 'Bag fee', 1, 0.1, 0.1]]);
  // The table's Tax column is the tax on the taxed lines only.
  await expect(page.locator('tr.entry-row td.col-tax')).toHaveText('$1.08');
});

test('a row opens in place to edit; Remove has Undo', async ({ page }) => {
  await boot(page);
  await newPurchase(page);
  await page.click('#fxItemsFold');
  await addLine(page, 'item', 'Milk', 4.29);
  await page.click('#fxRows .fx-row');
  await page.fill('#fxEdQty', '3');
  await expect(page.locator('#fxEdLine')).toHaveText('12.87');
  await page.fill('#fxEdNote', '1 gal');
  await page.click('#fxEdDone');
  await expect(page.locator('#fxRows .fx-row')).toContainText('3 × 4.29 · 1 gal');
  await page.click('#fxRows .fx-row');
  await page.click('#fxEdRemove');
  await expect(page.locator('#fxRows .fx-row')).toHaveCount(0);
  await page.locator('#memoToast button', { hasText: 'Undo' }).click();
  await expect(page.locator('#fxRows .fx-row')).toHaveCount(1);
});

test('lines that contradict the typed total block Save until one of the fixes is picked', async ({ page }) => {
  await boot(page);
  await newPurchase(page);
  await page.fill('#total', '21.73');
  await page.fill('#desc', 'Ralphs');
  await page.click('#fxItemsFold');
  await addLine(page, 'item', 'Milk', 8.58);
  await addLine(page, 'item', 'Eggs', 12.15);
  await expect(page.locator('#fxWarn')).toBeVisible();
  await expect(page.locator('#fxWarnMsg')).toContainText('$1.00 is missing');
  await page.click('#saveBtn');
  await expect(page.locator('#entryDlg')).toHaveAttribute('open', '');      // not saved
  expect((await saved(page)).length).toBe(0);
  await page.click('#fxWarnAdd');                                          // "Add $1.00 as a line"
  await expect(page.locator('#fxWarn')).toBeHidden();
  await expect(page.locator('#fxOk')).toBeVisible();
  await page.click('#saveBtn');
  await expect(page.locator('#entryDlg')).not.toHaveAttribute('open', '');
  const e = (await saved(page))[0];
  expect([e.total, e.items.length, e.items[2].name, e.items[2].totalPrice]).toEqual([21.73, 3, 'Other', 1]);
});

test('store, payment and notes are kept through a reload, and search finds the store', async ({ page }) => {
  await boot(page);
  await newPurchase(page);
  await page.fill('#total', '58.20');
  await page.fill('#desc', 'Gas');
  await page.click('#fxMoreFold');
  await page.fill('#fxStore', 'Shell Station');
  await page.click('#fxPaidChips [data-paid="cash"]');
  await page.fill('#fxNotes', 'Road trip');
  await expect(page.locator('#fxMoreV')).toHaveText('Shell Station · Cash');
  await page.click('#saveBtn');
  await expect(page.locator('#entryDlg')).not.toHaveAttribute('open', '');
  await page.evaluate(() => window.MemoStateDb.flush());
  await page.reload();
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready() && window.MemoCore.getState().db.entries.length, null, { timeout: 15000 });
  const e = (await saved(page))[0];
  expect([e.store, e.paidWith, e.notes]).toEqual(['Shell Station', 'cash', 'Road trip']);
  await page.evaluate(() => { const s = document.getElementById('searchBox'); s.value = 'shell'; window.MemoVariant.renderFeed(); });
  await expect(page.locator('tr.entry-row')).toHaveCount(1);
  await page.evaluate(() => window.openEntryModal(window.MemoCore.getState().db.entries[0]));
  await expect(page.locator('#dlgTitle')).toHaveText('Edit purchase');
  await expect(page.locator('#fxStore')).toHaveValue('Shell Station');
  await expect(page.locator('#fxPaidChips [data-paid="cash"]')).toHaveClass(/on/);
});

test('an old single-price entry opens as just its amount', async ({ page }) => {
  await boot(page, [{ id: 'legacy', description: 'Coffee', category: 'Food', sheet: 'General', tags: [], images: [], attachments: [], purchaseDate: '2026-09-01', price: 4.5, tax: 0, total: 4.5, ts: 1 }]);
  await page.evaluate(() => window.openEntryModal(window.MemoCore.getState().db.entries[0]));
  await expect(page.locator('#total')).toHaveValue('4.50');
  await expect(page.locator('#fxRows .fx-row')).toHaveCount(0);
  await page.click('#saveBtn');
  await expect(page.locator('#entryDlg')).not.toHaveAttribute('open', '');
  const e = (await saved(page))[0];
  expect([e.total, e.items, e.price]).toEqual([4.5, [], undefined]);
});

test('reading receipts: rows rebuilt from positions, quantities, discounts, fees, tax, store and date', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    let y = 0;
    const row = (...cells) => { y += 30; return cells.map(([text, left, right]) => ({ text, left, right, top: y, bottom: y + 20 })); };
    const lines = [].concat(row(['RALPHS', 100, 220]), row(['Store #412', 110, 210]), row(['(310) 555-1234', 90, 230]), row(['10/14/2026 12:45 PM', 70, 260]),
      row(['MILK', 10, 80], ['8.58 F', 300, 360]), row(['2 @ 4.29', 30, 120]), row(['EGGS', 10, 80], ['6.49 F', 300, 360]),
      row(['BREAD', 10, 90], ['S.99 F', 300, 360]), row(['SUBTOTAL', 10, 120], ['21.06', 300, 360]), row(['TAX 8.25%', 10, 120], ['1.74', 300, 360]),
      row(['BALANCE DUE', 10, 140], ['22.80', 300, 360]), row(['VISA', 10, 60], ['22.80', 300, 360]));
    // The reader returns blocks: every name first, then every price.
    const shuffled = lines.filter(l => l.left < 290).concat(lines.filter(l => l.left >= 290));
    const a = window.MemoReceipt.parse({ lines: shuffled });
    const b = window.MemoReceipt.parse({ text: 'TRADER JOES\nBANANAS 1.36\n2.31 lb @ 0.59 /lb\nCHEESE 6.99\nMEMBER SAVINGS 2.00-\nBAG FEE 0.10\nTAX 0.41\nTOTAL 6.86\nYOU SAVED 2.00' });
    const c = window.MemoReceipt.parse({ text: 'BÄCKEREI MÜLLER\n14.10.2026\nBrot 2,49\nKaffee 3,00\nSUMME 5,49\nMwSt 7% 0,36' });
    const d = window.MemoReceipt.parse({ text: '全家便利店\n2026年10月14日\n饭团 12.00\n合计 12.00\n现金 20.00\n找零 8.00' });
    const brief = x => ({ store: x.store, date: x.date, total: x.total, tax: x.tax, mismatch: x.mismatch,
      items: x.items.map(i => [i.kind || 'item', i.name, i.amount, i.unitPrice, i.totalPrice, !!i.unsure]) });
    return [brief(a), brief(b), brief(c), brief(d)];
  });
  expect(r[0]).toEqual({ store: 'Ralphs', date: '2026-10-14', total: 22.8, tax: 1.74, mismatch: false,
    items: [['item', 'Milk', 2, 4.29, 8.58, false], ['item', 'Eggs', 1, 6.49, 6.49, false], ['item', 'Bread', 1, 5.99, 5.99, true]] });
  expect(r[1].items).toEqual([['item', 'Bananas', 2.31, 0.59, 1.36, false], ['item', 'Cheese', 1, 6.99, 6.99, false],
    ['discount', 'Member Savings', 1, -2, -2, false], ['fee', 'Bag Fee', 1, 0.1, 0.1, false]]);
  expect([r[1].total, r[1].tax, r[1].mismatch]).toEqual([6.86, 0.41, false]);
  // VAT already in the prices: the lines alone make the total.
  expect([r[2].store, r[2].date, r[2].total, r[2].tax, r[2].mismatch]).toEqual(['Bäckerei Müller', '2026-10-14', 5.49, null, false]);
  expect([r[3].store, r[3].date, r[3].total, r[3].items.length]).toEqual(['全家便利店', '2026-10-14', 12, 1]);
});

test('Scan a receipt keeps the photo, fills the form from it, and Undo puts the form back', async ({ page }) => {
  await boot(page, [{ id: 'prev', description: 'Earlier shop', category: 'Groceries', store: 'Ralphs', sheet: 'General', tags: [], images: [], attachments: [], purchaseDate: '2026-10-01', items: [], total: 5, ts: 1, updatedAt: '2026-10-01T00:00:00.000Z' }]);
  // A phone with a text reader: the scanner and reader answer like the Android plugins.
  await page.evaluate(() => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    let y = 0;
    const lines = [['RALPHS', 100, 200], ['10/14/2026', 100, 200], ['MILK', 10, 80, '8.58'], ['EGGS', 10, 80, '6.49'], ['TOTAL', 10, 80, '15.07']].flatMap(([t, l, r, p]) => {
      y += 30; const out = [{ text: t, left: l, right: r, top: y, bottom: y + 20 }];
      if (p) out.push({ text: p, left: 300, right: 360, top: y, bottom: y + 20 });
      return out;
    });
    window.Capacitor = Object.assign(window.Capacitor || {}, { isNativePlatform: () => true });
    window.Capacitor.Plugins = Object.assign(window.Capacitor.Plugins || {}, { DocumentScanner: { scan: async () => ({ pages: [{ data: png, mime: 'image/png' }] }) } });
    window.MemoOcrNative = { available: () => true, recognize: async () => ({ text: '', lines, height: 400 }) };
  });
  await newPurchase(page);
  await expect(page.locator('#fxScanBtn')).toBeVisible();
  await page.click('#fxScanBtn');
  await expect(page.locator('#fxBanner')).toBeVisible();
  await expect(page.locator('#fxBannerMsg')).toContainText('Filled in from your receipt.');
  await expect(page.locator('#fxRows .fx-row')).toHaveCount(2);
  await expect(page.locator('#total')).toHaveValue('15.07');
  await expect(page.locator('#desc')).toHaveValue('Ralphs');
  await expect(page.locator('#fxStore')).toHaveValue('Ralphs');
  await expect(page.locator('#entryDate')).toHaveValue('2026-10-14');
  await expect(page.locator('.fx-cat .fx-chip.on')).toHaveText('Groceries');          // same store as before
  expect(await page.evaluate(() => window.modalImages.length)).toBe(1);               // the photo is kept
  await page.click('#fxScanUndo');
  await expect(page.locator('#fxBanner')).toBeHidden();
  await expect(page.locator('#fxRows .fx-row')).toHaveCount(0);
  await expect(page.locator('#total')).toHaveValue('');
  await expect(page.locator('#desc')).toHaveValue('');
  expect(await page.evaluate(() => window.modalImages.length)).toBe(1);
});

test('a draft of the form survives the app being closed and reopened', async ({ page }) => {
  await boot(page);
  await newPurchase(page);
  await page.fill('#total', '9.99');
  await page.click('#fxItemsFold');
  await addLine(page, 'item', 'Socks', 9.99);
  await page.click('#fxMoreFold');
  await page.click('#fxPaidChips [data-paid="card"]');
  const draft = await page.evaluate(() => window.MemoCore.captureDraft());
  await page.evaluate(() => document.getElementById('entryDlg').close());
  await page.evaluate(d => window.MemoCore.restoreDraft(d), draft);
  await expect(page.locator('#fxRows .fx-row')).toHaveCount(1);
  await expect(page.locator('#fxRows .fx-row')).toContainText('Socks');
  await expect(page.locator('#total')).toHaveValue('9.99');
  await expect(page.locator('#fxPaidChips [data-paid="card"]')).toHaveClass(/on/);
});

test('the one-page app: finance gets the purchase form, notes keep their own form', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoSpaShell && window.MemoStateDb?.ready() && window.MemoFilterBootstrapped, null, { timeout: 15000 });
  await page.evaluate(() => window.MemoSpaShell.switchTo('finance'));
  await page.waitForFunction(() => document.body.classList.contains('finance-variant') && window.MemoVariant === window.MemoVariantRegistry.finance);
  await page.click('#fab');
  await expect(page.locator('#entryDlg[open] #total')).toBeVisible();
  await expect(page.locator('#fxItemsFold')).toBeVisible();
  await expect(page.locator('#desc')).toHaveAttribute('placeholder', 'What did you buy?');
  await page.fill('#total', '12.00');
  await page.fill('#desc', 'Lunch');
  await page.click('#saveBtn');
  await expect(page.locator('#entryDlg')).not.toHaveAttribute('open', '');
  expect((await saved(page)).find(e => e.description === 'Lunch').total).toBe(12);

  await page.evaluate(() => window.MemoSpaShell.switchTo('default'));
  await page.waitForFunction(() => !document.body.classList.contains('finance-variant'));
  await page.click('#fab');
  await expect(page.locator('#entryDlg[open] #desc')).toBeVisible();
  await expect(page.locator('#fxItemsBlock')).toBeHidden();
  await expect(page.locator('#entryDlg .fx-total')).toBeHidden();
  await expect(page.locator('#categoryInput').locator('xpath=ancestor::div[contains(@class,"fx-oldcat-row")]')).toBeVisible();
  await expect(page.locator('#desc')).not.toHaveAttribute('placeholder', 'What did you buy?');
});

test.describe('phone in landscape', () => {
  test.use({ viewport: { width: 873, height: 393 }, deviceScaleFactor: 2.75 });
  test('the lines get their own column and Save sits in the header', async ({ page }) => {
    await boot(page);
    await newPurchase(page);
    const box = await page.evaluate(() => {
      const r = s => document.querySelector(s).getBoundingClientRect();
      return { total: r('.fx-total').left, items: r('#fxItemsBlock').left, save: r('#saveBtn').top, header: r('#entryDlg .modal > header').bottom };
    });
    expect(box.items).toBeGreaterThan(box.total + 300);
    expect(box.save).toBeLessThan(box.header);
    await expect(page.locator('#fxItems')).toBeVisible();          // open from the start in two columns
  });
});
