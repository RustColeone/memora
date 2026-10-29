/**
 * End-to-end sync test against the self-hosted sync server — ALL THREE pages.
 *
 *   node tests/sync-e2e.js
 *
 * Spins up an ISOLATED backend (temp DB) + a static "frontend-only" host, then,
 * for each variant (memo / finance / planner), drives two real browser clients:
 *   - Client A: the backend-hosted web version (served by Flask → server mode).
 *   - Client B: the frontend-only build (static host) pointed at the sync server.
 * Adds an entry on each, performs a sync, and verifies the data converges on both
 * clients (and on the backend, for the memo/finance variants).
 */
const { chromium } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');
const BACKEND_PORT = 5071;
const STATIC_PORT = 5098;
const BACKEND = `http://localhost:${BACKEND_PORT}`;
const STATIC = `http://localhost:${STATIC_PORT}`;

const procs = [];
let backendDiagnostics = '';
const cleanup = () => procs.forEach((p) => { try { p.kill('SIGKILL'); } catch (_e) {} });

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve({ status: r.statusCode, body: d })); }).on('error', reject);
  });
}
async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await httpGet(url); if (r.status >= 200 && r.status < 500) return; } catch (_e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timed out waiting for ' + url);
}

const results = [];
const check = (cond, label) => { results.push([!!cond, label]); console.log((cond ? '  ok   ' : '  FAIL ') + label); };

async function addEntryViaUI(page, text) {
  // The FAB is a tap-vs-hold gesture (attachHold), so a synthetic click doesn't
  // register as a tap. Open the modal directly and click Save via JS — this still
  // runs memo-core's real onSaveEntry -> persist -> addOperation path.
  await page.evaluate(() => window.openEntryModal && window.openEntryModal(null));
  await page.waitForSelector('#entryDlg[open]', { timeout: 5000 });
  await page.fill('#desc', text);
  await page.evaluate(() => document.getElementById('saveBtn').click());
  await page.waitForTimeout(900);
}
async function syncRound(page) {
  await page.evaluate(async () => {
    const q = window.OperationQueue;
    if (!q || !q.processQueue) return;
    await q.processQueue();
  });
  await page.waitForTimeout(600);
}
const has = (arr, v) => arr.filter((x) => x === v).length;

async function addEntryWithImageViaUI(page, text, imgPath) {
  await page.evaluate(() => window.openEntryModal && window.openEntryModal(null));
  await page.waitForSelector('#entryDlg[open]', { timeout: 5000 });
  await page.setInputFiles('#images', imgPath);
  await page.waitForTimeout(400); // let the file-input change handler register the image
  await page.fill('#desc', text);
  await page.evaluate(() => document.getElementById('saveBtn').click());
  await page.waitForTimeout(1800); // blob write + queue + upload
}

// Regression for the create-with-files sync bug: memo-core built a FLAT opData
// so op.data was undefined — files never uploaded and the entry synced with
// images:[]. Also covers the images-not-linked half. A single image entry made
// on A must reach the server WITH its image, be downloadable, and land on B.
async function checkImageSync(browser, imgPath) {
  console.log('\n── IMAGE SYNC (create-with-file regression) ──────────────────');
  const serverReady = (p) => p.waitForFunction(
    () => (window.MemoContracts && window.MemoContracts.getMode && window.MemoContracts.getMode() === 'server') || window.MODE === 'server',
    null, { timeout: 15000 });
  const syncClientReady = (p) => p.waitForFunction(expected =>
    window.MemoRuntime?.getMode?.() === 'local' && window.MemoRuntime?.getApiBase?.() === expected,
    BACKEND, { timeout: 15000 });

  const A = await (await browser.newContext()).newPage();
  await A.goto(`${BACKEND}/index.html`);
  await serverReady(A);
  const desc = 'img-regression-' + Date.now();
  await addEntryWithImageViaUI(A, desc, imgPath);
  await syncRound(A);

  const memos = JSON.parse((await httpGet(`${BACKEND}/api/memos?variant=default`)).body);
  const entry = memos.find((m) => m.description === desc);
  check(!!entry, '[image] sync server stored the entry');
  check(entry && (entry.images || []).length >= 1, '[image] entry synced WITH its image (images non-empty)');

  let fileOk = false;
  if (entry && entry.images && entry.images[0]) {
    const u = String(entry.images[0]);
    const url = u.startsWith('http') ? u : `${BACKEND}${u}`;
    try { fileOk = (await httpGet(url)).status === 200; } catch (_e) {}
  }
  check(fileOk, '[image] uploaded file is downloadable from the server');

  const B = await (await browser.newContext()).newPage();
  await B.goto(`${STATIC}/index.html`);
  await B.evaluate((u) => localStorage.setItem('memo_server_url', u), BACKEND);
  await B.reload();
  await syncClientReady(B);
  await syncRound(B);
  const bImgCount = await B.evaluate((d) => {
    const e = window.MemoCore.getState().db.entries.find((x) => x.description === d);
    return e ? (e.images || []).length : -1;
  }, desc);
  check(bImgCount >= 1, '[image] Client B pulled the entry with its image');
  if (bImgCount < 1) console.log('  IMAGE DIAG:', JSON.stringify(await B.evaluate(() => ({
    result: OperationQueue.lastResult, cursor: OperationQueue.lastServerOpId,
    entries: MemoCore.getState().db.entries, stored: MemoStateDb.loadEntries('default')
  }))));

  await A.context().close();
  await B.context().close();
}

// ── per-variant scenario definitions ────────────────────────────────────────
const memoLike = (page, variant, a, b) => ({
  page, variant, a, b,
  serverReady: (p) => p.waitForFunction(
    () => (window.MemoContracts && window.MemoContracts.getMode && window.MemoContracts.getMode() === 'server') || window.MODE === 'server',
    null, { timeout: 15000 }),
  mode: (p) => p.evaluate(() => (window.MemoContracts.getMode && window.MemoContracts.getMode()) || window.MODE),
  add: addEntryViaUI,
  read: (p) => p.evaluate(() => window.MemoCore.getState().db.entries.filter((e) => !e.deletedAt).map((e) => e.description)),
  backend: async () => JSON.parse((await httpGet(`${BACKEND}/api/memos?variant=${variant}`)).body).filter((m) => !m.deletedAt).map((m) => m.description),
});

const SCENARIOS = [
  memoLike('index.html', 'default', 'memo-alpha', 'memo-beta'),
  memoLike('finance.html', 'finance', 'fin-alpha', 'fin-beta'),
  {
    page: 'planner.html', variant: 'planner', a: 'plan-alpha', b: 'plan-beta',
    serverReady: (p) => p.waitForFunction(
      () => window.Planner && window.Planner.Store && window.Planner.Store._syncEnabled === true, null, { timeout: 15000 }),
    mode: (p) => p.evaluate(() => (window.Planner && window.Planner.Store && window.Planner.Store._syncEnabled) ? 'server' : 'local'),
    add: (p, t) => p.evaluate((title) => window.Planner.Store.addTodo({ title }), t).then(() => p.waitForTimeout(400)),
    read: (p) => p.evaluate(() => window.Planner.Store.state.todos.map((t) => t.title)),
    backend: null, // verified via client convergence (B can only see A's todo if the server relayed it)
  },
];

async function runScenario(browser, s) {
  console.log(`\n── ${s.variant.toUpperCase()} (${s.page}) ─────────────────────────────`);

  // Client A: backend-hosted
  const A = await (await browser.newContext()).newPage();
  await A.goto(`${BACKEND}/${s.page}`);
  await s.serverReady(A);
  check(true, `[${s.variant}] Client A (backend-hosted) in SERVER mode`);
  await s.add(A, s.a);

  // Client B: frontend-only, pointed at the sync server
  const B = await (await browser.newContext()).newPage();
  await B.goto(`${STATIC}/${s.page}`);
  check((await s.mode(B)) !== 'server', `[${s.variant}] Client B (frontend-only) starts LOCAL`);
  await B.evaluate((u) => localStorage.setItem('memo_server_url', u), BACKEND);
  await B.reload();
  if (s.variant === 'planner') await s.serverReady(B);
  else await B.waitForFunction(expected => window.MemoRuntime?.getMode?.() === 'local'
    && window.MemoRuntime?.getApiBase?.() === expected, BACKEND, { timeout: 15000 });
  check(true, `[${s.variant}] Client B connected to the sync server`);
  await s.add(B, s.b);

  // Sync (pull each other's ops)
  for (let i = 0; i < 3; i++) { await syncRound(A); await syncRound(B); }

  const da = await s.read(A);
  const db_ = await s.read(B);
  console.log(`  A sees: ${JSON.stringify(da)}\n  B sees: ${JSON.stringify(db_)}`);
  if (has(da, s.b) !== 1 || has(db_, s.a) !== 1) {
    const diag = (p) => p.evaluate(async (variant) => {
      const q = window.OperationQueue;
      const apiBase = (window.MemoContracts.getApiBase && window.MemoContracts.getApiBase()) || '';
      const pull = await fetch(`${apiBase}/api/operations/pull?variant=${variant}&sinceOpId=0`, { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
      return { variant, mode: (window.MemoContracts.getMode && window.MemoContracts.getMode()), lastServerOpId: q && q.lastServerOpId,
               queue: q && q.queue.map((o) => `${o.type}/${o.synced ? 'synced' : 'UNSYNCED'}${o.lastError ? '/' + o.lastError : ''}`),
               serverOps: (pull.operations || []).map((o) => `${o.opId}:${o.type}`) };
    }, s.variant);
    console.log('  DIAG A:', JSON.stringify(await diag(A)));
    console.log('  DIAG B:', JSON.stringify(await diag(B)));
  }
  check(has(da, s.a) === 1 && has(da, s.b) === 1, `[${s.variant}] Client A converged (both, no dupes)`);
  check(has(db_, s.a) === 1 && has(db_, s.b) === 1, `[${s.variant}] Client B converged (both, no dupes)`);
  if (s.backend) {
    const bl = await s.backend();
    console.log(`  backend: ${JSON.stringify(bl)}`);
    check(has(bl, s.a) === 1 && has(bl, s.b) === 1, `[${s.variant}] Sync server persisted both exactly once`);
  }

  await A.context().close();
  await B.context().close();
}

async function checkRestartSync(browser, stopServer, startServer) {
  console.log('\n── SERVER RESTART WITH A PENDING OFFLINE EDIT ───────────────');
  const nameA = 'restart-before-' + Date.now(), nameB = 'restart-offline-' + Date.now();
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
  const status = (page, name) => page.evaluate(label => ({
    inStore: MemoStateDb.loadEntries('default').some(e => e.description === label),
    inView: MemoCore.getState().db.entries.some(e => e.description === label),
    mode: MemoRuntime.getMode(),
    pending: OperationQueue.readState('default').queue.filter(op => !op.synced).length,
    saving: MemoStateDb.getMetadataHealth(),
  }), name);
  try {
    for (const page of [A, B]) {
      await page.goto(`${STATIC}/index.html`);
      await page.evaluate(url => localStorage.setItem('memo_server_url', url), BACKEND);
      await page.reload();
      await page.evaluate(() => MemoAppReady);
    }
    await addEntryViaUI(A, nameA);
    await syncRound(A);
    await syncRound(B);
    check((await B.evaluate(name => MemoStateDb.loadEntries('default').some(e => e.description === name), nameA)),
      '[restart] second client received entry before server shutdown');

    await stopServer();
    await addEntryViaUI(B, nameB);
    const beforeReload = await status(B, nameB);
    await B.reload();
    await B.evaluate(() => MemoAppReady);
    const afterReload = await status(B, nameB);
    if (!beforeReload.inStore || !afterReload.inStore) console.log('  offline diagnostic:', JSON.stringify({ beforeReload, afterReload }));
    check(beforeReload.inStore && afterReload.inStore && afterReload.pending > 0,
      '[restart] edit survived client reload while server was unavailable');

    await startServer();
    for (let i = 0; i < 3; i++) {
      await B.evaluate(() => OperationQueue.manualSync());
      await A.evaluate(() => OperationQueue.manualSync());
    }
    const entriesA = await A.evaluate(() => MemoStateDb.loadEntries('default').map(e => e.description));
    const entriesB = await B.evaluate(() => MemoStateDb.loadEntries('default').map(e => e.description));
    const server = JSON.parse((await httpGet(`${BACKEND}/api/memos?variant=default`)).body).map(e => e.description);
    if (!server.includes(nameB)) console.log('  restart diagnostic:', JSON.stringify({ A: await status(A, nameB), B: await status(B, nameB) }));
    check(has(entriesA, nameA) === 1 && has(entriesA, nameB) === 1,
      '[restart] first client converged without duplicates');
    check(has(entriesB, nameA) === 1 && has(entriesB, nameB) === 1,
      '[restart] offline client converged without duplicates');
    check(has(server, nameA) === 1 && has(server, nameB) === 1,
      '[restart] same backend database retained and accepted both edits exactly once');
  } finally {
    await A.context().close();
    await B.context().close();
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-sync-'));

  console.log('· Building www/ ...');
  const b = spawnSync('node', ['build_tools/build.js'], { cwd: REPO, encoding: 'utf8' });
  if (b.status !== 0) throw new Error('build failed: ' + (b.stderr || b.stdout));

  console.log(`· Starting isolated backend on ${BACKEND_PORT} (data=${tmp}) ...`);
  const startBackend = () => {
    const child = spawn('python', ['backend/server.py'], {
    cwd: REPO,
    env: { ...process.env, MEMO_DATA_DIR: path.join(tmp, 'data'), MEMO_UPLOAD_DIR: path.join(tmp, 'uploads'),
           MEMO_PORT: String(BACKEND_PORT), MEMO_DEBUG: 'false', USE_SERVER_BACKEND: 'true', LLM_PROVIDER: '', PYTHONUTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { backendDiagnostics = (backendDiagnostics + chunk).slice(-10000); });
    return child;
  };
  let backend = startBackend();
  procs.push(backend);
  console.log(`· Starting static frontend host on ${STATIC_PORT} ...`);
  procs.push(spawn('node', ['tests/static-server.js'], { cwd: REPO, env: { ...process.env, PORT: String(STATIC_PORT) }, stdio: 'ignore' }));

  await waitFor(`${BACKEND}/api/config`, 25000);
  await waitFor(`${STATIC}/index.html`, 10000);
  console.log('· Both servers up.');

  const browser = await chromium.launch({ channel: 'msedge' });
  for (const s of SCENARIOS) await runScenario(browser, s);
  // Create-with-files regression (single image entry, memo variant).
  const pngPath = path.join(tmp, 'regression.png');
  fs.writeFileSync(pngPath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));
  await checkImageSync(browser, pngPath);
  await checkRestartSync(browser, async () => {
    const exited = new Promise(resolve => backend.once('exit', resolve));
    backend.kill('SIGKILL');
    await exited;
  }, async () => {
    backend = startBackend();
    procs.push(backend);
    await waitFor(`${BACKEND}/api/config`, 25000);
  });
  await browser.close();
  cleanup();

  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
}

process.on('SIGINT', () => { cleanup(); process.exit(1); });
main().catch((e) => { console.error('\nERROR:', e.message, '\nBackend diagnostics:\n' + backendDiagnostics); cleanup(); process.exit(1); });
