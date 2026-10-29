// memo-backdrop.js — a tap outside a dialog closes it.
//
// The dimmed area around a dialog is where people tap to get out of it. A tap
// there closes the dialog the way its own Cancel / ✕ does (so the same clean-up
// runs). If something was typed or changed since it opened, it asks first, so
// a stray tap never throws work away. Full-screen editors and dialogs that
// guard their own leaving are left alone.
(function (global) {
  'use strict';
  var STAY = { imageEditorDlg: 1, mieLeaveDlg: 1, gifEditorDlg: 1, toolEditorDlg: 1, cropDlg: 1, quizDlg: 1 };
  var snapshots = new WeakMap();
  var t = function (s) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s) : s; };

  function fingerprint(dlg) {
    var parts = [];
    dlg.querySelectorAll('input, textarea, select').forEach(function (n) {
      if (n.type === 'file') return;
      parts.push((n.id || n.name || '') + '=' + (n.type === 'checkbox' || n.type === 'radio' ? n.checked : n.value));
    });
    dlg.querySelectorAll('[aria-pressed]').forEach(function (n) { parts.push('p' + n.getAttribute('aria-pressed')); });
    // The entry editor keeps images, files and tags outside its inputs.
    if (dlg.id === 'entryDlg' && global.MemoCore && global.MemoCore.captureDraft) {
      try {
        var d = global.MemoCore.captureDraft();
        if (d) parts.push(JSON.stringify([d.tags, (d.images || []).length, (d.files || []).length, d.variant]));
      } catch (_e) {}
    }
    return parts.join('|');
  }
  function remember(dlg) {
    // Let the opener finish filling the form before taking the "unchanged" copy.
    requestAnimationFrame(function () { if (dlg.open) snapshots.set(dlg, fingerprint(dlg)); });
  }
  function changed(dlg) {
    var before = snapshots.get(dlg);
    return before != null && before !== fingerprint(dlg);
  }

  function closeLikeCancel(dlg) {
    if (dlg.id === 'detailDlg' && global.MemoVariant && typeof global.MemoVariant.closeDetail === 'function') { global.MemoVariant.closeDetail(); return; }
    // Its own way out, most specific first.
    var ways = ['#cancelBtn', '.memo-confirm-cancel', 'footer button[value="cancel"]', 'button[value="cancel"]', '[data-close]', '.dlg-close', 'header .close', 'header button.icon'];
    for (var i = 0; i < ways.length; i++) {
      var own = dlg.querySelector(ways[i]);
      if (own && !own.disabled && own.offsetParent !== null) { own.click(); if (!dlg.open) return; break; }
    }
    var ev = new Event('cancel', { cancelable: true });
    if (dlg.dispatchEvent(ev) && dlg.open) dlg.close('cancel');
  }

  function topModal() {
    var all = document.querySelectorAll('dialog[open]');
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].classList.contains('closing')) continue;      // fading out: already answered
      try { if (all[i].matches(':modal')) return all[i]; } catch (_e) { return all[i]; }
    }
    return null;
  }
  // A tap is "outside" when it lands on the dialog element itself but not on
  // any of its panels (dialogs whose element is the panel compare their box).
  function outside(dlg, x, y) {
    var r = dlg.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return true;
    for (var i = 0; i < dlg.children.length; i++) {
      var c = dlg.children[i].getBoundingClientRect();
      if (c.width && c.height && x >= c.left && x <= c.right && y >= c.top && y <= c.bottom) return false;
    }
    var cs = getComputedStyle(dlg);
    // The dialog draws its own panel (background on the element): inside its box counts as inside.
    return cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent';
  }

  // The dialog a tap on this element belongs to: a dialog still fading out
  // has been answered, so a tap on it is meant for the one underneath.
  function tappedDialog(node) {
    if (!node) return null;
    // With a fading dialog on top, the tap falls through to the page root:
    // nothing outside a modal can be hit, so it is the dimmed area.
    if (node === document.documentElement) return document.querySelector('dialog.closing[open]') ? topModal() : null;
    if (node.tagName !== 'DIALOG') return null;
    return node.classList.contains('closing') ? topModal() : node;
  }
  var downOn = null;
  document.addEventListener('pointerdown', function (e) {
    var dlg = tappedDialog(e.target);
    downOn = dlg && dlg === topModal() && outside(dlg, e.clientX, e.clientY) ? dlg : null;
  }, true);
  document.addEventListener('click', function (e) {
    var dlg = downOn; downOn = null;
    // Both ends of the tap outside (not a drag that started in the form), and
    // the dialog's own handler did not already close it.
    if (!dlg || tappedDialog(e.target) !== dlg || !dlg.open || STAY[dlg.id] || dlg.hasAttribute('data-backdrop-stay')) return;
    if (!outside(dlg, e.clientX, e.clientY)) return;
    if (!changed(dlg) || !global.MemoShell || !global.MemoShell.choose) { closeLikeCancel(dlg); return; }
    global.MemoShell.choose(t('Discard your changes?'), { okLabel: t('Keep editing'), okValue: 'keep', secondaryLabel: t('Discard'), secondaryValue: 'discard', danger: false })
      .then(function (pick) { if (pick === 'discard' && dlg.open) closeLikeCancel(dlg); });
  });

  // Watch every dialog opening, including ones made later by script.
  new MutationObserver(function (list) {
    list.forEach(function (m) {
      if (m.type === 'attributes' && m.target.tagName === 'DIALOG' && m.target.open) remember(m.target);
    });
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });

  global.MemoBackdrop = { changed: changed, remember: remember };
})(window);
