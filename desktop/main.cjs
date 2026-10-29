// Memora for Windows, macOS and Linux — the Electron main process.
//
// The window shows the same www/ bundle as the Android app, served from the
// private app://memora origin. Like Capacitor on the phone, this process gives
// the page what a browser cannot:
//   sqlite.*     the phone's CapacitorSQLite calls, on an encrypted SQLite file
//                (memo-native-store.js runs unchanged on top of it)
//   fs.*         its few Filesystem calls, in the app's data folder
//   http.request every request to another address (AI providers, sync
//                servers), so no browser CORS or mixed-content rule applies
//   reminders.*  Planner reminders as system notifications
//   mods.*       lists the mods folder (memo-mods.js loads the ones turned on)
//   server.*     "Host sync for my other devices": starts and stops the
//                bundled memora-server, the same server as the open-source one
// AI is bring-your-own-key: nothing here holds or adds a key.
const { app, BrowserWindow, ipcMain, protocol, net, safeStorage, Notification, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

app.setName('Memora');
// Tests and trial runs keep their own profile instead of %APPDATA%\Memora.
if (process.env.MEMORA_USER_DATA) app.setPath('userData', process.env.MEMORA_USER_DATA);
const ORIGIN = 'app://memora';
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

const repo = path.join(__dirname, '..');
const packaged = app.isPackaged;
const WWW = packaged ? path.join(process.resourcesPath, 'www') : path.join(repo, 'www');
const userData = () => app.getPath('userData');
// Memora's own folder inside the profile. Not <profile>/databases: Chromium
// deletes that one at startup (it is the old WebSQL location).
const DATA = () => path.join(userData(), 'MemoraData');
const FILES = () => path.join(DATA(), 'files');          // Capacitor's DATA directory
const DATABASES = () => path.join(DATA(), 'databases');  // where the phone keeps *SQLite.db
const SECRETS = () => path.join(DATA(), 'secrets');
const MODS = () => path.join(userData(), 'mods');        // folders a person drops in (memo-mods.js)
let win = null;

// ── app://memora → www/ ──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain', '.map': 'application/json' };
function serveApp() {
  protocol.handle('app', request => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    // The page asks its own origin whether it is a sync server; it is not.
    if (rel === 'api/config') return new Response(JSON.stringify({ server: false, desktop: true }), { headers: { 'content-type': 'application/json' } });
    // Mods come from the profile's mods folder (memo-mods.js); everything else from www/.
    const root = rel.startsWith('mods/') ? MODS() : WWW;
    const file = path.normalize(path.join(root, rel.startsWith('mods/') ? rel.slice(5) : rel));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' } });
  });
}

// ── secrets (the database key, the sync password) ──
// Windows: DPAPI for this Windows user, called directly. Not Electron's
// safeStorage there: its key lives in Chromium's "Local State" file, which is
// only saved on a clean exit, so a crash right after setup would lock the
// database forever. Elsewhere: safeStorage (Keychain / libsecret).
function dpapi(op, base64) {
  const script = 'Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::' + op +
    '([Convert]::FromBase64String($env:MEMORA_DPAPI_IN), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: Object.assign({}, process.env, { MEMORA_DPAPI_IN: base64 }), windowsHide: true, encoding: 'utf8' }).trim();
}
const secretCache = new Map();
function writeSecret(name, value) {
  fs.mkdirSync(SECRETS(), { recursive: true });
  let text;
  if (process.platform === 'win32') text = 'dpapi:' + dpapi('Protect', Buffer.from(value, 'utf8').toString('base64'));
  else if (safeStorage.isEncryptionAvailable()) text = 'safe:' + safeStorage.encryptString(value).toString('base64');
  else throw new Error('This computer offers no protected storage for the database key.');
  const file = path.join(SECRETS(), name);
  fs.writeFileSync(file + '.tmp', text, 'utf8');
  fs.renameSync(file + '.tmp', file);
  secretCache.set(name, value);
}
function readSecret(name) {
  if (secretCache.has(name)) return secretCache.get(name);
  try {
    const text = fs.readFileSync(path.join(SECRETS(), name), 'utf8');
    let value = null;
    if (text.startsWith('dpapi:')) value = Buffer.from(dpapi('Unprotect', text.slice(6)), 'base64').toString('utf8');
    else if (text.startsWith('safe:')) value = safeStorage.decryptString(Buffer.from(text.slice(5), 'base64'));
    if (value) secretCache.set(name, value);
    return value;
  } catch (error) {
    if (process.env.MEMORA_SQL_TRACE) console.log('[trace] readSecret failed', name, String(error && error.message || error).slice(0, 300));
    return null;
  }
}
function forgetSecret(name) {
  secretCache.delete(name);
  try { fs.unlinkSync(path.join(SECRETS(), name)); } catch (_e) {}
}

// ── sqlite.* : the CapacitorSQLite calls memo-native-store.js makes ──
const Database = require('better-sqlite3-multiple-ciphers');
const connections = new Map();   // database name → { db, encrypted }
const dbFile = name => path.join(DATABASES(), name + 'SQLite.db');
function conn(name) {
  const c = connections.get(name);
  if (!c || !c.db) throw new Error('Database ' + name + ' is not open');
  return c.db;
}
const bindable = values => (values || []).map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const sqlite = {
  isDatabase: ({ database }) => ({ result: fs.existsSync(dbFile(database)) }),
  getDatabaseList: () => {
    const list = fs.existsSync(DATABASES()) ? fs.readdirSync(DATABASES()).filter(f => /SQLite\.db$/.test(f)) : [];
    if (!list.length) throw new Error('No databases');
    return { values: list };
  },
  setEncryptionSecret: ({ passphrase }) => { writeSecret('db-passphrase', passphrase); return {}; },
  isSecretStored: () => ({ result: !!readSecret('db-passphrase') }),
  clearEncryptionSecret: () => { forgetSecret('db-passphrase'); return {}; },
  createConnection: ({ database, encrypted }) => { connections.set(database, { db: null, encrypted: encrypted !== false }); return {}; },
  open: ({ database }) => {
    const c = connections.get(database) || { encrypted: true };
    fs.mkdirSync(DATABASES(), { recursive: true });
    const db = new Database(dbFile(database));
    if (c.encrypted) {
      const secret = readSecret('db-passphrase');
      if (!secret) { db.close(); throw new Error('No passphrase stored for ' + database); }
      db.pragma("cipher='sqlcipher'");
      db.pragma('legacy=4');
      db.pragma('key=' + "'" + secret.replace(/'/g, "''") + "'");
    }
    db.pragma('journal_mode = WAL');
    db.prepare('SELECT count(*) FROM sqlite_master').get();   // throws now if the key is wrong
    c.db = db;
    connections.set(database, c);
    return {};
  },
  query: ({ database, statement, values }) => {
    const stmt = conn(database).prepare(statement);
    if (stmt.reader) return { values: stmt.all(bindable(values)) };
    stmt.run(bindable(values));
    return { values: [] };
  },
  executeSet: ({ database, set, transaction }) => {
    const db = conn(database);
    const runAll = () => { for (const s of set || []) db.prepare(s.statement).run(bindable(s.values)); };
    if (transaction !== false) db.transaction(runAll)(); else runAll();
    return { changes: { changes: (set || []).length } };
  },
  beginTransaction: ({ database }) => { conn(database).exec('BEGIN'); return {}; },
  commitTransaction: ({ database }) => { conn(database).exec('COMMIT'); return {}; },
  rollbackTransaction: ({ database }) => { conn(database).exec('ROLLBACK'); return {}; },
  close: ({ database }) => { const c = connections.get(database); if (c && c.db) { c.db.close(); c.db = null; } return {}; },
  closeConnection: ({ database }) => { sqlite.close({ database }); connections.delete(database); return {}; }
};

// ── fs.* : the Filesystem calls (DATA directory = <userData>/files) ──
// Paths are relative to <userData>/files, or file: URIs from getUri; either
// way they must stay inside the app's data folder.
const toPath = p => {
  const full = /^file:/i.test(p) ? require('node:url').fileURLToPath(p) : path.normalize(path.join(FILES(), p));
  if (!full.startsWith(userData())) throw new Error('Outside the app folder');
  return full;
};
// The layout matches the phone's (<data>/files/MemoSystem beside
// <data>/databases), so the store can move a database it has no key for into
// files/MemoSystem/locked-* exactly as it does on Android.
const files = {
  readFile: ({ path: p }) => ({ data: fs.readFileSync(toPath(p), 'utf8') }),
  writeFile: ({ path: p, data }) => { fs.mkdirSync(path.dirname(toPath(p)), { recursive: true }); fs.writeFileSync(toPath(p), data, 'utf8'); return {}; },
  mkdir: ({ path: p }) => { fs.mkdirSync(toPath(p), { recursive: true }); return {}; },
  getUri: ({ path: p }) => ({ uri: pathToFileURL(toPath(p)).href }),
  rename: ({ from, to }) => { const target = toPath(to); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(toPath(from), target); return {}; }
};

// ── http.request : every request to another address ──
async function httpRequest({ url, method, headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 120000);
  try {
    const response = await net.fetch(url, { method: method || 'GET', headers: headers || {}, body: body && body.byteLength ? Buffer.from(body) : undefined,
      signal: controller.signal, bypassCustomProtocolHandlers: true });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body: bytes };
  } catch (error) {
    return { error: (error && error.name === 'AbortError') ? 'The request timed out.' : String(error && error.message || error) };
  } finally { clearTimeout(timer); }
}

// ── reminders.* : Planner reminders as Windows notifications ──
let reminderTimers = [], openedFromReminder = false;
const reminders = {
  status: () => ({ enabled: Notification.isSupported(), approximate: false }),
  enable: () => reminders.status(),
  settings: () => { shell.openExternal('ms-settings:notifications'); return {}; },
  consumeOpen: () => { const open = openedFromReminder; openedFromReminder = false; return { open }; },
  replace: ({ events }) => {
    reminderTimers.forEach(clearTimeout);
    reminderTimers = [];
    const now = Date.now();
    // A repeating event lists the dates it comes round in `dates`.
    for (const ev of events || []) for (const date of ev.dates || [ev.date]) {
      const due = new Date(date + 'T' + (ev.start || '09:00') + ':00').getTime() - (Number(ev.remindBefore) || 0) * 60000;
      if (!(due > now - 60000) || due - now > 24 * 3600e3 * 24) continue;   // past, or beyond setTimeout's range
      reminderTimers.push(setTimeout(() => {
        const n = new Notification({ title: ev.channel || 'Memora', body: ev.body || 'An event is coming up.' });
        n.on('click', () => { openedFromReminder = true; if (win) { win.show(); win.focus(); win.webContents.send('memora:reminder-open'); } });
        n.show();
      }, Math.max(0, due - now)));
    }
    return {};
  }
};

// ── mods.* : folders a person drops into <profile>/mods (memo-mods.js) ──
// Only lists them; the page decides which are on, and loads their files from
// app://memora/mods/<folder>/.
const mods = {
  list: () => {
    fs.mkdirSync(MODS(), { recursive: true });
    const out = [];
    for (const entry of fs.readdirSync(MODS(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const file = path.join(MODS(), entry.name, 'mod.json');
      let manifest = null, error = '';
      try {
        if (fs.statSync(file).size > 65536) throw new Error('mod.json is larger than 64 KB');
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) { error = e.code === 'ENOENT' ? 'no mod.json in this folder' : 'mod.json: ' + e.message; }
      out.push({ folder: entry.name, manifest, error });
    }
    return { dir: MODS(), mods: out.sort((a, b) => a.folder.localeCompare(b.folder)) };
  },
  openFolder: async () => { fs.mkdirSync(MODS(), { recursive: true }); await shell.openPath(MODS()); return {}; },
};

// ── server.* : the built-in sync server ──
let serverProc = null, serverInfo = null;
function serverCommand() {
  const name = process.platform === 'win32' ? 'memora-server.exe' : 'memora-server';
  const exe = packaged ? path.join(process.resourcesPath, 'memora-server', name) : path.join(repo, 'dist-server', 'memora-server', name);
  if (fs.existsSync(exe)) return { cmd: exe, args: [] };
  // Development without a packaged server: run the same code with Python.
  return { cmd: process.platform === 'win32' ? 'python' : 'python3', args: [path.join(repo, 'backend', 'memora_server.py')] };
}
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}
function syncPassword() {
  let pw = readSecret('sync-password');
  if (!pw) {
    // Easy to type on a phone: 4 groups of 4 letters and digits, no look-alikes.
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    pw = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => abc[crypto.randomInt(abc.length)]).join('')).join('-');
    writeSecret('sync-password', pw);
  }
  return pw;
}
async function describeServer() {
  if (!serverInfo) return { running: false, password: readSecret('sync-password') };
  const urls = lanAddresses().map(ip => `http://${ip}:${serverInfo.port}`);
  const QRCode = require('qrcode');
  const pairing = urls[0] ? JSON.stringify({ memora: 1, url: urls[0], password: serverInfo.password }) : null;
  return { running: true, port: serverInfo.port, urls, local: `http://127.0.0.1:${serverInfo.port}`, password: serverInfo.password,
    qr: pairing ? await QRCode.toDataURL(pairing, { margin: 1, width: 260 }) : null, dataDir: serverInfo.baseDir, version: serverInfo.version };
}
let starting = null;
const SERVER_PORTS = Array.from({ length: 10 }, (_v, i) => 5050 + i);
const portFile = () => path.join(DATA(), 'server-port.json');
function preferredPort() {
  try { const p = JSON.parse(fs.readFileSync(portFile(), 'utf8')).port; if (SERVER_PORTS.includes(p)) return p; } catch (_e) {}
  return SERVER_PORTS[0];
}
async function startOnFreePort() {
  const first = preferredPort();
  const order = [first].concat(SERVER_PORTS.filter(p => p !== first));
  for (const port of order) {
    try {
      const info = await startOn(port);
      fs.mkdirSync(DATA(), { recursive: true });
      fs.writeFileSync(portFile(), JSON.stringify({ port }));
      return info;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Ports 5050–5059 are all in use by other programs.');
}
function startOn(port) {
  return new Promise((resolve, reject) => {
    const { cmd, args } = serverCommand();
    const password = syncPassword();
    const baseDir = path.join(userData(), 'server');
    const env = Object.assign({}, process.env, { MEMO_SYNC_PASSWORD: password, PYTHONIOENCODING: 'utf-8' });
    delete env.ELECTRON_RUN_AS_NODE;
    const proc = spawn(cmd, args.concat(['--host', '0.0.0.0', '--port', String(port), '--base-dir', baseDir]), { env, windowsHide: true });
    serverProc = proc;
    let settled = false, log = '';
    const fail = (message, code) => {
      if (settled) return;
      settled = true;
      if (serverProc === proc) { serverProc = null; serverInfo = null; }
      const error = new Error(message);
      error.code = code;
      reject(error);
    };
    const timer = setTimeout(() => { stopProcess(proc); fail('The sync server did not start in time.'); }, 45000);
    proc.stdout.on('data', chunk => {
      log = (log + chunk.toString('utf8')).slice(-4000);
      const m = /MEMORA_SERVER_READY (\{.*\})/.exec(log);
      if (m && !settled) {
        settled = true; clearTimeout(timer);
        serverInfo = Object.assign(JSON.parse(m[1]), { password });
        resolve(describeServer());
      }
    });
    proc.stderr.on('data', chunk => { log = (log + chunk.toString('utf8')).slice(-4000); });
    proc.on('error', error => { clearTimeout(timer); fail('Could not start the sync server: ' + error.message); });
    proc.on('exit', code => {
      clearTimeout(timer);
      const wasRunning = !!serverInfo && serverProc === proc;
      if (serverProc === proc) { serverProc = null; serverInfo = null; }
      if (!settled) {
        if (/address already in use|10048|10013|forbidden by its access permissions|Errno 98/i.test(log)) fail(`Port ${port} is in use by another program.`, 'EADDRINUSE');
        else fail('The sync server stopped (code ' + code + '). ' + log.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
      } else if (wasRunning && win) win.webContents.send('memora:server-stopped');
    });
  });
}
const server = {
  status: () => describeServer(),
  // One start at a time: a second call (the switch, the auto-start at launch)
  // waits for the first. 5050 first, or the port that worked last time, so a
  // phone keeps its saved address; when another program holds it, the next
  // free one of 5050–5059 is used and remembered.
  start: () => {
    if (serverInfo) return describeServer();
    if (!starting) starting = startOnFreePort().finally(() => { starting = null; });
    return starting;
  },
  stop: () => { const proc = serverProc; serverProc = null; serverInfo = null; if (proc) stopProcess(proc); return { running: false }; },
  newPassword: () => { forgetSecret('sync-password'); return { password: syncPassword() }; }
};
function stopProcess(proc) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else proc.kill('SIGTERM');
  } catch (_e) {}
}

// ── wiring ──
const TRACE = !!process.env.MEMORA_SQL_TRACE;
function handle(prefix, impl) {
  for (const name of Object.keys(impl)) {
    ipcMain.handle(prefix + ':' + name, async (_event, options) => {
      if (TRACE) {
        const o = options || {};
        const sql = o.statement || (o.set ? o.set.length + ' stmts: ' + o.set.slice(0, 2).map(s => s.statement.slice(0, 60)).join(' | ') : '');
        console.log('[trace]', prefix + ':' + name, o.database || o.path || '', sql.slice(0, 160));
      }
      const result = await impl[name](options || {});
      if (TRACE && /isDatabase|isSecretStored|getDatabaseList/.test(name)) console.log('[trace]   →', JSON.stringify(result), fs.existsSync(DATABASES()) ? fs.readdirSync(DATABASES()).join(',') : 'no databases dir', dbFile((options || {}).database || ''));
      return result;
    });
  }
}
handle('sqlite', sqlite);
handle('fs', files);
handle('reminders', reminders);
handle('server', server);
handle('mods', mods);
ipcMain.handle('http:request', (_event, options) => httpRequest(options || {}));
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, packaged }));
ipcMain.handle('app:openExternal', (_event, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return {}; });

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 860, minWidth: 380, minHeight: 560, backgroundColor: '#17181b', title: 'Memora', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true }
  });
  win.once('ready-to-show', () => win.show());
  // Links to other sites open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(ORIGIN)) { event.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  win.loadURL(ORIGIN + '/index.html');
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    // macOS routes Cmd+C / Cmd+V / Cmd+Q through the menu bar, so it keeps one.
    if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }].concat(packaged ? [] : [{ role: 'viewMenu' }])));
    else if (!packaged) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'viewMenu' }, { role: 'editMenu' }]));
    else Menu.setApplicationMenu(null);
    serveApp();
    // Backups and exports are downloads: Windows asks where to save each one.
    // Tests set MEMORA_DOWNLOAD_DIR to save them straight into a folder.
    if (process.env.MEMORA_DOWNLOAD_DIR) {
      require('electron').session.defaultSession.on('will-download', (_event, item) => {
        fs.mkdirSync(process.env.MEMORA_DOWNLOAD_DIR, { recursive: true });
        item.setSavePath(path.join(process.env.MEMORA_DOWNLOAD_DIR, item.getFilename()));
      });
    }
    createWindow();
  });
  app.on('before-quit', () => { if (serverProc) stopProcess(serverProc); for (const [name] of connections) sqlite.close({ database: name }); });
  app.on('window-all-closed', () => app.quit());
}
