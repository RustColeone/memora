const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test.describe('Android WebView production boundary', () => {
  test('keeps arbitrary pages out of the WebView while retaining native LAN HTTP', () => {
    const config = JSON.parse(read('capacitor.config.json'));

    // A configured self-hosted endpoint is data/API traffic, not trusted app code.
    // CapacitorHttp carries those requests natively without expanding main-frame
    // navigation or enabling mixed content in the WebView.
    expect(config.server?.allowNavigation ?? []).not.toContain('*');
    expect(config.android?.allowMixedContent).toBe(false);
    expect(config.plugins?.CapacitorHttp?.enabled).toBe(true);

    // Leave this unset so Capacitor follows ApplicationInfo.FLAG_DEBUGGABLE:
    // inspectable debug builds, non-inspectable release builds.
    expect(config.android).not.toHaveProperty('webContentsDebuggingEnabled');

    // The native transport must still be able to reach a user-selected HTTP LAN
    // endpoint. These flags do not grant that endpoint WebView navigation access.
    expect(config.server?.cleartext).toBe(true);
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:usesCleartextTraffic="true"');
    expect(manifest).toContain('android:networkSecurityConfig="@xml/network_security_config"');
    expect(read('android/app/src/main/res/xml/network_security_config.xml'))
      .toContain('<base-config cleartextTrafficPermitted="true">');
  });

  test('release builds cannot opt back into WebView debugging', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toMatch(/release\s*\{[\s\S]*?debuggable\s+false/);

    const mainActivity = read(
      'android/app/src/main/java/com/laplacengan/memora/MainActivity.java',
    );
    expect(mainActivity).not.toContain('setWebContentsDebuggingEnabled(true)');
  });

  test('self-hosted HTTP documentation does not prescribe wildcard navigation', () => {
    const guide = read('HTTP-CONFIG-GUIDE.md');
    expect(guide).not.toMatch(/allowNavigation\s*:\s*\[\s*['"]\*['"]\s*\]/);
    expect(guide).toContain('CapacitorHttp');
    expect(guide).toMatch(/navigation/i);
  });
});
