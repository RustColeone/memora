(function (global) {
  'use strict';

  var registry = Object.create(null);

  function getApiBase() {
    return (typeof global.API_BASE === 'string') ? global.API_BASE : '';
  }

  function setApiBase(value) {
    global.API_BASE = (value || '').trim();
    return global.API_BASE;
  }

  function getMode() {
    return global.MODE || 'local';
  }

  function setMode(mode) {
    global.MODE = mode || 'local';
    return global.MODE;
  }

  function getVariant() {
    if (global.MEMO_VARIANT) {
      return String(global.MEMO_VARIANT).toLowerCase();
    }
    var meta = (typeof document !== 'undefined') ? document.querySelector('meta[name="memo-variant"]') : null;
    var metaValue = (meta && meta.getAttribute('content') || '').trim().toLowerCase();
    if (metaValue === 'finance' || metaValue === 'default') {
      return metaValue;
    }
    var stored = '';
    try { stored = (global.localStorage && global.localStorage.getItem('memo_variant') || '').trim().toLowerCase(); } catch (_ignored) {}
    return (stored === 'finance' || stored === 'default') ? stored : 'default';
  }

  // randomUUID is Chrome 92+. getRandomValues also works on the supported
  // older engines and on the self-hosted HTTP frontend.
  function createId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    return Array.prototype.map.call(bytes, function (byte, i) {
      return ([4, 6, 8, 10].indexOf(i) >= 0 ? '-' : '') + ('0' + byte.toString(16)).slice(-2);
    }).join('');
  }

  function registerService(name, service) {
    if (!name) return;
    registry[name] = service;
  }

  function getService(name) {
    return registry[name];
  }

  global.MemoContracts = {
    createId: createId,
    getApiBase: getApiBase,
    setApiBase: setApiBase,
    getMode: getMode,
    setMode: setMode,
    getVariant: getVariant,
    registerService: registerService,
    getService: getService
  };
})(window);
