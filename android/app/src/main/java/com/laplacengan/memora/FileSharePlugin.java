package com.laplacengan.memora;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;

/**
 * Hands exported files (password-protected backups or a database file) to
 * Android's share sheet, all in one share. The web layer first writes them
 * into the app's private cache under memora-out/ (Capacitor Filesystem, CACHE
 * directory); this plugin only ever shares files from that folder, through a
 * one-time read grant on FileProvider URIs. Nothing goes to shared storage.
 * Files older than an hour are cleared when the next share starts, so a slow
 * receiving app still has time to read the current ones.
 */
@CapacitorPlugin(name = "FileShare")
public class FileSharePlugin extends Plugin {

    private static final String OUT_DIR = "memora-out";
    private static final long KEEP_MS = 60L * 60 * 1000;

    @PluginMethod
    public void shareFiles(PluginCall call) {
        JSArray names = call.getArray("names");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String title = call.getString("title", "Share");
        File dir = new File(getContext().getCacheDir(), OUT_DIR);
        ArrayList<Uri> uris = new ArrayList<>();
        Set<File> keep = new HashSet<>();
        try {
            if (names == null || names.length() == 0) {
                call.reject("No files to share.");
                return;
            }
            String root = dir.getCanonicalPath() + File.separator;
            for (int i = 0; i < names.length(); i++) {
                String name = names.getString(i);
                if (name == null || name.isEmpty() || name.contains("/") || name.contains("\\") || name.startsWith(".")) {
                    call.reject("A plain file name inside the export folder is required.");
                    return;
                }
                File file = new File(dir, name);
                if (!file.getCanonicalPath().startsWith(root) || !file.isFile()) {
                    call.reject("Export file not found: " + name);
                    return;
                }
                keep.add(file);
                uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file));
            }
        } catch (Exception e) {
            call.reject("The export files could not be prepared.", e);
            return;
        }
        clearOld(dir, keep);
        Intent send;
        if (uris.size() == 1) {
            send = new Intent(Intent.ACTION_SEND);
            send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
        } else {
            send = new Intent(Intent.ACTION_SEND_MULTIPLE);
            send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        }
        send.setType(mimeType);
        ClipData clip = ClipData.newRawUri("export", uris.get(0));
        for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
        send.setClipData(clip);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, title);
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().startActivity(chooser);
        JSObject result = new JSObject();
        result.put("shared", uris.size());
        call.resolve(result);
    }

    private void clearOld(File dir, Set<File> keep) {
        File[] files = dir.listFiles();
        if (files == null) return;
        long now = System.currentTimeMillis();
        for (File f : files) {
            if (!keep.contains(f) && now - f.lastModified() > KEEP_MS) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }
}
