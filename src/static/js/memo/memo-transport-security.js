// memo-transport-security.js — one shared HTTP risk disclosure for every
// self-hosted server setup surface.
(function (global) {
  'use strict';

  var CONFIRM_MESSAGE =
    'This HTTP connection is unencrypted. Devices on the network may intercept or modify synced notes, files, and passwords. Continue only if you control the server and trust this network.';

  function isHttp(value) {
    try { return new URL(String(value || '').trim()).protocol === 'http:'; }
    catch (_error) { return /^\s*http:\/\//i.test(String(value || '')); }
  }

  function reflect(input, warning) {
    if (!warning) return false;
    var insecure = isHttp(input && input.value);
    warning.hidden = !insecure;
    return insecure;
  }

  function bind(input, warning) {
    if (!input || !warning || input.dataset.transportSecurityBound === '1') {
      reflect(input, warning);
      return;
    }
    input.dataset.transportSecurityBound = '1';
    input.addEventListener('input', function () { reflect(input, warning); });
    input.addEventListener('change', function () { reflect(input, warning); });
    reflect(input, warning);
  }

  function confirmHttp(url) {
    return !isHttp(url) || global.confirm(CONFIRM_MESSAGE);
  }

  global.MemoTransportSecurity = {
    bind: bind,
    reflect: reflect,
    isHttp: isHttp,
    confirmHttp: confirmHttp,
    CONFIRM_MESSAGE: CONFIRM_MESSAGE,
  };
})(window);
