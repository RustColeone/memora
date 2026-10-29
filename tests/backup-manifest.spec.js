const { test, expect } = require('@playwright/test');
const { clickExport, answerPassword, readPlain, plainName } = require('./helpers/protected-backup');
const JSZip = require('jszip');
const crypto = require('crypto');
const fs = require('fs');

const MANIFEST_MEMBER = 'memosystem-backup.json';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoStateDb?.ready() && window.MemoCore && window.MemoBackup && window.JSZip,
    null,
    { timeout: 15000 },
  );
}

async function openBackupPanel(page) {
  await page.evaluate(() => document.getElementById('mobileSettingsBtn').click());
  await page.waitForFunction(() => document.getElementById('settingsDlg').open);
  await page.evaluate(() => document.getElementById('exportDataBtn').closest('.settings-section')?.classList.remove('collapsed'));
}

async function captureExport(page) {
  const downloads = [];
  const listener = download => downloads.push(download);
  page.on('download', listener);
  await clickExport(page);
  await page.waitForFunction(() => /Export complete/.test(
    document.getElementById('importExportStatus')?.textContent || ''
  ), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  page.off('download', listener);

  const files = [];
  for (const download of downloads) {
    files.push(await readPlain(download));
  }
  return files;
}

async function readManifest(files) {
  const archive = files.find(file => /00_manifest/i.test(file.name));
  expect(archive, `download names: ${files.map(file => file.name).join(', ')}`).toBeTruthy();
  const zip = await JSZip.loadAsync(archive.bytes);
  const member = zip.file(MANIFEST_MEMBER);
  expect(member).toBeTruthy();
  return JSON.parse(await member.async('string'));
}

test('a complete export emits a checksummed manifest before marking backup complete', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    localStorage.removeItem('memo_backed_up');
    window.MemoStateDb.importBundle({
      version: 1,
      memos: [{ id: 'manifest-memo', description: 'complete export', category: 'Audit', tags: [], images: [], ts: 1 }],
      finance: [{ id: 'manifest-finance', description: 'complete export', category: 'Audit', tags: [], images: [], purchaseDate: '2026-07-18', ts: 2 }],
      planner: [{ id: 'manifest-plan', kind: 'todo', title: 'complete export', createdAt: '2026-07-18T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z' }],
    }, 'replace');
    await window.MemoStateDb.flush();
  });
  await openBackupPanel(page);

  const files = await captureExport(page);
  const manifest = await readManifest(files);
  const dataFiles = files.filter(file => !/00_manifest/i.test(file.name));

  expect(dataFiles).toHaveLength(1);
  expect(manifest.type).toBe('memosystem-backup-set');
  expect(manifest.version).toBe(1);
  expect(manifest.full_library).toBe(true);
  expect(manifest.counts).toEqual({ memos: 1, finance: 1, planner: 1 });
  expect(manifest.parts).toHaveLength(1);
  expect(manifest.parts[0]).toMatchObject({
    name: dataFiles[0].name,
    bytes: dataFiles[0].bytes.length,
    sha256: sha256(dataFiles[0].bytes),
  });
  expect(await page.evaluate(() => localStorage.getItem('memo_backed_up'))).toBe('1');
});

test('a scoped export stays explicitly partial and cannot clear the backup reminder', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    localStorage.removeItem('memo_backed_up');
    window.MemoStateDb.importBundle({
      version: 1,
      memos: [{ id: 'scope-memo', description: 'scoped', category: 'Audit', tags: [], images: [], ts: 1 }],
      finance: [{ id: 'scope-finance', description: 'excluded', category: 'Audit', tags: [], images: [], purchaseDate: '2026-07-18', ts: 2 }],
      planner: [],
    }, 'replace');
    await window.MemoStateDb.flush();
  });
  await openBackupPanel(page);
  await page.uncheck('#exportInclFinance');

  const files = await captureExport(page);
  const manifest = await readManifest(files);

  expect(manifest.full_library).toBe(false);
  expect(manifest.counts).toEqual({ memos: 1, finance: 0, planner: 0 });
  expect(await page.evaluate(() => localStorage.getItem('memo_backed_up'))).toBeNull();
});

async function makePart(setId, part, description) {
  const zip = new JSZip();
  zip.file('memosystem.json', JSON.stringify({
    version: 1,
    backup_set: { id: setId, part, parts: 2 },
    memos: [{ id: `part-${part}`, description, category: 'Audit', tags: [], images: [], ts: part }],
    finance: [],
    planner: [],
  }));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

async function makeManifest(setId, records) {
  const zip = new JSZip();
  zip.file(MANIFEST_MEMBER, JSON.stringify({
    type: 'memosystem-backup-set',
    version: 1,
    id: setId,
    created_at: '2026-07-18T00:00:00.000Z',
    full_library: true,
    counts: { memos: 2, finance: 0, planner: 0 },
    parts: records,
  }));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

async function installImportProbe(page) {
  await page.evaluate(() => {
    const db = window.MemoStateDb;
    const probe = window.__manifestImportProbe = { imports: 0, writes: 0 };
    db.importBundle = () => {
      probe.imports++;
      return { memos: 1, finance: 0, planner: 0 };
    };
    db.readBlob = async () => null;
    db.writeBlob = async () => { probe.writes++; };
    db.flush = async () => {};
    db.loadEntries = () => [];
  });
}

async function importFiles(page, files) {
  await page.setInputFiles('#importDataInput', files.map(file => ({
    name: file.name,
    mimeType: 'application/zip',
    buffer: file.bytes,
  })));
  await page.waitForFunction(() => /Import (?:failed|complete)/.test(
    document.getElementById('importExportStatus')?.textContent || ''
  ));
  return page.evaluate(() => ({
    ...window.__manifestImportProbe,
    status: document.getElementById('importExportStatus').textContent,
  }));
}

test('an incomplete manifest set is rejected before the first metadata mutation', async ({ page }) => {
  const setId = 'set-incomplete';
  const part1 = await makePart(setId, 1, 'one');
  const part2 = await makePart(setId, 2, 'two');
  const names = ['memoSystem-backup-setincom-01.zip', 'memoSystem-backup-setincom-02.zip'];
  const manifest = await makeManifest(setId, [part1, part2].map((bytes, index) => ({
    name: names[index], bytes: bytes.length, sha256: sha256(bytes), part: index + 1,
  })));
  await boot(page);
  await installImportProbe(page);

  const result = await importFiles(page, [
    { name: 'memoSystem-backup-00_manifest_setincom.zip', bytes: manifest },
    { name: names[0], bytes: part1 },
  ]);

  expect(result.status).toContain('Import failed');
  expect(result.status).toContain('incomplete');
  expect(result.imports).toBe(0);
  expect(result.writes).toBe(0);
});

test('a checksum-mismatched part is rejected before the first metadata mutation', async ({ page }) => {
  const setId = 'set-tampered';
  const original = await makePart(setId, 1, 'original');
  const tampered = await makePart(setId, 1, 'altered!');
  const part2 = await makePart(setId, 2, 'two');
  const names = ['memoSystem-backup-settampe-01.zip', 'memoSystem-backup-settampe-02.zip'];
  const manifest = await makeManifest(setId, [original, part2].map((bytes, index) => ({
    name: names[index], bytes: bytes.length, sha256: sha256(bytes), part: index + 1,
  })));
  await boot(page);
  await installImportProbe(page);

  const result = await importFiles(page, [
    { name: 'memoSystem-backup-00_manifest_settampe.zip', bytes: manifest },
    { name: names[0], bytes: tampered },
    { name: names[1], bytes: part2 },
  ]);

  expect(result.status).toContain('Import failed');
  expect(result.status).toContain('checksum failed');
  expect(result.imports).toBe(0);
  expect(result.writes).toBe(0);
});
