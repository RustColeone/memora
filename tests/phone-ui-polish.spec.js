// Phone UI polish: drawer swipe, header search, folder shelf (fold · row · grid),
// header-dragged sheets with the grip over the header, one solid + button,
// and label-free finance rows.
const { test, expect } = require('@playwright/test');
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function seedMemo(page, folderCount = 3) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready() && window.MemoFilterBootstrapped, null, { timeout: 15000 });
  await page.evaluate(async (n) => {
    const memos = [{ id: 'loose', description: 'Loose note about the parking spot', category: 'Uncategorized', tags: [], images: [], ts: 9000 }];
    for (let i = 0; i < n; i++) memos.push({ id: 'f' + i, description: 'entry ' + i, category: 'Folder ' + String(i).padStart(2, '0'), tags: [], images: [], ts: 1000 + i });
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    window.MemoCore.renderFeed();
  }, folderCount);
  await page.waitForSelector('#feed .folder-shelf .folder-card');
}

// stepMs > 0 stamps the events that far apart (seconds since epoch, as CDP
// takes them), so a flick has a real release speed however slowly it is sent.
async function touchDrag(page, from, to, steps = 8, stepMs = 0) {
  const cdp = await page.context().newCDPSession(page);
  const t0 = Date.now() / 1000;
  const at = i => (stepMs ? { timestamp: t0 + i * stepMs / 1000 } : {});
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }], ...at(0) });
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + (to[0] - from[0]) * i / steps, y = from[1] + (to[1] - from[1]) * i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }], ...at(i) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], ...at(steps + 1) });
  await cdp.detach();
}

const menuHidden = page => page.locator('#mobileMenu').getAttribute('aria-hidden');

test.describe('drawer swipe', () => {
  test('follows a left swipe open and a right drag closed', async ({ page }) => {
    await seedMemo(page);
    const y = await page.evaluate(() => document.querySelector('#feed .card[data-id="loose"]').getBoundingClientRect().top + 20);
    await touchDrag(page, [330, y], [180, y + 4]);
    await expect.poll(() => menuHidden(page)).toBe('false');
    await expect(page.locator('#mobileMenuClose')).toBeFocused();
    await touchDrag(page, [200, 400], [360, 404]);
    await expect.poll(() => menuHidden(page)).toBe('true');
  });

  test('ignores vertical scrolls, back-gesture edges and the folder row', async ({ page }) => {
    await seedMemo(page, 12);
    const y = await page.evaluate(() => document.querySelector('#feed .card[data-id="loose"]').getBoundingClientRect().top + 20);
    await touchDrag(page, [200, y + 60], [196, y - 40]);
    await touchDrag(page, [384, y], [200, y]);          // starts inside the 28px edge strip
    const shelfY = await page.evaluate(() => document.querySelector('#feed .folder-shelf').getBoundingClientRect().top + 30);
    await touchDrag(page, [330, shelfY], [150, shelfY]); // the row scrolls instead
    await page.waitForTimeout(300);
    expect(await menuHidden(page)).toBe('true');
  });
  test('with 3-button navigation it opens from the very edge, and from the folder row only there', async ({ page }) => {
    await seedMemo(page, 12);
    // NativeUi reports no Back-gesture strips with 3-button navigation.
    await page.evaluate(() => { const s = document.documentElement.style; s.setProperty('--system-gesture-left', '0px'); s.setProperty('--system-gesture-right', '0px'); });
    const shelfY = await page.evaluate(() => document.querySelector('#feed .folder-shelf').getBoundingClientRect().top + 30);
    await touchDrag(page, [330, shelfY], [150, shelfY]); // the row owns this swipe
    await page.waitForTimeout(300);
    expect(await menuHidden(page)).toBe('true');
    await touchDrag(page, [384, shelfY], [200, shelfY]); // the last strip at the edge opens
    await expect.poll(() => menuHidden(page)).toBe('false');
  });

  test('keeps the momentum of the finger: a short brush stays closed, a quick flick opens', async ({ page }) => {
    await seedMemo(page);
    const y = await page.evaluate(() => document.querySelector('#feed .card[data-id="loose"]').getBoundingClientRect().top + 20);
    await touchDrag(page, [330, y], [300, y], 6);          // under a tenth of the width
    await page.waitForTimeout(500);
    expect(await menuHidden(page)).toBe('true');
    await touchDrag(page, [330, y], [255, y], 5, 8);       // about a quarter, released moving fast
    await expect.poll(() => menuHidden(page)).toBe('false');
  });
});

test('hover styles apply only with a hovering pointer', () => {
  const { execFileSync } = require('child_process');
  const files = ['src/static/css/memo.css', 'src/static/css/memo-finance.css', 'src/static/css/memo-navigation.css', 'src/static/reader/reader.css'];
  execFileSync(process.execPath, ['build_tools/hover-only-pointers.cjs', '--check', ...files], { cwd: require('path').join(__dirname, '..'), stdio: 'pipe' });
});

test.describe('header search', () => {
  test('takes Bin\'s place, filters, and closes with ✕ or Back', async ({ page }) => {
    await seedMemo(page);
    await expect(page.locator('#recycleBinBtn')).toBeHidden();
    await expect(page.locator('#searchBox')).toBeHidden();
    await page.click('#searchToggleBtn');
    await expect(page.locator('#searchBox')).toBeVisible();
    await expect(page.locator('#searchBox')).toBeFocused();
    await expect(page.locator('#searchToggleBtn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#brandMenuButton')).toBeHidden();
    await page.fill('#searchBox', 'parking');
    await expect(page.locator('#feed .card[data-id="loose"]')).toBeVisible();
    await expect(page.locator('#feed .card[data-id="f0"]')).toHaveCount(0);
    await page.click('#searchToggleBtn');
    await expect(page.locator('#searchBox')).toBeHidden();
    await expect(page.locator('#searchBox')).toHaveValue('');
    await page.click('#searchToggleBtn');
    await page.fill('#searchBox', 'entry');
    expect(await page.evaluate(() => window.MemoShell.handleSystemBack())).toBe(true);
    await expect(page.locator('#searchBox')).toBeHidden();
    await expect(page.locator('#searchBox')).toHaveValue('');
  });

  test('the drawer no longer carries a second search box', async ({ page }) => {
    await seedMemo(page);
    expect(await page.locator('#mobileSearchBox').count()).toBe(0);
  });

  test('the header and an open search stay on screen down a long list in the app', async ({ page }) => {
    await seedMemo(page);
    // The phone app runs with html.cap-mode, where overflow-x once made body a
    // scroll container and the sticky header scrolled away with the page.
    await page.evaluate(() => {
      document.documentElement.classList.add('cap-mode');
      const spacer = document.createElement('div');
      spacer.style.height = '4000px';
      document.getElementById('feed').appendChild(spacer);
    });
    await page.click('#searchToggleBtn');
    await page.evaluate(() => window.scrollTo(0, 2500));
    const at = await page.evaluate(() => ({ scrollY, header: document.querySelector('header').getBoundingClientRect().top,
      search: document.getElementById('searchBox').getBoundingClientRect().top, sideways: document.scrollingElement.scrollWidth - innerWidth }));
    expect(at.scrollY).toBeGreaterThan(2000);
    expect(at.header).toBe(0);
    expect(at.search).toBeGreaterThanOrEqual(0);
    expect(at.search).toBeLessThan(80);
    expect(at.sideways).toBeLessThanOrEqual(0);
  });
});

test.describe('folder shelf', () => {
  test('folds away, shows a row, and toggles to a remembered grid', async ({ page }) => {
    await seedMemo(page, 50);
    const shelf = page.locator('#feed > .folder-shelf');
    const toggle = page.locator('#feed .time-divider[data-group="__folders__"] .folder-view-toggle');
    await expect(page.locator('#feed .time-divider[data-group="__folders__"] .time-divider-count')).toHaveText('50');

    // Row: one line that scrolls sideways; entries stay on the first screen.
    const row = await shelf.evaluate(el => ({ display: getComputedStyle(el).display, wide: el.scrollWidth > el.clientWidth, height: el.getBoundingClientRect().height }));
    expect(row.display).toBe('flex');
    expect(row.wide).toBe(true);
    expect(row.height).toBeLessThan(160);
    expect(await page.evaluate(() => document.querySelector('#feed .card[data-id="loose"]').getBoundingClientRect().top)).toBeLessThan(500);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Grid: every folder, flowing down the page, tiles smaller than entry cards.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const grid = await shelf.evaluate(el => ({ display: getComputedStyle(el).display, wide: el.scrollWidth > el.clientWidth + 1, height: el.getBoundingClientRect().height }));
    expect(grid.display).toBe('grid');
    expect(grid.wide).toBe(false);
    expect(grid.height).toBeGreaterThan(1000);
    const sizes = await page.evaluate(() => ({ folder: document.querySelector('#feed .folder-card').getBoundingClientRect().width, entry: document.querySelector('#feed .card[data-id="loose"]').getBoundingClientRect().width }));
    expect(sizes.folder).toBeLessThan(sizes.entry);
    expect(await page.evaluate(() => localStorage.getItem('memoFolderView'))).toBe('grid');

    // First-level fold hides everything, the grid toggle included; unfolding
    // brings back the grid it was in.
    await page.click('#feed .time-divider[data-group="__folders__"] .time-divider-label');
    await expect(shelf).toBeHidden();
    await expect(toggle).toBeHidden();
    await page.click('#feed .time-divider[data-group="__folders__"] .time-divider-label');
    await expect(shelf).toBeVisible();
    await expect(toggle).toBeVisible();
    await expect(page.locator('#feed > .folder-shelf.is-grid')).toHaveCount(1);
    expect(await toggle.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('0px');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // The choice survives a re-render.
    await toggle.click();
    await page.evaluate(() => window.MemoCore.renderFeed());
    await expect(page.locator('#feed > .folder-shelf.is-grid')).toHaveCount(1);
  });
});

test.describe('bottom sheets', () => {
  test('the grip sits on the header, and the header drags the sheet closed', async ({ page }) => {
    await seedMemo(page);
    await page.click('#filtersBtn');
    const dlg = page.locator('#filtersDlg');
    await expect(dlg).toHaveAttribute('open', '');
    await page.waitForTimeout(300);
    const geo = await page.evaluate(() => {
      const d = document.getElementById('filtersDlg');
      return { dialog: d.getBoundingClientRect().top, grip: d.querySelector('.sheet-drag-handle').getBoundingClientRect().top, header: d.querySelector('.modal > header').getBoundingClientRect().top };
    });
    expect(Math.abs(geo.header - geo.dialog)).toBeLessThan(1);
    expect(Math.abs(geo.grip - geo.dialog)).toBeLessThan(1);

    // A drag that starts on a tab does not move the sheet.
    const tab = await page.locator('#filterDateTab').boundingBox();
    await page.mouse.move(tab.x + 10, tab.y + 10); await page.mouse.down();
    await page.mouse.move(tab.x + 10, tab.y + 260, { steps: 6 }); await page.mouse.up();
    await expect(dlg).toHaveAttribute('open', '');

    const head = await page.locator('#filtersDlg .modal > header strong').boundingBox();
    await page.mouse.move(head.x + 4, head.y + 4); await page.mouse.down();
    await page.mouse.move(head.x + 4, head.y + 260, { steps: 6 }); await page.mouse.up();
    await expect(dlg).not.toHaveAttribute('open', '');
  });

  test('a focused grip tints its pill instead of boxing the header', async ({ page }) => {
    await seedMemo(page);
    await page.evaluate(() => document.getElementById('privacySettingsDlg').showModal());
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    const grip = page.locator('#privacySettingsDlg > .sheet-drag-handle');
    await grip.focus();
    expect(await grip.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');
  });

  test('empty tag panels collapse into their hint', async ({ page }) => {
    await seedMemo(page);
    await page.evaluate(() => document.getElementById('tagPickerDlg').showModal());
    await page.evaluate(() => { document.getElementById('tagPickAppliedEmpty').hidden = false; });
    await expect(page.locator('#tagPickApplied')).toBeHidden();
    await expect(page.locator('#tagPickAppliedEmpty')).toBeVisible();
  });

  test('library tiles keep their names readable', async ({ page }) => {
    await seedMemo(page);
    await page.evaluate(async () => {
      const memos = [{ id: 'p1', description: 'Wi-Fi and router admin details', category: 'Home', tags: [], images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='], ts: 5000 }];
      window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
      await window.MemoStateDb.flush();
      window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
      window.MemoLibraryPicker.open({ mode: 'multi', filter: 'image', min: 2, onDone() {} });
    });
    const head = page.locator('.libpick-entry-head').first();
    await expect(head).toBeVisible();
    const box = await head.evaluate(el => { const cs = getComputedStyle(el); return { right: cs.paddingRight, position: cs.position, title: el.querySelector('.libpick-entry-title').getBoundingClientRect().width, head: el.getBoundingClientRect().width }; });
    expect(box.right).toBe('8px');
    expect(box.position).toBe('static');
    expect(box.title).toBeGreaterThan(box.head * 0.6);
  });

  test('About uses the shared close button, hidden on phone sheets', async ({ page }) => {
    await seedMemo(page);
    await page.click('#hamburgerBtn');
    await page.click('#aboutBtn');
    await expect(page.locator('#aboutDlg')).toHaveAttribute('open', '');
    await expect(page.locator('#aboutCloseBtn')).toHaveClass(/modal-close/);
    await expect(page.locator('#aboutCloseBtn')).toBeHidden();
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator('#aboutCloseBtn')).toBeVisible();
    await page.click('#aboutCloseBtn');
    await expect(page.locator('#aboutDlg')).not.toHaveAttribute('open', '');
  });
});

test('one solid + button replaces the add tile on phones', async ({ page }) => {
  await seedMemo(page);
  await expect(page.locator('#addCard')).toBeHidden();
  await expect(page.locator('#fab')).toBeVisible();
  expect(await page.locator('#fab').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
});

test('finance rows show amounts without labels and no repeated footer total', async ({ page }) => {
  await page.goto('/finance.html');
  await page.waitForFunction(() => window.MemoCore && window.MemoVariant && window.MemoStateDb?.ready(), null, { timeout: 15000 });
  await page.evaluate(async () => {
    window.MemoStateDb.saveEntries([{ id: 'r1', description: 'Groceries', category: 'Food', sheet: 'General', tags: [], images: [], attachments: [], purchaseDate: '2026-10-14', items: [], price: 84.12, tax: 0, total: 84.12, ts: Date.now() }], 'finance');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('finance') || [];
    window.MemoVariant.renderFeed();
  });
  const cell = page.locator('tr.entry-row[data-id="r1"] td.col-total');
  await expect(cell).toHaveText('$84.12');
  expect(await cell.evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
  await expect(page.locator('.listtable > tfoot')).toBeHidden();
});
