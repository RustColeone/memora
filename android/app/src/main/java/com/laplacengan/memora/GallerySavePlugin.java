package com.laplacengan.memora;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;

/**
 * Saves an image straight into the phone's gallery (MediaStore -> Pictures/Memora) so
 * it shows up in Photos/Gallery -- unlike Share, which only hands the file to another
 * app. On API 29+ this needs no runtime permission (the app writes its own media).
 * On older devices the web layer falls back to its Downloads writer.
 */
@CapacitorPlugin(name = "GallerySave")
public class GallerySavePlugin extends Plugin {

    private static final String TAG = "GallerySavePlugin";
    private static final long MAX_BYTES = 64L * 1024 * 1024;   // guard against giant base64 payloads
    private static final String SUBDIR = "Memora";

    @PluginMethod
    public void save(PluginCall call) {
        // MediaStore RELATIVE_PATH + IS_PENDING is API 29+. Older devices use the JS fallback.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("MediaStore gallery save requires Android 10+");
            return;
        }

        String base64 = call.getString("base64");
        String mime   = call.getString("mime", "image/png");
        String name   = call.getString("fileName", "image_" + System.currentTimeMillis());
        if (base64 == null) { call.reject("No base64 data provided"); return; }

        String pure = base64.contains(",") ? base64.substring(base64.indexOf(',') + 1) : base64;

        byte[] bytes;
        try {
            bytes = Base64.decode(pure, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("Failed to decode image data: " + e.getMessage());
            return;
        }
        if (bytes.length == 0 || bytes.length > MAX_BYTES) {
            call.reject("Image is empty or exceeds the save limit");
            return;
        }

        final ContentResolver resolver = getContext().getContentResolver();
        final ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        values.put(MediaStore.Images.Media.MIME_TYPE, mime);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + SUBDIR);
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri uri = null;
        try {
            uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) { call.reject("Could not create a gallery entry"); return; }
            try (OutputStream os = resolver.openOutputStream(uri)) {
                if (os == null) throw new Exception("No output stream for gallery entry");
                os.write(bytes);
            }
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            Log.d(TAG, "Saved to gallery: " + uri);
            call.resolve();
        } catch (Exception e) {
            // Roll back the half-written pending entry so it doesn't linger invisibly.
            if (uri != null) { try { resolver.delete(uri, null, null); } catch (Exception ignored) {} }
            Log.e(TAG, "Gallery save failed: " + e.getMessage());
            call.reject("Gallery save failed: " + e.getMessage());
        }
    }
}
