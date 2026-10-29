package com.laplacengan.memora;

import android.content.Context;
import android.util.AttributeSet;
import android.net.Uri;
import com.getcapacitor.CapacitorWebView;
import java.util.UUID;

/** Keep Capacitor initialization synchronous, but prepare its first document. */
public class PreparedWebView extends CapacitorWebView {
    private final String preparationPath = "/__native_start_" + UUID.randomUUID() + ".html";
    private String destination;
    private boolean prepared;
    private boolean historyCleaned;

    public PreparedWebView(Context context, AttributeSet attrs) { super(context, attrs); }
    public String getPreparationPath() { return preparationPath; }

    @Override public void loadUrl(String url) {
        if (!prepared && destination == null) {
            destination = url;
            super.loadUrl(Uri.parse(url).buildUpon().path(preparationPath).clearQuery().fragment(null).build().toString());
        } else { super.loadUrl(url); }
    }

    public void finishPreparation() {
        if (prepared || destination == null) return;
        prepared = true;
        removeJavascriptInterface("NativeShell");
        super.loadUrl(destination);
    }

    public void onPreparedPageLoaded() {
        if (!prepared || historyCleaned || getUrl() == null || getUrl().contains(preparationPath)) return;
        historyCleaned = true;
        clearHistory(); // Android Back must never return to the startup document.
    }
}
