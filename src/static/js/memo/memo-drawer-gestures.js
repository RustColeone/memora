// memo-drawer-gestures.js — swipe the menu drawer open and closed (port of
// ImageDB's side-panel-gestures.js).
//
// The drawer sits on the right. A clearly horizontal swipe to the left on the
// page content opens it; a swipe to the right on the open drawer (or its
// backdrop) closes it. The drawer follows the finger; on release it keeps the
// finger's momentum (where it would coast to decides open or closed, and a
// spring carries it there from the release speed), then MemoShell, which owns
// focus, inert and aria state, takes over. Swipes that start within the outer
// edge strips are left alone: with Android gesture navigation those belong to
// the system Back gesture (NativeUi reports their width; zero with 3-button
// navigation, so the menu then opens from the very edge).
(function (global) {
  'use strict';

  var EDGE_GUARD_PX = 28;        // system back-gesture strip when Android does not say
  var START_PX = 14;             // movement before a direction is decided
  var DOMINANCE = 1.6;           // |dx| must exceed |dy| by this factor
  var COMMIT_FRACTION = 0.33;    // a projected third of the width commits the swipe
  var MIN_TRAVEL = 0.15;         // momentum only counts after a real drag, not a brush
  var MAX_COAST = 0.6;           // how far momentum alone can carry the drawer
  var PROJECTION_MS = 200;       // how far the release speed carries it
  var VELOCITY_WINDOW_MS = 80;   // speed over the last moments of the drag
  var SPRING_OMEGA = 0.024;      // critically damped spring, per ms (~300 ms)
  var SCROLLER_EDGE_PX = 24;     // from a sideways scroller, only this close to the edge opens

  var gesture = null;
  var settling = 0;

  function edgeGuard(side) {
    var value = getComputedStyle(document.documentElement).getPropertyValue('--system-gesture-' + side).trim();
    var px = parseFloat(value);
    return value && isFinite(px) ? px : EDGE_GUARD_PX;
  }

  function menu() { return document.getElementById('mobileMenu'); }
  function overlay() { return document.getElementById('mobileOverlay'); }
  function isOpen() { var m = menu(); return !!(m && m.classList.contains('open')); }

  // A horizontal swipe inside something that scrolls sideways (the folder
  // strip, a wide table, the Gantt chart) scrolls it instead.
  function inHorizontalScroller(node) {
    for (var el = node; el && el !== document.body; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1) {
        var ox = getComputedStyle(el).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
    }
    return false;
  }

  function canOpen(target) {
    if (isOpen() || document.querySelector('dialog[open]')) return false;
    var body = document.body;
    if (body.classList.contains('privacy-locked') || body.classList.contains('select-mode')) return false;
    var lightbox = document.getElementById('lightbox');
    if (lightbox && lightbox.getAttribute('aria-hidden') === 'false') return false;
    // The feed, or the empty page below a short feed.
    if (!target.closest || !(target.closest('main') || target === document.body || target === document.documentElement)) return false;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return false;
    return true;
  }

  function width() { var m = menu(); return (m && m.getBoundingClientRect().width) || 280; }

  // progress: 0 = closed, 1 = fully open.
  function paint(progress) {
    var p = Math.max(0, Math.min(1, progress));
    var m = menu(), o = overlay();
    m.style.transform = 'translateX(' + ((1 - p) * 100) + '%)';
    if (o) o.style.opacity = String(p);
  }

  function beginDrag(state) {
    cancelAnimationFrame(settling);
    settling = 0;
    state.dragging = true;
    var m = menu(), o = overlay();
    m.classList.add('drawer-dragging');
    m.style.opacity = '1';
    if (o) { o.classList.add('drawer-dragging'); o.style.visibility = 'visible'; o.style.pointerEvents = 'none'; }
  }

  // Hand the final state to MemoShell; the drag classes keep CSS transitions
  // off until the inline styles match the class state.
  function finish(open) {
    var m = menu(), o = overlay();
    m.style.removeProperty('transform');
    m.style.removeProperty('opacity');
    if (o) ['opacity', 'visibility', 'pointer-events'].forEach(function (p) { o.style.removeProperty(p); });
    var shell = global.MemoShell;
    if (shell) { if (open) shell.openMenu(); else shell.closeMenu(); }
    requestAnimationFrame(function () {
      m.classList.remove('drawer-dragging');
      if (o) o.classList.remove('drawer-dragging');
    });
  }

  // Spring from the release position and speed (progress per ms) to 0 or 1.
  function settle(progress, velocity, open) {
    var target = open ? 1 : 0;
    var reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { paint(target); finish(open); return; }
    var x = progress, v = velocity, last = performance.now();
    function step(now) {
      var dt = Math.min(32, now - last);
      last = now;
      while (dt > 0) {
        var h = Math.min(8, dt);
        var accel = -SPRING_OMEGA * SPRING_OMEGA * (x - target) - 2 * SPRING_OMEGA * v;
        v += accel * h;
        x += v * h;
        dt -= h;
      }
      // Momentum may carry it past the end: stop there instead of overshooting.
      if ((open && x >= 1) || (!open && x <= 0) || (Math.abs(x - target) < 0.002 && Math.abs(v) < 0.0004)) {
        settling = 0; paint(target); finish(open); return;
      }
      paint(x);
      settling = requestAnimationFrame(step);
    }
    settling = requestAnimationFrame(step);
  }

  function progressOf(state) {
    var dx = state.lastX - state.startX;
    return Math.max(0, Math.min(1, state.mode === 'open' ? -dx / width() : 1 - dx / width()));
  }
  // Toward-open speed in progress per ms, measured up to the release: a finger
  // that stopped before letting go has no speed.
  function velocityOf(state, releaseT) {
    var recent = state.samples.filter(function (sample) { return releaseT - sample.t <= VELOCITY_WINDOW_MS; });
    if (recent.length < 2) return 0;
    var first = recent[0], last = recent[recent.length - 1];
    return -(last.x - first.x) / Math.max(1, releaseT - first.t) / width();
  }

  function onStart(event) {
    gesture = null;
    if (event.touches.length !== 1 || !menu()) return;
    var touch = event.touches[0], x = touch.clientX;
    if (x < edgeGuard('left') || x > global.innerWidth - edgeGuard('right')) return;
    var open = isOpen();
    var m = menu(), o = overlay();
    if (open ? !(m.contains(event.target) || event.target === o) : !canOpen(event.target)) return;
    // Sideways scrollers (the folder row, a wide table, the image strip) own
    // swipes that start on them; only the last strip at the right edge opens.
    if (!open && x < global.innerWidth - SCROLLER_EDGE_PX && inHorizontalScroller(event.target)) return;
    // Inside the open drawer, leave sideways scrollers and fields alone too.
    if (open && (inHorizontalScroller(event.target) || (event.target.closest && event.target.closest('input, textarea, select')))) return;
    gesture = { mode: open ? 'close' : 'open', startX: x, startY: touch.clientY,
      lastX: x, samples: [{ x: x, t: event.timeStamp }], dragging: false, decided: false };
  }

  function onMove(event) {
    if (!gesture) return;
    var touch = event.touches[0];
    var dx = touch.clientX - gesture.startX;
    var dy = touch.clientY - gesture.startY;
    if (!gesture.decided) {
      if (Math.hypot(dx, dy) < START_PX) return;
      gesture.decided = true;
      var horizontal = Math.abs(dx) > Math.abs(dy) * DOMINANCE;
      var rightWay = gesture.mode === 'open' ? dx < 0 : dx > 0;
      if (!horizontal || !rightWay) { gesture = null; return; }
      beginDrag(gesture);
    }
    gesture.lastX = touch.clientX;
    gesture.samples.push({ x: touch.clientX, t: event.timeStamp });
    while (gesture.samples.length > 2 && event.timeStamp - gesture.samples[0].t > VELOCITY_WINDOW_MS) gesture.samples.shift();
    paint(progressOf(gesture));
    if (event.cancelable) event.preventDefault();
  }

  function onEnd(event) {
    if (!gesture) return;
    var state = gesture;
    gesture = null;
    if (!state.dragging) return;
    var progress = progressOf(state);
    var velocity = velocityOf(state, event.timeStamp);
    var travelled = Math.abs(state.lastX - state.startX) / width();
    var coast = travelled < MIN_TRAVEL ? 0 : Math.max(-MAX_COAST, Math.min(MAX_COAST, velocity * PROJECTION_MS));
    var projected = progress + coast;
    var open = state.mode === 'open' ? projected >= COMMIT_FRACTION : projected > 1 - COMMIT_FRACTION;
    settle(progress, velocity, open);
  }

  function onCancel() {
    if (!gesture) return;
    var state = gesture;
    gesture = null;
    // An interrupted drag returns to where it started.
    if (state.dragging) settle(progressOf(state), 0, state.mode === 'close');
  }

  // The native side reports its edges as they change; ask once the page is up,
  // since an early report can land before the page has loaded.
  var nativeUi = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.NativeUi;
  if (nativeUi && nativeUi.getGestureEdges) {
    nativeUi.getGestureEdges().then(function (edges) {
      var style = document.documentElement.style;
      if (edges && edges.left >= 0) style.setProperty('--system-gesture-left', edges.left + 'px');
      if (edges && edges.right >= 0) style.setProperty('--system-gesture-right', edges.right + 'px');
    }).catch(function () {});
  }

  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd, { passive: true });
  document.addEventListener('touchcancel', onCancel, { passive: true });
})(window);
