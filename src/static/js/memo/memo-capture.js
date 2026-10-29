// memo-capture.js — press-and-hold→camera for the FAB and the in-feed add-card,
// plus FAB auto-hide while the add-card is visible (the FAB is just a shortcut
// for when the add-card has scrolled out of view).  Mirrors ImageDB's capture.js.
//
// Interaction model per target:
//   • short tap   → open the New-entry dialog
//   • press+hold  → after a short grace period a border ring fills (500 ms); on
//                   completion the camera opens directly and the captured photo
//                   is dropped into a fresh entry.
(function (global) {
  'use strict';
  function $(id) { return document.getElementById(id); }

  var HOLD_RING_DELAY = 180; // grace period so a plain tap never flashes the ring
  var HOLD_FILL_MS = 500;    // ring fill duration — must match the CSS animation

  var cameraInput = $('cameraInput');

  function openNewEntry() { if (global.openEntryModal) global.openEntryModal(null); }

  // Camera result → new entry pre-loaded with the photo.
  if (cameraInput) {
    cameraInput.addEventListener('change', function () {
      var files = cameraInput.files;
      if (files && files.length) {
        openNewEntry();
        if (global.addImageFiles) global.addImageFiles(files);
      }
      cameraInput.value = '';
    });
  }

  function openCamera() {
    if (!cameraInput) { openNewEntry(); return; }
    cameraInput.value = '';
    cameraInput.click();
  }

  // Generic press-and-hold wiring.  `progress` is the element whose `.running`
  // class drives the fill animation; `onTap`/`onHold` are the two outcomes.
  function attachHold(el, progress, onTap, onHold, signal) {
    var ringTimer = null, fillTimer = null, fired = false, origin = null;
    var opts = signal ? { signal: signal } : undefined;
    var passive = signal ? { passive: true, signal: signal } : { passive: true };

    function start() { if (progress) progress.classList.add('running'); }
    function reset() { if (progress) { progress.classList.remove('running'); void progress.getBoundingClientRect(); } }
    function cancel() { clearTimeout(ringTimer); clearTimeout(fillTimer); origin = null; if (!fired) reset(); }

    el.addEventListener('pointerdown', function (e) {
      fired = false;
      origin = { x: e.clientX, y: e.clientY };
      ringTimer = setTimeout(function () {
        start();
        fillTimer = setTimeout(function () {
          fired = true;
          reset();
          onHold();
        }, HOLD_FILL_MS);
      }, HOLD_RING_DELAY);
    }, opts);
    // Mouse up = real release; touch up fires immediately, so rely on move/cancel.
    el.addEventListener('pointerup', function (e) { if (e.pointerType !== 'touch') cancel(); }, opts);
    el.addEventListener('pointercancel', cancel, opts);
    el.addEventListener('pointermove', function (e) {
      if (!origin) return;
      var dx = e.clientX - origin.x, dy = e.clientY - origin.y;
      if (dx * dx + dy * dy > 100) cancel(); // dragged >10px → not a hold
    }, opts);
    el.addEventListener('touchend', function () {
      clearTimeout(ringTimer); clearTimeout(fillTimer); origin = null; if (!fired) reset();
    }, passive);
    el.addEventListener('click', function () { if (!fired) onTap(); }, opts);
    return cancel;
  }

  // ── FAB: wired once (it persists across renders) ──────────────────
  var fab = $('fab');
  var fabRing = $('fabRing');
  var fabCancel = fab ? attachHold(fab, fabRing, openNewEntry, openCamera) : null;

  // ── Add-card: re-wired after every feed render (the card is recreated) ──
  var floating = fab ? fab.parentElement : null;
  var addCardObserver = null;
  var addCardAbort = null;

  function showFab(show) {
    if (!floating) return;
    floating.style.opacity = show ? '' : '0';
    floating.style.pointerEvents = show ? '' : 'none';
  }

  function initAddCard() {
    // Tear down the previous card's listeners/observer.
    if (addCardObserver) { addCardObserver.disconnect(); addCardObserver = null; }
    if (addCardAbort) { addCardAbort.abort(); addCardAbort = null; }
    showFab(true);

    var card = $('addCard');
    if (!card) return;
    var progress = card.querySelector('.add-card-progress');

    addCardAbort = new AbortController();
    attachHold(card, progress, openNewEntry, openCamera, addCardAbort.signal);

    // Hide the FAB while the add-card is on screen; show it once scrolled away.
    if (typeof IntersectionObserver === 'function') {
      addCardObserver = new IntersectionObserver(function (entries) {
        showFab(!entries[0].isIntersecting);
      }, { threshold: 0.4 });
      addCardObserver.observe(card);
    }
  }

  // Reset rings if the user dismisses the camera picker without choosing a photo.
  function resetCaptureRings() {
    if (fabRing) fabRing.classList.remove('running');
    var p = document.querySelector('.add-card-progress.running');
    if (p) p.classList.remove('running');
  }
  global.addEventListener('focus', resetCaptureRings);
  global.addEventListener('pagehide', function (event) {
    if (window.MemoLifecycle?.retain(event) || (event && event.persisted)) return;
    if (fabCancel) fabCancel();
    if (addCardObserver) addCardObserver.disconnect();
    if (addCardAbort) addCardAbort.abort();
    addCardObserver = null;
    addCardAbort = null;
    global.removeEventListener('focus', resetCaptureRings);
  });

  global.MemoCapture = { initAddCard: initAddCard };
})(typeof window !== 'undefined' ? window : this);
