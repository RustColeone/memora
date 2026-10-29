// memo-about.js — the About sheet: what Memora does with your data, plus the
// credits shared with ImageDB and Neuro-Camp. Credit portraits load on first
// open (they are not in the service-worker precache), so startup is unaffected.
(function (global) {
  'use strict';

  // [en, es, fr, de, zh] like memo-i18n-tools.js; credit rows reuse ImageDB's translations.
  global.MemoI18n.addMessages([
    ['About', 'Acerca de', 'À propos', 'Über', '关于'],
    ['About Memora', 'Acerca de Memora', 'À propos de Memora', 'Über Memora', '关于 Memora'],
    ['Close About', 'Cerrar Acerca de', 'Fermer À propos', 'Über schließen', '关闭“关于”'],
    ['Memora keeps memos, finances and plans in one private notebook on this device.',
      'Memora guarda notas, finanzas y planes en un cuaderno privado en este dispositivo.',
      'Memora réunit notes, finances et plans dans un carnet privé sur cet appareil.',
      'Memora bewahrt Notizen, Finanzen und Pläne in einem privaten Notizbuch auf diesem Gerät auf.',
      'Memora 把备忘、财务和计划保存在本设备上的一本私人笔记中。'],
    ['Your notebook stays on this device', 'Tu cuaderno se queda en este dispositivo',
      'Votre carnet reste sur cet appareil', 'Dein Notizbuch bleibt auf diesem Gerät', '笔记保存在本设备上'],
    ['Entries, images and files are saved on this device and work offline. Memora has no account and no developer cloud.',
      'Las entradas, imágenes y archivos se guardan en este dispositivo y funcionan sin conexión. Memora no tiene cuentas ni nube del desarrollador.',
      'Les entrées, images et fichiers sont enregistrés sur cet appareil et fonctionnent hors ligne. Memora n’a ni compte ni cloud du développeur.',
      'Einträge, Bilder und Dateien werden auf diesem Gerät gespeichert und funktionieren offline. Memora hat kein Konto und keine Entwickler-Cloud.',
      '条目、图片和文件都保存在本设备上，离线也能使用。Memora 没有账户，也没有开发者云端。'],
    ['Sync is optional and yours', 'La sincronización es opcional y tuya',
      'La synchronisation est facultative et à vous', 'Synchronisierung ist optional und gehört dir', '同步可选，由你掌控'],
    ['If you connect a sync server, Memora copies your data only to the server address you enter, such as one you host yourself.',
      'Si conectas un servidor de sincronización, Memora copia tus datos solo a la dirección que indiques, por ejemplo uno alojado por ti.',
      'Si vous connectez un serveur de synchronisation, Memora copie vos données uniquement à l’adresse saisie, par exemple un serveur que vous hébergez.',
      'Wenn du einen Sync-Server verbindest, kopiert Memora deine Daten nur an die eingegebene Adresse, etwa einen selbst gehosteten Server.',
      '如果连接同步服务器，Memora 只会把数据复制到你填写的服务器地址，例如你自己搭建的服务器。'],
    ['AI: bring your own key', 'IA: trae tu propia clave',
      'IA : apportez votre propre clé', 'KI: bring deinen eigenen Schlüssel mit', 'AI：自带密钥'],
    ['Memora has no AI service and includes no AI key. Photo analysis and AI chats are off until you add your own API key in the Vault or use your sync server’s own AI. Then what you send, and the records an AI contact is allowed to read, go to the provider you chose (such as DeepSeek, Gemini, OpenAI or Claude) under its own privacy policy. Nothing an AI suggests is saved until you tap it. On Android, text recognition (OCR) runs on the device.',
      'Memora no tiene servicio de IA ni incluye ninguna clave. El análisis de fotos y los chats con IA están desactivados hasta que añadas tu propia una clave de API en la Bóveda o uses la IA propia de tu servidor de sincronización. Entonces, lo que envías y los registros que un contacto de IA tiene permitido leer van al proveedor elegido (como DeepSeek, Gemini, OpenAI o Claude) según su propia política de privacidad. Nada de lo que sugiere una IA se guarda hasta que lo tocas. En Android, el reconocimiento de texto (OCR) se ejecuta en el dispositivo.',
      'Memora n’a pas de service d’IA et ne fournit aucune clé. L’analyse de photos et les discussions avec l’IA sont désactivées tant que vous n’ajoutez pas votre propre clé d’API dans le Coffre ou n’utilisez pas l’IA de votre serveur de synchronisation. Ce que vous envoyez, ainsi que les éléments qu’un contact IA est autorisé à lire, partent alors chez le fournisseur choisi (par exemple DeepSeek, Gemini, OpenAI ou Claude) selon sa propre politique de confidentialité. Rien de ce que propose une IA n’est enregistré avant que vous ne le touchiez. Sur Android, la reconnaissance de texte (OCR) s’exécute sur l’appareil.',
      'Memora hat keinen eigenen KI-Dienst und keinen Schlüssel dabei. Fotoanalyse und KI-Chats sind aus, bis du deinen eigenen API-Schlüssel im Tresor hinzufügst oder die eigene KI deines Sync-Servers nutzt. Dann gehen das Gesendete und die Einträge, die ein KI-Kontakt lesen darf, an den gewählten Anbieter (etwa DeepSeek, Gemini, OpenAI oder Claude), gemäß dessen Datenschutzrichtlinie. Nichts, was eine KI vorschlägt, wird gespeichert, bevor du es antippst. Unter Android läuft die Texterkennung (OCR) auf dem Gerät.',
      'Memora 没有自己的 AI 服务，也不附带任何密钥。照片分析和 AI 聊天在你于保险库中添加自己的 API 密钥、或使用同步服务器自带的 AI 之前不会启用。启用后，你发送的内容以及 AI 联系人获准读取的记录会发送给你选择的服务商（如 DeepSeek、Gemini、OpenAI 或 Claude），并适用其隐私政策。AI 提出的任何更改在你点按之前都不会保存。在 Android 上，文字识别（OCR）在设备上运行。'],
    ['Android backup', 'Copia de Android', 'Sauvegarde Android', 'Android-Sicherung', 'Android 备份'],
    ["On Android, entries are kept in an encrypted database. If Android backup is on, Android may copy Memora's data to your Google account and to a new phone. The entries in that copy open on another phone only with the recovery password you set in Backup & Data; images are copied as they are. Backups you export yourself are protected by their own password.",
      'En Android, las entradas se guardan en una base de datos cifrada. Si la copia de Android está activada, Android puede copiar los datos de Memora a tu cuenta de Google y a un teléfono nuevo. Las entradas de esa copia solo se abren en otro teléfono con la contraseña de recuperación que definas en Copia y datos; las imágenes se copian tal cual. Las copias que exportas tú están protegidas con su propia contraseña.',
      'Sur Android, les entrées sont conservées dans une base de données chiffrée. Si la sauvegarde Android est activée, Android peut copier les données de Memora sur votre compte Google et sur un nouveau téléphone. Les entrées de cette copie ne s’ouvrent sur un autre téléphone qu’avec le mot de passe de récupération défini dans Sauvegarde et données ; les images sont copiées telles quelles. Les sauvegardes que vous exportez sont protégées par leur propre mot de passe.',
      'Unter Android liegen Einträge in einer verschlüsselten Datenbank. Ist die Android-Sicherung aktiv, kann Android die Daten von Memora in dein Google-Konto und auf ein neues Telefon kopieren. Die Einträge dieser Kopie öffnen sich auf einem anderen Telefon nur mit dem Wiederherstellungspasswort aus „Sicherung & Daten“; Bilder werden unverändert kopiert. Selbst exportierte Sicherungen schützt ihr eigenes Passwort.',
      '在 Android 上，条目保存在加密数据库中。如果开启了 Android 备份，Android 可能会把 Memora 的数据复制到你的 Google 账户和新手机。只有使用你在“备份与数据”中设置的恢复密码，这份副本中的条目才能在另一台手机上打开；图片会按原样复制。你自己导出的备份由其各自的密码保护。'],
    ['App lock', 'Bloqueo de la app', 'Verrouillage de l’app', 'App-Sperre', '应用锁'],
    ['Read the full privacy policy', 'Leer la política de privacidad completa', 'Lire la politique de confidentialité complète',
      'Vollständige Datenschutzerklärung lesen', '阅读完整隐私政策'],
    ['Source code (AGPL-3.0)', 'Código fuente (AGPL-3.0)', 'Code source (AGPL-3.0)', 'Quellcode (AGPL-3.0)', '源代码（AGPL-3.0）'],
    ['Privacy can lock a page, or Safe entries, behind your device biometrics or screen lock. Memora never stores a PIN.',
      'Privacidad puede bloquear una página o las entradas de Caja fuerte con la biometría o el bloqueo de pantalla del dispositivo. Memora nunca guarda un PIN.',
      'Confidentialité peut verrouiller une page ou les entrées du Coffre avec la biométrie ou le verrouillage d’écran de l’appareil. Memora ne stocke jamais de code PIN.',
      'Datenschutz kann eine Seite oder Tresor-Einträge mit Biometrie oder Displaysperre des Geräts schützen. Memora speichert nie eine PIN.',
      '“隐私”可以用设备的生物识别或锁屏来锁定某个页面或保险箱条目。Memora 从不保存 PIN。'],
    ['Credits', 'Créditos', 'Crédits', 'Mitwirkende', '贡献者'],
    ['UCLA alum', 'Exalumno de UCLA', 'Ancien étudiant de UCLA', 'Absolvent der UCLA', 'UCLA 校友'],
    ['USC alum', 'Exalumno de USC', 'Ancien étudiant de USC', 'Absolvent der USC', 'USC 校友'],
    ['MSU alum', 'Exalumno de MSU', 'Ancien étudiant de MSU', 'Absolvent der MSU', 'MSU 校友'],
    ['Special Thanks', 'Agradecimientos especiales', 'Remerciements particuliers', 'Besonderer Dank', '特别鸣谢'],
    ['UCLA Ph.D. student', 'Doctorando en UCLA', 'Doctorant à UCLA', 'Doktorand an der UCLA', 'UCLA 博士生'],
    ['speedcuber', 'speedcuber', 'speedcubeur', 'Speedcuber', '魔方速拧选手'],
    ['Honorable Mention', 'Mención de honor', 'Mention d’honneur', 'Ehrenvolle Erwähnung', '荣誉致谢'],
    ['UCLA Power Electronics and Energy Control (PEEC) Lab', 'Laboratorio de Electrónica de Potencia y Control de Energía (PEEC) de UCLA',
      'Laboratoire d’électronique de puissance et de contrôle de l’énergie (PEEC) de UCLA', 'Labor für Leistungselektronik und Energiesteuerung (PEEC) der UCLA',
      'UCLA 电力电子与能源控制（PEEC）实验室'],
    ['Thank you, Deepseek-Chan, GPT-Chan, and Claude-Chan, for helping us navigate debugging and deployment through Google Play Console.',
      'Gracias a Deepseek-Chan, GPT-Chan y Claude-Chan por ayudarnos con la depuración y la publicación mediante Google Play Console.',
      'Merci à Deepseek-Chan, GPT-Chan et Claude-Chan pour leur aide dans le débogage et la publication via Google Play Console.',
      'Danke an Deepseek-Chan, GPT-Chan und Claude-Chan für die Hilfe beim Debuggen und Veröffentlichen über die Google Play Console.',
      '感谢 Deepseek-Chan、GPT-Chan 和 Claude-Chan 帮助我们完成调试，以及通过 Google Play Console 部署和发布应用。'],
    ['AI-Chan illustrations', 'Ilustraciones de AI-Chan', 'Illustrations AI-Chan', 'AI-Chan-Illustrationen', 'AI娘插画'],
    ['Deepseek-Chan original character', 'Personaje original de Deepseek-Chan', 'Personnage original de Deepseek-Chan', 'Ursprüngliche Figur von Deepseek-Chan', 'Deepseek-Chan 角色原作'],
    ['No modifications made by Memora; scaled for display.',
      'Sin modificaciones por Memora; tamaño ajustado para su visualización.',
      'Aucune modification par Memora ; taille adaptée à l’affichage.',
      'Keine Änderungen durch Memora; für die Anzeige skaliert.',
      'Memora 未修改图片，仅调整显示尺寸。'],
  ]);

  function dlg() { return document.getElementById('aboutDlg'); }

  function open() {
    var d = dlg(); if (!d) return;
    if (global.MemoShell && global.MemoShell.closeMenu) global.MemoShell.closeMenu();
    // Own attribute, not data-src, so the feed's lazy loader (memo-lazyimg.js) ignores them.
    d.querySelectorAll('img[data-credit-src]').forEach(function (img) { img.src = img.getAttribute('data-credit-src'); img.removeAttribute('data-credit-src'); });
    global.MemoI18n.apply(d);
    if (!d.open) d.showModal();
  }

  function init() {
    var btn = document.getElementById('aboutBtn');
    if (btn) btn.addEventListener('click', open);
    var close = document.getElementById('aboutCloseBtn');
    if (close) close.addEventListener('click', function () { var d = dlg(); if (d) d.close(); });
    // Credit links open in the system browser, not inside the app's WebView.
    document.querySelectorAll('#aboutDlg a[target="_blank"]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        global.open(event.currentTarget.href, '_blank', 'noopener');
      });
    });
    global.MemoI18n.apply(dlg() || document.createElement('div'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  global.MemoAbout = { open: open };
})(window);
