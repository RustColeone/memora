package com.laplacengan.memora;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Places a real image content URI on Android's clipboard. Browser clipboard APIs
 * are unreliable for binary image data in WebViews; FileProvider-backed URIs let
 * receiving apps paste image pixels instead of a data-URL string.
 */
@CapacitorPlugin(name = "ClipboardImage")
public class ClipboardImagePlugin extends Plugin {

    private static final int MAX_CLIPBOARD_IMAGE_BYTES = 12 * 1024 * 1024;
    private static final int MAX_CLIPBOARD_BASE64_CHARS = ((MAX_CLIPBOARD_IMAGE_BYTES + 2) / 3) * 4 + 16;
    private static final String SHARE_DIR = "memora-share";

    @PluginMethod
    public void copyImage(PluginCall call) {
        String base64 = call.getString("base64");
        String mime = call.getString("mime", "image/png");
        if (base64 == null || base64.isEmpty()) {
            call.reject("No image data was provided");
            return;
        }
        if (!mime.startsWith("image/")) {
            call.reject("Clipboard content must be an image");
            return;
        }

        String raw = base64.contains(",") ? base64.substring(base64.indexOf(',') + 1) : base64;
        if (raw.length() > MAX_CLIPBOARD_BASE64_CHARS) {
            call.reject("Image is larger than the 12 MB clipboard limit");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(raw, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("Could not decode image data: " + error.getMessage());
            return;
        }
        if (bytes.length == 0 || bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) {
            call.reject(bytes.length == 0 ? "Clipboard image is empty" : "Image is larger than the 12 MB clipboard limit");
            return;
        }

        String extension = extensionFor(mime);
        File shareDir = new File(getContext().getCacheDir(), SHARE_DIR);
        if (!shareDir.exists() && !shareDir.mkdirs()) {
            call.reject("Could not prepare the clipboard cache");
            return;
        }
        File image = new File(shareDir, "memo_clipboard_image." + extension);
        try (FileOutputStream stream = new FileOutputStream(image)) {
            stream.write(bytes);
        } catch (Exception error) {
            call.reject("Could not write clipboard image: " + error.getMessage());
            return;
        }

        final Uri uri;
        try {
            String authority = getContext().getPackageName() + ".fileprovider";
            uri = FileProvider.getUriForFile(getContext(), authority, image);
        } catch (Exception error) {
            call.reject("Could not expose clipboard image: " + error.getMessage());
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                ClipDescription description = new ClipDescription("Memo image", new String[] { mime });
                ClipData clip = new ClipData(description, new ClipData.Item(uri));
                ClipboardManager manager = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                manager.setPrimaryClip(clip);
                call.resolve();
            } catch (Exception error) {
                call.reject("Could not copy image: " + error.getMessage());
            }
        });
    }

    /**
     * Copies a Vault value: the clip is marked sensitive (Android 13+ hides it in
     * the clipboard preview and keyboard suggestions) and is cleared after
     * clearAfterMs (default 60 s) if it is still the current clip.
     */
    @PluginMethod
    public void copySecret(PluginCall call) {
        String text = call.getString("text");
        if (text == null) { call.reject("No text was provided"); return; }
        long clearAfter = Math.max(5000, Math.min(600000, call.getLong("clearAfterMs", 60000L)));
        getActivity().runOnUiThread(() -> {
            try {
                ClipboardManager manager = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("Memora Vault", text);
                PersistableBundle extras = new PersistableBundle();
                // ClipDescription.EXTRA_IS_SENSITIVE (Android 13); older versions ignore it.
                extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
                clip.getDescription().setExtras(extras);
                manager.setPrimaryClip(clip);
                new Handler(Looper.getMainLooper()).postDelayed(() -> clearIfStill(manager, text), clearAfter);
                call.resolve();
            } catch (Exception error) {
                call.reject("Could not copy: " + error.getMessage());
            }
        });
    }

    private static void clearIfStill(ClipboardManager manager, String text) {
        try {
            // Android 10+ refuses to show the clip to a background app (null):
            // a minute after copying it is still almost certainly ours, so the
            // secret is cleared rather than left behind. A clip we can read
            // that is something else is left alone.
            ClipData current = manager.getPrimaryClip();
            if (current != null && current.getItemCount() > 0) {
                CharSequence value = current.getItemAt(0).getText();
                if (value == null || !text.contentEquals(value)) return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) manager.clearPrimaryClip();
            else manager.setPrimaryClip(ClipData.newPlainText("", ""));
        } catch (Exception ignored) {
            // Nothing else to do; Android also clears old clips on its own.
        }
    }

    private String extensionFor(String mime) {
        if ("image/jpeg".equals(mime) || "image/jpg".equals(mime)) return "jpg";
        if ("image/gif".equals(mime)) return "gif";
        if ("image/webp".equals(mime)) return "webp";
        if ("image/avif".equals(mime)) return "avif";
        return "png";
    }
}
