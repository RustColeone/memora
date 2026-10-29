package com.laplacengan.memora;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Holds Android share-sheet payloads until the WebView is ready. Incoming files
 * are copied through a bounded app-private cache instead of being Base64 encoded
 * in memory and sent across the JavaScript bridge.
 */
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {

    static final int MAX_SHARED_FILES = 16;
    static final long MAX_SHARED_FILE_BYTES = 32L * 1024L * 1024L;
    static final long MAX_SHARED_TOTAL_BYTES = 96L * 1024L * 1024L;
    private static final int MAX_SHARED_TEXT_CHARS = 256 * 1024;
    private static final long STALE_SHARE_AGE_MS = 60L * 60L * 1000L;
    private static final String SHARE_DIR = "memora-share";
    private static final String SHARE_PREFIX = "pending-share-";
    private static final String SHARE_PREFS = "memora_pending_share";
    private static final String SHARE_PREFS_KEY = "payload";

    static void setPendingShare(Context context, List<Uri> uris, String text, String mimeHint) {
        List<String> uriStrings = new ArrayList<>();
        if (uris != null) for (Uri uri : uris) if (uri != null) uriStrings.add(uri.toString());
        pendingStore(context).save(new PendingShareStore.Payload(uriStrings, text, mimeHint));
    }

    @PluginMethod
    public void consumePendingShare(PluginCall call) {
        PendingShareStore inbox = pendingStore(getContext());
        PendingShareStore.Payload pending = inbox.peek();
        List<Uri> uris = new ArrayList<>();
        for (String value : pending.uriStrings) {
            try { uris.add(Uri.parse(value)); } catch (Exception ignored) {}
        }
        String text = pending.text;

        if (uris.isEmpty() && text.trim().isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("text", "");
            empty.put("files", new JSArray());
            call.resolve(empty);
            return;
        }

        if (uris.size() > MAX_SHARED_FILES) {
            inbox.ack(pending);
            call.reject("A share can contain at most " + MAX_SHARED_FILES + " files");
            return;
        }
        if (text.length() > MAX_SHARED_TEXT_CHARS) {
            inbox.ack(pending);
            call.reject("Shared text is larger than the 256 KB intake limit");
            return;
        }

        File shareDir = new File(getContext().getCacheDir(), SHARE_DIR);
        if (!shareDir.exists() && !shareDir.mkdirs()) {
            call.reject("Unable to prepare the shared-file cache");
            return;
        }
        pruneStaleShares(shareDir);

        String token = UUID.randomUUID().toString();
        List<File> stagedFiles = new ArrayList<>();
        JSArray files = new JSArray();
        long totalBytes = 0L;
        try {
            ContentResolver resolver = getContext().getContentResolver();
            for (int index = 0; index < uris.size(); index++) {
                Uri uri = uris.get(index);
                FileResult result = stageFile(
                        resolver, uri, pending.mimeHint, shareDir, token, index, totalBytes);
                totalBytes += result.size;
                if (totalBytes > MAX_SHARED_TOTAL_BYTES) {
                    throw new IllegalArgumentException("Shared files exceed the 96 MB total intake limit");
                }
                stagedFiles.add(result.file);
                files.put(result.payload);
            }

            JSObject result = new JSObject();
            result.put("text", text);
            result.put("token", token);
            result.put("files", files);
            inbox.ack(pending);
            call.resolve(result);
        } catch (Exception error) {
            for (File file : stagedFiles) file.delete();
            deleteTokenFiles(shareDir, token);
            // Policy violations cannot become valid on retry. Provider I/O and
            // cache failures can, so leave their metadata pending for the next
            // consume attempt while the Android task still owns its URI grant.
            if (error instanceof IllegalArgumentException) inbox.ack(pending);
            call.reject("Could not read shared content: " + error.getMessage());
        }
    }

    @PluginMethod
    public void releasePendingShare(PluginCall call) {
        String token = call.getString("token", "");
        if (!token.matches("[0-9a-f-]{36}")) {
            call.reject("Invalid shared-file token");
            return;
        }
        deleteTokenFiles(new File(getContext().getCacheDir(), SHARE_DIR), token);
        call.resolve();
    }

    private FileResult stageFile(ContentResolver resolver, Uri uri, String mimeHint, File shareDir,
                                 String token, int index, long currentTotal) throws Exception {
        String name = readDisplayName(resolver, uri);
        String mime = ShareIntentSupport.resolveSupportedMime(resolver.getType(uri), mimeHint, name);
        if (mime == null) {
            throw new IllegalArgumentException("The shared item type is not supported");
        }

        long declaredSize = querySize(resolver, uri);
        if (declaredSize > MAX_SHARED_FILE_BYTES) {
            throw new IllegalArgumentException("A shared file is larger than the 32 MB per-file limit");
        }
        if (declaredSize >= 0 && currentTotal + declaredSize > MAX_SHARED_TOTAL_BYTES) {
            throw new IllegalArgumentException("Shared files exceed the 96 MB total intake limit");
        }

        String fileName = SHARE_PREFIX + token + "-" + index + "." + extensionFor(mime);
        File staged = new File(shareDir, fileName);
        long size = 0L;
        try (InputStream stream = resolver.openInputStream(uri);
             FileOutputStream output = new FileOutputStream(staged)) {
            if (stream == null) throw new IllegalStateException("Cannot open shared file");
            byte[] chunk = new byte[32 * 1024];
            int count;
            while ((count = stream.read(chunk)) != -1) {
                size += count;
                if (size > MAX_SHARED_FILE_BYTES) {
                    throw new IllegalArgumentException("A shared file is larger than the 32 MB per-file limit");
                }
                if (currentTotal + size > MAX_SHARED_TOTAL_BYTES) {
                    throw new IllegalArgumentException("Shared files exceed the 96 MB total intake limit");
                }
                output.write(chunk, 0, count);
            }
        } catch (Exception error) {
            staged.delete();
            throw error;
        }
        if (size == 0L) {
            staged.delete();
            throw new IllegalArgumentException("A shared file is empty");
        }

        JSObject payload = new JSObject();
        payload.put("filePath", staged.getAbsolutePath());
        payload.put("mime", mime);
        payload.put("name", name);
        payload.put("size", size);
        return new FileResult(staged, payload, size);
    }

    private String readDisplayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{ OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0 && !cursor.isNull(index)) return cursor.getString(index);
            }
        } catch (Exception ignored) {}
        return "shared_file";
    }

    private long querySize(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{ OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index);
            }
        } catch (Exception ignored) {}
        return -1L;
    }

    private String extensionFor(String mime) {
        if ("image/jpeg".equals(mime) || "image/jpg".equals(mime)) return "jpg";
        if ("image/png".equals(mime)) return "png";
        if ("image/gif".equals(mime)) return "gif";
        if ("image/webp".equals(mime)) return "webp";
        if ("image/avif".equals(mime)) return "avif";
        if ("application/pdf".equals(mime)) return "pdf";
        return "bin";
    }

    private void deleteTokenFiles(File shareDir, String token) {
        File[] matches = shareDir.listFiles((dir, name) -> name.startsWith(SHARE_PREFIX + token + "-"));
        if (matches != null) for (File file : matches) file.delete();
    }

    private void pruneStaleShares(File shareDir) {
        long cutoff = System.currentTimeMillis() - STALE_SHARE_AGE_MS;
        File[] files = shareDir.listFiles((dir, name) -> name.startsWith(SHARE_PREFIX));
        if (files != null) for (File file : files) if (file.lastModified() < cutoff) file.delete();
    }

    private static PendingShareStore pendingStore(Context context) {
        Context appContext = context.getApplicationContext();
        SharedPreferences preferences =
                appContext.getSharedPreferences(SHARE_PREFS, Context.MODE_PRIVATE);
        return new PendingShareStore(new PendingShareStore.Storage() {
            @Override
            public String read() {
                return preferences.getString(SHARE_PREFS_KEY, null);
            }

            @Override
            public void write(String encoded) {
                // commit() is intentional: returning from the share activity only
                // after this tiny record is durable closes the process-death gap.
                preferences.edit().putString(SHARE_PREFS_KEY, encoded).commit();
            }

            @Override
            public void clear() {
                preferences.edit().remove(SHARE_PREFS_KEY).commit();
            }
        });
    }

    private static final class FileResult {
        final File file;
        final JSObject payload;
        final long size;

        FileResult(File file, JSObject payload, long size) {
            this.file = file;
            this.payload = payload;
            this.size = size;
        }
    }
}
