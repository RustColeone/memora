#!/usr/bin/env node
// Start a packaged memora-server on a throwaway data folder, check it answers,
// then stop it. Used by the release workflow on every platform.
//   node build_tools/smoke-server.cjs [path/to/memora-server]
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
let exe = process.argv[2] || path.join(root, 'dist-server', 'memora-server', 'memora-server');
if (process.platform === 'win32' && !exe.endsWith('.exe')) exe += '.exe';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-smoke-'));
const port = 5077, password = 'smoke-test-password';
const proc = spawn(exe, ['--host', '127.0.0.1', '--port', String(port), '--base-dir', base],
  { env: Object.assign({}, process.env, { MEMO_SYNC_PASSWORD: password, PYTHONIOENCODING: 'utf-8' }) });
let log = '';
const done = (code, message) => {
  console.log(message);
  if (code) console.log(log.slice(-3000));
  proc.kill();
  setTimeout(() => { fs.rmSync(base, { recursive: true, force: true }); process.exit(code); }, 1500);
};
const timer = setTimeout(() => done(1, 'The server did not report ready within 60 s.'), 60000);
proc.stderr.on('data', (c) => { log += c; });
proc.on('exit', (code) => { if (code !== null) done(1, 'The server exited early with code ' + code + '.'); });
proc.stdout.on('data', async (chunk) => {
  log += chunk;
  const m = /MEMORA_SERVER_READY (\{.*\})/.exec(log);
  if (!m || timer._done) return;
  timer._done = true; clearTimeout(timer);
  try {
    const url = `http://127.0.0.1:${port}`;
    const config = await (await fetch(url + '/api/config')).json();
    const page = await fetch(url + '/index.html');
    const locked = await fetch(url + '/api/memos');
    const problems = [];
    if (!config || typeof config !== 'object') problems.push('/api/config is not JSON');
    if (!page.ok || !(await page.text()).includes('<html')) problems.push('/index.html did not load (' + page.status + ')');
    if (locked.status !== 401 && locked.status !== 403) problems.push('/api/memos answered ' + locked.status + ' without the sync password');
    if (problems.length) return done(1, 'Smoke test failed: ' + problems.join('; '));
    done(0, 'memora-server ' + JSON.parse(m[1]).version + ' answers on ' + url + ' and asks for the sync password.');
  } catch (error) { done(1, 'Smoke test failed: ' + error.message); }
});
