// memo-native-store.js — Android's durable store: native SQLite through
// @capacitor-community/sqlite, encrypted with SQLCipher. The desktop app
// (desktop/main.cjs) answers the same plugin calls on an encrypted SQLite file,
// so it runs this store unchanged.
//
// MemoStateDb keeps its sql.js working copy everywhere; on Android this store
// is where data lives between launches. Each change arrives as a batch of
// single-row statements in one transaction, so nothing ever rewrites a whole
// file. Every database here sits in Memora's private folder.
//
// Keys: the passphrase is random. The plugin keeps it in Android's
// Keystore-backed storage, which never leaves this phone, and the main
// database holds a copy in `native_meta` (never mirrored into the working
// copy, exports or backups). With a recovery password set, the passphrase is
// also sealed into memora-db-recovery.memora, so a phone restored from
// Android backup can open its notes again. Without one, the restored database
// stays untouched beside a fresh one; notes come back from the server or a
// backup. Last-known-good copies are separate databases under the same key.
(function (global) {
  'use strict';

  var CAP_DIR = 'MemoSystem';
  var POINTER_FILE = 'memora-db.json';          // { name } of the main database
  var RECOVERY_FILE = 'memora-db-recovery.memora';
  var DEFAULT_NAME = 'memora';
  var BATCH = 400;                                // statements per bridge call
  var META = 'CREATE TABLE IF NOT EXISTS native_meta (key TEXT PRIMARY KEY, value TEXT)';
  // Columns added after a table first shipped (memo-state-db.js migrates the
  // working copy the same way). CREATE IF NOT EXISTS cannot add them to an
  // existing phone database, and a write naming a missing column would fail.
  var ADDED_COLUMNS = [['memos', 'safe', 'INTEGER DEFAULT 0'], ['finance_entries', 'details', 'TEXT']];

  var secret = null;      // passphrase, known once the main database is open
  var state = 'closed';   // closed | ready | locked
  var main = null;        // Connection to the main database

  function plugin() {
    var C = global.Capacitor, D = global.MemoDesktop;
    return (C && C.Plugins && C.Plugins.CapacitorSQLite) || (D && D.sqlite) || null;
  }
  function fs() {
    var C = global.Capacitor, D = global.MemoDesktop;
    return (C && C.Plugins && C.Plugins.Filesystem) || (C && C.Filesystem) || (D && D.fs) || null;
  }
  function isNative() {
    var C = global.Capacitor;
    return !!(C && C.isNativePlatform && C.isNativePlatform()) || !!global.MemoDesktop;
  }

  async function readText(name) {
    try {
      var r = await fs().readFile({ path: CAP_DIR + '/' + name, directory: 'DATA', encoding: 'utf8' });
      return typeof r.data === 'string' ? r.data : null;
    } catch (_e) { return null; }
  }
  async function writeText(name, text) {
    try { await fs().mkdir({ path: CAP_DIR, directory: 'DATA', recursive: true }); } catch (_e) {}
    await fs().writeFile({ path: CAP_DIR + '/' + name, data: text, directory: 'DATA', encoding: 'utf8' });
  }
  async function pointer() {
    var raw = await readText(POINTER_FILE);
    try { var p = raw && JSON.parse(raw); if (p && p.name) return p; } catch (_e) {}
    return { name: DEFAULT_NAME };
  }
  // isDatabase checks the file itself; isDBExists needs an open connection.
  async function exists(name) {
    try { return !!(await plugin().isDatabase({ database: name })).result; } catch (_e) { return false; }
  }
  async function databaseFiles() {
    try { return ((await plugin().getDatabaseList()).values || []).filter(function (f) { return /SQLite\.db$/.test(f); }); }
    catch (_e) { return []; } // the plugin throws when the folder is empty
  }
  // The plugin refuses a new passphrase while any database in its folder
  // cannot be opened with it. Databases this phone has no key for (restored
  // by Android backup) are moved, with their side files, out of that folder
  // into files/MemoSystem/locked-<time>/: still on the phone, still backed
  // up, never deleted.
  async function setAside(files) {
    if (!files.length) return null;
    var Fs = fs();
    var base = (await Fs.getUri({ path: CAP_DIR, directory: 'DATA' })).uri.replace(/\/$/, '');
    var dbDir = base.replace(/\/files\/MemoSystem$/, '/databases');
    var folder = 'locked-' + Date.now();
    await Fs.mkdir({ path: CAP_DIR + '/' + folder, directory: 'DATA', recursive: true });
    for (var i = 0; i < files.length; i++) {
      var sides = [files[i], files[i] + '-journal', files[i] + '-wal', files[i] + '-shm'];
      for (var k = 0; k < sides.length; k++) {
        try { await Fs.rename({ from: dbDir + '/' + sides[k], to: base + '/' + folder + '/' + sides[k] }); }
        catch (error) { if (k === 0) throw error; } // side files usually do not exist
      }
    }
    return folder;
  }
  async function secretFromCopies(schema) {
    var names = ['memora-lkg-a', 'memora-lkg-b'];
    for (var i = 0; i < names.length; i++) {
      if (!(await exists(names[i]))) continue;
      try {
        var conn = await new Connection(names[i]).open(schema);
        var value = await conn.meta('db_secret');
        await conn.close();
        if (value) return value;
      } catch (_e) {}
    }
    return null;
  }
  async function storeNewSecret(value) {
    try { await plugin().setEncryptionSecret({ passphrase: value }); }
    catch (error) {
      // The plugin saves the passphrase before checking the other databases;
      // what matters is that it is stored now.
      if (!(await secretStored())) throw error;
    }
  }
  async function secretStored() {
    try { return !!(await plugin().isSecretStored()).result; } catch (_e) { return false; }
  }

  // One open database. Main, and each last-known-good copy, is a Connection.
  function Connection(name) { this.name = name; }
  Connection.prototype.open = async function (schema) {
    var P = plugin();
    try { await P.closeConnection({ database: this.name }); } catch (_e) {}
    await P.createConnection({ database: this.name, version: 1, encrypted: true, mode: 'secret', readonly: false });
    await P.open({ database: this.name });
    await this.run((schema || []).concat([META]).map(function (s) { return { statement: s, values: [] }; }), true);
    for (var i = 0; i < ADDED_COLUMNS.length; i++) {
      var add = ADDED_COLUMNS[i];
      var columns = await this.query('PRAGMA table_info(' + add[0] + ')');
      if (columns.length && !columns.some(function (c) { return c.name === add[1]; })) {
        await this.run([{ statement: 'ALTER TABLE ' + add[0] + ' ADD COLUMN ' + add[1] + ' ' + add[2], values: [] }], true);
      }
    }
    var check = (await this.query('PRAGMA quick_check'))[0];
    var verdict = check && (check.quick_check || check[Object.keys(check)[0]]);
    if (verdict !== 'ok') throw new Error('Database ' + this.name + ' failed its integrity check: ' + verdict);
    return this;
  };
  Connection.prototype.query = async function (sql, values) {
    var r = await plugin().query({ database: this.name, statement: sql, values: values || [] });
    return (r && r.values) || [];
  };
  Connection.prototype.run = async function (set, transaction) {
    if (set.length) await plugin().executeSet({ database: this.name, set: set, transaction: transaction !== false });
  };
  // Apply a batch atomically: every statement commits, or none does.
  Connection.prototype.apply = async function (statements) {
    if (statements.length <= BATCH) return this.run(statements, true);
    var P = plugin();
    await P.beginTransaction({ database: this.name });
    try {
      for (var i = 0; i < statements.length; i += BATCH) await this.run(statements.slice(i, i + BATCH), false);
      await P.commitTransaction({ database: this.name });
    } catch (error) {
      try { await P.rollbackTransaction({ database: this.name }); } catch (_e) {}
      throw error;
    }
  };
  // Apply statements handed over a chunk at a time by nextChunk() (null when
  // done), all in one transaction, so a whole-database copy never has to sit
  // in memory at once and still commits all or nothing.
  Connection.prototype.applyChunks = async function (nextChunk) {
    var P = plugin();
    await P.beginTransaction({ database: this.name });
    try {
      for (var chunk = nextChunk(); chunk; chunk = nextChunk()) {
        for (var i = 0; i < chunk.length; i += BATCH) await this.run(chunk.slice(i, i + BATCH), false);
      }
      await P.commitTransaction({ database: this.name });
    } catch (error) {
      try { await P.rollbackTransaction({ database: this.name }); } catch (_e) {}
      throw error;
    }
  };
  // Rows of one table in pages, for building the working copy at launch.
  Connection.prototype.readTable = async function (table, onRows) {
    var page = 5000, offset = 0;
    for (;;) {
      var rows = await this.query('SELECT * FROM ' + table + ' ORDER BY rowid LIMIT ? OFFSET ?', [page, offset]);
      if (rows.length) onRows(rows);
      if (rows.length < page) return;
      offset += page;
    }
  };
  Connection.prototype.count = async function (table) {
    var r = (await this.query('SELECT COUNT(*) AS n FROM ' + table))[0];
    return r ? Number(r.n) : 0;
  };
  Connection.prototype.meta = async function (key) {
    var r = (await this.query('SELECT value FROM native_meta WHERE key=?', [key]))[0];
    return r ? r.value : null;
  };
  Connection.prototype.close = async function () {
    try { await plugin().close({ database: this.name }); } catch (_e) {}
    try { await plugin().closeConnection({ database: this.name }); } catch (_e) {}
  };

  var Store = {
    // True on Android builds that include the plugin.
    available: function () { return isNative() && !!plugin() && !!fs(); },
    state: function () { return state; },
    main: function () { return main; },

    // Open (or create) the main database. Resolves { state: 'ready', created }
    // or { state: 'locked', hasRecovery } when this phone holds a database it
    // cannot unlock (Android restored it, but not the Keystore key).
    open: async function (schema) {
      var P = plugin();
      var name = (await pointer()).name;
      var hasDb = await exists(name);
      if (hasDb && !(await secretStored())) {
        state = 'locked';
        return { state: state, hasRecovery: !!(await readText(RECOVERY_FILE)) };
      }
      if (!(await secretStored())) {
        // No key on this phone yet: databases already in the folder belong to
        // a key this phone never had, so they are set aside first.
        await setAside(await databaseFiles());
        secret = global.MemoCrypto.toBase64(global.MemoCrypto.randomKey());
        await storeNewSecret(secret);
      }
      Store._schema = schema;
      try {
        main = await new Connection(name).open(schema);
      } catch (openError) {
        // SQLCipher reports a wrong key as "not a database": the data is
        // there but this phone holds another key. Treat it like a restored
        // phone, so a recovery password can still open it.
        if (hasDb && /not a database|file is encrypted|code 26/i.test(String(openError && openError.message || openError))) {
          main = null;
          state = 'locked';
          return { state: state, reason: 'key', hasRecovery: !!(await readText(RECOVERY_FILE)) };
        }
        throw openError;
      }
      if (hasDb) secret = await main.meta('db_secret');
      else {
        // A new main database under a stored key: learn the key from a
        // safety copy when one exists, so a recovery password still works.
        if (!secret) secret = await secretFromCopies(schema);
        if (secret) await main.run(Store.secretStatements());
      }
      state = 'ready';
      return { state: state, created: !hasDb };
    },

    // Locked phone: unlock with the recovery password.
    unlockWithRecoveryPassword: async function (password, schema) {
      var sealed = await readText(RECOVERY_FILE);
      if (!sealed) throw new Error('No recovery password was set on the phone this data came from.');
      var bytes = await global.MemoCrypto.decryptWithPassword(global.MemoCrypto.fromBase64(sealed), password);
      // A key that opens nothing here (the locked case) is replaced.
      if (await secretStored()) { try { await plugin().clearEncryptionSecret(); } catch (_e) {} }
      await storeNewSecret(new TextDecoder().decode(bytes));
      state = 'closed';
      return Store.open(schema);
    },
    // Locked or damaged: keep the old database where it is, start a new one.
    startFresh: async function (schema) {
      if (main) { await main.close(); main = null; }
      var previous = (await pointer()).name;
      var folder = await setAside(await databaseFiles());
      try { await plugin().clearEncryptionSecret(); } catch (_e) {}
      await writeText(POINTER_FILE, JSON.stringify({ name: DEFAULT_NAME, previous: previous, setAside: folder, since: new Date().toISOString() }));
      state = 'closed';
      return Store.open(schema);
    },
    // A database replaced after damage keeps its name list in the pointer
    // file so nothing is deleted.
    replaceMainName: async function (schema) {
      var previous = (await pointer()).name;
      var name = DEFAULT_NAME + '-' + Date.now();
      await writeText(POINTER_FILE, JSON.stringify({ name: name, previous: previous, since: new Date().toISOString() }));
      if (main) { await main.close(); }
      main = await new Connection(name).open(schema);
      if (secret) await main.run(Store.secretStatements());
      state = 'ready';
      return main;
    },
    // The passphrase travels inside each safety copy (sealed by itself), so
    // a database rebuilt from a copy can still get a recovery password.
    secretStatements: function () {
      return secret ? [{ statement: 'INSERT OR REPLACE INTO native_meta (key,value) VALUES (?,?)', values: ['db_secret', secret] }] : [];
    },
    adoptSecretFrom: async function (conn) {
      if (!secret) secret = await conn.meta('db_secret');
    },

    hasRecoveryPassword: async function () { return !!(await readText(RECOVERY_FILE)); },
    setRecoveryPassword: async function (password) {
      if (state !== 'ready' || !secret) throw new Error('The phone database is not open.');
      var sealed = await global.MemoCrypto.encryptWithPassword(new TextEncoder().encode(secret), password);
      await writeText(RECOVERY_FILE, global.MemoCrypto.toBase64(sealed));
    },

    // Last-known-good copies: separate databases under the same key.
    openCopy: async function (name, schema) { return new Connection(name).open(schema); },
    copyExists: function (name) { return exists(name); },
    exists: exists,
    Connection: Connection
  };

  global.MemoNativeStore = Store;
})(window);
