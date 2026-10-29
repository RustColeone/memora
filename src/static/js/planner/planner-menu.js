// planner-menu.js — Settings (sync server) for the planner page.
// Hamburger open/close, theme and .debug-only visibility are wired by the shared
// memo-shell.js; Debug Log by memo-debug.js; Chat by memo-chats.js (the Assistant).
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function closeMenu() { if (window.MemoShell) window.MemoShell.closeMenu(); }

  // The planner menu is action-only (Chat/Settings/Debug), so a click on any of
  // its buttons closes the menu (no in-menu controls to leave open).
  var menu = $('mobileMenu');
  if (menu) {
    menu.querySelectorAll('button').forEach(function (b) {
      if (b.id !== 'mobileMenuClose') b.addEventListener('click', closeMenu);
    });
  }

  // ---- Settings (sync server URL — the part that applies to the planner) ----
  var dlg = $('settingsDlg');
  function syncEnabled() {
    return !!(window.Planner && window.Planner.Store && window.Planner.Store._syncEnabled);
  }
  function openSettings() {
    if (!dlg) return;
    var input = $('serverUrlInput');
    if (input) input.value = localStorage.getItem('memo_server_url') || '';
    if (window.MemoTransportSecurity) {
      window.MemoTransportSecurity.reflect(input, $('serverTransportWarning'));
    }
    var pwInput = $('syncPasswordInput');
    if (pwInput && window.MemoAuth) pwInput.value = window.MemoAuth.getPassword();
    var st = $('serverUrlStatus');
    if (st) st.textContent = syncEnabled() ? '● Connected to a sync server.' : '○ Offline (no server).';
    dlg.showModal();
  }
  var settingsBtn = $('mobileSettingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  var settingsClose = $('settingsCloseBtn');
  if (settingsClose) settingsClose.addEventListener('click', function () { dlg.close(); });

  if (window.MemoTransportSecurity) {
    window.MemoTransportSecurity.bind($('serverUrlInput'), $('serverTransportWarning'));
  }

  var saveBtn = $('saveServerUrlBtn');
  if (saveBtn) saveBtn.addEventListener('click', function () {
    var input = $('serverUrlInput');
    var st = $('serverUrlStatus');
    var url = ((input && input.value) || '').trim();
    if (url) {
      var parsed;
      try {
        parsed = new URL(url);
        if (['http:', 'https:'].indexOf(parsed.protocol) < 0) throw new Error('bad protocol');
      } catch (e) { if (st) st.innerHTML = '<span class="svg-icon svg-icon-x"></span> Invalid URL. Use http://host:port or https://host'; return; }
      if (window.MemoTransportSecurity && !window.MemoTransportSecurity.confirmHttp(parsed.href)) {
        if (st) st.textContent = 'HTTP server not saved. Use HTTPS, or confirm the risk to continue.';
        return;
      }
      localStorage.setItem('memo_server_url', url);
    } else {
      localStorage.removeItem('memo_server_url');
    }
    // Persist the optional sync password alongside the URL.
    var pwInput = $('syncPasswordInput');
    if (pwInput && window.MemoAuth) window.MemoAuth.setPassword((pwInput.value || '').trim());
    if (window.MemoContracts && window.MemoContracts.setApiBase) window.MemoContracts.setApiBase(url);
    if (st) st.textContent = url ? 'Saved — reconnecting…' : 'Saved — offline.';
    // Reload so the planner's detectServer() re-runs against the new URL.
    setTimeout(function () { location.reload(); }, 400);
  });
})();
