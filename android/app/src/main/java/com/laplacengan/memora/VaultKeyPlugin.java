package com.laplacengan.memora;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Fingerprint (or device PIN) unlock for the Vault.
 *
 * The web layer owns the Vault and its random 32-byte vault key. This plugin
 * only seals that key with an Android Keystore AES key that can be used once
 * per user authentication, and opens it again after a BiometricPrompt that is
 * bound to the cipher (a CryptoObject): without a successful fingerprint or
 * device credential the Keystore refuses to decrypt. Enrolling a new
 * fingerprint invalidates the key; the Vault then asks for its password once
 * and seals the key again. The sealed blob is stored by the web layer on this
 * device only; Keystore keys never leave the phone, so a restored backup can
 * only be opened with the Vault password.
 */
@CapacitorPlugin(name = "VaultKey")
public class VaultKeyPlugin extends Plugin {

    private static final String KEY_ALIAS = "memora_vault_key";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private final Object promptLock = new Object();
    private PluginCall pendingCall;

    /** Strong biometrics everywhere; on Android 11+ the device credential too. */
    private static int promptAuthenticators() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return BiometricManager.Authenticators.BIOMETRIC_STRONG
                    | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        }
        return BiometricManager.Authenticators.BIOMETRIC_STRONG;
    }

    private int availability() {
        return BiometricManager.from(getContext()).canAuthenticate(promptAuthenticators());
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    private static SecretKey existingKey() throws Exception {
        KeyStore.Entry entry = keyStore().getEntry(KEY_ALIAS, null);
        return entry instanceof KeyStore.SecretKeyEntry ? ((KeyStore.SecretKeyEntry) entry).getSecretKey() : null;
    }

    private static SecretKey createKey() throws Exception {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // 0 = every use needs its own authentication (the CryptoObject).
            spec.setUserAuthenticationParameters(0,
                    KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(spec.build());
        return generator.generateKey();
    }

    private static void deleteKey() {
        try { keyStore().deleteEntry(KEY_ALIAS); } catch (Exception ignored) { }
    }

    @PluginMethod
    public void status(PluginCall call) {
        int status = availability();
        JSObject result = new JSObject();
        result.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        result.put("status", status);
        boolean hasKey;
        try { hasKey = existingKey() != null; } catch (Exception e) { hasKey = false; }
        result.put("hasKey", hasKey);
        call.resolve(result);
    }

    /** Seal { secret: base64 } after authentication; resolves { iv, data } (base64). */
    @PluginMethod
    public void protect(PluginCall call) {
        String secret = call.getString("secret");
        if (secret == null || secret.isEmpty()) { call.reject("secret is required"); return; }
        final byte[] plain;
        try { plain = Base64.decode(secret, Base64.NO_WRAP); } catch (IllegalArgumentException e) { call.reject("secret must be base64"); return; }
        Cipher cipher;
        try {
            // A fresh key each time protection is turned on, so an old sealed
            // blob can never be opened again after it is replaced.
            deleteKey();
            cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, createKey());
        } catch (Exception error) {
            call.reject("Fingerprint unlock is not available: " + error.getMessage(), "VAULT_KEY_UNAVAILABLE");
            return;
        }
        final Cipher sealing = cipher;
        prompt(call, sealing, call.getString("title", "Use fingerprint for the Vault"), (authenticated) -> {
            byte[] sealed = authenticated.doFinal(plain);
            JSObject result = new JSObject();
            result.put("iv", Base64.encodeToString(authenticated.getIV(), Base64.NO_WRAP));
            result.put("data", Base64.encodeToString(sealed, Base64.NO_WRAP));
            return result;
        });
    }

    /** Open { iv, data } after authentication; resolves { secret } or { invalidated: true }. */
    @PluginMethod
    public void reveal(PluginCall call) {
        String iv = call.getString("iv"), data = call.getString("data");
        if (iv == null || data == null) { call.reject("iv and data are required"); return; }
        final byte[] sealed;
        Cipher cipher;
        try {
            sealed = Base64.decode(data, Base64.NO_WRAP);
            SecretKey key = existingKey();
            if (key == null) { resolveInvalidated(call); return; }
            cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        } catch (KeyPermanentlyInvalidatedException invalidated) {
            // A fingerprint was added or the screen lock removed: the key is gone for good.
            deleteKey();
            resolveInvalidated(call);
            return;
        } catch (Exception error) {
            call.reject("Fingerprint unlock failed: " + error.getMessage(), "VAULT_KEY_UNAVAILABLE");
            return;
        }
        prompt(call, cipher, call.getString("title", "Unlock the Vault"), (authenticated) -> {
            JSObject result = new JSObject();
            result.put("secret", Base64.encodeToString(authenticated.doFinal(sealed), Base64.NO_WRAP));
            return result;
        });
    }

    @PluginMethod
    public void forget(PluginCall call) {
        deleteKey();
        call.resolve();
    }

    private static void resolveInvalidated(PluginCall call) {
        JSObject result = new JSObject();
        result.put("invalidated", true);
        call.resolve(result);
    }

    private interface CipherWork { JSObject run(Cipher cipher) throws Exception; }

    private void prompt(PluginCall call, Cipher cipher, String title, CipherWork work) {
        FragmentActivity activity = getActivity() instanceof FragmentActivity ? (FragmentActivity) getActivity() : null;
        if (activity == null) { call.reject("Fingerprint unlock needs an active screen"); return; }
        if (availability() != BiometricManager.BIOMETRIC_SUCCESS) {
            call.reject("Set up a fingerprint or screen lock to use this", "VAULT_KEY_UNAVAILABLE");
            return;
        }
        synchronized (promptLock) {
            if (pendingCall != null) { call.reject("Another unlock is already in progress"); return; }
            pendingCall = call;
        }
        BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        PluginCall finished = takePending();
                        if (finished == null) return;
                        BiometricPrompt.CryptoObject crypto = result.getCryptoObject();
                        try {
                            if (crypto == null || crypto.getCipher() == null) throw new IllegalStateException("No unlocked key");
                            finished.resolve(work.run(crypto.getCipher()));
                        } catch (Exception error) {
                            finished.reject("Fingerprint unlock failed: " + error.getMessage(), "VAULT_KEY_FAILED");
                        }
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence message) {
                        PluginCall finished = takePending();
                        if (finished == null) return;
                        JSObject result = new JSObject();
                        result.put("cancelled", true);
                        result.put("errorCode", errorCode);
                        result.put("errorMessage", String.valueOf(message));
                        finished.resolve(result);
                    }
                });
        activity.runOnUiThread(() -> {
            BiometricPrompt.CryptoObject crypto = new BiometricPrompt.CryptoObject(cipher);
            try {
                prompt.authenticate(promptInfo(title, promptAuthenticators()), crypto);
            } catch (IllegalArgumentException unsupported) {
                // Some versions refuse a device credential with a CryptoObject:
                // fall back to strong biometrics only (the key accepts both).
                try {
                    prompt.authenticate(promptInfo(title, BiometricManager.Authenticators.BIOMETRIC_STRONG), crypto);
                } catch (Exception error) {
                    PluginCall finished = takePending();
                    if (finished != null) finished.reject("Unable to start fingerprint unlock: " + error.getMessage());
                }
            } catch (Exception error) {
                PluginCall finished = takePending();
                if (finished != null) finished.reject("Unable to start fingerprint unlock: " + error.getMessage());
            }
        });
    }

    private BiometricPrompt.PromptInfo promptInfo(String title, int authenticators) {
        BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setConfirmationRequired(false)
                .setAllowedAuthenticators(authenticators);
        // A negative button is required whenever the device credential is not allowed.
        if ((authenticators & BiometricManager.Authenticators.DEVICE_CREDENTIAL) == 0) {
            info.setNegativeButtonText(getContext().getString(android.R.string.cancel));
        }
        return info.build();
    }

    @Override
    protected void handleOnDestroy() {
        PluginCall pending = takePending();
        if (pending != null) pending.reject("Fingerprint unlock was interrupted");
        super.handleOnDestroy();
    }

    private PluginCall takePending() {
        synchronized (promptLock) {
            PluginCall call = pendingCall;
            pendingCall = null;
            return call;
        }
    }
}
