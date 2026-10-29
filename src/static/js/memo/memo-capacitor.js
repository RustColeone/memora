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

	// Determine variant. A specific variant the page declared up-front
	// (window.MEMO_VARIANT, e.g. the planner sub-page) wins and is preserved —
	// the finance/default switcher below doesn't manage it. Otherwise fall back
	// to the stored/meta value.
	// The page's own identity is authoritative: an inline window.MEMO_VARIANT
	// (e.g. planner) wins, then the page's <meta name="memo-variant">, and only
	// then the stored value. localStorage is just a mirror for cross-page reads,
	// never an override — otherwise a stale value renders the wrong variant.
	var presetVariant = (window.MEMO_VARIANT || '').trim().toLowerCase();
	var variantMeta = document.querySelector('meta[name="memo-variant"]');
	var variantFromMeta = ((variantMeta && variantMeta.content) || '').trim().toLowerCase();
	var variantFromStorage = (localStorage.getItem('memo_variant') || '').trim().toLowerCase();
	var variant;
	if (presetVariant && presetVariant !== 'default') {
		variant = presetVariant;
	} else if (variantFromMeta === 'finance' || variantFromMeta === 'default') {
		variant = variantFromMeta;
	} else if (variantFromStorage === 'finance' || variantFromStorage === 'default') {
		variant = variantFromStorage;
	} else {
		variant = 'default';
	}
	// In the single-page shell the shell controller owns the active variant
	// (it flips memo/finance in place); don't let this reset it on native boot.
	if (!window.__MEMO_SPA__) {
		window.MEMO_VARIANT = variant;
		try { localStorage.setItem('memo_variant', variant); } catch (_ignored) {}
	}

	function applyVariantBrandUi() {
		if (!window.__CAP_MODE__) return;
		var current = (window.MEMO_VARIANT || 'default').toLowerCase();
		var brandBtn = document.querySelector('.brand-dropdown .brand');
		// Only the finance/default switcher owns the brand label; leave other
		// variants (e.g. planner) own branding intact.
		if (brandBtn && (current === 'finance' || current === 'default')) {
			var brandIcon = current === 'finance' ? 'cash' : 'folder';
			var brandLabel = current === 'finance' ? 'Finance' : 'Memo';
			brandBtn.innerHTML = '<span class="svg-icon svg-icon-' + brandIcon + '"></span> ' + brandLabel +
				' <span class="svg-icon svg-icon-chevron-down"></span> ';
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
		// The single-page shell handles variant links itself (in-place switch);
		// leave navigation-based switching off so the two don't fight.
		if (window.__MEMO_SPA__) return;
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
			// Navigate to the variant's OWN page (each has its own DOM + module).
			window.location.href = targetVariant === 'finance' ? 'finance.html' : 'index.html';
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
				l.href = STATIC_BASE + 'css/' + f;   // css lives under static/css/
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
				s.src = STATIC_BASE + 'js/memo/' + files[i];   // memo scripts live under static/js/memo/
				s.onload = function(){ loadSeq(i+1); };
				document.body.appendChild(s);
			}
			loadSeq(0);
		}
	} catch (e) {
		// eslint-disable-next-line no-console
		console.log('Capacitor bootstrap error', e);
	}

	// No splash screen — the @capacitor/splash-screen plugin was removed
	// (mirroring ImageDB), so there is nothing to hide.
})();

