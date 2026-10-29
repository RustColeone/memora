/**
 * Regenerate the Android launcher icons + PWA icons from the notebook artwork.
 *   node build_tools/gen-launcher.js
 * Source: src/static/icons/notebook.svg (a full-bleed rounded icon).
 * - Adaptive foreground: notebook padded into the safe zone (transparent bg).
 * - Legacy + round + PWA: the full notebook.
 * The adaptive background colour is set in res/values/ic_launcher_background.xml.
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'src/static/icons/notebook.svg'));
const RES = path.join(ROOT, 'android/app/src/main/res');

const FG = { 'mipmap-mdpi': 108, 'mipmap-hdpi': 162, 'mipmap-xhdpi': 216, 'mipmap-xxhdpi': 324, 'mipmap-xxxhdpi': 432 };
const LEGACY = { 'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

function svg() { return sharp(SVG, { density: 400 }); }

async function renderFull(size, out) {
  await svg().resize(size, size, { fit: 'contain', background: TRANSPARENT }).png().toFile(out);
}
async function renderForeground(size, out) {
  // Keep the notebook inside the adaptive safe zone (~72dp of the 108dp canvas).
  const inner = Math.round(size * 0.72);
  const left = Math.floor((size - inner) / 2);
  const top = left;
  const buf = await svg().resize(inner, inner, { fit: 'contain', background: TRANSPARENT }).png().toBuffer();
  await sharp(buf)
    .extend({ top: top, bottom: size - inner - top, left: left, right: size - inner - left, background: TRANSPARENT })
    .png().toFile(out);
}

(async () => {
  for (const dir of Object.keys(FG)) {
    await renderForeground(FG[dir], path.join(RES, dir, 'ic_launcher_foreground.png'));
    await renderFull(LEGACY[dir], path.join(RES, dir, 'ic_launcher.png'));
    await renderFull(LEGACY[dir], path.join(RES, dir, 'ic_launcher_round.png'));
  }
  await renderFull(192, path.join(ROOT, 'src/static/icons/icon-192.png'));
  await renderFull(512, path.join(ROOT, 'src/static/icons/icon-512.png'));
  await renderFull(180, path.join(ROOT, 'src/static/icons/apple-touch-icon.png'));
  console.log('gen-launcher: wrote adaptive foreground + legacy + round mipmaps and PWA icons from notebook.svg');
})().catch((e) => { console.error('gen-launcher failed:', e.message); process.exit(1); });
