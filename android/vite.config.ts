import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Build static site from src/ into dist/ to match capacitor.config.json webDir
export default defineConfig({
  // Treat src/ as the dev root so HTML entrypoints are discovered automatically
  root: 'src',
  publicDir: false,
  plugins: [
    // Copy plain static resources without bundling
    viteStaticCopy({
      targets: [
        { src: 'static', dest: '' },
        { src: 'assets', dest: '' },
        { src: 'finance.html', dest: '' },
        { src: 'manifest.json', dest: '' },
      ],
    }),
  ],
  build: {
    // Emit to dist/ at the project root
    outDir: '../dist',
    emptyOutDir: true,
    minify: false,
  },
});
