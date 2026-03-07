/**
 * Debug Logger - Intercepts console.log and stores in memory for display in app
 * Useful for debugging in Capacitor apps where browser console isn't accessible
 */

(function() {
  'use strict';

  var Runtime = window.MemoRuntime || null;
  var Contracts = window.MemoContracts || null;
  function getMode() {
    return Contracts ? Contracts.getMode() : (window.MODE || 'detecting');
  }
  function getApiBase() {
    return Runtime ? Runtime.getApiBase() : (Contracts ? Contracts.getApiBase() : '');
  }

  // Debug log storage
  const debugLog = {
    entries: [],
    maxEntries: 500, // Keep last 500 log entries
    
    add(level, args) {
      const timestamp = new Date().toISOString().split('T')[1].slice(0, -1); // HH:MM:SS.mmm
      const message = args.map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2);
          } catch (e) {
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');
      
      this.entries.push({
        timestamp,
        level,
        message
      });
      
      // Keep only last maxEntries
      if (this.entries.length > this.maxEntries) {
        this.entries.shift();
      }
      
      // Update UI if dialog is open
      this.updateUI();
    },
    
    clear() {
      this.entries = [];
      this.updateUI();
    },
    
    getText() {
      return this.entries.map(e => `[${e.timestamp}] ${e.level.toUpperCase()}: ${e.message}`).join('\n');
    },
    
    updateUI() {
      const contentEl = document.getElementById('debugLogContent');
      if (contentEl) {
        contentEl.textContent = this.getText();
        // Auto-scroll to bottom
        contentEl.scrollTop = contentEl.scrollHeight;
      }
    }
  };
  
  // Store original console methods
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info
  };
  
  // Override console methods to intercept logs
  console.log = function(...args) {
    debugLog.add('log', args);
    originalConsole.log.apply(console, args);
  };
  
  console.warn = function(...args) {
    debugLog.add('warn', args);
    originalConsole.warn.apply(console, args);
  };
  
  console.error = function(...args) {
    debugLog.add('error', args);
    originalConsole.error.apply(console, args);
  };
  
  console.info = function(...args) {
    debugLog.add('info', args);
    originalConsole.info.apply(console, args);
  };
  
  // Click tracer — logs what element was clicked to the debug log
  document.addEventListener('click', function(ev) {
    var el = ev.target;
    var tag = el.tagName ? el.tagName.toLowerCase() : '?';
    var id = el.id ? '#' + el.id : '';
    var cls = el.className && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.')
      : '';
    var text = (el.textContent || '').trim().slice(0, 60);
    if (text) text = ' "' + text + '"';
    // Walk up to build a short path (up to 4 ancestors)
    var path = [];
    var cur = el.parentElement;
    for (var i = 0; i < 4 && cur && cur !== document.body; i++) {
      var part = cur.tagName.toLowerCase();
      if (cur.id) part += '#' + cur.id;
      else if (cur.className && typeof cur.className === 'string' && cur.className.trim())
        part += '.' + cur.className.trim().split(/\s+/)[0];
      path.unshift(part);
      cur = cur.parentElement;
    }
    var ancestor = path.length ? path.join(' > ') + ' > ' : '';
    console.log('[click] ' + ancestor + tag + id + cls + text);
  }, true); // capture so we see it even if handlers call stopPropagation

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  function init() {
    const debugLogDlg = document.getElementById('debugLogDlg');
    const debugLogContent = document.getElementById('debugLogContent');
    const clearDebugLog = document.getElementById('clearDebugLog');
    const copyDebugLog = document.getElementById('copyDebugLog');
    const closeDebugLog = document.getElementById('closeDebugLog');
    const mobileDebugLogBtn = document.getElementById('mobileDebugLogBtn');
    
    if (!debugLogDlg) return;
    
    // Open debug log from mobile menu
    function openDebugLog() {
      debugLog.updateUI(); // Refresh content
      debugLogDlg.showModal();
      
      // Close mobile menu if open
      const mobileMenu = document.getElementById('mobileMenu');
      const mobileOverlay = document.getElementById('mobileOverlay');
      if (mobileMenu && mobileMenu.classList.contains('open')) {
        mobileMenu.classList.remove('open');
        if (mobileOverlay) mobileOverlay.classList.remove('open');
      }
    }
    
    // Close debug log
    function closeDebugLogDialog() {
      debugLogDlg.close();
    }
    
    // Clear log
    function handleClearLog() {
      debugLog.clear();
    }
    
    // Copy to clipboard
    async function handleCopyLog() {
      const text = debugLog.getText();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          alert('Debug log copied to clipboard!');
        } else {
          // Fallback for browsers without clipboard API
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
          alert('Debug log copied to clipboard!');
        }
      } catch (err) {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard. See console for details.');
      }
    }
    
    // Event listeners
    if (mobileDebugLogBtn) mobileDebugLogBtn.addEventListener('click', openDebugLog);
    if (closeDebugLog) closeDebugLog.addEventListener('click', closeDebugLogDialog);
    if (clearDebugLog) clearDebugLog.addEventListener('click', handleClearLog);
    if (copyDebugLog) copyDebugLog.addEventListener('click', handleCopyLog);
    
    // Close on backdrop click
    if (debugLogDlg) {
      debugLogDlg.addEventListener('click', (e) => {
        if (e.target === debugLogDlg) {
          closeDebugLogDialog();
        }
      });
    }
    
    // Log initial info
    console.log('🐛 Debug Logger initialized');

    function logViewportMetrics(reason) {
      const vv = window.visualViewport || null;
      const orientationType = (screen.orientation && screen.orientation.type) ? screen.orientation.type : 'unknown';
      const orientationAngle = (screen.orientation && typeof screen.orientation.angle === 'number')
        ? screen.orientation.angle
        : (typeof window.orientation === 'number' ? window.orientation : 'n/a');

      const metrics = {
        reason: reason,
        location: window.location.href,
        protocol: window.location.protocol,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        clientWidth: document.documentElement ? document.documentElement.clientWidth : null,
        clientHeight: document.documentElement ? document.documentElement.clientHeight : null,
        visualViewport: vv ? {
          width: vv.width,
          height: vv.height,
          scale: vv.scale,
          offsetLeft: vv.offsetLeft,
          offsetTop: vv.offsetTop,
          pageLeft: vv.pageLeft,
          pageTop: vv.pageTop
        } : null,
        screenWidth: screen.width,
        screenHeight: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        devicePixelRatio: window.devicePixelRatio,
        orientationType: orientationType,
        orientationAngle: orientationAngle,
        capMode: !!(window.CAP_BOOT || window.__CAP_MODE__),
        memoVariant: window.MEMO_VARIANT || 'default'
      };

      console.log('📐 Viewport metrics', metrics);
    }

    const logViewportMetricsDebounced = (() => {
      let timer = null;
      return (reason) => {
        clearTimeout(timer);
        timer = setTimeout(() => logViewportMetrics(reason), 120);
      };
    })();

    logViewportMetrics('init');

    window.addEventListener('resize', () => logViewportMetricsDebounced('resize'));
    window.addEventListener('orientationchange', () => logViewportMetricsDebounced('orientationchange'));
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener('resize', () => logViewportMetricsDebounced('visualViewport.resize'));
      window.visualViewport.addEventListener('scroll', () => logViewportMetricsDebounced('visualViewport.scroll'));
    }
    
    // Wait a bit for memo-core.js to set global variables
    setTimeout(() => {
      console.log('📱 Mode:', getMode());
      console.log('🌐 API Base:', getApiBase() || '(empty - same origin)');
      console.log('📦 Variant:', window.MEMO_VARIANT || 'default');
      console.log('🔧 Capacitor:', !!(window.CAP_BOOT || window.__CAP_MODE__));
      logViewportMetrics('post-init-100ms');
    }, 100);
  }
  
  // Expose debug log globally for manual access
  window.DebugLog = debugLog;
})();
