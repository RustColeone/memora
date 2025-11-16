/**
 * Memo Sync Manager
 * Handles bidirectional synchronization between local client and server
 */

const SyncManager = {
  syncState: {
    lastSyncTime: 0,
    isSyncing: false,
    pendingChanges: [],
    autoSyncInterval: null
  },
  
  /**
   * Initialize the sync manager
   */
  async init() {
    // Only initialize sync if we have a remote server configured
    const hasRemoteServer = window.API_BASE && window.API_BASE.trim() !== '';
    if (!hasRemoteServer) {
      console.log('📡 Sync Manager: No remote server configured, sync disabled');
      return;
    }
    
    console.log('📡 Sync Manager: Initializing with remote server:', window.API_BASE);
    
    // Clear any existing interval to avoid duplicates
    if (this.syncState.autoSyncInterval) {
      clearInterval(this.syncState.autoSyncInterval);
      this.syncState.autoSyncInterval = null;
    }
    
    // Load sync state from localStorage
    const variant = window.MEMO_VARIANT || 'default';
    const stateKey = `memo_sync_state_${variant}`;
    const saved = localStorage.getItem(stateKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        this.syncState = {...this.syncState, ...parsed, autoSyncInterval: null, isSyncing: false};
      } catch (e) {
        console.warn('Failed to parse sync state:', e);
      }
    }
    
    // Auto-sync every 5 minutes
    this.syncState.autoSyncInterval = setInterval(() => {
      this.performSync();
    }, 5 * 60 * 1000);
    
    // Sync when user returns to tab (use once to avoid duplicate listeners)
    const visibilityHandler = () => {
      if (!document.hidden && !this.syncState.isSyncing) {
        this.performSync();
      }
    };
    // Remove old listener if exists
    document.removeEventListener('visibilitychange', visibilityHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
    
    // Sync before page unload (best effort)
    const unloadHandler = () => {
      if (this.syncState.pendingChanges.length > 0) {
        // Use sendBeacon for guaranteed delivery
        const data = JSON.stringify({
          entries: this.getPendingEntries(),
          deleted: []
        });
        const variant = window.MEMO_VARIANT || 'default';
        let apiBase = window.API_BASE || '';
        apiBase = apiBase.replace(/\/$/, '');
        navigator.sendBeacon(`${apiBase}/api/sync?variant=${variant}`, data);
      }
    };
    // Remove old listener if exists
    window.removeEventListener('beforeunload', unloadHandler);
    window.addEventListener('beforeunload', unloadHandler);
  },
  
  /**
   * Perform a full sync cycle with efficient comparison-based sync
   */
  async performSync() {
    if (this.syncState.isSyncing) {
      return;
    }
    
    // Only sync when we have a remote server configured
    // Don't sync if we're running directly on the server (API_BASE is empty)
    const hasRemoteServer = window.API_BASE && window.API_BASE.trim() !== '';
    if (!hasRemoteServer) {
      // We're either in local mode or accessing the server directly (same origin)
      // In both cases, no sync is needed
      return;
    }
    
    // Also check that we're not in pure local mode
    if (typeof window.MODE === 'undefined' || window.MODE === 'local') {
      return;
    }
    
    this.syncState.isSyncing = true;
    this.updateSyncUI('syncing', 'Syncing...');
    
    try {
      console.log('🔄 Starting efficient sync...');
      
      // Phase 1: Push local changes (this also compares and identifies what to download)
      const pushResult = await this.pushChanges();
      
      // Phase 2: Pull only if server has newer entries
      if (pushResult && pushResult.needsDownload && pushResult.needsDownload.length > 0) {
        console.log('⬇️  Server has', pushResult.needsDownload.length, 'newer entries, pulling them...');
        await this.pullChanges();
      } else {
        console.log('✅ Everything in sync, no pull needed!');
      }
      
      // Update last sync time
      this.syncState.lastSyncTime = Date.now();
      this.saveSyncState();
      
      this.updateSyncUI('success', 'Synced');
    } catch (err) {
      console.error('Sync failed:', err);
      console.error('   Error type:', err?.constructor?.name);
      console.error('   Error message:', err?.message);
      console.error('   Error stack:', err?.stack);
      this.updateSyncUI('error', 'Sync failed');
    } finally {
      this.syncState.isSyncing = false;
    }
  },
  
  /**
   * Pull changes from server
   */
  async pullChanges() {
    const variant = window.MEMO_VARIANT || 'default';
    let apiBase = window.API_BASE || '';
    // Remove trailing slash to avoid double slashes
    apiBase = apiBase.replace(/\/$/, '');
    const url = `${apiBase}/api/sync?since=${this.syncState.lastSyncTime}&variant=${variant}`;
    
    const resp = await fetch(url, {
      method: 'GET',
      cache: 'no-store'
    });
    
    if (!resp.ok) {
      throw new Error(`Pull failed: ${resp.status} ${resp.statusText}`);
    }
    
    const data = await resp.json();
    
    if (!data || !Array.isArray(data.entries)) {
      throw new Error('Invalid server response');
    }
    
    let changesApplied = 0;
    
    // Get db reference from MemoCore
    const { db } = window.MemoCore.getState();
    
    // Apply server changes to local db
    for (const serverEntry of data.entries) {
      const localIdx = db.entries.findIndex(e => e.id === serverEntry.id);
      
      if (localIdx >= 0) {
        const local = db.entries[localIdx];
        const localModified = local.modifiedAt || 0;
        const serverModified = this.parseTimestamp(serverEntry.updatedAt);
        
        // Check if local has pending changes
        if (this.syncState.pendingChanges.includes(serverEntry.id)) {
          // Keep local version, will push in next phase
          continue;
        } else if (localModified > serverModified) {
          // Local is newer but not marked as pending - mark it now
          this.syncState.pendingChanges.push(serverEntry.id);
        } else {
          // Server wins, overwrite local
          const normalized = this.normalizeServerEntry(serverEntry);
          // Download assets before storing
          const withAssets = await this.downloadAssets(normalized);
          db.entries[localIdx] = withAssets;
          changesApplied++;
        }
      } else {
        // New entry from server
        const normalized = this.normalizeServerEntry(serverEntry);
        // Download assets before storing
        const withAssets = await this.downloadAssets(normalized);
        db.entries.push(withAssets);
        changesApplied++;
      }
    }
    
    // Remove entries deleted on server
    if (Array.isArray(data.deleted)) {
      data.deleted.forEach(id => {
        const idx = db.entries.findIndex(e => e.id === id);
        if (idx >= 0) {
          db.entries.splice(idx, 1);
          changesApplied++;
        }
      });
    }
    
    if (changesApplied > 0) {
      console.log(`📥 Pulled ${changesApplied} changes from server`);
      
      // Write to local folder if enabled
      const { settings } = window.MemoCore.getState();
      if (settings.fsEnabled && settings.memoDirHandle) {
        try {
          // Format entries for JSON storage - MATCH SERVER FORMAT EXACTLY
          const formattedEntries = db.entries.map(entry => {
            const formatted = {
              id: entry.id,
              description: entry.description,
              category: entry.category,
              tags: entry.tags || [],
              ts: entry.ts,
              createdAt: entry.createdAt || new Date(entry.ts).toISOString(),
              updatedAt: entry.updatedAt || new Date(entry.ts).toISOString(),
              deletedAt: entry.deletedAt || null,
              deletedBy: entry.deletedBy || null,
              permanentDeleteAt: entry.permanentDeleteAt || null
            };
            
            // Add variant-specific fields
            if (window.MEMO_VARIANT === 'finance') {
              formatted.purchaseDate = entry.purchaseDate;
              formatted.price = entry.price;
              formatted.tax = entry.tax;
              formatted.adjustment = entry.adjustment;
              formatted.total = entry.total;
            }
            
            // Images: ONLY use _storedPaths (never blob URLs from entry.images)
            if (entry._storedPaths && entry._storedPaths.length > 0) {
              // Convert _storedPaths to server URL format
              formatted.images = entry._storedPaths.map(sp => `/uploads/${sp}`);
            } else {
              formatted.images = [];
            }
            
            // Attachments: convert storedPath to server URL format
            if (entry.attachments && entry.attachments.length > 0) {
              formatted.attachments = entry.attachments.map(att => ({
                name: att.name,
                url: att.storedPath ? `/uploads/${att.storedPath}` : att.url,
                type: att.type
              }));
            } else {
              formatted.attachments = [];
            }
            
            return formatted;
          });
          
          // Write to data/ folder (matching server structure - ARRAY not object)
          const variant = window.MEMO_VARIANT || 'default';
          const filename = variant === 'finance' ? 'finance.json' : 'memos.json';
          
          const dataDir = await settings.memoDirHandle.getDirectoryHandle('data', { create: true });
          const dataFileHandle = await dataDir.getFileHandle(filename, { create: true });
          const dataWritable = await dataFileHandle.createWritable();
          await dataWritable.write(JSON.stringify(formattedEntries, null, 2)); // Array, not {entries: []}
          await dataWritable.close();
          
          // Initialize other data files if they don't exist
          const chatFilename = variant === 'finance' ? 'chat_finance.json' : 'chat.json';
          try {
            await dataDir.getFileHandle(chatFilename);
          } catch {
            // Create empty chat file
            const chatHandle = await dataDir.getFileHandle(chatFilename, { create: true });
            const chatWritable = await chatHandle.createWritable();
            await chatWritable.write(JSON.stringify([], null, 2));
            await chatWritable.close();
          }
          
          // Initialize hashbook.json from server data
          try {
            const hashHandle = await dataDir.getFileHandle('hashbook.json', { create: true });
            const hashWritable = await hashHandle.createWritable();
            // Use server's hashbook if available, otherwise empty object
            const hashbookData = data.hashbook || {};
            await hashWritable.write(JSON.stringify(hashbookData, null, 2));
            await hashWritable.close();
          } catch (e) {
            console.error('Failed to sync hashbook:', e);
          }
          
          // CRITICAL: Reload from folder to convert storedPaths to blob URLs
          if (window.MemoCore && window.MemoCore.loadFromFolder) {
            await window.MemoCore.loadFromFolder(settings.memoDirHandle);
            return; // loadFromFolder already calls saveAll() and renderFeed()
          }
        } catch (e) {
          console.error('Failed to update local JSON:', e);
        }
      }
      
      // Save and refresh UI (only if we didn't reload from folder)
      if (window.MemoCore && window.MemoCore.saveAll) {
        window.MemoCore.saveAll();
      }
      if (window.MemoCore && window.MemoCore.renderFeed) {
        window.MemoCore.renderFeed();
      }
    }
  },
  
  /**
   * Push local changes to server
   */
  async pushChanges() {
    // Get db reference
    const { db } = window.MemoCore.getState();
    
    console.log('🔄 Push Sync: Starting push process...');
    
    // Step 1: Send local entry summary to server for comparison
    const localSummary = db.entries
      .filter(e => !e.deletedAt) // Don't include deleted entries in summary
      .map(e => {
        const hash = this.hashEntry(e);
        const modifiedAt = this.parseTimestamp(e.updatedAt) || e.ts || Date.now();
        console.log(`📝 Entry ${e.id}: updatedAt=${e.updatedAt}, modifiedAt=${modifiedAt}, hash=${hash}`);
        return {
          id: e.id,
          modifiedAt: modifiedAt, // Use updatedAt timestamp for modification comparison
          hash: hash // Simple hash of entry content
        };
      });
    
    const localDeleted = db.entries
      .filter(e => e.deletedAt)
      .map(e => e.id);
    
    console.log('📋 Push Sync: Local summary:', localSummary.length, 'entries,', localDeleted.length, 'deleted');
    
    const variant = window.MEMO_VARIANT || 'default';
    let apiBase = window.API_BASE || '';
    apiBase = apiBase.replace(/\/$/, '');
    
    // Step 2: Get server's comparison result
    const compareUrl = `${apiBase}/api/sync/compare?variant=${variant}`;
    console.log('📡 Push Sync: Sending summary to server for comparison...');
    
    let compareResp;
    try {
      compareResp = await fetch(compareUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          entries: localSummary,
          deleted: localDeleted
        })
      });
    } catch (fetchErr) {
      console.error('❌ Push Sync: Network error during compare:', fetchErr);
      console.error('   URL:', compareUrl);
      console.error('   Error type:', fetchErr.constructor.name);
      console.error('   Error message:', fetchErr.message);
      console.error('   Error stack:', fetchErr.stack);
      throw new Error(`Network error: ${fetchErr.message}`);
    }
    
    if (!compareResp.ok) {
      const errText = await compareResp.text();
      console.error('❌ Push Sync: Compare failed:', compareResp.status, compareResp.statusText);
      console.error('   Response body:', errText);
      throw new Error(`Compare failed: ${compareResp.status} ${compareResp.statusText} - ${errText}`);
    }
    
    const comparison = await compareResp.json();
    console.log('📊 Push Sync: Server comparison result:', comparison);
    
    // comparison contains:
    // - needsUpload: IDs of entries that need to be sent to server (new or modified locally)
    // - needsDownload: IDs of entries that need to be fetched from server (modified on server)
    // - needsDelete: IDs of entries to delete from server
    
    const toUpload = db.entries.filter(e => comparison.needsUpload && comparison.needsUpload.includes(e.id));
    const toDelete = comparison.needsDelete || [];
    const needsDownload = comparison.needsDownload || [];
    
    console.log('📤 Push Sync: Found', toUpload.length, 'entries to upload,', toDelete.length, 'to delete,', needsDownload.length, 'to download');
    
    if (toUpload.length === 0 && toDelete.length === 0 && needsDownload.length === 0) {
      console.log('✅ Push Sync: Everything in sync!');
      return { needsDownload: [] };
    }
    
    // Return early if nothing to upload, but indicate what needs download
    if (toUpload.length === 0 && toDelete.length === 0) {
      console.log('✅ Push Sync: Nothing to push to server');
      return { needsDownload };
    }
    
    console.log('📤 Push Sync: Entries to upload:', toUpload.map(e => ({id: e.id, description: e.description, hasImages: e._storedPaths?.length || 0, hasAttachments: e.attachments?.length || 0})));
    
    // Format entries for server (clean format without blob URLs or _storedPaths)
    const formattedEntries = [];
    
    // Upload files and format entries - get settings from MemoCore state
    const { settings } = window.MemoCore.getState();
    const hasFileAccess = settings.fsEnabled && settings.memoDirHandle;
    
    if (hasFileAccess) {
      console.log('📁 Push Sync: File system access available, will upload files');
    } else {
      console.log('⚠️  Push Sync: No file system access available');
    }
    
    for (const entry of toUpload) {
      console.log(`� Formatting entry: ${entry.id} "${entry.description}"`);
      
      // Create clean formatted entry
      const formatted = {
        id: entry.id,
        description: entry.description,
        category: entry.category,
        tags: entry.tags || [],
        ts: entry.ts,
        createdAt: entry.createdAt || new Date(entry.ts).toISOString(),
        updatedAt: entry.updatedAt || new Date().toISOString(),
        deletedAt: entry.deletedAt || null,
        deletedBy: entry.deletedBy || null,
        permanentDeleteAt: entry.permanentDeleteAt || null,
        images: [],
        attachments: []
      };
      
      // Add variant-specific fields
      if (window.MEMO_VARIANT === 'finance') {
        formatted.purchaseDate = entry.purchaseDate;
        formatted.price = entry.price;
        formatted.tax = entry.tax;
        formatted.adjustment = entry.adjustment;
        formatted.total = entry.total;
      }
      
      // Upload images if local files exist
      if (hasFileAccess && entry._storedPaths && entry._storedPaths.length > 0) {
        console.log(`🖼️  Uploading ${entry._storedPaths.length} images for entry "${entry.description}"...`);
        
        for (const storedPath of entry._storedPaths) {
          try {
            // Get the file from local storage
            const parts = storedPath.split('/');
            const dateFolder = parts[0];
            const filename = parts[1];
            
            console.log(`   ↗️ Uploading: ${storedPath}`);
            
            const dateDir = await settings.memoDirHandle.getDirectoryHandle(dateFolder);
            const fileHandle = await dateDir.getFileHandle(filename);
            const file = await fileHandle.getFile();
            
            // Upload to server (server will check hashbook and deduplicate)
            const formData = new FormData();
            formData.append('file', file, filename);
            
            let apiBase = window.API_BASE || '';
            apiBase = apiBase.replace(/\/$/, '');
            
            const uploadResp = await fetch(`${apiBase}/api/upload`, {
              method: 'POST',
              body: formData
            });
            
            if (uploadResp.ok) {
              const result = await uploadResp.json();
              formatted.images.push(result.url);
              console.log(`   ✅ Uploaded: ${result.url}`);
            } else {
              console.error(`   ❌ Upload failed for ${storedPath}:`, uploadResp.status);
            }
          } catch (err) {
            console.error(`   ❌ Failed to upload image ${storedPath}:`, err);
          }
        }
      } else if (entry.images && entry.images.length > 0) {
        // Entry has images but no local files - likely from server mode
        // Filter out blob URLs, keep only server URLs
        formatted.images = entry.images.filter(img => 
          typeof img === 'string' && img.startsWith('/uploads/')
        );
      }
      
      // Upload attachments if local files exist
      if (hasFileAccess && entry.attachments && entry.attachments.length > 0) {
        const attachmentsToUpload = entry.attachments.filter(a => a.storedPath);
        
        if (attachmentsToUpload.length > 0) {
          console.log(`📎 Uploading ${attachmentsToUpload.length} attachments for entry "${entry.description}"...`);
        }
        
        for (const attachment of entry.attachments) {
          if (attachment.storedPath) {
            try {
              const parts = attachment.storedPath.split('/');
              const dateFolder = parts[0];
              const filename = parts[1];
              
              console.log(`   ↗️ Uploading: ${attachment.name} (${attachment.storedPath})`);
              
              const dateDir = await settings.memoDirHandle.getDirectoryHandle(dateFolder);
              const fileHandle = await dateDir.getFileHandle(filename);
              const file = await fileHandle.getFile();
              
              // Upload to server (server will check hashbook and deduplicate)
              const formData = new FormData();
              formData.append('file', file, filename);
              
              let apiBase = window.API_BASE || '';
              apiBase = apiBase.replace(/\/$/, '');
              
              const uploadResp = await fetch(`${apiBase}/api/upload`, {
                method: 'POST',
                body: formData
              });
              
              if (uploadResp.ok) {
                const result = await uploadResp.json();
                formatted.attachments.push({
                  name: attachment.name,
                  url: result.url,
                  type: attachment.type
                });
                console.log(`   ✅ Uploaded: ${result.url}`);
              } else {
                console.error(`   ❌ Upload failed for ${attachment.name}:`, uploadResp.status);
              }
            } catch (err) {
              console.error(`   ❌ Failed to upload attachment ${attachment.name}:`, err);
            }
          } else if (attachment.url && attachment.url.startsWith('/uploads/')) {
            // Attachment already on server
            formatted.attachments.push({
              name: attachment.name,
              url: attachment.url,
              type: attachment.type
            });
          }
        }
      }
      
      formattedEntries.push(formatted);
      console.log(`✅ Formatted entry ${entry.id}: ${formatted.images.length} images, ${formatted.attachments.length} attachments`);
    }
    
    // Step 3: Push the formatted entries to server
    const pushUrl = `${apiBase}/api/sync?variant=${variant}`;
    
    console.log('📡 Push Sync: Sending formatted entries to server via POST /api/sync...');
    console.log('   Entries:', formattedEntries.length, 'Deleted:', toDelete.length);
    
    const resp = await fetch(pushUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        entries: formattedEntries,
        deleted: toDelete
      })
    });
    
    if (!resp.ok) {
      console.error('❌ Push Sync: Failed:', resp.status, resp.statusText);
      throw new Error(`Push failed: ${resp.status} ${resp.statusText}`);
    }
    
    const result = await resp.json();
    console.log('✅ Push Sync: Server response:', result);
    
    // Handle conflicts
    if (result.conflicts && result.conflicts.length > 0) {
      console.log('⚠️  Push Sync: Conflicts detected:', result.conflicts);
      this.handleConflicts(result.conflicts);
    }
    
    console.log('✅ Push Sync: Complete!');
    
    // Return info about what needs to be downloaded (let performSync handle it)
    return { needsDownload };
  },
  
  /**
   * Create a simple hash of an entry for comparison
   */
  hashEntry(entry) {
    // Create a stable string representation of the entry
    // Use the actual field names from the data structure
    const relevant = {
      attachments: (entry.attachments || []).map(a => a.name || '').join(','),
      category: entry.category || '',
      description: entry.description || entry.title || '',
      images: (entry.images || []).length
    };
    
    // Keys are already alphabetically ordered above (attachments, category, description, images)
    console.log(`   Client hashing entry ${entry.id}:`, relevant);
    
    // Simple hash function - must match Python implementation exactly
    const str = JSON.stringify(relevant);
    console.log(`   Client stringified:`, str);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  },
  
  /**
   * Get entries that need to be uploaded
   */
  getPendingEntries() {
    const { db } = window.MemoCore.getState();
    return db.entries.filter(e => {
      // Include if in pending list
      if (this.syncState.pendingChanges.includes(e.id)) {
        return true;
      }
      
      // Include if modified after last sync
      if (e.modifiedAt && e.modifiedAt > this.syncState.lastSyncTime) {
        return true;
      }
      
      return false;
    });
  },
  
  /**
   * Handle sync conflicts
   */
  async handleConflicts(conflicts) {
    const { db } = window.MemoCore.getState();
    let resolved = 0;
    
    for (const conflict of conflicts) {
      if (conflict.resolution === 'server_wins') {
        const idx = db.entries.findIndex(e => e.id === conflict.id);
        if (idx >= 0) {
          // Mark the entry as having a conflict
          const serverEntry = this.normalizeServerEntry(conflict.serverVersion);
          serverEntry._hasConflict = true;
          serverEntry._conflictClientVersion = JSON.stringify(conflict.clientVersion);
          serverEntry._conflictResolvedAt = Date.now();
          
          // Download assets to convert server URLs to blob URLs
          db.entries[idx] = await this.downloadAssets(serverEntry);
          resolved++;
        }
      }
    }
    
    if (resolved > 0) {
      console.warn(`⚠️ ${resolved} conflict(s) detected - entries marked for review`);
      if (window.MemoCore && window.MemoCore.saveAll) {
        window.MemoCore.saveAll();
      }
      if (window.MemoCore && window.MemoCore.renderFeed) {
        window.MemoCore.renderFeed();
      }
      
      // Show notification to user
      if (typeof alert !== 'undefined') {
        setTimeout(() => {
          alert(`⚠️ ${resolved} sync conflict(s) detected.\n\nThe server version was kept, but entries are marked with ⚠️ for your review.\n\nPlease review and edit these entries as needed.`);
        }, 100);
      }
    }
  },
  
  /**
   * Normalize server entry to match client structure
   */
  /**
   * Download and cache assets (images and attachments) from server to local folder
   * Keeps server paths in JSON, writes actual files to disk
   */
  async downloadAssets(entry) {
    const apiBase = (window.API_BASE || '').replace(/\/$/, '');
    const isFileProtocol = window.location.protocol === 'file:';
    const needsDownload = isFileProtocol || !navigator.onLine;
    
    // Skip downloading if we're on https and online
    if (!needsDownload && window.location.protocol === 'https:') {
      return entry;
    }
    
    const { settings } = window.MemoCore.getState();
    const fsEnabled = settings.fsEnabled && settings.memoDirHandle;
    
    // If no folder selected, can't download
    if (!fsEnabled) {
      console.warn('⚠️ No folder selected. Please choose a folder in Settings first.');
      return entry;
    }
    
    // Helper to get or create directory
    const getOrCreateDir = async (root, name) => {
      try {
        return await root.getDirectoryHandle(name, { create: true });
      } catch (e) {
        console.error(`Failed to create directory ${name}:`, e);
        return null;
      }
    };
    
    // Helper to write file to FS
    const writeFileToFS = async (dirHandle, filename, blob) => {
      try {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch (e) {
        console.error(`Failed to write file ${filename}:`, e);
        return false;
      }
    };
    
    // Download images and save to local folder
    if (entry.images && entry.images.length > 0) {
      const storedPaths = [];
      
      for (const imgUrl of entry.images) {
        try {
          // Parse the server path: /uploads/2025-09-21/2048_Ferrites_Long.jpg
          // Server format: /uploads/DATE/FILENAME
          // Local format: DATE/FILENAME (no /uploads prefix)
          const match = imgUrl.match(/\/uploads\/([^\/]+)\/(.+)/);
          if (!match) {
            console.warn(`Invalid image path format: ${imgUrl}`);
            continue;
          }
          
          const dateFolder = match[1]; // e.g., "2025-09-21"
          const filename = match[2];   // e.g., "2048_Ferrites_Long.jpg" - keep original name!
          
          // Construct full URL for download
          const fullUrl = `${apiBase}${imgUrl}`;
          
          // Fetch the image
          const response = await fetch(fullUrl);
          if (!response.ok) {
            continue;
          }
          
          const blob = await response.blob();
          
          // Write to local folder with same structure (no /uploads prefix)
          const dateDir = await getOrCreateDir(settings.memoDirHandle, dateFolder);
          if (!dateDir) continue;
          
          const written = await writeFileToFS(dateDir, filename, blob);
          if (written) {
            // Store as relative path: "2025-09-21/2048_Ferrites_Long.jpg"
            const storedPath = `${dateFolder}/${filename}`;
            storedPaths.push(storedPath);
          }
        } catch (error) {
          // Skip failed downloads silently
        }
      }
      
      // Keep original server paths in images array
      // Store local paths in _storedPaths for rendering
      if (storedPaths.length > 0) {
        entry._storedPaths = storedPaths;
      }
    }
    
    // Download attachments and save to local folder
    if (entry.attachments && entry.attachments.length > 0) {
      for (const attachment of entry.attachments) {
        try {
          const attUrl = attachment.url;
          
          // Parse the server path: /uploads/2025-09-27/file.pdf
          const match = attUrl.match(/\/uploads\/([^\/]+)\/(.+)/);
          if (!match) {
            continue;
          }
          
          const dateFolder = match[1];
          const filename = match[2]; // Keep original filename!
          
          // Construct full URL for download
          const fullUrl = `${apiBase}${attUrl}`;
          
          // Fetch the attachment
          const response = await fetch(fullUrl);
          if (!response.ok) {
            continue;
          }
          
          const blob = await response.blob();
          
          // Write to local folder with same structure (no /uploads prefix)
          const dateDir = await getOrCreateDir(settings.memoDirHandle, dateFolder);
          if (!dateDir) continue;
          
          const written = await writeFileToFS(dateDir, filename, blob);
          if (written) {
            // Store as relative path: "2025-09-27/file.pdf"
            const storedPath = `${dateFolder}/${filename}`;
            attachment.storedPath = storedPath;
          }
        } catch (error) {
          // Skip failed downloads silently
        }
      }
    }
    
    return entry;
  },
  
  normalizeServerEntry(serverEntry) {
    // Use variant-specific normalization if available
    if (window.MemoVariant && typeof window.MemoVariant.normalizeServerMemo === 'function') {
      return window.MemoVariant.normalizeServerMemo(serverEntry);
    }
    
    // Default normalization
    return {
      id: serverEntry.id,
      description: serverEntry.description || '',
      category: serverEntry.category || 'Uncategorized',
      tags: serverEntry.tags || [],
      ts: serverEntry.ts || Date.now(),
      images: serverEntry.images || [],
      attachments: serverEntry.attachments || [],
      createdAt: serverEntry.createdAt,
      updatedAt: serverEntry.updatedAt,
      deletedAt: serverEntry.deletedAt || null,
      deletedBy: serverEntry.deletedBy || null,
      permanentDeleteAt: serverEntry.permanentDeleteAt || null
    };
  },
  
  /**
   * Mark an entry as modified (needs sync)
   */
  markModified(entryId) {
    const entry = db.entries.find(e => e.id === entryId);
    if (entry) {
      entry.modifiedAt = Date.now();
      if (!this.syncState.pendingChanges.includes(entryId)) {
        this.syncState.pendingChanges.push(entryId);
      }
      this.saveSyncState();
    }
  },
  
  /**
   * Save sync state to localStorage
   */
  saveSyncState() {
    const variant = window.MEMO_VARIANT || 'default';
    const stateKey = `memo_sync_state_${variant}`;
    const toSave = {
      lastSyncTime: this.syncState.lastSyncTime,
      pendingChanges: this.syncState.pendingChanges
    };
    localStorage.setItem(stateKey, JSON.stringify(toSave));
  },
  
  /**
   * Parse ISO timestamp to milliseconds
   */
  parseTimestamp(iso) {
    if (!iso) return 0;
    try {
      return new Date(iso).getTime();
    } catch (e) {
      return 0;
    }
  },
  
  /**
   * Update sync status UI
   */
  updateSyncUI(status, message) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    
    const iconEl = el.querySelector('#syncIcon');
    const textEl = el.querySelector('#syncText');
    
    if (!iconEl || !textEl) return;
    
    // Update class
    el.className = `sync-status ${status}`;
    
    // Update icon
    const icons = {
      syncing: '🔄',
      success: '✅',
      error: '❌',
      idle: '☁️'
    };
    iconEl.textContent = icons[status] || icons.idle;
    
    // Update text
    textEl.textContent = message;
    
    // Auto-transition success to idle
    if (status === 'success') {
      setTimeout(() => {
        if (el.classList.contains('success')) {
          iconEl.textContent = '☁️';
          textEl.textContent = 'Synced';
          el.className = 'sync-status';
        }
      }, 2000);
    }
  },
  
  /**
   * Trigger manual sync
   */
  async manualSync() {
    await this.performSync();
  },
  
  /**
   * Cleanup on shutdown
   */
  destroy() {
    if (this.syncState.autoSyncInterval) {
      clearInterval(this.syncState.autoSyncInterval);
    }
  }
};

// Expose globally
window.SyncManager = SyncManager;
