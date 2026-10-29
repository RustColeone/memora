package com.laplacengan.memora;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.TextRecognizerOptionsInterface;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions;
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * On-device text recognition (ML Kit, unbundled Play Services models).
 *
 * Deliberately storage-agnostic: the web layer resolves any image (blob, upload,
 * app-private) to a downscaled base64 JPEG/PNG and passes it in, so this plugin
 * never has to know how Memora stores media. Each script family has its own model
 * (Latin, Chinese, Japanese, Korean — the CJK recognizers also read Latin); a
 * request may ask for several and we return the one that read the most text, which
 * gives a usable "auto" without the caller having to detect the script first.
 * Models download on first use via Play Services (no APK bloat).
 */
@CapacitorPlugin(name = "MemoOcr")
public class MemoOcrPlugin extends Plugin {

    private static final long PROCESS_TIMEOUT_MS = 30000L;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private static String normalizeLanguage(String language) {
        if ("chinese".equals(language) || "japanese".equals(language) || "korean".equals(language)) return language;
        return "latin";
    }

    private static TextRecognizerOptionsInterface optionsForLanguage(String language) {
        switch (language) {
            case "chinese":  return new ChineseTextRecognizerOptions.Builder().build();
            case "japanese": return new JapaneseTextRecognizerOptions.Builder().build();
            case "korean":   return new KoreanTextRecognizerOptions.Builder().build();
            default:         return TextRecognizerOptions.DEFAULT_OPTIONS;
        }
    }

    @PluginMethod
    public void getAvailability(PluginCall call) {
        // The plugin (and thus native ML Kit) is present on Android; models fetch
        // on demand. The web build has no plugin, so it simply never calls this.
        JSObject result = new JSObject();
        result.put("available", true);
        call.resolve(result);
    }

    @PluginMethod
    public void recognize(PluginCall call) {
        final String b64 = call.getString("imageBase64", "");
        if (b64 == null || b64.isEmpty()) { call.reject("imageBase64 is required"); return; }

        // Which script(s) to try. A single "language", an array of "languages", or
        // (default) auto: Latin + Chinese + Japanese.
        final List<String> langs = new ArrayList<>();
        JSArray arr = call.getArray("languages", null);
        if (arr != null) {
            try { List<String> list = arr.toList(); for (String v : list) if (v != null) langs.add(normalizeLanguage(v)); }
            catch (Exception ignored) {}
        }
        String single = call.getString("language", null);
        if (langs.isEmpty() && single != null) langs.add(normalizeLanguage(single));
        if (langs.isEmpty()) { langs.add("latin"); langs.add("chinese"); langs.add("japanese"); }
        // lines: also return each line with its position, so a receipt's rows
        // (name on the left, price on the right) can be put back together.
        final boolean withLines = Boolean.TRUE.equals(call.getBoolean("lines", false));

        executor.execute(() -> {
            Bitmap bmp = null;
            try {
                String clean = b64.contains(",") ? b64.substring(b64.indexOf(',') + 1) : b64;
                byte[] bytes = Base64.decode(clean, Base64.DEFAULT);
                bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp == null) { call.reject("The image could not be decoded"); return; }
                InputImage input = InputImage.fromBitmap(bmp, 0);

                String bestText = "";
                String bestLang = "latin";
                Text bestResult = null;
                JSObject perLang = new JSObject();
                String lastError = null;
                for (String lang : langs) {
                    TextRecognizer recognizer = TextRecognition.getClient(optionsForLanguage(lang));
                    try {
                        Text result = Tasks.await(recognizer.process(input), PROCESS_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                        String text = (result == null || result.getText() == null) ? "" : result.getText();
                        perLang.put(lang, text);
                        if (text.length() > bestText.length()) { bestText = text; bestLang = lang; bestResult = result; }
                    } catch (Exception error) {
                        lastError = error.getMessage();   // model may still be downloading, or Play Services missing
                    } finally {
                        try { recognizer.close(); } catch (Exception ignored) {}
                    }
                }

                if (bestText.isEmpty() && perLang.length() == 0) {
                    call.reject(lastError != null ? lastError : "Text recognition is unavailable");
                    return;
                }
                JSObject response = new JSObject();
                response.put("text", bestText);
                response.put("language", bestLang);
                response.put("results", perLang);
                if (withLines && bestResult != null) {
                    JSArray lines = new JSArray();
                    for (Text.TextBlock block : bestResult.getTextBlocks()) {
                        for (Text.Line line : block.getLines()) {
                            Rect box = line.getBoundingBox();
                            if (box == null) continue;
                            JSObject l = new JSObject();
                            l.put("text", line.getText());
                            l.put("left", box.left);
                            l.put("top", box.top);
                            l.put("right", box.right);
                            l.put("bottom", box.bottom);
                            lines.put(l);
                        }
                    }
                    response.put("lines", lines);
                    response.put("width", bmp.getWidth());
                    response.put("height", bmp.getHeight());
                }
                call.resolve(response);
            } catch (Exception error) {
                call.reject("OCR failed: " + error.getMessage());
            } finally {
                if (bmp != null && !bmp.isRecycled()) bmp.recycle();
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        try { executor.shutdownNow(); } catch (Exception ignored) {}
        super.handleOnDestroy();
    }
}
