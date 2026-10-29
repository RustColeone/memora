// Memora for Windows (desktop/): the real Electron app, driven by Playwright.
// Each test gets a throwaway profile (MEMORA_USER_DATA), never %APPDATA%\Memora.
// Needs `npm install` in desktop/; the sync-server test also needs
// `npm run build:server` (or Python with the backend requirements).
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DESKTOP = path.join(__dirname, '..', 'desktop');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron');
test.skip(!fs.existsSync(ELECTRON), 'desktop app dependencies are not installed (npm install in desktop/)');
test.describe.configure({ mode: 'serial', timeout: 120000 });

const READY = () => window.MemoStateDb && window.MemoStateDb.ready && window.MemoStateDb.ready() && window.MemoCore && window.MemoChats &&
  window.MODE !== 'detecting' && window.MemoStateDb.storage.engine() === 'native';
async function launch(profile) {
  const env = Object.assign({}, process.env, { MEMORA_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require(ELECTRON), args: [DESKTOP], env });
  const page = await app.firstWindow();
  await page.waitForFunction(READY, null, { timeout: 30000 });
  return { app, page };
}
const profileDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memora-desktop-'));

test('runs local-first on an encrypted SQLite file that survives a restart', async () => {
  const profile = profileDir();
  let { app, page } = await launch(profile);
  const first = await page.evaluate(async () => {
    window.MemoStateDb.saveEntries([{ id: 'desk1', description: 'Written on the desktop', category: 'Test', tags: [], images: [], attachments: [], ts: Date.now() }], 'default');
    await window.MemoStateDb.flush();
    return { origin: location.origin, engine: window.MemoStateDb.storage.engine(), mode: window.MODE, desktop: document.documentElement.classList.contains('desktop-mode'),
      sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller), secure: isSecureContext };
  });
  expect(first).toMatchObject({ origin: 'app://memora', engine: 'native', mode: 'local', desktop: true, sw: false, secure: true });
  await app.close();
  const file = path.join(profile, 'MemoraData', 'databases', 'memoraSQLite.db');
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.readFileSync(file).subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');   // encrypted at rest
  ({ app, page } = await launch(profile));
  const again = await page.evaluate(() => (window.MemoStateDb.loadEntries('default').find(e => e.id === 'desk1') || {}).description);
  expect(again).toBe('Written on the desktop');
  await app.close();
});

test('the Vault works (secure context), and AI calls go out through the app, not the browser', async () => {
  const { app, page } = await launch(profileDir());
  // A provider that would be blocked from a web page by CORS: answer from the
  // app's network side. Playwright cannot route the main process, so point a
  // Custom (OpenAI-compatible) key at a local stub that sends no CORS headers.
  const http = require('node:http');
  const seen = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });   // no Access-Control-Allow-Origin on purpose
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello from the stub.' } }] }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise(r => stub.once('listening', r));
  const port = stub.address().port;
  const out = await page.evaluate(async (port) => {
    await window.MemoVault.setup('desktop vault password');
    await window.MemoVault.save({ type: 'ai-key', provider: 'custom', apiKey: 'sk-desktop', baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'stub-model', isDefault: true });
    await window.MemoChats.ensureAssistant();
    await window.MemoChats.send('assistant', 'hello');
    return { reply: (window.MemoChats.messagesFor('assistant').filter(m => m.role === 'assistant').pop() || {}).text };
  }, port);
  stub.close();
  expect(out.reply).toBe('Hello from the stub.');
  expect(seen[0]).toMatchObject({ url: '/v1/chat/completions', auth: 'Bearer sk-desktop' });
  expect(seen[0].body.model).toBe('stub-model');
  await app.close();
});

test('Host sync on this computer: the switch starts the bundled server, this computer syncs to it, off stops it', async () => {
  const profile = profileDir();
  const { app, page } = await launch(profile);
  await page.evaluate(() => {
    window.MemoStateDb.saveEntries([{ id: 'hosted1', description: 'Synced through my own server', category: 'Test', tags: [], images: [], attachments: [], ts: Date.now() }], 'default');
    return window.MemoStateDb.flush();
  });
  await page.evaluate(() => document.getElementById('settingsDlg').showModal());
  const section = page.locator('#desktopServerSection');
  await expect(section).toBeVisible();
  await expect(section).toContainText('Host sync on this computer');
  await section.locator('#desktopServerToggle').check();
  await expect(section).toContainText('Sync server is on', { timeout: 60000 });
  await expect(section.locator('.desktop-server-qr')).toBeVisible();
  const info = await page.evaluate(() => window.MemoDesktopSync.info());
  expect(info.password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  expect(info.self).toBe(true);
  // A note written now reaches the server through the normal sync log.
  await page.evaluate(async () => {
    await window.OperationQueue.addOperation('create', 'hosted2', { data: { description: 'Pushed to the hosted server', category: 'Test', tags: [], images: [], attachments: [], ts: Date.now() } }, { variant: 'default' });
    await window.OperationQueue.manualSync();
  });
  const fromServer = await (await fetch(info.local + '/api/memos', { headers: { 'X-Sync-Password': info.password } })).json();
  const list = Array.isArray(fromServer) ? fromServer : (fromServer.memos || fromServer.entries || []);
  expect(list.some(m => m.id === 'hosted2')).toBe(true);
  const unauthorized = await fetch(info.local + '/api/memos');
  expect(unauthorized.status).toBe(401);                     // the password guards it
  expect(fs.existsSync(path.join(profile, 'server', 'data', 'memosystem.db'))).toBe(true);
  // Off: the server stops and this computer goes back to local-only.
  await section.locator('#desktopServerToggle').uncheck();
  await expect(section).toContainText('Turn on sync server');
  await expect.poll(async () => { try { await fetch(info.local + '/api/config'); return 'up'; } catch (_e) { return 'down'; } }, { timeout: 15000 }).toBe('down');
  expect(await page.evaluate(() => localStorage.getItem('memo_server_url'))).toBe(null);
  await app.close();
});
