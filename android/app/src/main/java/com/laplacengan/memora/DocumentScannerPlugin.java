package com.laplacengan.memora;

import android.app.Activity;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * "Scan documents": Google's ML Kit document scanner (Google Play services) runs
 * its own camera screen with edge detection, cropping and clean-up, and returns
 * JPEG pages. The pages are handed to the web layer, which opens the New Entry
 * form with them attached. Nothing is uploaded. Ported from ImageDB.
 */
@CapacitorPlugin(name = "DocumentScanner")
public class DocumentScannerPlugin extends Plugin {

    static final int MAX_PAGES = 20;
    static final long MAX_PAGE_BYTES = 24L * 1024L * 1024L;

    private ActivityResultLauncher<IntentSenderRequest> launcher;
    private PluginCall pending;
    private ExecutorService reader;

    @Override
    public void load() {
        reader = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "Memora-doc-scan");
            thread.setDaemon(true);
            return thread;
        });
        // Registered while the activity is being created, as the Activity Result API requires.
        launcher = getActivity().registerForActivityResult(
                new ActivityResultContracts.StartIntentSenderForResult(), this::onResult);
    }

    @PluginMethod
    public void scan(PluginCall call) {
        if (pending != null) {
            call.reject("A scan is already open", "SCAN_BUSY");
            return;
        }
        int pages = Math.max(1, Math.min(MAX_PAGES, call.getInt("pageLimit", MAX_PAGES)));
        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
                .setGalleryImportAllowed(true)
                .setPageLimit(pages)
                .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
                .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
                .build();
        pending = call;
        GmsDocumentScanning.getClient(options)
                .getStartScanIntent(getActivity())
                .addOnSuccessListener(sender -> launcher.launch(new IntentSenderRequest.Builder(sender).build()))
                .addOnFailureListener(error -> {
                    PluginCall failed = pending;
                    pending = null;
                    if (failed != null) failed.reject("The document scanner is unavailable: " + error.getMessage(), "SCAN_UNAVAILABLE");
                });
    }

    private void onResult(ActivityResult activityResult) {
        PluginCall call = pending;
        pending = null;
        if (call == null) return;
        if (activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            cancelled.put("pages", new JSArray());
            call.resolve(cancelled);
            return;
        }
        GmsDocumentScanningResult result = GmsDocumentScanningResult.fromActivityResultIntent(activityResult.getData());
        if (result == null || result.getPages() == null) {
            call.reject("The scanner returned no pages", "SCAN_EMPTY");
            return;
        }
        ExecutorService executor = reader;
        if (executor == null) {
            call.reject("The scanner is shutting down", "SCAN_INTERRUPTED");
            return;
        }
        executor.execute(() -> {
            JSArray out = new JSArray();
            try {
                for (GmsDocumentScanningResult.Page page : result.getPages()) {
                    Uri uri = page.getImageUri();
                    JSObject item = new JSObject();
                    item.put("data", Base64.encodeToString(readBounded(uri), Base64.NO_WRAP));
                    item.put("mime", "image/jpeg");
                    out.put(item);
                    deleteIfCacheFile(uri);
                }
                JSObject resolved = new JSObject();
                resolved.put("cancelled", false);
                resolved.put("pages", out);
                call.resolve(resolved);
            } catch (IOException | RuntimeException error) {
                call.reject("The scanned pages could not be read", "SCAN_READ_FAILED");
            }
        });
    }

    private byte[] readBounded(Uri uri) throws IOException {
        try (InputStream stream = getContext().getContentResolver().openInputStream(uri)) {
            if (stream == null) throw new IOException("No stream for " + uri);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            int read;
            while ((read = stream.read(chunk)) > 0) {
                bytes.write(chunk, 0, read);
                if (bytes.size() > MAX_PAGE_BYTES) throw new IOException("Scanned page is too large");
            }
            return bytes.toByteArray();
        }
    }

    // The scanner writes its pages into this app's cache; remove them once read.
    private void deleteIfCacheFile(Uri uri) {
        if (!"file".equals(uri.getScheme()) || uri.getPath() == null) return;
        File file = new File(uri.getPath());
        try {
            String cache = getContext().getCacheDir().getCanonicalPath();
            if (file.getCanonicalPath().startsWith(cache)) //noinspection ResultOfMethodCallIgnored
                file.delete();
        } catch (IOException ignored) {}
    }

    @Override
    protected void handleOnDestroy() {
        ExecutorService executor = reader;
        reader = null;
        if (executor != null) executor.shutdownNow();
        super.handleOnDestroy();
    }
}
