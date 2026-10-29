# HTTP (Cleartext) Configuration Guide

This document explains the changes made to allow your app to connect to HTTP (non-HTTPS) servers.

## Why This Is Needed

By default, Android apps (API level 28+) block HTTP traffic for security. Since your self-hosted server uses HTTP, we need to explicitly allow cleartext traffic.

## Changes Made

### 1. AndroidManifest.xml
**File:** `android/app/src/main/AndroidManifest.xml`

Added two attributes to the `<application>` tag:
```xml
android:usesCleartextTraffic="true"
android:networkSecurityConfig="@xml/network_security_config"
```

### 2. Network Security Config
**File:** `android/app/src/main/res/xml/network_security_config.xml`

The security configuration:

- Allows HTTP transport so a user can select a server on their LAN
- Trusts system certificates
- Trusts user-installed certificates

### 3. Capacitor Config
**File:** `capacitor.config.json`

The app enables native HTTP transport without allowing remote pages to become app
content:

```json
{
  "server": {
    "androidScheme": "https",
    "cleartext": true
  },
  "plugins": {
    "CapacitorHttp": {
      "enabled": true
    }
  },
  "android": {
    "allowMixedContent": false
  }
}
```

`CapacitorHttp` patches the Android app's `fetch` and `XMLHttpRequest` calls so
API traffic uses the native network stack. The self-hosted server URL therefore
does not need to be added to WebView navigation. Remote pages remain outside the
trusted Capacitor origin, and the WebView does not need mixed-content mode.

WebView debugging is not forced in Capacitor configuration. Capacitor follows the
Android build's debuggable flag: debug builds can be inspected, while the release
build explicitly sets `debuggable false`.

## Security Considerations

### Current Setup (Allows All HTTP)
The current Android network policy permits cleartext connections because the
self-hosted endpoint is selected at runtime and may be any LAN address. Only enter
a server URL you control, and use this mode on a trusted network. HTTP has no
transport encryption; another device on the network may observe or modify traffic.

This transport permission is separate from WebView navigation. It does not allow
an HTTP server to replace the bundled app page or gain Capacitor bridge access.

### More Secure Alternative (Recommended for Production)

If you know your server's IP/domain, you can restrict HTTP access to only that server:

**Edit:** `android/app/src/main/res/xml/network_security_config.xml`

Replace the `<base-config>` section with:

```xml
<base-config cleartextTrafficPermitted="false">
    <trust-anchors>
        <certificates src="system" />
    </trust-anchors>
</base-config>

<domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">192.168.1.100</domain>  <!-- Your server IP -->
    <domain includeSubdomains="true">localhost</domain>
    <domain includeSubdomains="true">10.0.2.2</domain>       <!-- Android emulator -->
</domain-config>
```

Replace `192.168.1.100` with your actual server IP or domain.

## After Making Changes

If you modify the network security config, rebuild the app:

```powershell
# Sync changes to Android
npx cap sync android

# Then rebuild in Android Studio
```

Or run the project helper:
```powershell
.\build_tools\sync-app.bat
```

Then rebuild in Android Studio.

## Testing

### Test Your HTTP Connection:

1. Make sure your server is running (e.g., `http://192.168.1.100:5050`)
2. In the app's settings, set the server URL
3. Try to sync data
4. Check Android Studio's Logcat for any network errors

### Common Server URLs:

- **Local network:** `http://192.168.1.100:5050`
- **Localhost (emulator):** `http://10.0.2.2:5050`
- **Localhost (physical device via adb):** `http://localhost:5050`

## Notes

- These changes only affect the Android app
- For iOS, you would need to configure `App Transport Security` in `Info.plist`
- Always use HTTPS in production if possible
- HTTP traffic can be intercepted on public networks

## Troubleshooting

### Still getting connection errors?

1. **Check the server URL format:**
   - Include `http://` prefix
   - Include port if not 80
   - Example: `http://192.168.1.100:5050`

2. **Verify network connectivity:**
   - Can you access the URL in a browser?
   - Are you on the same network?

3. **Check Logcat in Android Studio:**
   - Look for `ERR_CLEARTEXT_NOT_PERMITTED` errors
   - Look for network timeout errors

4. **Rebuild the app:**
   ```powershell
   .\build_tools\sync-app.bat
   ```
   Then clean and rebuild in Android Studio

5. **For emulator, use special IP:**
   - `10.0.2.2` maps to your computer's localhost
   - Example: `http://10.0.2.2:5050`

The Android app remains able to connect to HTTP self-hosted servers without
granting those servers WebView navigation access.
