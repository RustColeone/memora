// Compare the bundle to both generated web assets and Capacitor's synced copy.
// Signature/manifest validation remains a separate jarsigner/bundletool check.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// R8 once deleted @CapacitorPlugin's permissions member in ImageDB, so every
// permission check crashed only the release build. Check the shrunk dex
// itself: plugins that declare permissions must still carry them.
const PLUGINS_WITH_PERMISSIONS = ['PlannerReminders', 'Camera', 'Filesystem'];
function dexdumpPath() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk');
  const toolsDir = path.join(sdk, 'build-tools');
  const versions = fs.existsSync(toolsDir) ? fs.readdirSync(toolsDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  for (const version of versions.reverse()) {
    for (const name of ['dexdump.exe', 'dexdump']) {
      const candidate = path.join(toolsDir, version, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('dexdump not found in Android SDK build-tools');
}
async function checkPluginPermissions(zip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-dex-'));
  let text = '';
  try {
    for (const name of Object.keys(zip.files).filter(entry => /^base\/dex\/.+\.dex$/.test(entry))) {
      const file = path.join(dir, path.basename(name));
      fs.writeFileSync(file, await zip.file(name).async('nodebuffer'));
      text += execFileSync(dexdumpPath(), ['-a', file], { encoding: 'utf8', maxBuffer: 1 << 30 });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  for (const name of PLUGINS_WITH_PERMISSIONS) {
    const line = text.split('\n').find(row => row.includes(`; name="${name}"`) && row.includes('VISIBILITY_RUNTIME'));
    assert.ok(line, 'Plugin annotation missing from release dex: ' + name);
    assert.ok(line.includes('permissions={'), `R8 stripped the permissions of plugin ${name}; permission checks would crash`);
  }
  return PLUGINS_WITH_PERMISSIONS;
}
const root = path.resolve(__dirname, '..');
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => entry.isDirectory()
    ? walk(path.join(dir, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
}
(async () => {
  const bundle = path.resolve(process.argv[2] || path.join(root, 'android/app/build/outputs/bundle/release/app-release.aab'));
  const bytes = fs.readFileSync(bundle);
  const zip = await JSZip.loadAsync(bytes, {checkCRC32:true});
  const config = JSON.parse(await zip.file('base/assets/capacitor.config.json').async('string'));
  assert.deepEqual(config, JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8')), 'Stale Capacitor config');
  assert.equal(config.android.minWebViewVersion, 85);
  assert.equal(config.server.errorPath, 'static/webview-update.html');
  assert.ok(!config.server.url, 'Release must start from packaged assets');
  const www = path.join(root, 'www');
  const synced = path.join(root, 'android/app/src/main/assets/public');
  const prefix = 'base/assets/public/';
  for (const name of walk(www)) assert.ok(zip.file(prefix + name), 'Missing bundled web asset: ' + name);
  let matched = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!name.startsWith(prefix) || entry.dir) continue;
    const relative = name.slice(prefix.length);
    const local = path.resolve(['cordova.js', 'cordova_plugins.js'].includes(relative) ? synced : www, relative);
    assert.ok(local.startsWith(root + path.sep));
    assert.ok(fs.existsSync(local), 'Unexpected packaged asset: ' + relative);
    const content = await entry.async('nodebuffer');
    assert.ok(content.equals(fs.readFileSync(local)), 'Stale bundled asset: ' + relative);
    assert.ok(content.equals(fs.readFileSync(path.join(synced, relative))), 'Stale synced asset: ' + relative);
    assert.ok(!/\.(db|sqlite|jks|keystore)$|key\.properties/i.test(relative), 'Private file bundled: ' + relative);
    matched++;
  }
  assert.ok((await zip.file('base/assets/native-start.html').async('nodebuffer')).equals(
    fs.readFileSync(path.join(root, 'android/app/src/main/assets/native-start.html'))), 'Stale native preparation page');
  const pluginPermissionAnnotationsKept = await checkPluginPermissions(zip);
  console.log(JSON.stringify({bundle,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),matchedWebAssets:matched,zipCrcVerified:true,pluginPermissionAnnotationsKept}, null, 2));
})().catch(error => {console.error(error);process.exitCode = 1;});
