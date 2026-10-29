// Memora for Windows: what must survive. Hard kills mid-write, a lost key,
// a second copy of the app, and the built-in sync server dying, finding its
// port taken, quitting with the app, or meeting an unusual folder name.
// Every test uses a throwaway profile (MEMORA_USER_DATA).
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const DESKTOP = path.join(__dirname, '..', 'desktop');
const ELECTRON_PKG = path.join(DESKTOP, 'node_modules', 'electron');
const SERVER_EXE = path.join(__dirname, '..', 'dist-server', 'memora-server', 'memora-server.exe');
test.skip(!fs.existsSync(ELECTRON_PKG), 'desktop app dependencies are not installed (npm install in desktop/)');
test.describe.configure({ mode: 'serial', timeout: 150000 });

const ELECTRON = fs.existsSync(ELECTRON_PKG) ? require(ELECTRON_PKG) : null;
const READY = () => window.MemoStateDb && window.MemoStateDb.ready && window.MemoStateDb.ready() && window.MemoCore && window.MODE !== 'detecting' &&
  ['native', 'locked', 'unavailable'].includes(window.MemoStateDb.storage.engine());
const profileDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memora-rel-'));
const envFor = profile => { const e = Object.assign({}, process.env, { MEMORA_USER_DATA: profile }); delete e.ELECTRON_RUN_AS_NODE; return e; };
async function launch(profile) {
  const app = await electron.launch({ executablePath: ELECTRON, args: [DESKTOP], env: envFor(profile) });
  const page = await app.firstWindow();
  await page.waitForFunction(READY, null, { timeout: 40000 });
  return { app, page };
}
// Hard kill: no before-quit, no clean close of the database.
function kill(app) {
  const pid = app.process().pid;
  try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_e) {}
}
const dbFiles = profile => path.join(profile, 'MemoraData', 'databases');
const hashFiles = dir => fs.readdirSync(dir).sort().map(f => f + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')).join('|');
const portBusy = port => new Promise(resolve => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
const memo = (id, text) => ({ id, description: text, category: 'Test', tags: [], images: [], attachments: [], ts: Date.now() });

test('a hard kill mid-write keeps every write that was saved, and the database stays intact', async () => {
  const profile = profileDir();
  let { app, page } = await launch(profile);
  const saved = await page.evaluate(async (makeOne) => {
    const make = new Function('return ' + makeOne)();
    const list = [], ids = [];
    for (let i = 0; i < 40; i++) {
      list.push(make('k' + i, 'Saved note ' + i));
      window.MemoStateDb.saveEntries(list.slice(), 'default');
      await window.MemoStateDb.flush();
      ids.push('k' + i);
    }
    // Writes still in flight when the app dies.
    (async () => { for (let i = 40; i < 400; i++) { list.push(make('k' + i, 'In flight ' + i)); window.MemoStateDb.saveEntries(list.slice(), 'default'); await window.MemoStateDb.flush(); } })();
    await new Promise(r => setTimeout(r, 120));
    return ids;
  }, memo.toString());
  kill(app);
  await new Promise(r => setTimeout(r, 1500));
  ({ app, page } = await launch(profile));
  const after = await page.evaluate(async () => {
    const conn = window.MemoNativeStore.main();
    const check = await conn.query('PRAGMA integrity_check');
    return { engine: window.MemoStateDb.storage.engine(), ids: window.MemoStateDb.loadEntries('default').map(e => e.id), integrity: check[0] && Object.values(check[0])[0] };
  });
  expect(after.engine).toBe('native');
  expect(after.integrity).toBe('ok');
  for (const id of saved) expect(after.ids).toContain(id);
  await app.close();
});

test('a lost key never wipes the data: the app opens locked, the file is untouched, and the key coming back restores it', async () => {
  const profile = profileDir();
  let { app, page } = await launch(profile);
  await page.evaluate(async (m) => { window.MemoStateDb.saveEntries([m], 'default'); await window.MemoStateDb.flush(); }, memo('keep1', 'Must survive a lost key'));
  await app.close();
  const keyFile = path.join(profile, 'MemoraData', 'secrets', 'db-passphrase');
  const kept = keyFile + '.away';
  fs.renameSync(keyFile, kept);
  const before = hashFiles(dbFiles(profile));
  ({ app, page } = await launch(profile));
  expect(await page.evaluate(() => window.MemoStateDb.storage.engine())).toBe('locked');
  await page.waitForTimeout(2000);   // give any stray write a chance to happen
  await app.close();
  expect(hashFiles(dbFiles(profile))).toBe(before);
  fs.renameSync(kept, keyFile);
  ({ app, page } = await launch(profile));
  const back = await page.evaluate(() => ({ engine: window.MemoStateDb.storage.engine(), text: (window.MemoStateDb.loadEntries('default').find(e => e.id === 'keep1') || {}).description }));
  expect(back).toEqual({ engine: 'native', text: 'Must survive a lost key' });
  await app.close();
});

test('a second copy of the app hands over to the first instead of opening the database twice', async () => {
  const profile = profileDir();
  const { app, page } = await launch(profile);
  const second = spawn(ELECTRON, [DESKTOP], { env: envFor(profile), stdio: 'ignore' });
  const code = await new Promise(resolve => { const t = setTimeout(() => { second.kill(); resolve('still running'); }, 20000); second.on('exit', c => { clearTimeout(t); resolve(c); }); });
  expect(code).toBe(0);
  // The first copy still reads and writes.
  const ok = await page.evaluate(async (m) => { window.MemoStateDb.saveEntries([m], 'default'); await window.MemoStateDb.flush(); return window.MemoStateDb.loadEntries('default').length; }, memo('solo1', 'Only one copy'));
  expect(ok).toBe(1);
  await app.close();
});

test('a protected backup made on the desktop restores everything into a fresh install, photos included', async () => {
  const { answerPassword } = require('./helpers/protected-backup');
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-dl-'));
  const start = async (profile) => {
    const env = Object.assign(envFor(profile), { MEMORA_DOWNLOAD_DIR: downloads });
    const app = await electron.launch({ executablePath: ELECTRON, args: [DESKTOP], env });
    const page = await app.firstWindow();
    await page.waitForFunction(READY, null, { timeout: 40000 });
    await page.waitForFunction(() => window.MemoBackup && window.JSZip);
    return { app, page };
  };
  const openBackup = page => page.evaluate(() => {
    document.getElementById('settingsDlg').showModal();
    document.getElementById('exportDataBtn').closest('.settings-section')?.classList.remove('collapsed');
  });
  // Seed: two notes (one with a photo), a Vault item, an AI contact.
  let { app, page } = await start(profileDir());
  const photoBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 30;
    const g = canvas.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 40, 30);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const rel = 'uploads/2026-10-19/sweep_photo.png';
    await window.MemoStateDb.writeBlob(rel, blob);
    window.MemoStateDb.saveEntries([
      { id: 'b1', description: 'Backed-up note', category: 'Test', tags: ['keep'], images: ['/' + rel], _storedPaths: [rel], attachments: [], ts: Date.now() },
      { id: 'b2', description: 'Second note', category: 'Test', tags: [], images: [], attachments: [], ts: Date.now() }], 'default');
    await window.MemoStateDb.flush();
    await window.MemoVault.setup('desktop backup vault pw');
    await window.MemoVault.save({ type: 'note', title: 'Locker', content: 'CODE: 4711' });
    await window.OperationQueue.addOperation('create', 'c_bk', { data: { id: 'c_bk', kind: 'contact', name: 'Mei', persona: 'cheerful' } }, { variant: 'contacts' });
    await window.MemoStateDb.flush();
    return blob.size;
  });
  await openBackup(page);
  await page.click('#exportDataBtn');
  await answerPassword(page);
  await page.waitForFunction(() => /Export complete/.test(document.getElementById('importExportStatus').textContent || ''), null, { timeout: 40000 });
  await expect.poll(() => fs.readdirSync(downloads).filter(f => f.endsWith('.memora')).length, { timeout: 15000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  await app.close();
  const files = fs.readdirSync(downloads).filter(f => f.endsWith('.memora')).map(f => path.join(downloads, f));
  for (const f of files) expect(fs.readFileSync(f).subarray(0, 6).toString('latin1')).toBe('MEMORA');

  // A fresh install restores it.
  ({ app, page } = await start(profileDir()));
  await openBackup(page);
  await page.setInputFiles('#importDataInput', files);
  await answerPassword(page);
  await page.locator('#memoConfirmDlg .memo-confirm-ok').click();
  await page.waitForFunction(() => (window.MemoStateDb.loadEntries('default') || []).length === 2, null, { timeout: 30000 });
  const restored = await page.evaluate(async () => {
    const note = window.MemoStateDb.loadEntries('default').find(e => e.id === 'b1');
    const rel = (note._storedPaths && note._storedPaths[0]) || String(note.images[0]).replace(/^\//, '');
    const blob = await window.MemoStateDb.readBlob(rel);
    await window.MemoVault.unlock('desktop backup vault pw');
    const items = (await window.MemoVault.list()).items;
    return { text: note.description, tags: note.tags, photo: blob ? blob.size : 0,
      vault: items.filter(i => i.type === 'note').map(i => i.content), contacts: window.MemoStateDb.loadDocs('contacts').map(c => c.name) };
  });
  expect(restored.text).toBe('Backed-up note');
  expect(restored.tags).toEqual(['keep']);
  expect(restored.photo).toBe(photoBytes);
  expect(restored.vault).toContain('CODE: 4711');
  expect(restored.contacts).toContain('Mei');
  await app.close();
});

test('launch and the main views log no errors in the desktop app', async () => {
  const env = envFor(profileDir());
  const app = await electron.launch({ executablePath: ELECTRON, args: [DESKTOP], env });
  const page = await app.firstWindow();
  const problems = [];
  page.on('pageerror', e => problems.push('uncaught: ' + (e && e.stack || e)));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.waitForFunction(READY, null, { timeout: 40000 });
  for (const view of ['finance', 'planner', 'discover', 'default']) {
    await page.evaluate(v => document.querySelector('#primaryNav a[data-view="' + v + '"], #primaryNav a[href="#' + v + '"]')?.click(), view);
    await page.waitForTimeout(600);
  }
  await page.evaluate(async () => {
    window.MemoShell.handleSystemBack();
    await window.MemoVault.setup('desktop sweep password');
    window.MemoVaultUi.open();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.getElementById('vaultDlg')?.close(); document.getElementById('settingsDlg').showModal(); });
  await page.waitForTimeout(500);
  await app.close();
  expect(problems).toEqual([]);
});

test.describe('the built-in sync server', () => {
  test.skip(!fs.existsSync(SERVER_EXE), 'npm run build:server first');

  async function turnOn(page) {
    await page.evaluate(() => document.getElementById('settingsDlg').showModal());
    await page.locator('#desktopServerToggle').check();
    await expect(page.locator('#desktopServerSection')).toContainText('Sync server is on', { timeout: 60000 });
    return page.evaluate(() => window.MemoDesktopSync.info());
  }

  test('quitting the app stops the server; it never keeps running on its own', async () => {
    const { app, page } = await launch(profileDir());
    const info = await turnOn(page);
    expect(await portBusy(info.port)).toBe(true);
    await app.close();
    await expect.poll(() => portBusy(info.port), { timeout: 15000 }).toBe(false);
  });

  test('when the server dies, writes wait in the queue and reach it once it is back, with its earlier data intact', async () => {
    const profile = profileDir();
    const { app, page } = await launch(profile);
    let info = await turnOn(page);
    const push = (id, text) => page.evaluate(async ([id, text]) => {
      await window.OperationQueue.addOperation('create', id, { data: { description: text, category: 'T', tags: [], images: [], attachments: [], ts: Date.now() } }, { variant: 'default' });
      return window.OperationQueue.manualSync();
    }, [id, text]);
    const onServer = async (port, password) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/memos`, { headers: { 'X-Sync-Password': password } });
      const body = await res.json();
      return (Array.isArray(body) ? body : (body.memos || body.entries || [])).map(m => m.id);
    };
    await push('before-crash', 'Synced before the crash');
    expect(await onServer(info.port, info.password)).toContain('before-crash');
    execFileSync('taskkill', ['/IM', 'memora-server.exe', '/T', '/F'], { stdio: 'ignore' });
    await expect(page.locator('#desktopServerSection')).toContainText('The sync server stopped', { timeout: 15000 });
    await expect(page.locator('#desktopServerToggle')).not.toBeChecked();
    await push('while-down', 'Written while the server was down');
    const pending = await page.evaluate(() => window.OperationQueue.context('default').state.queue.filter(op => !op.synced).map(op => op.entryId));
    expect(pending).toContain('while-down');
    info = await turnOn(page);
    await page.evaluate(() => window.OperationQueue.manualSync());
    const ids = await onServer(info.port, info.password);
    expect(ids).toEqual(expect.arrayContaining(['before-crash', 'while-down']));
    await app.close();
  });

  test('a taken port moves the server to the next free one and remembers it', async () => {
    const holder = net.createServer().listen(5050, '0.0.0.0');
    await new Promise((resolve, reject) => { holder.once('listening', resolve); holder.once('error', reject); });
    try {
      const profile = profileDir();
      let { app, page } = await launch(profile);
      const info = await turnOn(page);
      expect(info.port).not.toBe(5050);
      expect(info.urls[0]).toContain(':' + info.port);
      await app.close();
      holder.close();
      // Next launch keeps the same port, so a phone's saved address still works.
      ({ app, page } = await launch(profile));
      await expect(page.locator('#desktopServerSection')).toContainText('Sync server is on', { timeout: 60000 });   // remembered as on
      expect((await page.evaluate(() => window.MemoDesktopSync.info())).port).toBe(info.port);
      await app.close();
    } finally { holder.close(); }
  });

  test('a computer already syncing with another server keeps it; the switch does not take over', async () => {
    const { app, page } = await launch(profileDir());
    await page.evaluate(() => { localStorage.setItem('memo_server_url', 'http://192.0.2.10:5050'); window.MemoContracts.setApiBase('http://192.0.2.10:5050'); });
    const info = await turnOn(page);
    expect(info.self).toBe(false);
    await expect(page.locator('#desktopServerSection')).toContainText('keeps syncing with http://192.0.2.10:5050');
    await page.locator('#desktopServerToggle').uncheck();
    await expect(page.locator('#desktopServerSection')).toContainText('Turn on sync server');
    expect(await page.evaluate(() => [localStorage.getItem('memo_server_url'), window.MemoContracts.getApiBase()])).toEqual(['http://192.0.2.10:5050', 'http://192.0.2.10:5050']);
    await app.close();
  });

  test('the packaged server runs from a folder with spaces and non-English letters', async () => {
    const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memora-path-')), 'My Memora Sérvér 数据');
    const proc = spawn(SERVER_EXE, ['--host', '127.0.0.1', '--port', '5091', '--base-dir', base], { env: Object.assign({}, process.env, { MEMO_SYNC_PASSWORD: 'pw-path' }) });
    try {
      let out = '';
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no ready line: ' + out)), 45000);
        proc.stdout.on('data', d => { out += d; if (/MEMORA_SERVER_READY/.test(out)) { clearTimeout(t); resolve(); } });
        proc.on('exit', c => { clearTimeout(t); reject(new Error('exited ' + c + ': ' + out)); });
      });
      const res = await fetch('http://127.0.0.1:5091/api/operations/push?variant=default', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Password': 'pw-path' },
        body: JSON.stringify({ operations: [{ type: 'create', entryId: 'p1', clientOpId: 'c1', timestamp: Date.now(), data: { description: 'Unicode path ✓', category: 'T', tags: [], images: [], attachments: [] } }] }) });
      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(base, 'data', 'memosystem.db'))).toBe(true);
      const list = await (await fetch('http://127.0.0.1:5091/api/memos', { headers: { 'X-Sync-Password': 'pw-path' } })).json();
      expect(JSON.stringify(list)).toContain('Unicode path ✓');
    } finally {
      try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_e) {}
    }
  });
});
