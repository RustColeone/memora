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
    
    // Local folder elements
    const chooseFolderBtn = document.getElementById('chooseFolderBtn');
    const folderStatus = document.getElementById('folderStatus');
    
    // Export/Import elements
    const exportDataBtn = document.getElementById('exportDataBtn');
    const importDataInput = document.getElementById('importDataInput');
    const importExportStatus = document.getElementById('importExportStatus');

    if (!settingsDlg) return;

    // Determine mode
    const isCapacitorMode = window.CAP_BOOT || window.__CAP_MODE__;

    // Customize UI based on Mode
    function updateBackupUI() {
        const MODE = getMode();
        const exportBtn = document.getElementById('exportDataBtn');
        const importInput = document.getElementById('importDataInput');
        const importLabel = document.querySelector('label[for="importDataInput"]');
        const importNote = importLabel ? importLabel.nextElementSibling : null;

        if (MODE === 'server') {
            // Server: Only Download Backup (Export), No Import
            if (exportBtn) {
                exportBtn.hidden = false;
                exportBtn.textContent = '📥 Download Server Backup (.zip)';
            }
            if (importLabel) importLabel.style.display = 'none'; // Hide Import
            if (importNote) importNote.style.display = 'none';
        } else if (MODE === 'capacitor') {
            // Capacitor: Enable Export to Zip (save to device)
            if (exportBtn) {
                exportBtn.hidden = false; 
                exportBtn.textContent = '📥 Export Data to Zip';
            }
            if (importLabel) importLabel.style.display = 'none'; // Import manually via folder usually
            if (importNote) {
               importNote.style.display = 'block';
               importNote.textContent = 'Export creates a zip file in your Documents folder.';
            }
        } else if (MODE === 'local') {
            // Local (Desktop): Direct access instructions
            if (exportBtn) exportBtn.hidden = true;
            if (importLabel) importLabel.style.display = 'none';
            if (importNote) {
                importNote.style.display = 'block';
                importNote.innerHTML = '<strong>Data Backup:</strong> Your data is stored directly in your device folder.<br>To backup, simply copy the entire folder to a safe location.<br><br>No import/export needed!';
                importNote.className = 'info';
            }
        }
    }

    // Open settings dialog
    function openSettings() {
      const isServerMode = getMode() === 'server';
      // Load current server URL
      const savedUrl = localStorage.getItem('memo_server_url') || '';
      if (serverUrlInput) serverUrlInput.value = savedUrl;
      
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
      
      // Close mobile menu if open
      const mobileMenu = document.getElementById('mobileMenu');
      const mobileOverlay = document.getElementById('mobileOverlay');
      if (mobileMenu && mobileMenu.classList.contains('open')) {
        mobileMenu.classList.remove('open');
        if (mobileOverlay) mobileOverlay.classList.remove('open');
      }
    }

    // Close settings dialog
    function closeSettingsDialog() {
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
    function showStatus(element, message, type = 'info') {
      if (!element) return;
      element.textContent = message;
      element.className = type; // 'success', 'error', 'info'
      if (element === importExportStatus) {
        element.style.display = 'block';
      }
    }

    // Save server URL
    async function handleSaveServerUrl() {
      const url = serverUrlInput.value.trim();
      
      if (!url) {
        showStatus(serverUrlStatus, 'Please enter a server URL', 'error');
        return;
      }

      // Basic URL validation
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error('URL must use HTTP or HTTPS protocol');
        }
      } catch (e) {
        showStatus(serverUrlStatus, 'Invalid URL format. Use https://example.com or http://192.168.1.100:5050', 'error');
        return;
      }

      // Save to localStorage
      localStorage.setItem('memo_server_url', url);
      
      // Update global API_BASE immediately
      setApiBase(url);
      
      showStatus(serverUrlStatus, '⏳ Connecting to server and initializing sync...', 'info');
      
      // Switch to server mode and initialize sync
      try {
        setMode('server');
        
        // Reset sync state to force a full sync
        const variant = getVariant();
        const stateKey = `memo_sync_state_${variant}`;
        localStorage.removeItem(stateKey);
        
        // Load data from server
        const serverApi = getServerAPI();
        if (serverApi && serverApi.list) {
          const memos = await serverApi.list();
          const { db } = window.MemoCore.getState();
          
          // Replace local data with server data
          const normalizedMemos = (memos || []).map(m => {
            if (window.MemoVariant && typeof window.MemoVariant.normalizeServerMemo === 'function') {
              return window.MemoVariant.normalizeServerMemo(m);
            }
            return {
              id: m.id,
              description: m.description || '',
              category: m.category || 'Uncategorized',
              tags: m.tags || [],
              ts: m.ts || Date.now(),
              images: m.images || [],
              attachments: m.attachments || []
            };
          });
          
          // Download assets for all memos if using file:// protocol
          if (window.SyncManager && window.SyncManager.downloadAssets) {
            db.entries = [];
            for (const memo of normalizedMemos) {
              const memoWithAssets = await window.SyncManager.downloadAssets(memo);
              db.entries.push(memoWithAssets);
            }
          } else {
            db.entries = normalizedMemos;
          }
          
          // Save and refresh UI
          if (window.MemoCore && window.MemoCore.saveAll) {
            window.MemoCore.saveAll();
          }
          if (window.MemoCore && window.MemoCore.renderFeed) {
            window.MemoCore.renderFeed();
          }
        }
        
        // Initialize sync manager
        if (window.SyncManager) {
          await window.SyncManager.init();
          
          // Show sync status indicator
          const syncStatusEl = document.getElementById('syncStatus');
          if (syncStatusEl) syncStatusEl.style.display = 'flex';
          
          // Perform initial sync
          setTimeout(() => window.SyncManager.performSync(), 500);
        }
        
        showStatus(serverUrlStatus, '✓ Connected! Sync is now active.', 'success');
      } catch (err) {
        console.error('Failed to connect to server:', err);
        showStatus(serverUrlStatus, `✗ Failed to connect: ${err.message}. Check the URL and try again.`, 'error');
      }
    }

    // Clear server URL
    function handleClearServerUrl() {
      localStorage.removeItem('memo_server_url');
      if (serverUrlInput) serverUrlInput.value = '';
      
      // Reset to local mode
      setApiBase('');
      setMode('local');
      
      // Hide sync status
      const syncStatusEl = document.getElementById('syncStatus');
      if (syncStatusEl) syncStatusEl.style.display = 'none';
      
      showStatus(serverUrlStatus, '✓ Server URL cleared! Now running in local mode.', 'success');
    }

    // Export all data
    async function handleExportData() {
      // If server mode, simple download from /api/backup
      if (getMode() === 'server') {
          showStatus(importExportStatus, 'Requesting server backup...', 'info');
          const backupLink = document.createElement('a');
          backupLink.href = getApiBase() + '/api/backup';
          backupLink.target = '_blank';
          backupLink.download = 'backup.zip';
          document.body.appendChild(backupLink);
          backupLink.click();
          setTimeout(() => document.body.removeChild(backupLink), 2000);
          showStatus(importExportStatus, '✓ Backup download started.', 'success');
          return;
      }

      try {
        showStatus(importExportStatus, 'Preparing export...', 'info');

        if (!window.JSZip) {
          showStatus(importExportStatus, '✗ Export requires JSZip library. Please check your internet connection or try disabling tracking prevention for this site.', 'error');
          return;
        }

        if (!window.MemoCore) {
          throw new Error('MemoCore not initialized');
        }

        const { db } = window.MemoCore.getState();
        const variant = getVariant();
        const zip = new JSZip();

        // Create data folder structure
        const dataFolder = zip.folder('data');

        // 1. Export entries JSON files
        const variantFileName = variant === 'finance' ? 'finance.json' : 'memos.json';
        
        // Get all entries (including deleted ones for complete backup)
        const allEntries = db.entries || [];
        dataFolder.file(variantFileName, JSON.stringify(allEntries, null, 2));

        // 2. Export chat files if they exist
        const chatFileName = variant === 'finance' ? 'chat_finance.json' : 'chat.json';
        const chatHistory = localStorage.getItem(`memoChat_${variant}`) || '[]';
        dataFolder.file(chatFileName, chatHistory);

        // 3. Export hashbook if available (for deduplication)
        const hashbook = localStorage.getItem('memoHashbook') || '{}';
        dataFolder.file('hashbook.json', hashbook);

        // 4. Export images and attachments
        const uploadsFolder = dataFolder.folder('uploads');
        
        showStatus(importExportStatus, 'Downloading files...', 'info');
        
        // Track unique files to avoid duplicates
        const processedFiles = new Set();
        const filesToDownload = [];

        // Collect all image and attachment URLs
        for (const entry of allEntries) {
          // Images
          if (entry.images && Array.isArray(entry.images)) {
            entry.images.forEach((imgUrl, idx) => {
              if (imgUrl && !processedFiles.has(imgUrl)) {
                processedFiles.add(imgUrl);
                // Try to find original path for structure preservation
                let originalPath = null;
                if (entry._storedPaths && entry._storedPaths[idx]) {
                    originalPath = entry._storedPaths[idx];
                }
                filesToDownload.push({ url: imgUrl, type: 'image', originalPath: originalPath });
              }
            });
          }
          
          // Attachments
          if (entry.attachments && Array.isArray(entry.attachments)) {
            for (const att of entry.attachments) {
              const attUrl = att.url || att;
              if (attUrl && !processedFiles.has(attUrl)) {
                processedFiles.add(attUrl);
                // Try to find original path
                let originalPath = att.storedPath || (typeof att === 'string' && att.startsWith('uploads/') ? att : null);
                filesToDownload.push({ url: attUrl, type: 'attachment', name: att.name || null, originalPath: originalPath });
              }
            }
          }
        }

        // Download and add files to zip
        let downloadedCount = 0;
        for (const fileInfo of filesToDownload) {
          try {
            const fileUrl = fileInfo.url;
            
            // Determine the path in the zip
            // Expected format: /uploads/YYYY-MM-DD/filename.ext
            let zipPath = '';

            if (fileInfo.originalPath) {
                 // Use stored path if available (preserves folder structure)
                 // Clean path (remove leading slash)
                 let clean = fileInfo.originalPath.startsWith('/') ? fileInfo.originalPath.substring(1) : fileInfo.originalPath;
                 // Ensure it starts with uploads/
                 if (!clean.startsWith('uploads/')) clean = 'uploads/' + clean;
                 zipPath = clean;
            } else if (fileUrl.startsWith('/uploads/') || fileUrl.startsWith('uploads/')) {
              // Server mode - extract path from URL
              zipPath = fileUrl.replace(/^\//, ''); // Remove leading slash
            } else if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
              // Full URL - extract filename and use date-based folder
              const urlObj = new URL(fileUrl);
              const pathParts = urlObj.pathname.split('/');
              const filename = pathParts[pathParts.length - 1];
              
              // Try to find date folder in URL
              const dateMatch = urlObj.pathname.match(/(\d{4}-\d{2}-\d{2})/);
              const dateFolder = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
              
              zipPath = `uploads/${dateFolder}/${filename}`;
            } else {
              // Relative path or blob URL - use default folder
              const filename = fileInfo.name || fileUrl.split('/').pop();
              const today = new Date().toISOString().split('T')[0];
              zipPath = `uploads/${today}/${filename}`;
            }

            // Fetch the file
            let fetchUrl = fileUrl;
            // If relative URL and we have API_BASE, prepend it
            if (fetchUrl.startsWith('/') && getApiBase()) {
              fetchUrl = getApiBase().replace(/\/$/, '') + fetchUrl;
            }

            let blob;
            // Try native fetch for Capacitor
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
                 try {
                    const resp = await window.Capacitor.Plugins.CapacitorHttp.get({
                        url: fetchUrl,
                        responseType: 'blob'
                    });
                    if (resp.status >= 200 && resp.status < 300) {
                        if (typeof resp.data === 'string') {
                             // Convert base64 to blob
                             const byteCharacters = atob(resp.data);
                             const byteNumbers = new Array(byteCharacters.length);
                             for (let i = 0; i < byteCharacters.length; i++) {
                                 byteNumbers[i] = byteCharacters.charCodeAt(i);
                             }
                             const byteArray = new Uint8Array(byteNumbers);
                             blob = new Blob([byteArray]);
                        } else {
                             blob = resp.data;
                        }
                    }
                 } catch(e) { 
                     console.warn('Native fetch failed for export, falling back', e);
                 }
            }

            if (!blob) {
                const response = await fetch(fetchUrl);
                if (!response.ok) {
                  continue;
                }
                blob = await response.blob();
            }

            uploadsFolder.file(zipPath.replace('uploads/', ''), blob);
            
            downloadedCount++;
            showStatus(importExportStatus, `Downloaded ${downloadedCount} / ${filesToDownload.length} files...`, 'info');
          } catch (err) {
            // Skip failed downloads
          }
        }

        showStatus(importExportStatus, 'Creating zip file...', 'info');

        // Generate zip file
        const content = await zip.generateAsync({ 
          type: 'base64', // Change to base64 for Capacitor write
          compression: 'DEFLATE',
          compressionOptions: { level: 6 }
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const filename = `memoSystem-backup-${timestamp}.zip`;
        
        // Capacitor Save
        if (isCapacitorMode) {
             try {
                 const Filesystem = window.Capacitor.Plugins?.Filesystem || window.Capacitor.Filesystem;
                 // Write to Documents folder
                 await Filesystem.writeFile({
                     path: filename,
                     data: content,
                     directory: 'DOCUMENTS', // Directory.Documents
                     recursive: true
                 });
                 showStatus(importExportStatus, `✓ Saved to Documents/${filename}`, 'success');
             } catch (capErr) {
                 console.warn('Capacitor write failed, trying file share...', capErr);
                 // Fallback to Share or file opener could be implemented logic here
                 // For now, try browser download shim if write fails (might not work well on all webviews)
                 const blob = await zip.generateAsync({ type: 'blob' });
                 const link = document.createElement('a');
                 link.href = URL.createObjectURL(blob);
                 link.download = filename;
                 link.click();
             }
        } else {
             // Browser Download
             const blob = await zip.generateAsync({ type: 'blob' });
             const link = document.createElement('a');
             link.href = URL.createObjectURL(blob);
             link.download = filename;
             link.click();
             URL.revokeObjectURL(link.href);
             showStatus(importExportStatus, `✓ Export complete! Downloaded ${filename}`, 'success');
        }
      } catch (error) {
        console.error('Export error:', error);
        showStatus(importExportStatus, `✗ Export failed: ${error.message}`, 'error');
      }
    }

    // Import data
    async function handleImportData(event) {
      const file = event.target.files[0];
      if (!file) return;

      try {
        showStatus(importExportStatus, 'Reading zip file...', 'info');

        if (!window.JSZip) {
          showStatus(importExportStatus, '✗ Import requires JSZip library. Please check your internet connection or try disabling tracking prevention for this site.', 'error');
          event.target.value = '';
          return;
        }

        const zip = await JSZip.loadAsync(file);
        
        // Verify data folder exists
        const dataFolderFiles = Object.keys(zip.files).filter(name => name.startsWith('data/'));
        if (dataFolderFiles.length === 0) {
          throw new Error('Invalid backup file: data/ folder not found');
        }

        showStatus(importExportStatus, 'Extracting data...', 'info');

        // 1. Import entries JSON
        const variant = window.MEMO_VARIANT || 'default';
        const variantFileName = variant === 'finance' ? 'finance.json' : 'memos.json';
        const entriesFile = zip.file(`data/${variantFileName}`);
        
        if (!entriesFile) {
          throw new Error(`Entries file not found: data/${variantFileName}`);
        }

        const entriesJson = await entriesFile.async('string');
        const entries = JSON.parse(entriesJson);

        // 2. Import chat history
        const chatFileName = variant === 'finance' ? 'chat_finance.json' : 'chat.json';
        const chatFile = zip.file(`data/${chatFileName}`);
        if (chatFile) {
          const chatJson = await chatFile.async('string');
          localStorage.setItem(`memoChat_${variant}`, chatJson);
        }

        // 3. Import hashbook
        const hashbookFile = zip.file('data/hashbook.json');
        if (hashbookFile) {
          const hashbookJson = await hashbookFile.async('string');
          localStorage.setItem('memoHashbook', hashbookJson);
        }

        // 4. Handle images/attachments based on mode
        const MODE = getMode();
        
        if (MODE === 'server') {
          // Server mode: Upload files to server
          showStatus(importExportStatus, 'Uploading files to server...', 'info');
          
          const uploadsFiles = Object.keys(zip.files).filter(name => 
            name.startsWith('data/uploads/') && !zip.files[name].dir
          );

          let uploadedCount = 0;
          const uploadedUrls = new Map(); // Map old paths to new URLs

          for (const filePath of uploadsFiles) {
            try {
              const fileData = await zip.file(filePath).async('blob');
              const filename = filePath.split('/').pop();
              
              // Create File object
              const file = new File([fileData], filename, { type: fileData.type });
              
              // Upload via ServerAPI
              const serverApi = getServerAPI();
              if (serverApi && serverApi.upload) {
                const result = await serverApi.upload(file);
                if (result && result.url) {
                  // Map old path to new URL
                  const oldPath = '/' + filePath.replace('data/', '');
                  uploadedUrls.set(oldPath, result.url);
                  uploadedCount++;
                  showStatus(importExportStatus, `Uploaded ${uploadedCount} / ${uploadsFiles.length} files...`, 'info');
                }
              }
            } catch (err) {
              // Skip failed uploads
            }
          }

          // Update entry URLs to point to new server locations
          for (const entry of entries) {
            if (entry.images) {
              entry.images = entry.images.map(url => uploadedUrls.get(url) || url);
            }
            if (entry.attachments) {
              entry.attachments = entry.attachments.map(att => {
                if (typeof att === 'string') {
                  return uploadedUrls.get(att) || att;
                }
                return {
                  ...att,
                  url: uploadedUrls.get(att.url) || att.url
                };
              });
            }
          }

        } else {
          // Local mode: Store in localStorage/IndexedDB or keep as blob URLs
          // For now, we'll just warn the user that files need manual handling
          showStatus(importExportStatus, 'Note: In local mode, files are not automatically restored. Please manually copy the uploads/ folder to your local server if needed.', 'info');
        }

        // 5. Update the database
        if (window.MemoCore) {
          const { db } = window.MemoCore.getState();
          
          // Option to merge or replace
          const shouldReplace = confirm('Replace all existing data? (Cancel to merge with existing entries)');
          
          if (shouldReplace) {
            db.entries = entries;
          } else {
            // Merge: Add new entries, update existing ones by ID
            const existingIds = new Set(db.entries.map(e => e.id));
            for (const entry of entries) {
              const existingIndex = db.entries.findIndex(e => e.id === entry.id);
              if (existingIndex >= 0) {
                db.entries[existingIndex] = entry;
              } else {
                db.entries.push(entry);
              }
            }
          }

          // Save to server if in server mode
          const serverApi = getServerAPI();
          if (MODE === 'server' && serverApi) {
            showStatus(importExportStatus, 'Saving to server...', 'info');
            // Trigger a full save
            for (const entry of db.entries) {
              try {
                await serverApi.update(entry.id, entry);
              } catch (err) {
                // Skip failed saves
              }
            }
          }

          // Refresh the UI
          if (window.MemoVariant && window.MemoVariant.renderFeed) {
            window.MemoVariant.renderFeed();
          }
        }

        showStatus(importExportStatus, '✓ Import complete! Data has been restored.', 'success');
        
        // Clear file input
        event.target.value = '';

      } catch (error) {
        console.error('Import error:', error);
        showStatus(importExportStatus, `✗ Import failed: ${error.message}`, 'error');
        event.target.value = '';
      }
    }

    // Handle folder selection
    async function handleChooseFolder() {
      // Check if File System Access API is supported
      if (!window.MemoCore || !window.MemoCore.fsSupported || !window.MemoCore.fsSupported()) {
        if (folderStatus) {
          folderStatus.textContent = 'Not supported in this browser';
          folderStatus.style.color = 'var(--error)';
        }
        alert('File System Access API is not supported in this browser. Try Chrome or Edge.');
        return;
      }

      try {
        // Show directory picker
        const dirHandle = await window.showDirectoryPicker({ id: 'memo_root' });
        
        // Request permission
        if (window.MemoCore.ensurePermission) {
          const granted = await window.MemoCore.ensurePermission(dirHandle);
          if (!granted) {
            if (folderStatus) {
              folderStatus.textContent = 'Permission denied';
              folderStatus.style.color = 'var(--error)';
            }
            return;
          }
        }

        // Update settings
        const { settings } = window.MemoCore.getState();
        settings.memoDirHandle = dirHandle;
        settings.fsEnabled = true;
        
        // Persist to IndexedDB
        if (window.MemoCore.idbPut && window.MemoCore.IDB_KEY_ROOT) {
          await window.MemoCore.idbPut(window.MemoCore.IDB_KEY_ROOT, dirHandle);
        }

        // Load data from folder
        if (window.MemoCore.loadFromFolder) {
          await window.MemoCore.loadFromFolder(dirHandle);
          
          // Save and refresh
          if (window.MemoCore.saveAll) {
            window.MemoCore.saveAll();
          }
          
          // Update status
          if (folderStatus) {
            folderStatus.textContent = `Loaded from: ${dirHandle.name}`;
            folderStatus.style.color = 'var(--accent2)';
          }
          
          // Refresh the feed
          if (window.MemoCore.renderFeed) {
            window.MemoCore.renderFeed();
          }
        }
      } catch (error) {
        console.error('Folder selection error:', error);
        if (error.name === 'AbortError') {
          // User cancelled, no message needed
          return;
        }
        if (folderStatus) {
          folderStatus.textContent = `Error: ${error.message}`;
          folderStatus.style.color = 'var(--error)';
        }
      }
    }

    // Event listeners
    if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
    if (mobileSettingsBtn) mobileSettingsBtn.addEventListener('click', openSettings);
    if (closeSettings) closeSettings.addEventListener('click', closeSettingsDialog);
    
    if (saveServerUrl) saveServerUrl.addEventListener('click', handleSaveServerUrl);
    if (clearServerUrl) clearServerUrl.addEventListener('click', handleClearServerUrl);
    
    if (chooseFolderBtn) chooseFolderBtn.addEventListener('click', handleChooseFolder);
    
    if (exportDataBtn) exportDataBtn.addEventListener('click', handleExportData);
    if (importDataInput) importDataInput.addEventListener('change', handleImportData);

    // Close on backdrop click
    if (settingsDlg) {
      settingsDlg.addEventListener('click', (e) => {
        if (e.target === settingsDlg) {
          closeSettingsDialog();
        }
      });
    }
  }
})();
