package com.laplacengan.memora;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

/**
 * "Scan": Google's code scanner (Google Play services) runs its own camera
 * screen and returns what the code says. Memora asks for no camera permission
 * and sees no camera images; only the decoded text comes back. The web layer
 * (memo-scan.js) connects to a sync server when the code is a Memora pairing
 * code, and otherwise starts a new note with the text.
 */
@CapacitorPlugin(name = "QrScanner")
public class QrScannerPlugin extends Plugin {

    private PluginCall pending;

    @PluginMethod
    public void scan(PluginCall call) {
        if (pending != null) {
            call.reject("A scan is already open", "SCAN_BUSY");
            return;
        }
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE, Barcode.FORMAT_AZTEC, Barcode.FORMAT_DATA_MATRIX,
                        Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E,
                        Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39, Barcode.FORMAT_PDF417)
                .enableAutoZoom()
                .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
        pending = call;
        scanner.startScan()
                .addOnSuccessListener(barcode -> {
                    PluginCall done = take();
                    if (done == null) return;
                    JSObject out = new JSObject();
                    String raw = barcode.getRawValue();
                    out.put("text", raw != null ? raw : (barcode.getDisplayValue() != null ? barcode.getDisplayValue() : ""));
                    out.put("format", formatName(barcode.getFormat()));
                    out.put("cancelled", false);
                    done.resolve(out);
                })
                .addOnCanceledListener(() -> {
                    PluginCall done = take();
                    if (done == null) return;
                    JSObject out = new JSObject();
                    out.put("cancelled", true);
                    done.resolve(out);
                })
                .addOnFailureListener(error -> {
                    PluginCall done = take();
                    if (done != null) done.reject("The code scanner is unavailable: " + error.getMessage(), "SCAN_UNAVAILABLE");
                });
    }

    private PluginCall take() {
        PluginCall call = pending;
        pending = null;
        return call;
    }

    private static String formatName(int format) {
        switch (format) {
            case Barcode.FORMAT_QR_CODE: return "qr";
            case Barcode.FORMAT_AZTEC: return "aztec";
            case Barcode.FORMAT_DATA_MATRIX: return "data-matrix";
            case Barcode.FORMAT_PDF417: return "pdf417";
            case Barcode.FORMAT_EAN_13: case Barcode.FORMAT_EAN_8: return "ean";
            case Barcode.FORMAT_UPC_A: case Barcode.FORMAT_UPC_E: return "upc";
            case Barcode.FORMAT_CODE_128: case Barcode.FORMAT_CODE_39: return "code";
            default: return "other";
        }
    }
}
