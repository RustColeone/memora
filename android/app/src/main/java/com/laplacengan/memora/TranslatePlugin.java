package com.laplacengan.memora;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.moduleinstall.InstallStatusListener;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.android.gms.common.moduleinstall.ModuleInstallClient;
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest;
import com.google.android.gms.common.moduleinstall.ModuleInstallResponse;
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.nl.languageid.IdentifiedLanguage;
import com.google.mlkit.nl.languageid.LanguageIdentification;
import com.google.mlkit.nl.languageid.LanguageIdentifier;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.TranslateRemoteModel;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;

import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * On-device translation for the "Translate" image tool. Text recognition runs
 * through MemoOcr; this plugin identifies the language (ML Kit language ID,
 * via Google Play services) and translates with ML Kit Translation, whose
 * per-language models (about 30 MB each) download once on demand and then work
 * offline. No text leaves the phone. Ported from ImageDB.
 */
@CapacitorPlugin(name = "Translate")
public class TranslatePlugin extends Plugin {

    static final int MAX_TEXT_CHARS = 20_000;
    static final long STEP_TIMEOUT_MS = 30_000L;
    static final long DOWNLOAD_TIMEOUT_MS = 300_000L;

    private ExecutorService executor;
    private LanguageIdentifier identifier;

    @Override
    public void load() {
        executor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "Memora-translate");
            thread.setDaemon(true);
            return thread;
        });
    }

    /** Languages ML Kit can translate between, as BCP-47 tags. */
    @PluginMethod
    public void getLanguages(PluginCall call) {
        JSArray out = new JSArray();
        for (String tag : TranslateLanguage.getAllLanguages()) out.put(tag);
        JSObject result = new JSObject();
        result.put("languages", out);
        call.resolve(result);
    }

    /** Most likely language of the text, or "und" when unsure. */
    @PluginMethod
    public void identifyLanguage(PluginCall call) {
        String text = MemoImageFiles.truncate(call.getString("text", ""), MAX_TEXT_CHARS);
        run(call, () -> {
            LanguageIdentifier client = identifier();
            ensureModule(client);
            List<IdentifiedLanguage> candidates = Tasks.await(client.identifyPossibleLanguages(text),
                    STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            String best = "und";
            float confidence = 0f;
            for (IdentifiedLanguage candidate : candidates) {
                if (candidate.getConfidence() > confidence) {
                    confidence = candidate.getConfidence();
                    best = candidate.getLanguageTag();
                }
            }
            JSObject result = new JSObject();
            result.put("language", best);
            result.put("confidence", confidence);
            result.put("supported", TranslateLanguage.fromLanguageTag(best) != null);
            return result;
        });
    }

    /** Whether the model for a language is already on the device. */
    @PluginMethod
    public void getDownloadedModels(PluginCall call) {
        run(call, () -> {
            Set<TranslateRemoteModel> models = Tasks.await(
                    RemoteModelManager.getInstance().getDownloadedModels(TranslateRemoteModel.class),
                    STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            JSArray out = new JSArray();
            for (TranslateRemoteModel model : models) out.put(model.getLanguage());
            JSObject result = new JSObject();
            result.put("languages", out);
            return result;
        });
    }

    /** Translates text, downloading the two language models first if needed. */
    @PluginMethod
    public void translate(PluginCall call) {
        String text = MemoImageFiles.truncate(call.getString("text", ""), MAX_TEXT_CHARS);
        String source = TranslateLanguage.fromLanguageTag(call.getString("source", ""));
        String target = TranslateLanguage.fromLanguageTag(call.getString("target", ""));
        boolean wifiOnly = call.getBoolean("wifiOnly", Boolean.FALSE);
        if (source == null || target == null) {
            call.reject("This language pair is not supported", "TRANSLATE_UNSUPPORTED");
            return;
        }
        run(call, () -> {
            JSObject result = new JSObject();
            if (source.equals(target) || text.trim().isEmpty()) {
                result.put("text", text);
                return result;
            }
            TranslatorOptions options = new TranslatorOptions.Builder()
                    .setSourceLanguage(source).setTargetLanguage(target).build();
            Translator translator = Translation.getClient(options);
            try {
                DownloadConditions.Builder conditions = new DownloadConditions.Builder();
                if (wifiOnly) conditions.requireWifi();
                Tasks.await(translator.downloadModelIfNeeded(conditions.build()),
                        DOWNLOAD_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                // Line by line keeps the layout of receipts, signs and menus.
                StringBuilder out = new StringBuilder();
                for (String line : text.split("\n", -1)) {
                    if (out.length() > 0) out.append('\n');
                    if (line.trim().isEmpty()) continue;
                    out.append(Tasks.await(translator.translate(line), STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS));
                }
                result.put("text", out.toString());
                return result;
            } finally {
                translator.close();
            }
        });
    }

    /** Installs the language-ID module through Play services and waits until it is usable. */
    private void ensureModule(LanguageIdentifier client) throws Exception {
        ModuleInstallClient installer = ModuleInstall.getClient(getContext());
        if (Tasks.await(installer.areModulesAvailable(client), STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .areModulesAvailable()) return;
        CountDownLatch done = new CountDownLatch(1);
        InstallStatusListener listener = update -> {
            int state = update.getInstallState();
            if (state == ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED
                    || state == ModuleInstallStatusUpdate.InstallState.STATE_FAILED
                    || state == ModuleInstallStatusUpdate.InstallState.STATE_CANCELED) done.countDown();
        };
        try {
            ModuleInstallResponse response = Tasks.await(installer.installModules(ModuleInstallRequest.newBuilder()
                    .addApi(client).setListener(listener).build()), DOWNLOAD_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (!response.areModulesAlreadyInstalled() && !done.await(DOWNLOAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                throw new TimeoutException("Language identification download timed out");
            }
        } finally {
            installer.unregisterListener(listener);
        }
    }

    interface Work {
        JSObject run() throws Exception;
    }

    private void run(PluginCall call, Work work) {
        ExecutorService current = executor;
        if (current == null) {
            call.reject("Translation is shutting down", "TRANSLATE_INTERRUPTED");
            return;
        }
        try {
            current.execute(() -> {
                try {
                    call.resolve(work.run());
                } catch (Exception error) {
                    Throwable cause = error instanceof ExecutionException && error.getCause() != null
                            ? error.getCause() : error;
                    if (cause instanceof TimeoutException) {
                        call.reject("Translation took too long", "TRANSLATE_TIMEOUT");
                    } else if (cause instanceof InterruptedException) {
                        Thread.currentThread().interrupt();
                        call.reject("Translation was interrupted", "TRANSLATE_INTERRUPTED");
                    } else {
                        call.reject("Translation failed: " + cause.getMessage(), "TRANSLATE_FAILED");
                    }
                }
            });
        } catch (RejectedExecutionException error) {
            call.reject("Translation is shutting down", "TRANSLATE_INTERRUPTED", error);
        }
    }

    private synchronized LanguageIdentifier identifier() {
        if (identifier == null) identifier = LanguageIdentification.getClient();
        return identifier;
    }

    @Override
    protected void handleOnDestroy() {
        ExecutorService current = executor;
        executor = null;
        if (current != null) current.shutdownNow();
        synchronized (this) {
            if (identifier != null) identifier.close();
            identifier = null;
        }
        super.handleOnDestroy();
    }
}
