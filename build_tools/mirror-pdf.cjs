// Pin PDF.js's legacy build and lower its remaining class static block for
// WebView 85. Both files include the matching legacy API polyfills.
// node build_tools/mirror-pdf.cjs [directory with pdf-legacy*.mjs for offline use]
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const VERSION = '4.7.76';
const files = ['pdf.min.mjs', 'pdf.worker.min.mjs'];

async function main() {
  const results = await Promise.allSettled(files.map(async name => {
    const offlineName = name === 'pdf.min.mjs' ? 'pdf-legacy.min.mjs' : 'pdf-legacy.worker.min.mjs';
    let source;
    if (process.argv[2]) source = fs.readFileSync(path.resolve(process.argv[2], offlineName), 'utf8');
    else {
      const response = await fetch(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/legacy/build/${name}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      source = await response.text();
    }
    if (!source.startsWith('/**') || !source.includes('Copyright 2024 Mozilla Foundation')) throw new Error('Missing PDF.js license notice');
    const license = source.slice(0, source.indexOf('*/') + 2);
    const output = transformSync(source, { loader: 'js', target: 'chrome85', format: 'esm',
      minify: true, legalComments: 'inline', banner: license + `\n// Memora: PDF.js ${VERSION} legacy build, transformed for WebView 85. See build_tools/mirror-pdf.cjs.\n`
        + fs.readFileSync(path.join(__dirname, 'pdf-compat.js'), 'utf8') }).code;
    return { name, output };
  }));
  // Validate both downloads/transforms before replacing either pinned file.
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  for (const { value } of results) {
    fs.writeFileSync(path.resolve(__dirname, '../src/static/vendor', value.name), value.output);
    console.log(`[mirror-pdf] ${value.name}: ${Buffer.byteLength(value.output)} bytes, WebView 85`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
