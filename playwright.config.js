// Playwright config — runs against the installed Microsoft Edge (no Chromium download).
const { defineConfig } = require('@playwright/test');

const PORT = 5099;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'msedge',
    headless: true,
    // Block the PWA service worker by default so it can't add cache-I/O latency to
    // the feature specs (localhost is a secure context, so it would otherwise
    // register). The dedicated pwa-sw spec opts back in with serviceWorkers:'allow'.
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'node tests/static-server.js',
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 20000,
  },
});
