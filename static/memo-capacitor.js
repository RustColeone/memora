// This is the shared Capacitor bootstrap used by both web templates and the native builds.
// It mirrors android/src/static/memo-capacitor.js so you can copy between locations.
(function(){
	var C = window.Capacitor;
	var protocol = location.protocol;
	var host = (location.hostname || '').toLowerCase();
	var isLocalhostHost = host === 'localhost' || host === '127.0.0.1';
	var capPlatform = (typeof C?.getPlatform === 'function') ? C.getPlatform() : '';
	var capSaysNative = !!C && (
		(typeof C.isNativePlatform === 'function' && C.isNativePlatform()) ||
		(capPlatform === 'android' || capPlatform === 'ios')
	);
	var protocolImpliesNative = protocol === 'capacitor:' || protocol === 'ionic:' || protocol === 'file:';
	var localhostWebview = protocol === 'https:' && isLocalhostHost;
	var isNative = capSaysNative && (protocolImpliesNative || localhostWebview);
	// Public flags other scripts can check
	window.__CAP_MODE__ = !!isNative;
	if (window.__CAP_MODE__) {
		document.documentElement.classList.add('cap-mode');
		if (document.body) {
			document.body.classList.add('cap-mode');
		} else {
			document.addEventListener('DOMContentLoaded', function () {
				document.body.classList.add('cap-mode');
			}, { once: true });
		}
	}

	// Determine variant
	var variantMeta = document.querySelector('meta[name="memo-variant"]');
	var variantFromMeta = (variantMeta && variantMeta.content) || 'default';
	var variantFromStorage = (localStorage.getItem('memo_variant') || '').trim().toLowerCase();
	var variant = (variantFromStorage === 'finance' || variantFromStorage === 'default')
		? variantFromStorage
		: ((variantFromMeta === 'finance' || variantFromMeta === 'default') ? variantFromMeta : 'default');
	window.MEMO_VARIANT = variant;

	function applyVariantBrandUi() {
		if (!window.__CAP_MODE__) return;
		var current = (window.MEMO_VARIANT || 'default').toLowerCase();
		var brandBtn = document.querySelector('.brand-dropdown .brand');
		if (brandBtn) {
			brandBtn.textContent = current === 'finance' ? '💸 Finance ▾' : '🗂️ Memo ▾';
		}
		var brandMenu = document.getElementById('brandMenu');
		if (brandMenu) {
			var links = brandMenu.querySelectorAll('a[data-variant]');
			links.forEach(function (link) {
				var v = (link.getAttribute('data-variant') || '').trim().toLowerCase();
				link.style.fontWeight = (v === current) ? '700' : '';
			});
		}
	}

	function wireVariantSwitcher() {
		if (!window.__CAP_MODE__) return;
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', applyVariantBrandUi, { once: true });
		} else {
			applyVariantBrandUi();
		}

		function handleVariantLink(targetVariant) {
			if (targetVariant !== 'finance' && targetVariant !== 'default') return;
			if ((window.MEMO_VARIANT || 'default') === targetVariant) {
				applyVariantBrandUi();
				return;
			}
			try { localStorage.setItem('memo_variant', targetVariant); } catch (_ignored) {}
			window.MEMO_VARIANT = targetVariant;
			applyVariantBrandUi();
			window.location.href = 'index.html';
		}

		document.addEventListener('click', function (event) {
			var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
			if (!link) return;
			var dataVariant = (link.getAttribute('data-variant') || '').trim().toLowerCase();
			if (dataVariant === 'finance' || dataVariant === 'default') {
				event.preventDefault();
				handleVariantLink(dataVariant);
				return;
			}
			var href = (link.getAttribute('href') || '').trim().toLowerCase();
			if (!href) return;
			if (href === 'finance.html') {
				event.preventDefault();
				handleVariantLink('finance');
			} else if (href === 'index.html' || href === '') {
				event.preventDefault();
				handleVariantLink('default');
			}
		});
	}

	// Inject CSS & load JS primarily when running inside Capacitor (non http/https)
	try {
		var hasServer = location.protocol === 'http:' || location.protocol === 'https:';
		// When running inside native, apps may use capacitor:// or file://; use relative 'static/'
		var STATIC_BASE = hasServer ? '/static/' : 'static/';

		// Only auto-inject when we're in native and templates are NOT managing scripts.
		if (window.__CAP_MODE__) {
			wireVariantSwitcher();
			if (window.__MEMO_TEMPLATE_LOADS_SCRIPTS__) {
				return;
			}
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
				'memo-contracts.js',
				'memo-runtime.js',
				'memo-api.js',
				'memo-debug.js',
				'memo-theme.js',
				'memo-export.js',
				'memo-settings.js',
				'memo-operation-queue.js',
				'memo-sync.js',
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

