// memo-share.js — receive files shared into the native Android shell.
//
// The native ShareReceiver plugin keeps incoming ACTION_SEND / ACTION_SEND_MULTIPLE
// content until this module consumes it. Shared files open a new Memo draft (or
// append to an already-open draft, never discarding unsaved work).
(function (global) {
  'use strict';

  var consuming = false;
  var retryTimer = 0;

  function plugin() {
    return global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.ShareReceiver;
  }

  function extensionFor(mime) {
    return {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
      'image/webp': 'webp', 'image/avif': 'avif', 'application/pdf': 'pdf'
    }[String(mime || '').toLowerCase()] || 'bin';
  }

  function fileFromBase64(item, index) {
    var value = String((item && item.base64) || '');
    var match = value.match(/^data:([^;,]+)?;base64,(.*)$/i);
    var mime = String((item && item.mime) || (match && match[1]) || 'application/octet-stream').toLowerCase();
    var bytes = atob(match ? match[2] : value);
    var data = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) data[i] = bytes.charCodeAt(i);
    var name = String((item && item.name) || '').trim() || ('shared_' + (index + 1) + '.' + extensionFor(mime));
    return new File([data], name, { type: mime });
  }

  async function fileFromSharedItem(item, index) {
    if (!item || !item.filePath) return fileFromBase64(item, index);
    var capacitor = global.Capacitor;
    if (!capacitor || typeof capacitor.convertFileSrc !== 'function') {
      throw new Error('Native shared-file conversion is unavailable.');
    }
    var mime = String(item.mime || 'application/octet-stream').toLowerCase();
    var response = await fetch(capacitor.convertFileSrc(String(item.filePath)));
    if (!response.ok) throw new Error('Could not read the staged shared file.');
    var blob = await response.blob();
    var name = String(item.name || '').trim() || ('shared_' + (index + 1) + '.' + extensionFor(mime));
    return new File([blob], name, { type: mime || blob.type });
  }

  function showToast(message, kind) {
    if (global.MemoShell && typeof global.MemoShell.toast === 'function') {
      global.MemoShell.toast(message, { kind: kind || 'info' });
    }
  }

  function appendText(text) {
    var description = document.getElementById('desc');
    var value = String(text || '').trim();
    if (!description || !value) return;
    description.value = description.value.trim() ? description.value.trim() + '\n\n' + value : value;
  }

  function waitForMemoDraft(attempt) {
    if (typeof global.openEntryModal === 'function' && typeof global.addImageFiles === 'function') return true;
    if (attempt >= 20) return false;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { consumePendingShare(attempt + 1); }, 150);
    return false;
  }

  async function consumePendingShare(attempt) {
    var receiver = plugin();
    if (!receiver || typeof receiver.consumePendingShare !== 'function' || consuming) return false;
    if (!waitForMemoDraft(attempt || 0)) return false;

    consuming = true;
    try {
      var payload = await receiver.consumePendingShare();
      var items = Array.isArray(payload && payload.files) ? payload.files : [];
      var files = [];
      for (var index = 0; index < items.length; index++) {
        try {
          var file = await fileFromSharedItem(items[index], index);
          if (/^(image\/|application\/pdf$)/i.test(file.type)) files.push(file);
        } catch (err) {
          console.warn('[MemoShare] Ignored an unreadable shared file:', err);
        }
      }
      var text = String((payload && payload.text) || '').trim();
      if (!files.length && !text) return false;

      var dialog = document.getElementById('entryDlg');
      // A new share never destroys an in-progress edit. When an entry dialog is
      // already open, append the content to that draft instead.
      if (!dialog || !dialog.open) global.openEntryModal(null);
      appendText(text);
      if (files.length) global.addImageFiles(files);

      var noun = files.length === 1 ? 'file' : 'files';
      showToast(files.length ? ('Added shared ' + noun + ' to the draft.') : 'Added shared text to the draft.', 'success');
      return true;
    } catch (err) {
      console.error('[MemoShare] Could not receive shared content:', err);
      showToast('Could not open the shared content: ' + (err && err.message || err), 'error');
      return false;
    } finally {
      try {
        if (payload && payload.token && typeof receiver.releasePendingShare === 'function') {
          await receiver.releasePendingShare({ token: payload.token });
        }
      } catch (releaseError) {
        console.warn('[MemoShare] Could not clean the native share staging files:', releaseError);
      }
      consuming = false;
    }
  }

  function routeShareToMemo(isIncomingShare) {
    // The native launcher always opens index.html, but a warm share can arrive
    // while Finance or Planner is visible. Keep the pending native payload and
    // navigate to the memo entry flow, where it will be consumed.
    var variant = String(global.MEMO_VARIANT || 'default').toLowerCase();
    if (variant !== 'default' || !(location.pathname === '/' || /index\.html(?:$|[?#])/i.test(location.pathname))) {
      if (isIncomingShare) location.href = 'index.html';
      return;
    }
    if (typeof global.openEntryModal === 'function') consumePendingShare(0);
  }

  function init() {
    // On the Memo page this safely consumes a pending cold-start share. Other
    // variants must remain where the user opened them unless a new warm-share
    // event arrives.
    routeShareToMemo(false);
    global.addEventListener('memoShareReceived', function () { routeShareToMemo(true); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.MemoShare = { consumePendingShare: consumePendingShare };
})(window);
