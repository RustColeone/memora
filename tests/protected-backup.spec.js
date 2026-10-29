// Password-protected backups through the real Backup UI (the one restore
// route: database files are refused), and the lock screen of a restored phone.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PASSWORD, answerPassword, clickExport, decryptMemora } = require('./helpers/protected-backup');
const fake = fs.readFileSync(path.join(__dirname, 'fixtures', 'fake-native-sqlite.js'), 'utf8');

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoStateDb?.ready() && window.MemoCore && window.MemoBackup && window.JSZip && window.MemoStorageUI, null, { timeout: 15000 });
}
async function seed(page, memos) {
  await page.evaluate(async list => {
    window.MemoStateDb.importBundle({ version: 1, memos: list, finance: [], planner: [] }, 'replace');
    await window.MemoStateDb.flush();
  }, memos);
}
async function openBackup(page) {
  await page.evaluate(() => document.getElementById('mobileSettingsBtn').click());
  await page.waitForFunction(() => document.getElementById('settingsDlg').open);
  await page.evaluate(() => document.getElementById('exportDataBtn').closest('.settings-section')?.classList.remove('collapsed'));
}
async function captureDownloads(page, action) {
  const downloads = [];
  const listener = d => downloads.push(d);
  page.on('download', listener);
  await action();
  await page.waitForTimeout(600);
  page.off('download', listener);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-protected-'));
  const out = [];
  for (const d of downloads) { const p = path.join(dir, d.suggestedFilename()); await d.saveAs(p); out.push(p); }
  return out;
}
const memo = (id, description) => ({ id, description, category: 'Work', tags: [], images: [], attachments: [], ts: 1700000000000 });

test('a protected backup exports as .memora files and restores with its password', async ({ page }) => {
  await boot(page);
  await seed(page, [memo('p1', 'Passport number'), memo('p2', 'Bank PIN hint')]);
  await openBackup(page);
  const files = await captureDownloads(page, async () => {
    await clickExport(page);
    await page.waitForFunction(() => /Export complete/.test(document.getElementById('importExportStatus').textContent || ''), null, { timeout: 30000 });
  });
  expect(files.length).toBe(2);
  expect(files.every(f => f.endsWith('.zip.memora'))).toBe(true);
  for (const f of files) {
    const raw = fs.readFileSync(f);
    expect(raw.subarray(0, 6).toString('latin1')).toBe('MEMORA');
    expect(raw.includes(Buffer.from('Passport number'))).toBe(false);
    expect(decryptMemora(raw).subarray(0, 2).toString('latin1')).toBe('PK');
  }

  await seed(page, []);
  await page.setInputFiles('#importDataInput', files);
  const dlg = page.locator('dialog.password-dlg[open]');
  await dlg.locator('#passwordDlgFirst').fill('not the password');
  await dlg.locator('.actions .primary').click();
  await expect(dlg.locator('.password-dlg-error')).toHaveText('Wrong password. Try again.');
  await dlg.locator('#passwordDlgFirst').fill(PASSWORD);
  await dlg.locator('.actions .primary').click();
  await page.locator('#memoConfirmDlg .memo-confirm-ok').click();
  await page.waitForFunction(() => (window.MemoStateDb.loadEntries('default') || []).length === 2, null, { timeout: 20000 });
  expect(await page.evaluate(() => window.MemoStateDb.loadEntries('default').map(e => e.description).sort())).toEqual(['Bank PIN hint', 'Passport number']);
});

test('there is one backup route: database files are refused and change nothing', async ({ page }) => {
  await boot(page);
  await seed(page, [memo('d1', 'Kept as it is')]);
  await openBackup(page);
  await expect(page.locator('#exportDbFileBtn')).toHaveCount(0);
  await expect(page.locator('#settingsDlg .backup-risk-note')).toHaveCount(0);
  await expect(page.locator('#settingsDlg #importDataInput')).toHaveAttribute('accept', '.memora,.zip,application/zip,application/octet-stream');
  const refusal = 'This is a database file, not a backup. Restore a backup made with Export backup.';
  const { plain, sealed } = await page.evaluate(async password => {
    const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
    const db = window.MemoStateDb.exportDatabaseFile();
    return { plain: b64(db), sealed: b64(await window.MemoCrypto.encryptWithPassword(db, password)) };
  }, PASSWORD);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-dbfile-'));
  const plainDb = path.join(dir, 'memora.db'), sealedDb = path.join(dir, 'memora-database.memora');
  fs.writeFileSync(plainDb, Buffer.from(plain, 'base64'));
  fs.writeFileSync(sealedDb, Buffer.from(sealed, 'base64'));

  await seed(page, [memo('d1', 'Kept as it is'), memo('d2', 'Made later')]);
  await page.setInputFiles('#importDataInput', plainDb);
  await expect(page.locator('#importExportStatus')).toContainText(refusal);
  await page.setInputFiles('#importDataInput', sealedDb);
  await answerPassword(page);
  await expect(page.locator('#importExportStatus')).toContainText(refusal);
  await expect(page.locator('#memoConfirmDlg[open]')).toHaveCount(0);
  expect(await page.evaluate(() => window.MemoStateDb.loadEntries('default').map(e => e.id).sort())).toEqual(['d1', 'd2']);
});

test('the assistant chat history travels in the backup: Merge adds, Replace restores', async ({ page }) => {
  await boot(page);
  await seed(page, [memo('c1', 'A note')]);
  const msg = (id, role, content, ts) => ({ id, role, content, ts });
  const saved = [msg('m1', 'user', 'What is due this week?', '2026-10-01T09:00:00.000Z'), msg('m2', 'assistant', 'Two planner items.', '2026-10-01T09:00:05.000Z')];
  await page.evaluate(async list => { window.MemoStateDb.setItem('chat_default', list); await window.MemoStateDb.flush(); }, saved);
  await openBackup(page);
  const files = await captureDownloads(page, async () => {
    await clickExport(page);
    await page.waitForFunction(() => /Export complete/.test(document.getElementById('importExportStatus').textContent || ''), null, { timeout: 30000 });
  });
  const later = msg('m3', 'user', 'Asked after the backup', '2026-10-02T10:00:00.000Z');
  await page.evaluate(async m => { window.MemoStateDb.setItem('chat_default', [m]); await window.MemoStateDb.flush(); }, later);
  const restore = async button => {
    await page.setInputFiles('#importDataInput', files);
    await answerPassword(page);
    const dlg = page.locator('#memoConfirmDlg[open]');
    await dlg.locator('button', { hasText: button }).first().click();
    await page.waitForFunction(() => /Import complete/.test(document.getElementById('importExportStatus').textContent || ''), null, { timeout: 20000 });
    return page.evaluate(() => (window.MemoStateDb.getItem('chat_default') || []).map(m => m.id));
  };
  expect(await restore('Merge')).toEqual(['m1', 'm2', 'm3']);
  expect(await restore('Replace')).toEqual(['m1', 'm2']);
});

test('a restored phone shows the lock screen and opens with the recovery password', async ({ page }) => {
  const harness = async () => {
    await page.goto('/queue-harness.html');
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: '/static/vendor/sql-wasm.js' });
    await page.addScriptTag({ content: fake });
    for (const name of ['memo-i18n.js', 'memo-crypto.js', 'memo-native-store.js', 'memo-state-db.js', 'memo-storage-ui.js']) {
      await page.addScriptTag({ url: '/static/js/memo/' + name });
    }
    await page.evaluate(() => { window.MemoShell = { confirm: async () => true, toast: () => {} }; });
    await page.evaluate(() => window.MemoStateDb.init());
  };
  await page.goto('/queue-harness.html');
  await page.evaluate(() => localStorage.clear());
  await harness();
  await page.evaluate(async () => {
    window.MemoStateDb.saveEntries([{ id: 'kept', description: 'On the old phone', category: 'Work', tags: [], images: [], attachments: [], ts: 1 }], 'default');
    await window.MemoStateDb.flush();
    await window.MemoStateDb.storage.setRecoveryPassword('recovery-pass');
    __fakeNative.restoreOnNewPhone();
  });
  await page.reload();
  await harness();
  // memo-storage-ui ran before init on the reloaded page; ask it to render.
  await page.evaluate(() => window.MemoStateDb.init());
  const lock = page.locator('dialog.storage-lock-dlg[open]');
  await expect(lock).toContainText('The key that opens its database stayed on the old phone.');
  await lock.locator('#storageLockPassword').fill('wrong');
  await lock.locator('.actions .primary').click();
  await expect(lock.locator('.password-dlg-error')).toHaveText('Wrong password. Try again.');
  await lock.locator('#storageLockPassword').fill('recovery-pass');
  await Promise.all([page.waitForEvent('load'), lock.locator('.actions .primary').click()]);
  await harness();
  expect(await page.evaluate(() => ({ engine: window.MemoStateDb.storage.engine(), ids: window.MemoStateDb.loadEntries('default').map(e => e.id) })))
    .toEqual({ engine: 'native', ids: ['kept'] });
});
