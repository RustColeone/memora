// memo-crypto.js — password and key encryption shared by backups, database
// file exports, the on-phone database recovery key and last-known-good copies.
//
// One file format ("Memora envelope"), Web Crypto only:
//   bytes 0-7   magic  "MEMORA\x01\x00"
//   byte  8     kind   1 = password (PBKDF2-SHA256), 2 = raw key
//   bytes 9-12  PBKDF2 iterations, big-endian (0 for raw key)
//   bytes 13-28 salt (16 bytes; zero for raw key)
//   bytes 29-40 AES-GCM IV (12 bytes)
//   bytes 41-   AES-256-GCM ciphertext + tag
// The header is authenticated as additional data, so a changed header fails
// decryption like a wrong password does. A forgotten password cannot be
// recovered: there is no other copy of the key.
(function (global) {
  'use strict';

  var MAGIC = [0x4d, 0x45, 0x4d, 0x4f, 0x52, 0x41, 0x01, 0x00]; // "MEMORA" 1 0
  var HEADER = 41;
  var KIND_PASSWORD = 1;
  var KIND_KEY = 2;
  var ITERATIONS = 600000; // OWASP's 2023 PBKDF2-SHA256 guidance

  function subtle() {
    var c = global.crypto && global.crypto.subtle;
    if (!c) throw new Error('This browser cannot encrypt files (Web Crypto is unavailable).');
    return c;
  }
  function randomBytes(n) { var b = new Uint8Array(n); global.crypto.getRandomValues(b); return b; }
  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Expected binary data.');
  }

  function isEnvelope(data) {
    var b = toBytes(data);
    if (b.length < HEADER + 16) return false;
    for (var i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return false;
    return true;
  }
  function envelopeKind(data) { return isEnvelope(data) ? toBytes(data)[8] : 0; }
  // Just the 8-byte magic, for sniffing the start of a chosen file.
  function hasMagic(data) {
    var b = toBytes(data);
    if (b.length < MAGIC.length) return false;
    for (var i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return false;
    return true;
  }

  async function passwordKey(password, salt, iterations, usage) {
    if (!password) throw new Error('A password is required.');
    var base = await subtle().importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations },
      base, { name: 'AES-GCM', length: 256 }, false, usage);
  }
  async function rawKey(keyBytes, usage) {
    var k = toBytes(keyBytes);
    if (k.length !== 32) throw new Error('An encryption key must be 32 bytes.');
    return subtle().importKey('raw', k, { name: 'AES-GCM' }, false, usage);
  }

  function header(kind, iterations, salt, iv) {
    var h = new Uint8Array(HEADER);
    h.set(MAGIC, 0);
    h[8] = kind;
    new DataView(h.buffer).setUint32(9, iterations >>> 0, false);
    h.set(salt, 13);
    h.set(iv, 29);
    return h;
  }
  async function seal(kind, key, iterations, salt, plain) {
    var iv = randomBytes(12);
    var h = header(kind, iterations, salt, iv);
    var sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv, additionalData: h }, key, toBytes(plain)));
    var out = new Uint8Array(HEADER + sealed.length);
    out.set(h, 0); out.set(sealed, HEADER);
    return out;
  }
  async function open(data, keyFor) {
    var b = toBytes(data);
    if (!isEnvelope(b)) throw new Error('This file is not an encrypted Memora file.');
    var h = b.subarray(0, HEADER);
    var iterations = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(9, false);
    var key = await keyFor(b[8], iterations, b.slice(13, 29));
    try {
      return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: b.slice(29, 41), additionalData: h }, key, b.subarray(HEADER)));
    } catch (_e) {
      var error = new Error('Wrong password, or the file is damaged.');
      error.code = 'decrypt-failed';
      throw error;
    }
  }

  global.MemoCrypto = {
    ITERATIONS: ITERATIONS,
    isEnvelope: isEnvelope,
    hasMagic: hasMagic,
    isPasswordEnvelope: function (data) { return envelopeKind(data) === KIND_PASSWORD; },
    randomKey: function () { return randomBytes(32); },
    toBase64: function (bytes) {
      var b = toBytes(bytes), s = '';
      for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(s);
    },
    fromBase64: function (text) {
      var s = atob(String(text || '')), b = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return b;
    },
    // Password envelopes: backups, database file exports, the recovery key.
    encryptWithPassword: async function (plain, password, iterations) {
      var salt = randomBytes(16), n = iterations || ITERATIONS;
      return seal(KIND_PASSWORD, await passwordKey(password, salt, n, ['encrypt']), n, salt, plain);
    },
    decryptWithPassword: function (data, password) {
      return open(data, function (kind, iterations, salt) {
        if (kind !== KIND_PASSWORD) throw new Error('This file is not protected by a password.');
        return passwordKey(password, salt, iterations, ['decrypt']);
      });
    },
    // Raw-key envelopes: last-known-good copies sealed with the database key.
    encryptWithKey: async function (plain, keyBytes) {
      return seal(KIND_KEY, await rawKey(keyBytes, ['encrypt']), 0, new Uint8Array(16), plain);
    },
    decryptWithKey: function (data, keyBytes) {
      return open(data, function (kind) {
        if (kind !== KIND_KEY) throw new Error('This copy was not sealed with the database key.');
        return rawKey(keyBytes, ['decrypt']);
      });
    }
  };
})(window);
