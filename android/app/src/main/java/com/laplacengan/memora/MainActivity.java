package com.laplacengan.memora;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.util.Log;
import android.view.ViewGroup;
import androidx.annotation.RequiresApi;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.ProcessedRoute;
import com.getcapacitor.WebViewListener;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final String LIFECYCLE_TAG = "MemoraLifecycle";
    private boolean recoveringRenderer;

	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(ClipboardImagePlugin.class);
		registerPlugin(ShareReceiverPlugin.class);
		registerPlugin(NativeUiPlugin.class);
		registerPlugin(PrivacyPlugin.class);
		registerPlugin(MemoOcrPlugin.class);
		registerPlugin(GallerySavePlugin.class);
		registerPlugin(FileSharePlugin.class);
		registerPlugin(PlannerRemindersPlugin.class);
		registerPlugin(ImageInsightsPlugin.class);
		registerPlugin(DocumentScannerPlugin.class);
		registerPlugin(TranslatePlugin.class);
		registerPlugin(VaultKeyPlugin.class);
		registerPlugin(QrScannerPlugin.class);
		registerPlugin(ModsPlugin.class);
		// Draw edge to edge on every Android version, not only where Android 15+
		// enforces it, so no deprecated status/navigation bar colour API is used:
		// the bars are transparent over the theme background, and the page pads
		// itself with env(safe-area-inset-*). NativeUi keeps the WebView above
		// the keyboard, which an edge-to-edge window no longer resizes for.
		WindowCompat.enableEdgeToEdge(getWindow());
		// Light bar icons from the first frame, matching the dark launch theme;
		// the web layer switches them for the light theme.
		WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
		bars.setAppearanceLightStatusBars(false);
		bars.setAppearanceLightNavigationBars(false);
		// Apply the persisted cold-start screenshot policy before the WebView
		// paints, so a locked variant never leaks into the task snapshot.
		PrivacyPlugin.applyStoredPrivacyLevel(this);
		super.onCreate(savedInstanceState);
		// Honour the page's viewport tag (every page sets width=device-width), so
		// memo-viewport.js can draw phones in landscape at a smaller scale.
		getBridge().getWebView().getSettings().setUseWideViewPort(true);
		Log.i(LIFECYCLE_TAG, "activity-create restored=" + (savedInstanceState != null));
		handleShareIntent(getIntent());
	}

	@Override
	protected void load() {
		PreparedWebView webView = findViewById(com.getcapacitor.android.R.id.webview);
		bridgeBuilder.setRouteProcessor((basePath, path) -> {
			ProcessedRoute route = new ProcessedRoute();
			boolean preparation = path.equals(webView.getPreparationPath());
			route.setPath(preparation ? "native-start.html" : basePath + path);
			route.setAsset(true);
			route.setIgnoreAssetPath(preparation);
			return route;
		});
		webView.addJavascriptInterface(new Object() {
			@JavascriptInterface public void ready() {
				runOnUiThread(() -> {
					if (isFinishing() || isDestroyed()) return;
					Log.i(LIFECYCLE_TAG, "packaged-shell-ready");
					webView.finishPreparation();
				});
			}
		}, "NativeShell");
		// Register Capacitor's activity-result handlers during onCreate as required.
		// Only its initial document waits for worker retirement, not the bridge.
		super.load();
		getBridge().addWebViewListener(new WebViewListener() {
			@Override public void onPageLoaded(WebView view) {
				((PreparedWebView) view).onPreparedPageLoaded();
			}
			@RequiresApi(Build.VERSION_CODES.O)
			@Override
			public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
				Log.w(LIFECYCLE_TAG, "renderer-gone crash=" + detail.didCrash()
					+ " priority=" + detail.rendererPriorityAtExit());
				if (!recoveringRenderer) {
					recoveringRenderer = true;
					// A terminated WebView cannot be reused. Recreate the bridge;
					// local data, drafts and the saved view drive the next document.
					if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
					view.destroy();
					runOnUiThread(() -> recreate());
				}
				return true;
			}
		});
		keepRendererAliveWhileBackgrounded();
	}

	/** Reassert Android's default priority; renderer survival is not guaranteed. */
	private void keepRendererAliveWhileBackgrounded() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;   // API 26+
		try {
			WebView webView = getBridge() != null ? getBridge().getWebView() : null;
			if (webView == null) return;
			webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
		} catch (Throwable ignored) {
			// Some WebView implementations don't support the policy; the default
			// behaviour (and the page-reload path) still works.
		}
	}

	@Override
	public void onResume() {
		super.onResume();
		Log.i(LIFECYCLE_TAG, "activity-resume");
		// Re-assert on every resume: a WebView whose renderer was replaced comes
		// back with the default policy.
		keepRendererAliveWhileBackgrounded();
	}

	@Override
	public void onStop() {
		Log.i(LIFECYCLE_TAG, "activity-stop");
		super.onStop();
	}

	@Override
	public void onDestroy() {
		Log.i(LIFECYCLE_TAG, "activity-destroy changingConfig=" + isChangingConfigurations());
		super.onDestroy();
	}

	@Override
	protected void onNewIntent(Intent intent) {
		super.onNewIntent(intent);
		// Keep the newest grant-carrying Intent attached to the task. Android's
		// temporary read grant remains valid while this receiving Activity task is
		// alive; the private persisted inbox below bridges process recreation within
		// that task. It intentionally does not promise access after task dismissal or
		// device reboot, when the provider may revoke its grant.
		setIntent(intent);
		boolean incomingShare = handleShareIntent(intent);
		// Reopening from the launcher is not a share. Dispatching this event for
		// ACTION_MAIN can navigate the WebView and destroy its retained editor.
		if (incomingShare && getBridge() != null) getBridge().triggerWindowJSEvent("memoShareReceived", "{}");
	}

	private boolean handleShareIntent(Intent intent) {
		if (intent == null) return false;
		String action = intent.getAction();
		if (!ShareIntentSupport.isShareAction(action)) return false;

		Uri single = null;
		List<Uri> multiple = new ArrayList<>();
		if (Intent.ACTION_SEND.equals(action)) {
			single = intent.getParcelableExtra(Intent.EXTRA_STREAM);
		} else {
			ArrayList<Uri> extra = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
			if (extra != null) multiple.addAll(extra);
		}
		// Some sharing apps provide content through ClipData rather than EXTRA_STREAM.
		List<Uri> clipFiles = new ArrayList<>();
		ClipData clip = intent.getClipData();
		if (clip != null) {
			for (int i = 0; i < clip.getItemCount(); i++) {
				Uri uri = clip.getItemAt(i).getUri();
				if (uri != null) clipFiles.add(uri);
			}
		}
		List<Uri> files = ShareIntentSupport.collectUris(single, multiple, clipFiles);

		String text = intent.getStringExtra(Intent.EXTRA_TEXT);
		if (files.isEmpty() && (text == null || text.trim().isEmpty())) return false;
		ShareReceiverPlugin.setPendingShare(getApplicationContext(), files, text, intent.getType());
		return true;
	}
}
