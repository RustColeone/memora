const { test, expect } = require('@playwright/test');
const JSZip = require('jszip');

const MiB = 1024 * 1024;

async function makeZip(extraName, extraBytes, compression = 'STORE') {
  const zip = new JSZip();
  zip.file('memosystem.json', JSON.stringify({
    version: 1,
    memos: [{
      id: 'archive-probe',
      description: 'must remain uncommitted',
      tags: [],
      images: [`/${extraName.replace(/^\.\.\//, '')}`],
      attachments: [],
      ts: 1,
    }],
    finance: [],
    planner: [],
  }));
  zip.file(extraName, extraBytes, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression });
}

function patchCentralExpandedSize(input, memberName, expandedSize) {
  const out = Buffer.from(input);
  for (let pos = 0; pos + 46 <= out.length; pos++) {
    if (out.readUInt32LE(pos) !== 0x02014b50) continue;
    const nameLength = out.readUInt16LE(pos + 28);
    const extraLength = out.readUInt16LE(pos + 30);
    const commentLength = out.readUInt16LE(pos + 32);
    const name = out.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    if (name === memberName) {
      out.writeUInt32LE(expandedSize, pos + 24);
      return out;
    }
    pos += 45 + nameLength + extraLength + commentLength;
  }
  throw new Error(`central-directory member not found: ${memberName}`);
}

async function bootWithProbe(page) {
  await page.goto('/index.html');
  await page.evaluate(() => window.MemoAppReady);
  await page.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready() && window.JSZip);
  await page.evaluate(() => {
    const originalLoad = window.JSZip.loadAsync.bind(window.JSZip);
    const probe = window.__zipPreflightProbe = { loads: 0, writes: [], imports: 0, flushes: 0 };
    window.JSZip.loadAsync = async (...args) => {
      probe.loads++;
      return originalLoad(...args);
    };
    const db = window.MemoStateDb;
    db.readBlob = async () => null;
    db.writeBlob = async name => { probe.writes.push(name); };
    db.deleteBlob = async () => {};
    db.importBundle = () => {
      probe.imports++;
      return { memos: 1, finance: 0, planner: 0 };
    };
    db.flush = async () => { probe.flushes++; };
    db.loadEntries = () => [];
  });
}

async function importBuffer(page, buffer, name) {
  await page.setInputFiles('#importDataInput', {
    name,
    mimeType: 'application/zip',
    buffer,
  });
  await page.locator('#memoConfirmDlg .memo-confirm-secondary').click();
  await page.waitForFunction(() => /Import (?:failed|complete)/.test(
    document.getElementById('importExportStatus')?.textContent || ''
  ));
  return page.evaluate(() => ({
    ...window.__zipPreflightProbe,
    status: document.getElementById('importExportStatus').textContent,
  }));
}

test('rejects a traversal ZIP member before extraction or mutation', async ({ page }) => {
  const archive = await makeZip('../uploads/escape.bin', Buffer.from([1, 2, 3]));
  await bootWithProbe(page);
  const result = await importBuffer(page, archive, 'traversal.zip');

  expect(result.status).toContain('Import failed');
  expect(result.status).toContain('Unsafe ZIP path');
  expect(result.loads).toBe(0);
  expect(result.writes).toEqual([]);
  expect(result.imports).toBe(0);
});

test('rejects an oversized declared member before JSZip expands it', async ({ page }) => {
  const safe = await makeZip('uploads/oversized.bin', Buffer.from([1]));
  const archive = patchCentralExpandedSize(safe, 'uploads/oversized.bin', 97 * MiB);
  await bootWithProbe(page);
  const result = await importBuffer(page, archive, 'oversized-member.zip');

  expect(result.status).toContain('Import failed');
  expect(result.status).toContain('member is too large');
  expect(result.loads).toBe(0);
  expect(result.writes).toEqual([]);
  expect(result.imports).toBe(0);
});

test('rejects a high-ratio ZIP bomb before extraction or mutation', async ({ page }) => {
  const archive = await makeZip('uploads/high-ratio.bin', Buffer.alloc(2 * MiB), 'DEFLATE');
  await bootWithProbe(page);
  const result = await importBuffer(page, archive, 'high-ratio.zip');

  expect(result.status).toContain('Import failed');
  expect(result.status).toContain('unsafe compression ratio');
  expect(result.loads).toBe(0);
  expect(result.writes).toEqual([]);
  expect(result.imports).toBe(0);
});
