// Syncs the shared UniversalReader module from the sibling ../reader repo into
// src/static/reader/ (same pattern as ImageDB's build_tools/sync-reader.js).
// The synced copy is committed, so builds still work without the sibling repo.
// `npm run sync-reader` performs the explicit update; normal builds only verify
// that an available sibling source matches, keeping build/test side-effect free.
const fs = require('fs');
const path = require('path');

const readerSrc = path.join(__dirname, '..', '..', 'reader', 'src');
const dest = path.join(__dirname, '..', 'src', 'static', 'reader');

function syncReader({ check = false } = {}) {
  if (!fs.existsSync(readerSrc)) {
    console.warn(`⚠ reader source not found at ${readerSrc} — keeping the committed copy in src/static/reader/`);
    return;
  }

  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['reader.js', 'reader.css']) {
    const from = path.join(readerSrc, file);
    const to = path.join(dest, file);
    if (!fs.existsSync(from)) throw new Error(`Missing shared reader source: ${from}`);
    if (check) {
      const matches = fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to));
      if (!matches) {
        throw new Error(`Reader source is out of sync: ${file}. Run "npm run sync-reader" explicitly.`);
      }
      console.log(`✓ verified reader/${file}`);
    } else {
      fs.copyFileSync(from, to);
      console.log(`✓ synced reader/${file}`);
    }
  }
}

module.exports = {
  syncReader,
  checkReader() { syncReader({ check: true }); },
};

if (require.main === module) syncReader();
