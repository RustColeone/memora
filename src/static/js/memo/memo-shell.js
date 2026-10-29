// memo-shell.js — shared app-chrome wiring for every page (memo / finance /
// planner): theme toggle + cross-tab sync, hamburger-menu open/close (button,
// overlay, Escape), and .debug-only visibility. This used to be copy-pasted
// across memo-theme.js, planner-app.js and planner-menu.js; now it lives once.
//
// Page-specific menu behaviour (which mobile buttons do what, and whether a
// button click closes the menu) stays in the per-page modules, because the memo
// menu contains in-menu controls — the Day/Week/Month/Year group buttons — that
// must NOT close the menu, whereas the planner menu is action-only.
(function (global) {
  'use strict';
  // Theme = a mode (dark / light / system) plus one look per mode. System
  // shows the dark look while the device is dark and the light look while it
  // is light. data-theme="light" still means "light" everywhere (native bars,
  // reader, planner); data-look picks the palette (memo.css). Graphite and
  // Daylight are the base palettes and set no data-look. The inline boot
  // script in head.html / planner.html applies the same rules before paint.
  var THEME_KEY = 'memoTheme';
  var LOOK_KEYS = { dark: 'memoLookDark', light: 'memoLookLight' };
  var LOOKS = {
    dark: [['graphite', 'Graphite', '#17181b', '#e0a458'], ['midnight', 'Midnight', '#000000', '#7aa2ff'],
      ['sage', 'Sage', '#141a17', '#8fcf9f'], ['plum', 'Plum', '#1a1520', '#e58fb5']],
    light: [['daylight', 'Daylight', '#f8fafc', '#2563eb'], ['paper', 'Paper', '#f6f1e7', '#a94e25']]
  };
  var systemLight = global.matchMedia ? global.matchMedia('(prefers-color-scheme: light)') : null;

  function stored(key) { try { return localStorage.getItem(key); } catch (_e) { return null; } }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (_e) {} }
  function readMode() { var m = stored(THEME_KEY); return m === 'light' || m === 'system' ? m : 'dark'; }
  function readLook(kind) {
    var id = stored(LOOK_KEYS[kind]);
    return LOOKS[kind].some(function (l) { return l[0] === id; }) ? id : LOOKS[kind][0][0];
  }
  // The device's dark mode. Android's WebView always reports
  // prefers-color-scheme: light, so the app asks NativeUi and saves the last
  // answer (memoSystemDark) for the pre-paint boot script; browsers use the
  // media query.
  var NATIVE_DARK_KEY = 'memoSystemDark';
  function systemIsLight() {
    var native = stored(NATIVE_DARK_KEY);
    if (native === '1' || native === '0') return native === '0';
    return !!(systemLight && systemLight.matches);
  }
  // The light/dark actually shown for a mode.
  function resolvedTheme(mode) {
    mode = mode || readMode();
    if (mode === 'system') return systemIsLight() ? 'light' : 'dark';
    return mode;
  }
  function nativeUi() { var C = global.Capacitor; return C && C.isNativePlatform && C.isNativePlatform() && C.Plugins ? C.Plugins.NativeUi : null; }
  function watchNativeNightMode() {
    var p = nativeUi();
    if (!p || typeof p.getNightMode !== 'function') return;
    var take = function (r) {
      if (!r || typeof r.dark !== 'boolean') return;
      store(NATIVE_DARK_KEY, r.dark ? '1' : '0');
      if (readMode() === 'system') reflectTheme();
    };
    Promise.resolve(p.getNightMode()).then(take).catch(function () {});
    try { p.addListener('nightModeChanged', take); } catch (_e) {}
  }
  function readTheme() { return resolvedTheme(); }
  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    var look = readLook(theme === 'light' ? 'light' : 'dark');
    if (look === LOOKS.dark[0][0] || look === LOOKS.light[0][0]) root.removeAttribute('data-look');
    else root.setAttribute('data-look', look);
  }
  function updateThemeButton(theme) {
    var icon = theme === 'light' ? 'sun' : 'moon';
    var title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
    // The header toggle (wide layouts) flips light/dark in one tap; the menu's
    // Theme tile opens the Theme sheet instead and keeps its palette icon.
    document.querySelectorAll('#themeToggleBtn').forEach(function (btn) {
      btn.innerHTML = '<span class="svg-icon svg-icon-' + icon + '"></span>'; btn.title = title; btn.setAttribute('aria-label', title);
    });
  }
  function reflectTheme() {
    var theme = resolvedTheme();
    applyTheme(theme);
    updateThemeButton(theme);
    renderThemeSheet();
    if (global.MemoNativeUi) global.MemoNativeUi.syncSystemBars();
  }
  // setTheme accepts 'dark' | 'light' | 'system'.
  function setTheme(mode) { store(THEME_KEY, mode === 'light' || mode === 'system' ? mode : 'dark'); reflectTheme(); }
  function setLook(kind, id) {
    if (!LOOKS[kind] || !LOOKS[kind].some(function (l) { return l[0] === id; })) return;
    store(LOOK_KEYS[kind], id);
    // Picking a look shows it: switch to its mode unless following the system.
    if (readMode() !== 'system') store(THEME_KEY, kind);
    reflectTheme();
  }
  function toggleTheme() { setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'); }
  if (systemLight) {
    var onSystemChange = function () { if (readMode() === 'system') reflectTheme(); };
    if (systemLight.addEventListener) systemLight.addEventListener('change', onSystemChange);
    else if (systemLight.addListener) systemLight.addListener(onSystemChange);
  }

  // ── Theme sheet (built on first open, so every page has it) ──
  var themeDlg = null;
  function themeSheet() {
    if (themeDlg && document.body.contains(themeDlg)) return themeDlg;
    var t = function (s) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s) : s; };
    var dlg = document.createElement('dialog');
    dlg.id = 'themeDlg';
    dlg.className = 'mobile-sheet theme-dlg';
    var modes = [['light', 'sun', 'Light'], ['dark', 'moon', 'Dark'], ['system', 'auto', 'System']];
    var swatches = function (kind) {
      return LOOKS[kind].map(function (l) {
        return '<button type="button" class="theme-swatch" data-look-kind="' + kind + '" data-look="' + l[0] + '" aria-pressed="false">' +
          '<span class="theme-swatch-preview" style="background:' + l[2] + '"><i style="background:' + l[3] + '"></i><i></i><i></i></span>' +
          '<span class="theme-swatch-name">' + t(l[1]) + '</span></button>';
      }).join('');
    };
    dlg.innerHTML =
      '<button type="button" class="sheet-drag-handle" aria-label="' + t('Close theme') + '"></button>' +
      '<div class="modal"><header><strong>' + t('Theme') + '</strong></header><div class="content">' +
      '<div class="theme-modes" role="group" aria-label="' + t('Mode') + '">' + modes.map(function (m) {
        return '<button type="button" data-theme-mode="' + m[0] + '" aria-pressed="false"><span class="svg-icon svg-icon-' + m[1] + '"></span> ' + t(m[2]) + '</button>';
      }).join('') + '</div>' +
      '<div class="theme-sub"><span>' + t('Dark look') + '</span><span data-look-now="dark"></span></div>' +
      '<div class="theme-swatches" data-kind="dark">' + swatches('dark') + '</div>' +
      '<div class="theme-sub"><span>' + t('Light look') + '</span><span data-look-now="light"></span></div>' +
      '<div class="theme-swatches" data-kind="light">' + swatches('light') + '</div>' +
      '<p class="muted theme-hint">' + t('System uses your dark look while the phone is dark and your light look while it is light.') + '</p>' +
      '</div></div>';
    dlg.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target : null;
      if (!target) return;
      var mode = target.closest('[data-theme-mode]');
      if (mode) { setTheme(mode.getAttribute('data-theme-mode')); return; }
      var look = target.closest('[data-look-kind]');
      if (look) setLook(look.getAttribute('data-look-kind'), look.getAttribute('data-look'));
    });
    document.body.appendChild(dlg);
    themeDlg = dlg;
    return dlg;
  }
  function renderThemeSheet() {
    if (!themeDlg) return;
    var mode = readMode();
    themeDlg.querySelectorAll('[data-theme-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-mode') === mode)); });
    ['dark', 'light'].forEach(function (kind) {
      var current = readLook(kind);
      themeDlg.querySelectorAll('[data-look-kind="' + kind + '"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-look') === current)); });
      var now = themeDlg.querySelector('[data-look-now="' + kind + '"]');
      var entry = LOOKS[kind].filter(function (l) { return l[0] === current; })[0];
      if (now && entry) now.textContent = global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(entry[1]) : entry[1];
    });
  }
  // A language change rebuilds the sheet in the new language on its next open.
  document.addEventListener('memo:localechange', function () {
    if (themeDlg && !themeDlg.open) { themeDlg.remove(); themeDlg = null; }
  });
  function openThemeSheet() {
    var dlg = themeSheet();
    renderThemeSheet();
    if (menuOpen()) closeMenu();
    if (!dlg.open) dlg.showModal();
  }

  function menuEl() { return document.getElementById('mobileMenu'); }
  function overlayEl() { return document.getElementById('mobileOverlay'); }
  var menuOpener = null;
  var lastMenuFocus = null;
  function prepareMenu() {
    var menu = menuEl(), overlay = overlayEl(), button = document.getElementById('hamburgerBtn');
    if (menu) {
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-modal', 'true');
      menu.setAttribute('aria-hidden', menu.classList.contains('open') ? 'false' : 'true');
      menu.inert = !menu.classList.contains('open');
      var heading = menu.querySelector('.mobile-menu-header h3');
      if (heading) {
        if (!heading.id) heading.id = 'mobileMenuTitle';
        menu.setAttribute('aria-labelledby', heading.id);
      } else menu.setAttribute('aria-label', 'Menu');
    }
    if (overlay) overlay.setAttribute('aria-hidden', overlay.classList.contains('open') ? 'false' : 'true');
    if (button) {
      button.setAttribute('aria-controls', 'mobileMenu');
      button.setAttribute('aria-expanded', menu && menu.classList.contains('open') ? 'true' : 'false');
      if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', button.title || 'Menu');
    }
  }
  function menuFocusables() {
    var menu = menuEl();
    if (!menu) return [];
    return Array.prototype.filter.call(
      menu.querySelectorAll('button, input, select, textarea, a[href], [tabindex]'),
      function (node) {
        return !node.disabled && node.tabIndex >= 0 && !node.hidden
          && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
      }
    );
  }
  function openMenu() {
    var menu = menuEl(), overlay = overlayEl(), button = document.getElementById('hamburgerBtn');
    if (!menu || menu.classList.contains('open')) return;
    menuOpener = document.activeElement && document.activeElement !== document.body ? document.activeElement : button;
    menu.inert = false;
    menu.setAttribute('aria-hidden', 'false');
    menu.classList.add('open');
    document.body.classList.add('menu-open');   // lock the page behind the menu
    if (overlay) { overlay.classList.add('open'); overlay.setAttribute('aria-hidden', 'false'); }
    if (button) button.setAttribute('aria-expanded', 'true');
    var close = document.getElementById('mobileMenuClose');
    if (close) {
      try { close.focus({ preventScroll: true }); } catch (_e) { close.focus(); }
      // Retry once after style/layout settlement for WebViews that reject focus
      // during the same discrete visibility update.
      if (document.activeElement !== close) {
        requestAnimationFrame(function () {
          if (menu.classList.contains('open') && !menu.contains(document.activeElement)) {
            try { close.focus({ preventScroll: true }); } catch (_e2) { close.focus(); }
          }
        });
      }
    }
  }
  function closeMenu() {
    var menu = menuEl(), overlay = overlayEl(), button = document.getElementById('hamburgerBtn');
    var wasOpen = !!(menu && menu.classList.contains('open'));
    if (menu) {
      menu.classList.remove('open');
      menu.setAttribute('aria-hidden', 'true');
      menu.inert = true;
    }
    document.body.classList.remove('menu-open');
    if (overlay) { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); }
    if (button) button.setAttribute('aria-expanded', 'false');
    var opener = menuOpener;
    menuOpener = null;
    lastMenuFocus = null;
    if (wasOpen && opener && opener.isConnected && !document.querySelector('dialog[open]')) {
      requestAnimationFrame(function () { try { opener.focus({ preventScroll: true }); } catch (_e) { opener.focus(); } });
    }
  }
  function menuOpen() { var m = menuEl(); return !!(m && m.classList.contains('open')); }

  function trapMenuFocus(event) {
    if (event.key !== 'Tab' || !menuOpen()) return;
    var items = menuFocusables();
    if (!items.length) { event.preventDefault(); return; }
    var first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (event.shiftKey && (active === first || items.indexOf(active) < 0)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (active === last || items.indexOf(active) < 0)) {
      event.preventDefault(); first.focus();
    }
  }

  // The variant picker is shared by Memo, Finance, and Planner. Keep the state
  // here rather than in three inline onclick handlers so it always closes on an
  // outside press, focus loss, Escape, or the Android system-back button.
  function brandMenuEl() { return document.getElementById('brandMenu'); }
  function brandButtonEl() { return document.getElementById('brandMenuButton'); }
  function brandMenuOpen() { var m = brandMenuEl(); return !!(m && m.classList.contains('show')); }
  function brandMenuItems() {
    var menu = brandMenuEl();
    return menu ? Array.prototype.filter.call(menu.querySelectorAll('[role="menuitem"]'), function (item) {
      return !item.hidden && getComputedStyle(item).display !== 'none' && getComputedStyle(item).visibility !== 'hidden';
    }) : [];
  }
  function prepareBrandMenu() {
    var menu = brandMenuEl(), button = brandButtonEl();
    if (menu) {
      menu.setAttribute('aria-hidden', brandMenuOpen() ? 'false' : 'true');
      menu.inert = !brandMenuOpen();
      brandMenuItems().forEach(function (item) { item.tabIndex = -1; });
    }
    if (button) {
      button.setAttribute('aria-controls', 'brandMenu');
      button.setAttribute('aria-expanded', brandMenuOpen() ? 'true' : 'false');
    }
  }
  function focusBrandItem(position) {
    var items = brandMenuItems();
    if (!items.length) return;
    var index = position === 'last' ? items.length - 1 : 0;
    try { items[index].focus({ preventScroll: true }); } catch (_e) { items[index].focus(); }
  }
  function setBrandMenuOpen(open, options) {
    var menu = brandMenuEl(), button = brandButtonEl();
    if (!menu) return false;
    options = options || {};
    menu.inert = false;
    menu.classList.toggle('show', !!open);
    menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (!open) menu.inert = true;
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && options.focus !== false) focusBrandItem(options.focus === 'last' ? 'last' : 'first');
    if (!open && options.restoreFocus && button) {
      try { button.focus({ preventScroll: true }); } catch (_e) { button.focus(); }
    }
    return true;
  }
  function openBrandMenu(position) { return setBrandMenuOpen(true, { focus: position === 'last' ? 'last' : 'first' }); }
  function closeBrandMenu(restoreFocus) { return setBrandMenuOpen(false, { restoreFocus: !!restoreFocus }); }
  function toggleBrandMenu() { return brandMenuOpen() ? closeBrandMenu(true) : openBrandMenu(); }

  function handleBrandMenuKey(event) {
    var items = brandMenuItems();
    var current = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeBrandMenu(true);
      return;
    }
    if (event.key === 'Tab') { closeBrandMenu(false); return; }
    var next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (current + 1 + items.length) % items.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (current - 1 + items.length) % items.length;
    else return;
    if (!items.length) return;
    event.preventDefault();
    items[next].focus();
  }

  // Keep a real opening-order stack for nested modal dialogs (for example the
  // reader above an entry dialog). A plain querySelectorAll() only reflects DOM
  // order, which is not the visual/top-layer order that Android Back must use.
  var dialogStack = [];
  function removeDialogFromStack(dlg) {
    var i = dialogStack.indexOf(dlg);
    if (i >= 0) dialogStack.splice(i, 1);
  }
  function noteDialogState(dlg) {
    if (!dlg || dlg.tagName !== 'DIALOG') return;
    removeDialogFromStack(dlg);
    if (dlg.open) dialogStack.push(dlg);
  }
  function topOpenDialog() {
    // Prefer the motion layer's modal stack: it records TRUE open order (pushed
    // synchronously from the patched showModal), so Back targets the surface
    // actually on top even when dialogs are opened over each other. The local
    // observer-based dialogStack below can lag or mis-order across a batched
    // flush — which is what let Back close a dialog behind the current one.
    if (global.MemoMotion && typeof global.MemoMotion.topModalDialog === 'function') {
      var motionTop = global.MemoMotion.topModalDialog();
      if (motionTop) return motionTop;
    }
    for (var i = dialogStack.length - 1; i >= 0; i--) {
      if (dialogStack[i] && dialogStack[i].open) return dialogStack[i];
    }
    // Covers a dialog opened immediately before the mutation observer flushes.
    var dialogs = Array.prototype.slice.call(document.querySelectorAll('dialog[open]'));
    return dialogs.length ? dialogs[dialogs.length - 1] : null;
  }

  function updateDialogStack(records) {
    (records || []).forEach(function (record) {
      if (record.type === 'attributes' && record.attributeName === 'open') noteDialogState(record.target);
      if (record.type === 'childList') {
        Array.prototype.forEach.call(record.addedNodes || [], function (node) {
          if (node && node.tagName === 'DIALOG') noteDialogState(node);
          if (node && node.querySelectorAll) node.querySelectorAll('dialog[open]').forEach(noteDialogState);
        });
      }
    });
  }

  function closeTopDialog() {
    var dlg = topOpenDialog();
    if (!dlg) return false;
    if (dlg.id === 'settingsDlg' && global.MemoBackupUI?.isRestoring()) return true;
    // These tools own timers, previews, or temporary object URLs. Let their
    // public close methods perform cleanup before falling back to dialog.close().
    if (dlg.id === 'cropDlg' && global.MemoCrop && global.MemoCrop.close) { global.MemoCrop.close(); return true; }
    if (dlg.id === 'panelDlg' && global.MemoPanel && global.MemoPanel.close) { global.MemoPanel.close(); return true; }
    if (dlg.id === 'gifDlg' && global.MemoGif && global.MemoGif.close) { global.MemoGif.close(); return true; }
    if (dlg.id === 'gifEditorDlg' && global.MemoGifEditor && global.MemoGifEditor.close) { global.MemoGifEditor.close(); return true; }
    if (dlg.id === 'batchImportReviewDlg' && global.MemoBatchImport && global.MemoBatchImport.close) { global.MemoBatchImport.close(); return true; }
    if (dlg.id === 'detailDlg' && global.MemoVariant && global.MemoVariant.closeDetail) { global.MemoVariant.closeDetail(); return true; }
    try { dlg.close(); } catch (_e) { dlg.removeAttribute('open'); }
    return true;
  }

  function closeTransientPopup() {
    if (global.MemoCtx && typeof global.MemoCtx.isOpen === 'function' && global.MemoCtx.isOpen()) {
      global.MemoCtx.hide();
      return true;
    }
    var detailPopup = document.getElementById('detailMenuPopup');
    if (detailPopup && detailPopup.classList.contains('open')) {
      detailPopup.classList.remove('open');
      return true;
    }
    return false;
  }

  // Return true when a user-visible state was dismissed. This is public on
  // purpose: it makes the priority order testable without a physical device.
  function handleSystemBack() {
    if (closeTransientPopup()) return true;
    // Reader owns its nested page menu and zoom state before its dialog closes.
    if (topOpenDialog()?.id === 'urDlg' && global.MemoReader && typeof global.MemoReader.handleBack === 'function' && global.MemoReader.handleBack()) return true;
    if (closeTopDialog()) return true;
    if (menuOpen()) { closeMenu(); return true; }
    if (brandMenuOpen()) { closeBrandMenu(); return true; }
    if (global.MemoHeaderSearch && global.MemoHeaderSearch.close()) return true;
    if (global.MemoDiscover && global.MemoDiscover.handleBack()) return true;
    if (global.MemoSelect && typeof global.MemoSelect.active === 'function' && global.MemoSelect.active()) {
      global.MemoSelect.exit();
      return true;
    }
    if (global.MemoVariant && typeof global.MemoVariant.handleBack === 'function' && global.MemoVariant.handleBack()) return true;
    return false;
  }

  var nativeBackRegistered = false;
  var dialogObserver = null;
  var menuObserver = null;
  function nativeAppPlugin() {
    var capacitor = global.Capacitor;
    return (capacitor && capacitor.Plugins && capacitor.Plugins.App) || (capacitor && capacitor.App) || null;
  }
  function isNativePlatform() {
    var capacitor = global.Capacitor;
    return !!(global.__CAP_MODE__ || (capacitor && typeof capacitor.isNativePlatform === 'function' && capacitor.isNativePlatform()));
  }
  function registerNativeBackHandler() {
    if (nativeBackRegistered) return true;
    var app = nativeAppPlugin();
    if (!app || typeof app.addListener !== 'function') return false;
    nativeBackRegistered = true;
    try {
      app.addListener('backButton', function (event) {
        if (handleSystemBack()) return;
        if (event && event.canGoBack) { global.history.back(); return; }
        // Registering a Capacitor listener replaces the default Android exit
        // behavior, so explicitly restore it only when no app state remains.
        if (isNativePlatform() && typeof app.exitApp === 'function') app.exitApp();
      });
      return true;
    } catch (_e) {
      nativeBackRegistered = false;
      return false;
    }
  }

  var toastTimer = 0;
  var scrollbarTimer = 0;
  var activeScrollTargets = [];
  function toastEl() {
    var el = document.getElementById('memoToast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'memoToast';
    el.setAttribute('popover', 'manual');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    return el;
  }
  // A single top-layer notification surface shared by memo, finance, and planner.
  // `popover` keeps it visible above open dialogs; browsers without Popover still
  // get the same fixed-position toast through the CSS fallback.
  function hideToast() {
    var el = document.getElementById('memoToast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.classList.remove('visible');
    setTimeout(function () { try { if (el.matches(':popover-open')) el.hidePopover(); } catch (_e) {} }, 180);
  }
  function toast(message, options) {
    options = options || {};
    var el = toastEl();
    var kind = options.kind || 'info';
    // Snackbar mode: a message plus one tappable action (e.g. Undo).
    var action = options.action;
    var hasAction = !!(action && action.label && typeof action.onClick === 'function');
    var ms = options.ms || (hasAction ? 6000 : 3200);
    el.className = 'memo-toast memo-toast-' + kind + (hasAction ? ' has-action' : '');
    // Errors are time-sensitive and need to interrupt assistive technology;
    // ordinary progress/success notices remain polite status updates.
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    if (hasAction) {
      el.textContent = '';
      var msg = document.createElement('span');
      msg.className = 'memo-toast-msg';
      msg.textContent = String(message || '');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'memo-toast-action';
      btn.textContent = action.label;
      var fired = false;
      btn.onclick = function () {
        if (fired) return;
        fired = true;
        hideToast();
        try { action.onClick(); } catch (_e) {}
      };
      el.append(msg, btn);
    } else {
      el.textContent = String(message || '');
    }
    clearTimeout(toastTimer);
    try { if (el.matches(':popover-open')) el.hidePopover(); } catch (_e) {}
    // An open modal dialog makes the rest of the page inert, a top-layer toast
    // too: its Undo could be seen but not tapped. Show it from inside the dialog.
    var host = null;
    try { var modals = document.querySelectorAll('dialog:modal'); host = modals.length ? modals[modals.length - 1] : null; } catch (_e) {}
    host = host || document.body;
    if (el.parentNode !== host) host.appendChild(el);
    // That dialog may be on its way out (a confirm that just answered): when
    // it closes, carry the toast out with it instead of hiding it.
    if (host !== document.body) {
      host.addEventListener('close', function rehost() {
        if (el.parentNode !== host || !el.classList.contains('visible')) return;
        var next = null;
        try { var open = document.querySelectorAll('dialog:modal'); next = open.length ? open[open.length - 1] : null; } catch (_e) {}
        (next || document.body).appendChild(el);
        try { el.showPopover(); } catch (_e3) {}
      }, { once: true });
    }
    try { el.showPopover(); } catch (_e2) { el.classList.add('visible'); }
    requestAnimationFrame(function () { el.classList.add('visible'); });
    toastTimer = setTimeout(function () {
      el.classList.remove('visible');
      setTimeout(function () { try { if (el.matches(':popover-open')) el.hidePopover(); } catch (_e) {} }, 180);
    }, ms);
  }

  // ── In-app confirm / alert / prompt (themed, promise-based) ──────────────
  // Replaces native confirm()/alert()/prompt() so destructive/confirm flows look
  // like the rest of the app and participate in the modal stack (system Back
  // closes them). One reusable <dialog>, created lazily.
  function ensureDialogUi() {
    var dlg = document.getElementById('memoConfirmDlg');
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'memoConfirmDlg';
    dlg.className = 'memo-confirm-dlg';
    dlg.innerHTML =
      '<div class="modal">' +
        '<header><strong class="memo-confirm-title"></strong></header>' +
        '<div class="content">' +
          '<p class="memo-confirm-msg"></p>' +
          '<input class="memo-confirm-input" type="text" hidden />' +
        '</div>' +
        '<div class="actions">' +
          '<span class="spacer"></span>' +
          '<button class="ghost memo-confirm-cancel" type="button">Cancel</button>' +
          '<button class="ghost memo-confirm-secondary" type="button" hidden></button>' +
          '<button class="primary memo-confirm-ok" type="button">OK</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);
    return dlg;
  }
  function openDialog(opts) {
    return new Promise(function (resolve) {
      var dlg = ensureDialogUi();
      var titleEl = dlg.querySelector('.memo-confirm-title');
      var msgEl = dlg.querySelector('.memo-confirm-msg');
      var input = dlg.querySelector('.memo-confirm-input');
      var okBtn = dlg.querySelector('.memo-confirm-ok');
      var cancelBtn = dlg.querySelector('.memo-confirm-cancel');
      var secondaryBtn = dlg.querySelector('.memo-confirm-secondary');
      var headerEl = dlg.querySelector('header');
      if (headerEl) headerEl.style.display = opts.title ? '' : 'none';
      titleEl.textContent = opts.title || '';
      msgEl.textContent = String(opts.message || '');
      okBtn.textContent = opts.okLabel || 'OK';
      okBtn.className = 'primary memo-confirm-ok' + (opts.danger ? ' danger' : '');
      cancelBtn.textContent = opts.cancelLabel || 'Cancel';
      cancelBtn.hidden = !!opts.alert;
      secondaryBtn.hidden = !opts.choice;
      secondaryBtn.textContent = opts.secondaryLabel || '';
      if (opts.prompt) { input.hidden = false; input.value = opts.defaultValue || ''; input.placeholder = opts.placeholder || ''; }
      else { input.hidden = true; input.value = ''; }
      var done = false;
      function finish(val) {
        if (done) return;
        done = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        secondaryBtn.removeEventListener('click', onSecondary);
        dlg.removeEventListener('close', onClose);
        if (input) input.removeEventListener('keydown', onKey);
        try { if (dlg.open) dlg.close(); } catch (_e) {}
        resolve(val);
      }
      function onOk() { finish(opts.choice ? opts.okValue : opts.prompt ? (input.value != null ? input.value : '') : true); }
      function onSecondary() { finish(opts.secondaryValue); }
      function onCancel() { finish(opts.choice || opts.prompt ? null : false); }
      function onClose() { finish(opts.alert ? true : (opts.choice || opts.prompt ? null : false)); }
      function onKey(e) { if (e.key === 'Enter') { e.preventDefault(); onOk(); } }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      secondaryBtn.addEventListener('click', onSecondary);
      dlg.addEventListener('close', onClose);
      if (opts.prompt && input) input.addEventListener('keydown', onKey);
      try { dlg.showModal(); } catch (_e) { finish(opts.alert ? true : (opts.choice || opts.prompt ? null : false)); return; }
      try {
        if (opts.prompt && input) { input.focus(); input.select(); }
        else okBtn.focus();
      } catch (_e) {}
    });
  }
  function confirmDialog(message, opts) { opts = opts || {}; return openDialog({ message: message, title: opts.title, okLabel: opts.okLabel, cancelLabel: opts.cancelLabel, danger: opts.danger }); }
  function alertDialog(message, opts) { opts = opts || {}; return openDialog({ message: message, title: opts.title, okLabel: opts.okLabel || 'OK', alert: true }); }
  function promptDialog(message, defaultValue, opts) { opts = opts || {}; return openDialog({ message: message, title: opts.title, prompt: true, defaultValue: defaultValue, placeholder: opts.placeholder, okLabel: opts.okLabel, cancelLabel: opts.cancelLabel }); }

  var lastMetadataPersistNotice = '';
  function handleMetadataHealth(event) {
    var health = event && event.detail;
    var error = health && health.lastPersistError;
    if (!error || error === lastMetadataPersistNotice) return;
    lastMetadataPersistNotice = error;
    toast('Recent changes could not be saved to the local database: ' + error + '. Export a backup before closing the app.', {
      kind: 'error', ms: 15000
    });
  }

  // On Android the virtual keyboard can cover controls low in a dialog. Scroll
  // the dialog body after layout has reacted, keeping the focused field in the
  // upper, visible portion instead of behind the keyboard.
  function revealFocusedDialogControl(event) {
    var control = event.target;
    if (!control || !control.matches || !control.matches('input, textarea, select, [contenteditable="true"]')) return;
    var body = control.closest && control.closest('dialog[open] .content');
    if (!body) return;
    requestAnimationFrame(function () {
      var bodyRect = body.getBoundingClientRect();
      var controlRect = control.getBoundingClientRect();
      var desiredTop = bodyRect.top + bodyRect.height * 0.24;
      body.scrollTop += controlRect.top - desiredTop;
    });
  }

  function updateDialogScrollLock() {
    var open = !!document.querySelector('dialog[open]');
    document.documentElement.classList.toggle('dialog-open', open);
    document.body.classList.toggle('dialog-open', open);
  }

  function showScrollIndicator(event) {
    var target = event && event.target;
    if (target === document) target = document.documentElement;
    if (target && target.classList) {
      target.classList.add('scrollbar-active');
      if (activeScrollTargets.indexOf(target) < 0) activeScrollTargets.push(target);
    }
    document.documentElement.classList.add('scrollbar-active');
    document.body.classList.add('scrollbar-active');
    clearTimeout(scrollbarTimer);
    scrollbarTimer = setTimeout(function () {
      activeScrollTargets.forEach(function (node) { node.classList.remove('scrollbar-active'); });
      activeScrollTargets = [];
      document.documentElement.classList.remove('scrollbar-active');
      document.body.classList.remove('scrollbar-active');
    }, 700);
  }

  // Hide developer-only affordances (Gen Summaries, Debug Log) unless the debug
  // flag is set:  localStorage.setItem('memo_debug','1'); location.reload();
  function applyDebugVisibility() {
    var on = false;
    try { on = localStorage.getItem('memo_debug') === '1' || global.MEMO_DEBUG === true; } catch (_e) {}
    document.querySelectorAll('.debug-only').forEach(function (el) { el.hidden = !on; });
  }

  function init() {
    prepareMenu();
    prepareBrandMenu();
    reflectTheme();
    watchNativeNightMode();
    // Chrome controls are wired by delegation, not direct listeners. In the
    // single-page shell the memo/finance view is detached while planner is
    // active (and vice versa), so a control captured at init would be dead on
    // the other view. Document-level handlers work for whichever view's
    // controls are currently mounted; the helpers (brandButtonEl, menuEl…)
    // resolve by id so they always target the live view.
    document.addEventListener('click', function (event) {
      var t = event.target;
      if (!t || !t.closest) return;
      if (t.closest('#themeToggleBtn')) { toggleTheme(); return; }
      if (t.closest('#mobileThemeBtn')) { openThemeSheet(); return; }
      if (t.closest('#hamburgerBtn')) { openMenu(); return; }
      if (t.closest('#mobileMenuClose')) { closeMenu(); return; }
      if (t.closest('#mobileOverlay')) { closeMenu(); return; }
      if (t.closest('#brandMenuButton')) { event.preventDefault(); toggleBrandMenu(); return; }
      if (t.closest('#brandMenu a[href]')) { closeBrandMenu(); return; }
    });
    // Listen at the document boundary so the drawer still contains the next Tab
    // if asynchronous rendering removes the currently focused menu control.
    document.addEventListener('keydown', trapMenuFocus, true);
    document.addEventListener('keydown', function (event) {
      var menu = brandMenuEl();
      if (menu && menu.contains && menu.contains(event.target)) handleBrandMenuKey(event);
    });
    document.addEventListener('pointerdown', function (event) {
      if (!brandMenuOpen()) return;
      var bb = brandButtonEl();
      var root = bb && bb.closest ? bb.closest('.brand-dropdown') : null;
      if (!root || !root.contains(event.target)) closeBrandMenu();
    }, true);
    document.addEventListener('focusin', function (event) {
      if (!brandMenuOpen()) return;
      var bb = brandButtonEl();
      var root = bb && bb.closest ? bb.closest('.brand-dropdown') : null;
      if (!root || !root.contains(event.target)) closeBrandMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      closeMenu();
      closeBrandMenu(true);
    });
    var observedMenu = menuEl();
    if (observedMenu) {
      observedMenu.addEventListener('focusin', function (event) {
        lastMenuFocus = event.target;
      });
      menuObserver = new MutationObserver(function (records) {
        if (!menuOpen() || observedMenu.contains(document.activeElement)) return;
        // Only repair focus when this mutation actually removed the focused
        // drawer control. An unrelated late render must not pre-consume the
        // first Tab after an integration has moved focus outside the modal.
        var removedFocusedControl = !!lastMenuFocus && records.some(function (record) {
          return Array.prototype.some.call(record.removedNodes || [], function (node) {
            return node === lastMenuFocus || (node.contains && node.contains(lastMenuFocus));
          });
        });
        if (!removedFocusedControl) return;
        var close = document.getElementById('mobileMenuClose');
        if (close) {
          try { close.focus({ preventScroll: true }); } catch (_e) { close.focus(); }
        }
      });
      menuObserver.observe(observedMenu, { childList: true, subtree: true });
    }
    document.addEventListener('focusin', revealFocusedDialogControl);
    document.addEventListener('scroll', showScrollIndicator, true);
    document.querySelectorAll('dialog[open]').forEach(noteDialogState);
    dialogObserver = new MutationObserver(function (records) {
      updateDialogStack(records);
      updateDialogScrollLock();
    });
    dialogObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    updateDialogScrollLock();
    registerNativeBackHandler();
    // memo-capacitor.js is deferred from the document head. Retrying after this
    // task keeps the listener reliable whether it loaded before or after shell.
    setTimeout(registerNativeBackHandler, 0);
    global.addEventListener('load', registerNativeBackHandler, { once: true });
    // Keep theme in sync across tabs/variants (don't re-write storage → no loop).
    global.addEventListener('storage', function (e) { if (e.key === THEME_KEY || e.key === LOOK_KEYS.dark || e.key === LOOK_KEYS.light) reflectTheme(); });
    global.addEventListener('memo:metadata-health', handleMetadataHealth);
    global.addEventListener('pagehide', function (event) {
      if (global.MemoLifecycle?.retain(event) || event.persisted) return;
      if (dialogObserver) { dialogObserver.disconnect(); dialogObserver = null; }
      if (menuObserver) { menuObserver.disconnect(); menuObserver = null; }
    });
    applyDebugVisibility();
  }
  // The menu exists before this bottom-of-document script. Establish its hidden
  // semantic state immediately so assistive technology never sees an off-screen
  // but focusable drawer during the DOMContentLoaded gap.
  prepareMenu();
  // This script is intentionally loaded after the shared chrome markup on all
  // three pages, so wire it now. Exposing MemoShell only after handlers exist
  // prevents fast pages (notably Planner) from accepting a dead first tap.
  init();

  global.MemoShell = {
    toggleTheme: toggleTheme, setTheme: setTheme, applyTheme: applyTheme, setLook: setLook, openThemeSheet: openThemeSheet,
    theme: function () { return { mode: readMode(), shown: resolvedTheme(), dark: readLook('dark'), light: readLook('light') }; }, LOOKS: LOOKS,
    openMenu: openMenu, closeMenu: closeMenu, menuOpen: menuOpen,
    openBrandMenu: openBrandMenu, closeBrandMenu: closeBrandMenu, toggleBrandMenu: toggleBrandMenu, brandMenuOpen: brandMenuOpen,
    handleSystemBack: handleSystemBack, registerNativeBackHandler: registerNativeBackHandler,
    applyDebugVisibility: applyDebugVisibility, toast: toast, hideToast: hideToast,
    confirm: confirmDialog, alert: alertDialog, prompt: promptDialog,
    choose: (message, options) => openDialog({ ...options, message, choice: true })
  };
})(window);
