// The Image Editor's ImageDB tools: six dials and looks, tone curves over a
// histogram, and Steps (look at an earlier step, remove one, edit on from it).
const { test, expect } = require('@playwright/test');

async function boot(page, size) {
  if (size) await page.setViewportSize(size);
  await page.goto('/index.html');
  await page.evaluate(() => window.MemoAppReady);
}
// A grey ramp on the left, solid mid-grey on the right.
async function source(page) {
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 100;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 100; x++) { const v = Math.round(x * 2.55); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, 0, 1, 100); }
    ctx.fillStyle = 'rgb(128,128,128)'; ctx.fillRect(100, 0, 100, 100);
    const blob = await new Promise((r) => c.toBlob(r));
    await MemoImageEditor.open(new File([blob], 'ramp.png', { type: 'image/png' }));
  });
  await expect(page.locator('#mieStatus')).toContainText('200 × 100');
}
// The preview pixel in the middle of the right half (the mid-grey block).
const greyPixel = (page) => page.evaluate(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.getElementById('mieCanvas');
  const d = c.getContext('2d').getImageData(Math.round(c.width * 0.75), Math.round(c.height / 2), 1, 1).data;
  return [d[0], d[1], d[2]];
});
async function dragOnPad(page, from, to) {
  const box = await page.locator('#mieCurvePad').boundingBox();
  const at = (p) => [box.x + p[0] * box.width, box.y + (1 - p[1]) * box.height];
  await page.mouse.move(...at(from)); await page.mouse.down();
  await page.mouse.move(...at(to), { steps: 6 }); await page.mouse.up();
}

test('Adjust has six dials and looks; a look sets the dials and can be taken off again', async ({ page }) => {
  await boot(page); await source(page);
  await page.click('#mieAdjustTool');
  for (const id of ['Brightness', 'Contrast', 'Saturation', 'Warmth', 'Hue', 'Blur']) await expect(page.locator('#mie' + id)).toBeVisible();
  await expect(page.locator('#mieHue')).toHaveAttribute('min', '-180');
  await expect(page.locator('#mieBlur')).toHaveAttribute('min', '0');
  await page.locator('#mieLooks .mie-look[data-preset="Warm"]').click();
  await expect(page.locator('#mieLooks .mie-look[data-preset="Warm"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mieWarmth')).toHaveValue('35');
  await expect(page.locator('#mieWarmthValue')).toHaveText('+35%');
  const warm = await greyPixel(page);
  expect(warm[0]).toBeGreaterThan(warm[2] + 8);                 // grey turned warm
  // Hand-tuning a dial leaves the look.
  await page.locator('#mieHue').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#mieLooks .mie-look[data-preset="Warm"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#mieHueValue')).toHaveText('+1°');
  // Mono, then tap Mono again to take it off.
  await page.locator('#mieLooks .mie-look[data-preset="Mono"]').click();
  await expect(page.locator('#mieSaturation')).toHaveValue('-100');
  await page.locator('#mieLooks .mie-look[data-preset="Mono"]').click();
  await expect(page.locator('#mieSaturation')).toHaveValue('0');
  await page.locator('#mieLooks .mie-look[data-preset="Mono"]').click();
  await page.click('#mieApply');
  const mono = await greyPixel(page);
  expect(Math.abs(mono[0] - mono[2])).toBeLessThanOrEqual(2);
  await expect(page.locator('#mieStepCount')).toHaveText('1');
});

test('Curves: lifting the middle brightens; each channel has its own curve; Reset clears all four', async ({ page }) => {
  await boot(page); await source(page);
  const before = await greyPixel(page);
  await page.click('#mieCurvesTool');
  await expect(page.locator('#mieCurvesControls')).toBeVisible();
  await expect(page.locator('.mie-ch[data-channel="rgb"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#mieCurvesReset')).toBeDisabled();
  // The pad shows a histogram of the picture beneath the curve.
  const hasHistogram = await page.locator('#mieCurvePad').evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let bright = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 60) bright++; return bright;
  });
  expect(hasHistogram).toBeGreaterThan(100);
  await dragOnPad(page, [0.5, 0.5], [0.5, 0.75]);
  const brighter = await greyPixel(page);
  expect(brighter[0]).toBeGreaterThan(before[0] + 30);
  await expect(page.locator('.mie-ch[data-channel="rgb"]')).toHaveClass(/edited/);
  // Red only: pull red down in the middle.
  await page.click('.mie-ch[data-channel="r"]');
  await expect(page.locator('.mie-ch[data-channel="r"]')).toHaveAttribute('aria-checked', 'true');
  await dragOnPad(page, [0.5, 0.5], [0.5, 0.2]);
  const lessRed = await greyPixel(page);
  expect(lessRed[0]).toBeLessThan(lessRed[1] - 20);
  await expect(page.locator('.mie-ch[data-channel="g"]')).not.toHaveClass(/edited/);
  await page.click('#mieCurvesReset');
  await expect(page.locator('#mieCurvesReset')).toBeDisabled();
  const reset = await greyPixel(page);
  expect(Math.abs(reset[0] - before[0])).toBeLessThanOrEqual(2);
  // An untouched curve leaves no step behind.
  await page.click('#mieApply');
  await expect(page.locator('#mieStepCount')).toHaveText('0');
});

test('a curve point is removed by a double-tap, and the ends cannot leave the edges', async ({ page }) => {
  await boot(page); await source(page);
  await page.click('#mieCurvesTool');
  await dragOnPad(page, [0.5, 0.5], [0.5, 0.7]);
  const count = () => page.evaluate(async () => (await MemoImageDraft.read('default', false))?.draft?.params?.curves?.rgb?.length);
  await page.evaluate(() => MemoImageEditorImpl.checkpoint());
  expect(await count()).toBe(3);
  const box = await page.locator('#mieCurvePad').boundingBox();
  const x = box.x + 0.5 * box.width, y = box.y + 0.3 * box.height;
  await page.mouse.click(x, y); await page.mouse.click(x, y);
  await page.evaluate(() => MemoImageEditorImpl.checkpoint());
  expect(await count()).toBe(2);
  // Drag the black point sideways: it stays at the left edge.
  await dragOnPad(page, [0.005, 0.005], [0.4, 0.2]);
  await page.evaluate(() => MemoImageEditorImpl.checkpoint());
  const rgb = await page.evaluate(async () => (await MemoImageDraft.read('default', false)).draft.params.curves.rgb);
  expect(rgb[0][0]).toBe(0);
  expect(rgb[0][1]).toBeGreaterThan(0.1);
  // The white point, grabbed from just outside the pad's corner, comes down.
  await dragOnPad(page, [1.03, 1.03], [0.7, 0.8]);
  await page.evaluate(() => MemoImageEditorImpl.checkpoint());
  const after = await page.evaluate(async () => (await MemoImageDraft.read('default', false)).draft.params.curves.rgb);
  expect(after[after.length - 1][0]).toBe(1);
  expect(after[after.length - 1][1]).toBeLessThan(0.9);
});

test('Steps: look at an earlier step, remove one, and a new edit from there replaces the rest', async ({ page }) => {
  await boot(page); await source(page);
  await page.click('#mieRotateRight');
  await page.click('#mieAdjustTool'); await page.locator('#mieLooks .mie-look[data-preset="Mono"]').click(); await page.click('#mieApply');
  await page.click('#mieCurvesTool'); await page.click('.mie-ch[data-channel="b"]'); await dragOnPad(page, [0.5, 0.5], [0.5, 0.8]); await page.click('#mieApply');
  await expect(page.locator('#mieStepCount')).toHaveText('3');
  await page.click('#mieSteps');
  const rows = page.locator('#mieStepsMenu .mie-step');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Original');
  await expect(rows.nth(1)).toContainText('Rotate 90°');
  await expect(rows.nth(2)).toContainText('Mono');
  await expect(rows.nth(3)).toContainText('Curves · B');
  await expect(rows.nth(3)).toHaveClass(/current/);
  // Look at step 1: rotated, still in colour; saving waits for "Back to latest".
  await rows.nth(1).locator('.mie-step-pick').click();
  await expect(page.locator('#mieViewing')).toBeVisible();
  await expect(page.locator('#mieViewingText')).toContainText('step 1 of 3');
  await expect(page.locator('#mieSave')).toBeDisabled();
  await expect(page.locator('#mieUndo')).toBeDisabled();
  await expect.poll(() => page.locator('#mieCanvas').evaluate((c) => [c.width, c.height])).toEqual([100, 200]);
  await page.click('#mieBackToLatest');
  await expect(page.locator('#mieViewing')).toBeHidden();
  await expect(page.locator('#mieSave')).toBeEnabled();
  // Remove the Mono step: the picture is in colour again (blue curve still on).
  await page.click('#mieSteps');
  await rows.nth(2).locator('.mie-step-remove').click();
  await expect(page.locator('#mieStepCount')).toHaveText('2');
  await expect(rows.nth(2)).toContainText('Curves · B');
  await page.keyboard.press('Escape');
  await expect(page.locator('#mieStepsMenu')).toBeHidden();
  await expect(page.locator('#imageEditorDlg')).toHaveAttribute('open', '');
  // From the original, a flip replaces both later steps.
  await page.click('#mieSteps');
  await rows.nth(0).locator('.mie-step-pick').click();
  await expect(page.locator('#mieViewingText')).toContainText('original');
  await page.click('#mieFlipH');
  await expect(page.locator('#mieStepCount')).toHaveText('1');
  await expect(page.locator('#mieViewing')).toBeHidden();
  await page.click('#mieSteps');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Flip horizontal');
});

test('the saved copy carries the curves and looks at full size', async ({ page }) => {
  await boot(page); await source(page);
  await page.click('#mieAdjustTool'); await page.locator('#mieLooks .mie-look[data-preset="Mono"]').click(); await page.click('#mieApply');
  await page.click('#mieCurvesTool'); await dragOnPad(page, [0.5, 0.5], [0.5, 0.8]); await page.click('#mieApply');
  await page.evaluate(() => { window.__saved = null; MemoCrop.saveToPhone = async (blob) => { window.__saved = blob; return 'gallery'; }; });
  await page.click('#mieDownload');
  await expect(page.locator('#mieStatus')).toHaveText('Copy saved to device. Original kept.');
  const px = await page.evaluate(async () => {
    const bmp = await createImageBitmap(window.__saved);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(150, 50, 1, 1).data;
    return { w: bmp.width, h: bmp.height, rgb: [d[0], d[1], d[2]] };
  });
  expect([px.w, px.h]).toEqual([200, 100]);
  expect(px.rgb[0]).toBeGreaterThan(170);                        // mid-grey 128 lifted by the curve
  expect(Math.abs(px.rgb[0] - px.rgb[2])).toBeLessThanOrEqual(2); // and still grey (Mono)
});

test('an unfinished curve survives closing the app and comes back on Resume', async ({ page }) => {
  await boot(page); await source(page);
  await page.click('#mieCurvesTool'); await page.click('.mie-ch[data-channel="g"]');
  await dragOnPad(page, [0.5, 0.5], [0.5, 0.75]);
  await page.evaluate(() => MemoImageEditorImpl.checkpoint());
  await page.reload(); await page.evaluate(() => window.MemoAppReady);
  await page.evaluate(() => MemoImageEditor.open());
  await page.click('#mieResume');
  await expect(page.locator('#mieCurvesControls')).toBeVisible();
  await expect(page.locator('.mie-ch[data-channel="g"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.mie-ch[data-channel="g"]')).toHaveClass(/edited/);
  const px = await greyPixel(page);
  expect(px[1]).toBeGreaterThan(px[0] + 20);                     // greener
});

test('phone: the curve pad fits and the controls do not push the page sideways', async ({ page }) => {
  await boot(page, { width: 390, height: 844 }); await source(page);
  await page.click('#mieCurvesTool');
  const pad = await page.locator('#mieCurvePad').boundingBox();
  expect(pad.width).toBeGreaterThan(150);
  expect(Math.abs(pad.width - pad.height)).toBeLessThan(2);
  const ctrls = await page.locator('.mie-controls').boundingBox();
  expect(pad.y + pad.height).toBeLessThanOrEqual(ctrls.y + ctrls.height + 400);   // reachable by scrolling the panel
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(1);
  await page.click('#mieCancelTool'); await page.click('#mieAdjustTool');
  await expect(page.locator('#mieBlur')).toBeAttached();
});
