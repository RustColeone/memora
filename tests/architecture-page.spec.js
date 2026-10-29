// The architecture page (docs/architecture): made from the code by build_tools/architecture.cjs.
// It draws the top map and the guides, finds a function by name, and works on a phone (diagram and
// details one at a time, nothing wider than the screen). The diagrams load ELK from a CDN.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PAGE = 'file:///' + path.join(ROOT, 'docs', 'architecture', 'index.html').replace(/\\/g, '/');
test.beforeAll(() => { execFileSync(process.execPath, [path.join(ROOT, 'build_tools', 'architecture.cjs')], { cwd: ROOT }); });

async function open(page, route) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(PAGE + '#/' + (route || ''));
  await page.waitForFunction(() => document.querySelector('#chart svg') || /could not/.test(document.querySelector('#chart').textContent), null, { timeout: 30000 });
  return errors;
}

test('the top map, the guides and a function, read from the code', async ({ page }) => {
  const errors = await open(page, '');
  await expect(page.locator('#chart-title')).toHaveText('The whole of Memora');
  await expect(page.locator('#pane')).toContainText(/\d[\d,]* files · \d+ classes/);
  for (const label of ['Android app', 'Desktop app', 'Operation queue', 'Mods loader', 'Notebook stats']) await expect(page.locator('#chart svg')).toContainText(label);
  await page.evaluate(() => { location.hash = '#/guide/mods'; });
  await expect(page.locator('#chart-title')).toHaveText('How a mod goes in');
  await expect(page.locator('#pane')).toContainText("Memora.mod('notebook-stats'");
  // Search finds a function and opens its code.
  await page.fill('#search', 'addOperation');
  await page.locator('#results a', { hasText: 'OperationQueue.addOperation()' }).first().click();
  await expect(page.locator('#chart-title')).toHaveText('OperationQueue.addOperation()');
  await expect(page.locator('#pane .signature')).toHaveText(/^async addOperation\(type, entryId/);
  await expect(page.locator('#pane .code')).toContainText('memo:entries-changed');
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('diagram and details one at a time, nothing wider than the screen', async ({ page }) => {
    const errors = await open(page, 'android/app/src/main/java/com/laplacengan/memora/PlannerReminderReceiver.java::PlannerReminderReceiver.pending');
    // A function opens on its details, with a switch back to the diagram.
    await expect(page.locator('#views button[data-view="pane"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#pane')).toContainText('The date to deliver next');
    await page.click('#views button[data-view="chart"]');
    await expect(page.locator('#chart svg')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
});
