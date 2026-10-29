// memo-i18n.js — lightweight localization for Memora's chrome.
//
// A translation table (en + es/fr/de/zh) with t(key, vars) (English fallback,
// {var} interpolation) and a DOM applier that swaps elements marked with:
//   data-i18n="key"          → textContent
//   data-i18n-html="key"     → innerHTML (strings that contain markup/icons)
//   data-i18n-ph="key"       → placeholder
//   data-i18n-title="key"    → title
//   data-i18n-aria="key"     → aria-label
// Coverage is the visible chrome (header, view menu, Settings, core dialogs);
// adding keys/languages is copy-translate-extend. Dynamic JS strings can call
// MemoI18n.t() incrementally later.
(function (global) {
  'use strict';
  var LANG_KEY = 'memoLang'; // { useSystem: bool, locale: string }

  var T = {
    en: {
      _name: 'English', _native: 'English',
      searchPlaceholder: 'Search description / tags…',
      filters: 'Filters', calendar: 'Calendar', bin: 'Bin', chat: 'Chat', menu: 'Menu',
      groupByTime: 'Group by time', day: 'Day', week: 'Week', month: 'Month', year: 'Year',
      cardSize: 'Card size', dateFormat: 'Date format', adjustView: 'Adjust View', period: 'Period',
      dateFmtAuto: 'Auto (locale)', dateFmtRelative: 'Relative',
      settings: 'Settings', language: 'Language', useSystemLanguage: 'Use system language',
      serverSync: 'Server Sync', localFolder: 'Local Folder Storage', dataBackup: 'Data Backup',
      verifyRepair: 'Verify & Repair', scanLibrary: 'Scan Library', libraryHealth: 'Library Health',
      aiAnalysis: 'AI Analysis', personalAiKey: 'Personal AI Key',
      exportData: 'Export Data', importData: 'Import Data',
      cancel: 'Cancel', save: 'Save', close: 'Close', apply: 'Apply', post: 'Post', add: 'Add',
      description: 'Description', category: 'Category', tags: 'Tags', newEntry: 'New Entry',
      albums: 'Folders', uncategorized: 'Uncategorized',
      modeScroll: '<span class="svg-icon svg-icon-scroll"></span> Scroll',
      modeLtr: '<span class="svg-icon svg-icon-chevron-right"></span> L<span class="svg-icon svg-icon-arrow-right-md"></span> R',
      modeRtl: '<span class="svg-icon svg-icon-chevron-left"></span> R<span class="svg-icon svg-icon-arrow-right-md"></span> L',
    },
    es: {
      _name: 'Spanish', _native: 'Español',
      searchPlaceholder: 'Buscar descripción / etiquetas…',
      filters: 'Filtros', calendar: 'Calendario', bin: 'Papelera', chat: 'Chat', menu: 'Menú',
      groupByTime: 'Agrupar por tiempo', day: 'Día', week: 'Semana', month: 'Mes', year: 'Año',
      cardSize: 'Tamaño de tarjeta', dateFormat: 'Formato de fecha', adjustView: 'Ajustar vista', period: 'Período',
      dateFmtAuto: 'Auto (local)', dateFmtRelative: 'Relativo',
      settings: 'Ajustes', language: 'Idioma', useSystemLanguage: 'Usar idioma del sistema',
      serverSync: 'Sincronización con servidor', localFolder: 'Almacenamiento en carpeta local', dataBackup: 'Copia de seguridad',
      verifyRepair: 'Verificar y reparar', scanLibrary: 'Escanear biblioteca', libraryHealth: 'Salud de la biblioteca',
      aiAnalysis: 'Análisis con IA', personalAiKey: 'Clave de IA personal',
      exportData: 'Exportar datos', importData: 'Importar datos',
      cancel: 'Cancelar', save: 'Guardar', close: 'Cerrar', apply: 'Aplicar', post: 'Publicar', add: 'Añadir',
      description: 'Descripción', category: 'Categoría', tags: 'Etiquetas', newEntry: 'Nueva entrada',
    },
    fr: {
      _name: 'French', _native: 'Français',
      searchPlaceholder: 'Rechercher description / étiquettes…',
      filters: 'Filtres', calendar: 'Calendrier', bin: 'Corbeille', chat: 'Discussion', menu: 'Menu',
      groupByTime: 'Grouper par temps', day: 'Jour', week: 'Semaine', month: 'Mois', year: 'Année',
      cardSize: 'Taille des cartes', dateFormat: 'Format de date', adjustView: 'Ajuster la vue', period: 'Période',
      dateFmtAuto: 'Auto (locale)', dateFmtRelative: 'Relatif',
      settings: 'Paramètres', language: 'Langue', useSystemLanguage: 'Utiliser la langue du système',
      serverSync: 'Synchronisation serveur', localFolder: 'Stockage dossier local', dataBackup: 'Sauvegarde des données',
      verifyRepair: 'Vérifier et réparer', scanLibrary: 'Analyser la bibliothèque', libraryHealth: 'Santé de la bibliothèque',
      aiAnalysis: 'Analyse par IA', personalAiKey: 'Clé IA personnelle',
      exportData: 'Exporter les données', importData: 'Importer les données',
      cancel: 'Annuler', save: 'Enregistrer', close: 'Fermer', apply: 'Appliquer', post: 'Publier', add: 'Ajouter',
      description: 'Description', category: 'Catégorie', tags: 'Étiquettes', newEntry: 'Nouvelle entrée',
    },
    de: {
      _name: 'German', _native: 'Deutsch',
      searchPlaceholder: 'Beschreibung / Tags suchen…',
      filters: 'Filter', calendar: 'Kalender', bin: 'Papierkorb', chat: 'Chat', menu: 'Menü',
      groupByTime: 'Nach Zeit gruppieren', day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr',
      cardSize: 'Kartengröße', dateFormat: 'Datumsformat', adjustView: 'Ansicht anpassen', period: 'Zeitraum',
      dateFmtAuto: 'Auto (Gebietsschema)', dateFmtRelative: 'Relativ',
      settings: 'Einstellungen', language: 'Sprache', useSystemLanguage: 'Systemsprache verwenden',
      serverSync: 'Server-Synchronisierung', localFolder: 'Lokaler Ordnerspeicher', dataBackup: 'Datensicherung',
      verifyRepair: 'Prüfen & Reparieren', scanLibrary: 'Bibliothek scannen', libraryHealth: 'Bibliothekszustand',
      aiAnalysis: 'KI-Analyse', personalAiKey: 'Persönlicher KI-Schlüssel',
      exportData: 'Daten exportieren', importData: 'Daten importieren',
      cancel: 'Abbrechen', save: 'Speichern', close: 'Schließen', apply: 'Anwenden', post: 'Posten', add: 'Hinzufügen',
      description: 'Beschreibung', category: 'Kategorie', tags: 'Tags', newEntry: 'Neuer Eintrag',
    },
    zh: {
      _name: 'Chinese', _native: '中文',
      searchPlaceholder: '搜索描述 / 标签…',
      filters: '筛选', calendar: '日历', bin: '回收站', chat: '聊天', menu: '菜单',
      groupByTime: '按时间分组', day: '日', week: '周', month: '月', year: '年',
      cardSize: '卡片大小', dateFormat: '日期格式', adjustView: '调整视图', period: '周期',
      dateFmtAuto: '自动（区域）', dateFmtRelative: '相对',
      settings: '设置', language: '语言', useSystemLanguage: '使用系统语言',
      serverSync: '服务器同步', localFolder: '本地文件夹存储', dataBackup: '数据备份',
      verifyRepair: '验证与修复', scanLibrary: '扫描库', libraryHealth: '图库健康度',
      aiAnalysis: 'AI 分析', personalAiKey: '个人 AI 密钥',
      exportData: '导出数据', importData: '导入数据',
      cancel: '取消', save: '保存', close: '关闭', apply: '应用', post: '发布', add: '添加',
      description: '描述', category: '分类', tags: '标签', newEntry: '新条目',
    },
  };

  var _locale = 'en';

  function detectSystemLocale() {
    var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
    for (var i = 0; i < langs.length; i++) {
      var code = String(langs[i]).split('-')[0].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(T, code)) return code;
    }
    return 'en';
  }
  function t(key, vars) {
    var dict = T[_locale] || T.en;
    var str = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key]
      : (Object.prototype.hasOwnProperty.call(T.en, key) ? T.en[key] : key);
    if (vars && str) for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) str = str.split('{' + k + '}').join(String(vars[k]));
    return str;
  }
  function setLocale(code) { _locale = Object.prototype.hasOwnProperty.call(T, code) ? code : 'en'; }
  function getLocale() { return _locale; }
  function availableLocales() {
    return Object.keys(T).map(function (c) { return { code: c, name: T[c]._name, nativeName: T[c]._native }; });
  }

  // ── persistence ──
  function readPref() { try { return JSON.parse(localStorage.getItem(LANG_KEY)) || null; } catch (_e) { return null; } }
  function writePref(pref) { try { localStorage.setItem(LANG_KEY, JSON.stringify(pref)); } catch (_e) {} }

  // ── DOM applier ──
  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    root.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
    root.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    try { document.documentElement.setAttribute('lang', _locale); } catch (_e) {}
  }

  // Switch language: persist (explicit choice), set, re-apply to the whole page,
  // and refresh the picker so its option labels + selection track the new locale.
  function choose(code) {
    if (code === 'system') { writePref({ useSystem: true }); setLocale(detectSystemLocale()); }
    else { writePref({ useSystem: false, locale: code }); setLocale(code); }
    apply(document);
    initPicker();
    // Let dynamically-rendered chrome (e.g. the recycle-bin badge, feed dates)
    // re-render in the new language.
    try { document.dispatchEvent(new CustomEvent('memo:localechange', { detail: { locale: _locale } })); } catch (_e) {}
  }

  // Resolve the initial locale from the stored preference (or system) — call
  // before first paint of chrome. Does not touch the DOM.
  function initLocale() {
    var pref = readPref();
    if (pref && pref.useSystem === false && pref.locale) setLocale(pref.locale);
    else setLocale(detectSystemLocale());
  }

  // Populate + wire the Settings language <select> (native name + English name,
  // plus a "use system language" option). Changing it re-localises the page.
  function initPicker() {
    var sel = document.getElementById('languageSelect');
    if (!sel) return;
    var pref = readPref();
    var usingSystem = !pref || pref.useSystem !== false;
    var html = '<option value="system"' + (usingSystem ? ' selected' : '') + '>' + t('useSystemLanguage') + '</option>';
    availableLocales().forEach(function (l) {
      var on = (!usingSystem && pref.locale === l.code) ? ' selected' : '';
      var label = l.nativeName === l.name ? l.name : (l.nativeName + ' (' + l.name + ')');
      html += '<option value="' + l.code + '"' + on + '>' + label + '</option>';
    });
    sel.innerHTML = html;
    sel.onchange = function () { choose(sel.value); }; // onchange = idempotent on re-render
  }

  initLocale();
  function ready() { apply(document); initPicker(); }
  document.addEventListener('memo:variant-changed', ready);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  global.MemoI18n = {
    addMessages: function (rows) { rows.forEach(function (row) { ['en','es','fr','de','zh'].forEach(function (locale, i) { T[locale][row[0]] = row[i]; }); }); },
    t: t, apply: apply, choose: choose,
    setLocale: setLocale, getLocale: getLocale, availableLocales: availableLocales,
    detectSystemLocale: detectSystemLocale, initLocale: initLocale,
    readPref: readPref, LANG_KEY: LANG_KEY,
  };
})(window);
