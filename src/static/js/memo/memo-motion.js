// memo-motion.js — shared motion, scheduling, and modal lifecycle primitives.
//
// Motion stays short and compositor-friendly. Work that can arrive in bursts is
// coalesced, stale transitions cannot commit, and every behavior has an immediate
// prefers-reduced-motion path.
(function (global) {
  'use strict';

  var mql = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduced() { return !!(mql && mql.matches); }

  function cssDurationMs(name, fallback) {
    if (reduced()) return 0;
    var raw = '';
    try { raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (_e) {}
    if (!raw) return fallback;
    var n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    return /ms$/i.test(raw) ? n : n * 1000;
  }

  // ── Bounded stagger entrances ─────────────────────────────────────────────
  var STAGGER_INDEX_CAP = 12;
  var CLEANUP_MS = 900;
  var staggerRuns = new WeakMap();

  function finishStagger(el, run) {
    if (!el || staggerRuns.get(el) !== run) return;
    staggerRuns.delete(el);
    clearTimeout(run.timer);
    el.removeEventListener('animationend', run.finish);
    el.removeEventListener('animationcancel', run.finish);
    el.classList.remove('motion-pop', 'motion-fade');
    el.style.removeProperty('--motion-i');
  }

  function stagger(items, mode) {
    if (reduced() || !items) return;
    var arr = Array.prototype.slice.call(items);
    var cls = mode === 'fade' ? 'motion-fade' : 'motion-pop';
    var prepared = [];
    var needsReplayFlush = false;
    arr.forEach(function (el, index) {
      if (!el || !el.style) return;
      var prior = staggerRuns.get(el);
      if (prior) {
        finishStagger(el, prior);
        needsReplayFlush = true;
      }
      var run = { timer: 0 };
      run.finish = function (event) {
        if (event && event.target !== el) return;
        finishStagger(el, run);
      };
      staggerRuns.set(el, run);
      el.style.setProperty('--motion-i', Math.min(index, STAGGER_INDEX_CAP));
      prepared.push({ el: el, run: run });
    });
    // Only deliberate replays need an animation restart. Batch that work into
    // one style flush instead of interleaving a forced layout with every card.
    if (needsReplayFlush && prepared.length) void document.documentElement.offsetWidth;
    prepared.forEach(function (item) {
      var el = item.el, run = item.run;
      el.classList.add(cls);
      el.addEventListener('animationend', run.finish);
      el.addEventListener('animationcancel', run.finish);
      run.timer = setTimeout(run.finish, CLEANUP_MS);
    });
  }

  // ── Last-intent-wins feed transitions ─────────────────────────────────────
  var viewRuns = new WeakMap();
  var activeDocumentTransition = null;

  function clearViewRun(container, run) {
    if (viewRuns.get(container) !== run) return;
    viewRuns.delete(container);
    container.classList.remove('feed-leaving');
  }

  function fallbackViewAnimation(container, run) {
    if (!container || typeof container.animate !== 'function') {
      clearViewRun(container, run);
      return;
    }
    try {
      var animation = container.animate([
        { opacity: .84, transform: 'translateY(3px)' },
        { opacity: 1, transform: 'none' }
      ], {
        duration: cssDurationMs('--motion-base', 200),
        easing: 'cubic-bezier(.2, .7, .2, 1)'
      });
      run.cancel = function () { try { animation.cancel(); } catch (_e) {} };
      Promise.resolve(animation.finished).then(
        function () { clearViewRun(container, run); },
        function () { clearViewRun(container, run); }
      );
    } catch (_e) {
      clearViewRun(container, run);
    }
  }

  function startViewRun(container, run) {
    if (viewRuns.get(container) !== run) return;
    run.started = true;
    container.classList.remove('feed-leaving');
    var commit = function () {
      if (viewRuns.get(container) !== run) return;
      run.render();
    };
    var transitionName = '';
    try { transitionName = getComputedStyle(container).viewTransitionName || ''; } catch (_e) {}
    if (document.startViewTransition && transitionName && transitionName !== 'none') {
      try {
        if (activeDocumentTransition && typeof activeDocumentTransition.skipTransition === 'function') {
          activeDocumentTransition.skipTransition();
        }
        activeDocumentTransition = null;
        var transition = document.startViewTransition(commit);
        activeDocumentTransition = transition;
        run.transition = transition;
        run.cancel = function () {
          try { if (transition.skipTransition) transition.skipTransition(); } catch (_e2) {}
        };
        // Both promises may reject when a newer intent deliberately skips this
        // transition. They are diagnostic only; `finished` below owns cleanup.
        if (transition.ready) Promise.resolve(transition.ready).catch(function () {});
        if (transition.updateCallbackDone) Promise.resolve(transition.updateCallbackDone).catch(function () {});
        Promise.resolve(transition.finished).then(function () {
          if (activeDocumentTransition === transition) activeDocumentTransition = null;
          clearViewRun(container, run);
        }, function () {
          if (activeDocumentTransition === transition) activeDocumentTransition = null;
          clearViewRun(container, run);
        });
        return;
      } catch (_e3) {
        if (activeDocumentTransition && activeDocumentTransition === run.transition) activeDocumentTransition = null;
      }
    }
    commit();
    fallbackViewAnimation(container, run);
  }

  function viewTransition(container, renderFn) {
    if (typeof renderFn !== 'function') return;
    if (!container) { renderFn(); return; }
    if (container.id === 'feed' && document.querySelector('.nav-reveal')) cancelCircularReveal();
    var active = viewRuns.get(container);
    if (reduced()) {
      // A preference change is also a newest intent. Replace ownership before
      // rendering so a delayed native update callback cannot repaint stale DOM.
      if (active && active.cancel) {
        active.cancel();
        if (active.transition === activeDocumentTransition) activeDocumentTransition = null;
      } else if (activeDocumentTransition && typeof activeDocumentTransition.skipTransition === 'function') {
        try { activeDocumentTransition.skipTransition(); } catch (_e) {}
        activeDocumentTransition = null;
      }
      var immediate = { render: renderFn, started: true, cancel: null, transition: null };
      viewRuns.set(container, immediate);
      try { renderFn(); } finally { clearViewRun(container, immediate); }
      return;
    }
    if (active && !active.started) {
      // Coalesce bursts in the current task so an intermediate search/category
      // state never gets painted merely because it was requested first.
      active.render = renderFn;
      return;
    }
    if (active && active.cancel) active.cancel();
    var run = { render: renderFn, started: false, cancel: null, transition: null };
    viewRuns.set(container, run);
    // A microtask is enough to collect same-input bursts while keeping the
    // interaction-to-DOM latency well inside the next frame.
    Promise.resolve().then(function () { startViewRun(container, run); });
  }

  function cancelViewTransition(container) {
    var run = container && viewRuns.get(container);
    if (run) {
      if (run.cancel) run.cancel();
      clearViewRun(container, run);
    }
    if (activeDocumentTransition && typeof activeDocumentTransition.skipTransition === 'function') {
      try { activeDocumentTransition.skipTransition(); } catch (_e) {}
    }
    activeDocumentTransition = null;
  }

  // ── Shared-element transitions ───────────────────────────────────────────
  // Transfer one temporary View Transition name from a mounted source to a
  // synchronously-created destination. Callers still own their DOM mutation;
  // this helper only coordinates native transition ownership and cleanup.
  var activeSharedRun = null;

  function canSharedElement(from) {
    return !!(from && from.isConnected && document.startViewTransition && !reduced());
  }

  function settleTransition(transition, cleanup) {
    if (transition.ready) Promise.resolve(transition.ready).catch(function () {});
    if (transition.updateCallbackDone) Promise.resolve(transition.updateCallbackDone).catch(function () {});
    if (transition.finished) Promise.resolve(transition.finished).then(cleanup, cleanup);
    else cleanup();
  }

  function finishSharedRun(run) {
    if (!run || run.cleaned) return;
    run.cleaned = true;
    if (run.from && run.from.style.viewTransitionName === run.name) run.from.style.viewTransitionName = '';
    if (run.to && run.to.style.viewTransitionName === run.name) run.to.style.viewTransitionName = '';
    (run.suppressed || []).forEach(function (item) {
      if (!item.el || !item.el.style) return;
      item.el.style.viewTransitionName = item.value;
    });
    if (activeSharedRun === run) activeSharedRun = null;
    if (activeDocumentTransition === run.transition) activeDocumentTransition = null;
    if (typeof run.onFinished === 'function') {
      try { run.onFinished(run.result); } catch (_e) {}
    }
  }

  function cancelSharedElement() {
    var run = activeSharedRun;
    if (!run) return;
    run.cancelled = true;
    try { if (run.transition && run.transition.skipTransition) run.transition.skipTransition(); } catch (_e) {}
    finishSharedRun(run);
  }

  function sharedElementTransition(options) {
    var opts = options || {};
    var mutate = typeof opts.mutate === 'function' ? opts.mutate : function () {};
    var from = opts.from;
    if (!canSharedElement(from)) { mutate(false); return null; }

    cancelSharedElement();
    var suppressed = [];
    Array.prototype.slice.call(opts.suppress || []).forEach(function (el) {
      if (!el || !el.style) return;
      cancelViewTransition(el);
      suppressed.push({ el: el, value: el.style.viewTransitionName });
      el.style.viewTransitionName = 'none';
    });

    var run = {
      cleaned: false,
      cancelled: false,
      from: from,
      to: null,
      name: opts.name || 'memo-shared-element',
      result: null,
      transition: null,
      suppressed: suppressed,
      onFinished: opts.onFinished
    };
    activeSharedRun = run;
    from.style.viewTransitionName = run.name;
    var committed = false;
    try {
      var transition = document.startViewTransition(function () {
        // skipTransition() only suppresses animation; browsers may still invoke
        // an update callback that was already queued. A cancelled generation
        // must never mutate stale UI (especially after privacy teardown).
        if (run.cancelled || activeSharedRun !== run) return;
        committed = true;
        if (from.style.viewTransitionName === run.name) from.style.viewTransitionName = '';
        run.result = mutate(true);
        run.to = typeof opts.to === 'function' ? opts.to(run.result) : opts.to;
        if (run.to && run.to.style) run.to.style.viewTransitionName = run.name;
      });
      run.transition = transition;
      activeDocumentTransition = transition;
      settleTransition(transition, function () { finishSharedRun(run); });
      return transition;
    } catch (_e) {
      finishSharedRun(run);
      if (!committed) mutate(false);
      return null;
    }
  }

  // ── Coalesced work ─────────────────────────────────────────────────────────
  var scheduled = new Map();
  function cancelScheduled(key) {
    var active = scheduled.get(key);
    if (!active) return false;
    clearTimeout(active.timer);
    scheduled.delete(key);
    return true;
  }
  function schedule(key, fn, wait) {
    if (typeof fn !== 'function') return;
    cancelScheduled(key);
    var run = { fn: fn, timer: 0 };
    run.timer = setTimeout(function () {
      if (scheduled.get(key) !== run) return;
      scheduled.delete(key);
      run.fn();
    }, Math.max(0, Number(wait) || 0));
    scheduled.set(key, run);
  }

  // ── Folder circular reveal ───────────────────────────────────────────────
  // Two inert snapshots expose the old view outside a moving circle and the
  // new view inside it. clip-path is advanced with rAF instead of WAAPI because
  // repeated compositor clip animations are mis-scaled by some Samsung WebViews.
  var circularRevealRun = 0;
  var circularRevealMutating = false;
  var revealPrewarmed = false;

  function circularRevealActive() { return circularRevealMutating; }

  function releaseRevealLayer(layer) {
    if (!layer) return;
    try { if (global.MemoLazy && global.MemoLazy.release) global.MemoLazy.release(layer); } catch (_e) {}
    try { layer.remove(); } catch (_e2) {}
  }

  function removeRevealLayers() {
    document.querySelectorAll('.nav-reveal').forEach(releaseRevealLayer);
  }

  function cancelCircularReveal() {
    circularRevealRun += 1;
    circularRevealMutating = false;
    removeRevealLayers();
    var feed = document.getElementById('feed');
    if (feed) feed.style.visibility = '';
  }

  function runRevealMutation(mutate) {
    circularRevealMutating = true;
    try { return mutate(); }
    catch (error) {
      cancelCircularReveal();
      throw error;
    }
    finally { circularRevealMutating = false; }
  }

  function warmRevealImages(layer, capMs) {
    if (!layer) return Promise.resolve();
    try { if (global.MemoLazy && global.MemoLazy.hydrate) global.MemoLazy.hydrate(layer); } catch (_e) {}
    var images = Array.prototype.slice.call(layer.querySelectorAll('img'));
    if (!images.length) return Promise.resolve();
    var ready = images.map(function (img) {
      if (img.complete && (img.currentSrc || img.src)) {
        return typeof img.decode === 'function' ? Promise.resolve(img.decode()).catch(function () {}) : Promise.resolve();
      }
      return new Promise(function (resolve) {
        var done = function () {
          img.removeEventListener('load', done);
          img.removeEventListener('error', done);
          if (typeof img.decode === 'function' && (img.currentSrc || img.src)) {
            Promise.resolve(img.decode()).then(resolve, resolve);
          } else resolve();
        };
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      });
    });
    return Promise.race([
      Promise.all(ready),
      new Promise(function (resolve) { setTimeout(resolve, capMs); })
    ]);
  }

  function circularReveal(mutate, options) {
    var opts = options || {};
    var feed = document.getElementById('feed');
    cancelCircularReveal();
    var run = circularRevealRun;
    if (!feed) { runRevealMutation(mutate); return; }
    feed.style.visibility = '';
    cancelViewTransition(feed);
    var clipSupported = !global.CSS || !global.CSS.supports || global.CSS.supports('clip-path', 'circle(1px at 1px 1px)');
    if (reduced() || !clipSupported || typeof global.requestAnimationFrame !== 'function') {
      runRevealMutation(mutate);
      if (opts.direction !== 'exit' && typeof global.scrollTo === 'function') global.scrollTo(0, 0);
      return;
    }

    var width = global.innerWidth;
    var header = document.querySelector('header');
    var areaTop = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
    var height = Math.max(1, global.innerHeight - areaTop);
    var duration = cssDurationMs('--motion-reveal', 300);
    var overscan = 120;

    function centerOf(el) {
      var rect = el && el.getBoundingClientRect && el.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    function clip(origin, radius) {
      return 'circle(' + radius + 'px at ' + origin.x + 'px ' + origin.y + 'px)';
    }
    function originForLayer(layer, viewportOrigin) {
      var rect = layer.getBoundingClientRect();
      var origin = { x: viewportOrigin.x - rect.left, y: viewportOrigin.y - rect.top };
      var radius = Math.ceil(Math.hypot(
        Math.max(origin.x, rect.width - origin.x),
        Math.max(origin.y, rect.height - origin.y)
      )) + 4;
      return { origin: origin, radius: radius };
    }
    function stripMotion(root) {
      var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('.motion-pop, .motion-fade')));
      nodes.forEach(function (node) {
        if (!node || !node.classList) return;
        node.classList.remove('motion-pop', 'motion-fade');
        node.style.removeProperty('--motion-i');
      });
    }
    function snapshot(zIndex) {
      var layer = document.createElement('div');
      layer.className = 'nav-reveal';
      layer.style.cssText = 'top:' + areaTop + 'px;height:' + height + 'px;z-index:' + zIndex;
      layer.setAttribute('aria-hidden', 'true');
      layer.inert = true;
      document.body.appendChild(layer);
      var layerRect = layer.getBoundingClientRect();
      var inner = document.createElement('div');
      inner.className = 'nav-reveal-content';
      inner.style.viewTransitionName = 'none';
      Array.prototype.forEach.call(feed.children, function (child) {
        var rect = child.getBoundingClientRect();
        var near = rect.width > 0 && rect.height > 0 &&
          rect.right >= -overscan && rect.left <= width + overscan &&
          rect.bottom >= areaTop - overscan && rect.top <= global.innerHeight + overscan;
        if (!near) return;
        var copy = child.cloneNode(true);
        copy.removeAttribute('id');
        copy.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id'); });
        copy.querySelectorAll('img[loading]').forEach(function (img) { img.loading = 'eager'; });
        stripMotion(copy);
        copy.style.position = 'absolute';
        copy.style.left = Math.round(rect.left - layerRect.left) + 'px';
        copy.style.top = Math.round(rect.top - layerRect.top) + 'px';
        copy.style.width = Math.round(rect.width) + 'px';
        copy.style.height = Math.round(rect.height) + 'px';
        copy.style.margin = '0';
        inner.appendChild(copy);
      });
      layer.appendChild(inner);
      return layer;
    }
    function clearLayers() {
      if (run !== circularRevealRun) return;
      removeRevealLayers();
    }
    function sweep(layer, viewportOrigin, opening, onEnd) {
      var geometry = originForLayer(layer, viewportOrigin);
      var from = opening ? 0 : geometry.radius;
      var to = opening ? geometry.radius : 0;
      var done = false;
      var start = global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now();
      function finish() {
        if (done) return;
        done = true;
        onEnd();
      }
      function ease(t) {
        return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      }
      layer.style.clipPath = clip(geometry.origin, from);
      function frame(now) {
        if (run !== circularRevealRun) { done = true; return; }
        var elapsed = (now || Date.now()) - start;
        var progress = Math.min(1, elapsed / Math.max(1, duration));
        layer.style.clipPath = clip(geometry.origin, from + (to - from) * ease(progress));
        if (progress < 1) global.requestAnimationFrame(frame);
        else finish();
      }
      global.requestAnimationFrame(frame);
      setTimeout(finish, duration + 120);
    }

    var fallbackOrigin = { x: width / 2, y: areaTop + height * .3 };
    if (opts.direction === 'exit') {
      var leaving = snapshot(42);
      runRevealMutation(mutate);
      var exitOrigin = centerOf(typeof opts.originAfter === 'function' ? opts.originAfter() : null)
        || centerOf(opts.origin) || fallbackOrigin;
      sweep(leaving, exitOrigin, false, clearLayers);
      return;
    }

    var enterOrigin = centerOf(opts.origin) || fallbackOrigin;
    snapshot(40);
    runRevealMutation(mutate);
    if (typeof global.scrollTo === 'function') global.scrollTo(0, 0);
    var entering = snapshot(42);
    entering.style.clipPath = 'circle(0px)';
    feed.style.visibility = 'hidden';
    warmRevealImages(entering, 80).then(function () {
      if (run !== circularRevealRun) return;
      sweep(entering, enterOrigin, true, function () {
        if (run !== circularRevealRun) return;
        feed.style.visibility = '';
        clearLayers();
      });
    });
  }

  function prewarmCircularReveal() {
    if (revealPrewarmed || reduced() || !document.body) return;
    revealPrewarmed = true;
    try {
      var layer = document.createElement('div');
      layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px;opacity:.01;pointer-events:none;z-index:-1;background:#808080;contain:strict';
      document.body.appendChild(layer);
      var frame = 0;
      function step() {
        layer.style.clipPath = 'circle(' + (frame % 2 ? 8 : 0) + 'px at 4px 4px)';
        frame += 1;
        if (frame < 4) global.requestAnimationFrame(step);
        else layer.remove();
      }
      global.requestAnimationFrame(step);
    } catch (_e) {}
  }

  // ── Dialog lifecycle ───────────────────────────────────────────────────────
  var nativeClose = global.HTMLDialogElement && global.HTMLDialogElement.prototype.close;
  var nativeShowModal = global.HTMLDialogElement && global.HTMLDialogElement.prototype.showModal;
  var modalLocks = new WeakSet();
  var modalOpeners = new WeakMap();
  var closingTimers = new WeakMap();
  var modalUnderlayStates = new WeakMap();
  var modalStack = [];
  var modalLockCount = 0;
  var modalLockState = null;
  var dialogObserver = null;

  function removeFromModalStack(dialog) {
    var index = modalStack.indexOf(dialog);
    if (index >= 0) modalStack.splice(index, 1);
  }
  function restoreModalUnderlay(dialog) {
    var state = modalUnderlayStates.get(dialog);
    if (!state) return;
    modalUnderlayStates.delete(dialog);
    dialog.inert = state.inert;
    if (state.hadAriaHidden) dialog.setAttribute('aria-hidden', state.ariaHidden);
    else dialog.removeAttribute('aria-hidden');
  }
  function hideModalUnderlay(dialog) {
    if (!dialog || modalUnderlayStates.has(dialog)) return;
    modalUnderlayStates.set(dialog, {
      inert: !!dialog.inert,
      hadAriaHidden: dialog.hasAttribute('aria-hidden'),
      ariaHidden: dialog.getAttribute('aria-hidden') || ''
    });
    dialog.inert = true;
    dialog.setAttribute('aria-hidden', 'true');
  }
  function noteModalOpen(dialog) {
    removeFromModalStack(dialog);
    restoreModalUnderlay(dialog);
    for (var i = modalStack.length - 1; i >= 0; i--) {
      if (modalStack[i] && modalStack[i].open) {
        hideModalUnderlay(modalStack[i]);
        break;
      }
    }
    modalStack.push(dialog);
  }
  function noteModalClosed(dialog) {
    var wasTop = modalStack[modalStack.length - 1] === dialog;
    removeFromModalStack(dialog);
    restoreModalUnderlay(dialog);
    if (!wasTop) return;
    for (var i = modalStack.length - 1; i >= 0; i--) {
      if (modalStack[i] && modalStack[i].open) {
        restoreModalUnderlay(modalStack[i]);
        break;
      }
    }
  }

  // The dialog actually on top, in TRUE open order (this stack is pushed
  // synchronously from the patched showModal, so nested dialogs opened over each
  // other resolve correctly). The system Back handler uses this so Back always
  // lands on the latest surface instead of closing one behind it. DOM-order
  // fallback covers a dialog opened before this module patched showModal.
  function topModalDialog() {
    for (var i = modalStack.length - 1; i >= 0; i--) {
      if (modalStack[i] && modalStack[i].open) return modalStack[i];
    }
    var open = document.querySelectorAll('dialog[open]');
    return open.length ? open[open.length - 1] : null;
  }

  function rememberStyles(el, names) {
    var out = {};
    names.forEach(function (name) { out[name] = el.style[name]; });
    return out;
  }
  function restoreStyles(el, saved) {
    Object.keys(saved || {}).forEach(function (name) { el.style[name] = saved[name]; });
  }
  function acquireModalLock(dialog) {
    if (!document.body || modalLocks.has(dialog)) return;
    modalLocks.add(dialog);
    modalLockCount += 1;
    if (modalLockCount !== 1) return;
    var root = document.documentElement;
    var body = document.body;
    var scrollX = global.scrollX || 0;
    var scrollY = global.scrollY || 0;
    var gap = Math.max(0, global.innerWidth - root.clientWidth);
    var padding = parseFloat(getComputedStyle(body).paddingRight) || 0;
    modalLockState = {
      scrollX: scrollX,
      scrollY: scrollY,
      rootHadClass: root.classList.contains('dialog-open'),
      bodyHadClass: body.classList.contains('dialog-open'),
      bodyStyles: rememberStyles(body, ['position', 'top', 'left', 'width', 'paddingRight'])
    };
    body.style.position = 'fixed';
    body.style.top = (-scrollY) + 'px';
    body.style.left = (-scrollX) + 'px';
    body.style.width = '100%';
    if (gap) body.style.paddingRight = (padding + gap) + 'px';
    root.classList.add('dialog-open');
    body.classList.add('dialog-open');
  }
  function releaseModalLock(dialog) {
    if (!modalLocks.has(dialog)) return;
    modalLocks.delete(dialog);
    modalLockCount = Math.max(0, modalLockCount - 1);
    if (modalLockCount || !modalLockState) return;
    var state = modalLockState;
    modalLockState = null;
    restoreStyles(document.body, state.bodyStyles);
    if (!state.rootHadClass) document.documentElement.classList.remove('dialog-open');
    if (!state.bodyHadClass) document.body.classList.remove('dialog-open');
    global.scrollTo(state.scrollX, state.scrollY);
  }
  function finishDialogClose(dialog, returnValue) {
    var timer = closingTimers.get(dialog);
    if (timer) clearTimeout(timer);
    closingTimers.delete(dialog);
    dialog.classList.remove('closing');
    if (dialog.open) nativeClose.call(dialog, returnValue);
  }

  if (nativeClose && nativeShowModal) {
    global.HTMLDialogElement.prototype.close = function (returnValue) {
      if (!this.open) return nativeClose.call(this, returnValue);
      if (this.classList.contains('closing')) return;
      var duration = cssDurationMs('--motion-dialog-close', 150);
      if (!duration || getComputedStyle(this).transitionDuration === '0s' || this.id === 'urDlg') {
        return nativeClose.call(this, returnValue);
      }
      var dialog = this;
      dialog.classList.add('closing');
      closingTimers.set(dialog, setTimeout(function () {
        finishDialogClose(dialog, returnValue);
      }, duration));
    };

    global.HTMLDialogElement.prototype.showModal = function () {
      var dialog = this;
      // Treat reopen during the short close animation as the newest intent.
      // The native dialog is still top-layer, so cancel its owned close timer
      // instead of throwing InvalidStateError or letting stale work hide it.
      if (dialog.open && dialog.classList.contains('closing')) {
        var closeTimer = closingTimers.get(dialog);
        if (closeTimer) clearTimeout(closeTimer);
        closingTimers.delete(dialog);
        dialog.classList.remove('closing');
        dialog.style.opacity = '';
        dialog.style.transform = '';
        return;
      }
      // Repeated open requests are idempotent. In particular, do not replace
      // the external opener with a control inside the dialog or flash a fresh
      // inline entrance state while it is already visible.
      if (dialog.open) return;
      var opener = document.activeElement;
      if (opener && opener !== document.body && opener !== document.documentElement) modalOpeners.set(dialog, opener);
      var duration = cssDurationMs('--motion-dialog', 220);
      var animate = duration > 0 && dialog.id !== 'urDlg' && !dialog.classList.contains('detail-morph');
      if (animate) {
        var style = getComputedStyle(dialog);
        dialog.style.opacity = '0';
        dialog.style.transform = style.getPropertyValue('--dialog-enter-transform').trim()
          || 'translateY(8px) scale(.97)';
      }
      try {
        var result = nativeShowModal.call(dialog);
        acquireModalLock(dialog);
        noteModalOpen(dialog);
        if (animate) requestAnimationFrame(function () { requestAnimationFrame(function () {
          if (!dialog.open || dialog.classList.contains('closing')) return;
          dialog.style.opacity = '';
          dialog.style.transform = '';
        }); });
        return result;
      } catch (error) {
        dialog.style.opacity = '';
        dialog.style.transform = '';
        throw error;
      }
    };
  }

  function labelDialog(dialog) {
    if (!dialog || dialog.tagName !== 'DIALOG') return;
    if (!dialog.hasAttribute('aria-label') && !dialog.hasAttribute('aria-labelledby')) {
      var heading = dialog.querySelector('header strong, .modal header strong, .quiz-title');
      if (heading) {
        if (!heading.id) heading.id = (dialog.id || 'dialog') + 'Title';
        dialog.setAttribute('aria-labelledby', heading.id);
      }
    }
    if (dialog.dataset.motionWired) return;
    dialog.dataset.motionWired = '1';
    dialog.addEventListener('cancel', function (event) {
      if (event.defaultPrevented) return;
      if (dialog.id === 'detailDlg' && global.MemoVariant && typeof global.MemoVariant.closeDetail === 'function') {
        event.preventDefault();
        global.MemoVariant.closeDetail();
        return;
      }
      if (reduced() || dialog.id === 'urDlg') return;
      event.preventDefault();
      dialog.close();
    });
    dialog.addEventListener('close', function () {
      var timer = closingTimers.get(dialog);
      if (timer) clearTimeout(timer);
      closingTimers.delete(dialog);
      dialog.classList.remove('closing', 'sheet-dragging', 'sheet-drag-settling');
      dialog.style.removeProperty('--sheet-drag-y');
      dialog.style.opacity = '';
      dialog.style.transform = '';
      noteModalClosed(dialog);
      releaseModalLock(dialog);
      var opener = modalOpeners.get(dialog);
      modalOpeners.delete(dialog);
      if (opener && opener.isConnected && typeof opener.focus === 'function') {
        requestAnimationFrame(function () { try { opener.focus({ preventScroll: true }); } catch (_e) { opener.focus(); } });
      }
    });
  }

  function wireMobileSheet(dialog) {
    if (!dialog || dialog.dataset.sheetWired) return;
    var handle = dialog.querySelector(':scope > .sheet-drag-handle');
    if (!handle) return;
    // The grip sits over the header, so the whole title bar drags the sheet too.
    var header = dialog.querySelector(':scope > .modal > header');
    var NOT_DRAG = 'button, a, input, select, textarea, label, [role="tab"], [contenteditable="true"], .custom-select';
    dialog.dataset.sheetWired = '1';
    var phone = global.matchMedia('(max-width: 540px)');
    var drag = null;
    var settleTimer = 0;

    function clearDrag() {
      clearTimeout(settleTimer);
      settleTimer = 0;
      drag = null;
      dialog.classList.remove('sheet-dragging', 'sheet-drag-settling');
      dialog.style.removeProperty('--sheet-drag-y');
    }
    function snapBack() {
      if (reduced()) { clearDrag(); return; }
      dialog.classList.remove('sheet-dragging');
      dialog.classList.add('sheet-drag-settling');
      dialog.style.setProperty('--sheet-drag-y', '0px');
      settleTimer = setTimeout(clearDrag, cssDurationMs('--motion-dialog', 220) + 60);
    }
    function finish(event, cancelled) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      var active = drag;
      var offset = Math.max(0, event.clientY - active.startY);
      var elapsed = Math.max(1, event.timeStamp - active.lastTime);
      var movedAtRelease = event.clientY !== active.lastY;
      var velocity = movedAtRelease
        ? (event.clientY - active.lastY) / elapsed
        : (elapsed <= 80 ? active.velocity : 0);
      var threshold = Math.min(140, dialog.getBoundingClientRect().height * 0.25);
      try { if (active.source.hasPointerCapture(event.pointerId)) active.source.releasePointerCapture(event.pointerId); } catch (_e) {}
      drag = null;
      if (!cancelled && (offset >= threshold || (offset >= 28 && velocity >= 0.65))) {
        dialog.classList.remove('sheet-dragging');
        dialog.close();
      } else snapBack();
    }
    function start(event) {
      if (!phone.matches || !dialog.open || dialog.classList.contains('closing') || !event.isPrimary
          || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (event.currentTarget === header && event.target.closest && event.target.closest(NOT_DRAG)) return;
      clearDrag();
      drag = {
        source: event.currentTarget,
        pointerId: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastTime: event.timeStamp,
        velocity: 0
      };
      dialog.classList.add('sheet-dragging');
      try { drag.source.setPointerCapture(event.pointerId); } catch (_e) {}
      event.preventDefault();
    }
    function move(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      var offset = Math.max(0, event.clientY - drag.startY);
      var elapsed = Math.max(1, event.timeStamp - drag.lastTime);
      drag.velocity = (event.clientY - drag.lastY) / elapsed;
      drag.lastY = event.clientY;
      drag.lastTime = event.timeStamp;
      dialog.style.setProperty('--sheet-drag-y', offset + 'px');
      event.preventDefault();
    }
    [handle, header].forEach(function (source) {
      if (!source) return;
      source.addEventListener('pointerdown', start);
      source.addEventListener('pointermove', move);
      source.addEventListener('pointerup', function (event) { finish(event, false); });
      source.addEventListener('pointercancel', function (event) { finish(event, true); });
    });
    handle.addEventListener('click', function (event) {
      event.preventDefault();
      if (event.detail === 0 && dialog.open) dialog.close();
    });
    dialog.addEventListener('close', clearDrag);
    if (phone.addEventListener) phone.addEventListener('change', function () { if (!phone.matches) clearDrag(); });
  }

  function wireDocument() {
    document.querySelectorAll('dialog').forEach(function (dialog) {
      labelDialog(dialog);
      if (dialog.classList.contains('mobile-sheet')) wireMobileSheet(dialog);
    });
    if (!document.body || typeof MutationObserver !== 'function' || dialogObserver) return;
    dialogObserver = new MutationObserver(function (records) {
      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes || [], function (node) {
          if (!node || node.nodeType !== 1) return;
          var dialogs = node.matches && node.matches('dialog') ? [node] : Array.prototype.slice.call(node.querySelectorAll ? node.querySelectorAll('dialog') : []);
          dialogs.forEach(function (dialog) {
            labelDialog(dialog);
            if (dialog.classList.contains('mobile-sheet')) wireMobileSheet(dialog);
          });
        });
      });
    });
    dialogObserver.observe(document.body, { childList: true, subtree: true });
  }

  function releaseDocumentObserver() {
    if (!dialogObserver) return;
    dialogObserver.disconnect();
    dialogObserver = null;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireDocument);
  else wireDocument();
  global.addEventListener('pagehide', function (event) {
    cancelSharedElement();
    cancelCircularReveal();
    if (!global.MemoLifecycle?.retain(event) && !event.persisted) releaseDocumentObserver();
  });
  document.addEventListener('memo:privacy-locked', function () {
    cancelSharedElement();
    cancelCircularReveal();
    cancelViewTransition(document.getElementById('feed'));
  });
  document.addEventListener('memo:variant-changed', function () {
    cancelSharedElement();
    cancelCircularReveal();
    cancelViewTransition(document.getElementById('feed'));
  });
  (global.requestIdleCallback || function (fn) { return setTimeout(fn, 1200); })(prewarmCircularReveal);

  // ── FLIP: animate keyed elements across a DOM mutation ────────────────────
  // For "moving items around" UIs (tag pills between Applied/Available, list
  // reorders). Elements keep identity by key across the mutation even when the
  // container is rebuilt from innerHTML. A move WITHIN a container slides
  // (translate); an arrival into a DIFFERENT container — or a brand-new element —
  // pops in (scale/opacity), which avoids being clipped by a panel's overflow.
  //   MemoMotion.flip([panelA, panelB], () => rebuild(), { selector:'.pill', key: el => el.dataset.tag })
  function flip(roots, mutate, opts) {
    opts = opts || {};
    roots = Array.prototype.slice.call(roots || []);
    var sel = opts.selector || '[data-flip-key]';
    var keyOf = opts.key || function (el) { return el.getAttribute('data-flip-key'); };
    if (reduced() || !roots.length) { mutate(); return; }
    var prev = new Map();
    roots.forEach(function (root) {
      if (!root) return;
      root.querySelectorAll(sel).forEach(function (el) { prev.set(keyOf(el), { rect: el.getBoundingClientRect(), root: root }); });
    });
    mutate();
    var dur = opts.duration || 240;
    var ease = 'var(--ease-out, cubic-bezier(.2,.7,.2,1))';
    var items = [];
    roots.forEach(function (root) {
      if (!root) return;
      root.querySelectorAll(sel).forEach(function (el) { items.push({ el: el, root: root, now: el.getBoundingClientRect(), was: prev.get(keyOf(el)) }); });
    });
    items.forEach(function (it) {
      var el = it.el;
      if (it.was && it.was.root === it.root) {
        // Same container: slide from the old spot to the new one.
        var dx = it.was.rect.left - it.now.left, dy = it.was.rect.top - it.now.top;
        if (!dx && !dy) { it.skip = true; return; }
        el.style.transition = 'none';
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      } else if (it.was) {
        // Moved to a DIFFERENT container (e.g. Available → Applied): fly a fixed
        // clone across the gap — unclipped and above everything — and fade the real
        // pill in as it lands, so the move is clearly visible.
        it.fly = true;
        el.style.opacity = '0';
        var c = el.cloneNode(true);
        c.style.cssText = 'position:fixed;margin:0;z-index:100001;pointer-events:none;box-sizing:border-box;left:' +
          it.was.rect.left + 'px;top:' + it.was.rect.top + 'px;width:' + it.was.rect.width + 'px;height:' + it.was.rect.height + 'px;transition:none;';
        document.body.appendChild(c);
        it.clone = c;
      } else {
        // Brand new: pop in.
        el.style.transition = 'none';
        el.style.transform = 'scale(.85)';
        el.style.opacity = '0';
      }
    });
    requestAnimationFrame(function () {
      items.forEach(function (it) {
        if (it.skip) return;
        if (it.fly) {
          var el = it.el, c = it.clone, now = it.now;
          c.style.transition = 'left ' + dur + 'ms ' + ease + ', top ' + dur + 'ms ' + ease + ', width ' + dur + 'ms ' + ease + ', height ' + dur + 'ms ' + ease;
          c.style.left = now.left + 'px'; c.style.top = now.top + 'px';
          c.style.width = now.width + 'px'; c.style.height = now.height + 'px';
          setTimeout(function () { el.style.transition = 'opacity 120ms ease'; el.style.opacity = ''; }, Math.round(dur * 0.6));
          var done = function () { if (c.parentNode) c.parentNode.removeChild(c); el.style.transition = ''; el.style.opacity = ''; };
          c.addEventListener('transitionend', done, { once: true });
          setTimeout(done, dur + 90);
          return;
        }
        it.el.style.transition = 'transform ' + dur + 'ms ' + ease + ', opacity ' + dur + 'ms ease';
        it.el.style.transform = '';
        it.el.style.opacity = '';
      });
      setTimeout(function () {
        items.forEach(function (it) { if (!it.skip && !it.fly) it.el.style.transition = ''; });
      }, dur + 60);
    });
  }

  // Crossfade an in-place content swap (e.g. feed ⇄ recycle bin) so the
  // rebuild isn't a hard cut. `mutate` runs while the element is held hidden,
  // then it fades back in.
  //
  // Deliberately timer-driven with CSS transitions, NOT View Transitions and
  // never awaiting animation.finished: several Android WebViews expose
  // document.startViewTransition but never invoke its callback, and a throttled
  // render loop never resolves .finished — either would strand the swap
  // half-done. Timers always fire, so the content always ends up correct and
  // visible; the fade is purely cosmetic on top.
  function fadeSwap(el, mutate) {
    if (typeof mutate !== 'function') return;
    if (!el || reduced()) { mutate(); return; }
    el.style.transition = 'opacity ' + cssDurationMs('--motion-fast', 140) + 'ms var(--ease-in, ease)';
    el.style.opacity = '0';
    setTimeout(function () {
      try {
        mutate();
      } finally {
        el.style.transition = 'none';
        el.style.opacity = '0';
        void el.offsetWidth;                       // flush so the fade-in animates
        el.style.transition = 'opacity ' + cssDurationMs('--motion-base', 200) + 'ms var(--ease-out, ease)';
        el.style.opacity = '1';
        // Clear inline overrides on a timer so the element can never be left
        // hidden even if the render loop wasn't ticking during the fade.
        setTimeout(function () { el.style.transition = ''; el.style.opacity = ''; }, 260);
      }
    }, 130);
  }

  global.MemoMotion = {
    fadeSwap: fadeSwap,
    stagger: stagger,
    reduced: reduced,
    viewTransition: viewTransition,
    cancelViewTransition: cancelViewTransition,
    sharedElementTransition: sharedElementTransition,
    cancelSharedElement: cancelSharedElement,
    circularReveal: circularReveal,
    cancelCircularReveal: cancelCircularReveal,
    circularRevealActive: circularRevealActive,
    schedule: schedule,
    cancelScheduled: cancelScheduled,
    cssDurationMs: cssDurationMs,
    topModalDialog: topModalDialog,
    flip: flip
  };
})(window);
