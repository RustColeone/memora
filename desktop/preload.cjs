// What the Memora page may ask the desktop app for (main.cjs implements it).
// The page sees window.MemoDesktop; nothing else from Node or Electron.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, options) => ipcRenderer.invoke(channel, options);
const group = (prefix, names) => Object.fromEntries(names.map(name => [name, options => call(prefix + ':' + name, options)]));

contextBridge.exposeInMainWorld('MemoDesktop', {
  platform: process.platform,
  // The phone's CapacitorSQLite / Filesystem calls, so memo-native-store.js runs as is.
  sqlite: group('sqlite', ['isDatabase', 'getDatabaseList', 'setEncryptionSecret', 'isSecretStored', 'clearEncryptionSecret', 'createConnection', 'open', 'query',
    'executeSet', 'beginTransaction', 'commitTransaction', 'rollbackTransaction', 'close', 'closeConnection']),
  fs: group('fs', ['readFile', 'writeFile', 'mkdir', 'getUri', 'rename']),
  reminders: group('reminders', ['status', 'enable', 'settings', 'consumeOpen', 'replace']),
  server: group('server', ['status', 'start', 'stop', 'newPassword']),
  http: { request: options => call('http:request', options) },
  info: () => call('app:info'),
  openExternal: url => call('app:openExternal', url),
  on: (event, callback) => {
    const channel = { 'reminder-open': 'memora:reminder-open', 'server-stopped': 'memora:server-stopped' }[event];
    if (channel) ipcRenderer.on(channel, () => callback());
  }
});
