// memo-settings.js - Settings panel for server sync configuration and data export/import

(function() {
  'use strict';

  const Contracts = window.MemoContracts || null;
  const Runtime = window.MemoRuntime || null;
  const getMode = () => Contracts ? Contracts.getMode() : (window.MODE || 'local');
  const setMode = (mode) => Contracts ? Contracts.setMode(mode) : (window.MODE = mode);
  const getApiBase = () => Runtime ? Runtime.getApiBase() : (Contracts ? Contracts.getApiBase() : '');
  const setApiBase = (value) => Runtime ? Runtime.setApiBase(value) : (Contracts ? Contracts.setApiBase(value) : String(value || '').trim());
  const getVariant = () => Contracts ? Contracts.getVariant() : (window.MEMO_VARIANT || 'default');
  const getServerAPI = () => Runtime ? Runtime.getServerAPI() : ((Contracts && Contracts.getService('serverApi')) || null);

  // Wait for DOM and dependencies
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    const settingsBtn = document.getElementById('settingsBtn');
    const mobileSettingsBtn = document.getElementById('mobileSettingsBtn');
    const settingsDlg = document.getElementById('settingsDlg');
    const closeSettings = document.getElementById('closeSettings');
    const serverSyncSection = document.getElementById('serverSyncSection');
    const localFolderSection = document.getElementById('localFolderSection');
    
    // Server URL elements
    const serverUrlInput = document.getElementById('serverUrlInput');
    const saveServerUrl = document.getElementById('saveServerUrl');
    const clearServerUrl = document.getElementById('clearServerUrl');
    const serverUrlStatus = document.getElementById('serverUrlStatus');
    const serverTransportWarning = document.getElementById('serverTransportWarning');

    // Sync password (optional shared-secret gate)
    const syncPasswordInput = document.getElementById('syncPasswordInput');
    const saveSyncPassword = document.getElementById('saveSyncPassword');
    const clearSyncPassword = document.getElementById('clearSyncPassword');
    const syncPasswordStatus = document.getElementById('syncPasswordStatus');
    
    // Local folder elements
    const chooseFolderBtn = document.getElementById('chooseFolderBtn');
    const folderStatus = document.getElementById('folderStatus');
    
    // Export/Import elements
    const exportDataBtn = document.getElementById('exportDataBtn');
    const importDataInput = document.getElementById('importDataInput');
    const importExportStatus = document.getElementById('importExportStatus');

    // DB backup elements (server mode)
    const dbBackupSection = document.getElementById('dbBackupSection');
    const exportDbBtn = document.getElementById('exportDbBtn');
    const exportDbJsonBtn = document.getElementById('exportDbJsonBtn');
    const importDbInput = document.getElementById('importDbInput');

    // AI settings elements
    const llmProviderSelect = document.getElementById('llmProviderSelect');
    const llmModelInput = document.getElementById('llmModelInput');
    const geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
    const openaiApiKeyInput = document.getElementById('openaiApiKeyInput');
    const deepseekApiKeyInput = document.getElementById('deepseekApiKeyInput');
    const anthropicApiKeyInput = document.getElementById('anthropicApiKeyInput');
    const customApiKeyInput = document.getElementById('customApiKeyInput');
    const customBaseUrlInput = document.getElementById('customBaseUrlInput');
    const saveLlmConfig = document.getElementById('saveLlmConfig');
    const llmConfigStatus = document.getElementById('llmConfigStatus');
    const aiSettingsSection = document.getElementById('aiSettingsSection');
    const ocrEnabledToggle = document.getElementById('ocrEnabledToggle');
    const ocrToggleNote = document.getElementById('ocrToggleNote');

    // Personal AI keys: a pointer to the Vault (separate from the server's own AI settings above).
    const openVaultAiKeys = document.getElementById('openVaultAiKeys');
    const clientAiKeyStatus = document.getElementById('clientAiKeyStatus');

    if (!settingsDlg) return;

    if (window.MemoTransportSecurity) {
      window.MemoTransportSecurity.bind(serverUrlInput, serverTransportWarning);
    }

    // Determine mode
    const isCapacitorMode = window.CAP_BOOT || window.__CAP_MODE__;

    // Customize UI based on Mode
    function updateBackupUI() {
        const MODE = getMode();
        const exportBtn = document.getElementById('exportDataBtn');
        const importInput = document.getElementById('importDataInput');
        const importLabel = document.querySelector('label[for="importDataInput"]');
        const importNote = importLabel?.closest('.form-row')?.querySelector('p');

        if (MODE === 'server') {
            // Server: Only Download Backup (Export), No Import
            if (exportBtn) {
                exportBtn.hidden = false;
                exportBtn.innerHTML = '<span class="svg-icon svg-icon-download"></span> Download Server Backup (.zip)';
            }
            if (importLabel) importLabel.style.display = '';
            if (importNote) importNote.style.display = '';
            // Show DB backup section
            if (dbBackupSection) dbBackupSection.style.display = 'block';
        } else if (MODE === 'capacitor') {
            // Capacitor: Enable Export to Zip (save to device)
            if (exportBtn) {
                exportBtn.hidden = false; 
                exportBtn.innerHTML = '<span class="svg-icon svg-icon-archive"></span> ' + window.MemoI18n.t('Export backup');
            }
            if (importLabel) importLabel.style.display = '';
            if (importNote) {
               importNote.style.display = 'block';
               importNote.textContent = window.MemoI18n.t('Choose a backup (.memora, or an older .zip) to restore your data.');
            }
        } else if (MODE === 'local') {
            const usingSqlite = !!(window.MemoStateDb && window.MemoStateDb.ready && window.MemoStateDb.ready());
            if (usingSqlite) {
                // Offline-independent (OPFS): data lives in the in-browser DB,
                // so offer ZIP export/import (the portable, server-compatible format).
                if (exportBtn) { exportBtn.hidden = false; exportBtn.innerHTML = '<span class="svg-icon svg-icon-archive"></span> ' + window.MemoI18n.t('Export backup'); }
                if (importLabel) importLabel.style.display = '';
                if (importNote) {
                    importNote.style.display = 'block';
                    importNote.textContent = window.MemoI18n.t('Choose a backup (.memora, or an older .zip) to restore your data.');
                }
            } else {
                // Legacy user-folder mode: data is already on disk.
                if (exportBtn) exportBtn.hidden = true;
                if (importLabel) importLabel.style.display = 'none';
                if (importNote) {
                    importNote.style.display = 'block';
                    importNote.innerHTML = '<strong>Data Backup:</strong> Your data is stored directly in your device folder.<br>To backup, simply copy the entire folder to a safe location.';
                    importNote.className = 'info';
                }
            }
        }
    }

    // Open settings dialog
    function openSettings() {
      const isServerMode = getMode() === 'server';
      // Load current server URL
      const savedUrl = localStorage.getItem('memo_server_url') || '';
      if (serverUrlInput) serverUrlInput.value = savedUrl;
      if (window.MemoTransportSecurity) {
        window.MemoTransportSecurity.reflect(serverUrlInput, serverTransportWarning);
      }
      if (syncPasswordInput && window.MemoAuth) {
        syncPasswordInput.value = window.MemoAuth.getPassword();
        if (syncPasswordStatus) {
          syncPasswordStatus.textContent = window.MemoAuth.serverRequiresPassword
            ? 'This server requires a password.' : '';
        }
      }

      updateBackupUI(); // Apply the mode-specific visibility rules
      
      // Update folder status
      if (folderStatus && window.MemoCore && window.MemoCore.getState) {
        const { settings } = window.MemoCore.getState();
        folderStatus.textContent = settings.fsEnabled ? 'Enabled' : 'Not enabled';
        folderStatus.style.color = settings.fsEnabled ? 'var(--accent2)' : 'var(--muted)';
      }
      
      // Disable server sync section if in server mode
      if (isServerMode && serverSyncSection) {
        serverSyncSection.style.opacity = '0.5';
        serverSyncSection.style.pointerEvents = 'none';
        const disabledNote = document.createElement('p');
        disabledNote.className = 'muted';
        disabledNote.style.fontSize = '11px';
        disabledNote.style.marginTop = '8px';
        disabledNote.textContent = '(Server sync configuration is disabled when running on the server)';
        if (!serverSyncSection.querySelector('.muted:last-child')) {
          serverSyncSection.appendChild(disabledNote);
        }
      }
      
      // Hide local folder section if in server or capacitor mode
      if (localFolderSection) {
        if (isServerMode || isCapacitorMode) {
          localFolderSection.style.display = 'none';
        } else {
          localFolderSection.style.display = 'block';
        }
      }
      
      settingsDlg.showModal();

      // Load LLM config if in server mode
      if (getMode() === 'server' && aiSettingsSection) {
        aiSettingsSection.style.display = '';
        loadLlmConfig();
      } else if (aiSettingsSection) {
        aiSettingsSection.style.display = 'none';
      }

      // Personal client-side AI key — always available, regardless of mode.
      loadClientAiKeySection();

      // Close mobile menu if open
      if (window.MemoTheme) window.MemoTheme.closeMobileMenu();
    }

    // Close settings dialog
    function closeSettingsDialog() {
      if (window.MemoBackupUI?.isRestoring()) return;
      settingsDlg.close();
      clearStatus();
    }

    // Clear all status messages
    function clearStatus() {
      if (serverUrlStatus) {
        serverUrlStatus.textContent = '';
        serverUrlStatus.className = '';
      }
      if (importExportStatus) {
        importExportStatus.style.display = 'none';
        importExportStatus.textContent = '';
        importExportStatus.className = '';
      }
    }

    // Show status message
    // Map a leading status glyph (✓/✗/⏳ etc.) to a theme-aware .svg-icon so
    // status lines match the rest of the icon system instead of raw emoji.
    const STATUS_GLYPH_ICON = { '✓': 'check', '✅': 'check', '✗': 'x', '❌': 'x', '⏳': 'clock' };
    function escStatusHtml(s) {
      return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
    function showStatus(element, message, type = 'info') {
      if (!element) return;
      let msg = String(message);
      const icon = STATUS_GLYPH_ICON[msg.charAt(0)];
      if (icon) {
        msg = msg.slice(1).replace(/^\s+/, '');
        element.innerHTML = `<span class="svg-icon svg-icon-${icon}"></span> ${escStatusHtml(msg)}`;
      } else {
        element.textContent = msg;
      }
      element.className = type; // 'success', 'error', 'info'
      if (element === importExportStatus) {
        element.style.display = 'block';
      }
    }

    // Vision-capable providers (must match backend _VISION_PROVIDERS)
    const VISION_PROVIDERS = new Set(['gemini', 'openai', 'anthropic', 'deepseek']);

    // LLM provider key-row visibility toggle
    function updateKeyRows(provider) {
      const geminiRow = document.getElementById('geminiKeyRow');
      const openaiRow = document.getElementById('openaiKeyRow');
      const deepseekRow = document.getElementById('deepseekKeyRow');
      if (geminiRow) geminiRow.style.display = provider === 'gemini' ? '' : 'none';
      if (openaiRow) openaiRow.style.display = provider === 'openai' ? '' : 'none';
      if (deepseekRow) deepseekRow.style.display = provider === 'deepseek' ? '' : 'none';
      const anthropicRow = document.getElementById('anthropicKeyRow');
      const customRow = document.getElementById('customKeyRow');
      if (anthropicRow) anthropicRow.style.display = provider === 'anthropic' ? '' : 'none';
      if (customRow) customRow.style.display = provider === 'custom' ? '' : 'none';
      const modelPlaceholders = { gemini: 'gemini-3.8-flash', openai: 'gpt-6-luna', deepseek: 'deepseek-flash', anthropic: 'claude-sonnet-5-5', custom: 'model name' };
      if (llmModelInput) llmModelInput.placeholder = modelPlaceholders[provider] || 'default';
      // OCR toggle: force-on+locked for DeepSeek, user-controlled for vision providers
      const isDeepseek = (provider || '').toLowerCase() === 'deepseek';
      if (ocrEnabledToggle) {
        if (isDeepseek) {
          ocrEnabledToggle.checked = true;
          ocrEnabledToggle.disabled = true;
          if (ocrToggleNote) ocrToggleNote.textContent = '(required for DeepSeek)';
        } else {
          ocrEnabledToggle.disabled = false;
          if (ocrToggleNote) ocrToggleNote.textContent = VISION_PROVIDERS.has(provider) ? '(optional — fuses with vision)' : '';
        }
      }
      // Update OCR capability banner when provider changes
      updateOcrCapabilityBanner(provider).catch(() => {});
    }

    async function updateOcrCapabilityBanner(provider) {
      const banner = document.getElementById('ocrCapabilityStatus');
      if (!banner) return;
      banner.textContent = '';
      if (getMode() !== 'server') return;
      const ocrOn = ocrEnabledToggle ? ocrEnabledToggle.checked : true;
      try {
        const r = await fetch(getApiBase() + '/api/ocr/capabilities');
        if (!r.ok) return;
        const cap = await r.json();
        const usingDeepseek = (provider || '').toLowerCase() === 'deepseek';
        const visionCapable = !!cap.vision_capable;
        const ocrAvail = cap.ocr && !!cap.ocr.available;
        const backend = cap.ocr ? (cap.ocr.backend || '') : '';
        if (usingDeepseek) {
          if (ocrAvail) {
            banner.textContent = `DeepSeek is text-only — OCR (${backend}) is active for images.`;
            banner.className = 'info';
          } else {
            banner.textContent = 'DeepSeek is text-only. OCR not installed — install EasyOCR or Tesseract for image text extraction.';
            banner.className = 'error';
          }
        } else if (!visionCapable && !ocrAvail) {
          banner.textContent = 'Selected provider cannot read images and no OCR is available.';
          banner.className = 'error';
        } else if (visionCapable) {
          if (ocrAvail && ocrOn) {
            banner.textContent = `Vision model active. OCR (${backend}) fusion enabled — extracted text will supplement the vision result.`;
            banner.className = 'info';
          } else if (ocrAvail && !ocrOn) {
            banner.textContent = 'Vision model active. OCR is available but disabled — toggle on to fuse extracted text.';
            banner.className = 'info';
          } else {
            banner.textContent = 'Vision model active.';
            banner.className = 'info';
          }
        } else {
          banner.textContent = '';
        }
      } catch (e) {
        // ignore
      }
    }

    async function loadLlmConfig() {
      try {
        const resp = await fetch(getApiBase() + '/api/llm/config');
        if (!resp.ok) return;
        const cfg = await resp.json();
        if (llmProviderSelect) {
          llmProviderSelect.value = cfg.provider || 'gemini';
          updateKeyRows(llmProviderSelect.value);
        }
        // Restore OCR toggle — force-on for DeepSeek (already handled in updateKeyRows)
        if (ocrEnabledToggle && !ocrEnabledToggle.disabled) {
          ocrEnabledToggle.checked = cfg.ocr_enabled !== false; // default true
        }
        await updateOcrCapabilityBanner(llmProviderSelect ? llmProviderSelect.value : 'gemini');
        if (llmModelInput) llmModelInput.value = cfg.model || '';
        if (geminiApiKeyInput) geminiApiKeyInput.placeholder = cfg.gemini_key_set ? '••••••••• (set)' : 'Paste Gemini API key';
        if (openaiApiKeyInput) openaiApiKeyInput.placeholder = cfg.openai_key_set ? '••••••••• (set)' : 'Paste OpenAI API key';
        if (deepseekApiKeyInput) deepseekApiKeyInput.placeholder = cfg.deepseek_key_set ? '••••••••• (set)' : 'Paste DeepSeek API key';
        if (anthropicApiKeyInput) anthropicApiKeyInput.placeholder = cfg.anthropic_key_set ? '••••••••• (set)' : 'Paste Claude API key';
        if (customApiKeyInput) customApiKeyInput.placeholder = cfg.custom_key_set ? '••••••••• (set)' : 'Paste API key';
        if (customBaseUrlInput) customBaseUrlInput.value = cfg.custom_base_url || '';
        if (llmConfigStatus) llmConfigStatus.textContent = '';
      } catch (e) {
        if (llmConfigStatus) llmConfigStatus.textContent = 'Could not load AI settings.';
      }
    }

    async function handleSaveLlmConfig() {
      const provider = llmProviderSelect ? llmProviderSelect.value : 'gemini';
      const model = llmModelInput ? llmModelInput.value.trim() : '';
      // OCR toggle: always true for DeepSeek (checkbox is disabled+checked), user value otherwise
      const ocrEnabled = ocrEnabledToggle ? ocrEnabledToggle.checked : true;
      const payload = { provider, model, ocr_enabled: ocrEnabled };
      if (geminiApiKeyInput && geminiApiKeyInput.value.trim()) payload.gemini_api_key = geminiApiKeyInput.value.trim();
      if (openaiApiKeyInput && openaiApiKeyInput.value.trim()) payload.openai_api_key = openaiApiKeyInput.value.trim();
      if (deepseekApiKeyInput && deepseekApiKeyInput.value.trim()) payload.deepseek_api_key = deepseekApiKeyInput.value.trim();
      if (anthropicApiKeyInput && anthropicApiKeyInput.value.trim()) payload.anthropic_api_key = anthropicApiKeyInput.value.trim();
      if (customApiKeyInput && customApiKeyInput.value.trim()) payload.custom_api_key = customApiKeyInput.value.trim();
      if (customBaseUrlInput) payload.custom_base_url = customBaseUrlInput.value.trim();

      if (llmConfigStatus) showStatus(llmConfigStatus, '⏳ Saving…', 'info');
      try {
        const resp = await fetch(getApiBase() + '/api/llm/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (resp.ok) {
          if (llmConfigStatus) showStatus(llmConfigStatus, '✓ ' + (data.message || 'Saved'), 'success');
          if (geminiApiKeyInput) geminiApiKeyInput.value = '';
          if (openaiApiKeyInput) openaiApiKeyInput.value = '';
          if (deepseekApiKeyInput) deepseekApiKeyInput.value = '';
          if (anthropicApiKeyInput) anthropicApiKeyInput.value = '';
          if (customApiKeyInput) customApiKeyInput.value = '';
          loadLlmConfig();
        } else {
          if (llmConfigStatus) showStatus(llmConfigStatus, '✗ ' + (data.message || 'Error'), 'error');
        }
      } catch (e) {
        if (llmConfigStatus) showStatus(llmConfigStatus, '✗ ' + e.message, 'error');
      }
    }

    // Personal AI keys live in the Vault (memo-vault.js), encrypted; this
    // section only reports the default key and opens the Vault. The section
    // above configures the *server's* key, a separate concept.
    function loadClientAiKeySection() {
      if (!clientAiKeyStatus) return;
      const active = window.MemoAiKey ? window.MemoAiKey.getActiveKey() : null;
      const label = active ? (active.label || (window.MemoVault?.PROVIDERS?.[active.provider]?.label) || active.provider) : '';
      const tr = (text, vars) => (window.MemoI18n?.t ? window.MemoI18n.t(text, vars) : text.replace('{name}', vars?.name || ''));
      clientAiKeyStatus.textContent = active ? tr('Default key: {name}', { name: label }) : tr('No AI key yet.');
      clientAiKeyStatus.className = 'info';
    }

    // Save server URL
    async function handleSaveServerUrl() {
      const url = serverUrlInput.value.trim();
      
      if (!url) {
        showStatus(serverUrlStatus, 'Please enter a server URL', 'error');
        return;
      }

      // Basic URL validation
      let parsed;
      try {
        parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error('URL must use HTTP or HTTPS protocol');
        }
      } catch (e) {
        showStatus(serverUrlStatus, 'Invalid URL format. Use https://example.com or http://192.168.1.100:5050', 'error');
        return;
      }

      if (window.MemoTransportSecurity &&
          !window.MemoTransportSecurity.confirmHttp(parsed.href)) {
        showStatus(serverUrlStatus, 'HTTP server not saved. Use HTTPS, or confirm the risk to continue.', 'info');
        return;
      }

      // Save to localStorage
      localStorage.setItem('memo_server_url', url);
      
      // Update global API_BASE immediately
      setApiBase(url);
      
      showStatus(serverUrlStatus, '⏳ Connecting to server and initializing sync...', 'info');
      
      // Switch to server mode and initialize sync
      try {
        // Local/native clients keep their storage mode. Push durable local work
        // before pulling the server baseline instead of replacing the visible
        // records with a preliminary GET that can hide unsynced entries.
        if (window.SyncManager) await window.SyncManager.init();
        const result = await window.OperationQueue?.manualSync();
        if (result && !['success', 'pending'].includes(result.status)) {
          throw new Error(result.error || (result.status === 'auth' ? 'Sync password required' : 'Server unavailable'));
        }
        const syncStatusEl = document.getElementById('syncStatus');
        if (syncStatusEl) syncStatusEl.style.display = 'flex';

        showStatus(serverUrlStatus, '✓ Connected! Sync is now active.', 'success');
      } catch (err) {
        console.error('Failed to connect to server:', err);
        showStatus(serverUrlStatus, `✗ Failed to connect: ${err.message}. Check the URL and try again.`, 'error');
      }
    }

    // Save / clear the optional sync password (shared secret matching the server).
    async function handleSaveSyncPassword() {
      if (!window.MemoAuth) return;
      const pw = (syncPasswordInput ? syncPasswordInput.value : '').trim();
      window.MemoAuth.setPassword(pw);
      showStatus(syncPasswordStatus, pw ? '✓ Password saved. It will be sent with sync requests.' : '✓ Password cleared.', 'success');
      // Refresh the image cookie + re-render so <img src="/uploads/…"> authorise.
      if (pw && window.MemoAuth.establishUploadSession) {
        await window.MemoAuth.establishUploadSession(getApiBase());
        if (window.MemoCore && window.MemoCore.renderFeed) window.MemoCore.renderFeed();
      }
      // If already in server mode, re-sync now that the credential changed.
      if (getMode() === 'server' && window.SyncManager && window.SyncManager.performSync) {
        await window.SyncManager.performSync();
      }
    }

    function handleClearSyncPassword() {
      if (!window.MemoAuth) return;
      window.MemoAuth.clearPassword();
      if (syncPasswordInput) syncPasswordInput.value = '';
      showStatus(syncPasswordStatus, '✓ Password cleared.', 'success');
    }

    // Clear server URL
    function handleClearServerUrl() {
      localStorage.removeItem('memo_server_url');
      if (serverUrlInput) serverUrlInput.value = '';
      if (window.MemoTransportSecurity) {
        window.MemoTransportSecurity.reflect(serverUrlInput, serverTransportWarning);
      }
      
      // Reset to local mode
      setApiBase('');
      setMode(isCapacitorMode ? 'capacitor' : 'local');
      
      // Hide sync status
      const syncStatusEl = document.getElementById('syncStatus');
      if (syncStatusEl) syncStatusEl.style.display = 'none';
      window.MemoSyncStatus?.refresh();
      
      showStatus(serverUrlStatus, '✓ Server URL cleared! Now running in local mode.', 'success');
    }

    // Export all data

    // Legacy user-folder storage has been removed. Data lives in the in-browser
    // SQLite store (app-private) and is backed up via Export ZIP.
    async function handleChooseFolder() {
      if (folderStatus) {
        folderStatus.textContent = 'Folder storage is no longer used — entries save automatically.';
        folderStatus.style.color = 'var(--muted)';
      }
    }

    // DB backup handlers (server mode)
    async function handleExportDb() {
        showStatus(importExportStatus, 'Downloading database file...', 'info');
        try {
            await window.MemoBackupUI.download('/api/db/export?format=db', 'memosystem.db');
            showStatus(importExportStatus, '✓ DB download started.', 'success');
        } catch (error) { showStatus(importExportStatus, `✗ Export failed: ${error.message}`, 'error'); }
    }

    async function handleExportDbJson() {
        showStatus(importExportStatus, 'Downloading JSON backup...', 'info');
        try {
            await window.MemoBackupUI.download('/api/db/export?format=json', 'memosystem_backup.json');
            showStatus(importExportStatus, '✓ JSON backup download started.', 'success');
        } catch (error) { showStatus(importExportStatus, `✗ Export failed: ${error.message}`, 'error'); }
    }

    async function handleImportDb(event) {
        const file = event.target.files[0];
        if (!file) return;
        event.target.value = '';

        const isDb = file.name.endsWith('.db');
        const format = isDb ? 'db' : 'json';
        const importMsg =
            `Import "${file.name}" as ${format.toUpperCase()} backup?\n\n` +
            (isDb ? `Replace the whole database with this backup.\n` : `Mode: merge (existing data is kept, new data is added).\n`) +
            `The page will reload after import.`;
        const confirmed = window.MemoShell ? await window.MemoShell.confirm(importMsg, { okLabel: 'Import' }) : confirm(importMsg);
        if (!confirmed) return;

        showStatus(importExportStatus, 'Uploading backup...', 'info');
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('format', format);
            formData.append('mode', isDb ? 'replace' : 'merge');
            const resp = await fetch(getApiBase() + '/api/db/import', { method: 'POST', body: formData });
            const result = await resp.json();
            if (result.success) {
                showStatus(importExportStatus, `✓ Import complete. Reloading...`, 'success');
                setTimeout(() => location.reload(), 1500);
            } else {
                showStatus(importExportStatus, `✗ Import failed: ${result.error || 'Unknown error'}`, 'error');
            }
        } catch (err) {
            showStatus(importExportStatus, `✗ Import error: ${err.message}`, 'error');
        }
    }

    // Event listeners
    if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
    if (mobileSettingsBtn) mobileSettingsBtn.addEventListener('click', openSettings);
    if (closeSettings) closeSettings.addEventListener('click', closeSettingsDialog);
    
    if (saveServerUrl) saveServerUrl.addEventListener('click', handleSaveServerUrl);
    if (clearServerUrl) clearServerUrl.addEventListener('click', handleClearServerUrl);

    if (saveSyncPassword) saveSyncPassword.addEventListener('click', handleSaveSyncPassword);
    if (clearSyncPassword) clearSyncPassword.addEventListener('click', handleClearSyncPassword);

    if (chooseFolderBtn) chooseFolderBtn.addEventListener('click', handleChooseFolder);
    
    // Data Backup (export/import) is wired by the shared memo-backup-ui.js so
    // the panel is identical on memo/finance/planner.

    if (exportDbBtn) exportDbBtn.addEventListener('click', handleExportDb);
    if (exportDbJsonBtn) exportDbJsonBtn.addEventListener('click', handleExportDbJson);
    if (importDbInput) importDbInput.addEventListener('change', handleImportDb);

    if (llmProviderSelect) llmProviderSelect.addEventListener('change', () => updateKeyRows(llmProviderSelect.value));
    if (ocrEnabledToggle) ocrEnabledToggle.addEventListener('change', () => updateOcrCapabilityBanner(llmProviderSelect ? llmProviderSelect.value : 'gemini').catch(() => {}));
    if (saveLlmConfig) saveLlmConfig.addEventListener('click', handleSaveLlmConfig);

    if (openVaultAiKeys) openVaultAiKeys.addEventListener('click', () => { if (settingsDlg?.open) settingsDlg.close(); window.MemoVaultUi?.open(); });

    // Close on backdrop click
    if (settingsDlg) {
      settingsDlg.addEventListener('click', (e) => {
        if (e.target === settingsDlg) {
          closeSettingsDialog();
        }
      });
    }

    // Progressive disclosure: make each settings section foldable (only the
    // first — Server Sync — is open by default) so the modal isn't a wall.
    setupCollapsibleSections();
  }

  function setupCollapsibleSections() {
    const dlg = document.getElementById('settingsDlg');
    if (!dlg) return;
    dlg.querySelectorAll('.settings-section').forEach((sec, idx) => {
      const h3 = sec.querySelector('h3');
      if (!h3 || h3.dataset.collapsible) return;
      h3.dataset.collapsible = '1';
      const chev = document.createElement('span');
      chev.className = 'sec-chev';
      chev.textContent = '▾';
      h3.prepend(chev);
      h3.style.cursor = 'pointer';
      h3.addEventListener('click', () => sec.classList.toggle('collapsed'));
      if (idx > 0) sec.classList.add('collapsed'); // keep the first section open
    });
  }
})();
