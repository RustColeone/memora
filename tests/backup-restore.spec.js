const { test, expect } = require('@playwright/test');
const JSZip = require('jszip');

async function part(id, files = {}) {
  const z = new JSZip();
  z.file('memosystem.json', JSON.stringify({version:1,
    memos:[{id:id+'-memo',description:id,ts:1000,images:['/uploads/'+id+'.bin']}],
    finance:[{id:id+'-finance',description:id,ts:1000,price:12.5}],
    planner:[{id:id+'-planner',kind:'todo',title:id,createdAt:'2026-09-01T00:00:00Z'}]}));
  for (const [name, bytes] of Object.entries(files)) z.file(name, bytes);
  return {name:id+'.zip',mimeType:'application/zip',buffer:await z.generateAsync({type:'nodebuffer'})};
}
async function boot(page) {
  await page.goto('/index.html');
  await page.evaluate(() => MemoAppReady);
  await page.waitForFunction(() => MemoStateDb.ready());
  await page.evaluate(async () => {
    const db = MemoStateDb;
    db.saveEntries([{id:'original-memo',description:'Original memo',ts:1}], 'default');
    db.saveEntries([{id:'original-finance',description:'Original finance',ts:1,price:20}], 'finance');
    db.saveDocs('planner',[{id:'original-planner',kind:'todo',title:'Original task'}]);
    await db.writeBlob('uploads/original.bin',new Blob(['original-file']));
    await db.flush();
  });
}
async function contents(page) {
  return page.evaluate(() => ({memos:MemoStateDb.loadEntries('default').map(e=>e.id).sort(),
    finance:MemoStateDb.loadEntries('finance').map(e=>e.id).sort(),
    planner:MemoStateDb.loadDocs('planner').map(e=>e.id).sort()}));
}
const original = {memos:['original-memo'],finance:['original-finance'],planner:['original-planner']};
async function finish(page) {
  await expect(page.locator('#importExportStatus')).toContainText(/Import (failed|complete)/);
  await page.waitForFunction(() => !MemoBackupUI.isRestoring());
}

test('Cancel and Android-style Back dismiss restore without changing any section', async ({page}) => {
  await boot(page);
  for (const action of ['cancel','back']) {
    await page.setInputFiles('#importDataInput', await part('incoming'));
    await expect(page.locator('#memoConfirmDlg')).toBeVisible();
    if (action === 'cancel') await page.click('#memoConfirmDlg .memo-confirm-cancel');
    else await page.evaluate(() => MemoShell.handleSystemBack());
    await expect(page.locator('#importExportStatus')).toContainText('Restore cancelled');
    await page.waitForFunction(() => !MemoBackupUI.isRestoring());
    expect(await contents(page)).toEqual(original);
  }
  await page.reload(); await page.evaluate(() => MemoAppReady);
  expect(await contents(page)).toEqual(original);
});

test('Merge imports all sections and records restorable files in the durable sync queue', async ({page}) => {
  await boot(page);
  await page.setInputFiles('#importDataInput', await part('incoming', {'uploads/incoming.bin':Buffer.from('incoming-file')}));
  await page.click('#memoConfirmDlg .memo-confirm-secondary'); await finish(page);
  expect(await contents(page)).toEqual({memos:['incoming-memo','original-memo'],finance:['incoming-finance','original-finance'],planner:['incoming-planner','original-planner']});
  await page.reload(); await page.evaluate(() => MemoAppReady);
  expect(await page.evaluate(async () => (await MemoStateDb.readBlob('uploads/incoming.bin')).text())).toBe('incoming-file');
  const queued = await page.evaluate(() => ['default','finance','planner'].map(v => OperationQueue.readState(v).queue.filter(o=>!o.synced).map(o=>({id:o.entryId,files:o.data?._filesToUpload}))));
  expect(queued[0]).toContainEqual({id:'incoming-memo',files:['uploads/incoming.bin']});
  expect(queued[1].some(o=>o.id==='incoming-finance')).toBe(true);
  expect(queued[2].some(o=>o.id==='incoming-planner')).toBe(true);
});

test('Replace of several parts commits all sections together and journals removals', async ({page}) => {
  await boot(page);
  await page.setInputFiles('#importDataInput', [await part('first'), await part('second')]);
  await page.click('#memoConfirmDlg .memo-confirm-ok'); await finish(page);
  expect(await contents(page)).toEqual({memos:['first-memo','second-memo'],finance:['first-finance','second-finance'],planner:['first-planner','second-planner']});
  expect(await page.evaluate(() => OperationQueue.readState('default').queue.some(o=>o.type==='delete'&&o.entryId==='original-memo'))).toBe(true);
  await page.reload(); await page.evaluate(() => MemoAppReady);
  expect((await contents(page)).planner).toEqual(['first-planner','second-planner']);
});

test('a later part storage failure leaves the complete old database and its files intact', async ({page}) => {
  await boot(page);
  await page.evaluate(() => {
    const write = MemoStateDb.writeBlob;
    MemoStateDb.writeBlob = async (path,blob) => {if(path.endsWith('second.bin'))throw new DOMException('Storage full','QuotaExceededError');return write(path,blob);};
  });
  await page.setInputFiles('#importDataInput',[await part('first',{'uploads/first.bin':Buffer.from('first-file')}),await part('second',{'uploads/second.bin':Buffer.from('second-file')})]);
  await page.click('#memoConfirmDlg .memo-confirm-ok'); await finish(page);
  await expect(page.locator('#importExportStatus')).toContainText('Import failed');
  expect(await contents(page)).toEqual(original);
  expect(await page.evaluate(async()=>({staged:!!await MemoStateDb.readBlob('uploads/first.bin'),original:await (await MemoStateDb.readBlob('uploads/original.bin')).text()}))).toEqual({staged:false,original:'original-file'});
  await page.reload(); await page.evaluate(() => MemoAppReady);
  expect(await contents(page)).toEqual(original);
});

test('failed durable promotion restores real SQLite records and the prior sync queue', async ({page}) => {
  await boot(page);
  await page.evaluate(() => {
    const flush = MemoStateDb.flush; let first=true;
    MemoStateDb.flush = async () => {if(first){first=false;throw new Error('Simulated promotion failure');}return flush();};
  });
  await page.setInputFiles('#importDataInput',await part('incoming',{'uploads/incoming.bin':Buffer.from('incoming-file')}));
  await page.click('#memoConfirmDlg .memo-confirm-ok'); await finish(page);
  expect(await contents(page)).toEqual(original);
  await page.reload(); await page.evaluate(() => MemoAppReady);
  expect(await contents(page)).toEqual(original);
  expect(await page.evaluate(()=>OperationQueue.readState('default').queue.some(o=>o.entryId==='incoming-memo'))).toBe(false);
});

test('server backup download carries the password and reports HTTP failure accurately', async ({page}) => {
  await boot(page);
  let password;
  await page.route('**/api/db/export?format=zip', route => {
    password=route.request().headers()['x-sync-password'];
    return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Backup unavailable'})});
  });
  await page.evaluate(() => { MemoAuth.setPassword('synthetic-password'); MemoContracts.setMode('server'); });
  await page.locator('#exportDataBtn').evaluate(button=>button.click());
  await expect(page.locator('#importExportStatus')).toContainText('Export failed: Backup unavailable');
  expect(password).toBe('synthetic-password');
});
