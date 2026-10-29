// Opt-in Android emulator check. Never targets a physical device or clears app data.
// Run after cap sync + assembleDebug + installing the APK on the emulator.
const { chromium, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const serial = process.env.MEMO_TEST_EMULATOR || 'emulator-5554';
if (!/^emulator-\d+$/.test(serial)) throw new Error('This check only accepts an emulator serial.');
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const app = 'com.laplacengan.memora';
const out = '.playwright/emulator-recovery';
fs.mkdirSync(out, {recursive:true});
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], {encoding:'utf8',windowsHide:true}).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const result = { serial, checks:[], timings:{}, started:new Date().toISOString() };
let browser, page, port;
async function connect() {
  const deadline = Date.now()+30000;
  let lastError;
  while (Date.now()<deadline) {
    try {
      const pid = adb('shell','pidof',app);
      if (!pid) { await pause(200); continue; }
      port = adb('forward','tcp:0','localabstract:webview_devtools_remote_'+pid);
      // Android WebView has no browser-context download management. Preserve
      // native defaults instead of sending desktop-only download overrides.
      browser = await chromium.connectOverCDP('http://127.0.0.1:'+port, {timeout:10000, noDefaults:true});
      page = browser.contexts()[0].pages()[0];
      if (!page) throw new Error('No WebView page yet');
      page.setDefaultTimeout(15000);
      await page.waitForFunction(() => !!window.MemoAppReady);
      await page.evaluate(() => MemoAppReady);
      return;
    } catch (error) { lastError = error; if (browser) try { await browser.close(); } catch (_) {} if (port) { try { adb('forward','--remove','tcp:'+port); } catch (_) {} } await pause(250); }
  }
  throw new Error('Could not attach to the emulator WebView: '+lastError?.message);
}
async function check(name, action) {
  await action(); result.checks.push(name); console.log('PASS:',name);
  fs.writeFileSync(out+'/results.json',JSON.stringify(result,null,2));
}
(async () => {
  try {
    await connect();
    result.platform = await page.evaluate(() => ({userAgent:navigator.userAgent,native:Capacitor.isNativePlatform(),viewport:[innerWidth,innerHeight],dpr:devicePixelRatio}));
    // Do not replace someone's existing recovery session in a reused emulator.
    const existing = await page.evaluate(() => MemoImageDraft.read(MEMO_VARIANT,false));
    if (existing) {
      if (!process.argv.includes('--retry') || existing.name !== 'emulator-receipt.jpg') throw new Error('An image draft already exists. Finish or discard it manually before this opt-in check.');
      // Explicit retry may clean up only this harness's synthetic image.
      await page.evaluate(async () => { window.MemoImageEditorImpl?.suspend(); await MemoImageDraft.clear(MEMO_VARIANT); });
      await expect(page.locator('#imageEditorDlg[open]')).toHaveCount(0);
    }
    if (await page.locator('#entryDlg').getAttribute('open') !== null) throw new Error('An entry draft is open; leave it intact.');
    await check('12 MP image opens and checkpoints locally', async () => {
      result.timings.openMs = await page.evaluate(async () => {
        const c = document.createElement('canvas');c.width=4000;c.height=3000;
        const ctx = c.getContext('2d');ctx.fillStyle='#eee';ctx.fillRect(0,0,4000,3000);
        ctx.fillStyle='#345';for(let y=20;y<3000;y+=70)ctx.fillRect(50,y,2000+y/3,22);
        const blob = await new Promise(resolve=>c.toBlob(resolve,'image/jpeg',.94));c.width=c.height=1;
        window.__editorBoot = MemoLifecycle.diagnostics()[0].bootId;
        const start=performance.now();await MemoImageEditor.open(new File([blob],'emulator-receipt.jpg',{type:'image/jpeg'}));return performance.now()-start;
      });
      await expect(page.locator('#mieStatus')).toContainText('4000 × 3000');
      result.preview = await page.locator('#mieCanvas').evaluate(c => ({pixels:[c.width,c.height],box:c.getBoundingClientRect().toJSON(),pixel:Array.from(c.getContext('2d').getImageData(10,10,1,1).data),image:c.parentElement.outerHTML.slice(0,400)}));
      console.log('Preview:',JSON.stringify(result.preview));
      expect(result.preview.box.width).toBeGreaterThan(100);
      expect(result.preview.box.height).toBeGreaterThan(100);
      await page.click('#mieRotateRight');
      result.timings.checkpointMs = await page.evaluate(async()=>{const start=performance.now();await MemoImageEditorImpl.checkpoint();return performance.now()-start;});
      await expect(page.locator('#mieDraftStatus')).toHaveText('Edit saved on this device');
    });
    await check('native Android Back protects the edit and Back from the prompt keeps editing', async () => {
      adb('shell','input','keyevent','KEYCODE_BACK');
      await expect(page.locator('#mieLeaveDlg')).toBeVisible();
      await page.screenshot({path:out+'/dismissal.png'});
      adb('shell','input','keyevent','KEYCODE_BACK');
      await expect(page.locator('#mieLeaveDlg')).not.toHaveAttribute('open','');
      await expect(page.locator('#imageEditorDlg')).toHaveAttribute('open','');
    });
    await check('native touch moves and resizes a square crop with German controls', async () => {
      await page.click('#mieCropTool'); await page.selectOption('#mieRatio','1');
      const crop = await page.locator('#mieCrop').boundingBox();
      const touch = async (x,y,dx,dy) => {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx,y:y+dy,id:1}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
      };
      const rect = () => page.evaluate(async()=>{await MemoImageEditorImpl.checkpoint();return (await MemoImageDraft.read(MEMO_VARIANT,false)).selection;});
      const initial = await rect();
      await touch(crop.x+crop.width/2,crop.y+crop.height/2,14,14);
      const moved = await rect();expect(moved.w).toBeCloseTo(initial.w);expect(moved.x).toBeGreaterThan(initial.x);
      const handle = await page.locator('[data-corner=se]').boundingBox();
      expect(handle.width).toBeGreaterThanOrEqual(44);expect(handle.height).toBeGreaterThanOrEqual(44);
      await touch(handle.x+32,handle.y+32,-24,-24);
      const resized = await rect();expect(resized.w).toBeLessThan(moved.w);expect(resized.w*3000/resized.h/4000).toBeCloseTo(1,5);
      await page.evaluate(()=>MemoI18n.choose('de'));
      await expect(page.locator('#mieCropTool')).toHaveText('Zuschneiden');await expect(page.locator('#mieApply')).toBeInViewport();
      await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
      fs.writeFileSync(out+'/crop-german-native.png',execFileSync(adbPath,['-s',serial,'exec-out','screencap','-p'],{windowsHide:true}));
      await page.evaluate(()=>MemoI18n.choose('en'));await page.click('#mieCancelTool');
    });
    await check('three Home/resume cycles retain the editor canvas and document', async () => {
      await page.evaluate(()=>{window.__editorCanvas=document.getElementById('mieCanvas');});
      for(let i=0;i<3;i++) {
        adb('shell','input','keyevent','KEYCODE_HOME');
        // Frames pause in the background. Poll the native lifecycle state.
        await page.waitForFunction(()=>!MemoLifecycle.isActive(),null,{polling:100});
        adb('shell','am','start','-n',app+'/.MainActivity');
        await page.waitForFunction(()=>MemoLifecycle.isActive(),null,{polling:100});
        expect(await page.evaluate(()=>document.getElementById('mieCanvas')===window.__editorCanvas && MemoLifecycle.diagnostics()[0].bootId===window.__editorBoot)).toBe(true);
        await expect(page.locator('#mieStatus')).toContainText('3000 × 4000');
      }
    });
    await check('unapplied adjustment survives force-stop and a new WebView process', async () => {
      await page.click('#mieAdjustTool');
      await page.locator('#mieBrightness').focus();await page.keyboard.press('ArrowRight');
      await page.evaluate(()=>MemoImageEditorImpl.checkpoint());
      const oldBoot=await page.evaluate(()=>MemoLifecycle.diagnostics()[0].bootId);
      adb('shell','am','force-stop',app);
      try { await browser.close(); } catch (_) {}
      try { adb('forward','--remove','tcp:'+port); } catch (_) {}
      adb('shell','am','start','-n',app+'/.MainActivity');await connect();
      expect(await page.evaluate(()=>MemoLifecycle.diagnostics()[0].bootId)).not.toBe(oldBoot);
      await page.evaluate(()=>MemoImageEditor.open());await expect(page.locator('#mieRecovery')).toBeVisible();
      const start=Date.now();await page.click('#mieResume');await expect(page.locator('#mieDraftStatus')).toHaveText('Saved edit restored');result.timings.restoreMs=Date.now()-start;
      await expect(page.locator('#mieBrightness')).toHaveValue('1');
      await expect(page.locator('#mieStatus')).toContainText('3000 × 4000');
      await page.screenshot({path:out+'/recovered.png'});
      fs.writeFileSync(out+'/recovered-native.png',execFileSync(adbPath,['-s',serial,'exec-out','screencap','-p'],{windowsHide:true}));
    });
    await check('12 MP adjustments remain interactive', async () => {
      result.timings.adjustmentFramesMs = await page.evaluate(async()=>{
        const samples=[], input=document.getElementById('mieBrightness');
        for(let i=0;i<12;i++) { const start=performance.now();input.value=String(i+2);input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));samples.push(performance.now()-start); }
        await MemoImageEditorImpl.checkpoint();return samples;
      });
      await page.click('#mieApply');
    });
    await check('12 MP native gallery export completes before recovery is cleared', async () => {
      const start=Date.now();
      await page.click('#mieDownload');
      await expect(page.locator('#mieStatus')).toHaveText('Copy saved to device. Original kept.',{timeout:30000});
      result.timings.exportMs=Date.now()-start;
      result.gallery=adb('shell','ls','-l','/sdcard/Pictures/Memora');
      expect(result.gallery).toContain('emulator-receipt-edited.jpg');
      expect(await page.evaluate(()=>MemoImageDraft.read(MEMO_VARIANT,false))).toBeNull();
      // A later edit must start checkpointing again after the saved copy.
      await page.click('#mieFlipH');
      await page.evaluate(()=>MemoImageEditorImpl.checkpoint());
    });
    await check('Keep draft closes, reopens, and Discard removes recovery', async () => {
      await page.click('#mieClose');await page.click('#mieKeepDraft');await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
      await page.evaluate(()=>MemoImageEditor.open());await page.click('#mieResume');await expect(page.locator('#mieDraftStatus')).toHaveText('Saved edit restored');
      await page.click('#mieClose');await page.click('#mieDiscard');await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
      expect(await page.evaluate(()=>MemoImageDraft.read(MEMO_VARIANT,false))).toBeNull();
    });
    await check('unreachable personal server keeps local status and translated sync details usable', async () => {
      const original = await page.evaluate(()=>({base:MemoRuntime.getApiBase(),mode:MemoRuntime.getMode(),pref:MemoI18n.readPref()}));
      try {
        await page.evaluate(async()=>{await OperationQueue._flight;MemoRuntime.setApiBase('http://127.0.0.1:9');await OperationQueue.manualSync();MemoSyncStatus.open();});
        await expect(page.locator('#syncServerState')).toHaveText('Server unavailable');
        await expect(page.locator('#syncLocalState')).toHaveText('Saved on this device');
        await expect(page.locator('#syncRetry')).toBeEnabled();
        await page.evaluate(()=>MemoI18n.choose('zh'));await expect(page.locator('#syncServerState')).toHaveText('服务器不可用');
        await expect(page.locator('#syncRetry')).toBeInViewport();
        await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
        fs.writeFileSync(out+'/sync-chinese-native.png',execFileSync(adbPath,['-s',serial,'exec-out','screencap','-p'],{windowsHide:true}));
        adb('shell','input','keyevent','KEYCODE_BACK');await expect(page.locator('#syncStatusDlg')).not.toHaveAttribute('open','');
      } finally {
        await page.evaluate(value=>{MemoRuntime.setApiBase(value.base);MemoRuntime.setMode(value.mode);MemoI18n.choose(value.pref?.useSystem===false?value.pref.locale:'system');MemoSyncStatus.refresh();},original);
      }
    });
    result.lifecycle = await page.evaluate(()=>MemoLifecycle.diagnostics());
    result.completed=new Date().toISOString();
    fs.writeFileSync(out+'/results.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result.timings,null,2));
  } catch(error) {
    result.error=error.stack;fs.writeFileSync(out+'/results.json',JSON.stringify(result,null,2));
    if(page)try{await page.screenshot({path:out+'/failure.png'});}catch(_){}
    console.error(error);process.exitCode=1;
  } finally {
    if(browser)try{await browser.close();}catch(_){}
    if(port)try{adb('forward','--remove','tcp:'+port);}catch(_){}
  }
})();
