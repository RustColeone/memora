package com.laplacengan.memora;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.util.Locale;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Theme-aware Android system chrome and three deliberately limited haptics. */
@CapacitorPlugin(name = "NativeUi")
public class NativeUiPlugin extends Plugin {
    private static final int DEFAULT_BACKGROUND = Color.rgb(23, 24, 27);

    private int backgroundColor = DEFAULT_BACKGROUND;
    private int statusBarColor = DEFAULT_BACKGROUND;
    private int navigationBarColor = DEFAULT_BACKGROUND;
    private boolean darkStatusIcons;
    private boolean darkNavigationIcons;
    private boolean hasSystemBarTheme;

    /**
     * Two inset jobs (from ImageDB's ImmersivePlugin), on the WebView's parent:
     *  - Memora draws edge to edge on every version (MainActivity), and an
     *    edge-to-edge window is not resized for the keyboard; WebView 140+
     *    only shrinks its visual viewport, so dialogs stayed under it. The
     *    WebView is lifted above the keyboard instead.
     *  - The edges Android reserves for its Back gesture (zero with 3-button
     *    navigation) go to CSS as --system-gesture-left/right, so the menu swipe
     *    can start at the very edge when nothing else owns it.
     * Insets pass through unchanged: the page reads env(safe-area-inset-*).
     */
    @Override
    public void load() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null || !(webView.getParent() instanceof View)) return;
        View host = (View) webView.getParent();
        host.post(() -> {
            ViewCompat.setOnApplyWindowInsetsListener(host, (view, insets) -> {
                boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
                applyBottomMargin(view, keyboard ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0);
                Insets gestures = insets.getInsets(WindowInsetsCompat.Type.systemGestures());
                injectGestureEdges(webView, gestures.left, gestures.right);
                return ViewCompat.onApplyWindowInsets(view, insets);
            });
            ViewCompat.requestApplyInsets(host);
        });
    }

    private static void applyBottomMargin(View view, int bottom) {
        if (!(view.getLayoutParams() instanceof ViewGroup.MarginLayoutParams)) return;
        ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
        if (params.bottomMargin == bottom) return;
        params.bottomMargin = bottom;
        view.setLayoutParams(params);
    }

    private volatile int gestureLeftDp = -1;
    private volatile int gestureRightDp = -1;

    /** The Back-gesture edges in CSS px; the page asks once it has loaded. */
    @PluginMethod
    public void getGestureEdges(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            // Without edge-to-edge (before Android 15) the system consumes the
            // insets above the WebView's parent, so the listener may never run:
            // read the window's own insets instead.
            if (gestureLeftDp < 0 || gestureRightDp < 0) {
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(getActivity().getWindow().getDecorView());
                if (insets != null) {
                    Insets gestures = insets.getInsets(WindowInsetsCompat.Type.systemGestures());
                    float density = getContext().getResources().getDisplayMetrics().density;
                    gestureLeftDp = Math.round(gestures.left / density);
                    gestureRightDp = Math.round(gestures.right / density);
                }
            }
            JSObject result = new JSObject();
            result.put("left", gestureLeftDp);
            result.put("right", gestureRightDp);
            call.resolve(result);
        });
    }

    private void injectGestureEdges(WebView webView, int left, int right) {
        float density = getContext().getResources().getDisplayMetrics().density;
        gestureLeftDp = Math.round(left / density);
        gestureRightDp = Math.round(right / density);
        String script = String.format(Locale.US,
                "try{var s=document.documentElement.style;"
                        + "s.setProperty('--system-gesture-left','%dpx');"
                        + "s.setProperty('--system-gesture-right','%dpx');}catch(e){}",
                Math.round(left / density), Math.round(right / density));
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    @PluginMethod
    public void setSystemBars(PluginCall call) {
        final int parsedBackground;
        final int parsedStatus;
        final int parsedNavigation;
        try {
            String background = call.getString("backgroundColor", "#17181b");
            parsedBackground = Color.parseColor(background);
            parsedStatus = Color.parseColor(call.getString("statusBarColor", background));
            parsedNavigation = Color.parseColor(call.getString("navigationBarColor", background));
        } catch (IllegalArgumentException | NullPointerException error) {
            call.reject("System bar colors must be valid Android color strings");
            return;
        }

        boolean sharedDarkIcons = call.getBoolean("darkIcons", Boolean.FALSE);
        backgroundColor = parsedBackground;
        statusBarColor = parsedStatus;
        navigationBarColor = parsedNavigation;
        darkStatusIcons = call.getBoolean("darkStatusIcons", sharedDarkIcons);
        darkNavigationIcons = call.getBoolean("darkNavigationIcons", sharedDarkIcons);
        hasSystemBarTheme = true;

        getActivity().runOnUiThread(() -> {
            try {
                applySystemBarTheme();
                call.resolve();
            } catch (Exception error) {
                call.reject("System bar update failed: " + error.getMessage());
            }
        });
    }

    /**
     * The phone's dark mode. Android's WebView keeps reporting
     * prefers-color-scheme: light here, so the web layer's "System" theme
     * asks natively and listens for nightModeChanged.
     */
    @PluginMethod
    public void getNightMode(PluginCall call) {
        JSObject result = new JSObject();
        result.put("dark", isNight(getContext().getResources().getConfiguration()));
        call.resolve(result);
    }

    private static boolean isNight(Configuration configuration) {
        return (configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        JSObject data = new JSObject();
        data.put("dark", isNight(newConfig));
        notifyListeners("nightModeChanged", data);
    }

    @PluginMethod
    public void haptic(PluginCall call) {
        String type = call.getString("type", "");
        final int feedbackConstant;
        switch (type) {
            case "longPress":
                feedbackConstant = HapticFeedbackConstants.LONG_PRESS;
                break;
            case "selection":
                feedbackConstant = HapticFeedbackConstants.CONTEXT_CLICK;
                break;
            case "destructiveSuccess":
                feedbackConstant = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                        ? HapticFeedbackConstants.CONFIRM
                        : HapticFeedbackConstants.CONTEXT_CLICK;
                break;
            default:
                call.reject("Unknown haptic type");
                return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                View target = getActivity().getWindow().getDecorView();
                JSObject result = new JSObject();
                // performHapticFeedback honors Android's touch-feedback preference
                // and needs no VIBRATE permission.
                result.put("performed", target.performHapticFeedback(feedbackConstant));
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Haptic feedback failed: " + error.getMessage());
            }
        });
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!hasSystemBarTheme || getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            try { applySystemBarTheme(); } catch (Exception ignored) {}
        });
    }

    private void applySystemBarTheme() {
        Window window = getActivity().getWindow();
        // Edge to edge on every version: the bars are transparent and the
        // window/WebView background shows through. (The status/navigation bar
        // colour setters are deprecated in Android 15 and not used.)
        window.getDecorView().setBackgroundColor(backgroundColor);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setBackgroundColor(backgroundColor);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(darkStatusIcons);
            controller.setAppearanceLightNavigationBars(darkNavigationIcons);
        }
    }
}
