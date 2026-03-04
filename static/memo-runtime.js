(function (global) {
  'use strict';

  function getContracts() {
    return global.MemoContracts || null;
  }

  function getService(name, fallback) {
    var contracts = getContracts();
    if (contracts && typeof contracts.getService === 'function') {
      var svc = contracts.getService(name);
      if (svc) return svc;
    }
    return fallback;
  }

  function getApiBase() {
    var contracts = getContracts();
    if (contracts && typeof contracts.getApiBase === 'function') {
      return contracts.getApiBase();
    }
    return (typeof global.API_BASE === 'string') ? global.API_BASE : '';
  }

  function setApiBase(value) {
    var contracts = getContracts();
    if (contracts && typeof contracts.setApiBase === 'function') {
      return contracts.setApiBase(value);
    }
    global.API_BASE = (value || '').trim();
    return global.API_BASE;
  }

  function getMode() {
    var contracts = getContracts();
    if (contracts && typeof contracts.getMode === 'function') {
      return contracts.getMode();
    }
    return global.MODE || 'local';
  }

  function setMode(mode) {
    var contracts = getContracts();
    if (contracts && typeof contracts.setMode === 'function') {
      return contracts.setMode(mode);
    }
    global.MODE = mode || 'local';
    return global.MODE;
  }

  function getServerAPI() {
    return getService('serverApi', global.ServerAPI);
  }

  global.MemoRuntime = {
    getContracts: getContracts,
    getService: getService,
    getApiBase: getApiBase,
    setApiBase: setApiBase,
    getMode: getMode,
    setMode: setMode,
    getServerAPI: getServerAPI
  };
})(window);
