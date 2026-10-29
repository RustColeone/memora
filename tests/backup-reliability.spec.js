const { test, expect } = require('@playwright/test');
const JSZip = require('jszip');

async function boot(page) {
  await page.goto('/index.html');
  await page.evaluate(() => window.MemoAppReady);
  await page.waitForFunction(
    () => window.MemoStateDb && window.MemoStateDb.ready() && window.MemoCore,
    null,
    { timeout: 15000 }
  );
}

test('offline import rolls back staged blobs and never commits metadata after a blob write fails', async ({ page }) => {
  const fixtureZip = new JSZip();
  fixtureZip.file('memosystem.json', JSON.stringify({ version: 1, memos: [], finance: [], planner: [] }));
  fixtureZip.file('uploads/good.bin', Buffer.from([1, 2, 3]));
  fixtureZip.file('uploads/fail.bin', Buffer.from([4, 5, 6]));
  const fixtureBytes = await fixtureZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  await boot(page);

  await page.evaluate(() => {
    const envelope = JSON.stringify({
      version: 1,
      memos: [{
        id: 'incoming',
        description: 'must not commit',
        images: ['/uploads/good.bin', '/uploads/fail.bin'],
        attachments: [],
        tags: [],
        ts: 1,
      }],
      finance: [],
      planner: [],
    });
    const members = {
      'memosystem.json': { dir: false, async: async type => type === 'string' ? envelope : null },
      'uploads/good.bin': { dir: false, async: async () => new Blob([new Uint8Array([1, 2, 3])]) },
      'uploads/fail.bin': { dir: false, async: async () => new Blob([new Uint8Array([4, 5, 6])]) },
    };
    window.JSZip = {
      loadAsync: async () => ({
        files: members,
        file(name) { return members[name] || null; },
      }),
    };
  });

  await page.evaluate(() => {
    const db = window.MemoStateDb;
    const probe = window.__backupImportProbe = {
      writes: [],
      deletes: [],
      importCalls: 0,
      flushCalls: 0,
    };
    db.writeBlob = async (name) => {
      probe.writes.push(name);
      if (name.endsWith('/fail.bin')) throw new DOMException('quota exhausted', 'QuotaExceededError');
    };
    db.deleteBlob = async (name) => { probe.deletes.push(name); };
    db.importBundle = () => {
      probe.importCalls++;
      return { memos: 1, finance: 0, planner: 0 };
    };
    db.flush = async () => { probe.flushCalls++; };
    db.loadEntries = () => [];
  });

  await page.setInputFiles('#importDataInput', {
    name: 'faulty-backup.zip',
    mimeType: 'application/zip',
    buffer: fixtureBytes,
  });
  await page.locator('#memoConfirmDlg .memo-confirm-ok').click();
  await page.waitForFunction(() => {
    const text = document.getElementById('importExportStatus').textContent || '';
    return /Import (?:failed|complete)/.test(text);
  });

  const result = await page.evaluate(() => ({
    ...window.__backupImportProbe,
    status: document.getElementById('importExportStatus').textContent,
  }));

  expect(result.status).toContain('Import failed');
  expect(result.writes).toEqual(['uploads/good.bin', 'uploads/fail.bin']);
  expect(result.deletes).toEqual(['uploads/good.bin']);
  expect(result.importCalls).toBe(0);
  expect(result.flushCalls).toBe(0);
});

test('a failed durable metadata flush restores the exact checkpoint and staged blobs', async ({ page }) => {
  const envelope = {
    version: 1,
    memos: [{
      id: 'incoming-after-checkpoint',
      description: 'must roll back',
      tags: [],
      images: ['/uploads/checkpoint.bin'],
      attachments: [],
      ts: 1,
    }],
    finance: [],
    planner: [],
  };
  const fixtureZip = new JSZip();
  fixtureZip.file('memosystem.json', JSON.stringify(envelope));
  fixtureZip.file('uploads/checkpoint.bin', Buffer.from([7, 8, 9]));
  const fixtureBytes = await fixtureZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  await boot(page);

  await page.evaluate(() => {
    const db = window.MemoStateDb;
    const probe = window.__durableImportProbe = {
      current: 'previous-database',
      imports: 0,
      restores: 0,
      flushes: 0,
      deletes: [],
    };
    db.readBlob = async () => null;
    db.writeBlob = async () => {};
    db.deleteBlob = async name => { probe.deletes.push(name); };
    db.createImportCheckpoint = () => ({ exact: 'previous-database' });
    db.restoreImportCheckpoint = checkpoint => {
      probe.restores++;
      probe.current = checkpoint.exact;
    };
    db.importBundle = () => {
      probe.imports++;
      probe.current = 'incoming-database';
      return { memos: 1, finance: 0, planner: 0 };
    };
    db.flush = async () => {
      probe.flushes++;
      if (probe.flushes === 1) throw new Error('simulated snapshot promotion failure');
    };
    db.loadEntries = () => [];
  });

  await page.setInputFiles('#importDataInput', {
    name: 'durable-failure.zip',
    mimeType: 'application/zip',
    buffer: fixtureBytes,
  });
  await page.locator('#memoConfirmDlg .memo-confirm-ok').click();
  await page.waitForFunction(() => /Import failed/.test(
    document.getElementById('importExportStatus')?.textContent || ''
  ));

  const result = await page.evaluate(() => ({
    ...window.__durableImportProbe,
    status: document.getElementById('importExportStatus').textContent,
  }));
  expect(result.status).toContain('Import failed');
  expect(result.current).toBe('previous-database');
  expect(result.imports).toBe(1);
  expect(result.restores).toBe(1);
  expect(result.flushes).toBe(2);
  expect(result.deletes).toEqual(['uploads/checkpoint.bin']);
});
