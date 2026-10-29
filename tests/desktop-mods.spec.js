// Mods in the desktop app (memo-mods.js, desktop/main.cjs mods.*): a folder in
// <profile>/mods is listed in Settings, stays off until turned on, then loads
// and can add a menu item, read entries and save one. Throwaway profiles only.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DESKTOP = path.join(__dirname, '..', 'desktop');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron');
const EXAMPLE = path.join(__dirname, '..', 'mods-examples', 'notebook-stats');
test.skip(!fs.existsSync(ELECTRON), 'desktop app dependencies are not installed (npm install in desktop/)');
test.describe.configure({ mode: 'serial', timeout: 120000 });

const READY = () => window.MemoStateDb && window.MemoStateDb.ready && window.MemoStateDb.ready() && window.MemoCore &&
  window.MODE !== 'detecting' && window.MemoStateDb.storage.engine() === 'native' && window.MemoMods;
async function launch(profile) {
  const env = Object.assign({}, process.env, { MEMORA_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require(ELECTRON), args: [DESKTOP], env });
  const page = await app.firstWindow();
  await page.waitForFunction(READY, null, { timeout: 30000 });
  await page.evaluate(() => window.MemoMods.start());
  return { app, page };
}
function profileWithMods(extra) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-mods-'));
  const mods = path.join(profile, 'mods');
  fs.cpSync(EXAMPLE, path.join(mods, 'notebook-stats'), { recursive: true });
  for (const [folder, files] of Object.entries(extra || {})) {
    fs.mkdirSync(path.join(mods, folder), { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(mods, folder, name), text);
  }
  return profile;
}

test('a dropped-in mod is listed, off until turned on, then adds its menu item and reads the notebook', async () => {
  const profile = profileWithMods({
    broken: { 'mod.json': '{ not json' },
    'wrong-version': { 'mod.json': JSON.stringify({ id: 'wrong-version', memora: 99, scripts: ['main.js'] }) },
    'escapes': { 'mod.json': JSON.stringify({ id: 'escapes', memora: 1, scripts: ['../notebook-stats/main.js'] }) },
  });
  let { app, page } = await launch(profile);
  const listed = await page.evaluate(() => window.MemoMods.list().map((m) => [m.folder, m.error ? 'error' : 'ok']));
  expect(listed).toEqual([['broken', 'error'], ['escapes', 'error'], ['notebook-stats', 'ok'], ['wrong-version', 'error']]);
  // Off by default: nothing ran.
  expect(await page.evaluate(() => window.MemoMods.state())).toEqual({});
  await expect(page.locator('#modsMenuSection button')).toHaveCount(0);
  // Settings → Mods shows it with a switch, and the folder.
  await page.evaluate(() => { window.MemoMods.render(); document.getElementById('settingsDlg').showModal(); });
  const section = page.locator('#modsSection');
  await expect(section).toContainText('Notebook stats');
  await expect(section).toContainText(path.join(profile, 'mods'));
  await expect(section.locator('.mod-error')).toHaveCount(3);
  await section.locator('[data-mod-toggle="notebook-stats"]').check();
  await page.evaluate(() => { window.MemoStateDb.saveEntries([{ id: 'n1', description: 'two words', category: 'Test', tags: [], images: [], attachments: [], ts: Date.now() }], 'default'); return window.MemoStateDb.flush(); });
  await app.close();

  ({ app, page } = await launch(profile));
  expect(await page.evaluate(() => window.MemoMods.state())).toEqual({ 'notebook-stats': 'loaded' });
  const item = page.locator('#modsMenuSection button[data-mod="notebook-stats"]');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Notebook stats');
  await page.evaluate(() => document.querySelector('#modsMenuSection button[data-mod="notebook-stats"]').click());
  const sheet = page.locator('dialog.mod-sheet[open]');
  await expect(sheet).toContainText('Words in notes');
  await expect(sheet.locator('dd').nth(0)).toHaveText('1');
  await expect(sheet.locator('dd').nth(1)).toHaveText('2');
  // Its stylesheet came from the mods folder too.
  expect(await sheet.locator('dl').evaluate((el) => getComputedStyle(el).display)).toBe('grid');
  // A mod can save through the normal queue, and the open sheet follows.
  await page.evaluate(() => window.OperationQueue.addOperation('create', 'n2', { data: { description: 'three more words', category: 'Test', tags: [], images: [], attachments: [], ts: Date.now() } }, { variant: 'default' }));
  await expect(sheet.locator('dd').nth(1)).toHaveText('5');
  await app.close();
});

test('a mod that throws is reported, and the app keeps working', async () => {
  const profile = profileWithMods({
    'throws': { 'mod.json': JSON.stringify({ id: 'throws', name: 'Throws', memora: 1, scripts: ['main.js'] }),
      'main.js': "Memora.mod('throws', function () { throw new Error('boom from the mod'); });" },
    'silent': { 'mod.json': JSON.stringify({ id: 'silent', memora: 1, scripts: ['main.js'] }), 'main.js': '/* never calls Memora.mod */' },
    'reads-file': { 'mod.json': JSON.stringify({ id: 'reads-file', memora: 1, scripts: ['main.js'] }), 'data.json': '{"hello":"world"}',
      'main.js': "Memora.mod('reads-file', async function (m) { window.__readsFile = (await (await fetch(m.url('data.json'))).json()).hello; });" },
  });
  let { app, page } = await launch(profile);
  await page.evaluate(() => localStorage.setItem('memora_mods_enabled', JSON.stringify(['throws', 'silent', 'reads-file'])));
  await app.close();
  ({ app, page } = await launch(profile));
  const state = await page.evaluate(() => window.MemoMods.state());
  expect(state.throws).toContain('boom from the mod');
  expect(state.silent).toContain('never called Memora.mod');
  // memora.url() reaches the mod's own files.
  expect(state['reads-file']).toBe('loaded');
  expect(await page.evaluate(() => window.__readsFile)).toBe('world');
  await page.evaluate(() => { window.MemoMods.render(); document.getElementById('settingsDlg').showModal(); });
  await expect(page.locator('#modsSection .mod-error')).toHaveCount(2);
  // The notebook still saves.
  await page.evaluate(() => { window.MemoStateDb.saveEntries([{ id: 'ok', description: 'still fine', category: 'T', tags: [], images: [], attachments: [], ts: Date.now() }], 'default'); return window.MemoStateDb.flush(); });
  expect(await page.evaluate(() => window.MemoStateDb.loadEntries('default').some((e) => e.id === 'ok'))).toBe(true);
  await app.close();
});

test('the app:// handler never serves files outside the mods folder', async () => {
  const profile = profileWithMods();
  fs.writeFileSync(path.join(profile, 'secret.txt'), 'outside');
  const { app, page } = await launch(profile);
  const r = await page.evaluate(async () => {
    const get = async (u) => (await fetch(u)).status;
    return { inside: await get('/mods/notebook-stats/mod.json'), up: await get('/mods/../secret.txt'), encoded: await get('/mods/%2e%2e/secret.txt'),
      deeper: await get('/mods/notebook-stats/..%2f..%2fsecret.txt') };
  });
  expect(r.inside).toBe(200);
  expect(r.up).toBe(404);
  expect(r.encoded).toBe(404);
  expect(r.deeper).toBe(404);
  await app.close();
});
