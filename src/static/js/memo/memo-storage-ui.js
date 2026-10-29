// memo-storage-ui.js — what the person sees of storage and protected files:
// the password dialog, sending exports out (share sheet on the phone,
// downloads in a browser), the lock screen for a restored phone, and the
// recovery password for the phone's encrypted database.
(function (global) {
  'use strict';

  global.MemoI18n.addMessages([
    ['Protect this backup', 'Proteger esta copia', 'Protéger cette sauvegarde', 'Diese Sicherung schützen', '保护此备份'],
    ['Choose a password for this backup. Without it the backup cannot be opened, and Memora cannot recover a forgotten password.', 'Elige una contraseña para esta copia. Sin ella no se puede abrir, y Memora no puede recuperar una contraseña olvidada.', 'Choisissez un mot de passe pour cette sauvegarde. Sans lui, elle ne peut pas être ouverte, et Memora ne peut pas récupérer un mot de passe oublié.', 'Wähle ein Passwort für diese Sicherung. Ohne es lässt sie sich nicht öffnen, und Memora kann ein vergessenes Passwort nicht wiederherstellen.', '为此备份设置密码。没有密码就无法打开备份，Memora 也无法找回忘记的密码。'],
    ['Enter the backup password', 'Introduce la contraseña de la copia', 'Saisissez le mot de passe de la sauvegarde', 'Passwort der Sicherung eingeben', '输入备份密码'],
    ['Password', 'Contraseña', 'Mot de passe', 'Passwort', '密码'],
    ['Repeat password', 'Repite la contraseña', 'Répétez le mot de passe', 'Passwort wiederholen', '再次输入密码'],
    ['Use at least 8 characters.', 'Usa al menos 8 caracteres.', 'Utilisez au moins 8 caractères.', 'Mindestens 8 Zeichen verwenden.', '至少使用 8 个字符。'],
    ['The two passwords are different.', 'Las dos contraseñas no coinciden.', 'Les deux mots de passe sont différents.', 'Die beiden Passwörter sind verschieden.', '两次输入的密码不一致。'],
    ['Wrong password. Try again.', 'Contraseña incorrecta. Inténtalo de nuevo.', 'Mot de passe incorrect. Réessayez.', 'Falsches Passwort. Erneut versuchen.', '密码错误，请重试。'],
    ['Continue', 'Continuar', 'Continuer', 'Weiter', '继续'],
    ['Share backup', 'Compartir copia', 'Partager la sauvegarde', 'Sicherung teilen', '分享备份'],
    ['Saves a password-protected backup (.memora) of your entries, images and assistant chats. On the phone it opens the share sheet. Very large libraries are split into parts.', 'Guarda una copia protegida con contraseña (.memora) de tus entradas, imágenes y chats del asistente. En el teléfono abre el menú Compartir. Las bibliotecas muy grandes se dividen en partes.', 'Enregistre une sauvegarde protégée par mot de passe (.memora) de vos entrées, images et discussions avec l’assistant. Sur le téléphone, elle ouvre le menu Partager. Les très grandes bibliothèques sont découpées en parties.', 'Speichert eine passwortgeschützte Sicherung (.memora) deiner Einträge, Bilder und Assistenten-Chats. Auf dem Telefon öffnet sich das Teilen-Menü. Sehr große Bibliotheken werden in Teile aufgeteilt.', '保存受密码保护的备份（.memora），包含你的条目、图片和助手聊天记录。在手机上会打开分享菜单。非常大的资料库会拆分成多个部分。'],
    ['Choose a backup (.memora, or an older .zip) to restore your data.', 'Elige una copia (.memora o un .zip anterior) para restaurar tus datos.', 'Choisissez une sauvegarde (.memora, ou un ancien .zip) pour restaurer vos données.', 'Wähle eine Sicherung (.memora oder ein älteres .zip), um deine Daten wiederherzustellen.', '选择一个备份（.memora 或旧版 .zip）来恢复数据。'],
    ['This is a database file, not a backup. Restore a backup made with Export backup.', 'Esto es un archivo de base de datos, no una copia. Restaura una copia hecha con Exportar copia.', 'Ceci est un fichier de base de données, pas une sauvegarde. Restaurez une sauvegarde créée avec Exporter une sauvegarde.', 'Das ist eine Datenbankdatei, keine Sicherung. Stelle eine Sicherung wieder her, die mit „Sicherung exportieren“ erstellt wurde.', '这是数据库文件，不是备份。请恢复用“导出备份”创建的备份。'],
    ['Phone database', 'Base de datos del teléfono', 'Base de données du téléphone', 'Telefon-Datenbank', '手机数据库'],
    ['Encrypted on this phone.', 'Cifrada en este teléfono.', 'Chiffrée sur ce téléphone.', 'Auf diesem Telefon verschlüsselt.', '已在此手机上加密。'],
    ['Encrypted on this phone. Recovery password is set.', 'Cifrada en este teléfono. Hay una contraseña de recuperación.', 'Chiffrée sur ce téléphone. Un mot de passe de récupération est défini.', 'Auf diesem Telefon verschlüsselt. Ein Wiederherstellungspasswort ist gesetzt.', '已在此手机上加密。已设置恢复密码。'],
    ['Encrypted on this phone. No recovery password yet.', 'Cifrada en este teléfono. Aún no hay contraseña de recuperación.', 'Chiffrée sur ce téléphone. Aucun mot de passe de récupération pour l’instant.', 'Auf diesem Telefon verschlüsselt. Noch kein Wiederherstellungspasswort.', '已在此手机上加密。尚未设置恢复密码。'],
    ['Set recovery password', 'Definir contraseña de recuperación', 'Définir un mot de passe de récupération', 'Wiederherstellungspasswort festlegen', '设置恢复密码'],
    ['Change recovery password', 'Cambiar contraseña de recuperación', 'Changer le mot de passe de récupération', 'Wiederherstellungspasswort ändern', '更改恢复密码'],
    ['If Android restores Memora onto a new phone from its backup, this password opens your entries there. Without it, they come back from your server or a backup.', 'Si Android restaura Memora en un teléfono nuevo desde su copia, esta contraseña abre allí tus entradas. Sin ella, vuelven desde tu servidor o una copia.', 'Si Android restaure Memora sur un nouveau téléphone depuis sa sauvegarde, ce mot de passe y ouvre vos entrées. Sans lui, elles reviennent depuis votre serveur ou une sauvegarde.', 'Wenn Android Memora aus seiner Sicherung auf ein neues Telefon überträgt, öffnet dieses Passwort dort deine Einträge. Ohne es kommen sie von deinem Server oder einer Sicherung zurück.', '如果 Android 从备份把 Memora 恢复到新手机上，此密码可在那里打开你的条目。没有它，条目将从你的服务器或备份恢复。'],
    ['Choose a recovery password. Keep it somewhere safe: Memora cannot show it again or recover it.', 'Elige una contraseña de recuperación. Guárdala en un lugar seguro: Memora no puede mostrarla de nuevo ni recuperarla.', 'Choisissez un mot de passe de récupération. Conservez-le en lieu sûr : Memora ne peut ni l’afficher à nouveau ni le récupérer.', 'Wähle ein Wiederherstellungspasswort. Bewahre es sicher auf: Memora kann es weder erneut anzeigen noch wiederherstellen.', '设置恢复密码。请妥善保管：Memora 无法再次显示或找回它。'],
    ['Recovery password saved.', 'Contraseña de recuperación guardada.', 'Mot de passe de récupération enregistré.', 'Wiederherstellungspasswort gespeichert.', '恢复密码已保存。'],
    ['Unlock this phone’s entries', 'Desbloquear las entradas de este teléfono', 'Déverrouiller les entrées de ce téléphone', 'Einträge dieses Telefons entsperren', '解锁此手机上的条目'],
    ['Memora was restored onto this phone from an Android backup. The key that opens its database stayed on the old phone.', 'Memora se restauró en este teléfono desde una copia de Android. La clave que abre su base de datos se quedó en el teléfono anterior.', 'Memora a été restauré sur ce téléphone depuis une sauvegarde Android. La clé qui ouvre sa base de données est restée sur l’ancien téléphone.', 'Memora wurde aus einer Android-Sicherung auf dieses Telefon übertragen. Der Schlüssel zur Datenbank ist auf dem alten Telefon geblieben.', 'Memora 是通过 Android 备份恢复到这台手机上的。打开其数据库的密钥留在了旧手机上。'],
    ['Enter the recovery password you set on that phone.', 'Introduce la contraseña de recuperación que definiste en ese teléfono.', 'Saisissez le mot de passe de récupération défini sur ce téléphone.', 'Gib das Wiederherstellungspasswort ein, das du auf jenem Telefon festgelegt hast.', '输入你在那台手机上设置的恢复密码。'],
    ['No recovery password was set on that phone.', 'No se definió contraseña de recuperación en ese teléfono.', 'Aucun mot de passe de récupération n’a été défini sur ce téléphone.', 'Auf jenem Telefon wurde kein Wiederherstellungspasswort festgelegt.', '那台手机上没有设置恢复密码。'],
    ['Unlock', 'Desbloquear', 'Déverrouiller', 'Entsperren', '解锁'],
    ['Start fresh', 'Empezar de cero', 'Repartir de zéro', 'Neu beginnen', '重新开始'],
    ['Start with an empty database? The locked one stays on this phone, untouched. Get your entries back by syncing with your server or importing a backup.', '¿Empezar con una base de datos vacía? La bloqueada se queda en este teléfono, intacta. Recupera tus entradas sincronizando con tu servidor o importando una copia.', 'Commencer avec une base de données vide ? La base verrouillée reste sur ce téléphone, intacte. Récupérez vos entrées en synchronisant avec votre serveur ou en important une sauvegarde.', 'Mit einer leeren Datenbank beginnen? Die gesperrte bleibt unverändert auf diesem Telefon. Hol deine Einträge per Synchronisierung mit deinem Server oder durch Import einer Sicherung zurück.', '要从空数据库开始吗？被锁定的数据库会原样留在这台手机上。通过与服务器同步或导入备份来找回你的条目。'],
    ['Memora cannot open this phone’s database', 'Memora no puede abrir la base de datos de este teléfono', 'Memora ne peut pas ouvrir la base de données de ce téléphone', 'Memora kann die Datenbank dieses Telefons nicht öffnen', 'Memora 无法打开这台手机的数据库'],
    ['Your entries are untouched, and nothing will be saved until it opens. Try again, or start fresh and get your entries back from your server or a backup.', 'Tus entradas están intactas y no se guardará nada hasta que se abra. Inténtalo de nuevo, o empieza de cero y recupera tus entradas desde tu servidor o una copia.', 'Vos entrées sont intactes et rien ne sera enregistré tant qu’elle ne s’ouvre pas. Réessayez, ou repartez de zéro et récupérez vos entrées depuis votre serveur ou une sauvegarde.', 'Deine Einträge sind unverändert, und nichts wird gespeichert, bis sie sich öffnet. Erneut versuchen oder neu beginnen und Einträge von deinem Server oder einer Sicherung zurückholen.', '你的条目未受影响，在它能打开之前不会保存任何内容。请重试，或重新开始并从服务器或备份找回条目。'],
    ['Try again', 'Reintentar', 'Réessayer', 'Erneut versuchen', '重试'],
    ['Use the copy from {date}', 'Usar la copia del {date}', 'Utiliser la copie du {date}', 'Kopie vom {date} verwenden', '使用 {date} 的副本'],
    ['When this phone switched to encrypted storage, Memora kept a copy of everything as it was then ({memos} memos, {finance} finance entries, {planner} planner items). Changes after that come back when you sync with your server.', 'Cuando este teléfono pasó al almacenamiento cifrado, Memora guardó una copia de todo tal como estaba ({memos} notas, {finance} entradas de finanzas, {planner} elementos del planificador). Los cambios posteriores vuelven al sincronizar con tu servidor.', 'Lorsque ce téléphone est passé au stockage chiffré, Memora a gardé une copie de tout tel quel ({memos} notes, {finance} entrées de finances, {planner} éléments du planificateur). Les changements ultérieurs reviennent en synchronisant avec votre serveur.', 'Als dieses Telefon auf verschlüsselten Speicher umgestellt wurde, hat Memora eine Kopie des damaligen Stands behalten ({memos} Notizen, {finance} Finanzeinträge, {planner} Planer-Einträge). Spätere Änderungen kommen bei der Synchronisierung mit deinem Server zurück.', '这台手机切换到加密存储时，Memora 保留了当时全部内容的副本（{memos} 条备忘、{finance} 条财务记录、{planner} 个计划项）。之后的更改会在与服务器同步时恢复。'],
    ['Replace', 'Reemplazar', 'Remplacer', 'Ersetzen', '替换'],
    ['Export backup', 'Exportar copia', 'Exporter une sauvegarde', 'Sicherung exportieren', '导出备份'],
    ['Export cancelled.', 'Exportación cancelada.', 'Exportation annulée.', 'Export abgebrochen.', '已取消导出。'],
    ['Restore cancelled. Your data is unchanged.', 'Restauración cancelada. Tus datos no han cambiado.', 'Restauration annulée. Vos données sont inchangées.', 'Wiederherstellung abgebrochen. Deine Daten sind unverändert.', '已取消恢复，你的数据未更改。'],
  ]);

  var t = function (key, vars) { return global.MemoI18n.t(key, vars); };
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text != null) node.textContent = text;
    return node;
  }

  // ── password dialog ──────────────────────────────────────────
  // opts: { title, message, confirm (ask twice, for a new password),
  //         okLabel, check(password) -> Promise (throw to show its message) }
  // Resolves the password, or null when cancelled.
  function askPassword(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var dlg = el('dialog', { class: 'password-dlg', 'aria-labelledby': 'passwordDlgTitle' });
      var modal = el('div', { class: 'modal' });
      var head = el('header');
      head.append(el('strong', { id: 'passwordDlgTitle' }, opts.title || t('Password')));
      var body = el('div', { class: 'content' });
      if (opts.message) body.append(el('p', { class: 'muted' }, opts.message));
      var first = el('input', { type: 'password', id: 'passwordDlgFirst', autocomplete: opts.confirm ? 'new-password' : 'current-password', 'aria-label': t('Password'), placeholder: t('Password') });
      body.append(first);
      var second = null;
      if (opts.confirm) {
        second = el('input', { type: 'password', id: 'passwordDlgSecond', autocomplete: 'new-password', 'aria-label': t('Repeat password'), placeholder: t('Repeat password') });
        body.append(second);
      }
      var error = el('p', { class: 'password-dlg-error', role: 'alert' });
      body.append(error);
      var actions = el('div', { class: 'actions' });
      var cancel = el('button', { type: 'button', class: 'ghost' }, t('cancel'));
      var ok = el('button', { type: 'button', class: 'primary' }, opts.okLabel || t('Continue'));
      actions.append(cancel, el('span', { class: 'spacer' }), ok);
      modal.append(head, body, actions);
      dlg.append(modal);
      document.body.append(dlg);
      var done = false;
      function finish(value) {
        if (done) return; done = true;
        try { dlg.close(); } catch (_e) {}
        dlg.remove();
        resolve(value);
      }
      async function submit() {
        var value = first.value;
        error.textContent = '';
        if (opts.confirm && value.length < 8) { error.textContent = t('Use at least 8 characters.'); return; }
        if (!value) { first.focus(); return; }
        if (second && second.value !== value) { error.textContent = t('The two passwords are different.'); second.focus(); return; }
        if (opts.check) {
          ok.disabled = true;
          try { await opts.check(value); }
          catch (e) { error.textContent = e && e.message || t('Wrong password. Try again.'); ok.disabled = false; first.select(); return; }
          ok.disabled = false;
        }
        finish(value);
      }
      ok.addEventListener('click', submit);
      cancel.addEventListener('click', function () { finish(null); });
      dlg.addEventListener('cancel', function (event) { event.preventDefault(); finish(null); });
      [first, second].forEach(function (input) {
        if (input) input.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
      });
      dlg.showModal();
      first.focus();
    });
  }

  // ── files out ────────────────────────────────────────────────
  // Android: files are written into the private cache (memora-out/) and
  // handed to the share sheet together by finish(). Browser: each downloads.
  var staged = [];
  function capacitor() { return global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform() ? global.Capacitor : null; }
  function fileShare() { var C = capacitor(); return C && C.Plugins && C.Plugins.FileShare; }
  async function stage(name, bytes) {
    var C = capacitor(), share = fileShare();
    if (C && share && C.Plugins.Filesystem) {
      var Fs = C.Plugins.Filesystem, path = 'memora-out/' + name, chunk = 3 * 1024 * 1024;
      var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      await Fs.writeFile({ path: path, data: global.MemoCrypto.toBase64(view.subarray(0, chunk)), directory: 'CACHE', recursive: true });
      for (var offset = chunk; offset < view.length; offset += chunk) {
        await Fs.appendFile({ path: path, data: global.MemoCrypto.toBase64(view.subarray(offset, offset + chunk)), directory: 'CACHE' });
      }
      staged.push(name);
      return;
    }
    var link = el('a');
    link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    link.download = name;
    document.body.append(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 30000);
    await new Promise(function (r) { setTimeout(r, 60); });
  }
  async function finish(title) {
    var share = fileShare();
    var names = staged; staged = [];
    if (share && names.length) await share.shareFiles({ names: names, mimeType: 'application/octet-stream', title: title || t('Share backup') });
  }

  // ── a phone database that cannot be opened ───────────────────
  function preNativeOption(info, body, actions, error) {
    var copy = info && info.preNative;
    if (!copy) return;
    var date = copy.newest ? new Date(copy.newest).toLocaleDateString(global.MemoI18n.getLocale()) : '';
    body.append(el('p', { class: 'muted' }, t('When this phone switched to encrypted storage, Memora kept a copy of everything as it was then ({memos} memos, {finance} finance entries, {planner} planner items). Changes after that come back when you sync with your server.',
      { memos: copy.memos, finance: copy.finance, planner: copy.planner })));
    var use = el('button', { type: 'button', class: 'secondary', id: 'storageLockUseCopy' }, t('Use the copy from {date}', { date: date }));
    use.addEventListener('click', async function () {
      error.textContent = '';
      use.disabled = true;
      try { await global.MemoStateDb.storage.restorePreNative(); location.reload(); }
      catch (e) { error.textContent = e.message; use.disabled = false; }
    });
    actions.prepend(use);
  }
  function lockScreen(engine, info) {
    var dlg = el('dialog', { class: 'storage-lock-dlg', 'aria-labelledby': 'storageLockTitle' });
    var modal = el('div', { class: 'modal' });
    var head = el('header', { tabindex: '-1', autofocus: '' });
    var body = el('div', { class: 'content' });
    var actions = el('div', { class: 'actions' });
    var error = el('p', { class: 'password-dlg-error', role: 'alert' });
    var fresh = el('button', { type: 'button', class: 'ghost' }, t('Start fresh'));
    fresh.addEventListener('click', async function () {
      var sure = await global.MemoShell.confirm(t('Start with an empty database? The locked one stays on this phone, untouched. Get your entries back by syncing with your server or importing a backup.'), { title: t('Start fresh'), okLabel: t('Start fresh') });
      if (!sure) return;
      try { await global.MemoStateDb.storage.startFresh(); location.reload(); }
      catch (e) { error.textContent = e.message; }
    });
    if (engine === 'locked') {
      head.append(el('strong', { id: 'storageLockTitle' }, t('Unlock this phone’s entries')));
      body.append(el('p', null, t('Memora was restored onto this phone from an Android backup. The key that opens its database stayed on the old phone.')));
      if (info && info.hasRecovery) {
        body.append(el('p', { class: 'muted' }, t('Enter the recovery password you set on that phone.')));
        var input = el('input', { type: 'password', id: 'storageLockPassword', autocomplete: 'current-password', 'aria-label': t('Password'), placeholder: t('Password') });
        body.append(input, error);
        var unlock = el('button', { type: 'button', class: 'primary' }, t('Unlock'));
        var tryUnlock = async function () {
          error.textContent = '';
          unlock.disabled = true;
          try { await global.MemoStateDb.storage.unlock(input.value); location.reload(); }
          catch (e) { error.textContent = e.code === 'decrypt-failed' ? t('Wrong password. Try again.') : e.message; unlock.disabled = false; }
        };
        unlock.addEventListener('click', tryUnlock);
        input.addEventListener('keydown', function (event) { if (event.key === 'Enter') tryUnlock(); });
        actions.append(fresh, el('span', { class: 'spacer' }), unlock);
      } else {
        body.append(el('p', { class: 'muted' }, t('No recovery password was set on that phone.')), error);
        actions.append(el('span', { class: 'spacer' }), fresh);
      }
    } else {
      head.append(el('strong', { id: 'storageLockTitle' }, t('Memora cannot open this phone’s database')));
      body.append(el('p', null, t('Your entries are untouched, and nothing will be saved until it opens. Try again, or start fresh and get your entries back from your server or a backup.')));
      if (info && info.reason) body.append(el('p', { class: 'muted' }, info.reason));
      body.append(error);
      var retry = el('button', { type: 'button', class: 'primary' }, t('Try again'));
      retry.addEventListener('click', function () { location.reload(); });
      actions.append(fresh, el('span', { class: 'spacer' }), retry);
    }
    preNativeOption(info, body, actions, error);
    modal.append(head, body, actions);
    dlg.append(modal);
    dlg.addEventListener('cancel', function (event) { event.preventDefault(); });
    document.body.append(dlg);
    dlg.showModal();
  }

  // ── recovery password setting ────────────────────────────────
  async function refreshPhoneSection() {
    var section = document.getElementById('phoneDbSection');
    var storage = global.MemoStateDb && global.MemoStateDb.storage;
    if (!section || !storage) return;
    if (storage.engine() !== 'native') { section.hidden = true; return; }
    section.hidden = false;
    var has = await storage.hasRecoveryPassword();
    var state = document.getElementById('phoneDbState');
    var label = document.getElementById('phoneDbRecoveryLabel');
    if (state) state.textContent = t(has ? 'Encrypted on this phone. Recovery password is set.' : 'Encrypted on this phone. No recovery password yet.');
    if (label) label.textContent = t(has ? 'Change recovery password' : 'Set recovery password');
  }
  async function setRecoveryPassword() {
    var password = await askPassword({ title: t('Set recovery password'), confirm: true,
      message: t('Choose a recovery password. Keep it somewhere safe: Memora cannot show it again or recover it.') });
    if (!password) return;
    await global.MemoStateDb.storage.setRecoveryPassword(password);
    global.MemoShell && global.MemoShell.toast(t('Recovery password saved.'), { kind: 'success' });
    refreshPhoneSection();
  }

  function init() {
    var btn = document.getElementById('phoneDbRecoveryBtn');
    if (btn) btn.addEventListener('click', function () {
      setRecoveryPassword().catch(function (e) { global.MemoShell && global.MemoShell.toast(e.message, { kind: 'error' }); });
    });
    var db = global.MemoStateDb;
    if (!db || !db.init) return;
    db.init().then(function () {
      var engine = db.storage.engine();
      if (engine === 'locked' || engine === 'unavailable') lockScreen(engine, db.storage.info());
      refreshPhoneSection();
    }, function () {});
  }
  document.addEventListener('memo:localechange', refreshPhoneSection);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  global.MemoStorageUI = { askPassword: askPassword, stage: stage, finish: finish, refreshPhoneSection: refreshPhoneSection };
})(window);
