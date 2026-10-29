const { test, expect } = require('@playwright/test');

test('planner page loads in memoSystem build and renders panels', async ({ page }) => {
  const pageErrors = [];
  const notFound = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('response', (r) => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname); });

  await page.goto('/planner.html');
  // Planner opens on its Today tab; the other sections render behind their tabs.
  await page.waitForSelector('#todayBody .pl-card', { timeout: 10000 });
  console.log('PAGE ERRORS', JSON.stringify(pageErrors));
  console.log('404s', JSON.stringify(notFound));
  // Ignore the browser's favicon probe and the backend-detection probe: this
  // static host has no /api, so /api/config 404s and the app falls back to local.
  const realMissing = notFound.filter((p) => p !== '/favicon.ico' && !p.startsWith('/api/'));

  const info = await page.evaluate(() => ({
    variant: window.MEMO_VARIANT,
    syncEnabled: window.Planner && window.Planner.Store && window.Planner.Store._syncEnabled,
    hasEntryStore: !!(window.MemoContracts && window.MemoContracts.getService('entryStore')),
    hasOpQueue: !!(window.OperationQueue && window.OperationQueue.deviceId),
    calDays: document.querySelectorAll('.cal-day').length,
    todos: document.querySelectorAll('.todo-item').length,
    gantt: document.querySelectorAll('.gantt-row').length,
    ganttPanel: !!document.querySelector('.panel--gantt'),
    habits: document.querySelectorAll('.habit-card').length,
    brandLinks: Array.from(document.querySelectorAll('#brandMenu a')).map((a) => a.getAttribute('href')),
  }));
  console.log('PLANNER PAGE INFO', JSON.stringify(info));

  expect(pageErrors, 'no uncaught JS errors').toEqual([]);
  expect(realMissing, 'no missing assets (favicon + /api probe ignored)').toEqual([]);
  expect(info.variant).toBe('planner');
  // Local (no backend) mode: the sync engine is wired but idle. The planner now
  // starts EMPTY (no auto-seeded demo data), so we assert the panels render
  // rather than expecting seeded rows.
  expect(info.syncEnabled, 'no backend here → stays local').toBe(false);
  expect(info.hasEntryStore, 'planner registers an entryStore adapter for the op-queue').toBe(true);
  expect(info.hasOpQueue, 'operation queue initialised (device id assigned)').toBe(true);
  expect(info.calDays).toBeGreaterThan(0);          // calendar grid always renders
  expect(info.habits).toBeGreaterThan(0);           // habit tracker renders its week
  expect(info.ganttPanel, 'gantt panel renders (empty state is fine)').toBe(true);
  expect(info.gantt).toBe(0);                        // no demo projects on first run
  expect(info.brandLinks).toContain('planner.html');
});

test('planner page is interactive: add a todo and it persists across reload', async ({ page }) => {
  await page.goto('/planner.html');
  await page.click('#plTab-todos');
  await page.waitForSelector('#todoInput');

  // a unique title keeps this deterministic regardless of seeded demo data
  const unique = 'pw-todo-' + Date.now();
  await page.fill('#todoInput', unique);
  await page.click('#todoAddBtn');
  await expect(page.locator('.todo-item', { hasText: unique })).toHaveCount(1);

  // Force the in-browser SQLite write before reload (the debounced OPFS flush
  // wouldn't otherwise survive an immediate reload). No-op on the localStorage
  // fallback. Same guard the offline.spec.js suite uses.
  await page.evaluate(async () => {
    if (window.MemoStateDb && window.MemoStateDb.ready && window.MemoStateDb.ready()) {
      await window.MemoStateDb.flush();
    }
  });

  // reload — the local store must bring it back
  await page.reload();
  await page.waitForSelector('#todoList');
  await expect(page.locator('.todo-item', { hasText: unique })).toHaveCount(1);
});

test('planner drives the shared sync engine: mutations push to ?variant=planner', async ({ page }) => {
  // Fake a reachable sync backend so the page enters synced mode and routes
  // every mutation through the event-sourced OperationQueue (push/pull).
  const pushedOps = [];
  const pushUrls = [];
  let nextOpId = 1;

  await page.route('**/api/config', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ server: true }) }));
  await page.route('**/api/operations/pull**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operations: [], needsFullSync: false }) }));
  await page.route('**/api/operations/push**', async (route) => {
    pushUrls.push(route.request().url());
    const body = route.request().postDataJSON() || {};
    const ops = (body.operations || []).map((op) => {
      pushedOps.push(op);
      return { clientOpId: op.clientOpId, serverOpId: nextOpId++, duplicate: false };
    });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operations: ops }) });
  });

  await page.goto('/planner.html');
  await page.click('#plTab-todos');
  await page.waitForSelector('#todoInput');
  // detectServer() resolved the mocked /api/config → synced mode
  await page.waitForFunction(() => window.Planner && window.Planner.Store && window.Planner.Store._syncEnabled === true, null, { timeout: 8000 });

  const unique = 'pw-sync-' + Date.now();
  await page.fill('#todoInput', unique);
  await page.click('#todoAddBtn');
  await expect(page.locator('.todo-item', { hasText: unique })).toHaveCount(1);

  // The mutation must have been pushed as a planner-variant create op.
  await expect
    .poll(() => pushedOps.some((o) => o.type === 'create' && o.data && o.data.kind === 'todo' && o.data.title === unique),
      { timeout: 8000 })
    .toBe(true);
  expect(pushUrls.some((u) => u.includes('variant=planner')), 'pushes target the planner variant').toBe(true);
});
