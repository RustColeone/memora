// memo-privacy.js — per-variant privacy gate (biometric / device-credential).
//
// Modelled on ImageDB's privacy.js, adapted to Memora's PER-VARIANT levels:
//   memo    : 1 (open) · 2 (Safe) · 3 (locked)
//   finance : 1 (open) · 3 (locked)
//   planner : 1 (open) · 3 (locked)
// The app's variant id for memo is 'default'; the privacy key for it is 'memo'.
//
// Safe (Level 2, memo only) is a PRESENTATION gate — it hides entries flagged
// entry.safe from the feed; it does not encrypt anything. Level 3 covers a whole
// variant behind a system-auth curtain. A single session unlock covers every L3
// variant; backgrounding re-locks immediately. The native PrivacyPlugin owns the
// biometric/device-credential prompt, FLAG_SECURE, and the authoritative levels.
'use strict';
(function (global) {
  var BOOT_KEY = 'memo_privacy_boot_v1';   // localStorage mirror for pre-paint curtain

  var session = {
    levels: { memo: 1, finance: 1, planner: 1 },
    available: false,
    availability: null,
    appUnlocked: false,      // one session unlock covers all L3 variants
    safeUnlocked: false,
    safeView: false,
    authInFlight: null,
    authKey: '',
    authEpoch: 0,
    appActive: true,
    initialized: false,
    lifecycleInstalled: false,
    nativeResolved: false,
  };

  // ── helpers ────────────────────────────────────────────────────────────────
  function plugin() { try { return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.Privacy) || null; } catch (_e) { return null; } }
  function isNative() { try { return !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform()); } catch (_e) { return false; } }
  function core() { return global.MemoCore; }
  function toast(msg, opts) { if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast(msg, opts); }
  function el(id) { return document.getElementById(id); }
  function VARIANTS() { return ['memo', 'finance', 'planner']; }

  function activeVariantId() {
    var v = 'default';
    try { v = (core() && core().getVariant && core().getVariant()) || global.MEMO_VARIANT || localStorage.getItem('memo_variant') || 'default'; } catch (_e) {}
    return (v || 'default').toLowerCase();
  }
  // App variant id -> privacy key ('default' page is the memo variant).
  function pkey(variantId) { var v = (variantId || activeVariantId()); return v === 'default' ? 'memo' : v; }
  function levelOf(variantId) { return session.levels[pkey(variantId)] || 1; }
  function isMemoActive() { return pkey() === 'memo'; }
  function anyLocked() { return VARIANTS().some(function (k) { return session.levels[k] === 3; }); }

  function normalizeLevel(key, value) {
    var n = Number(value);
    if (key === 'memo') return (n === 2 || n === 3) ? n : 1;
    return n === 3 ? 3 : 1;   // finance / planner: 1 or 3 only
  }
  function writeBootHint() {
    try { localStorage.setItem(BOOT_KEY, JSON.stringify(session.levels)); } catch (_e) {}
  }

  // ── native wrappers ──────────────────────────────────────────────────────
  async function getAvailability() {
    var p = plugin();
    if (!p || !p.getAvailability) {
      session.available = false;
      session.availability = { available: false, authoritative: !isNative() };
      return session.availability;
    }
    try {
      var res = await p.getAvailability();
      session.available = !!(res && res.available);
      session.availability = Object.assign({ authoritative: true }, res || {});
      if (res && res.levels) {
        session.levels = {
          memo: normalizeLevel('memo', res.levels.memo),
          finance: normalizeLevel('finance', res.levels.finance),
          planner: normalizeLevel('planner', res.levels.planner),
        };
        writeBootHint();
      }
      return session.availability;
    } catch (e) {
      console.warn('[Privacy] availability failed', e);
      session.available = false;
      session.availability = { available: false, authoritative: !isNative() };
      return session.availability;
    }
  }

  async function authenticate(opts) {
    opts = opts || {};
    var p = plugin();
    if (!p || !p.authenticate || !session.available || !session.appActive) return false;
    var authKey = JSON.stringify([opts.title || '', opts.subtitle || '']);
    if (session.authInFlight) return session.authKey === authKey ? session.authInFlight : false;
    var epoch = session.authEpoch;
    session.authKey = authKey;
    session.authInFlight = (async function () {
      try {
        var res = await p.authenticate({ title: opts.title || 'Unlock Memora', subtitle: opts.subtitle || 'Use your biometrics or device screen lock' });
        return !!(res && res.authenticated) && session.appActive && session.authEpoch === epoch;
      } catch (e) {
        console.warn('[Privacy] auth failed', e);
        return false;
      } finally {
        session.authInFlight = null; session.authKey = '';
      }
    })();
    return session.authInFlight;
  }

  async function setSecureScreen(enabled) {
    var p = plugin();
    if (!p || !p.setSecureScreen) return !enabled;
    try { var r = await p.setSecureScreen({ enabled: !!enabled }); return !(r && r.enabled === false); }
    catch (e) { console.warn('[Privacy] secure-screen failed', e); return false; }
  }

  // ── projection ─────────────────────────────────────────────────────────────
  function isSafe(entry) { return !!(entry && entry.safe); }
  function canViewEntry(entry) {
    if (!entry) return false;
    var lvl = levelOf();          // the current (active) variant's level
    if (lvl === 1) return true;
    if (lvl === 3) {
      if (!session.appUnlocked) return false;
      if (isMemoActive()) return session.safeView ? isSafe(entry) : true;
      return true;
    }
    // lvl === 2 (memo only): Safe view shows safe items, otherwise hides them.
    return (session.safeView && session.safeUnlocked) ? isSafe(entry) : !isSafe(entry);
  }
  function visibleEntries(list) { return (list || []).filter(canViewEntry); }

  // ── rendering / surfaces ────────────────────────────────────────────────────
  function rerender() {
    // Re-project the tag list too (Safe toggle changes which tags are visible),
    // then redraw the feed. Calendar re-indexes when it next opens.
    try { if (core() && core().recomputeTags) core().recomputeTags(); } catch (_e) {}
    try {
      if (core() && core().renderFeed) core().renderFeed();
      else if (global.MemoVariant && global.MemoVariant.renderFeed) global.MemoVariant.renderFeed();
    } catch (_e) {}
    updateUI();
  }
  function closeSensitiveSurfaces() {
    // Capture an unfinished image recipe before closing its sensitive surface.
    global.MemoImageEditorImpl?.suspend();
    try { for (var d of document.querySelectorAll('dialog[open]')) { try { d.close(); } catch (_e) {} } } catch (_e) {}
    try { if (global.MemoSelect && global.MemoSelect.active && global.MemoSelect.active()) global.MemoSelect.exit(); } catch (_e) {}
    try { if (global.MemoCtx && global.MemoCtx.hide) global.MemoCtx.hide(false); } catch (_e) {}
    try { if (global.MemoShell && global.MemoShell.hideToast) global.MemoShell.hideToast(); } catch (_e) {}
  }

  // ── curtain ──────────────────────────────────────────────────────────────
  var curtainSaved = new Map();
  function protectChild(node, curtain) {
    if (!(node instanceof HTMLElement) || node === curtain || curtainSaved.has(node)) return;
    curtainSaved.set(node, { inert: !!node.inert, ariaHidden: node.getAttribute('aria-hidden') });
    node.inert = true; node.setAttribute('aria-hidden', 'true');
  }
  function setCurtain(locked) {
    var curtain = el('privacyLockScreen');
    if (!curtain || !document.body) return;
    if (locked) {
      document.body.classList.add('privacy-locked');
      if (!curtainSaved.size) { for (var c of document.body.children) protectChild(c, curtain); }
      requestAnimationFrame(function () {
        if (document.body.classList.contains('privacy-locked')) { var b = el('privacyUnlockBtn'); if (b) try { b.focus({ preventScroll: true }); } catch (_e) {} }
      });
      return;
    }
    document.body.classList.remove('privacy-locked');
    for (var pair of curtainSaved) {
      var node = pair[0], prev = pair[1];
      if (!node.isConnected) continue;
      node.inert = prev.inert;
      if (prev.ariaHidden == null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', prev.ariaHidden);
    }
    curtainSaved.clear();
  }
  function settleBootGuard() {
    var root = document.documentElement;
    root.classList.remove('privacy-boot-pending', 'privacy-boot-locked');
  }

  // ── lock / unlock ──────────────────────────────────────────────────────────
  function lock(reason) {
    session.authEpoch++;
    session.safeUnlocked = false;
    session.safeView = false;
    if (anyLocked()) session.appUnlocked = false;
    void setSecureScreen(anyLocked());
    if (levelOf() === 3 || reason === 'background') setCurtain(true);
    closeSensitiveSurfaces();
    rerender();
    document.dispatchEvent(new CustomEvent('memo:privacy-locked', { detail: { reason: reason || 'manual' } }));
  }

  // Prove access to an L3 variant. Returns true if it's open, already unlocked
  // this session, or auth now succeeds. Callers own the curtain: the boot path
  // keeps it up on failure; a variant switch just aborts (staying on the current
  // page) so it never touches the curtain over content that's still allowed.
  async function ensureVariantAccess(variantId) {
    if (levelOf(variantId) !== 3) return true;
    if (session.appUnlocked) return true;
    if (!session.available) {
      await getAvailability();
      if (!session.available) { toast('Set up a device screen lock, then try again.', { kind: 'error', ms: 6000 }); return false; }
    }
    if (!(await setSecureScreen(true))) { toast('Could not enable screenshot protection.', { kind: 'error' }); return false; }
    var ok = await authenticate({ title: 'Unlock Memora', subtitle: 'Authenticate to open this page' });
    if (!ok || !session.appActive) return false;
    session.appUnlocked = true;
    await setSecureScreen(anyLocked());
    setCurtain(false);
    settleBootGuard();
    rerender();
    document.dispatchEvent(new CustomEvent('memo:privacy-unlocked', { detail: { scope: 'app' } }));
    return true;
  }

  // ── Safe (memo Level 2, and filter-only in Level 3) ─────────────────────────
  async function toggleSafe() {
    if (!isMemoActive()) return;
    var lvl = levelOf();
    if (lvl === 1) return;                 // disabled in L1
    if (session.safeView) {                // closing Safe
      session.safeView = false;
      if (lvl === 2) { session.safeUnlocked = false; lock('safe-closed'); return; }
      rerender(); return;                  // L3: just a filter
    }
    if (lvl === 3) { session.safeView = true; rerender(); return; }   // filter-only, already unlocked
    // lvl === 2: authenticate to open Safe
    if (!session.available) { await getAvailability(); if (!session.available) { toast('Set up a device screen lock to use Safe.', { kind: 'error', ms: 6000 }); return; } }
    var ok = await authenticate({ title: 'Open Safe', subtitle: 'Authenticate to view Safe items' });
    if (!ok || !session.appActive) return;
    if (!(await setSecureScreen(true))) { toast('Safe stayed closed — screenshot protection unavailable.', { kind: 'error' }); return; }
    closeSensitiveSurfaces();
    session.safeUnlocked = true; session.safeView = true;
    rerender();
    document.dispatchEvent(new CustomEvent('memo:privacy-unlocked', { detail: { scope: 'safe' } }));
  }

  async function setEntriesSafe(ids, safe) {
    ids = Array.from(new Set((ids || []).filter(Boolean)));
    if (!ids.length || levelOf('default') < 2) return 0;
    // Removing from Safe reveals content, so prove the owner first.
    if (!safe) {
      var ok = await authenticate({ title: 'Remove from Safe', subtitle: 'Authenticate to remove items from Safe' });
      if (!ok) return 0;
    }
    var c = core();
    if (c && c.batchApply) { try { await c.batchApply(ids, { safe: !!safe }); } catch (e) { toast('Could not update Safe.', { kind: 'error' }); return 0; } }
    closeSensitiveSurfaces();
    rerender();
    return ids.length;
  }

  // ── settings panel (3 rows, one Level dropdown each) ─────────────────────────
  function openSettings() {
    var dlg = el('privacySettingsDlg'); if (!dlg) return;
    VARIANTS().forEach(function (k) {
      var sel = el('privacyLevel_' + k);
      if (sel) sel.value = String(session.levels[k] || 1);
    });
    var avail = el('privacyAvailability');
    if (avail) avail.textContent = session.available
      ? 'Uses your device biometrics or screen lock. Memora never stores a PIN.'
      : 'Protection needs the Android app with a device screen lock configured.';
    VARIANTS().forEach(function (k) {
      var sel = el('privacyLevel_' + k);
      if (sel) Array.prototype.forEach.call(sel.options, function (o) {
        o.disabled = Number(o.value) > 1 && !session.available;
      });
    });
    if (!dlg.open) dlg.showModal();
  }

  async function saveSettingsPanel() {
    var dlg = el('privacySettingsDlg');
    var next = {};
    var changed = false, raising = false, lowering = false;
    VARIANTS().forEach(function (k) {
      var sel = el('privacyLevel_' + k);
      var v = normalizeLevel(k, sel ? sel.value : session.levels[k]);
      next[k] = v;
      if (v !== session.levels[k]) { changed = true; if (v > session.levels[k]) raising = true; else lowering = true; }
    });
    if (!changed) { if (dlg) dlg.close(); return; }
    var wantsProtected = VARIANTS().some(function (k) { return next[k] > 1; });
    if (wantsProtected && !session.available) { toast('Set up a device screen lock to use these levels.', { kind: 'error', ms: 6000 }); return; }
    // Any protection change proves the owner first.
    if (raising || lowering) {
      var ok = await authenticate({ title: 'Change privacy', subtitle: 'Authenticate to change privacy settings' });
      if (!ok) return;
    }
    var p = plugin();
    try {
      for (var k of VARIANTS()) {
        if (next[k] !== session.levels[k] && p && p.setVariantLevel) await p.setVariantLevel({ variant: k, level: next[k] });
      }
    } catch (e) { console.warn('[Privacy] setVariantLevel failed', e); toast('The privacy level could not be saved.', { kind: 'error' }); return; }
    session.levels = next;
    writeBootHint();
    try { var c = core(); if (c) { var st = c.getState(); if (st && st.settings) { st.settings.privacyLevels = Object.assign({}, next); if (c.saveAll) c.saveAll(); } } } catch (_e) {}
    // A freshly-authenticated change unlocks the app for this session.
    session.appUnlocked = true;
    session.safeUnlocked = false; session.safeView = false;
    await setSecureScreen(anyLocked());
    if (dlg) dlg.close();
    setCurtain(false); settleBootGuard();
    rerender();
  }

  // ── UI reflection ────────────────────────────────────────────────────────────
  function updateUI() {
    var memoLvl = session.levels.memo;
    var onMemo = isMemoActive();
    var safeBtn = el('safeBtn');
    if (safeBtn) {
      // Hide the Safe button entirely unless it's usable (memo page, Level ≥ 2).
      safeBtn.hidden = !onMemo || memoLvl < 2;
      safeBtn.classList.toggle('active', session.safeView);
      safeBtn.setAttribute('aria-pressed', String(session.safeView));
      var lab = session.safeView ? 'Close Safe' : 'Open Safe';
      safeBtn.setAttribute('aria-label', lab); safeBtn.title = lab;
      var ic = safeBtn.querySelector('.svg-icon');
      if (ic) { ic.classList.toggle('svg-icon-lock-open', session.safeView); ic.classList.toggle('svg-icon-lock', !session.safeView); }
    }
    var detailSafe = el('detailSafeBtn');
    if (detailSafe) {
      detailSafe.hidden = !(onMemo && memoLvl >= 2);
      var dlg = el('detailDlg');
      var id = dlg && dlg.dataset ? dlg.dataset.entryId : '';
      var entry = id ? findEntry(id) : null;
      detailSafe.textContent = (entry && entry.safe) ? 'Remove from Safe' : 'Move to Safe';
    }
  }
  function findEntry(id) {
    try { return core().getState().db.entries.find(function (e) { return String(e.id) === String(id); }) || null; } catch (_e) { return null; }
  }

  // ── lifecycle + init ─────────────────────────────────────────────────────────
  function installLifecycle() {
    if (session.lifecycleInstalled) return;
    session.lifecycleInstalled = true;
    var App = null;
    try { App = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.App; } catch (_e) {}
    if (App && App.addListener) {
      App.addListener('appStateChange', function (state) {
        if (!state || state.isActive === false) {
          session.appActive = false;
          session.authEpoch++;
          if (anyLocked() || session.safeView || session.safeUnlocked) { setCurtain(true); lock('background'); }
          return;
        }
        session.appActive = true;
        if (levelOf() === 3) {
          (async function () { try { await session.authInFlight; } catch (_e) {} if (session.appActive && !session.appUnlocked) await ensureVariantAccess(activeVariantId()); })();
        } else if (!anyLocked()) setCurtain(false);
      });
    }
  }

  async function initialize() {
    installEvents();
    var nativeRuntime = isNative();
    await getAvailability();
    session.nativeResolved = session.availability && session.availability.authoritative !== false;
    // Mirror levels into settings for web/backup; native stays authoritative.
    try { var c = core(); if (c) { var st = c.getState(); if (st && st.settings) { st.settings.privacyLevels = Object.assign({}, session.levels); } } } catch (_e) {}
    session.appUnlocked = !anyLocked();
    session.initialized = true;
    installLifecycle();
    updateUI();
    // Boot gate: if the landing variant is L3, keep the curtain and prompt.
    if (levelOf() === 3) {
      session.appUnlocked = false;
      setCurtain(true);
      await ensureVariantAccess(activeVariantId());
    } else {
      setCurtain(false);
      settleBootGuard();
      await setSecureScreen(anyLocked());
    }
    rerender();
    return true;
  }

  function installEvents() {
    if (installEvents._done) return; installEvents._done = true;
    var sb = el('safeBtn'); if (sb) sb.addEventListener('click', function () { void toggleSafe(); });
    var ub = el('privacyUnlockBtn'); if (ub) ub.addEventListener('click', function () { void ensureVariantAccess(activeVariantId()); });
    var open = el('privacySettingsBtn'); if (open) open.addEventListener('click', function () { void openSettings(); });
    var save = el('privacySettingsSave'); if (save) save.addEventListener('click', function () { void saveSettingsPanel(); });
    ['privacySettingsClose', 'privacySettingsCancel'].forEach(function (id) { var b = el(id); if (b) b.addEventListener('click', function () { var d = el('privacySettingsDlg'); if (d) d.close(); }); });
    var ds = el('detailSafeBtn'); if (ds) ds.addEventListener('click', function () {
      var dlg = el('detailDlg'); var id = dlg && dlg.dataset ? dlg.dataset.entryId : '';
      var entry = id ? findEntry(id) : null;
      if (entry) void setEntriesSafe([id], !entry.safe);
    });
  }

  global.MemoPrivacy = {
    initialize: initialize,
    canViewEntry: canViewEntry,
    visibleEntries: visibleEntries,
    isEntrySafe: isSafe,
    ensureVariantAccess: ensureVariantAccess,
    toggleSafe: toggleSafe,
    setEntriesSafe: setEntriesSafe,
    openSettings: openSettings,
    updateUI: updateUI,
    lock: lock,
    levelOf: levelOf,
    isSafeView: function () { return session.safeView; },
    session: session,
  };
})(window);
