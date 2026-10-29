// memo-native-ui.js — silent browser fallback for Android-only system chrome
// and deliberately sparse semantic haptics.
(function (global) {
  'use strict';

  var ALLOWED_HAPTICS = new Set(['longPress', 'selection', 'destructiveSuccess']);
  var syncFrame = 0;

  function plugin() {
    return global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.NativeUi;
  }

  function themePayload() {
    var style = getComputedStyle(document.documentElement);
    var background = style.getPropertyValue('--bg').trim() || '#17181b';
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      backgroundColor: background,
      statusBarColor: background,
      navigationBarColor: background,
      darkIcons: light,
    };
  }

  function syncSystemBars() {
    cancelAnimationFrame(syncFrame);
    syncFrame = requestAnimationFrame(function () {
      syncFrame = 0;
      var nativeUi = plugin();
      var payload = themePayload();
      var themeMeta = document.querySelector('meta[name="theme-color"]');
      if (themeMeta) themeMeta.setAttribute('content', payload.backgroundColor);
      if (!nativeUi || typeof nativeUi.setSystemBars !== 'function') return;
      try {
        Promise.resolve(nativeUi.setSystemBars(payload)).catch(function () {});
      } catch (_error) {}
    });
  }

  async function haptic(type) {
    if (!ALLOWED_HAPTICS.has(type)) return false;
    var nativeUi = plugin();
    if (!nativeUi || typeof nativeUi.haptic !== 'function') return false;
    try {
      await nativeUi.haptic({ type: type });
      return true;
    } catch (_error) {
      return false;
    }
  }

  global.MemoNativeUi = {
    syncSystemBars: syncSystemBars,
    haptic: haptic,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncSystemBars, { once: true });
  } else {
    syncSystemBars();
  }
})(window);
