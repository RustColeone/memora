(function (global) {
  'use strict';
  const records = [];
  let active = true;
  const bootId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  function native() { return !!global.Capacitor && (global.Capacitor.isNativePlatform?.() ?? !!global.Capacitor.Plugins); }
  function trace(event, detail = {}) {
    records.push({ bootId, at: Math.round(performance.now()), event, ...detail });
    if (records.length > 80) records.shift();
  }
  function checkpoint() {
    global.MemoDraft?.save();
    global.MemoRestore?.save();
    global.MemoStateDb?.flush?.().catch(() => {});
  }
  function resume() {
    trace('resume');
    global.dispatchEvent(new CustomEvent('memo:resume'));
  }
  global.MemoLifecycle = {
    native, trace, checkpoint, isActive: () => active,
    retain: event => !!event?.persisted || native(),
    diagnostics: () => records.slice()
  };
  trace('boot', { navigation: performance.getEntriesByType('navigation')[0]?.type || 'unknown' });
  document.addEventListener('visibilitychange', () => {
    trace('visibility', { hidden: document.hidden });
    if (document.hidden) checkpoint(); else resume();
  });
  global.addEventListener('pagehide', event => { trace('pagehide', { persisted: !!event.persisted }); checkpoint(); });
  global.addEventListener('pageshow', event => { trace('pageshow', { persisted: !!event.persisted }); resume(); });
  global.addEventListener('load', () => {
    global.Capacitor?.Plugins?.App?.addListener('appStateChange', state => {
      active = state.isActive;
      trace('appState', { active: state.isActive });
      if (state.isActive) resume(); else checkpoint();
    });
  }, { once: true });
})(window);
