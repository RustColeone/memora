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
    var v = (meta && meta.getAttribute('content') || 'default').trim().toLowerCase();
    return (v === 'finance' || v === 'default') ? v : 'default';
  }

  function registerService(name, service) {
    if (!name) return;
    registry[name] = service;
  }

  function getService(name) {
    return registry[name];
  }

  global.MemoContracts = {
    getApiBase: getApiBase,
    setApiBase: setApiBase,
    getMode: getMode,
    setMode: setMode,
    getVariant: getVariant,
    registerService: registerService,
    getService: getService
  };
})(window);
