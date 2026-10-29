// Stage 3 (UI) — the offline app exports a unified ZIP (memosystem.json + uploads/)
// and re-imports it, round-tripping entries through the real Settings UI.
const { test, expect } = require('@playwright/test');
const { clickExport, answerPassword, readPlain, plainName } = require('./helpers/protected-backup');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function waitForBoot(page) {
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready() && window.MemoCore,
    null,
    { timeout: 15000 }
  );
}

test('export ZIP -> wipe -> import ZIP restores entries through the Settings UI', async ({ page }) => {
  const bundle = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'backend-bundle.json'), 'utf8')
  );

  await page.goto('/index.html');
  await page.evaluate(() => window.MemoAppReady);
  await waitForBoot(page);

  // Seed the in-browser DB with the fixture.
  await page.evaluate(async (b) => {
    window.MemoStateDb.importBundle(b, 'replace');
    await window.MemoStateDb.flush();
  }, bundle);

  // Open Settings so the export button is wired/visible, then export.
  await page.evaluate(() => document.getElementById('mobileSettingsBtn').click());
  await page.waitForFunction(() => document.getElementById('settingsDlg').open, null, { timeout: 5000 });

  // Settings sections fold by default — expand the one holding the backup buttons.
  await page.evaluate(() => {
    const sec = document.getElementById('exportDataBtn').closest('.settings-section');
    if (sec) sec.classList.remove('collapsed');
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickExport(page),
  ]);
  const zipPath = path.join(os.tmpdir(), 'memo-export-' + Date.now() + '.zip');
  fs.writeFileSync(zipPath, (await readPlain(download)).bytes);
  expect(fs.statSync(zipPath).size).toBeGreaterThan(0);

  // Wipe the store, then import the exported ZIP (accept the "replace" prompt).
  await page.evaluate(async () => {
    window.MemoStateDb.importBundle({ version: 1, memos: [], finance: [] }, 'replace');
    await window.MemoStateDb.flush();
  });
  const emptied = await page.evaluate(() => (window.MemoStateDb.loadEntries('default') || []).length);
  expect(emptied).toBe(0);

  await page.setInputFiles('#importDataInput', zipPath);
  await page.locator('#memoConfirmDlg .memo-confirm-ok').click();

  // Import is async; wait for the store to refill from the imported envelope.
  await page.waitForFunction(
    (n) => (window.MemoStateDb.loadEntries('default') || []).length === n,
    bundle.memos.length,
    { timeout: 10000 }
  );

  const restored = await page.evaluate(() => ({
    memos: (window.MemoStateDb.loadEntries('default') || []).length,
    finance: (window.MemoStateDb.loadEntries('finance') || []).length,
  }));
  expect(restored.memos).toBe(bundle.memos.length);
  expect(restored.finance).toBe(bundle.finance.length);

  fs.unlinkSync(zipPath);
});
