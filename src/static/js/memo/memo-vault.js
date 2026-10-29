// memo-vault.js — the Vault: secure notes and AI keys, encrypted end to end.
//
// One random 32-byte vault key encrypts every item (title and content
// together) with AES-256-GCM (memo-crypto.js). The vault password seals that
// key in the "keyring" document; on a phone the fingerprint can seal it too
// (VaultKey plugin, device-only). Items and the keyring are documents in the
// 'vault' collection: they sync through the operation log and travel in
// backups, but only ever as ciphertext — the server and backup files cannot
// read them. Changing the password re-seals only the key, so it is one change.
//
// The key lives in memory while unlocked and is dropped 5 minutes after the
// app leaves the screen (and on every restart). AI keys are vault items too;
// a working copy of them stays usable while the vault is locked, so the AI
// never asks for an unlock: on a phone inside the already-encrypted app
// database, in a browser for this session only.
(function (global) {
  'use strict';

  var COLLECTION = 'vault';
  var KEYRING_ID = 'vault-keyring';
  var CHECK_TEXT = 'memora-vault-check';
  var RELOCK_MS = 5 * 60 * 1000;
  var CLIPBOARD_CLEAR_MS = 60 * 1000;
  var MIN_PASSWORD = 8;
  var BIO_KEY = 'memo_vault_bio';            // device-only sealed key (localStorage)
  var AI_CACHE_KEY = 'vault_ai_cache';        // AI key working copy
  var PROVIDERS = {
    // DeepSeek first: the low-cost default. `vision` is for the default model;
    // MemoAiKey.supportsVision(provider, model) decides per key.
    deepseek: { label: 'DeepSeek', model: 'deepseek-flash', vision: true, note: 'Low cost' },
    gemini: { label: 'Gemini', model: 'gemini-3.8-flash', vision: true, note: 'Free tier' },
    openai: { label: 'OpenAI', model: 'gpt-6-luna', vision: true, note: '' },
    anthropic: { label: 'Claude', model: 'claude-sonnet-5-5', vision: true, note: '' },
    custom: { label: 'Custom (OpenAI-compatible)', model: '', vision: false, note: 'OpenRouter, Groq, Ollama…' }
  };

  var session = { key: null, cache: new Map(), hiddenAt: 0 };

  function sdb() { var s = global.MemoStateDb; return s && s.ready && s.ready() ? s : null; }
  function crypto() { return global.MemoCrypto; }
  function native() { var C = global.Capacitor; return !!(C && C.isNativePlatform && C.isNativePlatform()); }
  function plugin(name) { var C = global.Capacitor; return C && C.Plugins && C.Plugins[name]; }
  function t(s, v) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s, v) : String(s).replace(/\{(\w+)\}/g, function (_m, k) { return v && v[k] != null ? v[k] : ''; }); }
  function emit(reason) { try { global.dispatchEvent(new CustomEvent('memo:vault-change', { detail: { reason: reason } })); } catch (_e) {} }
  function newId() { return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
  function b64(bytes) { return crypto().toBase64(bytes); }
  function unb64(text) { return crypto().fromBase64(text); }
  function utf8(text) { return new TextEncoder().encode(String(text)); }
  function text(bytes) { return new TextDecoder().decode(bytes); }

  function docs() { var s = sdb(); return s ? (s.loadDocs(COLLECTION) || []) : []; }
  function live(doc) { return doc && !doc.deletedAt; }
  function keyring() { return docs().filter(function (d) { return d.id === KEYRING_ID && live(d); })[0] || null; }

  // Writes go through the operation log so they sync; without it (very early
  // boot) the document is stored directly and syncs on its next change.
  async function write(type, id, doc) {
    var q = global.OperationQueue;
    // A create may reuse the id of a deleted document (a new Vault after
    // "Delete Vault" reuses the keyring id): clear the deletion explicitly,
    // since a create merges onto what is already stored.
    if (type === 'create') doc = Object.assign({}, doc, { deletedAt: null, deletedBy: null });
    if (q && typeof q.addOperation === 'function') {
      await q.addOperation(type, id, type === 'delete' ? {} : { data: doc }, { variant: COLLECTION });
      return;
    }
    var s = sdb();
    if (!s) throw new Error(t('The local database is not ready.'));
    var all = s.loadDocs(COLLECTION) || [];
    var now = new Date().toISOString();
    var index = all.findIndex(function (d) { return d.id === id; });
    if (type === 'delete') { if (index >= 0) all[index] = Object.assign({}, all[index], { deletedAt: now }); }
    else if (index >= 0) all[index] = Object.assign({}, all[index], doc, { updatedAt: now });
    else all.push(Object.assign({ createdAt: now }, doc, { id: id, updatedAt: now }));
    s.saveDocs(COLLECTION, all);
    if (s.flush) await s.flush();
  }

  // ── session ──
  function exists() { return !!keyring(); }
  function isUnlocked() { return !!session.key; }
  function requireKey() { if (!session.key) { var e = new Error(t('The Vault is locked.')); e.code = 'locked'; throw e; } return session.key; }

  async function checkKey(ring, key) {
    if (!ring) return false;
    if (!ring.check) return true; // keyrings always carry a check; tolerate none
    try { return text(await crypto().decryptWithKey(unb64(ring.check), key)) === CHECK_TEXT; }
    catch (_e) { return false; }
  }
  async function takeKey(key) {
    session.key = key;
    session.cache = new Map();
    session.hiddenAt = 0;
    await migrateLegacyAiKeys();
    await refreshAiCache();
    emit('unlocked');
  }

  async function setup(password) {
    if (exists()) throw new Error(t('A Vault already exists.'));
    if (String(password || '').length < MIN_PASSWORD) throw new Error(t('Use at least {n} characters.', { n: MIN_PASSWORD }));
    var key = crypto().randomKey();
    var ring = {
      id: KEYRING_ID, kind: 'keyring', v: 1,
      ring: b64(await crypto().encryptWithPassword(key, password)),
      check: b64(await crypto().encryptWithKey(utf8(CHECK_TEXT), key))
    };
    await write('create', KEYRING_ID, ring);
    await takeKey(key);
  }

  async function unlock(password) {
    var ring = keyring();
    if (!ring) throw new Error(t('There is no Vault yet.'));
    var key;
    try { key = await crypto().decryptWithPassword(unb64(ring.ring), password); }
    catch (_e) { var e = new Error(t('Wrong password.')); e.code = 'wrong-password'; throw e; }
    if (key.length !== 32 || !(await checkKey(ring, key))) { var bad = new Error(t('Wrong password.')); bad.code = 'wrong-password'; throw bad; }
    await takeKey(key);
    // The password worked: a phone with fingerprint unlock on but a stale
    // sealed key (fingerprints changed) seals the current key again.
    if (bioWanted() && !bioSealed()) enableBio().catch(function () {});
  }

  function lock(reason) {
    if (!session.key) return;
    session.key = null;
    session.cache = new Map();
    emit(reason || 'locked');
  }

  async function changePassword(password) {
    var key = requireKey();
    if (String(password || '').length < MIN_PASSWORD) throw new Error(t('Use at least {n} characters.', { n: MIN_PASSWORD }));
    var ring = keyring();
    await write('update', KEYRING_ID, Object.assign({}, ring, { ring: b64(await crypto().encryptWithPassword(key, password)) }));
    emit('password');
  }

  // Forgotten password: delete every vault document everywhere, then a new
  // Vault can be made. The old items cannot be recovered by anyone.
  async function erase() {
    var all = docs().filter(live);
    for (var i = 0; i < all.length; i++) await write('delete', all[i].id);
    session.key = null;
    session.cache = new Map();
    forgetBio();
    writeAiCache(null);
    emit('erased');
  }

  // ── items ──
  async function decryptDoc(doc) {
    var hit = session.cache.get(doc.id);
    if (hit && hit.cipher === doc.cipher) return hit.item;
    var item;
    try {
      item = JSON.parse(text(await crypto().decryptWithKey(unb64(doc.cipher), session.key)));
    } catch (_e) {
      item = null; // made with another vault key (e.g. a second Vault set up offline)
    }
    if (item) item = Object.assign(item, { id: doc.id, createdAt: doc.createdAt, updatedAt: doc.updatedAt });
    session.cache.set(doc.id, { cipher: doc.cipher, item: item });
    return item;
  }
  // Every readable item, newest first, plus how many could not be opened.
  async function list() {
    requireKey();
    var items = [], unreadable = 0;
    var all = docs().filter(function (d) { return live(d) && d.kind === 'item' && d.cipher; });
    for (var i = 0; i < all.length; i++) {
      var item = await decryptDoc(all[i]);
      if (item) items.push(item); else unreadable++;
    }
    items.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    return { items: items, unreadable: unreadable };
  }
  function clean(item) {
    var out = { type: item.type === 'ai-key' ? 'ai-key' : 'note' };
    if (out.type === 'note') {
      out.title = String(item.title || '').slice(0, 200);
      out.content = String(item.content || '').slice(0, 20000);
    } else {
      out.provider = PROVIDERS[item.provider] ? item.provider : 'custom';
      out.label = String(item.label || '').slice(0, 80);
      out.apiKey = String(item.apiKey || '').trim().slice(0, 500);
      out.model = String(item.model || '').trim().slice(0, 120);
      out.baseUrl = String(item.baseUrl || '').trim().slice(0, 300);
      out.isDefault = !!item.isDefault;
    }
    return out;
  }
  async function save(item) {
    var key = requireKey();
    var body = clean(item);
    var id = item.id || newId();
    var existing = docs().some(function (d) { return d.id === id && live(d); });
    var cipher = b64(await crypto().encryptWithKey(utf8(JSON.stringify(body)), key));
    await write(existing ? 'update' : 'create', id, { id: id, kind: 'item', v: 1, cipher: cipher });
    session.cache.delete(id);
    if (body.type === 'ai-key') await refreshAiCache();
    emit('saved');
    return id;
  }
  async function remove(id) {
    requireKey();
    var was = await getItem(id);
    await write('delete', id);
    session.cache.delete(id);
    if (was && was.type === 'ai-key') await refreshAiCache();
    emit('removed');
  }
  async function getItem(id) {
    requireKey();
    var doc = docs().filter(function (d) { return d.id === id && live(d); })[0];
    return doc ? decryptDoc(doc) : null;
  }

  // Per-line copy: "PASS: hunter2" copies "hunter2"; other lines copy whole.
  function parseLines(content) {
    return String(content || '').split(/\r?\n/).filter(function (line) { return line.trim(); }).map(function (line) {
      var m = line.match(/^\s*([^:\n]{1,40}?)\s*:\s*(.+?)\s*$/);
      return m && !/^https?$/i.test(m[1]) ? { label: m[1], value: m[2], line: line } : { label: '', value: line.trim(), line: line };
    });
  }

  // ── AI keys ──
  async function aiKeys() {
    var all = (await list()).items.filter(function (i) { return i.type === 'ai-key'; });
    all.sort(function (a, b) { return (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || String(a.label || a.provider).localeCompare(String(b.label || b.provider)); });
    return all;
  }
  async function setDefaultAiKey(id) {
    var keys = await aiKeys();
    for (var i = 0; i < keys.length; i++) {
      var want = keys[i].id === id;
      if (!!keys[i].isDefault !== want) await save(Object.assign({}, keys[i], { isDefault: want }));
    }
  }
  function aiStore() {
    if (native() && sdb()) return { get: function () { return sdb().getItem(AI_CACHE_KEY); }, set: function (v) { if (v) sdb().setItem(AI_CACHE_KEY, v); else if (sdb().removeItem) sdb().removeItem(AI_CACHE_KEY); else sdb().setItem(AI_CACHE_KEY, null); } };
    return {
      get: function () { try { return JSON.parse(sessionStorage.getItem('memo_' + AI_CACHE_KEY) || 'null'); } catch (_e) { return null; } },
      set: function (v) { try { if (v) sessionStorage.setItem('memo_' + AI_CACHE_KEY, JSON.stringify(v)); else sessionStorage.removeItem('memo_' + AI_CACHE_KEY); } catch (_e) {} }
    };
  }
  function writeAiCache(value) { try { aiStore().set(value); } catch (_e) {} if (global.MemoAiKey && global.MemoAiKey.applyAvailability) global.MemoAiKey.applyAvailability(); }
  async function refreshAiCache() {
    if (!session.key) return;
    var keys = await aiKeys();
    var withDefault = keys.length && !keys.some(function (k) { return k.isDefault; }) ? keys.map(function (k, i) { return Object.assign({}, k, { isDefault: i === 0 }); }) : keys;
    writeAiCache(withDefault.length ? {
      keys: withDefault.map(function (k) {
        return { id: k.id, provider: k.provider, label: k.label || PROVIDERS[k.provider].label, apiKey: k.apiKey,
          model: k.model || PROVIDERS[k.provider].model, baseUrl: k.baseUrl, isDefault: !!k.isDefault };
      })
    } : null);
  }
  // AI features read this; it works while the vault is locked.
  function aiKeyCache() { try { var v = aiStore().get(); return v && Array.isArray(v.keys) ? v.keys : []; } catch (_e) { return []; } }
  function activeAiKey(id) {
    var keys = aiKeyCache();
    return (id && keys.filter(function (k) { return k.id === id; })[0]) || keys.filter(function (k) { return k.isDefault; })[0] || keys[0] || null;
  }

  // Keys saved by older builds in plain localStorage move into the Vault the
  // first time it is unlocked, then the plain copies are deleted.
  async function migrateLegacyAiKeys() {
    var legacy = [];
    var chosen = '';
    try { chosen = localStorage.getItem('memo_ai_key_provider') || ''; } catch (_e) {}
    ['gemini', 'openai', 'deepseek'].forEach(function (p) {
      var k = '';
      try { k = localStorage.getItem('memo_ai_key_' + p) || ''; } catch (_e) {}
      if (k) legacy.push({ provider: p, apiKey: k });
    });
    if (!legacy.length) return;
    var existing = (await list()).items.filter(function (i) { return i.type === 'ai-key'; });
    var hasDefault = existing.some(function (k) { return k.isDefault; });
    for (var i = 0; i < legacy.length; i++) {
      if (existing.some(function (k) { return k.provider === legacy[i].provider && k.apiKey === legacy[i].apiKey; })) continue;
      await save({ type: 'ai-key', provider: legacy[i].provider, apiKey: legacy[i].apiKey,
        isDefault: !hasDefault && (legacy[i].provider === chosen || (!chosen && i === 0)) });
    }
    try {
      ['gemini', 'openai', 'deepseek'].forEach(function (p) { localStorage.removeItem('memo_ai_key_' + p); });
      localStorage.removeItem('memo_ai_key_provider');
    } catch (_e) {}
  }

  // ── fingerprint (phone only) ──
  function bioPlugin() { return native() ? plugin('VaultKey') : null; }
  function bioSealed() { try { return !!JSON.parse(localStorage.getItem(BIO_KEY) || 'null'); } catch (_e) { return false; } }
  function bioWanted() { try { return localStorage.getItem(BIO_KEY + '_on') === '1'; } catch (_e) { return false; } }
  async function bioStatus() {
    var p = bioPlugin();
    if (!p) return { supported: false, available: false, enabled: false };
    try { var s = await p.status(); return { supported: true, available: !!s.available, enabled: bioSealed() && !!s.hasKey }; }
    catch (_e) { return { supported: true, available: false, enabled: false }; }
  }
  async function enableBio() {
    var key = requireKey();
    var p = bioPlugin();
    if (!p) throw new Error(t('Fingerprint unlock needs the Memora app.'));
    var r = await p.protect({ secret: b64(key), title: t('Use fingerprint for the Vault') });
    if (!r || r.cancelled || !r.iv) return false;
    try { localStorage.setItem(BIO_KEY, JSON.stringify({ iv: r.iv, data: r.data })); localStorage.setItem(BIO_KEY + '_on', '1'); } catch (_e) {}
    emit('bio');
    return true;
  }
  function forgetBio() {
    try { localStorage.removeItem(BIO_KEY); localStorage.removeItem(BIO_KEY + '_on'); } catch (_e) {}
    var p = bioPlugin();
    if (p && p.forget) p.forget().catch(function () {});
  }
  function disableBio() { forgetBio(); emit('bio'); }
  // Resolves true (unlocked), false (cancelled), or throws with code
  // 'bio-reset' when the sealed key can no longer be opened.
  async function unlockWithBio() {
    var p = bioPlugin(), sealed = null;
    try { sealed = JSON.parse(localStorage.getItem(BIO_KEY) || 'null'); } catch (_e) {}
    if (!p || !sealed) return false;
    var r = await p.reveal({ iv: sealed.iv, data: sealed.data, title: t('Unlock the Vault') });
    if (!r || r.cancelled) return false;
    var reset = function () {
      try { localStorage.removeItem(BIO_KEY); } catch (_e) {}
      var e = new Error(t('Your fingerprints changed. Enter the Vault password once to turn fingerprint unlock back on.'));
      e.code = 'bio-reset';
      throw e;
    };
    if (r.invalidated || !r.secret) reset();
    var key = unb64(r.secret);
    if (key.length !== 32 || !(await checkKey(keyring(), key))) reset();
    await takeKey(key);
    return true;
  }

  // ── clipboard ──
  async function copySecret(value) {
    var C = plugin('ClipboardImage');
    if (native() && C && C.copySecret) { await C.copySecret({ text: String(value), clearAfterMs: CLIPBOARD_CLEAR_MS }); return; }
    await navigator.clipboard.writeText(String(value));
    // Browsers only let a focused page write the clipboard: best effort.
    setTimeout(function () {
      try { if (document.hasFocus()) navigator.clipboard.writeText('').catch(function () {}); } catch (_e) {}
    }, CLIPBOARD_CLEAR_MS);
  }

  // ── relock ──
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { session.hiddenAt = Date.now(); return; }
    if (session.key && session.hiddenAt && Date.now() - session.hiddenAt >= RELOCK_MS) lock('timeout');
    session.hiddenAt = 0;
  });
  // Synced changes (another device) replace documents: re-read on the next list.
  global.addEventListener('memo:sync-state', function () { if (session.key) emit('synced'); });

  global.MemoVault = {
    PROVIDERS: PROVIDERS,
    MIN_PASSWORD: MIN_PASSWORD,
    RELOCK_MS: RELOCK_MS,
    exists: exists,
    isUnlocked: isUnlocked,
    setup: setup,
    unlock: unlock,
    lock: lock,
    changePassword: changePassword,
    erase: erase,
    list: list,
    getItem: getItem,
    save: save,
    remove: remove,
    parseLines: parseLines,
    aiKeys: aiKeys,
    setDefaultAiKey: setDefaultAiKey,
    aiKeyCache: aiKeyCache,
    activeAiKey: activeAiKey,
    bioStatus: bioStatus,
    enableBio: enableBio,
    disableBio: disableBio,
    unlockWithBio: unlockWithBio,
    copySecret: copySecret
  };
})(window);
