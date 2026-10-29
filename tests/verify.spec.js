// Verify & Repair: enumerateBlobs() + MemoVerify.scan/deleteOrphans/pruneMissing.
// Seeds a known blob store (3 files) and entries that reference 2 of them plus
// one path that doesn't exist, so the scan must find exactly 1 orphan + 1 missing.
const { test, expect } = require('@playwright/test');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DIR = 'uploads/2099-02-02';
const A = DIR + '/a.png', B = DIR + '/b.png', C = DIR + '/c.png', MISSING = DIR + '/missing.png';

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready() && window.MemoVerify, null, { timeout: 15000 });
}

// 3 stored blobs (a,b,c); e1→a, e2→b + a dead ref. So c is orphaned, missing is broken.
async function seed(page) {
  await page.evaluate(async ({ b64, A, B, C, MISSING }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const mk = () => new Blob([bytes], { type: 'image/png' });
    for (const rel of [A, B, C]) await window.MemoStateDb.writeBlob(rel, mk());
    window.MemoStateDb.saveEntries([
      { id: 'e1', description: 'valid', _storedPaths: [A], images: ['/' + A], ts: Date.now() },
      { id: 'e2', description: 'has a dead ref', _storedPaths: [B, MISSING], images: ['/' + B, '/' + MISSING], ts: Date.now() },
    ], 'default');
    await window.MemoStateDb.flush();
  }, { b64: PNG_B64, A, B, C, MISSING });
}

test('enumerateBlobs lists every stored blob under uploads/', async ({ page }) => {
  await boot(page);
  await seed(page);
  const list = await page.evaluate(() => window.MemoStateDb.enumerateBlobs());
  expect(list.slice().sort()).toEqual([A, B, C].sort());
});

test('scan finds exactly the orphaned file and the broken reference', async ({ page }) => {
  await boot(page);
  await seed(page);
  const res = await page.evaluate(() => window.MemoVerify.scan());
  expect(res.supported).toBe(true);
  expect(res.storedCount).toBe(3);
  expect(res.refCount).toBe(3);            // A, B, MISSING referenced
  expect(res.orphans).toEqual([C]);        // stored but referenced by nobody
  expect(res.missing).toEqual([MISSING]);  // referenced but not stored
});

test('deleteOrphans removes the orphan from storage and leaves referenced files', async ({ page }) => {
  await boot(page);
  await seed(page);
  const after = await page.evaluate(async () => {
    const before = await window.MemoVerify.scan();
    const n = await window.MemoVerify.deleteOrphans(before.orphans);
    const list = (await window.MemoStateDb.enumerateBlobs()).slice().sort();
    const rescan = await window.MemoVerify.scan();
    return { n, list, orphans: rescan.orphans, storedCount: rescan.storedCount };
  });
  expect(after.n).toBe(1);
  expect(after.list).toEqual([A, B].sort());
  expect(after.orphans).toEqual([]);       // clean after delete
  expect(after.storedCount).toBe(2);
});

test('pruneMissing drops the dead reference from the entry in the DB', async ({ page }) => {
  await boot(page);
  await seed(page);
  const res = await page.evaluate(async () => {
    const scan = await window.MemoVerify.scan();
    const r = window.MemoVerify.pruneMissing(scan.missing);
    const e2 = (window.MemoStateDb.loadEntries('default') || []).find(e => e.id === 'e2');
    const rescan = await window.MemoVerify.scan();
    return { r, e2Paths: e2._storedPaths, missingAfter: rescan.missing };
  });
  expect(res.r.entries).toBe(1);           // one entry changed
  expect(res.r.refs).toBe(1);              // one dead link removed
  expect(res.e2Paths).toEqual([B]);        // MISSING gone, B kept
  expect(res.missingAfter).toEqual([]);    // healthy after repair
});

test('the Scan button renders the report with correct counts, then reads healthy after repair', async ({ page }) => {
  await boot(page);
  await seed(page);
  await page.evaluate(() => document.getElementById('verifyScanBtn').click());
  await page.waitForFunction(() => {
    const b = document.getElementById('verifyReport');
    return b && b.style.display !== 'none' && b.querySelector('.vstat');
  });
  const nums = await page.evaluate(() => [...document.querySelectorAll('#verifyReport .vstat .vnum')].map(n => n.textContent));
  expect(nums).toEqual(['3', '3', '1', '1']); // stored, referenced, orphaned, missing

  // Repair both (orphans + missing), then a fresh scan should report all-clear.
  const healthy = await page.evaluate(async () => {
    const scan = await window.MemoVerify.scan();
    await window.MemoVerify.deleteOrphans(scan.orphans);
    window.MemoVerify.pruneMissing(scan.missing);
    const rescan = await window.MemoVerify.scan();
    return { orphans: rescan.orphans.length, missing: rescan.missing.length, stored: rescan.storedCount };
  });
  expect(healthy).toEqual({ orphans: 0, missing: 0, stored: 2 });
});
