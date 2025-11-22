# Fix Android Connection Issues

The error `Failed to fetch` when connecting to `http://10.0.0.139:5050` is caused by Android's security policy blocking **Cleartext (HTTP)** traffic by default.

Since I cannot see your `android/` folder in the workspace, you must apply these changes manually to your Android project location.

## Step 1: Allow Cleartext Traffic (Crucial)

Find your Android project folder (usually `android/` inside your project).

1. Open `android/app/src/main/AndroidManifest.xml`
2. Find the `<application>` tag.
3. Add `android:usesCleartextTraffic="true"` to it.

It should look like this:

```xml
<application
    android:allowBackup="true"
    android:icon="@mipmap/ic_launcher"
    android:label="@string/app_name"
    android:roundIcon="@mipmap/ic_launcher_round"
    android:supportsRtl="true"
    android:theme="@style/AppTheme"
    android:usesCleartextTraffic="true">  <!-- ADD THIS LINE -->
    
    <activity...>
    </activity>
</application>
```

**Without this line, Android will silently block all HTTP requests to your server.**

## Step 2: Update Capacitor Config

I have updated `capacitor.config.json` in your workspace to enable the **CapacitorHttp** plugin. This plugin patches `fetch()` to use native code, which helps bypass CORS issues.

## Step 3: Re-sync and Re-build

Run these commands in your terminal:

```powershell
# 1. Copy the new config and static files to the android project
npx cap sync android

# 2. Open Android Studio to build and run
npx cap open android
```

## Troubleshooting

If it still fails:
1. Ensure your phone/emulator is on the **same WiFi network** as your computer (`10.0.0.139`).
2. Ensure your Windows Firewall is allowing incoming connections to Python/Flask on port 5050.
   - Try accessing `http://10.0.0.139:5050` from the phone's Chrome browser. If that fails, it's a network/firewall issue, not an app issue.
