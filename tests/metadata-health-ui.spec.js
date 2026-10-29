const { test, expect } = require('@playwright/test');

for (const pageName of ['index.html', 'finance.html', 'planner.html']) {
  test(`${pageName} surfaces a runtime metadata persistence failure`, async ({ page }) => {
    await page.goto(`/${pageName}`);
    await page.waitForFunction(() => window.MemoShell && typeof window.MemoShell.toast === 'function');

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('memo:metadata-health', {
        detail: {
          status: 'error',
          lastPersistError: 'simulated durable write failure',
          issues: [{ code: 'metadata-persist-failed', severity: 'error' }],
        },
      }));
    });

    const toast = page.locator('#memoToast');
    await expect(toast).toContainText('could not be saved');
    await expect(toast).toContainText('simulated durable write failure');
    await expect(toast).toHaveAttribute('role', 'alert');
    await expect(toast).toHaveAttribute('aria-live', 'assertive');
  });
}
