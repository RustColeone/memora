#!/usr/bin/env node
// Package the sync server as memora-server.exe (PyInstaller, one folder).
//   npm run build:server        → dist-server/memora-server/memora-server(.exe)
// The desktop app ships that folder and starts the program when "Host sync for
// my other devices" is on; it also runs on its own as the open-source server.
// Heavy optional extras (EasyOCR / PyTorch / OpenCV) stay out: the server's
// OCR is best-effort and turns itself off without them.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const sep = process.platform === 'win32' ? ';' : ':';
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const dist = path.join(root, 'dist-server');

const args = [
  '-m', 'PyInstaller', path.join(root, 'backend', 'memora_server.py'),
  '--name', 'memora-server', '--onedir', '--noconfirm', '--clean', '--console',
  '--distpath', dist, '--workpath', path.join(root, 'build', 'pyinstaller'), '--specpath', path.join(root, 'build', 'pyinstaller'),
  '--paths', path.join(root, 'backend'),
  '--add-data', `${path.join(root, 'src')}${sep}src`,
  '--add-data', `${path.join(root, 'package.json')}${sep}.`,
  // Blueprints and services are imported by name from backend/.
  '--collect-submodules', 'api', '--collect-submodules', 'services',
];
for (const mod of ['torch', 'torchvision', 'easyocr', 'cv2', 'numpy', 'scipy', 'matplotlib', 'pandas', 'tkinter', 'IPython', 'pytest']) args.push('--exclude-module', mod);

console.log('Packaging memora-server with PyInstaller…');
const run = spawnSync(python, args, { cwd: root, stdio: 'inherit' });
if (run.status !== 0) process.exit(run.status || 1);
const exe = path.join(dist, 'memora-server', process.platform === 'win32' ? 'memora-server.exe' : 'memora-server');
if (!fs.existsSync(exe)) { console.error('Build finished but ' + exe + ' is missing'); process.exit(1); }
// The old Gemini library imports googleapiclient but never reads its 88 MB
// catalog of every Google API description; keep the code, drop the catalog.
fs.rmSync(path.join(dist, 'memora-server', '_internal', 'googleapiclient', 'discovery_cache', 'documents'), { recursive: true, force: true });
console.log('✅ ' + exe);
