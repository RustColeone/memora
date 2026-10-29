/**
 * Builds www/ from the web source (src/) for the Capacitor client, and keeps the
 * app version in sync from a single source of truth: package.json.
 *
 * src/ is the single source of truth (the Flask server serves the same files):
 * HTML pages at src/ root, shared-chrome includes in src/partials/, assets under
 * src/static/{css,js,vendor}. www/ is a generated build artifact consumed by
 * Capacitor (webDir = "www") and is gitignored — never edit www/ by hand.
 *
 * Version sync (mirrors mind_games/scripts/prepare-web.js):
 *   - package.json "version" (e.g. "1.0.0") is the ONLY place you edit.
 *   - versionCode = major*10000 + minor*100 + patch (e.g. 1.0.0 -> 10000).
 *   - android/app/build.gradle versionCode/versionName are rewritten automatically.
 *   - {{APP_VERSION}} placeholders in the HTML are stamped while copying to www/.
 *     (The Flask server fills the same placeholder via a Jinja context processor.)
 *
 * Live user data (data/, uploads/) is intentionally NOT bundled: the mobile client
 * talks to the self-hosted server for that.
 */
const fs = require('fs-extra');
const path = require('path');
const esbuild = require('esbuild');

// The shared reader is updated only through `npm run sync-reader`; normal builds
// verify synchronization so testing never rewrites tracked source as a side effect.
require('./sync-reader').checkReader();

const ROOT = path.join(__dirname, '..');
// Frontend source lives in src/: the HTML pages sit at src/ root (like www/), with
// assets under src/static/{css,js,vendor} and shared-chrome includes in src/partials/.
const SRC_DIR = path.join(ROOT, 'src');
const TEMPLATES_DIR = SRC_DIR;                 // render root: pages + partials/ resolve here
const STATIC_DIR = path.join(SRC_DIR, 'static');
const WWW_DIR = path.join(ROOT, 'www');

// --- Single source of truth: version from package.json ---
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version; // e.g. "1.0.0"
const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
const versionCode = major * 10000 + minor * 100 + patch; // e.g. 10000

// Matches {{APP_VERSION}} and {{ APP_VERSION }} (Jinja-style spacing tolerated).
const APP_VERSION_RE = /\{\{\s*APP_VERSION\s*\}\}/g;

// Resolve the small subset of Jinja we use for shared chrome, so the static www/
// build is self-contained. The Flask server renders the very same templates
// natively (render_template), so this only needs to mirror Jinja's behaviour for:
//   {% set NAME = 'literal' %}         page-level string vars
//   {% include 'partials/x.html' %}    inlined (recursively), shares page vars
//   {{ NAME }}                         substituted from vars (incl. APP_VERSION)
// Partials live in templates/partials/ and are never emitted as their own pages.
function expandTemplate(html, vars) {
  // Block form: {% set X %}...multi-line HTML...{% endset %} (a variant "slot").
  // Stored raw; emit it with {{ X | safe }} (on the server it's Markup, so also
  // raw). Note: {{ }} inside a block body is not re-resolved — keep slots plain.
  html = html.replace(/\{%\s*set\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endset\s*%\}/g, (_m, k, body) => { vars[k] = body; return ''; });
  // Inline form: {% set X = '...' %}.
  html = html.replace(/\{%\s*set\s+(\w+)\s*=\s*'([^']*)'\s*%\}/g, (_m, k, v) => { vars[k] = v; return ''; });
  // Inline {% include 'partials/..' %} recursively (partials may set/include too).
  html = html.replace(/\{%\s*include\s+'([^']+)'\s*%\}/g, (_m, rel) => {
    const inc = fs.readFileSync(path.join(TEMPLATES_DIR, rel), 'utf8');
    return expandTemplate(inc, vars);
  });
  return html;
}
// Replace {{ NAME }} and {{ NAME | safe }} once every include has been inlined.
// Mirrors Flask/Jinja autoescape so both render paths agree: {{ NAME }} is
// HTML-escaped, {{ NAME | safe }} is emitted raw (for variant HTML slots).
// Unknown names are left as-is so a stray placeholder is visible, not blanked.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function substituteVars(html, vars) {
  return html.replace(/\{\{\s*(\w+)\s*(\|\s*safe\s*)?\}\}/g, (m, k, safe) => {
    if (!(k in vars)) return m;
    return safe ? vars[k] : escapeHtml(vars[k]);
  });
}

function syncAndroidVersion() {
  const gradlePath = path.join(ROOT, 'android', 'app', 'build.gradle');
  if (!fs.existsSync(gradlePath)) {
    console.warn('⚠ android/app/build.gradle not found — skipping Android version sync');
    return;
  }
  const original = fs.readFileSync(gradlePath, 'utf8');
  const updated = original
    .replace(/(\bversionCode\s+)\d+/, `$1${versionCode}`)
    .replace(/(\bversionName\s+")[^"]*"/, `$1${version}"`);
  if (updated !== original) fs.writeFileSync(gradlePath, updated, 'utf8');
  console.log(`✓ Android version synced → versionCode ${versionCode}, versionName "${version}"`);
}

// App-shell precache list (root-relative URLs): the pages + every js/css/icon +
// the boot-critical sql-wasm vendor files. Lazy vendor (pdf/gifenc) is left to
// runtime caching. `root` is the built www/ (or src/) directory.
function swPrecacheList(root) {
  const urls = ['/index.html', '/finance.html', '/planner.html', '/manifest.webmanifest'];
  const walk = (relDir) => {
    const abs = path.join(root, 'static', relDir.replace(/\//g, path.sep));
    if (!fs.existsSync(abs)) return;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = relDir + '/' + ent.name;
      if (ent.isDirectory()) walk(rel);
      else urls.push('/static/' + rel);
    }
  };
  ['js', 'css', 'icons', 'reader'].forEach(walk);
  // jspdf is precached (not left lazy) so detailed PDF export works fully offline.
  ['sql-wasm.js', 'sql-wasm.wasm', 'jszip.min.js', 'jspdf.umd.min.js'].forEach((v) => {
    if (fs.existsSync(path.join(root, 'static', 'vendor', v))) urls.push('/static/vendor/' + v);
  });
  return urls;
}

// The UI is intentionally no-bundler, but gifuct-js is distributed as CommonJS.
// Build its tiny browser global once into src/static/vendor so the GIF editor is
// offline-capable and never reaches for a CDN at runtime.
async function bundleGifDecoder() {
  const entryPoint = path.join(ROOT, 'node_modules', 'gifuct-js', 'lib', 'index.js');
  const outFile = path.join(STATIC_DIR, 'vendor', 'gifuct.js');
  if (!fs.existsSync(entryPoint)) {
    throw new Error('gifuct-js is missing. Run npm install before building.');
  }
  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'iife',
    globalName: 'MemoGifDecoder',
    platform: 'browser',
    target: 'es2018',
    legalComments: 'inline',
    banner: { js: '/*! gifuct-js 2.1.2 — MIT, Copyright (c) 2015 Matt Way. See gifuct.LICENSE. */' },
    outfile: outFile,
    logLevel: 'silent',
  });
  console.log('✓ Bundled vendored GIF decoder');
}

// Claude calls go through the official Anthropic SDK. It ships as ESM for
// bundlers, so build one browser global, loaded only on the first Claude request.
async function bundleAnthropicSdk() {
  const pkg = path.join(ROOT, 'node_modules', '@anthropic-ai', 'sdk');
  if (!fs.existsSync(pkg)) throw new Error('@anthropic-ai/sdk is missing. Run npm install before building.');
  const sdkVersion = require(path.join(pkg, 'package.json')).version;
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'anthropic-sdk-entry.js')],
    bundle: true,
    format: 'iife',
    globalName: 'MemoAnthropicSdk',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    banner: { js: `/*! @anthropic-ai/sdk ${sdkVersion} — MIT, Copyright (c) Anthropic, PBC. See anthropic-sdk.LICENSE. */` },
    outfile: path.join(STATIC_DIR, 'vendor', 'anthropic-sdk.js'),
    logLevel: 'silent',
  });
  fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(STATIC_DIR, 'vendor', 'anthropic-sdk.LICENSE'));
  console.log('✓ Bundled the Anthropic SDK ' + sdkVersion);
}

async function build() {
  console.log(`🔨 Building www/ from src/ (v${version})...`);
  try {
    syncAndroidVersion();
    await bundleGifDecoder();
    await bundleAnthropicSdk();

    // Fresh www/ each build so deleted/renamed files don't linger.
    await fs.emptyDir(WWW_DIR);
    console.log('✓ Cleaned www/');

    // Copy each top-level template to www/ root, resolving shared-chrome includes
    // and stamping variables. (Files under templates/partials/ are not pages.)
    const templates = (await fs.readdir(TEMPLATES_DIR)).filter((f) => f.endsWith('.html'));
    for (const file of templates) {
      const vars = { APP_VERSION: version };
      let html = await fs.readFile(path.join(TEMPLATES_DIR, file), 'utf8');
      html = expandTemplate(html, vars);         // inline partials + collect {% set %}
      html = substituteVars(html, vars);         // {{ NAME }} incl. APP_VERSION
      html = html.replace(APP_VERSION_RE, version); // belt-and-suspenders for {{APP_VERSION}}
      await fs.writeFile(path.join(WWW_DIR, file), html, 'utf8');
      console.log(`✓ Stamped + copied ${file}`);
    }

    // Copy the entire static/ folder verbatim.
    await fs.copy(STATIC_DIR, path.join(WWW_DIR, 'static'));
    console.log('✓ Copied static/');

    // PWA: stamp the service worker with a unique build id (a new build busts its
    // cache) + the app-shell precache list, and copy it + the manifest to the www/
    // root. (Flask serves the src/ originals via its own routes; this covers the
    // Capacitor build + test server.)
    const buildId = `${version}-${Date.now().toString(36)}`;
    const precache = swPrecacheList(WWW_DIR);
    let sw = await fs.readFile(path.join(SRC_DIR, 'sw.js'), 'utf8');
    sw = sw.replace(/\{\{\s*BUILD_VERSION\s*\}\}/g, buildId)
           .replace(/\{\{\s*PRECACHE_LIST\s*\}\}/g, precache.map((u) => JSON.stringify(u)).join(','));
    await fs.writeFile(path.join(WWW_DIR, 'sw.js'), sw, 'utf8');
    await fs.copy(path.join(SRC_DIR, 'manifest.webmanifest'), path.join(WWW_DIR, 'manifest.webmanifest'));
    console.log(`✓ Stamped service worker (build ${buildId}, ${precache.length} precached) + copied manifest`);

    // Local-storage structure expected by the client.
    await fs.ensureDir(path.join(WWW_DIR, 'data'));

    console.log('✅ Build complete. Run "npm run cap:sync" to sync native platforms.');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

build();
