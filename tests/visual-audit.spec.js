const { test, expect } = require('@playwright/test');

// The baselines are Windows screenshots (*-win32.png); other systems draw fonts differently.
test.skip(process.platform !== 'win32', 'visual baselines exist for Windows only');

for (const theme of ['dark', 'light']) {
  for (const viewport of [
    { name: 'phone', width: 390, height: 844 },
    { name: 'desktop', width: 1440, height: 900 },
  ]) {
    for (const app of ['index', 'finance', 'planner']) {
      test(`${app}: ${viewport.name} ${theme} visual baseline`, async ({ browser }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
        });
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date('2026-07-18T12:00:00-07:00'));
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem('memoTheme', selectedTheme);
        }, theme);
        await page.goto(`/${app}.html`);
        await page.evaluate(() => window.MemoAppReady || window.MemoCore?.start());

        if (app === 'index') {
          await page.waitForFunction(() => window.MemoCore && window.MemoStateDb?.ready());
          await page.evaluate(async () => {
            const memos = [{
              id: 'visual-memo',
              description: 'Inspection notes for the July reliability baseline',
              category: 'Uncategorized',
              tags: ['audit', 'offline'],
              images: [],
              attachments: [{
                name: 'audit-notes.pdf',
                url: '/uploads/audit-notes.pdf',
                storedPath: '/uploads/audit-notes.pdf',
                type: 'application/pdf',
              }],
              ts: Date.now(),
            }];
            window.MemoStateDb.importBundle({ version: 1, memos, finance: [], planner: [] }, 'replace');
            await window.MemoStateDb.flush();
            window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
            window.MemoCore.renderFeed();
          });
        } else if (app === 'finance') {
          await page.waitForFunction(() => window.MemoCore && window.MemoVariant && window.MemoStateDb?.ready());
          await page.evaluate(async () => {
            window.MemoStateDb.saveEntries([{
              id: 'visual-finance',
              description: 'Accessibility and backup QA tools',
              category: 'Software R&D Fee',
              sheet: 'General',
              tags: ['audit'],
              images: [],
              attachments: [{
                name: 'receipt.pdf',
                url: '/uploads/receipt.pdf',
                storedPath: '/uploads/receipt.pdf',
                type: 'application/pdf',
              }],
              purchaseDate: '2026-07-18',
              items: [{ name: 'QA tools', amount: 1, unitPrice: 42, totalPrice: 42 }],
              price: 42,
              tax: 4.2,
              total: 46.2,
              ts: Date.now(),
            }], 'finance');
            await window.MemoStateDb.flush();
            window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('finance') || [];
            window.MemoVariant.renderFeed();
          });
        } else {
          await page.waitForFunction(() => window.Planner?.Store && document.querySelector('.planner-page'));
          await page.evaluate(() => {
            const store = window.Planner.Store;
            store.addTodo({ title: 'Verify offline backup recovery', due: '2026-07-18', priority: 'high' });
            const project = store.addProject({ name: 'MemoSystem polish', start: '2026-07-14', end: '2026-07-31' });
            store.addMilestone(project.id, { title: 'Clean baseline', due: '2026-07-18' });
            store.addHabit({ name: 'Review visual states', type: 'check', timesPerWeek: 5, targetDays: [1, 2, 3, 4, 5] });
            const habit = store._entries.find((entry) => entry.kind === 'habit');
            if (habit) store.logHabit(habit.id);
          });
        }

        if (app === 'finance') await expect(page.locator('#fab')).toBeVisible();
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
        await expect(page).toHaveScreenshot(`${app}-${viewport.name}-${theme}.png`, {
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
        });
        await context.close();
      });
    }
  }
}
