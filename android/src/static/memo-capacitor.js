// This is the shared Capacitor bootstrap used by both web templates and the native builds.
// It mirrors android/src/static/memo-capacitor.js so you can copy between locations.
(function(){
	var C = window.Capacitor;
	var isNative = !!C && ((typeof C.isNativePlatform === 'function' && C.isNativePlatform()) ||
												 (typeof C.getPlatform === 'function' && (C.getPlatform() === 'android' || C.getPlatform() === 'ios')));
	// Public flags other scripts can check
	window.__CAP_MODE__ = !!isNative;

	// Determine variant
	var variantMeta = document.querySelector('meta[name="memo-variant"]');
	var variant = (variantMeta && variantMeta.content) || 'default';

	// Inject CSS & load JS primarily when running inside Capacitor (non http/https)
	try {
		var hasServer = location.protocol === 'http:' || location.protocol === 'https:';
		// When running inside native, apps may use capacitor:// or file://; use relative 'static/'
		var STATIC_BASE = hasServer ? '/static/' : 'static/';

		// Only auto-inject when we're in native; avoid double-loading on server
		if (window.__CAP_MODE__) {
			// CSS
			var cssFiles = ['memo.css'];
			if (variant === 'finance') cssFiles.push('memo-finance.css');
			cssFiles.forEach(function(f){
				var l = document.createElement('link');
				l.rel = 'stylesheet';
				l.href = STATIC_BASE + f;
				document.head.appendChild(l);
			});

			// JS (sequential)
			var files = [
				'memo-core.js',
				variant === 'finance' ? 'memo-variant-finance.js' : 'memo-variant-default.js',
				'memo-filter.js',
				'memo-lightbox.js',
			];
			function loadSeq(i){
				if (i >= files.length) return;
				var s = document.createElement('script');
				s.src = STATIC_BASE + files[i];
				s.onload = function(){ loadSeq(i+1); };
				document.body.appendChild(s);
			}
			loadSeq(0);
		}
	} catch (e) {
		// eslint-disable-next-line no-console
		console.log('Capacitor bootstrap error', e);
	}

	// Hide Capacitor Splash Screen once DOM is ready
	function hideSplash(){
		try {
			if (!isNative) return;
			var splash = (C && C.Plugins && C.Plugins.SplashScreen) || (C && C.SplashScreen);
			if (splash && typeof splash.hide === 'function') {
				setTimeout(function(){ splash.hide(); }, 50);
			}
		} catch (e) {
			// eslint-disable-next-line no-console
			console.log('Splash hide error', e);
		}
	}
	if (document.readyState === 'complete' || document.readyState === 'interactive') {
		hideSplash();
	} else {
		document.addEventListener('DOMContentLoaded', hideSplash);
	}
})();

