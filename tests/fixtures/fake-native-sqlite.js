// A stand-in for Android in browser tests: Capacitor reporting a native
// platform, a Filesystem plugin and @capacitor-community/sqlite. Databases are
// sql.js files kept in localStorage, so they survive page reloads the way a
// phone's storage survives app restarts. Each database remembers the
// passphrase it was created with and refuses another one, like SQLCipher.
(function () {
  'use strict';
  var LS = 'fakeNative:';
  var sqlPromise = null;
  var open = {};          // name -> { db, inTx }
  var log = [];

  function sql() {
    if (!sqlPromise) sqlPromise = window.initSqlJs({ locateFile: function (f) { return '/static/vendor/' + f; } });
    return sqlPromise;
  }
  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(text) {
    var s = atob(text), b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  function get(key) { return localStorage.getItem(LS + key); }
  function set(key, value) { if (value === null) localStorage.removeItem(LS + key); else localStorage.setItem(LS + key, value); }
  function persist(name) { set('db:' + name, toB64(open[name].db.export())); }
  function rows(db, statement, values) {
    var out = [], stmt = db.prepare(statement);
    try { stmt.bind(values || []); while (stmt.step()) out.push(stmt.getAsObject()); } finally { stmt.free(); }
    return out;
  }
  function need(name) {
    if (!open[name]) throw new Error('Database ' + name + ' is not open');
    return open[name];
  }
  function maybeFail(method) {
    var fail = window.__fakeNative.failNext;
    if (fail && fail[method]) { fail[method]--; throw new Error('Injected ' + method + ' failure'); }
  }

  function names() {
    return Object.keys(localStorage).filter(function (k) { return k.indexOf(LS + 'db:') === 0; }).map(function (k) { return k.slice((LS + 'db:').length); });
  }
  var connections = {};
  var SQLite = {
    // Like the real plugin: needs a connection; isDatabase checks the file.
    isDBExists: async function (o) {
      if (!connections[o.database]) throw new Error('isDBExists: No available connection for database ' + o.database);
      return { result: get('db:' + o.database) !== null };
    },
    isDatabase: async function (o) { return { result: get('db:' + o.database) !== null }; },
    getDatabaseList: async function () {
      var list = names().map(function (n) { return n + 'SQLite.db'; });
      if (!list.length) throw new Error('No databases found');
      return { values: list };
    },
    isSecretStored: async function () { return { result: !!get('secret') }; },
    // Saves first, then refuses if any database cannot be opened with it.
    setEncryptionSecret: async function (o) {
      if (get('secret')) throw new Error('a passphrase has already been set ');
      set('secret', o.passphrase);
      names().forEach(function (n) {
        if (get('key:' + n) !== o.passphrase) throw new Error('SetEncryptionSecret: State for: ' + n + 'SQLite.db not correct');
      });
    },
    clearEncryptionSecret: async function () { set('secret', null); },
    createConnection: async function (o) { connections[o.database] = true; log.push({ method: 'createConnection', database: o.database }); },
    closeConnection: async function (o) { delete open[o.database]; delete connections[o.database]; },
    open: async function (o) {
      var SQL = await sql();
      var secret = get('secret');
      if (!secret) throw new Error('No Passphrase stored');
      var stored = get('db:' + o.database);
      if (stored !== null && get('key:' + o.database) !== secret) throw new Error('file is not a database');
      if (stored === null) set('key:' + o.database, secret);
      open[o.database] = { db: stored !== null ? new SQL.Database(fromB64(stored)) : new SQL.Database(), inTx: false };
      if (stored === null) persist(o.database);
    },
    close: async function (o) { delete open[o.database]; },
    query: async function (o) {
      var c = need(o.database);
      if (/^\s*PRAGMA quick_check/i.test(o.statement)) {
        return { values: [{ quick_check: get('damaged:' + o.database) ? 'database disk image is malformed' : 'ok' }] };
      }
      return { values: rows(c.db, o.statement, o.values) };
    },
    executeSet: async function (o) {
      var c = need(o.database);
      maybeFail('executeSet');
      log.push({ method: 'executeSet', database: o.database, statements: o.set.length });
      var own = o.transaction !== false && !c.inTx;
      if (own) c.db.run('BEGIN');
      try {
        o.set.forEach(function (st) { c.db.run(st.statement, st.values || []); });
        if (own) { c.db.run('COMMIT'); persist(o.database); }
      } catch (error) {
        if (own) c.db.run('ROLLBACK');
        throw error;
      }
      return { changes: { changes: o.set.length } };
    },
    beginTransaction: async function (o) { var c = need(o.database); c.db.run('BEGIN'); c.inTx = true; return {}; },
    commitTransaction: async function (o) { var c = need(o.database); c.db.run('COMMIT'); c.inTx = false; persist(o.database); return {}; },
    rollbackTransaction: async function (o) { var c = need(o.database); c.db.run('ROLLBACK'); c.inTx = false; return {}; }
  };

  var Filesystem = {
    readFile: async function (o) {
      var v = get('file:' + o.path);
      if (v === null) { var e = new Error('File does not exist'); e.code = 'OS-PLUG-FILE-0008'; throw e; }
      return { data: v };
    },
    writeFile: async function (o) { log.push({ method: 'writeFile', path: o.path }); set('file:' + o.path, o.data); return {}; },
    appendFile: async function (o) { set('file:' + o.path, (get('file:' + o.path) || '') + o.data); return {}; },
    deleteFile: async function (o) {
      if (get('file:' + o.path) === null) { var e = new Error('File does not exist'); e.code = 'OS-PLUG-FILE-0008'; throw e; }
      set('file:' + o.path, null); return {};
    },
    mkdir: async function () { return {}; },
    getUri: async function (o) { return { uri: 'file:///data/user/0/fake/files/' + o.path }; },
    rename: async function (o) {
      var db = /^file:\/\/\/data\/user\/0\/fake\/databases\/(.+)SQLite\.db$/.exec(o.from);
      if (db) {
        if (get('db:' + db[1]) === null) throw new Error('File does not exist');
        set('aside:' + o.to, get('db:' + db[1])); set('db:' + db[1], null); set('key:' + db[1], null);
        return {};
      }
      if (/^file:/.test(o.from)) throw new Error('File does not exist');
      set('file:' + o.to, get('file:' + o.from)); set('file:' + o.from, null); return {};
    },
    readdir: async function () { return { files: [] }; },
    stat: async function (o) { if (get('file:' + o.path) === null) throw new Error('File does not exist'); return { type: 'file' }; }
  };

  window.__fakeNative = {
    log: log,
    failNext: {},
    file: function (path) { return get('file:' + path); },
    putFile: function (path, data) { set('file:' + path, data); },
    hasDb: function (name) { return get('db:' + name) !== null; },
    setAside: function () { return Object.keys(localStorage).filter(function (k) { return k.indexOf(LS + 'aside:') === 0; }).map(function (k) { return k.slice((LS + 'aside:').length).replace(/^.*\/files\//, ''); }); },
    tableCount: async function (name, table) {
      var SQL = await sql();
      var db = new SQL.Database(fromB64(get('db:' + name)));
      try { return db.exec('SELECT COUNT(*) FROM ' + table)[0].values[0][0]; } finally { db.close(); }
    },
    damage: function (name) { set('damaged:' + name, '1'); },
    // A phone restored from Android backup: files and databases came back,
    // the Keystore-held passphrase did not.
    restoreOnNewPhone: function () { set('secret', null); },
    reset: function () {
      Object.keys(localStorage).filter(function (k) { return k.indexOf(LS) === 0; }).forEach(function (k) { localStorage.removeItem(k); });
    }
  };
  window.Capacitor = {
    isNativePlatform: function () { return true; },
    getPlatform: function () { return 'android'; },
    Plugins: { CapacitorSQLite: SQLite, Filesystem: Filesystem }
  };
})();
