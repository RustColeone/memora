// memo-vault-ui.js — the Vault screen (memo-vault.js holds the data and keys).
// Built on first open so every page has it. States: set up · locked ·
// unlocked (notes with a copy button per "NAME: value" line, AI keys,
// settings) · note editor · AI key editor. Screenshots and the recent-apps
// preview are blocked while it is open.
(function (global) {
  'use strict';

  var V = function () { return global.MemoVault; };
  var dlg = null;
  var view = { mode: 'auto', expanded: null, revealed: {}, editing: null, error: '', busy: false };
  var SECRET_LABEL = /pass|pwd|pin|code|secret|key|token|cvv|cvc/i;

  function t(s, v) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s, v) : String(s).replace(/\{(\w+)\}/g, function (_m, k) { return v && v[k] != null ? v[k] : ''; }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function icon(name) { return '<span class="svg-icon svg-icon-' + name + '"></span>'; }
  function toast(message, kind) { if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast(message, { kind: kind || 'info' }); }
  function privacy() { var C = global.Capacitor; return C && C.Plugins && C.Plugins.Privacy; }
  function secure(on) {
    var p = privacy();
    if (!p || !p.setSecureScreen) return;
    var keep = !!(global.MemoPrivacy && global.MemoPrivacy.isSafeView && global.MemoPrivacy.isSafeView());
    p.setSecureScreen({ enabled: !!on || keep }).catch(function () {});
  }

  function ensureDialog() {
    if (dlg && document.body.contains(dlg)) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'vaultDlg';
    dlg.className = 'mobile-sheet vault-dlg';
    dlg.innerHTML = '<button type="button" class="sheet-drag-handle" aria-label="' + esc(t('Close the Vault')) + '"></button>' +
      '<div class="modal"><header><strong class="vault-title">' + icon('lock') + ' ' + esc(t('Vault')) + '</strong>' +
      '<span class="spacer"></span><span class="vault-head-actions"></span>' +
      '<button type="button" class="ghost vault-close" aria-label="' + esc(t('Close')) + '">' + icon('x') + '</button></header>' +
      '<div class="content vault-body"></div></div>';
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', function () { secure(false); view.revealed = {}; view.expanded = null; view.editing = null; });
    document.body.appendChild(dlg);
    return dlg;
  }

  // ── rendering ──
  async function render() {
    if (!dlg || !dlg.open) return;
    var vault = V();
    var body = dlg.querySelector('.vault-body');
    var head = dlg.querySelector('.vault-head-actions');
    head.innerHTML = '';
    if (!vault.exists()) { body.innerHTML = setupHtml(); focusFirst(); return; }
    if (!vault.isUnlocked()) { body.innerHTML = await lockedHtml(); focusFirst(); return; }
    if (view.editing) {
      body.innerHTML = view.editing.type === 'ai-key' ? aiEditorHtml(view.editing)
        : view.editing.type === 'password' ? passwordHtml() : noteEditorHtml(view.editing);
      focusFirst(); return;
    }
    head.innerHTML = '<button type="button" class="ghost" data-act="add-note" aria-label="' + esc(t('New note')) + '">' + icon('plus') + '</button>' +
      '<button type="button" class="ghost" data-act="lock" aria-label="' + esc(t('Lock now')) + '">' + icon('lock') + '</button>';
    var data = await vault.list();
    body.innerHTML = await unlockedHtml(data);
  }
  function focusFirst() {
    var el = dlg.querySelector('.vault-body input:not([type=checkbox]), .vault-body textarea');
    if (el && !matchMedia('(hover: none)').matches) setTimeout(function () { el.focus(); }, 60);
  }
  function errorHtml() { return view.error ? '<p class="vault-error" role="alert">' + esc(view.error) + '</p>' : ''; }

  function setupHtml() {
    return '<form class="vault-form" data-form="setup">' +
      '<p>' + esc(t('Keep Wi-Fi passwords, codes and AI keys here. Everything is encrypted on this device before it is saved or synced.')) + '</p>' +
      '<label class="field"><span>' + esc(t('Vault password')) + '</span><input type="password" name="password" autocomplete="new-password" minlength="' + V().MIN_PASSWORD + '" required></label>' +
      '<label class="field"><span>' + esc(t('Type it again')) + '</span><input type="password" name="confirm" autocomplete="new-password" required></label>' +
      '<p class="vault-warn">' + icon('warning') + ' ' + esc(t('If you forget this password, nobody can open the Vault — not even with a backup.')) + '</p>' +
      errorHtml() +
      '<div class="actions"><span class="spacer"></span><button class="primary" type="submit"' + (view.busy ? ' disabled' : '') + '>' + esc(t('Create Vault')) + '</button></div>' +
      '</form>';
  }
  async function lockedHtml() {
    var bio = await V().bioStatus();
    return '<form class="vault-form vault-locked" data-form="unlock">' +
      '<div class="vault-lock-mark">' + icon('lock') + '</div>' +
      '<p class="vault-center">' + esc(t('The Vault is locked.')) + '</p>' +
      (bio.enabled ? '<button type="button" class="vault-bio-btn" data-act="bio">' + icon('fingerprint') + ' ' + esc(t('Use fingerprint')) + '</button>' : '') +
      '<label class="field"><span>' + esc(t('Vault password')) + '</span><input type="password" name="password" autocomplete="current-password" required></label>' +
      errorHtml() +
      '<div class="actions"><button type="button" class="ghost" data-act="forgot">' + esc(t('Forgot password?')) + '</button><span class="spacer"></span>' +
      '<button class="primary" type="submit"' + (view.busy ? ' disabled' : '') + '>' + esc(t('Unlock')) + '</button></div>' +
      '</form>';
  }
  async function unlockedHtml(data) {
    var notes = data.items.filter(function (i) { return i.type === 'note'; });
    var keys = data.items.filter(function (i) { return i.type === 'ai-key'; });
    keys.sort(function (a, b) { return (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0); });
    var bio = await V().bioStatus();
    var html = '<p class="vault-status">' + icon(bio.enabled ? 'fingerprint' : 'lock-open') + ' ' +
      esc(t('Unlocked · locks {n} min after you leave', { n: Math.round(V().RELOCK_MS / 60000) })) + '</p>';
    if (data.unreadable) html += '<p class="vault-warn">' + icon('warning') + ' ' + esc(t('{n} item(s) were made with a different Vault password set up on another device and cannot be opened here.', { n: data.unreadable })) + '</p>';
    html += '<div class="vault-notes">';
    if (!notes.length) html += '<button type="button" class="vault-empty" data-act="add-note">' + icon('plus') + ' ' + esc(t('Add your first note, e.g. Home Wi-Fi')) + '</button>';
    notes.forEach(function (note) { html += noteCardHtml(note); });
    html += '</div>';
    html += '<div class="vault-section-label">' + esc(t('AI keys')) + '</div>' +
      '<p class="muted vault-hint vault-byok">' + esc(t('Bring your own key. Memora has no AI of its own; your key goes only to the provider you pick.')) + '</p><div class="vault-keys">';
    keys.forEach(function (k) {
      var p = V().PROVIDERS[k.provider] || V().PROVIDERS.custom;
      html += '<button type="button" class="vault-key-row" data-act="edit-key" data-id="' + esc(k.id) + '">' + icon('key') +
        '<span class="vault-key-text"><span class="vault-key-name">' + esc(k.label || p.label) + '</span>' +
        '<span class="vault-key-sub">' + (k.isDefault ? '<b>' + esc(t('Default')) + '</b> · ' : '') + esc((window.MemoAiKey ? window.MemoAiKey.supportsVision(k.provider, k.model) : p.vision) ? t('reads photos') : t('chat only')) +
        (k.model ? ' · ' + esc(k.model) : '') + '</span></span>' + icon('chevron-right') + '</button>';
    });
    html += '<button type="button" class="vault-key-row vault-key-add" data-act="add-key">' + icon('plus') +
      '<span class="vault-key-text"><span class="vault-key-name">' + esc(t('Add AI key')) + '</span><span class="vault-key-sub">' +
      esc('DeepSeek · Gemini · OpenAI · Claude · ' + t('Custom')) + '</span></span></button></div>';
    html += '<div class="vault-section-label">' + esc(t('Vault settings')) + '</div><div class="vault-settings">';
    if (bio.supported) {
      html += '<label class="vault-setting"><span>' + icon('fingerprint') + ' ' + esc(t('Unlock with fingerprint')) +
        (bio.available ? '' : '<small>' + esc(t('Set up a fingerprint or screen lock first')) + '</small>') + '</span>' +
        '<input type="checkbox" data-act="bio-toggle"' + (bio.enabled ? ' checked' : '') + (bio.available || bio.enabled ? '' : ' disabled') + '></label>';
    }
    html += '<button type="button" class="vault-setting-btn" data-act="change-password">' + icon('key') + ' ' + esc(t('Change Vault password')) + '</button></div>';
    return html;
  }
  function noteCardHtml(note) {
    var open = view.expanded === note.id;
    var html = '<article class="vault-card' + (open ? ' open' : '') + '" data-id="' + esc(note.id) + '">' +
      '<button type="button" class="vault-card-head" data-act="toggle" data-id="' + esc(note.id) + '" aria-expanded="' + open + '">' +
      '<span class="vault-card-title">' + esc(note.title || t('Untitled')) + '</span>' + icon(open ? 'chevron-down' : 'chevron-right') + '</button>';
    if (open) {
      var reveal = !!view.revealed[note.id];
      var lines = V().parseLines(note.content);
      html += '<div class="vault-lines">';
      if (!lines.length) html += '<p class="muted">' + esc(t('No content.')) + '</p>';
      lines.forEach(function (l, i) {
        var hidden = !reveal && l.label && SECRET_LABEL.test(l.label);
        html += '<div class="vault-line">' + (l.label ? '<span class="vault-k">' + esc(l.label) + '</span>' : '') +
          '<span class="vault-v">' + (hidden ? '••••••••' : esc(l.value)) + '</span>' +
          '<button type="button" class="vault-copy" data-act="copy" data-id="' + esc(note.id) + '" data-line="' + i + '">' + icon('copy') + ' ' + esc(t('Copy')) + '</button></div>';
      });
      html += '</div><div class="vault-card-actions">' +
        '<button type="button" class="ghost" data-act="reveal" data-id="' + esc(note.id) + '">' + icon(reveal ? 'eye-off' : 'eye') + ' ' + esc(reveal ? t('Hide') : t('Show')) + '</button>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="ghost" data-act="edit-note" data-id="' + esc(note.id) + '">' + icon('edit') + ' ' + esc(t('Edit')) + '</button>' +
        '<button type="button" class="ghost danger-text" data-act="delete" data-id="' + esc(note.id) + '">' + icon('trash') + ' ' + esc(t('Delete')) + '</button></div>';
    }
    return html + '</article>';
  }
  function passwordHtml() {
    return '<form class="vault-form" data-form="password">' +
      '<label class="field"><span>' + esc(t('New Vault password')) + '</span><input type="password" name="password" autocomplete="new-password" minlength="' + V().MIN_PASSWORD + '" required></label>' +
      '<label class="field"><span>' + esc(t('Type it again')) + '</span><input type="password" name="confirm" autocomplete="new-password" required></label>' +
      '<p class="muted vault-hint">' + esc(t('Other devices ask for the new password the next time they unlock.')) + '</p>' +
      errorHtml() +
      '<div class="actions"><button type="button" class="ghost" data-act="cancel-edit">' + esc(t('Cancel')) + '</button><span class="spacer"></span>' +
      '<button class="primary" type="submit">' + esc(t('Change password')) + '</button></div></form>';
  }
  function noteEditorHtml(item) {
    return '<form class="vault-form" data-form="note">' +
      '<label class="field"><span>' + esc(t('Note')) + '</span><input type="text" name="title" maxlength="200" value="' + esc(item.title || '') + '" placeholder="' + esc(t('Home Wi-Fi')) + '" required></label>' +
      '<label class="field"><span>' + esc(t('Content')) + '</span><textarea name="content" rows="7" spellcheck="false" autocomplete="off" placeholder="SSID: Maple-Home-5G&#10;PASS: …">' + esc(item.content || '') + '</textarea></label>' +
      '<p class="muted vault-hint">' + esc(t('Write one thing per line as NAME: value — each line gets its own copy button.')) + '</p>' +
      errorHtml() +
      '<div class="actions"><button type="button" class="ghost" data-act="cancel-edit">' + esc(t('Cancel')) + '</button><span class="spacer"></span>' +
      '<button class="primary" type="submit">' + esc(t('Save')) + '</button></div></form>';
  }
  function aiEditorHtml(item) {
    var P = V().PROVIDERS, provider = item.provider || 'deepseek';
    var info = P[provider] || P.custom;
    var options = Object.keys(P).map(function (k) {
      return '<option value="' + k + '"' + (k === provider ? ' selected' : '') + '>' + esc(P[k].label + (P[k].note ? ' — ' + t(P[k].note) : '')) + '</option>';
    }).join('');
    return '<form class="vault-form" data-form="ai-key">' +
      '<label class="field"><span>' + esc(t('Provider')) + '</span><select name="provider" data-act="provider">' + options + '</select></label>' +
      '<p class="muted vault-hint">' + esc(info.vision ? t('Reads photos and chats.') : t('Chats only — photo analysis needs DeepSeek Flash, Gemini, OpenAI or Claude.')) + '</p>' +
      '<label class="field"><span>' + esc(t('API key')) + '</span><input type="password" name="apiKey" autocomplete="off" spellcheck="false" value="' + esc(item.apiKey || '') + '" required></label>' +
      (provider === 'custom' ? '<label class="field"><span>' + esc(t('Address (OpenAI-compatible)')) + '</span><input name="baseUrl" type="url" inputmode="url" value="' + esc(item.baseUrl || '') + '" placeholder="https://openrouter.ai/api/v1" required></label>' : '') +
      '<label class="field"><span>' + esc(t('Model')) + '</span><input type="text" name="model" spellcheck="false" value="' + esc(item.model || '') + '" placeholder="' + esc(info.model || t('model name')) + '"' + (provider === 'custom' ? ' required' : '') + '></label>' +
      '<label class="field"><span>' + esc(t('Name (optional)')) + '</span><input type="text" name="label" maxlength="80" value="' + esc(item.label || '') + '" placeholder="' + esc(info.label) + '"></label>' +
      '<label class="vault-setting"><span>' + esc(t('Use by default')) + '</span><input type="checkbox" name="isDefault"' + (item.isDefault ? ' checked' : '') + '></label>' +
      errorHtml() +
      '<div class="actions">' + (item.id ? '<button type="button" class="ghost danger-text" data-act="delete" data-id="' + esc(item.id) + '">' + esc(t('Delete')) + '</button>' : '') +
      '<button type="button" class="ghost" data-act="cancel-edit">' + esc(t('Cancel')) + '</button><span class="spacer"></span>' +
      '<button class="primary" type="submit">' + esc(t('Save')) + '</button></div></form>';
  }

  // ── actions ──
  async function run(fn) {
    view.busy = true; view.error = '';
    try { await fn(); } catch (e) { view.error = e && e.message ? e.message : String(e); }
    view.busy = false;
    await render();
  }
  async function onSubmit(event) {
    var form = event.target;
    if (!form || !form.dataset || !form.dataset.form) return;
    event.preventDefault();
    var f = new FormData(form), kind = form.dataset.form;
    if (kind === 'setup') {
      var pw = String(f.get('password') || ''), again = String(f.get('confirm') || '');
      if (pw !== again) { view.error = t('The two passwords are different.'); return render(); }
      return run(async function () {
        await V().setup(pw);
        var bio = await V().bioStatus();
        if (bio.available && global.MemoShell && global.MemoShell.confirm &&
            await global.MemoShell.confirm(t('Unlock the Vault with your fingerprint from now on? The password still works.'), { okLabel: t('Use fingerprint') })) {
          await V().enableBio().catch(function () {});
        }
      });
    }
    if (kind === 'unlock') return run(function () { return V().unlock(String(f.get('password') || '')); });
    if (kind === 'password') {
      var next = String(f.get('password') || '');
      if (next !== String(f.get('confirm') || '')) { view.error = t('The two passwords are different.'); return render(); }
      return run(async function () { await V().changePassword(next); view.editing = null; toast(t('Vault password changed.')); });
    }
    if (kind === 'note') {
      return run(async function () {
        await V().save({ id: view.editing.id, type: 'note', title: String(f.get('title') || '').trim(), content: String(f.get('content') || '') });
        view.expanded = null; view.editing = null;
      });
    }
    if (kind === 'ai-key') {
      return run(async function () {
        var item = { id: view.editing.id, type: 'ai-key', provider: String(f.get('provider')), apiKey: String(f.get('apiKey') || ''),
          model: String(f.get('model') || ''), baseUrl: String(f.get('baseUrl') || ''), label: String(f.get('label') || ''), isDefault: f.get('isDefault') === 'on' };
        if (item.baseUrl && !/^https?:\/\//i.test(item.baseUrl)) throw new Error(t('The address must start with https:// or http://'));
        var id = await V().save(item);
        if (item.isDefault) await V().setDefaultAiKey(id);
        else if ((await V().aiKeys()).length === 1) await V().setDefaultAiKey(id);
        view.editing = null;
      });
    }
  }
  async function onClick(event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    if (target.closest('.vault-close')) { dlg.close(); return; }
    var el = target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act, id = el.dataset.id;
    if (act === 'provider' || act === 'bio-toggle') return; // handled on change
    if (act === 'lock') { V().lock(); view.error = ''; return render(); }
    if (act === 'bio') return run(async function () { await V().unlockWithBio(); });
    if (act === 'forgot') return forgot();
    if (act === 'toggle') { view.expanded = view.expanded === id ? null : id; return render(); }
    if (act === 'reveal') { view.revealed[id] = !view.revealed[id]; return render(); }
    if (act === 'add-note') { view.editing = { type: 'note' }; view.error = ''; return render(); }
    if (act === 'add-key') { view.editing = { type: 'ai-key', provider: 'deepseek' }; view.error = ''; return render(); }
    if (act === 'cancel-edit') { view.editing = null; view.error = ''; return render(); }
    if (act === 'edit-note' || act === 'edit-key') { view.editing = Object.assign({}, await V().getItem(id)); view.error = ''; return render(); }
    if (act === 'copy') {
      var note = await V().getItem(id);
      var line = note && V().parseLines(note.content)[Number(el.dataset.line)];
      if (!line) return;
      try { await V().copySecret(line.value); toast(t('Copied · clears in a minute')); }
      catch (_e) { toast(t('Could not copy.'), 'error'); }
      return;
    }
    if (act === 'delete') {
      var ok = !global.MemoShell || !global.MemoShell.confirm || await global.MemoShell.confirm(t('Delete this from the Vault on every device?'), { okLabel: t('Delete'), danger: true });
      if (!ok) return;
      return run(async function () { await V().remove(id); view.expanded = null; view.editing = null; });
    }
    if (act === 'change-password') return changePassword();
  }
  async function onChange(event) {
    var el = event.target;
    if (!dlg || !dlg.contains(el)) return;
    if (el.dataset && el.dataset.act === 'provider') {
      var form = el.closest('form');
      var f = new FormData(form);
      view.editing = Object.assign({}, view.editing, { provider: el.value, apiKey: String(f.get('apiKey') || ''),
        label: String(f.get('label') || ''), model: '', baseUrl: String(f.get('baseUrl') || ''), isDefault: f.get('isDefault') === 'on' });
      return render();
    }
    if (el.dataset && el.dataset.act === 'bio-toggle') {
      return run(async function () {
        if (el.checked) { if (!(await V().enableBio())) el.checked = false; }
        else V().disableBio();
      });
    }
  }
  function changePassword() { view.editing = { type: 'password' }; view.error = ''; return render(); }
  async function forgot() {
    var S = global.MemoShell;
    if (!S || !S.prompt) return;
    var typed = await S.prompt(t('Without the password the Vault cannot be opened. You can delete it and start a new one — every item is lost on every device. Type DELETE to continue.'), '', { okLabel: t('Delete Vault') });
    if (String(typed || '').trim().toUpperCase() !== 'DELETE') return;
    return run(function () { return V().erase(); });
  }

  // ── open / close ──
  async function open() {
    if (!V()) return;
    ensureDialog();
    if (global.MemoShell && global.MemoShell.menuOpen && global.MemoShell.menuOpen()) global.MemoShell.closeMenu();
    view.error = ''; view.editing = null; view.expanded = null; view.revealed = {};
    secure(true);
    if (!dlg.open) dlg.showModal();
    await render();
    // A sealed fingerprint key: offer it right away.
    if (V().exists() && !V().isUnlocked() && (await V().bioStatus()).enabled) run(function () { return V().unlockWithBio(); });
  }

  function showTiles() {
    document.querySelectorAll('#mobileVaultBtn').forEach(function (b) { b.hidden = false; });
  }
  document.addEventListener('click', function (event) {
    var t2 = event.target && event.target.closest ? event.target.closest('#mobileVaultBtn') : null;
    if (t2) { event.preventDefault(); open(); }
  });
  document.addEventListener('change', onChange, true);
  global.addEventListener('memo:vault-change', function (e) {
    if (dlg && dlg.open && e.detail && e.detail.reason !== 'saved') render();
  });
  // Planner's menu mounts later (single-page shell): reveal its tile too.
  document.addEventListener('memo:variant-changed', showTiles);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showTiles); else showTiles();

  global.MemoVaultUi = { open: open, render: render };
})(window);
