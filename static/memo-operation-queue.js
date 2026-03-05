/**
 * Operation Queue Manager for Event Sourcing
 * Handles reliable operation queuing, retry logic, and sync
 */

function queueGetContracts() {
  return window.MemoContracts || null;
}

function queueGetRuntime() {
  return window.MemoRuntime || null;
}

function queueGetApiBase() {
  const runtime = queueGetRuntime();
  if (runtime && typeof runtime.getApiBase === 'function') {
    return runtime.getApiBase();
  }
  const contracts = queueGetContracts();
  if (contracts && typeof contracts.getApiBase === 'function') {
    return contracts.getApiBase();
  }
  return '';
}

function queueGetVariant() {
  const contracts = queueGetContracts();
  if (contracts && typeof contracts.getVariant === 'function') {
    return contracts.getVariant();
  }
  return window.MEMO_VARIANT || 'default';
}

const OperationQueue = {
  queue: [],
  lastServerOpId: 0,
  isSyncing: false,
  autoSyncInterval: null,
  deviceId: null,
  visibilityHandler: null,
  unloadHandler: null,
  
  /**
   * Initialize the operation queue
   */
  init() {
    console.log('📋 Operation Queue: Initializing...');
    console.log('   Device ID generation/loading...');
    
    // Generate or load device ID
    this.deviceId = localStorage.getItem('memo_device_id');
    if (!this.deviceId) {
      this.deviceId = 'device-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('memo_device_id', this.deviceId);
      console.log('   ✅ New device ID created:', this.deviceId);
    } else {
      console.log('   ✅ Device ID loaded:', this.deviceId);
    }
    
    // Load queue from localStorage
    const variant = queueGetVariant();
    const queueKey = `memo_operation_queue_${variant}`;
    console.log('   Loading queue from:', queueKey);
    
    const saved = localStorage.getItem(queueKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        this.queue = parsed.queue || [];
        this.lastServerOpId = parsed.lastServerOpId || 0;
        console.log(`📋 Loaded ${this.queue.length} queued operations, last server opId: ${this.lastServerOpId}`);
      } catch (e) {
        console.warn('Failed to parse operation queue:', e);
        this.queue = [];
        console.log('📋 Loaded 0 queued operations (parse error), last server opId: 0');
      }
    } else {
      console.log('📋 No saved queue found - starting fresh');
      console.log('📋 Loaded 0 queued operations, last server opId: 0');
    }
    
    // Auto-sync every 5 minutes
    this.autoSyncInterval = setInterval(() => {
      this.processQueue();
    }, 5 * 60 * 1000);
    console.log('   ✅ Auto-sync scheduled (every 5 minutes)');
    
    // Sync when user returns to tab
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = () => {
      if (!document.hidden && !this.isSyncing) {
        this.processQueue();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    console.log('   ✅ Visibility sync enabled');
    
    // Best effort sync on unload
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
    }
    this.unloadHandler = () => {
      this.saveQueue();
    };
    window.addEventListener('beforeunload', this.unloadHandler);
    console.log('   ✅ Unload sync enabled');
    
    console.log('✅ Operation Queue initialization complete!');
    
    // Smart sync state detection
    const { db } = window.MemoCore.getState();
    const hasLocalEntries = db && db.entries && db.entries.length > 0;
    
    if (!hasLocalEntries && this.lastServerOpId > 0) {
      console.log('⚠️ No local entries but lastServerOpId is', this.lastServerOpId);
      console.log('🔄 Resetting sync state to pull all operations...');
      this.lastServerOpId = 0;
      this.saveQueue();
    }
    
    // Perform initial sync to pull server operations
    console.log('🔄 Performing initial sync to pull server state...');
    this.processQueue().catch(err => {
      console.error('❌ Initial sync failed:', err);
    });
  },
  
  /**
   * Add an operation to the queue
   */
  async addOperation(type, entryId, data = {}) {
    const operation = {
      clientOpId: `${this.deviceId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: type,
      entryId: entryId,
      timestamp: Date.now(),
      deviceId: this.deviceId,
      synced: false,
      attempts: 0,
      lastError: null,
      nextRetry: 0,
      ...data
    };
    
    console.log(`➕ Adding operation to queue: ${type} on ${entryId}`);
    this.queue.push(operation);
    
    // Apply operation locally immediately
    await this.applyOperationLocally(operation);
    
    // Save queue
    this.saveQueue();
    
    // Try to sync immediately if online
    if (navigator.onLine) {
      setTimeout(() => this.processQueue(), 100);
    }
    
    return operation.clientOpId;
  },
  
  /**
   * Apply an operation to local state
   */
  async applyOperationLocally(operation) {
    const { db } = window.MemoCore.getState();
    const entryId = operation.entryId;
    const apiBase = queueGetApiBase().replace(/\/$/, '');
    
    // Helper to convert relative URLs to absolute
    const fixImageUrl = (url) => {
      if (!url) return url;
      // If URL starts with / and we have an apiBase, make it absolute
      if (url.startsWith('/') && apiBase) {
        return `${apiBase}${url}`;
      }
      return url;
    };
    
    switch (operation.type) {
      case 'create':
        // Add new entry
        let newEntry = {
          id: entryId,
          ...operation.data,
          createdAt: new Date(operation.timestamp).toISOString(),
          updatedAt: new Date(operation.timestamp).toISOString()
        };
        
        // Fix image URLs to be absolute
        if (newEntry.images && Array.isArray(newEntry.images)) {
          newEntry.images = newEntry.images.map(fixImageUrl);
        }
        
        // Fix attachment URLs to be absolute
        if (newEntry.attachments && Array.isArray(newEntry.attachments)) {
          newEntry.attachments = newEntry.attachments.map(att => ({
            ...att,
            url: fixImageUrl(att.url)
          }));
        }
        
        db.entries.push(newEntry);
        
        // Download assets if needed
        if (window.SyncManager && window.SyncManager.downloadAssets) {
          const idx = db.entries.findIndex(e => e.id === entryId);
          if (idx >= 0) {
            db.entries[idx] = await window.SyncManager.downloadAssets(db.entries[idx]);
          }
        }
        break;
        
      case 'update':
        // Update existing entry
        const updateIdx = db.entries.findIndex(e => e.id === entryId);
        if (updateIdx >= 0) {
          if (operation.data) {
            const updateData = { ...operation.data };
            
            // Fix image URLs to be absolute
            if (updateData.images && Array.isArray(updateData.images)) {
              updateData.images = updateData.images.map(fixImageUrl);
            }
            
            // Fix attachment URLs to be absolute
            if (updateData.attachments && Array.isArray(updateData.attachments)) {
              updateData.attachments = updateData.attachments.map(att => ({
                ...att,
                url: fixImageUrl(att.url)
              }));
            }
            
            Object.assign(db.entries[updateIdx], updateData);
          } else if (operation.field && 'value' in operation) {
            db.entries[updateIdx][operation.field] = operation.value;
          }
          db.entries[updateIdx].updatedAt = new Date(operation.timestamp).toISOString();
          
          // Download assets if needed
          if (window.SyncManager && window.SyncManager.downloadAssets) {
            db.entries[updateIdx] = await window.SyncManager.downloadAssets(db.entries[updateIdx]);
          }
        }
        break;
        
      case 'delete':
        // Soft delete
        const deleteIdx = db.entries.findIndex(e => e.id === entryId);
        if (deleteIdx >= 0) {
          db.entries[deleteIdx].deletedAt = new Date(operation.timestamp).toISOString();
          db.entries[deleteIdx].deletedBy = this.deviceId;
        }
        break;
        
      case 'addImage':
        // Add image to entry (URL will be set after upload)
        const imgIdx = db.entries.findIndex(e => e.id === entryId);
        if (imgIdx >= 0) {
          if (!db.entries[imgIdx].images) {
            db.entries[imgIdx].images = [];
          }
          if (operation.url) {
            db.entries[imgIdx].images.push(operation.url);
          }
        }
        break;
        
      case 'addAttachment':
        // Add attachment to entry
        const attIdx = db.entries.findIndex(e => e.id === entryId);
        if (attIdx >= 0) {
          if (!db.entries[attIdx].attachments) {
            db.entries[attIdx].attachments = [];
          }
          if (operation.attachment) {
            db.entries[attIdx].attachments.push(operation.attachment);
          }
        }
        break;
    }
    
    // Save changes and refresh UI
    if (window.MemoCore && window.MemoCore.saveAll) {
      window.MemoCore.saveAll();
    }
    if (window.MemoCore && window.MemoCore.renderFeed) {
      window.MemoCore.renderFeed();
    }
  },
  
  /**
   * Process the operation queue - upload files and push operations to server
   */
  async processQueue() {
    if (this.isSyncing) {
      console.log('⏸️ Already syncing, skipping...');
      return;
    }
    
    // Only sync when we have a remote server configured
    const apiBase = queueGetApiBase();
    const hasRemoteServer = apiBase && apiBase.trim() !== '';
    if (!hasRemoteServer) {
      return;
    }
    
    this.isSyncing = true;
    this.updateSyncUI('syncing', 'Processing queue...');
    
    try {
      // Step 1: Process unsynced operations (upload files, push to server)
      await this.pushUnsyncedOperations();
      
      // Step 2: Pull new operations from server
      await this.pullServerOperations();
      
      this.updateSyncUI('success', 'Synced');
    } catch (err) {
      console.error('❌ Queue processing failed:', err);
      this.updateSyncUI('error', 'Sync failed');
    } finally {
      this.isSyncing = false;
    }
  },
  
  /**
   * Push unsynced operations to server
   */
  async pushUnsyncedOperations() {
    const unsyncedOps = this.queue.filter(op => !op.synced);
    
    if (unsyncedOps.length === 0) {
      console.log('✅ No unsynced operations');
      return;
    }
    
    console.log(`📤 Pushing ${unsyncedOps.length} unsynced operations...`);
    
    for (const op of unsyncedOps) {
      // Check if we need to wait for retry delay
      if (Date.now() < op.nextRetry) {
        console.log(`⏰ Operation ${op.clientOpId} waiting for retry delay`);
        continue;
      }
      
      try {
        console.log(`🔄 Processing operation ${op.clientOpId} (${op.type} on ${op.entryId})`);
        
        // Upload files if needed
        console.log(`📤 Uploading files for operation ${op.clientOpId}...`);
        await this.uploadFilesForOperation(op);
        console.log(`✅ Files uploaded for operation ${op.clientOpId}`);
        
        // Push operation to server
        console.log(`📡 Pushing operation ${op.clientOpId} to server...`);
        await this.pushOperationToServer(op);
        console.log(`✅ Operation ${op.clientOpId} pushed successfully`);
        
        // Mark as synced
        op.synced = true;
        op.lastError = null;
        
        console.log(`✅ Operation ${op.clientOpId} synced successfully`);
        
      } catch (err) {
        // Handle failure with exponential backoff
        op.attempts++;
        op.lastError = err.message;
        op.nextRetry = Date.now() + (Math.pow(2, op.attempts) * 1000);
        
        console.error(`❌ Operation ${op.clientOpId} failed (attempt ${op.attempts}): ${err.message}`);
        console.error(`   Error type: ${err.name}`);
        console.error(`   Full error:`, err);
        console.error(`   Operation type: ${op.type} on ${op.entryId}`);
        
        if (op.attempts > 10) {
          op.needsManualReview = true;
          console.error(`⚠️ Operation ${op.clientOpId} needs manual review after ${op.attempts} attempts`);
        }
      }
    }
    
    // Save updated queue
    this.saveQueue();
    
    // Clean up old synced operations (keep last 100)
    const syncedOps = this.queue.filter(op => op.synced);
    if (syncedOps.length > 100) {
      syncedOps.sort((a, b) => b.timestamp - a.timestamp);
      const toKeep = syncedOps.slice(0, 100);
      this.queue = this.queue.filter(op => !op.synced || toKeep.includes(op));
      this.saveQueue();
    }
  },
  
  /**
   * Upload files for an operation (images, attachments)
   */
  async uploadFilesForOperation(op) {
    console.log(`📤 uploadFilesForOperation for ${op.type} on ${op.entryId}`);
    
    const { settings } = window.MemoCore.getState();
    const hasFileAccess = settings.fsEnabled && settings.memoDirHandle;
    
    console.log(`📤 File access: ${hasFileAccess}`);
    
    if (!hasFileAccess) {
      console.log(`📤 No file access, skipping uploads`);
      return; // No files to upload
    }
    
    // Upload image if needed
    if (op.type === 'addImage' && op.localFilePath && !op.url) {
      const url = await this.uploadFile(op.localFilePath);
      op.url = url;
    }
    
    // Upload attachment if needed
    if (op.type === 'addAttachment' && op.attachment && op.attachment.storedPath && !op.attachment.url) {
      const url = await this.uploadFile(op.attachment.storedPath);
      op.attachment.url = url;
    }
    
    // Upload files in operation data if needed
    if (op.data && op.data._filesToUpload) {
      for (const filePath of op.data._filesToUpload) {
        const url = await this.uploadFile(filePath);
        // Store uploaded URL (will be added to operation when pushed)
        if (!op.data._uploadedUrls) {
          op.data._uploadedUrls = [];
        }
        op.data._uploadedUrls.push(url);
      }
    }
  },
  
  /**
   * Upload a file to server with checksum validation
   */
  async uploadFile(localFilePath) {
    const { settings } = window.MemoCore.getState();
    
    // Parse local file path: "2026-02-02/image.jpg"
    const parts = localFilePath.split('/');
    const dateFolder = parts[0];
    const filename = parts[1];
    
    // Get file from local storage
    const dateDir = await settings.memoDirHandle.getDirectoryHandle(dateFolder);
    const fileHandle = await dateDir.getFileHandle(filename);
    const file = await fileHandle.getFile();
    
    // Calculate checksum
    const arrayBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const clientHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    console.log(`📤 Uploading ${filename} (hash: ${clientHash.substr(0, 8)}...)`);
    
    // Upload to server
    let apiBase = queueGetApiBase() || '';
    apiBase = apiBase.replace(/\/$/, '');
    const uploadUrl = `${apiBase}/api/upload`;
    
    let uploadResp;
    
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
      // Use native HTTP for Capacitor
      const base64Data = await this.fileToBase64(file);
      const response = await window.Capacitor.Plugins.CapacitorHttp.post({
        url: uploadUrl,
        headers: { 'Content-Type': 'application/json' },
        data: {
          file: base64Data,
          filename: filename,
          type: file.type || 'application/octet-stream'
        }
      });
      
      uploadResp = {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.data
      };
    } else {
      // Standard fetch
      const formData = new FormData();
      formData.append('file', file, filename);
      
      uploadResp = await fetch(uploadUrl, {
        method: 'POST',
        body: formData
      });
    }
    
    if (!uploadResp.ok) {
      throw new Error(`Upload failed: ${uploadResp.status}`);
    }
    
    const result = await uploadResp.json();
    
    // Verify checksum
    if (result.hash && result.hash !== clientHash) {
      throw new Error(`Checksum mismatch! Client: ${clientHash.substr(0, 8)}, Server: ${result.hash.substr(0, 8)}`);
    }
    
    console.log(`✅ Upload verified: ${result.url}`);
    return result.url;
  },
  
  /**
   * Push an operation to server
   */
  async pushOperationToServer(op) {
    let apiBase = queueGetApiBase() || '';
    apiBase = apiBase.replace(/\/$/, '');
    const variant = queueGetVariant();
    const url = `${apiBase}/api/operations/push?variant=${variant}`;
    
    console.log(`📡 Push URL: ${url}`);
    console.log(`📡 API_BASE: "${apiBase}"`);
    console.log(`📡 Variant: ${variant}`);
    
    // Prepare operation for server
    const serverOp = {
      clientOpId: op.clientOpId,
      type: op.type,
      entryId: op.entryId,
      timestamp: op.timestamp,
      deviceId: op.deviceId,
      data: op.data,
      field: op.field,
      value: op.value,
      url: op.url,
      attachment: op.attachment
    };
    
    console.log(`📡 Sending operation:`, serverOp);
    
    let resp;
    
    try {
    console.log(`🔍 Checking fetch environment...`);
    console.log(`   window.location.protocol: ${window.location.protocol}`);
    console.log(`   Target URL: ${url}`);
    console.log(`   Has fetch: ${typeof fetch !== 'undefined'}`);
    
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
      const response = await window.Capacitor.Plugins.CapacitorHttp.post({
        url: url,
        headers: { 'Content-Type': 'application/json' },
        data: { operations: [serverOp] }
      });
      
      resp = {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.data
      };
    } else {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: [serverOp] })
      });
    }
    
    console.log(`📡 Response status: ${resp.status}`);
    
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unable to read error');
      console.error(`❌ Push failed with status ${resp.status}: ${errorText}`);
      throw new Error(`Push failed: ${resp.status} - ${errorText}`);
    }
    
    const result = await resp.json();
    console.log(`📡 Server response:`, result);
    
    if (result.operations && result.operations.length > 0) {
      const assigned = result.operations[0];
      op.serverOpId = assigned.serverOpId;
      
      if (assigned.serverOpId > this.lastServerOpId) {
        this.lastServerOpId = assigned.serverOpId;
      }
    }
    } catch (err) {
      console.error(`❌ pushOperationToServer error:`, err);
      throw err;
    }
  },
  
  /**
   * Pull new operations from server and apply them
   */
  async pullServerOperations() {
    let apiBase = queueGetApiBase() || '';
    apiBase = apiBase.replace(/\/$/, '');
    const variant = queueGetVariant();
    const url = `${apiBase}/api/operations/pull?variant=${variant}&sinceOpId=${this.lastServerOpId}`;
    
    console.log(`📥 Pulling operations from server...`);
    console.log(`   URL: ${url}`);
    console.log(`   Last server opId: ${this.lastServerOpId}`);
    
    let resp;
    
    try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
      const response = await window.Capacitor.Plugins.CapacitorHttp.get({ url: url });
      resp = {
        ok: response.status >= 200 && response.status < 300,
        json: async () => response.data
      };
    } else {
      resp = await fetch(url, { method: 'GET', cache: 'no-store' });
    }
    
    console.log(`📥 Pull response status: ${resp.status}`);
    
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unable to read error');
      console.error(`❌ Pull failed: ${resp.status} - ${errorText}`);
      throw new Error(`Pull failed: ${resp.status}`);
    }
    
    const result = await resp.json();
    console.log(`📥 Pull result:`, result);
    
    // Handle full sync if needed
    if (result.needsFullSync && result.snapshot) {
      console.log('📥 Full sync required, loading snapshot...');
      await this.applySnapshot(result.snapshot);
      this.lastServerOpId = result.snapshot.snapshotId;
    }
    
    // Apply new operations
    if (result.operations && result.operations.length > 0) {
      console.log(`📥 Applying ${result.operations.length} server operations...`);
      
      for (const serverOp of result.operations) {
        // Skip operations we created (already applied locally)
        if (serverOp.deviceId === this.deviceId) {
          this.lastServerOpId = Math.max(this.lastServerOpId, serverOp.opId);
          continue;
        }
        
        // Apply server operation locally
        await this.applyOperationLocally(serverOp);
        this.lastServerOpId = Math.max(this.lastServerOpId, serverOp.opId);
      }
      
      // After applying all operations, save to local file system
      console.log('💾 Saving entries to local file system...');
      if (window.MemoCore && window.MemoCore.saveAll) {
        await window.MemoCore.saveAll();
      }
      
      // Regenerate blob URLs from storedPaths for all entries
      console.log('🔄 Regenerating blob URLs from local files...');
      const { db, settings } = window.MemoCore.getState();
      if (settings.fsEnabled && settings.memoDirHandle) {
        for (const entry of db.entries) {
          if (entry._storedPaths && entry._storedPaths.length > 0) {
            const blobUrls = [];
            for (const storedPath of entry._storedPaths) {
              try {
                const blobUrl = await window.MemoCore.urlFromStoredPath(settings.memoDirHandle, storedPath);
                if (blobUrl) blobUrls.push(blobUrl);
              } catch (err) {
                console.warn(`Failed to load image from ${storedPath}:`, err);
              }
            }
            // Replace images array with blob URLs
            if (blobUrls.length > 0) {
              entry.images = blobUrls;
            }
          }
        }
        console.log('✅ Blob URLs regenerated');
      }
      
      if (window.MemoCore && window.MemoCore.renderFeed) {
        window.MemoCore.renderFeed();
      }
    }
    
    this.saveQueue();
    } catch (err) {
      console.error(`❌ pullServerOperations error:`, err);
      throw err;
    }
  },
  
  /**
   * Apply a snapshot (full sync)
   */
  async applySnapshot(snapshot) {
    const { db } = window.MemoCore.getState();
    
    // Replace all entries with snapshot
    db.entries = snapshot.entries || [];
    
    // Download assets for all entries
    if (window.SyncManager && window.SyncManager.downloadAssets) {
      for (let i = 0; i < db.entries.length; i++) {
        db.entries[i] = await window.SyncManager.downloadAssets(db.entries[i]);
      }
    }
    
    // Save and refresh
    if (window.MemoCore && window.MemoCore.saveAll) {
      window.MemoCore.saveAll();
    }
    if (window.MemoCore && window.MemoCore.renderFeed) {
      window.MemoCore.renderFeed();
    }
    
    console.log(`📸 Snapshot applied: ${db.entries.length} entries loaded`);
  },
  
  /**
   * Save queue to localStorage
   */
  saveQueue() {
    const variant = queueGetVariant();
    const queueKey = `memo_operation_queue_${variant}`;
    const data = {
      queue: this.queue,
      lastServerOpId: this.lastServerOpId
    };
    localStorage.setItem(queueKey, JSON.stringify(data));
  },
  
  /**
   * Helper: File to base64
   */
  fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result);
      reader.onerror = error => reject(error);
    });
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
    
    el.className = `sync-status ${status}`;
    
    const icons = {
      syncing: '🔄',
      success: '✅',
      error: '❌',
      idle: '☁️'
    };
    iconEl.textContent = icons[status] || icons.idle;
    textEl.textContent = message;
    
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
   * Manual sync trigger
   */
  async manualSync() {
    await this.processQueue();
  },
  
  /**
   * Cleanup
   */
  destroy() {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
  }
};

// Expose globally
window.OperationQueue = OperationQueue;
