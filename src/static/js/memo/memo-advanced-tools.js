// memo-advanced-tools.js — side-menu entry point for standalone media tools.
//
// The Panel Images and GIF Editor implementations are shared with entry details;
// this module only supplies a safe file-picker workflow for starting either tool
// without first creating an entry.
(function (global) {
  'use strict';

  var panelObjectUrls = [];

  function el(id) { return document.getElementById(id); }
  function dialog() { return el('advancedToolsDlg'); }
  function status(message, bad) {
    var node = el('advancedToolsStatus');
    if (!node) return;
    node.textContent = message || '';
    node.style.color = bad ? 'var(--danger)' : '';
  }
  function toast(message, options) {
    if (global.MemoShell && typeof global.MemoShell.toast === 'function') global.MemoShell.toast(message, options);
  }
  function closeMenu() {
    if (global.MemoShell && typeof global.MemoShell.closeMenu === 'function') global.MemoShell.closeMenu();
  }
  function resetInput(input) { if (input) input.value = ''; }
  function isImageFile(file) {
    return !!(file && ((file.type && file.type.indexOf('image/') === 0) || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name || '')));
  }
  function isGifFile(file) {
    return !!(file && ((file.type || '').toLowerCase() === 'image/gif' || /\.gif$/i.test(file.name || '')));
  }
  function releasePanelUrls() {
    panelObjectUrls.forEach(function (url) { try { URL.revokeObjectURL(url); } catch (_e) {} });
    panelObjectUrls = [];
  }
  function open() {
    var d = dialog();
    if (!d) return false;
    status('');
    var exif = el('advancedExifBtn');
    if (exif) exif.hidden = global.MEMO_VARIANT === 'planner' || !(global.MemoCore && global.MemoExifEditor);
    var organize = el('advancedOrganizeSection');
    if (organize) organize.hidden = global.MEMO_VARIANT === 'planner' || !global.MemoInsights;
    var cleanup = el('advancedCleanupBtn');
    if (cleanup) cleanup.hidden = !(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform());
    var scan = el('advancedScanBtn');
    if (scan) scan.hidden = global.MEMO_VARIANT === 'planner' || !global.MemoTools || !global.MemoTools.scanNewDocuments
      || !(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform());
    if (!d.open) {
      try { d.showModal(); } catch (_e) { d.setAttribute('open', ''); }
    }
    return true;
  }
  function close() {
    var d = dialog();
    if (!d || !d.open) return;
    try { d.close(); } catch (_e) { d.removeAttribute('open'); }
  }
  function requestPanelFiles() {
    var input = el('advancedPanelInput');
    if (!input) return;
    status('');
    resetInput(input);
    input.click();
  }
  function requestGifFile() {
    var input = el('advancedGifInput');
    if (!input) return;
    status('');
    resetInput(input);
    input.click();
  }
  function openPanelTool() {
    if (!global.MemoPanel || typeof global.MemoPanel.open !== 'function') {
      status('Panel Images is unavailable right now.', true);
      return;
    }
    close();
    global.MemoPanel.open([]);
  }
  function openGifTool() {
    if (!global.MemoGifEditor || typeof global.MemoGifEditor.open !== 'function') {
      status('GIF Editor is unavailable right now.', true);
      return;
    }
    close();
    Promise.resolve(global.MemoGifEditor.open()).catch(function (error) {
      open(); status('Could not open GIF Editor: ' + ((error && error.message) || error), true);
    });
  }
  function openExifTool() {
    if (!global.MemoExifEditor || typeof global.MemoExifEditor.pickFromLibrary !== 'function') {
      status('EXIF Editor is unavailable right now.', true);
      return;
    }
    close();
    global.MemoExifEditor.pickFromLibrary();
  }
  function launchPanel(files) {
    var chosen = Array.prototype.slice.call(files || []).filter(isImageFile);
    if (chosen.length < 2) {
      status('Choose at least two image files to combine.', true);
      return;
    }
    if (!global.MemoPanel || typeof global.MemoPanel.open !== 'function') {
      status('Panel Images is unavailable right now.', true);
      return;
    }
    releasePanelUrls();
    panelObjectUrls = chosen.map(function (file) { return URL.createObjectURL(file); });
    close();
    try {
      global.MemoPanel.open(panelObjectUrls);
    } catch (error) {
      releasePanelUrls();
      open();
      status('Could not open Panel Images: ' + ((error && error.message) || error), true);
    }
  }
  async function launchGifEditor(files) {
    var file = Array.prototype.slice.call(files || []).find(isGifFile);
    if (!file) {
      status('Choose an animated GIF file to edit.', true);
      return;
    }
    if (!global.MemoGifEditor || typeof global.MemoGifEditor.open !== 'function') {
      status('GIF Editor is unavailable right now.', true);
      return;
    }
    close();
    try {
      await global.MemoGifEditor.open(file, file.name);
    } catch (error) {
      open();
      status('Could not open GIF: ' + ((error && error.message) || error), true);
    }
  }
  // Pick from the existing library instead of the device. The tools' open()
  // functions accept URLs, and MemoLibraryPicker resolves each pick to a loadable
  // URL — so entry images/GIFs feed the tools with no download round-trip.
  function launchPanelFromLibrary() {
    if (!global.MemoLibraryPicker) { status('Library picker is unavailable.', true); return; }
    global.MemoLibraryPicker.open({ mode: 'multi', filter: 'image', min: 2, onDone: function (urls) {
      if (!urls || urls.length < 2) return;
      if (!global.MemoPanel || typeof global.MemoPanel.open !== 'function') { open(); status('Panel Images is unavailable right now.', true); return; }
      close();
      try { global.MemoPanel.open(urls); } catch (error) { open(); status('Could not open Panel Images: ' + ((error && error.message) || error), true); }
    } });
  }
  function launchGifFromLibrary() {
    if (!global.MemoLibraryPicker) { status('Library picker is unavailable.', true); return; }
    global.MemoLibraryPicker.open({ mode: 'single', filter: 'gif', onDone: async function (url) {
      if (!url) return;
      if (!global.MemoGifEditor || typeof global.MemoGifEditor.open !== 'function') { open(); status('GIF Editor is unavailable right now.', true); return; }
      close();
      try { await global.MemoGifEditor.open(url); } catch (error) { open(); status('Could not open GIF: ' + ((error && error.message) || error), true); }
    } });
  }
  function wire() {
    // The Planner menu mounts lazily, while the tool dialogs persist across views.
    document.addEventListener('click', function (event) {
      if (event.target.closest('#mobileAdvancedToolsBtn')) { closeMenu(); open(); }
    });
    var panelBtn = el('advancedPanelBtn');
    if (panelBtn) panelBtn.addEventListener('click', openPanelTool);
    var gifBtn = el('advancedGifEditorBtn');
    if (gifBtn) gifBtn.addEventListener('click', openGifTool);
    var exifBtn = el('advancedExifBtn');
    if (exifBtn) {
      exifBtn.hidden = !(global.MemoCore && global.MemoExifEditor);
      exifBtn.addEventListener('click', openExifTool);
    }
    var scanBtn = el('advancedScanBtn');
    if (scanBtn) scanBtn.addEventListener('click', function () { close(); if (global.MemoTools && global.MemoTools.scanNewDocuments) void global.MemoTools.scanNewDocuments(); });
    var panelLibBtn = el('advancedPanelLibBtn');
    if (panelLibBtn) panelLibBtn.addEventListener('click', launchPanelFromLibrary);
    var gifLibBtn = el('advancedGifLibBtn');
    if (gifLibBtn) gifLibBtn.addEventListener('click', launchGifFromLibrary);
    var panelInput = el('advancedPanelInput');
    if (panelInput) panelInput.addEventListener('change', function () { launchPanel(panelInput.files); });
    var gifInput = el('advancedGifInput');
    if (gifInput) gifInput.addEventListener('change', function () { launchGifEditor(gifInput.files); });
    // These URLs belong only to the standalone-picker flow. Existing entry URLs
    // passed to MemoPanel are never tracked or revoked here.
    var panelDialog = el('panelDlg');
    if (panelDialog) panelDialog.addEventListener('close', releasePanelUrls);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
  global.addEventListener('pagehide', function (event) {
    if (window.MemoLifecycle?.retain(event) || (event && event.persisted)) return;
    releasePanelUrls();
  });

  global.MemoAdvancedTools = {
    open: open,
    close: close,
    launchPanel: launchPanel,
    launchGifEditor: launchGifEditor,
    openPanelTool: openPanelTool,
    openGifTool: openGifTool,
    openExifTool: openExifTool,
    __panelUrlCount: function () { return panelObjectUrls.length; }
  };
})(window);
