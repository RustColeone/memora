// Reader + PDF attachments — PDF pages render inline as reader pages via the
// vendored pdf.js (pre-seeded onto window.pdfjsLib by the adapter's prepare()).
// Honors the images-AND-PDF-per-entry model: an entry's images form one
// sub-document, then each PDF attachment follows as its own sub-document with a
// divider at each boundary.
const { test, expect } = require('@playwright/test');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Minimal valid 2-page PDF (blank pages) with a correct xref — built in-page.
const BUILD_PDF = `() => {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>',
  ];
  let pdf = '%PDF-1.4\\n';
  const offs = [];
  for (let i = 0; i < objs.length; i++) { offs.push(pdf.length); pdf += (i + 1) + ' 0 obj\\n' + objs[i] + '\\nendobj\\n'; }
  const xref = pdf.length;
  pdf += 'xref\\n0 ' + (objs.length + 1) + '\\n0000000000 65535 f \\n';
  for (const o of offs) pdf += String(o).padStart(10, '0') + ' 00000 n \\n';
  pdf += 'trailer\\n<</Size ' + (objs.length + 1) + '/Root 1 0 R>>\\nstartxref\\n' + xref + '\\n%%EOF';
  return pdf;
}`;

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoReader && window.MemoPdf && window.UniversalReader && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
}

test('an entry with images + a PDF composes image pages then PDF pages', async ({ page }) => {
  await boot(page);
  await page.evaluate(async ({ png, buildSrc }) => {
    const buildPdf = eval(buildSrc);
    const bytes = new TextEncoder().encode(buildPdf());
    const rel = 'uploads/2099-03-03/doc.pdf';
    await window.MemoStateDb.writeBlob(rel, new Blob([bytes], { type: 'application/pdf' }));
    const memos = [{
      id: 'pdf1', description: 'Scan + PDF', category: 'Work', tags: [], images: [png],
      attachments: [{ name: 'doc.pdf', storedPath: rel, url: '/' + rel, type: 'application/pdf' }],
      ts: Date.now(),
    }];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
  }, { png: PNG, buildSrc: BUILD_PDF });

  await page.evaluate(() => {
    const e = window.MemoCore.getState().db.entries.find(x => x.id === 'pdf1');
    window.MemoReader.open(e, 0);
  });

  // The grouped entry resolves its PDF sub-document before first render:
  // 1 image page + 2 PDF pages, with one divider at the image|PDF boundary.
  await page.waitForFunction(() => window.MemoReader.__state().pageCount === 3, null, { timeout: 25000 });
  const s = await page.evaluate(() => ({
    total: window.MemoReader.__state().pageCount,
    domPages: document.querySelectorAll('#urScroll .ur-strip img.ur-page').length,
    dividers: document.querySelectorAll('#urScroll .ur-strip .ur-doc-divider').length,
    progressMax: document.getElementById('urProgress').max,
  }));
  expect(s.total).toBe(3);
  expect(s.domPages).toBe(3);
  expect(s.dividers).toBe(1);       // one boundary: images → doc.pdf
  expect(s.progressMax).toBe('1');  // progress is segment-local; page 1 sits in the 1-page image segment
});

test('a PDF attachment opens in the reader (not the browser native viewer)', async ({ page }) => {
  await boot(page);
  await page.evaluate(async ({ buildSrc }) => {
    const buildPdf = eval(buildSrc);
    const bytes = new TextEncoder().encode(buildPdf());
    const rel = 'uploads/2099-04-04/contract.pdf';
    await window.MemoStateDb.writeBlob(rel, new Blob([bytes], { type: 'application/pdf' }));
    const memos = [{
      id: 'pdfonly', description: 'Contract', category: 'Work', tags: [], images: [],
      attachments: [{ name: 'contract.pdf', storedPath: rel, url: '/' + rel, type: 'application/pdf' }], ts: Date.now(),
    }];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    const sel = document.getElementById('categoryFilter');
    if (![...sel.options].some(o => o.value === 'Work')) { const o = document.createElement('option'); o.value = 'Work'; o.textContent = 'Work'; sel.appendChild(o); }
    sel.value = 'Work'; window.MemoCore.renderFeed();
  }, { buildSrc: BUILD_PDF });

  // The card renders the PDF as a button (reader), never an <a target=_blank> (native white viewer).
  const link = await page.$('#feed .card[data-id="pdfonly"] .attachments a[target="_blank"]');
  expect(link).toBeNull();
  await page.waitForSelector('#feed .card[data-id="pdfonly"] .filelink-pdf');
  await page.click('#feed .card[data-id="pdfonly"] .filelink-pdf');
  await page.waitForFunction(() => document.getElementById('urDlg') && document.getElementById('urDlg').open, null, { timeout: 10000 });
  await page.waitForFunction(() => window.MemoReader.__state().pageCount === 2, null, { timeout: 25000 }); // the PDF's 2 pages
  const s = await page.evaluate(() => window.MemoReader.__state());
  expect(s.opened).toBe(true);
  expect(s.entryId).toBe('pdfonly');
});

// Build an N-page blank PDF with a valid xref (same shape as BUILD_PDF but variable count).
const BUILD_PDF_N = `(n) => {
  const kids = Array.from({length:n},(_,i)=>(i+3)+' 0 R').join(' ');
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids['+kids+']/Count '+n+'>>'];
  for (let i=0;i<n;i++) objs.push('<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>');
  let pdf = '%PDF-1.4\\n'; const offs=[];
  for (let i=0;i<objs.length;i++){ offs.push(pdf.length); pdf += (i+1)+' 0 obj\\n'+objs[i]+'\\nendobj\\n'; }
  const xref = pdf.length;
  pdf += 'xref\\n0 '+(objs.length+1)+'\\n0000000000 65535 f \\n';
  for (const o of offs) pdf += String(o).padStart(10,'0')+' 00000 n \\n';
  pdf += 'trailer\\n<</Size '+(objs.length+1)+'/Root 1 0 R>>\\nstartxref\\n'+xref+'\\n%%EOF';
  return pdf;
}`;

// Regression guard: page composition is a pure function of the entry (grouped
// descriptor → resolved parts), so cross-entry round trips must never grow the
// page count (the pre-UniversalReader model once duplicated 2 → 4 → 6 …).
test('repeated cross-entry swipes never duplicate a PDF entry’s pages; divider marks each PDF', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await boot(page);

  await page.evaluate(async ({ buildN }) => {
    const buildN2 = eval(buildN);
    const put = async (rel, n) => { await window.MemoStateDb.writeBlob(rel, new Blob([new TextEncoder().encode(buildN2(n))], { type: 'application/pdf' })); };
    await put('uploads/2099-07-01/a.pdf', 2);
    await put('uploads/2099-07-01/b.pdf', 3);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const memos = [
      { id: 'e1', description: 'One', category: 'Work', tags: [], images: [png], ts: 3000 },
      { id: 'e2', description: 'Two PDFs', category: 'Work', tags: [], images: [],
        attachments: [
          { name: 'a.pdf', storedPath: 'uploads/2099-07-01/a.pdf', url: '/uploads/2099-07-01/a.pdf', type: 'application/pdf' },
          { name: 'b.pdf', storedPath: 'uploads/2099-07-01/b.pdf', url: '/uploads/2099-07-01/b.pdf', type: 'application/pdf' },
        ], ts: 2000 },
      { id: 'e3', description: 'Three', category: 'Work', tags: [], images: [png], ts: 1000 },
    ];
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
    const sel = document.getElementById('categoryFilter'); const o = document.createElement('option'); o.value = 'Work'; o.textContent = 'Work'; sel.appendChild(o); sel.value = 'Work'; window.MemoCore.renderFeed();
  }, { buildN: BUILD_PDF_N });

  // Open e2 (the two-PDF entry) directly and let its PDFs resolve.
  await page.evaluate(() => { const e = window.MemoCore.getState().db.entries.find(x => x.id === 'e2'); window.MemoReader.open(e, 0); });
  await page.waitForFunction(() => window.MemoReader.__state().entryId === 'e2' && window.MemoReader.__state().pageCount === 5, null, { timeout: 25000 });

  const swipe = (dir) => page.evaluate((dir) => {
    const sc = document.getElementById('urScroll'), r = sc.getBoundingClientRect(), y = r.top + r.height / 2;
    const pe = (t, x) => sc.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, bubbles: true, pointerType: 'touch' }));
    const from = dir < 0 ? r.left + 440 : r.left + 40, to = dir < 0 ? r.left + 40 : r.left + 440;
    pe('pointerdown', from); pe('pointermove', (from + to) / 2); pe('pointermove', to); pe('pointerup', to);
  }, dir);

  // Swipe away to e3 and back to e2, three full round-trips. Page count must hold at 5.
  for (let k = 0; k < 3; k++) {
    await swipe(-1); // e2 → e3
    await page.waitForFunction(() => window.MemoReader.__state().entryId === 'e3', null, { timeout: 25000 });
    await page.waitForTimeout(150);
    await swipe(1);  // e3 → e2
    await page.waitForFunction(() => window.MemoReader.__state().entryId === 'e2', null, { timeout: 25000 });
    await page.waitForTimeout(150);
    const n = await page.evaluate(() => window.MemoReader.__state().pageCount);
    expect(n).toBe(5); // 2 (a.pdf) + 3 (b.pdf) — never 10, 15, …
  }

  // A divider marks the boundary between the two PDFs (where b.pdf's pages start).
  const dividers = await page.evaluate(() => document.querySelectorAll('#urScroll .ur-strip .ur-doc-divider').length);
  expect(dividers).toBe(1);
});

test('an entry with no PDF attachments composes nothing extra', async ({ page }) => {
  await boot(page);
  await page.evaluate((png) => {
    const e = { id: 'x', description: 'imgs only', images: [png, png], attachments: [], ts: Date.now() };
    window.MemoReader.open(e, 0);
  }, PNG);
  await page.waitForFunction(() => window.MemoReader.__state().opened, null, { timeout: 10000 });
  await page.waitForTimeout(300); // nothing should compose in afterwards
  const total = await page.evaluate(() => window.MemoReader.__state().pageCount);
  expect(total).toBe(2); // images only
});
