/**
 * Debug Logger - Intercepts console.log and stores in memory for display in app
 * Useful for debugging in Capacitor apps where browser console isn't accessible
 */

(function() {
  'use strict';

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
    
    // Wait a bit for memo-core.js to set global variables
    setTimeout(() => {
      console.log('📱 Mode:', window.MODE || 'detecting');
      console.log('🌐 API Base:', window.API_BASE || '(empty - same origin)');
      console.log('📦 Variant:', window.MEMO_VARIANT || 'default');
      console.log('🔧 Capacitor:', !!(window.CAP_BOOT || window.__CAP_MODE__));
    }, 100);
  }
  
  // Expose debug log globally for manual access
  window.DebugLog = debugLog;
})();
