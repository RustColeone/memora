(function (global) {
  'use strict';

  function isServerProtocol() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function getStaticBase() {
    return isServerProtocol() ? '/static/' : '../static/';
  }

  function resolveApiBase() {
    var protocol = location.protocol;
    var isHttps = protocol === 'https:';
    var isHttp = protocol === 'http:';
    // A native (Capacitor) build runs at https://localhost (androidScheme:https)
    // but is NOT its own server — the sync server is the configured memo_server_url.
    // Detect native via the injected Capacitor bridge (the protocol is 'https:',
    // never 'capacitor:'), and handle it BEFORE the https "web deployment, same
    // origin" case below. Without this, a native build resolved to '' and so
    // never picked up its server URL -> never auto-connected or synced on launch.
    var isCapacitor = protocol === 'capacitor:' || protocol === 'ionic:'
      || !!(window.Capacitor && (typeof window.Capacitor.isNativePlatform === 'function'
        ? window.Capacitor.isNativePlatform() : window.Capacitor.Plugins));
    var savedServerUrl = (localStorage.getItem('memo_server_url') || '').trim();

    // The desktop app (app://memora) likewise syncs only with a server it was given.
    if (isCapacitor || window.MemoDesktop) {
      return savedServerUrl || '';
    }

    if (isHttps) {
      return '';
    }

    if (isHttp) {
      return savedServerUrl || '';
    }

    return savedServerUrl || 'http://localhost:5050';
  }

  function injectStyles(cssFiles) {
    var staticBase = getStaticBase();
    (cssFiles || []).forEach(function (fileName) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = staticBase + fileName;
      document.head.appendChild(link);
    });
  }

  function hideCapacitorOnlyElements(selectors) {
    (selectors || []).forEach(function (selector) {
      var nodeList = document.querySelectorAll(selector);
      nodeList.forEach(function (node) {
        node.hidden = true;
      });
    });
  }

  function initHead(options) {
    var opts = options || {};
    var staticBase = getStaticBase();

    global.API_BASE = resolveApiBase();
    global.STATIC_BASE = staticBase;
    global.__MEMO_TEMPLATE_LOADS_SCRIPTS__ = true;

    injectStyles(opts.cssFiles || []);

    var capacitorScript = document.createElement('script');
    capacitorScript.src = staticBase + 'js/memo/memo-capacitor.js';
    capacitorScript.defer = true;
    capacitorScript.onload = function () {
      global.CAP_BOOT = !!global.__CAP_MODE__;
      if (!global.CAP_BOOT) {
        return;
      }
      var runHide = function () {
        hideCapacitorOnlyElements(opts.hideWhenCapacitor || []);
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runHide);
      } else {
        runHide();
      }
    };
    capacitorScript.onerror = function () {
      global.CAP_BOOT = false;
    };
    document.head.appendChild(capacitorScript);
  }

  function loadAppScripts(files) {
    var staticBase = global.STATIC_BASE || getStaticBase();
    var queue = (files || []).slice();

    function appendNext() {
      if (!queue.length) {
        return;
      }

      var fileName = queue.shift();
      var script = document.createElement('script');
      script.src = staticBase + fileName;
      script.async = false;
      script.defer = false;

      script.onload = function () {
        appendNext();
      };

      script.onerror = function () {
        try {
          console.error('Failed to load script:', script.src);
        } catch (_ignored) {}
        appendNext();
      };

      document.body.appendChild(script);
    }

    appendNext();
  }

  global.MemoBootstrap = {
    initHead: initHead,
    loadAppScripts: loadAppScripts,
    getStaticBase: getStaticBase,
    resolveApiBase: resolveApiBase
  };
})(window);
