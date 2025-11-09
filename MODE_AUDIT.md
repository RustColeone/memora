# Memo System - Three-Mode Architecture Audit

**Date:** November 9, 2025  
**Purpose:** Complete review of Server Mode, Local Browser Mode, and Capacitor Mode handling

---

## 📋 Mode Detection & Initialization

### 1. **Server Mode** (`window.MODE = 'server'`)
**When it activates:**
- ✅ Running on `https://` protocol (detected in HTML template)
- ✅ Running on `http://` with `memo_server_url` in localStorage
- ✅ Successfully fetches `/api/config` endpoint with `{server: true}`

**Detection flow:**
1. **HTML template** (index.html/finance.html lines 30-67):
   - Sets `window.API_BASE` based on protocol and localStorage
   - HTTPS → `API_BASE = ''` (relative URLs to same server)
   - HTTP with `memo_server_url` → `API_BASE = serverUrl`
   - File protocol → `API_BASE = ''` (local mode)

2. **memo-core.js** `detectMode()` (lines 135-162):
   ```javascript
   async function detectMode() {
     try {
       const r = await fetch(`${API_BASE}/api/config`, { cache: 'no-store' });
       if (r.ok) {
         const j = await r.json();
         MODE = (j && j.server) ? 'server' : 'local';
         window.MODE = MODE;
         return MODE;
       }
     } catch (e) { /* ignore */ }
     // Fallback checks...
   }
   ```

**What happens in Server Mode:**
- ✅ **Sync enabled** - memo-sync.js initializes and runs bidirectional sync
- ✅ **Server API calls** - All CRUD operations go through ServerAPI (create/update/delete)
- ✅ **File uploads** - Images/attachments uploaded to `/api/upload` endpoint
- ✅ **Asset URLs** - Server returns `/uploads/YYYY-MM-DD/HHMM_filename.ext` paths
- ✅ **Blob conversion** - SyncManager downloads server URLs and converts to blob URLs for display
- ❌ **File System Access API** - Disabled (not needed, server stores files)
- ✅ **Settings panel** - Server sync config is disabled/dimmed (already on server)
- ✅ **Local folder selector** - Hidden (lines 72-76 memo-settings.js)

---

### 2. **Local Browser Mode** (`window.MODE = 'local'`)
**When it activates:**
- ✅ Not running on server (no successful `/api/config` response)
- ✅ Not in Capacitor native (`window.__CAP_MODE__` is false)
- ✅ File protocol (`file://`) or HTTP without server URL

**Detection flow:**
1. **HTML template** sets `API_BASE = ''`
2. **detectMode()** fails to reach `/api/config`
3. **Capacitor check** returns false
4. Falls back to `MODE = 'local'`

**What happens in Local Mode:**
- ❌ **Sync disabled** - memo-sync.js returns early if `MODE !== 'server'`
- ✅ **File System Access API** - Available for choosing local folders
- ✅ **localStorage storage** - Entries stored in browser localStorage (DB_KEY)
- ✅ **IndexedDB** - DirectoryHandle persisted for folder access
- ✅ **Blob URLs** - Images/attachments stored as blob URLs in memory
- ✅ **Local folder** - Can use `showDirectoryPicker()` to select memo storage folder
- ✅ **Export/Import** - Full zip export/import via JSZip library
- ✅ **Settings panel** - Shows server sync config (can switch to server mode)
- ✅ **Local folder selector** - Visible and functional

---

### 3. **Capacitor Mode** (`window.MODE = 'capacitor'`)
**When it activates:**
- ✅ Running inside Capacitor native app
- ✅ `window.__CAP_MODE__` is set to true by memo-capacitor.js
- ✅ `Capacitor.isNativePlatform()` returns true

**Detection flow:**
1. **memo-capacitor.js** (lines 1-73):
   - Checks if Capacitor exists and is native platform
   - Sets `window.__CAP_MODE__ = true`
   - Auto-injects CSS and JS files for native builds
   - Hides splash screen when ready

2. **HTML template** (lines 10-27):
   - Loads `memo-capacitor.js`
   - Sets `window.CAP_BOOT = !!window.__CAP_MODE__`
   - Hides File System folder picker button if in Capacitor

3. **detectMode()** fallback:
   ```javascript
   if (window.CAP_BOOT || window.__CAP_MODE__) {
     MODE = 'capacitor';
     return MODE;
   }
   ```

**What happens in Capacitor Mode:**
- ⚠️ **Sync behavior** - Currently uses same logic as Local Mode (should it sync with server?)
- ✅ **File storage** - Uses Capacitor filesystem plugins
- ❌ **File System Access API** - Not available (native filesystem)
- ✅ **localStorage/IndexedDB** - Available for data storage
- ❌ **Folder picker** - Hidden (no showDirectoryPicker in native)
- ✅ **Settings panel** - Shows server sync config
- ❌ **Local folder selector** - Hidden (lines 72-76 memo-settings.js)
- ✅ **Asset loading** - Uses `capacitor://` or `file://` protocol with relative paths

---

## 🔄 Sync Manager Analysis

### memo-sync.js Behavior

**Entry check** (line 80):
```javascript
if (typeof window.MODE === 'undefined' || window.MODE !== 'server') {
  console.log('⏭️  Skipping sync - not in server mode');
  return;
}
```

**Current behavior:**
- ✅ **Server Mode**: Full bidirectional sync enabled
- ❌ **Local Mode**: Sync completely disabled
- ❌ **Capacitor Mode**: Sync completely disabled

**Sync features (Server Mode only):**
1. **Hash-based comparison** - Detects content changes, skips sync if identical
2. **Timestamp comparison** - Uses `updatedAt` for modification detection
3. **File upload** - Uploads local files during sync with hashbook deduplication
4. **Asset download** - Downloads server URLs and converts to blob URLs
5. **Conflict resolution** - Server wins, downloads assets for resolved conflicts
6. **Clean formatting** - Removes blob URLs before sending to server
7. **Timestamp preservation** - Preserves `createdAt`/`updatedAt` from both client and server

---

## 📁 File Handling by Mode

### Server Mode
- **Upload mechanism**: `/api/upload` endpoint
- **File naming**: Server adds `HHMM_` prefix, checks for existing prefix with regex `^\d{4}_`
- **Storage location**: Server's `uploads/YYYY-MM-DD/` folder
- **Asset URLs**: Absolute server paths `/uploads/YYYY-MM-DD/HHMM_filename.ext`
- **Display**: SyncManager downloads URLs → converts to blob URLs for display
- **Persistence**: Server filesystem (permanent)

### Local Browser Mode
- **Upload mechanism**: File input → FileReader → blob URL
- **File naming**: Client-side only, no server prefix
- **Storage location**: Browser memory (blob URLs) or FileSystemDirectoryHandle
- **Asset URLs**: `blob:https://...` or `/uploads/...` if using File System API
- **Display**: Direct blob URLs
- **Persistence**: 
  - **With File System API**: Physical folder on user's machine
  - **Without**: Memory only (lost on refresh unless saved)

### Capacitor Mode
- **Upload mechanism**: Capacitor Camera/Filesystem plugins
- **File naming**: Client-side
- **Storage location**: Native app's filesystem
- **Asset URLs**: `capacitor://` or `file://` protocols with relative paths
- **Display**: Direct native file URLs
- **Persistence**: Native app storage (permanent until app deleted)

---

## 🎯 Feature Matrix

| Feature | Server Mode | Local Browser | Capacitor |
|---------|-------------|---------------|-----------|
| **Sync with server** | ✅ Yes | ❌ No | ❌ No* |
| **File System API** | ❌ No | ✅ Yes | ❌ No |
| **Server API calls** | ✅ Yes | ❌ No | ⚠️ Optional* |
| **localStorage** | ✅ Yes (cache) | ✅ Yes (primary) | ✅ Yes (primary) |
| **IndexedDB** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Blob URLs** | ✅ Yes (display) | ✅ Yes | ✅ Yes |
| **Export/Import** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Folder picker** | ❌ Hidden | ✅ Visible | ❌ Hidden |
| **Server sync config** | ⚠️ Disabled | ✅ Enabled | ✅ Enabled |
| **Offline capable** | ⚠️ Partial | ✅ Yes | ✅ Yes |

\* *Needs clarification: Should Capacitor mode support server sync?*

---

## ⚠️ Potential Issues & Recommendations

### 1. **Capacitor + Server Sync**
**Current state:** Capacitor mode disables sync even if server URL is configured

**Questions:**
- Should Capacitor apps be able to sync with a server?
- If yes, mode detection needs update: `if (MODE === 'server' || (MODE === 'capacitor' && hasServerUrl))`

**Recommendation:**
```javascript
// memo-sync.js line 80
const canSync = window.MODE === 'server' || 
                (window.MODE === 'capacitor' && window.API_BASE && window.API_BASE !== '');
if (!canSync) {
  console.log('⏭️  Skipping sync - not configured for server');
  return;
}
```

### 2. **Mode Transition Edge Cases**
**Scenario:** User opens in local mode, then configures server URL

**Current handling:** ✅ GOOD
- memo-settings.js line 141: Sets `window.MODE = 'server'`
- Initializes SyncManager
- Loads data from server
- Starts sync

**Scenario:** User clears server URL while in server mode

**Current handling:** ✅ GOOD
- memo-settings.js line 215: Sets `window.MODE = 'local'`
- Hides sync status indicator

### 3. **File URL Resolution**
**Server mode:** 
- ✅ Server sends `/uploads/...` 
- ✅ SyncManager downloads and converts to blobs
- ✅ Display uses blob URLs

**Local mode:**
- ✅ Uses blob URLs directly
- ✅ File System API stores real files

**Capacitor mode:**
- ✅ Uses native file:// or capacitor:// URLs
- ⚠️ May need path resolution if syncing with server

### 4. **Timestamp Normalization**
**Recently fixed:** ✅
- Both variants now preserve `createdAt`, `updatedAt`, `deletedAt`, etc.
- Previously: variant `normalizeServerMemo()` was stripping timestamps
- Fix: Added all timestamp fields to normalization functions

### 5. **Asset Download in Capacitor**
**Potential issue:** If Capacitor mode enables server sync
- Downloads would create blob URLs
- May need to save to native filesystem instead
- Capacitor Filesystem plugin integration needed

---

## 📊 Code Flow Diagrams

### Mode Detection Flow
```
HTML Template (index.html/finance.html)
  ↓
Set window.API_BASE based on protocol & localStorage
  ↓
Load memo-capacitor.js (optional)
  ↓ (if Capacitor detected)
Set window.__CAP_MODE__ = true
  ↓
Load memo-core.js
  ↓
detectMode() in memo-core.js
  ↓
┌─────────────────────────────────────┐
│ Try fetch /api/config               │
│   ✅ Success & {server: true}       │
│      → MODE = 'server'              │
│   ❌ Failed or no {server: true}    │
│      → Check Capacitor              │
│         ✅ __CAP_MODE__ = true      │
│            → MODE = 'capacitor'     │
│         ❌ Not Capacitor            │
│            → MODE = 'local'         │
└─────────────────────────────────────┘
  ↓
window.MODE is set globally
  ↓
Initialize appropriate features
```

### Sync Flow (Server Mode Only)
```
User action (create/edit/delete entry)
  ↓
memo-core.js saves to local db
  ↓
SyncManager.performSync()
  ↓
┌────────────────────────────────────┐
│ 1. Compare (POST /api/sync/compare)│
│    - Send local hashes & timestamps│
│    - Server compares with its data │
│    - Returns what needs sync       │
└────────────────────────────────────┘
  ↓
┌────────────────────────────────────┐
│ 2. Upload files (/api/upload)     │
│    - Check hashbook for duplicates │
│    - Upload new files              │
│    - Server adds HHMM_ prefix      │
└────────────────────────────────────┘
  ↓
┌────────────────────────────────────┐
│ 3. Push entries (/api/sync/push)  │
│    - Send entries with clean URLs  │
│    - Server saves & preserves      │
│      client timestamps             │
└────────────────────────────────────┘
  ↓
┌────────────────────────────────────┐
│ 4. Pull entries (/api/sync/pull)  │
│    - Download server's newer       │
│      entries                       │
│    - Download asset files          │
│    - Convert to blob URLs          │
│    - Save to local db              │
└────────────────────────────────────┘
  ↓
✅ Sync complete - UI refreshes
```

### File Upload Flow (Server Mode)
```
User selects file
  ↓
File stored as blob URL in modalImages/modalFilesExtra
  ↓
User saves entry
  ↓
Entry saved to db with blob URL
  ↓
SyncManager.performSync()
  ↓
SyncManager.pushChanges()
  ↓
┌────────────────────────────────────┐
│ For each entry with local files:  │
│   1. Extract file from blob URL   │
│   2. Compute file hash             │
│   3. Check hashbook                │
│      ✅ Hash exists → reuse URL    │
│      ❌ New hash → upload file     │
│   4. POST /api/upload              │
│   5. Server checks HHMM_ prefix    │
│      - Regex: ^\d{4}_              │
│      - Skip prefix if exists       │
│   6. Server returns URL            │
│   7. Update hashbook               │
│   8. Replace blob URL with server  │
│      URL in entry                  │
└────────────────────────────────────┘
  ↓
Push entry with clean server URLs
  ↓
Pull to get final server version
  ↓
downloadAssets() converts URLs → blobs
  ↓
✅ Entry now has blob URLs for display
```

---

## ✅ Verified Correct Behaviors

### 1. Mode Detection ✅
- ✅ Server mode activates when `/api/config` returns `{server: true}`
- ✅ Capacitor mode activates when `window.__CAP_MODE__` is set
- ✅ Local mode is default fallback
- ✅ `window.MODE` is globally accessible

### 2. Sync Activation ✅
- ✅ Only runs in server mode
- ✅ Skips gracefully in local/capacitor modes
- ✅ Can be enabled by setting server URL in settings

### 3. Timestamp Preservation ✅
- ✅ Server preserves client's `createdAt`/`updatedAt` on push
- ✅ Client preserves server's timestamps on pull
- ✅ Both variants normalize with all timestamp fields
- ✅ No regeneration from `ts` field unless timestamps missing

### 4. File Handling ✅
- ✅ Server mode: uploads → server paths → downloaded as blobs
- ✅ Local mode: blob URLs stored directly
- ✅ HHMM_ prefix handled correctly (no double prefixes)
- ✅ Hashbook deduplication working

### 5. UI Adaptations ✅
- ✅ Folder picker hidden in server/capacitor modes
- ✅ Server sync config disabled when already on server
- ✅ Local folder section hidden when not applicable
- ✅ Export/import available in all modes

---

## 🎓 Summary

### **Three Modes Are:**

1. **Server Mode** = Web browser connected to Flask server
   - Full sync, server storage, collaborative-ready
   
2. **Local Browser Mode** = Web browser using File System API
   - No server, local storage, single-user, offline-first
   
3. **Capacitor Mode** = Native mobile app (Android/iOS)
   - Native filesystem, could potentially sync with server

### **Current Architecture:**
- ✅ Mode detection is robust
- ✅ Server mode fully functional with complete sync
- ✅ Local mode works for offline usage
- ✅ Capacitor mode boots correctly
- ⚠️ Capacitor + server sync not implemented (design decision needed)
- ✅ Transitions between modes handled properly

### **All Systems Green:**
- ✅ Sync working correctly in server mode
- ✅ File uploads with proper naming
- ✅ Timestamp preservation fixed
- ✅ Hash-based deduplication working
- ✅ Conflict resolution functional
- ✅ UI adapts to mode correctly
- ✅ Export/import available everywhere

---

## 🔮 Future Considerations

1. **Should Capacitor apps sync with server?**
   - If yes: Update sync check to allow Capacitor + server URL
   - If no: Current implementation is correct

2. **Offline support in server mode**
   - Service worker for offline caching?
   - Queue sync operations when offline?

3. **Multi-device sync**
   - Conflict resolution strategies
   - Last-write-wins vs. merge strategies

4. **File storage quotas**
   - Monitor localStorage size
   - Implement cleanup for old deleted entries
   - Compress images before upload?

---

**End of Audit** ✅
