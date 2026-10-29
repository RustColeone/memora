const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => !!window.MemoAppReady);
  await page.evaluate(() => MemoAppReady);
}

test('an old Chrome engine reaches a standalone update page and retains local data', async ({browser}) => {
  const context = await browser.newContext({userAgent:'Mozilla/5.0 (Linux; Android 10; wv) AppleWebKit/537.36 Version/4.0 Chrome/74.0.3729.185 Mobile Safari/537.36',serviceWorkers:'block'});
  try {
    const page = await context.newPage();
    await page.goto('/static/webview-update.html');
    await page.evaluate(() => localStorage.setItem('compat-draft', 'keep'));
    for (const route of ['/index.html', '/finance.html', '/planner.html']) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/static\/webview-update\.html$/);
      await expect(page.locator('h1')).toContainText('Memora needs an update');
      expect(await page.evaluate(() => ({draft:localStorage.getItem('compat-draft'),db:!!window.MemoStateDb}))).toEqual({draft:'keep',db:false});
    }
  } finally {await context.close();}
});

test('image and entry drafts persist and recover without randomUUID or structuredClone', async ({page}) => {
  await page.addInitScript(() => {delete Crypto.prototype.randomUUID; delete window.structuredClone;});
  await boot(page);
  const ids = await page.evaluate(() => Array.from({length:200}, () => MemoContracts.createId()));
  expect(new Set(ids).size).toBe(200);
  ids.forEach(id => expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 80;
    const ctx = c.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0,0,160,80);
    const blob = await new Promise(resolve => c.toBlob(resolve));
    await MemoImageEditor.open(new File([blob], 'compat.png', {type:'image/png'}));
  });
  await expect(page.locator('#mieStatus')).toContainText('160 × 80');
  await page.click('#mieRotateRight');
  await page.evaluate(() => MemoImageEditorImpl.checkpoint());
  const saved = await page.evaluate(async () => {
    const recipe = await MemoImageDraft.read('default');
    return {id:recipe.id,ops:recipe.ops,bytes:Array.from(new Uint8Array(await recipe.blob.arrayBuffer()))};
  });
  await page.reload(); await page.evaluate(() => MemoAppReady);
  await page.evaluate(() => MemoImageEditor.open()); await page.click('#mieResume');
  await expect(page.locator('#mieDraftStatus')).toHaveText('Saved edit restored');
  await expect.poll(() => page.locator('#mieCanvas').evaluate(c => [c.width,c.height])).toEqual([80,160]);
  expect(await page.evaluate(async () => {const recipe=await MemoImageDraft.read('default');return {id:recipe.id,ops:recipe.ops,bytes:Array.from(new Uint8Array(await recipe.blob.arrayBuffer()))};})).toEqual(saved);
  // The image-to-entry handoff also exercises the attachment draft UUID path.
  await page.click('#mieSave');
  await expect(page.locator('#entryDlg')).toHaveAttribute('open', '');
  await page.evaluate(() => MemoDraft.saveChecked());
  const original = await page.evaluate(async () => {
    const draft = MemoStateDb.getItem('memo_editor_draft_default');
    return Array.from(new Uint8Array(await (await MemoStateDb.readBlob(draft.images[0].draftPath)).arrayBuffer()));
  });
  await page.reload(); await page.evaluate(() => MemoAppReady);
  await expect(page.locator('#entryDlg')).toHaveAttribute('open', '');
  await expect(page.locator('#dragGrid .dragitem')).toHaveCount(1);
  expect(await page.evaluate(async () => Array.from(new Uint8Array(await MemoCore.captureDraft().images[0].file.arrayBuffer())))).toEqual(original);
});

test('PDF renders and extracts text in a real worker without newer APIs in either realm', async ({page}) => {
  const remove = () => {delete Promise.withResolvers;delete Array.prototype.at;delete window.structuredClone;};
  await page.addInitScript(remove);
  await page.route('**/static/vendor/pdf.worker.min.mjs', route => route.fulfill({contentType:'text/javascript',body:
    'delete Promise.withResolvers;delete Array.prototype.at;delete self.structuredClone;\n' + fs.readFileSync(path.resolve(__dirname, '../src/static/vendor/pdf.worker.min.mjs'), 'utf8')}));
  await boot(page);
  await page.addScriptTag({url:'/static/vendor/jspdf.umd.min.js'});
  const result = await page.evaluate(async () => {
    const pdf = new jspdf.jsPDF({unit:'pt',format:[200,120],orientation:'landscape'});
    pdf.text('Memora compatibility', 10, 30);
    const lib = await MemoPdf.ensure();
    const doc = await lib.getDocument({data:pdf.output('arraybuffer')}).promise;
    try {
      const first = await doc.getPage(1);
      const canvas = document.createElement('canvas');const viewport=first.getViewport({scale:1});
      canvas.width=viewport.width;canvas.height=viewport.height;
      await first.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      return {text:(await first.getTextContent()).items.map(i=>i.str).join(' '),dimensions:[canvas.width,canvas.height],realWorker:doc.loadingTask._worker.port instanceof Worker,
        ink:Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data).some((v,i)=>i%4!==3 && v<100)};
    } finally {await doc.destroy();}
  });
  expect(result).toEqual({text:'Memora compatibility',dimensions:[200,120],realWorker:true,ink:true});
});

test('a failed PDF load can be retried after a temporary network error', async ({page}) => {
  await boot(page);
  let available=false;
  await page.route('**/static/vendor/pdf.min.mjs', route => available ? route.continue() : route.fulfill({status:503,body:'Temporarily unavailable'}));
  expect(await page.evaluate(() => MemoPdf.ensure().then(()=>false,()=>true))).toBe(true);
  available=true;
  expect(await page.evaluate(() => MemoPdf.ensure().then(lib=>lib.version))).toBe('4.7.76');
});
