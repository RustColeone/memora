package com.laplacengan.memora;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.view.Window;
import android.view.WindowManager;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;

/**
 * Native half of Memora's privacy gate.
 *
 * Unlike ImageDB's single global level, Memora keeps a level PER VARIANT
 * (memo / finance / planner) because each page can be gated independently:
 *   - memo:    1 (open) · 2 (Safe) · 3 (locked)
 *   - finance: 1 (open) · 3 (locked)
 *   - planner: 1 (open) · 3 (locked)
 *
 * This plugin owns no entry data and performs no encryption. It exposes the
 * system biometric/device-credential prompt, persists the per-variant levels
 * for cold-start window policy, and controls FLAG_SECURE. The web layer filters
 * Safe entries, decides which variant needs unlocking, and presents the lock UI;
 * Android owns authentication and screenshot/task-snapshot policy.
 *
 * FLAG_SECURE policy is deliberately conservative: the window is secured whenever
 * ANY variant is Level 3 (or the web requests it for an open Safe view). A shared
 * WebView window can't cheaply scope screenshot protection to the active variant,
 * so privacy wins over the minor inconvenience of a secured non-private page.
 */
@CapacitorPlugin(name = "Privacy")
public class PrivacyPlugin extends Plugin {

    static final int PRIVACY_LEVEL_OPEN = 1;
    static final int PRIVACY_LEVEL_SAFE = 2;
    static final int PRIVACY_LEVEL_LOCKED = 3;

    static final String[] VARIANTS = { "memo", "finance", "planner" };

    private static final String PREFS_NAME = "memora_privacy";
    private static final String PREF_LEVEL_PREFIX = "level_";
    private static final int AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_WEAK
                    | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private final Object authenticationLock = new Object();
    private PluginCall pendingAuthentication;

    static boolean isKnownVariant(String variant) {
        for (String v : VARIANTS) if (v.equals(variant)) return true;
        return false;
    }

    /** Only memo may be Level 2 (Safe); finance/planner are open or locked. */
    static boolean isValidLevel(String variant, int level) {
        if (level < PRIVACY_LEVEL_OPEN || level > PRIVACY_LEVEL_LOCKED) return false;
        return !(level == PRIVACY_LEVEL_SAFE && !"memo".equals(variant));
    }

    static int getStoredLevel(Context context, String variant) {
        int stored = preferences(context).getInt(PREF_LEVEL_PREFIX + variant, PRIVACY_LEVEL_OPEN);
        return isValidLevel(variant, stored) ? stored : PRIVACY_LEVEL_OPEN;
    }

    static boolean anyVariantLocked(Context context) {
        for (String v : VARIANTS) {
            if (getStoredLevel(context, v) == PRIVACY_LEVEL_LOCKED) return true;
        }
        return false;
    }

    /** Apply the persisted cold-start policy before the WebView paints. */
    static void applyStoredPrivacyLevel(FragmentActivity activity) {
        applySecureScreen(activity.getWindow(), anyVariantLocked(activity));
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static void applySecureScreen(Window window, boolean enabled) {
        if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    /**
     * Android 11+ can evaluate the exact authenticator combination directly.
     * On Android 7-10, a secure keyguard is sufficient because PromptInfo uses
     * the AndroidX device-credential compatibility path; otherwise fall back to
     * the enrolled-biometric result.
     */
    private static int authenticationStatus(Context context) {
        BiometricManager manager = BiometricManager.from(context);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return manager.canAuthenticate(AUTHENTICATORS);
        }
        KeyguardManager keyguard =
                (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        if (keyguard != null && keyguard.isDeviceSecure()) {
            return BiometricManager.BIOMETRIC_SUCCESS;
        }
        return manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK);
    }

    private static JSObject levelsObject(Context context) {
        JSObject levels = new JSObject();
        for (String v : VARIANTS) levels.put(v, getStoredLevel(context, v));
        return levels;
    }

    @PluginMethod
    public void getAvailability(PluginCall call) {
        int status = authenticationStatus(getContext());
        KeyguardManager keyguard =
                (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);

        JSObject result = new JSObject();
        result.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        result.put("status", status);
        result.put("deviceCredentialAvailable", keyguard != null && keyguard.isDeviceSecure());
        result.put("levels", levelsObject(getContext()));
        result.put("secureScreen", anyVariantLocked(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        int status = authenticationStatus(getContext());
        if (status != BiometricManager.BIOMETRIC_SUCCESS) {
            JSObject result = new JSObject();
            result.put("authenticated", false);
            result.put("errorCode", status);
            result.put("errorMessage", "Device authentication is not available");
            call.resolve(result);
            return;
        }

        FragmentActivity activity = getActivity() instanceof FragmentActivity
                ? (FragmentActivity) getActivity() : null;
        if (activity == null) {
            call.reject("Privacy authentication requires a FragmentActivity");
            return;
        }

        synchronized (authenticationLock) {
            if (pendingAuthentication != null) {
                call.reject("Another privacy authentication is already in progress");
                return;
            }
            pendingAuthentication = call;
        }

        String title = call.getString("title", "Unlock Memora");
        String subtitle = call.getString("subtitle", "Use your biometrics or device screen lock");
        Executor executor = ContextCompat.getMainExecutor(activity);
        BiometricPrompt prompt = new BiometricPrompt(activity, executor,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(
                            BiometricPrompt.AuthenticationResult authenticationResult) {
                        super.onAuthenticationSucceeded(authenticationResult);
                        PluginCall finished = takePendingAuthentication();
                        if (finished == null) return;
                        JSObject result = new JSObject();
                        result.put("authenticated", true);
                        result.put("authenticationType",
                                authenticationResult.getAuthenticationType());
                        finished.resolve(result);
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence errorMessage) {
                        super.onAuthenticationError(errorCode, errorMessage);
                        PluginCall finished = takePendingAuthentication();
                        if (finished == null) return;
                        JSObject result = new JSObject();
                        result.put("authenticated", false);
                        result.put("errorCode", errorCode);
                        result.put("errorMessage", String.valueOf(errorMessage));
                        finished.resolve(result);
                    }
                });

        BiometricPrompt.PromptInfo.Builder promptInfo =
                new BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title)
                        .setSubtitle(subtitle)
                        .setConfirmationRequired(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            promptInfo.setAllowedAuthenticators(AUTHENTICATORS);
        } else {
            promptInfo.setDeviceCredentialAllowed(true);
        }

        activity.runOnUiThread(() -> {
            try {
                prompt.authenticate(promptInfo.build());
            } catch (Exception error) {
                PluginCall finished = takePendingAuthentication();
                if (finished != null) {
                    finished.reject("Unable to start device authentication: "
                            + error.getMessage());
                }
            }
        });
    }

    @PluginMethod
    public void setSecureScreen(PluginCall call) {
        Boolean requested = call.getBoolean("enabled");
        if (requested == null) {
            call.reject("enabled must be true or false");
            return;
        }
        // A locked variant always keeps the window secure even if a stale web
        // caller asks to clear it.
        final boolean enabled = requested || anyVariantLocked(getContext());
        FragmentActivity activity = getActivity() instanceof FragmentActivity
                ? (FragmentActivity) getActivity() : null;
        if (activity == null) {
            call.reject("Screenshot protection requires an active FragmentActivity");
            return;
        }
        activity.runOnUiThread(() -> {
            applySecureScreen(activity.getWindow(), enabled);
            JSObject result = new JSObject();
            result.put("enabled", enabled);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setVariantLevel(PluginCall call) {
        String variant = call.getString("variant", "");
        Integer requested = call.getInt("level");
        if (!isKnownVariant(variant)) {
            call.reject("variant must be one of memo, finance, planner");
            return;
        }
        if (requested == null || !isValidLevel(variant, requested)) {
            call.reject(variant + " level must be "
                    + ("memo".equals(variant) ? "1, 2, or 3" : "1 or 3"));
            return;
        }
        FragmentActivity activity = getActivity() instanceof FragmentActivity
                ? (FragmentActivity) getActivity() : null;
        if (activity == null) {
            call.reject("Changing the privacy level requires an active FragmentActivity");
            return;
        }
        if (!preferences(getContext()).edit()
                .putInt(PREF_LEVEL_PREFIX + variant, requested).commit()) {
            call.reject("Privacy level could not be persisted");
            return;
        }

        final boolean secure = anyVariantLocked(getContext());
        activity.runOnUiThread(() -> {
            applySecureScreen(activity.getWindow(), secure);
            JSObject result = new JSObject();
            result.put("levels", levelsObject(getContext()));
            result.put("secureScreen", secure);
            call.resolve(result);
        });
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        FragmentActivity activity = getActivity() instanceof FragmentActivity
                ? (FragmentActivity) getActivity() : null;
        if (activity == null) return;
        // Any locked variant re-secures the window on resume. When nothing is
        // locked, a Safe view (Level 2) may still be holding FLAG_SECURE — leave
        // that to the web lifecycle callback, which closes Safe and clears it as
        // the app actually backgrounds.
        if (anyVariantLocked(getContext())) {
            applySecureScreen(activity.getWindow(), true);
        }
    }

    @Override
    protected void handleOnDestroy() {
        PluginCall pending = takePendingAuthentication();
        if (pending != null) pending.reject("Privacy authentication was interrupted");
        super.handleOnDestroy();
    }

    private PluginCall takePendingAuthentication() {
        synchronized (authenticationLock) {
            PluginCall call = pendingAuthentication;
            pendingAuthentication = null;
            return call;
        }
    }
}
