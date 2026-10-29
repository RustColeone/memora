const { test, expect } = require('@playwright/test');

const AA_NORMAL_TEXT = 4.5;

function parseRgb(value) {
  const channels = String(value).match(/[\d.]+/g);
  if (!channels || channels.length < 3) throw new Error(`Unsupported CSS color: ${value}`);
  return channels.slice(0, 3).map(Number);
}

function relativeLuminance(cssColor) {
  const linear = parseRgb(cssColor).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function renderedContrast(page, foregroundSelector, backgroundSelector = foregroundSelector) {
  return page.evaluate(({ foregroundSelector, backgroundSelector }) => {
    const foreground = document.querySelector(foregroundSelector);
    const background = document.querySelector(backgroundSelector);
    if (!foreground) throw new Error(`Missing foreground: ${foregroundSelector}`);
    if (!background) throw new Error(`Missing background: ${backgroundSelector}`);
    const rgba = (value) => {
      const channels = String(value).match(/[\d.]+/g).map(Number);
      return [channels[0], channels[1], channels[2], channels.length > 3 ? channels[3] : 1];
    };
    const over = (front, back) => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      if (!alpha) return [0, 0, 0, 0];
      return [
        (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
        (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
        (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
        alpha,
      ];
    };
    let flattened = [0, 0, 0, 0];
    for (let node = background; node; node = node.parentElement) {
      flattened = over(flattened, rgba(getComputedStyle(node).backgroundColor));
      if (flattened[3] >= 0.999) break;
    }
    // The browser canvas is white beyond the root element.
    flattened = over(flattened, [255, 255, 255, 1]);
    return {
      foreground: getComputedStyle(foreground).color,
      background: `rgb(${flattened.slice(0, 3).map(Math.round).join(', ')})`,
    };
  }, { foregroundSelector, backgroundSelector });
}

async function expectAa(page, label, foregroundSelector, backgroundSelector) {
  const colors = await renderedContrast(page, foregroundSelector, backgroundSelector);
  const ratio = contrastRatio(colors.foreground, colors.background);
  expect.soft(
    ratio,
    `${label}: ${colors.foreground} on ${colors.background} has contrast ${ratio.toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
}

async function useLightTheme(page) {
  await page.addInitScript(() => localStorage.setItem('memoTheme', 'light'));
}

test('light memo text, file links, and primary controls meet WCAG AA without changing dark colors', async ({ page }) => {
  await useLightTheme(page);
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(),
    null,
    { timeout: 15000 },
  );

  await page.evaluate(async () => {
    const memos = [{
      id: 'contrast-memo',
      description: 'Visual contrast fixture',
      category: 'Visual QA',
      tags: [],
      images: [],
      attachments: [{
        name: 'audit-notes.pdf',
        storedPath: '/uploads/audit-notes.pdf',
        url: '/uploads/audit-notes.pdf',
        type: 'application/pdf',
      }],
      ts: Date.now(),
    }];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    const select = document.getElementById('categoryFilter');
    if (![...select.options].some((option) => option.value === 'Visual QA')) {
      const option = document.createElement('option');
      option.value = option.textContent = 'Visual QA';
      select.appendChild(option);
    }
    select.value = 'Visual QA';
    window.MemoCore.renderFeed();
  });
  await page.waitForSelector('#feed .card[data-id="contrast-memo"] .filelink');

  await expectAa(page, 'optional-saving hint', '#fsHint', 'body');
  await expectAa(
    page,
    'memo attachment link',
    '#feed .card[data-id="contrast-memo"] .filelink',
    '#feed .card[data-id="contrast-memo"]',
  );

  await page.evaluate(() => document.getElementById('fab').click());
  await expect(page.locator('#entryDlg')).toHaveAttribute('open', '');
  await expectAa(page, 'memo primary button', '#saveBtn');

  const darkColors = await page.evaluate(() => {
    document.documentElement.removeAttribute('data-theme');
    return {
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      fileLink: getComputedStyle(document.querySelector('.filelink')).color,
    };
  });
  expect(darkColors).toEqual({ accent: '#e0a458', fileLink: 'rgb(147, 197, 253)' });
});

test('light finance file links and primary controls meet WCAG AA', async ({ page }) => {
  await useLightTheme(page);
  await page.goto('/finance.html');
  await page.waitForFunction(
    () => window.MemoCore && window.MemoVariant && window.MemoStateDb && window.MemoStateDb.ready(),
    null,
    { timeout: 15000 },
  );

  await page.evaluate(async () => {
    window.MemoStateDb.saveEntries([{
      id: 'contrast-finance',
      description: 'Visual contrast fixture',
      category: 'Visual QA',
      sheet: 'General',
      tags: [],
      images: [],
      attachments: [{
        name: 'receipt.pdf',
        storedPath: '/uploads/receipt.pdf',
        url: '/uploads/receipt.pdf',
        type: 'application/pdf',
      }],
      purchaseDate: '2026-07-18',
      items: [{ name: 'Audit', amount: 1, unitPrice: 10, totalPrice: 10 }],
      tax: 0,
      total: 10,
    }], 'finance');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('finance') || [];
    window.MemoVariant.renderFeed();
  });
  await page.waitForSelector('#feed tr[data-id="contrast-finance"] .filelink');

  await expectAa(
    page,
    'finance attachment link',
    '#feed tr[data-id="contrast-finance"] .filelink',
    '#feed tr[data-id="contrast-finance"] td.col-images',
  );
  await page.evaluate(() => document.getElementById('fab').click());
  await expect(page.locator('#entryDlg')).toHaveAttribute('open', '');
  await expectAa(page, 'finance primary button', '#saveBtn');
});

test('light planner accent, danger, and success states meet WCAG AA', async ({ page }) => {
  await useLightTheme(page);
  await page.goto('/planner.html');
  await page.waitForFunction(
    () => window.Planner && window.Planner.Store && document.querySelector('#todoList > *'),
    null,
    { timeout: 15000 },
  );

  await page.evaluate(() => {
    const store = window.Planner.Store;
    const today = store.Dates.iso(new Date());
    store.addTodo({ title: 'Urgent visual check', due: today, priority: 'high' });
    store.addHabit({
      name: 'Visual QA habit',
      type: 'check',
      targetDays: [0, 1, 2, 3, 4, 5, 6],
      timesPerWeek: 7,
    });
    const habit = store._entries.find((entry) => entry.kind === 'habit' && entry.name === 'Visual QA habit');
    store.logHabit(habit.id);
  });
  // One folder tab at a time.
  await page.click('#plTab-todos');
  await page.waitForSelector('.todo-item .pill.high');
  await expectAa(page, 'planner primary button', '#todoAddBtn');
  await expectAa(page, 'planner high-priority label', '.todo-item .pill.high', '.todo-item');
  await page.waitForTimeout(400);   // let the tab finish its colour transition
  await expectAa(page, 'planner selected folder tab', '#plTab-todos');
  await page.click('#plTab-calendar');
  await expectAa(page, 'planner outlined accent action', '#calAddBtn', '.panel--calendar');
  await page.click('#plTab-habits');
  await page.waitForSelector('.habit-card .week-dot.done .d');
  await expectAa(page, 'planner completed-habit mark', '.habit-card .week-dot.done .d');
});

test('memo, finance, and planner avoid document-level horizontal overflow', async ({ page }) => {
  await useLightTheme(page);
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const path of ['/index.html', '/finance.html', '/planner.html']) {
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      const geometry = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(
        Math.max(geometry.document, geometry.body) - geometry.viewport,
        `${path} at ${viewport.width}px overflows horizontally: ${JSON.stringify(geometry)}`,
      ).toBeLessThanOrEqual(1);
    }
  }
});
