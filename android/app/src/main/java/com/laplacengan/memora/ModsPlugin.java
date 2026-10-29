package com.laplacengan.memora;

import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * Lists the mods folder, Android/data/<app>/files/mods: a computer reaches it
 * over USB, and no storage permission is needed. memo-mods.js decides which
 * mods run and loads their files through Capacitor.convertFileSrc.
 */
@CapacitorPlugin(name = "Mods")
public class ModsPlugin extends Plugin {
    static final long MANIFEST_LIMIT = 65536;

    static String read(File file) throws IOException {   // (java.nio.file needs Android 8; minSdk is 7)
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    @PluginMethod public void list(PluginCall call) {
        File dir = getContext().getExternalFilesDir("mods");
        if (dir == null) dir = new File(getContext().getFilesDir(), "mods");   // no shared storage mounted
        if (!dir.isDirectory() && !dir.mkdirs()) { call.reject("Could not create the mods folder"); return; }
        JSArray mods = new JSArray();
        File[] folders = dir.listFiles(File::isDirectory);
        if (folders != null) {
            Arrays.sort(folders);
            for (File folder : folders) {
                if (folder.getName().startsWith(".")) continue;
                JSObject mod = new JSObject();
                mod.put("folder", folder.getName());
                mod.put("path", folder.getAbsolutePath());
                File manifest = new File(folder, "mod.json");
                try {
                    if (!manifest.isFile()) mod.put("error", "no mod.json in this folder");
                    else if (manifest.length() > MANIFEST_LIMIT) mod.put("error", "mod.json is larger than 64 KB");
                    else mod.put("manifest", read(manifest));
                } catch (Exception e) { mod.put("error", "mod.json: " + e.getMessage()); }
                mods.put(mod);
            }
        }
        JSObject result = new JSObject();
        result.put("dir", dir.getAbsolutePath());
        result.put("mods", mods);
        call.resolve(result);
    }
}
