'use strict';
// Regenerate the .svg-icon-* mask rules in src/static/css/memo.css from the shared
// icon library (../assets), inlining each SVG as a base64 data: URI so masks paint
// under any origin (file:// / Capacitor, not just http). The library is the
// single tracked copy; memoSystem keeps no SVG files of its own.
//
//   edit  build_tools/icon-manifest.json   (icon-name -> shared/pack/file.svg)
//   run   node build_tools/gen-icons.js
//
const fs = require('fs');
const path = require('path');

const manifest = require('./icon-manifest.json');
const SHARED = path.resolve(__dirname, '../../assets');            // Apps/assets
const CSS = path.resolve(__dirname, '../src/static/css/memo.css');
const START = '/* ICONS:GENERATED-START';
const END = '/* ICONS:GENERATED-END */';

const rules = [];
for (const name of Object.keys(manifest)) {
  const b64 = fs.readFileSync(path.join(SHARED, manifest[name])).toString('base64');
  const uri = `url("data:image/svg+xml;base64,${b64}")`;
  rules.push(`.svg-icon-${name} { -webkit-mask-image: ${uri}; mask-image: ${uri}; }`);
}

const lines = fs.readFileSync(CSS, 'utf8').split(/\r?\n/);
const s = lines.findIndex(l => l.includes(START));
const e = lines.findIndex(l => l.includes(END));
if (s === -1 || e === -1 || e < s) throw new Error('gen-icons: ICONS:GENERATED markers not found in memo.css');
const out = [...lines.slice(0, s + 1), ...rules, ...lines.slice(e)];
fs.writeFileSync(CSS, out.join('\n'), 'utf8');
console.log(`gen-icons: wrote ${rules.length} .svg-icon rules into src/static/css/memo.css from ../assets`);
