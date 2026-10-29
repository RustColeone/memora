package com.laplacengan.memora;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real native WebView startup, filesystem persistence, and old-engine fallback.
 * Run only on a test emulator / isolated QA application. */
@RunWith(AndroidJUnit4.class)
public class StartupInstrumentedTest {
    private String evaluate(MainActivity activity, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> answer = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            activity.getBridge().getWebView().evaluateJavascript(script, value -> {answer.set(value);done.countDown();}));
        // A navigation can replace the JS realm before its callback arrives.
        if (!done.await(5, TimeUnit.SECONDS)) return "navigation-in-progress";
        return answer.get();
    }
    private void waitFor(MainActivity activity, String expression) throws Exception {
        long deadline = System.currentTimeMillis() + 30000;
        while (System.currentTimeMillis() < deadline) {
            if ("true".equals(evaluate(activity, expression))) return;
            Thread.sleep(100);
        }
        throw new AssertionError("Startup condition not reached: " + expression + " " +
            evaluate(activity, "JSON.stringify({path:location.pathname,variant:window.MEMO_VARIANT,editor:!!document.querySelector('#entryDlg[open]'),error:window.__nativeNavigationError})"));
    }
    @Test public void startupKeepsLocalDataAndHandlesUnsupportedWebView() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(intent);
        String key = "native-startup-probe-" + UUID.randomUUID();
        boolean stored = false;
        try {
            waitFor(activity, "location.protocol === 'https:' && !/\\/__native_start_/.test(location.pathname)");
            if ("true".equals(evaluate(activity, "Number((navigator.userAgent.match(/Chrome\\/(\\d+)/)||[])[1]) < 85"))) {
                waitFor(activity, "location.pathname === '/static/webview-update.html' && !!document.querySelector('h1')");
                assertEquals("true", evaluate(activity, "typeof window.MemoStateDb === 'undefined' && !!document.querySelector('a[href*=webview]')"));
                return;
            }
            waitFor(activity, "!!window.MemoAppReady && !!window.MemoStateDb && MemoStateDb.ready() && Capacitor.isNativePlatform()");
            // Exercise the actual mounted section controls in the release realm.
            String originalVariant = evaluate(activity, "window.MEMO_VARIANT || 'default'");
            for (String variant : new String[]{"finance", "planner", "default"}) {
                evaluate(activity, "window.__nativeNavigationDone=false; MemoAppReady.then(function(){return MemoSpaShell.switchTo('" + variant + "');}).then(function(){window.__nativeNavigationDone=true;}).catch(function(e){window.__nativeNavigationError=e.stack||e.message;});");
                waitFor(activity, "window.__nativeNavigationDone === true");
                assertEquals("\"" + variant + "\"", evaluate(activity, "window.MEMO_VARIANT"));
                if (variant.equals("planner")) {
                    assertEquals("true", evaluate(activity, "!!window.Planner"));
                } else {
                    // Finance uses the persistent FAB; its hidden Memo add-card
                    // is not the active section's creation control.
                    evaluate(activity, "document.getElementById('" + (variant.equals("finance") ? "fab" : "addCard") + "').click();");
                    waitFor(activity, "document.getElementById('entryDlg').open === true");
                    evaluate(activity, "document.getElementById('entryDlg').close();window.__nativeDraftCleared=false;MemoDraft.clear().then(function(){window.__nativeDraftCleared=true;});");
                    waitFor(activity, "window.__nativeDraftCleared === true && !document.getElementById('entryDlg').open");
                }
            }
            evaluate(activity, "window.__nativeNavigationDone=false; MemoSpaShell.switchTo(" + originalVariant + ").then(function(){window.__nativeNavigationDone=true;});");
            waitFor(activity, "window.__nativeNavigationDone === true");
            evaluate(activity, "window.__nativeProbeDone = false; MemoAppReady.then(function(){MemoStateDb.setItem('" + key + "', {probe:'preserved'});return MemoStateDb.flush();}).then(function(){window.__nativeProbeDone=true;});");
            waitFor(activity, "window.__nativeProbeDone === true");
            stored = true;
            assertEquals("true", evaluate(activity, "MemoStateDb.getMetadataHealth().status === 'healthy'"));
            // Checking the plugin's actual private file rules out an OPFS/browser fallback.
            evaluate(activity, "window.__nativeFileReady = false; Capacitor.Plugins.Filesystem.stat({path:'MemoSystem/memosystem.sqlite',directory:'DATA'}).then(function(r){window.__nativeFileReady=r.size > 0;});");
            waitFor(activity, "window.__nativeFileReady === true");
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> activity.getBridge().getWebView().reload());
            waitFor(activity, "typeof window.__nativeProbeDone === 'undefined'");
            waitFor(activity, "!!window.MemoStateDb && MemoStateDb.ready()");
            assertEquals("true", evaluate(activity, "MemoStateDb.getItem('" + key + "').probe === 'preserved'"));
        } finally {
            if (stored) {
                evaluate(activity, "window.__nativeCleanupDone=false; MemoStateDb.setItem('" + key + "', null);MemoStateDb.flush().then(function(){window.__nativeCleanupDone=true;});");
                waitFor(activity, "window.__nativeCleanupDone === true");
            }
            InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
        }
    }
}
