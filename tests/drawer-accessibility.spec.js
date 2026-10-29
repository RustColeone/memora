const { test, expect } = require('@playwright/test');

for (const app of ['index.html', 'finance.html', 'planner.html']) {
  test(`${app}: drawer owns focus, semantics, and opener restoration`, async ({ page }) => {
    await page.goto(`/${app}`);
    await page.waitForFunction(() => window.MemoShell, null, { timeout: 15000 });

    const initial = await page.evaluate(() => {
      const menu = document.getElementById('mobileMenu');
      const button = document.getElementById('hamburgerBtn');
      const overlay = document.getElementById('mobileOverlay');
      return {
        role: menu.getAttribute('role'),
        modal: menu.getAttribute('aria-modal'),
        hidden: menu.getAttribute('aria-hidden'),
        inert: menu.inert,
        expanded: button.getAttribute('aria-expanded'),
        controls: button.getAttribute('aria-controls'),
        overlayHidden: overlay.getAttribute('aria-hidden'),
      };
    });
    expect(initial).toEqual({
      role: 'dialog', modal: 'true', hidden: 'true', inert: true,
      expanded: 'false', controls: 'mobileMenu', overlayHidden: 'true',
    });

    await page.click('#hamburgerBtn');
    await expect(page.locator('#mobileMenuClose')).toBeFocused();
    const opened = await page.evaluate(() => ({
      hidden: document.getElementById('mobileMenu').getAttribute('aria-hidden'),
      inert: document.getElementById('mobileMenu').inert,
      expanded: document.getElementById('hamburgerBtn').getAttribute('aria-expanded'),
      overlayHidden: document.getElementById('mobileOverlay').getAttribute('aria-hidden'),
      overlayPointerEvents: getComputedStyle(document.getElementById('mobileOverlay')).pointerEvents,
    }));
    expect(opened).toEqual({
      hidden: 'false', inert: false, expanded: 'true',
      overlayHidden: 'false', overlayPointerEvents: 'auto',
    });

    // If asynchronous rendering removes the focused action, focus is restored
    // to the stable drawer boundary instead of falling back to the document.
    await page.evaluate(() => {
      const menu = document.getElementById('mobileMenu');
      const temporaryAction = document.createElement('button');
      menu.appendChild(temporaryAction);
      temporaryAction.focus();
      temporaryAction.remove();
    });
    await expect(page.locator('#mobileMenuClose')).toBeFocused();

    // Even if another integration moves focus outside, the next Tab stays in
    // the open modal drawer.
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();

      // Planner can finish an asynchronous drawer render in this gap. That
      // mutation must not consume the first re-entry Tab on the user's behalf.
      const menu = document.getElementById('mobileMenu');
      const lateStatus = document.createElement('span');
      menu.appendChild(lateStatus);
      lateStatus.remove();
    });
    await page.keyboard.press('Tab');
    // Re-entry lands on the drawer's first control: the Me profile at the top.
    await expect(page.locator('#mobileMenu .menu-profile')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('#hamburgerBtn')).toBeFocused();
    const closed = await page.evaluate(() => ({
      hidden: document.getElementById('mobileMenu').getAttribute('aria-hidden'),
      inert: document.getElementById('mobileMenu').inert,
      expanded: document.getElementById('hamburgerBtn').getAttribute('aria-expanded'),
      overlayHidden: document.getElementById('mobileOverlay').getAttribute('aria-hidden'),
      overlayPointerEvents: getComputedStyle(document.getElementById('mobileOverlay')).pointerEvents,
    }));
    expect(closed).toEqual({
      hidden: 'true', inert: true, expanded: 'false',
      overlayHidden: 'true', overlayPointerEvents: 'none',
    });
  });
}
