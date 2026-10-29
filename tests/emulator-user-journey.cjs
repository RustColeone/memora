// Opt-in, touch-driven QA on a separate emulator app. Never clears real app data.
// npm run cap:sync; gradlew -p android -PmemoraQa :app:assembleDebug
// adb -s emulator-5554 install -r android/app/build/outputs/apk/debug/app-debug.apk
// node tests/emulator-user-journey.cjs [--resume]
// Server steps require an isolated host server on port 5073, with
// MEMO_SYNC_PASSWORD=emulator-qa-password and separate MEMO_DATA_DIR/UPLOAD_DIR.
const { chromium, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const serial = process.env.MEMO_TEST_EMULATOR || 'emulator-5554';
if (!/^emulator-\d+$/.test(serial)) throw new Error('Only emulator serials are accepted');
const app = 'com.laplacengan.memora.qa';
const component = app+'/com.laplacengan.memora.MainActivity';
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const out = path.resolve('.playwright/emulator-user-journey');
fs.mkdirSync(out, {recursive:true});
const adb = (...args) => execFileSync(adbPath,['-s',serial,...args],{encoding:'utf8',windowsHide:true}).trim();
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const reportFile = path.join(out,'results.json');
const report = process.argv.includes('--resume') && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile)) : {serial,app,started:new Date().toISOString(),checks:[],errors:[]};
const record = () => fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
let browser, page, port;

async function connect() {
  for (let i=0;i<40;i++) {
    try {
      const pid = adb('shell','pidof',app);
      port = adb('forward','tcp:0','localabstract:webview_devtools_remote_'+pid);
      browser = await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true,timeout:5000});
      page = browser.contexts()[0].pages()[0];
      page.setDefaultTimeout(20000);
      await page.waitForFunction(()=>!!window.MemoAppReady);
      await page.evaluate(()=>MemoAppReady);
      page.on('pageerror',error=>{report.errors.push(error.message);record();});
      return;
    } catch(error) {
      if(browser)await browser.close().catch(()=>{});
      if(port)try{adb('forward','--remove','tcp:'+port);}catch(_){}
      if(i===39)throw error;
      await delay(250);
    }
  }
}
async function touch(selector) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded(); await expect(el).toBeVisible();
  const b=await el.boundingBox();
  const cdp=await page.context().newCDPSession(page);
  const point={x:b.x+b.width/2,y:b.y+b.height/2,id:1};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await cdp.detach();
}
async function shot(name) {
  await page.screenshot({path:path.join(out,name+'.png')});
  fs.writeFileSync(path.join(out,name+'-native.png'),execFileSync(adbPath,['-s',serial,'exec-out','screencap','-p'],{windowsHide:true}));
}
async function check(name, action) {
  if(report.checks.includes(name))return;
  console.log('CHECK:',name);
  await action();report.checks.push(name);record();console.log('PASS:',name);
}
async function navigate(variant) {
  await touch('#primaryNav [data-variant="'+variant+'"]');
  await page.waitForFunction(v=>window.MEMO_VARIANT===v,variant);
  await page.evaluate(()=>MemoAppReady);
}
async function settings() {
  if(!await page.locator('#settingsDlg[open]').count()) {
    await touch('#hamburgerBtn'); await touch('#mobileSettingsBtn');
  }
  await expect(page.locator('#settingsDlg')).toBeVisible();
  const section=page.locator('.settings-section').filter({has:page.locator('#exportDataBtn')});
  if(await section.evaluate(el=>el.classList.contains('collapsed')))await touch('.settings-section:has(#exportDataBtn) h3');
}
async function nodes() {
  for(let attempt=0;attempt<5;attempt++) {
    const dump=adb('shell','uiautomator','dump','--compressed','/sdcard/memora-qa-window.xml');
    if(dump.includes('dumped')) {
      const xml=adb('shell','cat','/sdcard/memora-qa-window.xml');
      return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));
    }
    await delay(500);
  }
  throw new Error('Android accessibility root did not become available');
}
function nativeTap(node,long=false) {
  if(!node)throw new Error('Native picker control was not found');
  const [x,y,w,h]=node.bounds.match(/\d+/g).map(Number);const px=Math.round((x+w)/2),py=Math.round((y+h)/2);
  if(long)adb('shell','input','swipe',String(px),String(py),String(px),String(py),'650');
  else adb('shell','input','tap',String(px),String(py));
}
async function pick(names) {
  await delay(750);
  let list=await nodes();
  console.log('Picker:',list.filter(n=>n.text||n['content-desc']).map(n=>({text:n.text,desc:n['content-desc']})));
  // Android's dedicated photo picker exposes thumbnails by date, not filename.
  if(names.length===1 && list.some(n=>/Photo taken on/.test(n['content-desc']))) {
    nativeTap(list.find(n=>/Photo taken on/.test(n['content-desc'])));
    list=await nodes();const add=list.find(n=>/^(Add|Open|Select)$/i.test(n.text));if(add)nativeTap(add);
    await delay(400);return;
  }
  // Open the actual Android DocumentsUI drawer and select Downloads.
  const drawer=list.find(n=>/Show roots|Open navigation drawer/i.test(n['content-desc']));
  if(drawer){nativeTap(drawer);await delay(200);list=await nodes();}
  const downloads=list.find(n=>n.text==='Downloads');
  if(downloads){nativeTap(downloads);await delay(350);}
  if(names.length>1) {
    list=await nodes();
    const menu=list.find(n=>n['content-desc']==='More options');
    nativeTap(menu);list=await nodes();
    nativeTap(list.find(n=>n.text==='Select all'));list=await nodes();
    if(!list.some(n=>n.text===names.length+' selected'))throw new Error('Unexpected native picker selection count');
    nativeTap(list.find(n=>/^(SELECT|Select)$/i.test(n.text)));
    await delay(400);return;
  }
  for(let i=0;i<names.length;i++) {
    list=await nodes();const node=list.find(n=>n.text===names[i]);
    if(!node){fs.writeFileSync(path.join(out,'picker-missing.xml'),adb('shell','cat','/sdcard/memora-qa-window.xml'));throw new Error('Picker cannot find '+names[i]);}
    nativeTap(node,names.length>1&&i===0);await delay(200);
  }
  list=await nodes();const open=list.find(n=>/^(OPEN|Open|SELECT|Select|Add)$/i.test(n.text));
  if(open)nativeTap(open);
  await delay(400);
}
async function counts() {
  return page.evaluate(()=>({memos:MemoStateDb.loadEntries('default').length,finance:MemoStateDb.loadEntries('finance').length,planner:MemoStateDb.loadDocs('planner').length}));
}
const server = 'http://127.0.0.1:5073';
const serverRequest = async path => {
  const response=await fetch(server+path,{headers:{'X-Sync-Password':'emulator-qa-password'}});
  if(!response.ok)throw new Error('QA server returned '+response.status);
  return response;
};
async function tools() {
  await touch('#hamburgerBtn');await touch('#mobileAdvancedToolsBtn');await touch('#advancedImageEditorBtn');
  await expect(page.locator('#imageEditorDlg')).toBeVisible();
}

(async()=>{
  try {
    adb('shell','am','start','-n',component);await connect();
    report.platform=await page.evaluate(()=>({native:Capacitor.isNativePlatform(),viewport:[innerWidth,innerHeight],userAgent:navigator.userAgent}));record();
    await check('Memo with a photo selected through the Android file picker',async()=>{
      await navigate('default');
      if(!await page.locator('#entryDlg[open]').count())await touch('#addCard');
      await page.fill('#desc','QA travel note: bring the camera and buy coffee.');
      const png=path.join(out,'Memora-QA-receipt.png');
      await sharp(Buffer.from('<svg width="800" height="1000" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="1000" fill="#eee"/><text x="80" y="150" font-size="50">QA COFFEE RECEIPT</text><text x="80" y="250" font-size="40">Coffee 2 x 3.50</text><text x="80" y="350" font-size="40">TOTAL 7.00</text></svg>')).png().toFile(png);
      adb('push',png,'/sdcard/Download/Memora-QA-receipt.png');
      await touch('#dropzone');await pick(['Memora-QA-receipt.png']);
      await expect(page.locator('#dragGrid img')).toHaveCount(1);
      await touch('#saveBtn');
      await expect(page.locator('#entryDlg')).not.toHaveAttribute('open','');
      await expect(page.locator('#feed')).toContainText('QA travel note');
      await shot('memo-created');
    });
    await check('Finance purchase with two items and tax',async()=>{
      await navigate('finance');await touch('#fab');await page.fill('#desc','QA coffee and groceries');
      const buttons=await page.locator('#entryDlg button').evaluateAll(bs=>bs.map(b=>({id:b.id,text:b.innerText})));
      console.log('Finance buttons:',buttons);
      await touch('#addItemBtn');await page.fill('#itemEdName','Coffee');await page.fill('#itemEdQty','2');await page.fill('#itemEdUnit','3.50');await touch('#itemEdCommit');
      await touch('#addItemBtn');await page.fill('#itemEdName','Groceries');await page.fill('#itemEdQty','1');await page.fill('#itemEdUnit','20');await touch('#itemEdCommit');
      await page.fill('#tax','10%');await page.locator('#tax').blur();
      expect(Number(await page.inputValue('#total'))).toBeCloseTo(29.7);
      await touch('#saveBtn');await expect(page.locator('#feed')).toContainText('QA coffee and groceries');await shot('finance-created');
    });
    await check('Planner task, completion, and calendar event',async()=>{
      await navigate('planner');await page.fill('#todoInput','QA pack the camera');await touch('#todoAddBtn');
      const todo=page.locator('.todo-item').filter({hasText:'QA pack the camera'});
      await expect(todo).toBeVisible();await touch('.todo-item:has-text("QA pack the camera") .todo-check');await expect(todo).toHaveClass(/done/);
      await touch('.todo-item:has-text("QA pack the camera") .todo-check');
      await touch('#calAddBtn');await page.fill('#evTitle','QA home sync evening');await page.fill('#evDesc','Synthetic emulator event');
      await touch('#evSaveBtn');await expect(page.locator('#eventDlg')).not.toHaveAttribute('open','');
      await page.waitForFunction(()=>MemoStateDb.loadDocs('planner').some(e=>e.title==='QA home sync evening'));
      await shot('planner-created');
    });
    await check('Three background/resume cycles preserve the rendered memo nodes',async()=>{
      await navigate('default');await expect(page.locator('#feed')).toContainText('QA travel note');
      await page.evaluate(()=>{window.__qaFeed=document.getElementById('feed');window.__qaCards=[...__qaFeed.children];window.__qaBoot=MemoLifecycle.diagnostics()[0].bootId;window.__qaMutations=[];window.__qaObserver=new MutationObserver(rs=>{for(const r of rs)if(r.removedNodes.length)__qaMutations.push(r.removedNodes.length);});__qaObserver.observe(__qaFeed,{childList:true});});
      for(let i=0;i<3;i++){adb('shell','input','keyevent','KEYCODE_HOME');await delay(1200);adb('shell','am','start','-n',component);await expect(page.locator('#feed')).toContainText('QA travel note');await delay(1200);}
      const retained=await page.evaluate(()=>({boot:__qaBoot===MemoLifecycle.diagnostics()[0].bootId,feed:__qaFeed===document.getElementById('feed'),cards:__qaCards.every(n=>n.isConnected),removed:__qaMutations}));
      expect(retained).toEqual({boot:true,feed:true,cards:true,removed:[]});report.resume=retained;await shot('memo-resumed');
    });
    await check('Cold restart preserves every section and the offline photo',async()=>{
      const before=await counts();adb('shell','am','force-stop',app);await browser.close().catch(()=>{});try{adb('forward','--remove','tcp:'+port);}catch(_){}
      adb('shell','am','start','-n',component);await connect();expect(await counts()).toEqual(before);
      const photo=await page.evaluate(async()=>{const e=MemoStateDb.loadEntries('default').find(e=>e.description.includes('QA travel note'));const rel=(e._storedPaths||e.images)[0].replace(/^\//,'');const b=await MemoStateDb.readBlob(rel);return {size:b?.size,rel};});
      expect(photo.size).toBeGreaterThan(100);report.photo=photo;report.counts=before;record();
    });
    await check('Native full backup writes all three sections and its manifest',async()=>{
      await settings();await expect(page.locator('label[for="importDataInput"]')).toBeVisible();
      await touch('#exportDataBtn');await expect(page.locator('#importExportStatus')).toContainText('Export complete',{timeout:60000});
      const files=adb('shell','ls','/sdcard/Documents').split(/\r?\n/).filter(n=>n.startsWith('memoSystem-backup-')&&n.endsWith('.zip'));
      if(files.length<2)throw new Error('Expected backup data part and manifest in Documents');
      report.backupFiles=files;for(const file of files){adb('pull','/sdcard/Documents/'+file,path.join(out,file));adb('shell','cp','/sdcard/Documents/'+file,'/sdcard/Download/'+file);}
      await shot('native-backup');
    });
    await check('Native picker plus Android Back cancels restore without changes',async()=>{
      await settings();const before=await counts();await touch('label[for="importDataInput"]');await pick(report.backupFiles);
      await expect(page.locator('#memoConfirmDlg')).toBeVisible();await shot('restore-choice');
      adb('shell','input','keyevent','KEYCODE_BACK');await expect(page.locator('#importExportStatus')).toContainText('Restore cancelled');expect(await counts()).toEqual(before);
    });
    await check('Native picker Merge and Replace restore all sections and photo bytes',async()=>{
      for(const action of ['secondary','ok']){
        await settings();await touch('label[for="importDataInput"]');await pick(report.backupFiles);
        await touch('#memoConfirmDlg .memo-confirm-'+action);await expect(page.locator('#importExportStatus')).toContainText('Import complete',{timeout:60000});
        expect(await counts()).toEqual(report.counts);
        expect(await page.evaluate(async rel=>(await MemoStateDb.readBlob(rel))?.size,report.photo.rel)).toEqual(report.photo.size);
      }
      await shot('restore-complete');
    });
    await check('Image Editor protects an edit, recovers it after restart, and saves a copy',async()=>{
      if(await page.locator('#settingsDlg[open]').count())adb('shell','input','keyevent','KEYCODE_BACK');
      await navigate('default');await tools();await touch('#mieDevice');await pick(['Memora-QA-receipt.png']);
      await expect(page.locator('#mieStatus')).toContainText('800 × 1000');await touch('#mieRotateRight');
      await expect(page.locator('#mieDraftStatus')).toHaveText('Edit saved on this device',{timeout:20000});
      adb('shell','input','keyevent','KEYCODE_BACK');await expect(page.locator('#mieLeaveDlg')).toBeVisible();
      adb('shell','input','keyevent','KEYCODE_BACK');await expect(page.locator('#imageEditorDlg')).toBeVisible();
      await touch('#mieClose');await touch('#mieKeepDraft');await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
      adb('shell','am','force-stop',app);await browser.close().catch(()=>{});try{adb('forward','--remove','tcp:'+port);}catch(_){}
      adb('shell','am','start','-n',component);await connect();await tools();await touch('#mieResume');
      await expect(page.locator('#mieStatus')).toContainText('1000 × 800');await touch('#mieUndo');await touch('#mieRedo');await shot('image-edit-recovered');
      await touch('#mieSave');await expect(page.locator('#entryDlg')).toBeVisible();await page.fill('#desc','QA edited receipt copy');await touch('#saveBtn');
      await expect(page.locator('#feed')).toContainText('QA edited receipt copy');
      expect(await page.evaluate(async rel=>(await MemoStateDb.readBlob(rel))?.size,report.photo.rel)).toEqual(report.photo.size);
      report.syncedCounts=await counts();await shot('edited-copy-saved');
    });
    await check('Settings connects to a password-protected server without hiding local records',async()=>{
      await settings();
      const section=page.locator('#serverSyncSection');
      if(await section.evaluate(el=>el.classList.contains('collapsed')))await touch('#serverSyncSection h3');
      await page.fill('#syncPasswordInput','emulator-qa-password');await touch('#saveSyncPassword');
      await page.fill('#serverUrlInput','http://10.0.2.2:5073');
      page.once('dialog',dialog=>dialog.accept());await touch('#saveServerUrl');
      // Android WebChromeClient may own the HTTP disclosure as a native dialog.
      await delay(500);const dialogNodes=await nodes();const ok=dialogNodes.find(n=>/^(OK|Continue)$/i.test(n.text));if(ok)nativeTap(ok);
      await expect(page.locator('#serverUrlStatus')).toContainText('Connected!',{timeout:60000});
      expect(await counts()).toEqual(report.syncedCounts);
      for(const [variant,key] of [['default','memos'],['finance','finance'],['planner','planner']]) {
        const records=await (await serverRequest('/api/memos?variant='+variant)).json();expect(records.filter(e=>!e.deletedAt).length).toBe(report.syncedCounts[key]);
      }
      expect(await page.evaluate(()=>MemoRuntime.getMode())).toBe('capacitor');await shot('server-connected');
    });
    await check('Restored and edited image bytes reach the server and survive offline navigation',async()=>{
      const records=await (await serverRequest('/api/memos?variant=default')).json();
      for(const entry of records.filter(e=>!e.deletedAt)) {
        expect(entry.images.length).toBeGreaterThan(0);
        const image=await (await serverRequest(entry.images[0])).arrayBuffer();expect(image.byteLength).toBeGreaterThan(100);
      }
      if(await page.locator('#settingsDlg[open]').count())adb('shell','input','keyevent','KEYCODE_BACK');
      await navigate('finance');await expect(page.locator('#feed')).toContainText('QA coffee and groceries');
      await navigate('planner');await expect(page.locator('#todoList')).toContainText('QA pack the camera');
      await navigate('default');await expect(page.locator('#feed')).toContainText('QA travel note');
      await settings();const section=page.locator('#serverSyncSection');if(await section.evaluate(el=>el.classList.contains('collapsed')))await touch('#serverSyncSection h3');
      await touch('#clearServerUrl');adb('shell','input','keyevent','KEYCODE_BACK');
      expect(await counts()).toEqual(report.syncedCounts);await shot('offline-after-sync');
    });
    delete report.failure;report.completed=new Date().toISOString();record();console.log(JSON.stringify(report,null,2));
  }catch(error){report.failure=error.stack;record();if(page)await shot('failure').catch(()=>{});console.error(error);process.exitCode=1;}
  finally{if(browser)await browser.close().catch(()=>{});if(port)try{adb('forward','--remove','tcp:'+port);}catch(_){}}
})();
