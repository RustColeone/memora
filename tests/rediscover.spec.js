// Finding the sync server after its address changes (memo-rediscover.js).
// The home network is simulated with routes: every address answers nothing,
// except the ones each test sets up. A server is accepted only with the same
// serverId AND a valid proof that it knows the sync password.
const { test, expect } = require('@playwright/test');
const crypto = require('crypto');

const ID = 'a'.repeat(32), PW = 'abcd-efgh-jkmn-pqrs', OLD = 'http://192.168.1.20:5050';

async function boot(page, { password = PW } = {}) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoRediscover && window.MemoAuth && window.MODE !== 'detecting', null, { timeout: 20000 });
  await page.evaluate(([old, id, pw]) => {
    localStorage.setItem('memo_server_identity', JSON.stringify({ url: old, id }));
    localStorage.setItem('memo_server_url', old);
    window.MemoContracts.setApiBase(old);
    if (pw) window.MemoAuth.setPassword(pw); else window.MemoAuth.setPassword('');
  }, [OLD, ID, password]);
}
// Route the simulated network: `servers` maps origin → how it answers /api/config.
async function network(page, servers) {
  const asked = [];
  await page.route(/^http:\/\/192\.168\.1\.\d+:\d+\//, async route => {
    const url = new URL(route.request().url());
    asked.push(url.origin);
    const s = servers[url.origin];
    if (!s || url.pathname !== '/api/config') return route.abort();
    const challenge = url.searchParams.get('challenge') || '';
    const body = { server: true, authRequired: s.authRequired !== false, serverId: s.id, collections: ['default'] };
    if (body.authRequired && s.password) body.proof = crypto.createHmac('sha256', s.password).update(challenge + ':' + s.id).digest('hex');
    await route.fulfill({ json: body });
  });
  return asked;
}

test('the same server at a new address is found, checked, and the app moves over by itself', async ({ page }) => {
  await boot(page);
  await network(page, { 'http://192.168.1.37:5050': { id: ID, password: PW } });
  const found = await page.evaluate(() => window.MemoRediscover.run(true));
  expect(found).toBe('http://192.168.1.37:5050');
  expect(await page.evaluate(() => [localStorage.getItem('memo_server_url'), window.MemoContracts.getApiBase(), JSON.parse(localStorage.getItem('memo_server_identity')).url]))
    .toEqual(['http://192.168.1.37:5050', 'http://192.168.1.37:5050', 'http://192.168.1.37:5050']);
});

test('the same computer on another port (the desktop app moved off a taken 5050) is tried first', async ({ page }) => {
  await boot(page);
  const asked = await network(page, { 'http://192.168.1.20:5052': { id: ID, password: PW }, 'http://192.168.1.99:5050': { id: ID, password: PW } });
  expect(await page.evaluate(() => window.MemoRediscover.run(true))).toBe('http://192.168.1.20:5052');
  expect(asked.indexOf('http://192.168.1.20:5052')).toBeLessThan(10);
});

test('an impostor with the same id but no knowledge of the password is never trusted', async ({ page }) => {
  await boot(page);
  await network(page, {
    'http://192.168.1.40:5050': { id: ID, password: 'not-the-password' },   // copies the id, cannot prove the password
    'http://192.168.1.41:5050': { id: ID, authRequired: false },              // claims to need no password
    'http://192.168.1.42:5050': { id: 'b'.repeat(32), password: PW }          // a different Memora server
  });
  expect(await page.evaluate(() => window.MemoRediscover.run(true))).toBe(null);
  expect(await page.evaluate(() => localStorage.getItem('memo_server_url'))).toBe(OLD);
});

test('only home-network addresses are searched, and only for the server this app last synced with', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(() => ({
    lan: window.MemoRediscover.candidates('http://192.168.1.20:5050').length,
    public: window.MemoRediscover.candidates('https://memo.example.net').length,
    tailnet: window.MemoRediscover.candidates('http://100.101.102.103:5050').length
  }));
  expect(out).toEqual({ lan: 9 + 253, public: 0, tailnet: 0 });
  // A server set by hand (different from the remembered one) is left alone.
  await page.evaluate(() => { localStorage.setItem('memo_server_url', 'http://192.168.1.50:5050'); window.MemoContracts.setApiBase('http://192.168.1.50:5050'); });
  await network(page, { 'http://192.168.1.37:5050': { id: ID, password: PW } });
  expect(await page.evaluate(() => window.MemoRediscover.run(true))).toBe(null);
});
