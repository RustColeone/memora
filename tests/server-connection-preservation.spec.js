const {test,expect}=require('@playwright/test');
for(const screen of ['index','finance']) {
  test(`${screen}: connecting in Settings keeps the local database while syncing`,async({page})=>{
    await page.goto('/'+screen+'.html');await page.waitForFunction(()=>window.MemoStateDb?.ready()&&window.MemoRuntime);
    await page.evaluate(async()=>{
      MemoStateDb.saveEntries([{id:'pending-memo',description:'Keep this pending memo',ts:1}],'default');
      MemoStateDb.saveDocs('planner',[{id:'pending-task',kind:'todo',title:'Keep this task'}]);
      await MemoStateDb.flush();
      window.__oldMode=MemoRuntime.getMode();window.__connectCalls=[];
      MemoRuntime.getServerAPI().list=async()=>{__connectCalls.push('list');return [];};
      SyncManager.init=async()=>{__connectCalls.push('init');};
      OperationQueue.manualSync=async()=>{__connectCalls.push('sync');return {status:'success'};};
      document.getElementById('settingsDlg').showModal();
      document.getElementById('serverUrlInput').closest('.settings-section').classList.remove('collapsed');
    });
    await page.fill('#serverUrlInput','https://synthetic.example');
    await page.locator('#saveServerUrl').click();
    await expect(page.locator('#serverUrlStatus')).toContainText('Connected!');
    expect(await page.evaluate(()=>({mode:MemoRuntime.getMode()===__oldMode,calls:__connectCalls,memos:MemoStateDb.loadEntries('default').map(e=>e.id),planner:MemoStateDb.loadDocs('planner').map(e=>e.id)}))).toEqual({mode:true,calls:['init','sync'],memos:['pending-memo'],planner:['pending-task']});
  });
}
