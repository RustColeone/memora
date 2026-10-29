'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const initSqlJsModule = require('sql.js');

function notFound(name) {
  const error = new Error(`${name} not found`);
  error.name = 'NotFoundError';
  return error;
}

function makeOpfs() {
  const files = new Map();
  const failWrites = new Set();
  const root = {
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) throw notFound(name);
      if (!files.has(name)) files.set(name, new Uint8Array());
      return {
        async getFile() { return new Blob([files.get(name)]); },
        async createWritable() {
          let staged = null;
          return {
            async write(value) {
              const view = value instanceof Uint8Array
                ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                : new Uint8Array(value);
              staged = new Uint8Array(view);
            },
            async close() {
              if (failWrites.has(name)) throw new Error(`Injected write failure for ${name}`);
              if (!staged) throw new Error('No staged bytes');
              files.set(name, staged);
            },
          };
        },
      };
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw notFound(name);
    },
  };
  return { failWrites, files, root };
}

function makeLocalStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function createHarness(SQL) {
  const opfs = makeOpfs();
  const events = [];
  const windowObject = {
    __MEMO_STATE_DB_TEST__: true,
    Capacitor: null,
    addEventListener() {},
    dispatchEvent(event) { events.push(event); },
  };
  const context = vm.createContext({
    ArrayBuffer,
    Blob,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    Date,
    Error,
    FileReader: class {},
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    TypeError,
    Uint8Array,
    atob,
    btoa,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      getElementsByTagName() { return []; },
    },
    initSqlJs: async () => SQL,
    indexedDB: {},
    localStorage: makeLocalStorage(),
    navigator: { storage: { getDirectory: async () => opfs.root } },
    setTimeout,
    window: windowObject,
  });
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'static', 'js', 'memo', 'memo-state-db.js'),
    'utf8'
  );
  vm.runInContext(source, context, { filename: 'memo-state-db.js' });
  return { ...opfs, context, events, api: windowObject.MemoStateDb };
}

function sqliteScalar(database, sql) {
  return database.exec(sql)[0].values[0][0];
}

(async () => {
  const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const SQL = await initSqlJsModule({ locateFile: () => wasmPath });

  const migration = createHarness(SQL);
  migration.api.__test.setSql(SQL);
  const legacy = new SQL.Database();
  legacy.run(`
    CREATE TABLE finance_entries (
      id TEXT PRIMARY KEY, description TEXT, category TEXT, tags TEXT,
      images TEXT, attachments TEXT, purchase_date TEXT, price REAL,
      tax REAL, adjustment REAL, total REAL, items TEXT,
      created_at INTEGER, updated_at INTEGER, deleted INTEGER, deleted_at INTEGER
    );
  `);
  assert.equal(migration.api.__test.migrateSqliteSchema(legacy), true);
  assert.equal(sqliteScalar(legacy, 'PRAGMA user_version'), 4);
  const financeColumns = legacy.exec('PRAGMA table_info(finance_entries)')[0].values.map(row => row[1]);
  assert.ok(financeColumns.includes('sheet'), 'legacy finance databases gain the sheet column');
  assert.ok(financeColumns.includes('image_meta'), 'legacy finance databases gain per-image metadata');
  assert.ok(financeColumns.includes('details'), 'legacy finance databases gain the store / payment / notes column');
  const memoColumns = legacy.exec('PRAGMA table_info(memos)')[0].values.map(row => row[1]);
  assert.ok(memoColumns.includes('image_meta'), 'legacy memo databases gain per-image metadata');
  assert.ok(legacy.exec("SELECT name FROM sqlite_master WHERE name='doc_entries'").length,
    'the document-variant table is created');

  // A damaged JSON field belongs to one row and one field. It must not hide
  // otherwise-readable rows or make an empty-looking database appear healthy.
  legacy.run(
    `INSERT INTO memos
      (id, description, category, tags, images, attachments, image_meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'good-memo', 'Readable memo', 'Safe', '["safe"]',
      '["/uploads/safe.png"]',
      '[{"name":"safe.pdf","url":"/uploads/safe.pdf","type":"application/pdf"}]',
      '{"uploads/safe.png":{"embeddedBackup":"ZXhpZg=="}}',
      1, 1
    ]
  );
  legacy.run(
    `INSERT INTO memos
      (id, description, category, tags, images, attachments, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['bad-tags', 'Bad tags', 'Safe', '{broken', '[]', '[]', 2, 2]
  );
  legacy.run(
    `INSERT INTO memos
      (id, description, category, tags, images, attachments, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['bad-images', 'Bad images', 'Safe', '[]', '{broken', '[]', 3, 3]
  );
  legacy.run(
    `INSERT INTO memos
      (id, description, category, tags, images, attachments, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['bad-attachments', 'Bad attachments', 'Safe', '[]', '[]', '{broken', 4, 4]
  );
  legacy.run(
    `INSERT INTO memos
      (id, description, category, tags, images, attachments, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'legacy-mixed-paths', 'Legacy mixed paths', 'Safe', '[]',
      '["/uploads/photo.png","/uploads/document.pdf"]',
      '[{"name":"document.pdf","url":"/uploads/document.pdf","storedPath":"uploads/document.pdf","type":"application/pdf"}]',
      5, 5
    ]
  );
  legacy.run(
    `INSERT INTO finance_entries
      (id, description, category, tags, images, attachments, items, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'good-finance', 'Readable finance entry', 'Safe', '["receipt"]', '[]', '[]',
      '[{"name":"Safe item","amount":1,"unitPrice":12,"totalPrice":12}]', 5, 5
    ]
  );
  legacy.run(
    `INSERT INTO finance_entries
      (id, description, category, tags, images, attachments, items, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['bad-items', 'Bad finance items', 'Safe', '[]', '[]', '[]', '{broken', 6, 6]
  );

  migration.api.__test.setDb(legacy);
  const loadedMemos = migration.api.loadEntries('default');
  const loadedFinance = migration.api.loadEntries('finance');
  assert.equal(loadedMemos.length, 5, 'malformed fields must not hide valid or sibling memo rows');
  assert.equal(loadedFinance.length, 2, 'malformed finance items must not hide finance rows');

  const goodMemo = loadedMemos.find(entry => entry.id === 'good-memo');
  assert.equal(goodMemo.description, 'Readable memo');
  assert.deepEqual(Array.from(goodMemo.tags), ['safe']);
  assert.deepEqual(Array.from(goodMemo.images), ['/uploads/safe.png']);
  assert.equal(goodMemo.attachments[0].name, 'safe.pdf');
  assert.equal(goodMemo.imageMeta['uploads/safe.png'].embeddedBackup, 'ZXhpZg==');
  assert.deepEqual(Array.from(loadedMemos.find(entry => entry.id === 'bad-tags').tags), []);
  assert.deepEqual(Array.from(loadedMemos.find(entry => entry.id === 'bad-images').images), []);
  assert.deepEqual(Array.from(loadedMemos.find(entry => entry.id === 'bad-images')._storedPaths), []);
  assert.deepEqual(Array.from(loadedMemos.find(entry => entry.id === 'bad-attachments').attachments), []);
  const repairedMixed = loadedMemos.find(entry => entry.id === 'legacy-mixed-paths');
  assert.deepEqual(Array.from(repairedMixed.images), ['/uploads/photo.png'],
    'a legacy attachment path must not reload as an image');
  assert.deepEqual(Array.from(repairedMixed._storedPaths), ['uploads/photo.png'],
    'legacy image ownership remains aligned after attachment-path repair');
  assert.equal(repairedMixed.attachments[0].storedPath, 'uploads/document.pdf');

  const goodFinance = loadedFinance.find(entry => entry.id === 'good-finance');
  assert.equal(goodFinance.items.length, 1);
  assert.equal(goodFinance.items[0].name, 'Safe item');
  assert.equal(loadedFinance.find(entry => entry.id === 'bad-items').items, null);

  const malformedHealth = migration.api.getMetadataHealth();
  assert.equal(malformedHealth.status, 'degraded', 'malformed row fields must degrade metadata health');
  assert.ok(Array.isArray(malformedHealth.quarantinedRows), 'metadata health exposes quarantined rows');
  assert.deepEqual(
    Array.from(malformedHealth.quarantinedRows, row => `${row.rowId}:${row.field}`).sort(),
    ['bad-attachments:attachments', 'bad-images:images', 'bad-items:items', 'bad-tags:tags'],
    'each malformed field is attributed to its source row'
  );

  const atomic = createHarness(SQL);
  atomic.api.__test.setSql(SQL);
  const atomicDb = new SQL.Database();
  atomic.api.__test.migrateSqliteSchema(atomicDb);
  atomic.api.__test.setDb(atomicDb);
  atomic.api.importBundle({
    version: 1,
    memos: [{ id: 'old-memo', description: 'keep memo', tags: [], images: [], attachments: [], ts: 1 }],
    finance: [{ id: 'old-finance', description: 'keep finance', tags: [], images: [], attachments: [], ts: 1 }],
    planner: [{ id: 'old-planner', kind: 'todo', title: 'keep planner', updatedAt: '2025-01-01T00:00:00Z' }],
  }, 'replace');
  atomic.api.setItem('atomic-setting', { keep: true });
  const circularTags = [];
  circularTags.push(circularTags);
  assert.throws(() => atomic.api.importBundle({
    version: 1,
    memos: [{ id: 'new-memo', description: 'partial insert', tags: [], images: [], attachments: [], ts: 2 }],
    finance: [{ id: 'new-finance', description: 'throws', tags: circularTags, images: [], attachments: [], ts: 2 }],
    planner: [{ id: 'new-planner', kind: 'todo', title: 'must not land', updatedAt: '2025-02-01T00:00:00Z' }],
  }, 'replace'), /circular/i);
  assert.deepEqual(Array.from(atomic.api.loadEntries('default'), row => row.id), ['old-memo'],
    'a failed cross-variant replace restores memo rows');
  assert.deepEqual(Array.from(atomic.api.loadEntries('finance'), row => row.id), ['old-finance'],
    'a failed cross-variant replace restores finance rows');
  assert.deepEqual(Array.from(atomic.api.loadDocs('planner'), row => row.id), ['old-planner'],
    'a failed cross-variant replace restores planner rows');
  assert.deepEqual(JSON.parse(JSON.stringify(atomic.api.getItem('atomic-setting'))), { keep: true },
    'unrelated settings survive a failed import transaction');

  const persistence = createHarness(SQL);
  persistence.api.__test.setSql(SQL);
  const first = new SQL.Database();
  persistence.api.__test.migrateSqliteSchema(first);
  first.run("INSERT INTO memos (id, description, created_at, updated_at) VALUES ('one', 'first', 1, 1)");
  await persistence.api.__test.persistSqliteSnapshot(first.export());

  const names = persistence.api.__test.constants;
  assert.ok(persistence.files.has(names.primary));
  assert.ok(persistence.files.has(names.backup), 'the first durable snapshot seeds a known-good backup');
  assert.ok(!persistence.files.has(names.temporary), 'the staged file is removed after promotion');

  first.run("INSERT INTO memos (id, description, created_at, updated_at) VALUES ('two', 'second', 2, 2)");
  await persistence.api.__test.persistSqliteSnapshot(first.export());
  const primaryDb = new SQL.Database(persistence.files.get(names.primary));
  const backupDb = new SQL.Database(persistence.files.get(names.backup));
  assert.equal(sqliteScalar(primaryDb, 'SELECT COUNT(*) FROM memos'), 2);
  assert.equal(sqliteScalar(backupDb, 'SELECT COUNT(*) FROM memos'), 1,
    'the backup remains the previous validated generation');
  primaryDb.close();
  backupDb.close();

  const recovery = createHarness(SQL);
  const recoveryNames = recovery.api.__test.constants;
  recovery.files.set(recoveryNames.primary, new Uint8Array([1, 2, 3, 4]));
  recovery.files.set(recoveryNames.backup, new Uint8Array(first.export()));
  await recovery.api.init();
  assert.equal(recovery.api.ready(), true);
  assert.equal(recovery.api.getMetadataHealth().recoveredFrom, recoveryNames.backup);
  const recoveredPrimary = new SQL.Database(recovery.files.get(recoveryNames.primary));
  assert.equal(sqliteScalar(recoveredPrimary, 'SELECT COUNT(*) FROM memos'), 2);
  recoveredPrimary.close();

  const failure = createHarness(SQL);
  failure.api.__test.setSql(SQL);
  failure.files.set(failure.api.__test.constants.primary, new Uint8Array(first.export()));
  failure.failWrites.add(failure.api.__test.constants.temporary);
  await assert.rejects(
    failure.api.__test.persistSqliteSnapshot(first.export()),
    /Injected write failure/
  );
  const stillValid = new SQL.Database(failure.files.get(failure.api.__test.constants.primary));
  assert.equal(sqliteScalar(stillValid, 'SELECT COUNT(*) FROM memos'), 2,
    'a failed staged write never replaces the live database');
  stillValid.close();

  legacy.close();
  atomicDb.close();
  first.close();
  console.log('MemoStateDb recovery checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
