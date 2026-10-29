/**
 * Single-page shell controller (memo + finance + planner in one document).
 *
 * memo & finance share one memo-core instance (MemoCore.switchVariant flips them
 * in place). Planner is a separate app: its view is lazily cloned from a template
 * and its scripts loaded once, on first switch. Only one view's DOM is attached
 * at a time (the other is detached) so their overlapping chrome IDs never collide.
 *
 * The heavy engine (sql.js WASM + the one SQLite store) comes up once and stays;
 * switching a tab is detach/attach + reload-this-variant-from-the-store + paint.
 *
 * The op-queue is variant-scoped by window.MEMO_VARIANT with a single active
 * entryStore. On each switch the shell keeps those correct: memo/finance use the
 * default store (MemoCore); planner registers its own. saveQueue() before / the
 * variant flip / reloadQueue() after keep each variant's op-log isolated.
 */
(function (global) {
  'use strict';

  var currentVariant = null;
  var mainRef = null;        // #view-main element (may be detached)
  var plannerRef = null;     // #view-planner element (may be detached)
  var plannerMounted = false;
  var plannerLoading = false;
  var plannerEntryStore = null;

  var PLANNER_SCRIPTS = [
    'planner-store', 'planner-ui', 'planner-calendar', 'planner-todos', 'planner-archive',
    'planner-projects', 'planner-habits', 'planner-today', 'planner-menu', 'planner-app'
  ];

  function el(id) { return document.getElementById(id); }
  function oq() { return global.OperationQueue || null; }

  function reducedMotionShell() {
    try { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_e) { return false; }
  }

  // The one view attached to the body right now (view-main for memo/finance,
  // view-planner for planner). This is what we crossfade on a switch.
  function attachedView() {
    if (mainRef && mainRef.parentNode) return mainRef;
    if (plannerRef && plannerRef.parentNode) return plannerRef;
    var m = el('view-main'); if (m && m.parentNode) return m;
    var p = el('view-planner'); if (p && p.parentNode) return p;
    return null;
  }

  // Commit the view as soon as its local state is ready. Motion never gates
  // navigation, and cancellation/hidden render loops cannot strand opacity at 0.
  async function runSwitchTransition(mutate) {
    global.__memoTabSwitching = true;
    try {
      await mutate();
      const view = attachedView();
      if (view && !document.hidden && !global.__memoRestoring && !reducedMotionShell() && view.animate) {
        const animation = view.animate([{ opacity: 0.7 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
        const cancel = () => { if (document.hidden) animation.cancel(); };
        document.addEventListener('visibilitychange', cancel);
        animation.finished.catch(() => {}).finally(() => document.removeEventListener('visibilitychange', cancel));
      }
    } finally { global.__memoTabSwitching = false; }
  }

  function normalizeVariant(v) {
    v = String(v || '').trim().toLowerCase();
    if (v === 'finance') return 'finance';
    if (v === 'planner') return 'planner';
    return 'default';
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('script load failed: ' + src)); };
      document.body.appendChild(s);
    });
  }

  async function loadPlannerScripts() {
    for (var i = 0; i < PLANNER_SCRIPTS.length; i++) {
      await loadScript('/static/js/planner/' + PLANNER_SCRIPTS[i] + '.js');
    }
  }

  // ── DOM view swapping (only one view attached at a time) ──────────────────
  function ensureRefs() {
    if (!mainRef) mainRef = el('view-main');
    if (!plannerRef) plannerRef = el('view-planner');
  }
  function attach(node) { if (node && !node.parentNode) document.body.appendChild(node); }
  function detach(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }

  function showDom(which) {
    ensureRefs();
    var incoming = (which === 'planner') ? plannerRef : mainRef;
    if (which === 'planner') {
      detach(mainRef);
      attach(plannerRef);
      if (plannerRef) plannerRef.hidden = false;
    } else {
      detach(plannerRef);
      attach(mainRef);
    }
    if (incoming) incoming.style.removeProperty('opacity');
  }

  // ── Memo/Finance chrome (brand, sheet bar, finance-only rows, save label) ──
  function setBrandUi(v) {
    var brandBtn = document.querySelector('#view-main .brand-dropdown .brand');
    if (brandBtn) {
      var label = (v === 'finance') ? 'Finance' : 'Memo';
      var glyph = (v === 'finance')
        ? '<span class="svg-icon svg-icon-cash"></span>'
        : '<span class="svg-icon svg-icon-book"></span>';
      brandBtn.innerHTML = glyph + ' ' + label +
        ' <span class="svg-icon svg-icon-chevron-down"></span> ';
    }
    var brandMenu = el('brandMenu');
    if (brandMenu) {
      brandMenu.querySelectorAll('a[data-variant]').forEach(function (link) {
        var dv = (link.getAttribute('data-variant') || '').toLowerCase();
        link.style.fontWeight = (dv === v) ? '700' : '';
      });
    }
  }

  function setSaveButton(v) {
    var saveBtn = el('saveBtn');
    if (!saveBtn) return;
    if (v === 'finance') {
      saveBtn.title = 'Save';
      saveBtn.innerHTML = '<span class="svg-icon svg-icon-save"></span> Save';
    } else {
      saveBtn.title = 'Post entry';
      saveBtn.innerHTML = '<span class="svg-icon svg-icon-check"></span> <span data-i18n="post">Post</span>';
    }
  }

  function setFeedMode(v) {
    var feed = el('feed');
    if (!feed) return;
    if (v === 'finance') feed.dataset.listmode = 'table';
    else feed.removeAttribute('data-listmode');
  }

  function applyVariantChrome(v) {
    document.body.classList.remove('planner-page');
    document.body.classList.toggle('finance-variant', v === 'finance');
    document.body.classList.toggle('memo-variant', v !== 'finance');
    setBrandUi(v);
    setSaveButton(v);
    setFeedMode(v);
    try { document.title = (v === 'finance') ? 'Finance — Purchases & Receipts' : 'Memo — Personal Database & Notes'; } catch (_e) {}
  }

  function closeBrandMenu() {
    document.querySelectorAll('#brandMenuButton').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    document.querySelectorAll('#brandMenu').forEach(function (m) { m.classList.remove('open', 'show'); });
    document.querySelectorAll('.brand-dropdown').forEach(function (w) { w.classList.remove('open', 'show'); });
  }

  // ── Switching ─────────────────────────────────────────────────────────────
  async function showMain(v) {
    v = normalizeVariant(v);
    if (v === 'planner') return showPlanner();
    if (currentVariant === v) { closeBrandMenu(); return; }
    var wasPlanner = (currentVariant === 'planner');
    var q = oq();
    if (wasPlanner) {
      // Persist planner's op-queue, hand the store back to memo/finance.
      try { if (q && q.saveQueue) q.saveQueue(); } catch (_e) {}
      if (global.MemoContracts && global.MemoContracts.registerService) {
        global.MemoContracts.registerService('entryStore', null);
      }
    }
    await runSwitchTransition(async function () {
      showDom('main');
      applyVariantChrome(v);
      try {
        if (global.MemoCore && global.MemoCore.switchVariant) await global.MemoCore.switchVariant(v);
      } catch (e) { console.error('Variant switch failed:', e); }
    });
    currentVariant = v;
    document.dispatchEvent(new Event('memo:variant-changed'));
    try { localStorage.setItem('memo_variant', v); } catch (_e) {}
    closeBrandMenu();
  }

  async function showPlanner() {
    if (currentVariant === 'planner') { closeBrandMenu(); return; }
    var q = oq();
    // Persist the outgoing memo/finance queue + entries before leaving.
    try { if (q && q.saveQueue) q.saveQueue(); } catch (_e) {}
    try { if (global.MemoCore && global.MemoCore.flushPersistence) await global.MemoCore.flushPersistence(); } catch (_e) {}
    // Enter the planner variant context.
    global.MEMO_VARIANT = 'planner';
    try { localStorage.setItem('memo_variant', 'planner'); } catch (_e) {}
    // The crossfade IS the planner's entrance; suppress planner-app's own
    // first-mount panel stagger so it doesn't replay a second motion after the
    // fade settles (which read as a flash). Cleared once the switch is done.
    global.__plannerEntering = true;
    await runSwitchTransition(async function () {
      document.body.classList.remove('finance-variant', 'memo-variant');
      document.body.classList.add('planner-page');
      showDom('planner');
      if (!plannerMounted) {
        if (!plannerLoading) {
          plannerLoading = true;
          var tpl = el('plannerTpl');
          if (tpl && tpl.content && plannerRef && !plannerRef.childElementCount) {
            plannerRef.appendChild(tpl.content.cloneNode(true));
          }
          try {
            await loadPlannerScripts();
            await global.Planner?.ready;  // planner-app self-inits against the mounted DOM
            plannerMounted = true;
            if (global.MemoContracts && global.MemoContracts.getService) {
              plannerEntryStore = global.MemoContracts.getService('entryStore');
            }
          } catch (e) { console.error('Planner load failed:', e); }
          plannerLoading = false;
        }
      } else {
        // Re-activate: re-point the op-queue + store at planner, reload + render.
        if (global.MemoContracts && plannerEntryStore) global.MemoContracts.registerService('entryStore', plannerEntryStore);
        try { if (q && q.reloadQueue) q.reloadQueue(); } catch (_e) {}
        try { global.MemoRestore?.prepare('planner'); if (global.Planner?.Store?.reload) global.Planner.Store.reload(); await global.MemoRestore?.ready(); } catch (_e) {}
      }
    });
    currentVariant = 'planner';
    document.dispatchEvent(new Event('memo:variant-changed'));
    global.__plannerEntering = false;
    closeBrandMenu();
  }

  let switchFlight = Promise.resolve(), switchIntent = 0;
  function switchTo(v) {
    const intent = ++switchIntent;
    const next = switchFlight.catch(() => {}).then(() => {
      if (intent !== switchIntent) return;
      return performSwitch(v);
    });
    switchFlight = next;
    return next;
  }

  async function performSwitch(v) {
    v = normalizeVariant(v);
    global.MemoRestore?.save();
    // Privacy gate: a Level-3 variant must be unlocked before we switch into it.
    // Auth denied ⇒ abort and stay on the current page (curtain untouched).
    if (global.MemoPrivacy && global.MemoPrivacy.ensureVariantAccess) {
      var ok = await global.MemoPrivacy.ensureVariantAccess(v);
      if (!ok) { closeBrandMenu(); return; }
    }
    return (v === 'planner') ? showPlanner() : showMain(v);
  }

  async function init(v) {
    v = normalizeVariant(v);
    if (v === 'planner') { await showPlanner(); return; }
    showDom('main');
    applyVariantChrome(v);
    try {
      if (global.MemoCore && global.MemoCore.switchVariant) await global.MemoCore.switchVariant(v);
    } catch (e) { console.error('Shell init failed:', e); }
    currentVariant = v;
    document.dispatchEvent(new Event('memo:variant-changed'));
    try { localStorage.setItem('memo_variant', v); } catch (_e) {}
  }

  // Intercept brand-menu variant links (in either view's header) so tab switches
  // happen in place instead of reloading the document.
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href], a[data-variant]') : null;
    if (!link) return;
    var dv = (link.getAttribute('data-variant') || '').trim().toLowerCase();
    var href = (link.getAttribute('href') || '').trim().toLowerCase();
    if (dv === 'planner' || href === 'planner.html') { event.preventDefault(); switchTo('planner'); return; }
    if (dv === 'finance' || href === 'finance.html') { event.preventDefault(); switchTo('finance'); return; }
    if (dv === 'default' || href === 'index.html') { event.preventDefault(); switchTo('default'); return; }
  }, true);

  global.MemoSpaShell = {
    init: init,
    switchTo: switchTo,
    applyVariantChrome: applyVariantChrome,
    getVariant: function () { return currentVariant; }
  };
})(window);
