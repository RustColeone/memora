const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const output = path.join(process.cwd(), 'test-results', 'motion-visual-audit');

async function boot(page, theme = 'dark') {
  await page.addInitScript(selected => localStorage.setItem('memoTheme', selected), theme);
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoShell && window.MemoMotion && window.MemoCore && window.MemoStateDb?.ready(),
    null,
    { timeout: 15000 },
  );
}

async function seekAnimations(page, selector, fraction) {
  return page.evaluate(async ({ selector, fraction }) => {
    const root = document.querySelector(selector);
    let animations = [];
    // Dialog opening intentionally clears its Android-compatible start styles
    // after two rAFs. Wait for the element's own transition (not a child or
    // ::backdrop animation) so the test always seeks the real surface.
    for (let frame = 0; frame < 20; frame += 1) {
      animations = root.getAnimations().filter(animation => animation.effect?.target === root);
      if (animations.length) break;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    let sought = 0;
    const ready = [];
    for (const animation of animations) {
      const timing = animation.effect?.getComputedTiming();
      const duration = Number(timing?.duration);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      animation.pause();
      animation.currentTime = Number(timing?.delay || 0) + duration * fraction;
      ready.push(Promise.resolve(animation.ready).catch(() => {}));
      sought += 1;
    }
    // `pause()` is asynchronous for compositor-owned transitions. Wait for its
    // ready promise so the screenshot and the main-thread geometry sample the
    // same requested frame.
    await Promise.all(ready);
    // A paused CSS transition is sampled on the next rendering update. Waiting
    // two frames makes the screenshot prove the requested phase instead of a
    // compositor frame that happened to be queued before the seek.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = root.getBoundingClientRect();
    const style = getComputedStyle(root);
    return {
      sought,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      opacity: Number(style.opacity),
      transform: style.transform,
    };
  }, { selector, fraction });
}

async function motionState(page, selector) {
  return page.locator(selector).evaluate(root => {
    const rect = root.getBoundingClientRect();
    const style = getComputedStyle(root);
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      opacity: Number(style.opacity),
      transform: style.transform,
    };
  });
}

test('capture deterministic premium motion frames', async ({ browser }) => {
  fs.mkdirSync(output, { recursive: true });

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  const page = await phone.newPage();
  await boot(page, 'dark');

  await page.click('#hamburgerBtn');
  const drawerSeek = await seekAnimations(page, '#mobileMenu', 0.5);
  const overlayMid = await seekAnimations(page, '#mobileOverlay', 0.5);
  const drawerMid = await motionState(page, '#mobileMenu');
  expect(drawerSeek.sought).toBeGreaterThan(0);
  expect(drawerMid.left).toBeGreaterThan(110);
  expect(drawerMid.left).toBeLessThan(300);
  expect(drawerMid.opacity).toBeGreaterThan(0);
  expect(drawerMid.opacity).toBeLessThan(1);
  expect(overlayMid.opacity).toBeGreaterThan(0);
  expect(overlayMid.opacity).toBeLessThan(1);
  await page.screenshot({ path: path.join(output, 'phone-drawer-midpoint-dark.png') });
  const drawerEnd = await seekAnimations(page, '#mobileMenu', 1);
  const overlayEnd = await seekAnimations(page, '#mobileOverlay', 1);
  expect(drawerEnd.left).toBeCloseTo(110, 0);
  expect(drawerEnd.opacity).toBe(1);
  expect(overlayEnd.opacity).toBe(1);
  await page.screenshot({ path: path.join(output, 'phone-drawer-settled-dark.png') });

  // Start the sheet capture from a fresh document. The drawer transitions above
  // are intentionally paused for deterministic screenshots and must not leak
  // into the next visual state.
  await boot(page, 'dark');
  await page.evaluate(() => document.getElementById('filtersDlg').showModal());
  const sheetMid = await seekAnimations(page, '#filtersDlg', 0.5);
  expect(sheetMid.sought).toBeGreaterThan(0);
  expect(sheetMid.opacity).toBeGreaterThan(0);
  expect(sheetMid.opacity).toBeLessThan(1);
  await page.screenshot({ path: path.join(output, 'phone-filter-sheet-midpoint-dark.png') });
  const sheetEnd = await seekAnimations(page, '#filtersDlg', 1);
  expect(sheetEnd.opacity).toBe(1);
  expect(sheetEnd.top).toBeLessThan(sheetMid.top);
  await page.screenshot({ path: path.join(output, 'phone-filter-sheet-settled-dark.png') });
  await phone.close();

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  const desktopPage = await desktop.newPage();
  await boot(desktopPage, 'light');
  await desktopPage.evaluate(() => document.getElementById('filtersDlg').showModal());
  const dialogMid = await seekAnimations(desktopPage, '#filtersDlg', 0.5);
  expect(dialogMid.sought).toBeGreaterThan(0);
  expect(dialogMid.opacity).toBeGreaterThan(0);
  expect(dialogMid.opacity).toBeLessThan(1);
  await desktopPage.screenshot({ path: path.join(output, 'desktop-dialog-midpoint-light.png') });
  const dialogEnd = await seekAnimations(desktopPage, '#filtersDlg', 1);
  expect(dialogEnd.opacity).toBe(1);
  expect(dialogEnd.top).toBeLessThan(dialogMid.top);
  await desktopPage.screenshot({ path: path.join(output, 'desktop-dialog-settled-light.png') });
  fs.writeFileSync(
    path.join(output, 'motion-metrics.json'),
    `${JSON.stringify({ drawerMid, overlayMid, drawerEnd, overlayEnd, sheetMid, sheetEnd, dialogMid, dialogEnd }, null, 2)}\n`,
  );
  await desktop.close();
});
