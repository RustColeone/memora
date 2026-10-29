// memo-ctxmenu.js — shared context menu + long-press, used by EVERY variant
// (memo / finance / planner). This owns the menu element, positioning, and open/close;
// each variant supplies its own item list. Long-press (or right-click) a card/row to
// open it; "Select" is one item that enters the variant's own select mode.
//
//   MemoCtx.attachLongPress(el, ({clientX, clientY}) => MemoCtx.showMenu(clientX, clientY, items))
//   items = [ { html, onClick, danger? } | { sep:true } | HTMLElement ]
(function (global) {
  'use strict';

  var menuEl = null;
  var menuOpener = null;
  var popupObserver = null;
  var _eatNextClick = false, _eatTimer = null;

  function nativeHaptic(type) {
    if (global.MemoNativeUi) void global.MemoNativeUi.haptic(type);
  }

  // Registered FIRST (document, capture) so it runs during the capturing phase — before
  // any target-element click listener. When a long-press just fired, it eats the click
  // that ends the press: stops it reaching the card (no openDetail) AND the outside-
  // dismiss (below, same node) via stopImmediatePropagation, so the menu stays open.
  document.addEventListener('click', function (e) {
    if (_eatNextClick) { _eatNextClick = false; clearTimeout(_eatTimer); e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  function ensureMenu() {
    if (menuEl && menuEl.isConnected) return menuEl;
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    menuEl.id = 'ctxMenu';
    menuEl.setAttribute('role', 'menu');
    menuEl.setAttribute('aria-label', 'Context actions');
    menuEl.setAttribute('aria-hidden', 'true');
    // Focusable so opening the menu can land focus on the container (not the first
    // item) — a pointer-opened menu shouldn't show a highlighted "tabbed" item, but
    // arrow keys must still enter the list. See showMenu.
    menuEl.tabIndex = -1;
    menuEl.addEventListener('keydown', function (event) {
      handleMenuKeys(event, menuEl, function () { hide(true); });
    });
    document.body.appendChild(menuEl);
    return menuEl;
  }

  function menuItems(container) {
    return container ? Array.prototype.filter.call(container.querySelectorAll('[role="menuitem"]'), function (item) {
      return !item.disabled && !item.hidden && getComputedStyle(item).display !== 'none'
        && getComputedStyle(item).visibility !== 'hidden';
    }) : [];
  }
  function focusMenuItem(container, position) {
    var items = menuItems(container);
    if (!items.length) return;
    var item = position === 'last' ? items[items.length - 1] : items[0];
    try { item.focus({ preventScroll: true }); } catch (_e) { item.focus(); }
  }
  function handleMenuKeys(event, container, closeFn) {
    var items = menuItems(container);
    var current = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFn();
      return;
    }
    if (event.key === 'Tab') { closeFn(false); return; }
    var next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (current + 1 + items.length) % items.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (current - 1 + items.length) % items.length;
    else return;
    if (!items.length) return;
    event.preventDefault();
    event.stopPropagation();
    items[next].focus();
  }
  function hide(restoreFocus) {
    if (!menuEl) return;
    menuEl.classList.remove('open');
    menuEl.setAttribute('aria-hidden', 'true');
    var opener = menuOpener;
    menuOpener = null;
    if (restoreFocus && opener && opener.isConnected && typeof opener.focus === 'function') {
      try { opener.focus({ preventScroll: true }); } catch (_e) { opener.focus(); }
    }
  }
  function isOpen() { return !!(menuEl && menuEl.classList.contains('open')); }

  function mkItem(html, onClick, danger) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (danger ? ' danger' : '');
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.innerHTML = html;
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      hide(true);
      if (typeof onClick === 'function') { try { onClick(ev); } catch (e) { console.error(e); } }
    });
    return b;
  }
  function mkSep() { var d = document.createElement('div'); d.className = 'ctx-sep'; d.setAttribute('role', 'separator'); return d; }

  // Show a menu at (x, y), clamped into the viewport. `items` entries are objects
  // ({html,onClick,danger} or {sep:true}) or ready-made nodes.
  function showMenu(x, y, items) {
    var m = ensureMenu();
    var active = document.activeElement;
    menuOpener = active && active !== document.body && active !== document.documentElement ? active : null;
    m.innerHTML = '';
    (items || []).forEach(function (it) {
      if (!it) return;
      if (it instanceof Node) { m.appendChild(it); return; }
      if (it.sep) { m.appendChild(mkSep()); return; }
      m.appendChild(mkItem(it.html, it.onClick, it.danger));
    });
    if (!m.childElementCount) return;
    m.querySelectorAll('button, a[href]').forEach(function (item) {
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
    });
    m.classList.add('open');                       // display:block so we can measure
    m.setAttribute('aria-hidden', 'false');
    var vw = window.innerWidth, vh = window.innerHeight;
    var mw = m.offsetWidth || 230, mh = m.offsetHeight || (m.childElementCount * 44 + 12);
    m.style.left = Math.max(8, Math.min(x, vw - mw - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, vh - mh - 8)) + 'px';
    // Focus the menu container, not the first item: the menu opens from a pointer
    // long-press/right-click, so a highlighted first item reads as an accidental
    // selection. Arrow keys still move into the items (handleMenuKeys treats a
    // container-focused menu as index -1, so ArrowDown lands on the first item).
    try { m.focus({ preventScroll: true }); } catch (_e) { m.focus(); }
  }

  function popupTrigger(popup) {
    if (!popup) return null;
    if (popup.id === 'urHoldMenu') return document.getElementById('urActionsBtn');
    var wrap = popup.closest && popup.closest('.modal-menu-wrap');
    return wrap ? wrap.querySelector('.modal-menu') : null;
  }
  function popupOpen(popup) {
    if (!popup) return false;
    return popup.classList.contains('ur-hold-menu') ? !popup.hidden : popup.classList.contains('open');
  }
  function syncPopup(popup) {
    if (!popup || !(popup.classList.contains('modal-menu-popup') || popup.classList.contains('ur-hold-menu'))) return;
    var trigger = popupTrigger(popup);
    var open = popupOpen(popup);
    var wasOpen = popup.dataset.a11yOpen === 'true';
    popup.dataset.a11yOpen = open ? 'true' : 'false';
    popup.setAttribute('role', 'menu');
    popup.setAttribute('aria-hidden', open ? 'false' : 'true');
    popup.querySelectorAll('.modal-menu-item, .ur-menu-btn').forEach(function (item) {
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
    });
    popup.querySelectorAll('.ur-hold-sep').forEach(function (separator) { separator.setAttribute('role', 'separator'); });
    popup.querySelectorAll('.ur-hold-title').forEach(function (title) { title.setAttribute('role', 'presentation'); });
    if (trigger) {
      if (!popup.id) popup.id = (trigger.id || 'menuTrigger') + 'Popup';
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-controls', popup.id);
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!popup.hasAttribute('aria-label')) {
        popup.setAttribute('aria-label', (trigger.getAttribute('aria-label') || trigger.title || 'Actions') + ' menu');
      }
    }
    if (open && !wasOpen) requestAnimationFrame(function () {
      if (popupOpen(popup)) focusMenuItem(popup, 'first');
    });
  }
  function closePopup(popup, restoreFocus) {
    var trigger = popupTrigger(popup);
    if (popup.id === 'urHoldMenu' && global.MemoReader && typeof global.MemoReader.handleBack === 'function') {
      global.MemoReader.handleBack();
    } else if (popup.classList.contains('ur-hold-menu')) popup.hidden = true;
    else popup.classList.remove('open');
    syncPopup(popup);
    if (restoreFocus && trigger && trigger.isConnected) {
      try { trigger.focus({ preventScroll: true }); } catch (_e) { trigger.focus(); }
    }
  }
  function upgradePopups(root) {
    var popups = [];
    if (root && root.matches && root.matches('.modal-menu-popup, .ur-hold-menu')) popups.push(root);
    if (root && root.querySelectorAll) {
      Array.prototype.push.apply(popups, root.querySelectorAll('.modal-menu-popup, .ur-hold-menu'));
    }
    popups.forEach(syncPopup);
  }
  function wirePopupSemantics() {
    upgradePopups(document);
    if (!document.body || typeof MutationObserver !== 'function' || popupObserver) return;
    popupObserver = new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === 'attributes') syncPopup(record.target);
        Array.prototype.forEach.call(record.addedNodes || [], upgradePopups);
        if (record.target && record.target.closest) syncPopup(record.target.closest('.modal-menu-popup, .ur-hold-menu'));
      });
    });
    popupObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  }
  function releasePopupObserver() {
    if (!popupObserver) return;
    popupObserver.disconnect();
    popupObserver = null;
  }

  // Long-press (pointer, 500ms, movement-cancelled) + right-click → cb({clientX,clientY}).
  // Swallows the click that follows a fired long-press so the element's own click
  // (e.g. open-detail) doesn't also run.
  function attachLongPress(el, cb) {
    var timer = null, sx = 0, sy = 0, fired = false, capId = null;
    function clear() {
      if (timer) { clearTimeout(timer); timer = null; }
      // Release the pointer capture taken in pointerdown (below). Without this the
      // element would keep swallowing pointer events after the gesture ended.
      if (capId != null) { try { el.releasePointerCapture(capId); } catch (_e) { /* noop */ } capId = null; }
    }
    // Chrome/Edge start a native text-selection or image-drag on a press-and-hold. That
    // native gesture grabs the pointer and FREEZES all input until release, and it also
    // fires pointercancel that kills the long-press (Firefox does neither). Suppress
    // selection/drag/callout AND capture the pointer so the whole hold stays on this
    // element — nothing native can hijack it, so input is never blocked.
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';
    el.style.webkitTouchCallout = 'none';   // iOS long-press callout
    el.addEventListener('dragstart', function (e) { e.preventDefault(); });
    el.addEventListener('selectstart', function (e) { e.preventDefault(); });
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // right-click → contextmenu path
      // A parent card's pointer capture retargets the eventual click back to the
      // card. Do not start a card long-press from an interactive descendant:
      // otherwise a thumbnail or PDF button opens the entry detail instead of
      // its reader action after a normal physical tap in Chromium/Edge.
      var target = e.target;
      if (target && target.closest && target.closest('button, a, input, select, textarea, img, [data-no-longpress]')) return;
      fired = false;
      sx = e.clientX; sy = e.clientY;
      // Own the pointer for the whole hold. This is the key fix for Edge/Chromium: a
      // captured pointer can't start a native selection/drag, so the page stays
      // responsive during the press instead of locking up until release.
      capId = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch (_e) { /* noop */ }
      timer = setTimeout(function () {
        timer = null; fired = true;
        // Swallow the click that ENDS the press so the element's own click (openDetail)
        // doesn't also fire — a per-element capture listener can't, because at the
        // target listeners run in registration order and openDetail is registered first.
        // The document-capture eater (below) runs during the CAPTURING phase, first.
        _eatNextClick = true;
        clearTimeout(_eatTimer); _eatTimer = setTimeout(function () { _eatNextClick = false; }, 800);
        nativeHaptic('longPress');
        cb({ clientX: sx, clientY: sy });
      }, 500);
    });
    el.addEventListener('pointermove', function (e) {
      if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) clear();
    });
    el.addEventListener('pointerup', clear);
    el.addEventListener('pointerleave', clear);
    el.addEventListener('pointercancel', clear);
    // Native contextmenu = right-click (mouse) → open the menu there. On touch, Chromium
    // ALSO fires this at the OS long-press threshold, but our timer has already opened
    // the menu by then, so just swallow the native one (no double-open, no native UI).
    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (fired) { fired = false; return; }   // touch/pen long-press already handled it
      clear();
      cb({ clientX: e.clientX, clientY: e.clientY });
    });
  }

  // ── Dialog header ✕ (shared across every dialog on every page) ──
  // Inject a top-right ✕ into any dialog's header and close via delegation, so all
  // dialogs get a consistent header close without hand-editing each one.
  function headerHasClose(header) {
    var btns = header.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i], t = (b.textContent || '').trim();
      if (b.classList.contains('modal-close') || b.value === 'cancel' ||
          b.getAttribute('title') === 'Close' || t === '✕' || t === 'Close') return true;
    }
    return false;
  }
  function addCloseButton(dlg) {
    if (!dlg) return;
    // Every dialog gets a header ✕. On swipe-dismiss sheets it is hidden by CSS
    // in the phone (≤540px) breakpoint — there the grip + backdrop tap dismiss —
    // but stays visible in landscape/tablet where the sheet is a plain centered
    // card with no grip, so the title bar keeps its ✕. Card dialogs keep it in
    // all sizes. Mirrors ImageDB.
    var header = dlg.querySelector('.modal header, .modal > header');
    // Skip if the header already has a close control (our ✕, a planner form-dialog
    // value="cancel" ✕, or a "Close" button like the chat/debug dialogs) — never
    // inject a duplicate.
    if (!header || headerHasClose(header)) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'modal-close';
    b.setAttribute('aria-label', 'Close');
    b.innerHTML = '✕';
    header.appendChild(b);
  }
  function initCloses() { document.querySelectorAll('dialog').forEach(addCloseButton); }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.modal-close') : null;
    if (!btn) return;
    var dlg = btn.closest('dialog');
    if (dlg && dlg.open) {
      e.preventDefault();
      if (dlg.id === 'detailDlg' && global.MemoVariant && typeof global.MemoVariant.closeDetail === 'function') {
        global.MemoVariant.closeDetail();
      } else dlg.close();
    }
  });
  // Backdrop tap closes a swipe sheet. Since these lost their ✕, this is the
  // dismiss in landscape (no drag handle there); in portrait it complements the
  // swipe. e.target is the <dialog> only when the tap lands on the backdrop —
  // taps inside .modal target the content, so this never eats real interactions.
  // Card dialogs are intentionally excluded so a stray tap can't discard an
  // in-progress entry/form.
  document.addEventListener('click', function (e) {
    var dlg = e.target;
    if (dlg && dlg.tagName === 'DIALOG' && dlg.open && dlg.classList.contains('mobile-sheet')) {
      dlg.close();
    }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCloses);
  else initCloses();

  // Global dismiss (outside click / Esc / scroll).
  document.addEventListener('click', function (e) {
    if (isOpen() && menuEl && !menuEl.contains(e.target)) hide();
  }, true);
  document.addEventListener('keydown', function (event) {
    var popup = event.target && event.target.closest && event.target.closest('.modal-menu-popup.open, .ur-hold-menu:not([hidden])');
    if (popup) {
      handleMenuKeys(event, popup, function () { closePopup(popup, true); });
      return;
    }
    if (event.key === 'Escape' && isOpen()) hide(true);
  }, true);
  window.addEventListener('scroll', function () { if (isOpen()) hide(false); }, true);
  window.addEventListener('resize', function () { hide(false); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wirePopupSemantics);
  else wirePopupSemantics();
  window.addEventListener('pagehide', function (event) {
    if (!global.MemoLifecycle?.retain(event) && !event.persisted) releasePopupObserver();
  });

  global.MemoCtx = {
    attachLongPress: attachLongPress,
    showMenu: showMenu,
    hide: hide,
    isOpen: isOpen,
    mkItem: mkItem,
    mkSep: mkSep,
    addCloseButton: addCloseButton,   // for dynamically-created dialogs
  };
})(window);
