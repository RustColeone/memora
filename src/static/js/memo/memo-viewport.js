// memo-viewport.js — phones in landscape keep the same proportions.
//
// A phone turned sideways is only ~390 CSS px tall, so a layout sized for
// portrait looks oversized: the header, the tabs and a dialog's buttons eat
// most of the screen. On a touch screen whose short side is under 500 px, in
// landscape, the page is drawn at short/480 (at least 0.75) of its size, so it
// lays out like a ~480 px tall window — the way the desktop app looks in a
// small window. Portrait, tablets and mouse screens are left at 1. The size is
// read from `screen`, which the scale itself does not change.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="viewport"]');
  if (!meta || !window.matchMedia) return;
  var TARGET = 480, MIN = 0.75;
  var base = (meta.getAttribute('content') || '').split(',').map(function (s) { return s.trim(); })
    .filter(function (s) { return s && !/^(initial|minimum|maximum)-scale\s*=/.test(s); });
  var current = 1;

  function scale() {
    if (!matchMedia('(pointer: coarse)').matches) return 1;
    var w = screen.width, h = screen.height, short = Math.min(w, h);
    if (!short || short >= 500) return 1;
    var type = screen.orientation && screen.orientation.type;
    var landscape = type ? /landscape/.test(type) : w > h;
    if (!landscape) return 1;
    return Math.max(MIN, Math.min(1, Math.round(short / TARGET * 100) / 100));
  }

  function apply() {
    var s = scale();
    if (s === current) return;
    current = s;
    var parts = base.slice();
    if (s === 1) parts.push('initial-scale=1.0');
    else parts.push('initial-scale=' + s, 'minimum-scale=' + s, 'maximum-scale=' + s);
    if (s === 1 && base.some(function (p) { return /^user-scalable\s*=\s*no/.test(p); })) parts.push('maximum-scale=1.0');
    meta.setAttribute('content', parts.join(', '));
    document.documentElement.classList.toggle('scaled-landscape', s !== 1);
  }

  // Keyboard up: on a touch screen the page gets much shorter while a text
  // field has focus. The bottom bar and the + button would then sit right on
  // top of the keyboard, over the form being filled in, so `kb-open` hides them.
  var tallest = {};
  function typing(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file|image|hidden)$/i.test(el.type || '');
  }
  function keyboard() {
    var key = (screen.orientation && screen.orientation.type) || (innerWidth > innerHeight ? 'l' : 'p');
    var h = Math.min(innerHeight, window.visualViewport ? visualViewport.height : innerHeight);
    tallest[key] = Math.max(tallest[key] || 0, h);
    var root = document.documentElement, short = h < tallest[key] * 0.8;
    // Opens with a text field in focus; closes only once the page is tall
    // again. Tapping a button while typing blurs the field first, and the bar
    // coming back before the keyboard has gone would move what the finger is on.
    var open = matchMedia('(pointer: coarse)').matches && short && (typing(document.activeElement) || root.classList.contains('kb-open'));
    root.classList.toggle('kb-open', open);
  }

  apply();
  keyboard();
  window.addEventListener('resize', function () { apply(); keyboard(); });
  if (window.visualViewport) visualViewport.addEventListener('resize', keyboard);
  document.addEventListener('focusin', keyboard);
  document.addEventListener('focusout', function () { setTimeout(keyboard, 0); });
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', apply);
  window.MemoViewport = { scale: function () { return current; }, apply: apply, keyboard: keyboard };
})();
