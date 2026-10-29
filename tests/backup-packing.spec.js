// Unit tests for the size-based backup packer (memo-backup.js). These exercise
// the pure algorithm in-browser via window.MemoBackup — no real blobs, no
// network — so they are fast and deterministic.
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoBackup, null, { timeout: 15000 });
}

test.beforeEach(async ({ page }) => { await boot(page); });

test('planParts: greedily fills a part then spills when the next item exceeds the cap', async ({ page }) => {
  const parts = await page.evaluate(() => {
    const items = [
      { id: 'a', ts: 1, bytes: 40 },
      { id: 'b', ts: 2, bytes: 40 },
      { id: 'c', ts: 3, bytes: 40 },
      { id: 'd', ts: 4, bytes: 40 },
      { id: 'e', ts: 5, bytes: 40 },
    ];
    return window.MemoBackup.planParts(items, 100).map(p => p.map(i => i.id));
  });
  // 100-byte cap, 40 each: [a,b] (80) -> c would make 120 > 100 -> spill.
  expect(parts).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
});

test('planParts: forward-progress guard puts an oversized item alone in its own part', async ({ page }) => {
  const parts = await page.evaluate(() => {
    const items = [
      { id: 'small1', ts: 1, bytes: 10 },
      { id: 'huge', ts: 2, bytes: 9999 }, // alone exceeds cap
      { id: 'small2', ts: 3, bytes: 10 },
    ];
    return window.MemoBackup.planParts(items, 100).map(p => p.map(i => i.id));
  });
  // small1 fills part 1; huge alone would exceed cap so it spills into its own
  // part (guard lets it land even though it's over-cap); small2 starts a 3rd.
  expect(parts).toEqual([['small1'], ['huge'], ['small2']]);
});

test('planParts: a single over-cap item never produces an empty part or loops', async ({ page }) => {
  const parts = await page.evaluate(() =>
    window.MemoBackup.planParts([{ id: 'only', ts: 1, bytes: 10 ** 9 }], 100).map(p => p.map(i => i.id))
  );
  expect(parts).toEqual([['only']]);
});

test('planParts: sorts oldest→newest before packing regardless of input order', async ({ page }) => {
  const order = await page.evaluate(() => {
    const items = [
      { id: 'c', ts: 300, bytes: 1 },
      { id: 'a', ts: 100, bytes: 1 },
      { id: 'b', ts: 200, bytes: 1 },
    ];
    const parts = window.MemoBackup.planParts(items, 1000);
    return parts[0].map(i => i.id);
  });
  expect(order).toEqual(['a', 'b', 'c']);
});

test('planParts: zero-byte (linked-only) items all share one part', async ({ page }) => {
  const parts = await page.evaluate(() => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: 'e' + i, ts: i, bytes: 0 }));
    return window.MemoBackup.planParts(items, 100).length;
  });
  expect(parts).toBe(1);
});

test('planParts: empty input yields no parts', async ({ page }) => {
  const n = await page.evaluate(() => window.MemoBackup.planParts([], 100).length);
  expect(n).toBe(0);
});

test('planParts: does not mutate the caller’s array', async ({ page }) => {
  const same = await page.evaluate(() => {
    const items = [{ id: 'b', ts: 2, bytes: 1 }, { id: 'a', ts: 1, bytes: 1 }];
    const before = items.map(i => i.id).join(',');
    window.MemoBackup.planParts(items, 100);
    return before === items.map(i => i.id).join(',');
  });
  expect(same).toBe(true); // input order preserved (sort is on a copy)
});

test('getPartCap/setPartCap round-trips and the default stays within the safe import budget', async ({ page }) => {
  const result = await page.evaluate(() => {
    const def = window.MemoBackup.getPartCap();
    window.MemoBackup.setPartCap(100 * 1024 * 1024);
    const set = window.MemoBackup.getPartCap();
    window.MemoBackup.setPartCap(0);       // ignored (must be > 0)
    const afterBad = window.MemoBackup.getPartCap();
    window.MemoBackup.setPartCap(def);      // restore
    return { def, set, afterBad };
  });
  expect(result.def).toBe(64 * 1024 * 1024);
  expect(result.set).toBe(100 * 1024 * 1024);
  expect(result.afterBad).toBe(100 * 1024 * 1024); // 0 rejected, keeps prior
});

test('collectEntryRels: keeps app-private uploads, drops remote/blob/data URLs', async ({ page }) => {
  const rels = await page.evaluate(() => window.MemoBackup.collectEntryRels({
    images: ['/uploads/2025-01-01/a.png', 'https://cdn.example/x.png', 'blob:xyz', 'data:image/png;base64,AAAA'],
    _storedPaths: ['uploads/2025-01-01/a.png', null],
    attachments: [
      { storedPath: 'uploads/2025-02-02/doc.pdf', name: 'doc' },
      { url: 'https://cdn.example/y.pdf' },
      'uploads/2025-03-03/note.txt',
    ],
  }));
  // _storedPaths wins for images; remote/blob/data are excluded; attachments add
  // their stored uploads. De-duplicated in reference order.
  expect(rels).toEqual([
    'uploads/2025-01-01/a.png',
    'uploads/2025-02-02/doc.pdf',
    'uploads/2025-03-03/note.txt',
  ]);
});

test('partName: 1-based, zero-padded, tagged with the part’s date range', async ({ page }) => {
  const out = await page.evaluate(() => {
    const min = new Date(2024, 0, 5).getTime();   // local 2024-01-05
    const max = new Date(2024, 11, 31).getTime(); // local 2024-12-31
    // Derive expected via the same dateOf so the assertion is timezone-agnostic.
    return {
      name: window.MemoBackup.partName(1, min, max),
      expected: 'memoSystem-backup-01_' + window.MemoBackup.dateOf(min) + '_' + window.MemoBackup.dateOf(max) + '.zip',
    };
  });
  expect(out.name).toBe(out.expected);
  expect(out.name).toMatch(/^memoSystem-backup-01_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.zip$/);
});
