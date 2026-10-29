const { test, expect } = require('@playwright/test');

async function boot(page, path = 'index.html') {
  await page.goto('/' + path);
  await page.evaluate(() => window.MemoAppReady || window.Planner?.ready);
}
async function source(page) {
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 80;
    const ctx = c.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0,0,80,80); ctx.fillStyle = 'blue'; ctx.fillRect(80,0,80,80);
    const blob = await new Promise(resolve => c.toBlob(resolve));
    await MemoImageEditor.open(new File([blob], 'recovery.png', {type:'image/png'}));
  });
  await expect(page.locator('#mieStatus')).toContainText('160 × 80');
}
async function checkpoint(page) {
  await page.evaluate(() => MemoImageEditorImpl.checkpoint());
  return page.evaluate(() => MemoImageDraft.read(window.MEMO_VARIANT || 'default', false));
}
async function resume(page) {
  await page.evaluate(() => MemoImageEditor.open());
  await expect(page.locator('#mieRecovery')).toBeVisible();
  await page.click('#mieResume');
  await expect(page.locator('#mieDraftStatus')).toHaveText('Saved edit restored');
}

test('reload restores the original bytes, undo history, and unapplied adjustments', async ({page}) => {
  await boot(page); await source(page);
  await page.click('#mieRotateRight'); await page.click('#mieFlipV'); await page.click('#mieUndo');
  await page.click('#mieAdjustTool'); await page.locator('#mieBrightness').focus(); await page.keyboard.press('ArrowRight');
  const before = await checkpoint(page);
  const original = await page.evaluate(async () => Array.from(new Uint8Array(await (await MemoImageDraft.read('default')).blob.arrayBuffer())));
  await page.reload(); await page.evaluate(() => MemoAppReady); await resume(page);
  await expect(page.locator('#mieBrightness')).toHaveValue('1');
  await expect.poll(() => page.locator('#mieCanvas').evaluate(c => [c.width,c.height])).toEqual([80,160]);
  expect(await page.evaluate(async () => Array.from(new Uint8Array(await (await MemoImageDraft.read('default')).blob.arrayBuffer())))).toEqual(original);
  expect((await checkpoint(page)).id).toBe(before.id);
  await page.click('#mieCancelTool'); await expect(page.locator('#mieRedo')).toBeEnabled();
  await page.click('#mieRedo'); await expect(page.locator('#mieRedo')).toBeDisabled();
});

test('Keep draft closes safely and restores an unapplied crop and ratio', async ({page}) => {
  await boot(page); await source(page); await page.click('#mieCropTool');
  await page.selectOption('#mieRatio','1'); await page.locator('#mieCrop').focus(); await page.keyboard.press('ArrowRight');
  const saved = await checkpoint(page);
  await page.click('#mieClose'); await page.click('#mieKeepDraft');
  await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
  await resume(page);
  await expect(page.locator('#mieRatio')).toHaveValue('1');
  expect((await checkpoint(page)).selection).toEqual(saved.selection);
  await page.click('#mieApply');
  await expect.poll(() => page.locator('#mieCanvas').evaluate(c => [c.width,c.height])).toEqual([80,80]);
});

test('Escape, Android Back and close guard the same edit; dismissing the prompt keeps editing', async ({page}) => {
  await boot(page); await source(page); await page.click('#mieRotateRight');
  for (const action of ['escape','back','close']) {
    if (action === 'escape') await page.keyboard.press('Escape');
    else if (action === 'back') await page.evaluate(() => MemoShell.handleSystemBack());
    else await page.click('#mieClose');
    await expect(page.locator('#mieLeaveDlg')).toBeVisible();
    await expect(page.locator('#mieKeepEditing')).toBeFocused();
    await page.evaluate(() => MemoShell.handleSystemBack());
    await expect(page.locator('#mieLeaveDlg')).not.toHaveAttribute('open','');
    await expect(page.locator('#imageEditorDlg')).toHaveAttribute('open','');
  }
  await page.click('#mieClose'); await page.click('#mieDiscard');
  await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
  expect(await page.evaluate(() => MemoImageDraft.read('default'))).toBeNull();
  await page.reload(); await page.evaluate(() => MemoAppReady); await page.evaluate(() => MemoImageEditor.open());
  await expect(page.locator('#mieEmpty')).toBeVisible();
});

test('a checkpoint failure keeps the current edit open and retains the prior checkpoint', async ({page}) => {
  await boot(page); await source(page); await page.click('#mieRotateRight');
  const saved = await checkpoint(page);
  await page.evaluate(() => { window.__saveImageDraft = MemoImageDraft.save; MemoImageDraft.save = async () => { throw new Error('Disk full'); }; });
  await page.click('#mieFlipV'); await expect(page.locator('#mieDraftStatus')).toContainText('Could not save');
  await page.click('#mieClose'); await page.click('#mieKeepDraft');
  await expect(page.locator('#mieLeaveStatus')).toContainText('Could not update');
  await expect(page.locator('#imageEditorDlg')).toHaveAttribute('open','');
  expect((await page.evaluate(() => MemoImageDraft.read('default', false))).ops).toEqual(saved.ops);
  await page.click('#mieKeepEditing'); await page.evaluate(() => { MemoImageDraft.save = window.__saveImageDraft; });
  expect((await checkpoint(page)).ops).toHaveLength(2);
});

test('privacy lock hides both dialogs and keeps the recipe for later recovery', async ({page}) => {
  await boot(page); await source(page); await page.click('#mieCropTool'); await checkpoint(page);
  await page.click('#mieClose');
  await page.evaluate(() => document.dispatchEvent(new Event('memo:privacy-locked')));
  await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
  await expect(page.locator('#mieLeaveDlg')).not.toHaveAttribute('open','');
  await resume(page); await expect(page.locator('#mieCrop')).toBeVisible();
});

test('a saved source is not revealed when the original entry is deleted or inaccessible', async ({page}) => {
  await boot(page); await source(page);
  await page.evaluate(async () => {
    await MemoImageEditorImpl.suspend();
  });
  await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width=100;c.height=50;
    const path='uploads/recovery-private.png'; await MemoStateDb.writeBlob(path,await new Promise(resolve=>c.toBlob(resolve)));
    const entry={id:'protected-source',description:'Private source',images:['/'+path],_storedPaths:[path],category:'Uncategorized',tags:[],ts:Date.now()};
    MemoCore.getState().db.entries=[entry]; await MemoImageEditor.openEntry(entry);
  });
  await page.click('#mieRotateRight'); await checkpoint(page);
  await page.evaluate(() => { MemoImageEditorImpl.suspend(); MemoCore.getState().db.entries[0].deletedAt=Date.now(); });
  await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
  await page.evaluate(() => MemoImageEditor.open()); await page.click('#mieResume');
  await expect(page.locator('#mieStatus')).toContainText('no longer available');
  await expect(page.locator('#mieImage')).toBeHidden();
  expect(await page.evaluate(() => !!MemoImageDraft)).toBe(true);
  expect(await page.evaluate(async () => !!await MemoImageDraft.read('default',false))).toBe(true);
});

test('standalone Planner recovers a device image without loading the Memo entry editor', async ({page}) => {
  await boot(page,'planner.html'); await source(page); await page.click('#mieFlipH'); await checkpoint(page);
  await page.reload(); await resume(page);
  expect(await page.evaluate(() => !!window.MemoCore)).toBe(false);
  await expect(page.locator('#mieSave')).toBeHidden();
  await expect(page.locator('#mieDownload')).toBeEnabled();
});

test('a durable copy handoff clears image recovery only after the entry draft saves', async ({page}) => {
  await boot(page); await source(page); await page.click('#mieRotateRight'); await checkpoint(page);
  await page.click('#mieSave'); await expect(page.locator('#entryDlg')).toHaveAttribute('open','');
  await expect.poll(() => page.evaluate(() => MemoImageDraft.read('default',false))).toBeNull();
  await page.reload(); await page.evaluate(() => MemoAppReady);
  await expect(page.locator('#entryDlg')).toHaveAttribute('open','');
  await expect(page.locator('#dragGrid .dragitem')).toHaveCount(1);
});

test('a failed entry-draft handoff retains the recoverable image edit', async ({page}) => {
  await boot(page); await source(page); await page.click('#mieRotateRight');
  const saved = await checkpoint(page);
  await page.evaluate(() => { MemoDraft.saveChecked = async () => { throw new Error('Entry draft write failed'); }; });
  await page.click('#mieSave');
  await expect(page.locator('#memoToast')).toContainText('Entry draft write failed');
  expect((await page.evaluate(() => MemoImageDraft.read('default',false))).id).toBe(saved.id);
});

test('privacy locking during Discard cannot resurrect the discarded checkpoint', async ({page}) => {
  await boot(page); await source(page); await page.click('#mieRotateRight'); await checkpoint(page);
  await page.evaluate(() => {
    const clear = MemoImageDraft.clear;
    MemoImageDraft.clear = async (...args) => {
      await clear(...args); window.__discardCommitted = true;
      await new Promise(resolve => { window.__finishDiscard = resolve; });
    };
  });
  await page.click('#mieClose'); await page.click('#mieDiscard');
  await page.waitForFunction(() => window.__discardCommitted);
  await page.evaluate(() => { document.dispatchEvent(new Event('memo:privacy-locked')); window.__finishDiscard(); });
  await expect(page.locator('#imageEditorDlg')).not.toHaveAttribute('open','');
  expect(await page.evaluate(() => MemoImageDraft.read('default',false))).toBeNull();
});
