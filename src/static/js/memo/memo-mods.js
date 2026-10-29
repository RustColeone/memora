// memo-mods.js — mods: folders a person drops in to add to Memora.
//
// Where the folder is:
//   desktop app   <profile>/mods   (Settings → Mods → Open mods folder)
//   Android app   Android/data/<app>/files/mods   (over USB from a computer)
//   server        <base-dir>/mods   (for pages opened from that server)
// One folder per mod, holding mod.json:
//   { "id": "word-count", "name": "Word count", "version": "1.0", "memora": 1,
//     "description": "…", "scripts": ["main.js"], "styles": ["style.css"] }
// A script calls Memora.mod("word-count", function (memora) { … }) and uses
// only what `memora` offers (see api() below and docs/MODS.md).
//
// A mod runs with Memora's own rights: it can read every entry and the Vault.
// So a mod is off until it is turned on in Settings → Mods, on each device,
// and a mod that fails to load is reported there instead of stopping the app.
(function (global) {
  'use strict';

  var API = 1;
  var KEY = 'memora_mods_enabled';
  var ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
  var FILE = /^(?!.*\.\.)[\w][\w./-]{0,199}$/;
  var found = [];          // [{ folder, manifest, error, base }]
  var defined = Object.create(null);   // id → setup, from Memora.mod()
  var state = Object.create(null);     // id → 'loaded' | error text
  var menuItems = [];      // [{ mod, label, icon, run }]
  var where = '';          // the folder to tell the person about
  var started = null;

  function t(s, v) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s, v) : String(s).replace(/\{(\w+)\}/g, function (_m, k) { return v && v[k] != null ? v[k] : ''; }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function enabled() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_e) { return []; } }
  function setEnabled(id, on) {
    var list = enabled().filter(function (x) { return x !== id; });
    if (on) list.push(id);
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_e) {}
  }

  // ── where mods come from ──
  function host() {
    var D = global.MemoDesktop;
    if (D && D.mods) {
      return { open: function () { return D.mods.openFolder(); }, list: async function () {
        var r = await D.mods.list();
        return { dir: r.dir, mods: (r.mods || []).map(function (m) { return Object.assign(m, { base: '/mods/' + encodeURIComponent(m.folder) + '/' }); }) };
      } };
    }
    var C = global.Capacitor, P = C && C.Plugins && C.Plugins.Mods;
    if (P && C.isNativePlatform && C.isNativePlatform()) {
      return { list: async function () {
        var r = await P.list();
        return { dir: r.dir, mods: (r.mods || []).map(function (m) {
          var manifest = null, error = m.error || '';
          try { manifest = m.manifest ? JSON.parse(m.manifest) : null; } catch (e) { error = 'mod.json: ' + e.message; }
          return { folder: m.folder, manifest: manifest, error: error, base: C.convertFileSrc('file://' + m.path) + '/' };
        }) };
      } };
    }
    if (global.MODE === 'server') {
      return { list: async function () {
        var res = await fetch('/api/mods', { headers: global.MemoAuth && global.MemoAuth.headers ? global.MemoAuth.headers() : {} });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var r = await res.json();
        return { dir: r.dir, mods: (r.mods || []).map(function (m) { return Object.assign(m, { base: '/mods/' + encodeURIComponent(m.folder) + '/' }); }) };
      } };
    }
    return null;
  }

  function check(manifest, folder) {
    if (!manifest || typeof manifest !== 'object') return 'mod.json is missing or not an object';
    if (!ID.test(String(manifest.id || ''))) return 'mod.json: "id" must be lowercase letters, digits, - or _';
    if (manifest.memora !== API) return 'mod.json: "memora" must be ' + API + ' (this Memora understands mods for version ' + API + ')';
    var files = [].concat(manifest.scripts || [], manifest.styles || []);
    if (!files.length) return 'mod.json lists no scripts or styles';
    for (var i = 0; i < files.length; i++) if (!FILE.test(String(files[i]))) return 'mod.json: "' + files[i] + '" is not a file inside ' + folder;
    return '';
  }

  // ── what a mod gets ──
  function api(mod) {
    var manifest = mod.manifest, id = manifest.id;
    var VARIANT = { notes: 'default', spending: 'finance', plans: 'planner' };
    function sdb() { return global.MemoStateDb; }
    function list(page) {
      var v = VARIANT[page];
      if (!v) throw new Error('Unknown page "' + page + '": use notes, spending or plans');
      var s = sdb(); if (!s) return [];
      var items = v === 'planner' ? s.loadDocs(v) : s.loadEntries(v);
      return (items || []).filter(function (e) { return !e.deletedAt && (!global.MemoPrivacy || !global.MemoPrivacy.canViewEntry || global.MemoPrivacy.canViewEntry(e)); })
        .map(function (e) { return JSON.parse(JSON.stringify(e)); });
    }
    async function op(type, page, entryId, data) {
      var v = VARIANT[page], q = global.OperationQueue;
      if (!v) throw new Error('Unknown page "' + page + '"');
      if (!q || !q.addOperation) throw new Error('Saving is not ready yet.');
      await q.addOperation(type, entryId, type === 'delete' ? {} : { data: data }, { variant: v });
      return entryId;
    }
    var store = 'memora_mod_' + id + ':';
    return Object.freeze({
      id: id, version: API, manifest: Object.freeze(JSON.parse(JSON.stringify(manifest))),
      // The address of a file in the mod's own folder, for fetch() or an <img>.
      url: function (file) { if (!FILE.test(String(file))) throw new Error('Not a file in the mod folder: ' + file); return mod.base + file; },
      // Read: copies, without deleted entries or ones the privacy lock hides.
      data: Object.freeze({
        list: list,
        add: function (page, fields) {
          var now = Date.now(), stamp = new Date(now).toISOString();
          var base = page === 'plans' ? { kind: 'todo', title: '', done: false, priority: 'normal' }
            : { description: '', category: 'Uncategorized', tags: [], images: [], attachments: [], imageMeta: {}, ts: now };
          var data = Object.assign(base, fields || {}, { createdAt: stamp, updatedAt: stamp, mod: id });
          return op('create', page, 'mod_' + id + '_' + now.toString(36) + Math.random().toString(36).slice(2, 6), data);
        },
        update: function (page, entryId, fields) { return op('update', page, entryId, Object.assign({}, fields, { updatedAt: new Date().toISOString() })); },
      }),
      // The image Tools sheet (memo-tools.js), with the mod's id in front of the tool's.
      tools: Object.freeze({ register: function (tool) { if (global.MemoTools) global.MemoTools.register(Object.assign({}, tool, { id: id + ':' + tool.id })); } }),
      // A row in the menu's Mods section.
      menu: Object.freeze({ add: function (item) { menuItems.push({ mod: id, label: String(item.label || manifest.name || id), icon: item.icon || 'svg-icon-sparkles', run: item.run }); renderMenu(); } }),
      // Translations: rows of [English, Español, Français, Deutsch, 中文].
      i18n: Object.freeze({ add: function (rows) { if (global.MemoI18n && global.MemoI18n.addMessages) global.MemoI18n.addMessages(rows); }, t: t }),
      // App events: resume, localechange, saved (an entry changed).
      on: function (name, fn) {
        var map = { resume: 'memo:resume', localechange: 'memo:localechange', saved: 'memo:entries-changed' };
        var target = name === 'localechange' ? document : global;
        if (map[name]) target.addEventListener(map[name], function (e) { try { fn(e.detail); } catch (err) { console.warn('[mod ' + id + ']', err); } });
      },
      ui: Object.freeze({
        toast: function (message, kind) { if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast(String(message), kind ? { kind: kind } : undefined); },
        // A sheet of the mod's own: render(body, close) fills it.
        sheet: function (title, render) { return sheet(title, render); },
      }),
      // A few small settings of its own, on this device.
      settings: Object.freeze({
        get: function (key, fallback) { try { var v = localStorage.getItem(store + key); return v == null ? fallback : JSON.parse(v); } catch (_e) { return fallback; } },
        set: function (key, value) { try { localStorage.setItem(store + key, JSON.stringify(value)); } catch (_e) {} },
      }),
    });
  }

  function sheet(title, render) {
    var d = document.createElement('dialog');
    d.className = 'mobile-sheet mod-sheet';
    d.innerHTML = '<div class="modal"><header><strong></strong><button type="button" class="modal-close" aria-label="Close">✕</button></header><div class="content"></div></div>';
    d.querySelector('strong').textContent = title;
    var close = function () { if (d.open) d.close(); };
    d.querySelector('.modal-close').addEventListener('click', close);
    d.addEventListener('close', function () { d.remove(); });
    document.body.appendChild(d);
    try { render(d.querySelector('.content'), close); } catch (e) { d.remove(); throw e; }
    d.showModal();
    return { close: close, element: d };
  }

  // ── loading ──
  function addTag(tag, attrs) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement(tag);
      Object.keys(attrs).forEach(function (k) { el[k] = attrs[k]; });
      el.onload = resolve;
      el.onerror = function () { reject(new Error('could not load ' + (attrs.src || attrs.href))); };
      document.head.appendChild(el);
    });
  }
  async function loadOne(mod) {
    var m = mod.manifest, id = m.id;
    try {
      for (var i = 0; i < (m.styles || []).length; i++) await addTag('link', { rel: 'stylesheet', href: mod.base + m.styles[i] });
      for (var j = 0; j < (m.scripts || []).length; j++) await addTag('script', { src: mod.base + m.scripts[j], async: false });
      if (m.scripts && m.scripts.length) {
        if (!defined[id]) throw new Error('its script never called Memora.mod("' + id + '", …)');
        await defined[id](api(mod));
      }
      state[id] = 'loaded';
    } catch (e) {
      state[id] = (e && e.message) || String(e);
      console.warn('[mods] ' + id + ' did not load:', e);
    }
  }
  function start() {
    if (started) return started;
    started = (async function () {
      var h = host();
      if (!h) { render(); return; }
      try {
        var r = await h.list();
        where = r.dir || '';
        var seen = Object.create(null);
        found = (r.mods || []).map(function (m) {
          var error = m.error || check(m.manifest, m.folder);
          if (!error && seen[m.manifest.id]) error = 'another mod already uses the id "' + m.manifest.id + '"';
          if (!error) seen[m.manifest.id] = true;
          return Object.assign({}, m, { error: error });
        });
      } catch (e) { console.warn('[mods] could not list mods:', e); found = []; }
      var on = enabled();
      for (var i = 0; i < found.length; i++) if (!found[i].error && on.indexOf(found[i].manifest.id) >= 0) await loadOne(found[i]);
      render();
    })();
    return started;
  }

  // ── Settings → Mods, and the menu's Mods section ──
  function renderMenu() {
    var menu = document.querySelector('#mobileMenu .mobile-menu-scroll');
    if (!menu) return;
    var box = document.getElementById('modsMenuSection');
    if (!box) {
      box = document.createElement('div');
      box.id = 'modsMenuSection';
      var before = Array.prototype.find.call(menu.querySelectorAll('.sp-section-label'), function (el) { return /Data/.test(el.getAttribute('data-i18n') || ''); });
      menu.insertBefore(box, before || null);
    }
    box.innerHTML = '';
    if (!menuItems.length) return;
    var label = document.createElement('div');
    label.className = 'sp-section-label';
    label.textContent = t('Mods');
    box.appendChild(label);
    menuItems.forEach(function (item) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.mod = item.mod;
      b.innerHTML = '<span class="svg-icon ' + esc(item.icon) + '"></span> <span></span>';
      b.lastChild.textContent = item.label;
      b.addEventListener('click', function () {
        if (global.MemoShell && global.MemoShell.closeMenu) global.MemoShell.closeMenu();
        try { item.run(); } catch (e) { console.warn('[mod ' + item.mod + ']', e); }
      });
      box.appendChild(b);
    });
  }

  function render() {
    var content = document.querySelector('#settingsDlg .content');
    if (!content) return;
    var box = document.getElementById('modsSection');
    if (!box) {
      box = document.createElement('div');
      box.id = 'modsSection';
      box.className = 'settings-section mods-section';
      content.appendChild(box);
    }
    var h = host();
    var html = '<h3><span class="svg-icon svg-icon-sparkles"></span> <span>' + esc(t('Mods')) + '</span></h3>';
    if (!h) {
      box.innerHTML = html + '<p class="muted">' + esc(t('Mods work in the desktop app, the Android app and on pages opened from a Memora server.')) + '</p>';
      return;
    }
    html += '<p class="muted">' + esc(t('A mod adds to Memora from a folder you put in the mods folder. It can read everything here, the Vault included: turn on only mods you trust.')) + '</p>';
    if (where) html += '<p class="muted mods-where">' + esc(t('Mods folder:')) + ' <code>' + esc(where) + '</code></p>';
    if (!found.length) html += '<p class="muted">' + esc(t('No mods yet.')) + '</p>';
    var on = enabled();
    found.forEach(function (m) {
      var man = m.manifest || {}, id = man.id || m.folder, live = state[id];
      html += '<div class="mod-row" data-mod="' + esc(id) + '"><label class="mod-switch"><input type="checkbox" data-mod-toggle="' + esc(id) + '"' +
        (m.error ? ' disabled' : '') + (on.indexOf(id) >= 0 && !m.error ? ' checked' : '') + '> <strong>' + esc(man.name || m.folder) + '</strong>' +
        (man.version ? ' <span class="muted">' + esc(man.version) + '</span>' : '') + '</label>' +
        (man.description ? '<div class="muted">' + esc(man.description) + '</div>' : '') +
        (m.error ? '<div class="mod-error" role="alert">' + esc(m.error) + '</div>'
          : live && live !== 'loaded' ? '<div class="mod-error" role="alert">' + esc(t('Did not load: {why}', { why: live })) + '</div>' : '') + '</div>';
    });
    var actions = '';
    if (h.open) actions += '<button type="button" id="modsOpenFolder">' + esc(t('Open mods folder')) + '</button> ';
    actions += '<button type="button" id="modsReload">' + esc(t('Apply changes')) + '</button>';
    html += '<div class="form-row mods-actions">' + actions + '</div>';
    box.innerHTML = html;
    box.querySelectorAll('[data-mod-toggle]').forEach(function (input) {
      input.addEventListener('change', function () { setEnabled(input.getAttribute('data-mod-toggle'), input.checked); });
    });
    var open = document.getElementById('modsOpenFolder');
    if (open) open.addEventListener('click', function () { h.open(); });
    // Turning a mod on or off takes effect after a reload; so does a new folder.
    document.getElementById('modsReload').addEventListener('click', function () { global.location.reload(); });
  }

  global.MemoI18n && global.MemoI18n.addMessages && global.MemoI18n.addMessages([
    ['Mods', 'Mods', 'Mods', 'Mods', '模组'],
    ['Mods work in the desktop app, the Android app and on pages opened from a Memora server.',
      'Los mods funcionan en la app de escritorio, la app de Android y en las páginas abiertas desde un servidor de Memora.',
      'Les mods fonctionnent dans l’app de bureau, l’app Android et sur les pages ouvertes depuis un serveur Memora.',
      'Mods funktionieren in der Desktop-App, der Android-App und auf Seiten, die von einem Memora-Server geöffnet werden.',
      '模组可在桌面版、Android 版以及从 Memora 服务器打开的页面中使用。'],
    ['A mod adds to Memora from a folder you put in the mods folder. It can read everything here, the Vault included: turn on only mods you trust.',
      'Un mod añade funciones a Memora desde una carpeta que pones en la carpeta de mods. Puede leer todo, incluida la Caja fuerte: activa solo mods en los que confíes.',
      'Un mod ajoute des fonctions à Memora depuis un dossier placé dans le dossier des mods. Il peut tout lire, le Coffre compris : n’activez que des mods de confiance.',
      'Ein Mod erweitert Memora aus einem Ordner im Mods-Ordner. Er kann alles lesen, auch den Tresor: Schalte nur Mods ein, denen du vertraust.',
      '模组来自你放进模组文件夹的文件夹，为 Memora 添加功能。它能读取这里的一切，包括保险箱：只开启你信任的模组。'],
    ['Mods folder:', 'Carpeta de mods:', 'Dossier des mods :', 'Mods-Ordner:', '模组文件夹：'],
    ['No mods yet.', 'Aún no hay mods.', 'Aucun mod pour l’instant.', 'Noch keine Mods.', '还没有模组。'],
    ['Did not load: {why}', 'No se cargó: {why}', 'Non chargé : {why}', 'Nicht geladen: {why}', '未能加载：{why}'],
    ['Open mods folder', 'Abrir carpeta de mods', 'Ouvrir le dossier des mods', 'Mods-Ordner öffnen', '打开模组文件夹'],
    ['Apply changes', 'Aplicar cambios', 'Appliquer', 'Änderungen anwenden', '应用更改'],
  ]);

  // The public name a mod's script uses.
  global.Memora = Object.freeze({
    version: API,
    mod: function (id, setup) { if (ID.test(String(id)) && typeof setup === 'function' && !defined[id]) defined[id] = setup; },
  });
  global.MemoMods = { API: API, start: start, render: render, list: function () { return found.slice(); }, state: function () { return Object.assign({}, state); } };

  document.addEventListener('memo:localechange', function () { render(); renderMenu(); });
  global.addEventListener('load', function () {
    Promise.resolve(global.MemoAppReady).then(start).catch(function () {});
  }, { once: true });
})(window);
