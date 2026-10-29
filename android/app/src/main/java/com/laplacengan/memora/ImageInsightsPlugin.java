package com.laplacengan.memora;

import android.content.res.AssetFileDescriptor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Point;
import android.graphics.Rect;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.nio.FloatBuffer;

import androidx.exifinterface.media.ExifInterface;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.common.moduleinstall.InstallStatusListener;
import com.google.android.gms.common.moduleinstall.ModuleAvailabilityResponse;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.android.gms.common.moduleinstall.ModuleInstallClient;
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest;
import com.google.android.gms.common.moduleinstall.ModuleInstallResponse;
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate;
import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.android.gms.tflite.java.TfLite;
import com.google.mlkit.common.MlKitException;
import com.google.android.gms.common.api.OptionalModuleApi;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation;
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentationResult;
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenter;
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;
import com.google.mlkit.vision.label.ImageLabel;
import com.google.mlkit.vision.label.ImageLabeler;
import com.google.mlkit.vision.label.ImageLabeling;
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions;

import org.tensorflow.lite.InterpreterApi;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * On-device image analysis and image tools for images Memora already stores
 * (ported from ImageDB's ImageInsightsPlugin).
 *
 * One call analyzes one stored image: ML Kit image labels, a face count (face
 * detection only — no identity, landmarks or face crops are produced or kept),
 * and a 1024-value image embedding for "find similar". JavaScript passes only
 * the stored path (uploads/…); Memora's images are not encrypted at rest, so
 * the file is read in place. ML Kit and the LiteRT runtime are the unbundled Google Play
 * services versions, so their models download through Play services. The
 * embedder model (MediaPipe MobileNet-V3 small, Apache 2.0) ships in assets.
 */
@CapacitorPlugin(name = "ImageInsights")
public class ImageInsightsPlugin extends Plugin {

    static final int ANALYZER_VERSION = 2; // 2: adds the QR/barcode count
    static final int ANALYSIS_DIMENSION = 768;
    static final long ANALYSIS_PIXELS = 1_200_000L;
    static final int EMBED_SIZE = 224;
    static final int EMBED_DIM = 1024;
    static final float LABEL_THRESHOLD = 0.55f;
    static final int MAX_LABELS = 12;
    static final float MIN_FACE_SIZE = 0.08f;
    static final long STEP_TIMEOUT_MS = 20_000L;
    static final long STATUS_TIMEOUT_MS = 12_000L;
    static final long PREPARE_TIMEOUT_MS = 170_000L;
    static final String MODEL_ASSET = "models/image_embedder_v1.tflite";
    // On-demand tools work on a larger copy than background analysis.
    static final int TOOL_DIMENSION = 2048;
    static final long TOOL_PIXELS = 3_200_000L;
    static final int MAX_CODES = 12;
    static final int MAX_REGIONS = 120;

    static final String CODE_INVALID_ARGUMENT = "INSIGHTS_INVALID_ARGUMENT";
    static final String CODE_BUSY = "INSIGHTS_BUSY";
    static final String CODE_PLAY_SERVICES_UNAVAILABLE = "INSIGHTS_PLAY_SERVICES_UNAVAILABLE";
    static final String CODE_MODEL_NOT_READY = "INSIGHTS_MODEL_NOT_READY";
    static final String CODE_MODEL_DOWNLOAD_FAILED = "INSIGHTS_MODEL_DOWNLOAD_FAILED";
    static final String CODE_TIMEOUT = "INSIGHTS_TIMEOUT";
    static final String CODE_INTERRUPTED = "INSIGHTS_INTERRUPTED";
    static final String CODE_INTERNAL = "INSIGHTS_INTERNAL";

    private final AtomicBoolean analysisBusy = new AtomicBoolean(false);
    private final AtomicBoolean prepareBusy = new AtomicBoolean(false);
    private final AtomicBoolean toolBusy = new AtomicBoolean(false);
    private final Object clientLock = new Object();

    private ExecutorService analysisExecutor;
    private ExecutorService controlExecutor;
    private ExecutorService toolExecutor;
    private BarcodeScanner barcodeScanner;
    private FaceDetector regionFaceDetector;
    private TextRecognizer textRecognizer;
    private SubjectSegmenter subjectSegmenter;
    private ImageLabeler labeler;
    private FaceDetector faceDetector;
    private ModuleInstallClient installer;
    private volatile boolean runtimeReady;
    private volatile boolean destroyed;
    // Touched only on the analysis thread.
    private InterpreterApi embedder;
    private boolean embedderFailed;

    @Override
    public void load() {
        destroyed = false;
        analysisExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "Memora-insights");
            thread.setDaemon(true);
            thread.setPriority(Thread.MIN_PRIORITY);
            return thread;
        });
        controlExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "Memora-insights-control");
            thread.setDaemon(true);
            return thread;
        });
        toolExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "Memora-image-tools");
            thread.setDaemon(true);
            return thread;
        });
    }

    /** Reports whether the labeling and face models and the LiteRT runtime are usable. */
    @PluginMethod
    public void getStatus(PluginCall call) {
        if (playServicesStatus() != ConnectionResult.SUCCESS) {
            call.resolve(statusResult("unsupported", false));
            return;
        }
        runControl(call, () -> {
            ModuleAvailabilityResponse response = Tasks.await(
                    installer().areModulesAvailable(labeler(), faceDetector()),
                    STATUS_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            boolean available = response.areModulesAvailable();
            call.resolve(statusResult(available && runtimeReady ? "ready" : "missing", available));
        });
    }

    /**
     * Installs the labeling and face modules (through Google Play services) and
     * initializes the LiteRT runtime. Resolves once analysis can run.
     */
    @PluginMethod
    public void prepare(PluginCall call) {
        if (playServicesStatus() != ConnectionResult.SUCCESS) {
            call.reject("Google Play services is unavailable", CODE_PLAY_SERVICES_UNAVAILABLE);
            return;
        }
        if (!prepareBusy.compareAndSet(false, true)) {
            call.reject("Auto-organize is already preparing", CODE_BUSY);
            return;
        }
        runControl(call, () -> {
            try {
                installModules();
                try {
                    Tasks.await(TfLite.initialize(getContext()), PREPARE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                    runtimeReady = true;
                } catch (ExecutionException | TimeoutException error) {
                    // Labels and faces still work without embeddings.
                    runtimeReady = false;
                }
                call.resolve(statusResult("ready", true));
            } finally {
                prepareBusy.set(false);
            }
        });
    }

    /** Analyzes one app-private stored original. One request at a time. */
    @PluginMethod
    public void analyzeStoredImage(PluginCall call) {
        String fileName = call.getString("path", "");
        if (fileName.isEmpty()) {
            call.reject("path is required", CODE_INVALID_ARGUMENT);
            return;
        }
        boolean wantEmbedding = call.getBoolean("embedding", Boolean.TRUE);
        if (!analysisBusy.compareAndSet(false, true)) {
            call.reject("Another analysis is already running", CODE_BUSY);
            return;
        }
        ExecutorService executor = analysisExecutor;
        if (executor == null || destroyed) {
            analysisBusy.set(false);
            call.reject("Auto-organize is shutting down", CODE_INTERRUPTED);
            return;
        }
        File filesDir = getContext().getFilesDir();
        File cacheDir = getContext().getCacheDir();
        try {
            executor.execute(() -> {
                try {
                    call.resolve(analyze(filesDir, cacheDir, fileName, wantEmbedding));
                } catch (MemoImageFiles.InputException error) {
                    call.reject(error.getMessage(), insightsCode(error.code), error);
                } catch (Exception error) {
                    rejectFailure(call, error);
                } catch (OutOfMemoryError error) {
                    call.reject("The stored image is too large to analyze", "INSIGHTS_IMAGE_TOO_LARGE");
                } finally {
                    analysisBusy.set(false);
                }
            });
        } catch (RejectedExecutionException error) {
            analysisBusy.set(false);
            call.reject("Auto-organize is shutting down", CODE_INTERRUPTED, error);
        }
    }

    /** A decoded, EXIF-oriented working copy of a stored original. */
    static final class LoadedImage {
        final Bitmap bitmap;
        final int width;
        final int height;
        final boolean camera;

        LoadedImage(Bitmap bitmap, int width, int height, boolean camera) {
            this.bitmap = bitmap;
            this.width = width;
            this.height = height;
            this.camera = camera;
        }
    }

    static LoadedImage loadImage(File filesDir, File cacheDir, String fileName, int maxDimension,
                                 long maxPixels) throws MemoImageFiles.InputException {
        File source = MemoImageFiles.resolveStoredImage(filesDir, fileName);
        MemoImageFiles.validateReadableImage(source);
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(source.getAbsolutePath(), bounds);
        boolean camera = hasCameraExif(source);
        Bitmap bitmap = MemoImageFiles.decodeSampledBitmap(source, maxDimension, maxPixels);
        return new LoadedImage(bitmap, bounds.outWidth, bounds.outHeight, camera);
    }

    private JSObject analyze(File filesDir, File cacheDir, String fileName, boolean wantEmbedding)
            throws Exception {
        LoadedImage loaded = loadImage(filesDir, cacheDir, fileName, ANALYSIS_DIMENSION, ANALYSIS_PIXELS);
        Bitmap bitmap = loaded.bitmap;
        try {
            InputImage input = InputImage.fromBitmap(bitmap, 0);
            List<ImageLabel> labels = Tasks.await(labeler().process(input),
                    STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            List<Face> faces = Tasks.await(faceDetector().process(input),
                    STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            // Only whether codes are present is kept; their content (a Wi-Fi
            // password, a ticket) is decoded on demand and never stored.
            int codes = 0;
            try {
                codes = Tasks.await(barcodeScanner().process(input), STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS).size();
            } catch (ExecutionException | TimeoutException ignored) {
                // The barcode module may still be downloading; labels and faces stand.
            }

            JSObject result = new JSObject();
            result.put("version", ANALYZER_VERSION);
            result.put("width", loaded.width);
            result.put("height", loaded.height);
            result.put("camera", loaded.camera);
            result.put("labels", labelsToJson(labels));
            result.put("faces", faces.size());
            result.put("codes", codes);
            result.put("faceArea", largestFaceArea(faces, bitmap.getWidth(), bitmap.getHeight()));
            String embedding = wantEmbedding ? embed(bitmap) : null;
            if (embedding != null) {
                result.put("embedding", embedding);
                result.put("embeddingDim", EMBED_DIM);
            }
            return result;
        } finally {
            if (!bitmap.isRecycled()) bitmap.recycle();
        }
    }

    // ── On-demand image tools ─────────────────────────────────

    /** Decodes QR codes and barcodes in one stored image. Nothing is stored. */
    @PluginMethod
    public void readCodes(PluginCall call) {
        runTool(call, (filesDir, cacheDir, fileName) -> {
            ensureModules(barcodeScanner());
            LoadedImage loaded = loadImage(filesDir, cacheDir, fileName, TOOL_DIMENSION, TOOL_PIXELS);
            try {
                List<Barcode> codes = Tasks.await(barcodeScanner().process(InputImage.fromBitmap(loaded.bitmap, 0)),
                        STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                JSArray out = new JSArray();
                for (int i = 0; i < codes.size() && i < MAX_CODES; i++) out.put(codeToJson(codes.get(i)));
                JSObject result = new JSObject();
                result.put("codes", out);
                return result;
            } finally {
                loaded.bitmap.recycle();
            }
        });
    }

    static JSObject codeToJson(Barcode code) {
        JSObject item = new JSObject();
        item.put("format", code.getFormat());
        item.put("type", code.getValueType());
        item.put("raw", MemoImageFiles.truncate(code.getRawValue(), 4096));
        item.put("display", MemoImageFiles.truncate(code.getDisplayValue(), 4096));
        if (code.getUrl() != null) item.put("url", MemoImageFiles.truncate(code.getUrl().getUrl(), 4096));
        if (code.getWifi() != null) {
            JSObject wifi = new JSObject();
            wifi.put("ssid", code.getWifi().getSsid());
            wifi.put("password", code.getWifi().getPassword());
            wifi.put("encryption", code.getWifi().getEncryptionType());
            item.put("wifi", wifi);
        }
        if (code.getPhone() != null) item.put("phone", code.getPhone().getNumber());
        if (code.getEmail() != null) item.put("email", code.getEmail().getAddress());
        return item;
    }

    /**
     * Finds faces and lines of text to blur before sharing. Boxes are returned as
     * fractions (0..1) of the EXIF-oriented image, which is how the WebView draws it.
     */
    @PluginMethod
    public void detectRegions(PluginCall call) {
        runTool(call, (filesDir, cacheDir, fileName) -> {
            ensureModules(regionFaceDetector(), textRecognizer());
            LoadedImage loaded = loadImage(filesDir, cacheDir, fileName, TOOL_DIMENSION, TOOL_PIXELS);
            try {
                Bitmap bitmap = loaded.bitmap;
                InputImage input = InputImage.fromBitmap(bitmap, 0);
                float w = bitmap.getWidth();
                float h = bitmap.getHeight();
                JSArray faces = new JSArray();
                for (Face face : Tasks.await(regionFaceDetector().process(input), STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                    if (faces.length() >= MAX_REGIONS) break;
                    faces.put(boxToJson(face.getBoundingBox(), w, h));
                }
                JSArray text = new JSArray();
                Text recognized = Tasks.await(textRecognizer().process(input), STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                for (Text.TextBlock block : recognized.getTextBlocks()) {
                    for (Text.Line line : block.getLines()) {
                        if (text.length() >= MAX_REGIONS || line.getBoundingBox() == null) continue;
                        JSObject box = boxToJson(line.getBoundingBox(), w, h);
                        box.put("text", MemoImageFiles.truncate(line.getText(), 200));
                        text.put(box);
                    }
                }
                JSObject result = new JSObject();
                result.put("faces", faces);
                result.put("text", text);
                return result;
            } finally {
                loaded.bitmap.recycle();
            }
        });
    }

    static JSObject boxToJson(Rect box, float width, float height) {
        JSObject item = new JSObject();
        item.put("x", clamp01(box.left / width));
        item.put("y", clamp01(box.top / height));
        item.put("w", clamp01(box.width() / width));
        item.put("h", clamp01(box.height() / height));
        return item;
    }

    static double clamp01(float value) {
        return Math.round(Math.max(0f, Math.min(1f, value)) * 10000d) / 10000d;
    }

    /**
     * Subject segmentation for two tools:
     *   mode "cutout"   → a PNG of the subject on a transparent background, trimmed;
     *   mode "document" → the four corners of the main subject (a page), as fractions.
     */
    @PluginMethod
    public void segmentSubject(PluginCall call) {
        String mode = call.getString("mode", "cutout");
        runTool(call, (filesDir, cacheDir, fileName) -> {
            ensureModules(subjectSegmenter());
            int maxDimension = "document".equals(mode) ? 1024 : TOOL_DIMENSION;
            long maxPixels = "document".equals(mode) ? 1_000_000L : TOOL_PIXELS;
            LoadedImage loaded = loadImage(filesDir, cacheDir, fileName, maxDimension, maxPixels);
            Bitmap foreground = null;
            try {
                SubjectSegmentationResult segmented = Tasks.await(
                        subjectSegmenter().process(InputImage.fromBitmap(loaded.bitmap, 0)),
                        STEP_TIMEOUT_MS * 2, TimeUnit.MILLISECONDS);
                FloatBuffer mask = segmented.getForegroundConfidenceMask();
                int w = loaded.bitmap.getWidth();
                int h = loaded.bitmap.getHeight();
                JSObject result = new JSObject();
                if ("document".equals(mode)) {
                    double[] corners = mask == null ? null : documentCorners(mask, w, h);
                    result.put("found", corners != null);
                    if (corners != null) {
                        JSArray points = new JSArray();
                        for (int i = 0; i < 4; i++) {
                            JSObject point = new JSObject();
                            point.put("x", corners[i * 2]);
                            point.put("y", corners[i * 2 + 1]);
                            points.put(point);
                        }
                        result.put("corners", points);
                    }
                    return result;
                }
                foreground = segmented.getForegroundBitmap();
                if (foreground == null || mask == null) {
                    result.put("found", false);
                    return result;
                }
                Rect bounds = maskBounds(mask, w, h, 0.5f);
                if (bounds == null) {
                    result.put("found", false);
                    return result;
                }
                int pad = Math.round(Math.max(w, h) * 0.02f);
                bounds.set(Math.max(0, bounds.left - pad), Math.max(0, bounds.top - pad),
                        Math.min(w, bounds.right + pad), Math.min(h, bounds.bottom + pad));
                Bitmap trimmed = Bitmap.createBitmap(foreground, bounds.left, bounds.top,
                        bounds.width(), bounds.height());
                ByteArrayOutputStream png = new ByteArrayOutputStream();
                trimmed.compress(Bitmap.CompressFormat.PNG, 100, png);
                if (trimmed != foreground) trimmed.recycle();
                result.put("found", true);
                result.put("png", Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP));
                result.put("width", bounds.width());
                result.put("height", bounds.height());
                return result;
            } finally {
                if (foreground != null && !foreground.isRecycled()) foreground.recycle();
                loaded.bitmap.recycle();
            }
        });
    }

    static Rect maskBounds(FloatBuffer mask, int width, int height, float threshold) {
        int left = width, top = height, right = -1, bottom = -1;
        mask.rewind();
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                if (mask.get() >= threshold) {
                    if (x < left) left = x;
                    if (x > right) right = x;
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                }
            }
        }
        return right < 0 ? null : new Rect(left, top, right + 1, bottom + 1);
    }

    /**
     * Corners of the dominant subject, ordered top-left, top-right, bottom-right,
     * bottom-left: the foreground points that extremize x+y and x−y. Returns null
     * when the subject is too small or fills the whole frame to be a page.
     */
    static double[] documentCorners(FloatBuffer mask, int width, int height) {
        mask.rewind();
        long count = 0;
        int[] best = new int[8];
        int minSum = Integer.MAX_VALUE, maxSum = Integer.MIN_VALUE;
        int minDiff = Integer.MAX_VALUE, maxDiff = Integer.MIN_VALUE;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                if (mask.get() < 0.5f) continue;
                count++;
                int sum = x + y, diff = x - y;
                if (sum < minSum) { minSum = sum; best[0] = x; best[1] = y; }
                if (diff > maxDiff) { maxDiff = diff; best[2] = x; best[3] = y; }
                if (sum > maxSum) { maxSum = sum; best[4] = x; best[5] = y; }
                if (diff < minDiff) { minDiff = diff; best[6] = x; best[7] = y; }
            }
        }
        double coverage = (double) count / ((double) width * height);
        if (coverage < 0.08 || coverage > 0.985) return null;
        double[] out = new double[8];
        for (int i = 0; i < 8; i += 2) {
            out[i] = clamp01(best[i] / (float) Math.max(1, width - 1));
            out[i + 1] = clamp01(best[i + 1] / (float) Math.max(1, height - 1));
        }
        return out;
    }

    interface ToolWork {
        JSObject run(File filesDir, File cacheDir, String fileName) throws Exception;
    }

    private void runTool(PluginCall call, ToolWork work) {
        String fileName = call.getString("path", "");
        if (fileName.isEmpty()) {
            call.reject("path is required", CODE_INVALID_ARGUMENT);
            return;
        }
        if (playServicesStatus() != ConnectionResult.SUCCESS) {
            call.reject("Google Play services is unavailable", CODE_PLAY_SERVICES_UNAVAILABLE);
            return;
        }
        if (!toolBusy.compareAndSet(false, true)) {
            call.reject("Another image tool is already running", CODE_BUSY);
            return;
        }
        ExecutorService executor = toolExecutor;
        if (executor == null || destroyed) {
            toolBusy.set(false);
            call.reject("Image tools are shutting down", CODE_INTERRUPTED);
            return;
        }
        File filesDir = getContext().getFilesDir();
        File cacheDir = getContext().getCacheDir();
        try {
            executor.execute(() -> {
                try {
                    call.resolve(work.run(filesDir, cacheDir, fileName));
                } catch (MemoImageFiles.InputException error) {
                    call.reject(error.getMessage(), insightsCode(error.code), error);
                } catch (Exception error) {
                    rejectFailure(call, error);
                } catch (OutOfMemoryError error) {
                    call.reject("The stored image is too large for this tool", "INSIGHTS_IMAGE_TOO_LARGE");
                } finally {
                    toolBusy.set(false);
                }
            });
        } catch (RejectedExecutionException error) {
            toolBusy.set(false);
            call.reject("Image tools are shutting down", CODE_INTERRUPTED, error);
        }
    }

    static JSArray labelsToJson(List<ImageLabel> labels) {
        List<ImageLabel> sorted = new ArrayList<>(labels);
        Collections.sort(sorted, (left, right) -> Float.compare(right.getConfidence(), left.getConfidence()));
        JSArray out = new JSArray();
        for (int i = 0; i < sorted.size() && i < MAX_LABELS; i++) {
            ImageLabel label = sorted.get(i);
            JSObject item = new JSObject();
            item.put("i", label.getIndex());
            item.put("t", MemoImageFiles.truncate(label.getText(), 64));
            item.put("c", Math.round(label.getConfidence() * 1000f) / 1000.0);
            out.put(item);
        }
        return out;
    }

    static double largestFaceArea(List<Face> faces, int width, int height) {
        if (faces.isEmpty() || width <= 0 || height <= 0) return 0d;
        double largest = 0d;
        for (Face face : faces) {
            Rect box = face.getBoundingBox();
            largest = Math.max(largest, (double) Math.max(0, box.width()) * Math.max(0, box.height()));
        }
        return Math.min(1d, Math.round(largest / ((double) width * height) * 1000d) / 1000d);
    }

    /** True when the file carries a camera make or model, i.e. it is a photo, not a screenshot. */
    static boolean hasCameraExif(File file) {
        try {
            ExifInterface exif = new ExifInterface(file.getAbsolutePath());
            String make = exif.getAttribute(ExifInterface.TAG_MAKE);
            String model = exif.getAttribute(ExifInterface.TAG_MODEL);
            return (make != null && !make.trim().isEmpty()) || (model != null && !model.trim().isEmpty());
        } catch (IOException | RuntimeException ignored) {
            return false;
        }
    }

    /** L2-normalized embedding quantized to int8 and Base64-encoded; null when unavailable. */
    private String embed(Bitmap bitmap) {
        InterpreterApi interpreter = embedder();
        if (interpreter == null) return null;
        Bitmap scaled = Bitmap.createScaledBitmap(bitmap, EMBED_SIZE, EMBED_SIZE, true);
        try {
            ByteBuffer input = ByteBuffer.allocateDirect(EMBED_SIZE * EMBED_SIZE * 3 * 4)
                    .order(ByteOrder.nativeOrder());
            int[] pixels = new int[EMBED_SIZE * EMBED_SIZE];
            scaled.getPixels(pixels, 0, EMBED_SIZE, 0, 0, EMBED_SIZE, EMBED_SIZE);
            FloatBuffer floats = input.asFloatBuffer();
            for (int pixel : pixels) {
                floats.put(((pixel >> 16) & 0xFF) / 255f);
                floats.put(((pixel >> 8) & 0xFF) / 255f);
                floats.put((pixel & 0xFF) / 255f);
            }
            float[][] output = new float[1][EMBED_DIM];
            interpreter.run(input, output);
            return Base64.encodeToString(quantize(output[0]), Base64.NO_WRAP);
        } catch (RuntimeException error) {
            return null;
        } finally {
            if (scaled != bitmap && !scaled.isRecycled()) scaled.recycle();
        }
    }

    static byte[] quantize(float[] vector) {
        double norm = 0d;
        for (float value : vector) norm += (double) value * value;
        norm = Math.sqrt(norm);
        byte[] out = new byte[vector.length];
        if (norm <= 0d) return out;
        for (int i = 0; i < vector.length; i++) {
            long scaled = Math.round(vector[i] / norm * 127d);
            out[i] = (byte) Math.max(-127, Math.min(127, scaled));
        }
        return out;
    }

    private InterpreterApi embedder() {
        if (embedder != null || embedderFailed || !runtimeReady) return embedder;
        try {
            ByteBuffer model = loadModel();
            InterpreterApi.Options options = new InterpreterApi.Options()
                    .setRuntime(InterpreterApi.Options.TfLiteRuntime.FROM_SYSTEM_ONLY)
                    .setNumThreads(2);
            embedder = InterpreterApi.create(model, options);
        } catch (IOException | RuntimeException error) {
            embedderFailed = true;
        }
        return embedder;
    }

    private ByteBuffer loadModel() throws IOException {
        try (AssetFileDescriptor descriptor = getContext().getAssets().openFd(MODEL_ASSET);
             FileInputStream stream = descriptor.createInputStream()) {
            ByteBuffer buffer = ByteBuffer.allocateDirect((int) descriptor.getLength())
                    .order(ByteOrder.nativeOrder());
            readFully(stream, buffer);
            return buffer;
        } catch (IOException compressed) {
            // A compressed asset has no file descriptor; read it as a stream instead.
            try (InputStream stream = getContext().getAssets().open(MODEL_ASSET)) {
                byte[] bytes = readAll(stream);
                ByteBuffer buffer = ByteBuffer.allocateDirect(bytes.length).order(ByteOrder.nativeOrder());
                buffer.put(bytes);
                buffer.rewind();
                return buffer;
            }
        }
    }

    private static void readFully(InputStream stream, ByteBuffer buffer) throws IOException {
        byte[] chunk = new byte[64 * 1024];
        int read;
        while (buffer.hasRemaining() && (read = stream.read(chunk, 0, Math.min(chunk.length, buffer.remaining()))) > 0) {
            buffer.put(chunk, 0, read);
        }
        buffer.rewind();
    }

    private static byte[] readAll(InputStream stream) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[64 * 1024];
        int read;
        while ((read = stream.read(chunk)) > 0) out.write(chunk, 0, read);
        return out.toByteArray();
    }

    private void installModules() throws Exception {
        ensureModules(labeler(), faceDetector(), barcodeScanner());
    }

    /** Installs the given optional Play services modules if needed, waiting for them. */
    private void ensureModules(OptionalModuleApi... apis) throws Exception {
        ModuleInstallClient client = installer();
        ModuleAvailabilityResponse available = Tasks.await(
                client.areModulesAvailable(apis),
                STATUS_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        if (available.areModulesAvailable()) return;

        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> failure = new AtomicReference<>();
        InstallStatusListener listener = update -> {
            int state = update.getInstallState();
            if (state == ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED) {
                done.countDown();
            } else if (state == ModuleInstallStatusUpdate.InstallState.STATE_FAILED
                    || state == ModuleInstallStatusUpdate.InstallState.STATE_CANCELED) {
                failure.set("Model download " + MemoImageFiles.installStateName(state));
                done.countDown();
            }
        };
        ModuleInstallRequest.Builder builder = ModuleInstallRequest.newBuilder().setListener(listener);
        for (OptionalModuleApi api : apis) builder.addApi(api);
        ModuleInstallRequest request = builder.build();
        try {
            ModuleInstallResponse response = Tasks.await(client.installModules(request),
                    PREPARE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (!response.areModulesAlreadyInstalled()
                    && !done.await(PREPARE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                throw new TimeoutException("Model download timed out");
            }
        } finally {
            client.unregisterListener(listener);
        }
        if (failure.get() != null) {
            throw new ModelDownloadException(failure.get());
        }
    }

    private void runControl(PluginCall call, ThrowingRunnable work) {
        ExecutorService executor = controlExecutor;
        if (executor == null || destroyed) {
            call.reject("Auto-organize is shutting down", CODE_INTERRUPTED);
            return;
        }
        try {
            executor.execute(() -> {
                try {
                    work.run();
                } catch (Exception error) {
                    rejectFailure(call, error);
                }
            });
        } catch (RejectedExecutionException error) {
            call.reject("Auto-organize is shutting down", CODE_INTERRUPTED, error);
        }
    }

    private void rejectFailure(PluginCall call, Exception error) {
        Throwable cause = error instanceof ExecutionException && error.getCause() != null
                ? error.getCause() : error;
        if (cause instanceof TimeoutException) {
            call.reject("Analysis took too long", CODE_TIMEOUT);
        } else if (cause instanceof InterruptedException) {
            Thread.currentThread().interrupt();
            call.reject("Analysis was interrupted", CODE_INTERRUPTED);
        } else if (cause instanceof ModelDownloadException) {
            call.reject(cause.getMessage(), CODE_MODEL_DOWNLOAD_FAILED);
        } else if (cause instanceof MlKitException
                && ((MlKitException) cause).getErrorCode() == MlKitException.UNAVAILABLE) {
            call.reject("The analysis models are not ready yet", CODE_MODEL_NOT_READY);
        } else {
            call.reject("Image analysis failed", CODE_INTERNAL,
                    cause instanceof Exception ? (Exception) cause : error);
        }
    }

    static String insightsCode(String toolCode) {
        return toolCode == null ? CODE_INTERNAL : toolCode.replaceFirst("^TOOL_", "INSIGHTS_");
    }

    private JSObject statusResult(String state, boolean modelsAvailable) {
        JSObject result = new JSObject();
        result.put("state", state);
        result.put("models", modelsAvailable);
        result.put("embedder", runtimeReady);
        result.put("version", ANALYZER_VERSION);
        return result;
    }

    private ImageLabeler labeler() {
        synchronized (clientLock) {
            if (labeler == null) {
                labeler = ImageLabeling.getClient(new ImageLabelerOptions.Builder()
                        .setConfidenceThreshold(LABEL_THRESHOLD)
                        .build());
            }
            return labeler;
        }
    }

    private FaceDetector faceDetector() {
        synchronized (clientLock) {
            if (faceDetector == null) {
                faceDetector = FaceDetection.getClient(new FaceDetectorOptions.Builder()
                        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                        .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
                        .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_NONE)
                        .setMinFaceSize(MIN_FACE_SIZE)
                        .build());
            }
            return faceDetector;
        }
    }

    private BarcodeScanner barcodeScanner() {
        synchronized (clientLock) {
            if (barcodeScanner == null) {
                barcodeScanner = BarcodeScanning.getClient(new BarcodeScannerOptions.Builder()
                        .setBarcodeFormats(Barcode.FORMAT_ALL_FORMATS)
                        .build());
            }
            return barcodeScanner;
        }
    }

    /** Accurate mode for blurring: smaller and turned faces matter more than speed. */
    private FaceDetector regionFaceDetector() {
        synchronized (clientLock) {
            if (regionFaceDetector == null) {
                regionFaceDetector = FaceDetection.getClient(new FaceDetectorOptions.Builder()
                        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
                        .setMinFaceSize(0.04f)
                        .build());
            }
            return regionFaceDetector;
        }
    }

    private TextRecognizer textRecognizer() {
        synchronized (clientLock) {
            if (textRecognizer == null) textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
            return textRecognizer;
        }
    }

    private SubjectSegmenter subjectSegmenter() {
        synchronized (clientLock) {
            if (subjectSegmenter == null) {
                subjectSegmenter = SubjectSegmentation.getClient(new SubjectSegmenterOptions.Builder()
                        .enableForegroundBitmap()
                        .enableForegroundConfidenceMask()
                        .build());
            }
            return subjectSegmenter;
        }
    }

    private ModuleInstallClient installer() {
        synchronized (clientLock) {
            if (installer == null) installer = ModuleInstall.getClient(getContext());
            return installer;
        }
    }

    private int playServicesStatus() {
        return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        ExecutorService analysis = analysisExecutor;
        ExecutorService control = controlExecutor;
        ExecutorService tool = toolExecutor;
        analysisExecutor = null;
        controlExecutor = null;
        toolExecutor = null;
        if (control != null) control.shutdownNow();
        if (tool != null) tool.shutdownNow();
        if (analysis != null) {
            // Close the interpreter on its own thread once in-flight work finishes.
            try {
                analysis.execute(() -> {
                    if (embedder != null) embedder.close();
                    embedder = null;
                });
            } catch (RejectedExecutionException ignored) {}
            analysis.shutdown();
        }
        synchronized (clientLock) {
            if (labeler != null) labeler.close();
            if (faceDetector != null) faceDetector.close();
            if (barcodeScanner != null) barcodeScanner.close();
            if (regionFaceDetector != null) regionFaceDetector.close();
            if (textRecognizer != null) textRecognizer.close();
            if (subjectSegmenter != null) subjectSegmenter.close();
            labeler = null;
            faceDetector = null;
            barcodeScanner = null;
            regionFaceDetector = null;
            textRecognizer = null;
            subjectSegmenter = null;
            installer = null;
        }
        super.handleOnDestroy();
    }

    interface ThrowingRunnable {
        void run() throws Exception;
    }

    static final class ModelDownloadException extends Exception {
        ModelDownloadException(String message) {
            super(message);
        }
    }
}
