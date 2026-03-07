/**
 * memo-ocr.js  –  OCR / AI Analysis feature
 *
 * Attaches to the Create/Edit entry modal.
 * When server mode is active, shows an "Analyse with AI" button.
 * On click:
 *   1. Uploads any pending new files via the normal upload API.
 *   2. Creates an OCR draft on /api/ocr/analyze.
 *   3. Polls until done, then shows conflict-resolution UI for each field.
 *
 * Draft persistence: stored in localStorage under key below, keyed by memoId
 * (or '__new__' for unsaved entries), so the user can close and reopen the
 * modal and still see their draft.
 *
 * Suggested tags are rendered with a distinct accent2 colour until the entry
 * is saved, at which point they automatically normalise.
 */

(function (global) {
  'use strict';

  // -------------------------------------------------------------------------
  // Dependencies (resolved lazily to avoid load-order issues)
  // -------------------------------------------------------------------------
  function getApiBase() {
    if (global.MemoRuntime && typeof global.MemoRuntime.getApiBase === 'function') return global.MemoRuntime.getApiBase();
    if (global.MemoContracts) return global.MemoContracts.getApiBase();
    return global.API_BASE || '';
  }
  function getMode() {
    if (global.MemoContracts) return global.MemoContracts.getMode();
    return global.MODE || 'local';
  }
  function getVariant() {
    if (global.MemoContracts) return global.MemoContracts.getVariant();
    return (global.MEMO_VARIANT || 'default');
  }
  function nativeFetch(url, opts) {
    if (global.MemoApi && typeof global.MemoApi.nativeFetch === 'function') return global.MemoApi.nativeFetch(url, opts);
    return fetch(url, opts);
  }

  // -------------------------------------------------------------------------
  // Local draft persistence (localStorage)
  // -------------------------------------------------------------------------
  var LOCAL_KEY_PREFIX = 'memo_ocr_draft_v1_';

  function localDraftKey(memoId) {
    return LOCAL_KEY_PREFIX + (memoId || '__new__') + '_' + getVariant();
  }

  function saveLocalDraft(memoId, draft) {
    try { localStorage.setItem(localDraftKey(memoId), JSON.stringify(draft)); } catch (_e) {}
  }

  function loadLocalDraft(memoId) {
    try {
      var raw = localStorage.getItem(localDraftKey(memoId));
      return raw ? JSON.parse(raw) : null;
    } catch (_e) { return null; }
  }

  function clearLocalDraft(memoId) {
    try { localStorage.removeItem(localDraftKey(memoId)); } catch (_e) {}
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------
  var _activePolls = {}; // draftId -> { timer, stopped }
  var _pollInflight = {}; // draftId -> boolean

  function startPolling(draftId, onUpdate, intervalMs) {
    stopPolling(draftId);
    var baseDelay = intervalMs || 2500; // start at 2.5s to ease load
    var maxDelay = 7000;               // cap at 7s
    var delay = baseDelay;

    function loop() {
      if (!_activePolls[draftId] || _activePolls[draftId].stopped) return;
      if (_pollInflight[draftId]) {
        // If a previous request is still in-flight, try again a bit later
        schedule(Math.min(delay * 1.2, maxDelay));
        return;
      }
      _pollInflight[draftId] = true;
      nativeFetch(getApiBase() + '/api/ocr/draft/' + encodeURIComponent(draftId))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (draft) {
          if (!draft) return;
          onUpdate(draft);
          if (draft.status === 'done' || draft.status === 'error') {
            stopPolling(draftId);
          } else {
            // Gradually back off while still processing
            delay = Math.min(Math.floor(delay * 1.5), maxDelay);
            schedule(delay);
          }
        })
        .catch(function () {
          // transient error – back off a bit and retry
          delay = Math.min(Math.floor(delay * 1.5), maxDelay);
          schedule(delay);
        })
        .finally(function () {
          _pollInflight[draftId] = false;
        });
    }

    function schedule(ms) {
      if (!_activePolls[draftId] || _activePolls[draftId].stopped) return;
      var timer = setTimeout(loop, ms);
      _activePolls[draftId].timer = timer;
    }

    _activePolls[draftId] = { timer: null, stopped: false };
    schedule(delay);
  }

  function stopPolling(draftId) {
    var rec = _activePolls[draftId];
    if (rec) {
      rec.stopped = true;
      if (rec.timer) clearTimeout(rec.timer);
      delete _activePolls[draftId];
    }
    if (_pollInflight[draftId]) delete _pollInflight[draftId];
  }

  // -------------------------------------------------------------------------
  // Field conflict popup
  // -------------------------------------------------------------------------
  /**
   * Show a floating popup anchored below/above a target element.
   * @param {HTMLElement} target - the form field to anchor to
   * @param {string} fieldKey    - logical field name
   * @param {*} proposedValue    - the AI-proposed value
   * @param {Function} onAccept  - called with proposedValue when ✓ is clicked
   * @param {Function} onDiscard - called when ✗ is clicked
   * @returns {HTMLElement} the popup element
   */
  function showConflictPopup(target, fieldKey, proposedValue, onAccept, onDiscard) {
    // Remove any existing popup for this field
    var existing = document.querySelector('.ocr-conflict-popup[data-field="' + fieldKey + '"]');
    if (existing) existing.remove();

    var popup = document.createElement('div');
    popup.className = 'ocr-conflict-popup';
    popup.dataset.field = fieldKey;

    var label = document.createElement('span');
    label.className = 'ocr-conflict-label';
    var displayValue = Array.isArray(proposedValue) ? proposedValue.join(', ') : String(proposedValue);
    label.textContent = '✨ AI: ' + (displayValue.length > 60 ? displayValue.slice(0, 57) + '…' : displayValue);

    var acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'ocr-conflict-accept';
    acceptBtn.title = 'Accept AI suggestion';
    acceptBtn.textContent = '✓';

    var discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'ocr-conflict-discard';
    discardBtn.title = 'Discard AI suggestion';
    discardBtn.textContent = '✗';

    popup.appendChild(label);
    popup.appendChild(acceptBtn);
    popup.appendChild(discardBtn);

    // Position relative to the target
    var parent = target.parentElement || document.body;
    parent.style.position = parent.style.position || 'relative';
    parent.appendChild(popup);

    // After insertion compute position
    var targetRect = target.getBoundingClientRect();
    var parentRect = parent.getBoundingClientRect();
    var topOffset = targetRect.bottom - parentRect.top + 4;
    popup.style.top = topOffset + 'px';
    popup.style.left = (targetRect.left - parentRect.left) + 'px';

    acceptBtn.addEventListener('click', function () {
      popup.remove();
      onAccept(proposedValue);
    });
    discardBtn.addEventListener('click', function () {
      popup.remove();
      if (onDiscard) onDiscard();
    });

    return popup;
  }

  function removeAllConflictPopups() {
    document.querySelectorAll('.ocr-conflict-popup').forEach(function (el) {
      el.remove();
    });
  }

  // -------------------------------------------------------------------------
  // Suggested tag chip rendering (accent2 colour until save)
  // -------------------------------------------------------------------------
  var _suggestedTags = new Set(); // tags suggested by AI, not yet committed

  function markTagsSuggested(tags) {
    (tags || []).forEach(function (t) { _suggestedTags.add(t); });
    refreshSuggestedTagStyles();
  }

  function commitSuggestedTags() {
    // Called when entry is saved – clears the 'suggested' highlight
    _suggestedTags.clear();
    refreshSuggestedTagStyles();
  }

  function refreshSuggestedTagStyles() {
    var chipsEl = document.getElementById('tagChips');
    if (!chipsEl) return;
    chipsEl.querySelectorAll('.chip').forEach(function (chip) {
      var text = chip.childNodes[0] ? chip.childNodes[0].textContent.trim() : '';
      if (_suggestedTags.has(text)) {
        chip.classList.add('chip-ai');
      } else {
        chip.classList.remove('chip-ai');
      }
    });
  }

  // -------------------------------------------------------------------------
  // Apply AI proposal to form
  // -------------------------------------------------------------------------
  /**
   * For each field in `proposed`, compare to current value.
   * If different: show conflict popup.
   * If the form field is empty: apply directly without popup.
   */
  function applyProposal(proposed, memoId) {
    if (!proposed) return;
    var variant = getVariant();

    // Description
    applyTextField('desc', proposed.description, 'description', function (val) {
      var el = document.getElementById('desc');
      if (el) el.value = val;
    });

    // Category
    applyTextField('categoryInput', proposed.category, 'category', function (val) {
      var el = document.getElementById('categoryInput');
      if (!el) return;
      // Try to select existing category in <select>
      var found = false;
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].value === val) { el.value = val; found = true; break; }
      }
      if (!found) {
        // Add new option and select
        var opt = document.createElement('option');
        opt.value = val; opt.textContent = val;
        el.appendChild(opt);
        el.value = val;
        // Also push to settings if MemoCore exposes ensureCategory
        if (typeof global.ensureCategory === 'function') global.ensureCategory(val);
      }
    });

    // Tags – add new AI-suggested tags directly, highlighted in green until saved
    if (Array.isArray(proposed.tags) && proposed.tags.length) {
      var newTags = proposed.tags.filter(function (t) {
        return t && !(global.workingTags && global.workingTags.has(t));
      });
      if (newTags.length) {
        newTags.forEach(function (t) {
          if (global.workingTags) global.workingTags.add(t);
          _suggestedTags.add(t);
        });
        if (typeof global.renderTagChips === 'function') global.renderTagChips();
        refreshSuggestedTagStyles();
      }
    }

    // Finance-specific
    if (variant === 'finance') {
      if (proposed.purchaseDate) {
        applyTextField('entryDate', proposed.purchaseDate, 'purchaseDate', function (val) {
          var el = document.getElementById('entryDate'); if (el) el.value = val;
        });
      }
      applyNumericField('price', proposed.price, 'price');
      applyNumericField('tax', proposed.tax, 'tax');
      applyNumericField('total', proposed.total, 'total');
      // Apply extracted line items
      if (proposed.items && proposed.items.length &&
          window.MemoVariant && typeof window.MemoVariant.applyItems === 'function') {
        window.MemoVariant.applyItems(proposed.items);
      }
    }
  }

  function getFieldCurrentValue(fieldId) {
    var el = document.getElementById(fieldId);
    if (!el) return '';
    return el.value || '';
  }

  function applyTextField(fieldId, proposedVal, fieldKey, applyFn) {
    if (!proposedVal) return;
    var current = getFieldCurrentValue(fieldId).trim();
    if (!current) {
      // No conflict – apply directly
      applyFn(proposedVal);
      return;
    }
    if (current === proposedVal.trim()) return; // Same – no popup needed

    var target = document.getElementById(fieldId);
    if (!target) return;
    showConflictPopup(target, fieldKey, proposedVal,
      function (val) { applyFn(val); },
      null
    );
  }

  function applyNumericField(fieldId, proposedVal, fieldKey) {
    if (proposedVal === undefined || proposedVal === null) return;
    var numVal = parseFloat(proposedVal);
    if (isNaN(numVal)) return;
    applyTextField(fieldId, String(numVal), fieldKey, function (val) {
      var el = document.getElementById(fieldId); if (el) el.value = val;
    });
  }

  function showTagsConflictPopup(newTags) {
    var chipsEl = document.getElementById('tagChips');
    if (!chipsEl) return;

    // Remove any existing tags popup
    var existing = document.querySelector('.ocr-conflict-popup[data-field="tags"]');
    if (existing) existing.remove();

    var popup = document.createElement('div');
    popup.className = 'ocr-conflict-popup';
    popup.dataset.field = 'tags';

    var label = document.createElement('span');
    label.className = 'ocr-conflict-label';
    label.textContent = '✨ AI tags: ' + newTags.join(', ');
    popup.appendChild(label);

    var acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'ocr-conflict-accept';
    acceptBtn.title = 'Add these tags';
    acceptBtn.textContent = '✓';

    var discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'ocr-conflict-discard';
    discardBtn.title = 'Discard suggested tags';
    discardBtn.textContent = '✗';

    popup.appendChild(label);
    popup.appendChild(acceptBtn);
    popup.appendChild(discardBtn);

    var parent = chipsEl.parentElement || document.body;
    parent.style.position = parent.style.position || 'relative';
    parent.appendChild(popup);

    acceptBtn.addEventListener('click', function () {
      popup.remove();
      newTags.forEach(function (t) {
        if (global.workingTags) global.workingTags.add(t);
        _suggestedTags.add(t);
      });
      if (typeof global.renderTagChips === 'function') global.renderTagChips();
      refreshSuggestedTagStyles();
    });

    discardBtn.addEventListener('click', function () {
      popup.remove();
    });
  }

  // -------------------------------------------------------------------------
  // OCR button injection
  // -------------------------------------------------------------------------
  var _ocrState = {
    memoId: null,       // current memoId (null = new entry)
    draftId: null,      // active server draft ID
    status: 'idle',     // idle | uploading | processing | done | error
  };

  function getOcrBtn() { return document.getElementById('ocrAnalyseBtn'); }
  function getOcrStatus() { return document.getElementById('ocrStatusText'); }
  function getOcrClearBtn() { return document.getElementById('ocrClearDraftBtn'); }

  function setOcrBtnState(state, msg) {
    _ocrState.status = state;
    var btn = getOcrBtn();
    var statusEl = getOcrStatus();
    var clearBtn = getOcrClearBtn();

    if (!btn) return;

    switch (state) {
      case 'idle':
        btn.disabled = false;
        btn.textContent = '✨ Analyse with AI';
        if (statusEl) statusEl.textContent = '';
        if (clearBtn) clearBtn.style.display = 'none';
        break;
      case 'uploading':
        btn.disabled = true;
        btn.textContent = '⏳ Uploading…';
        if (statusEl) statusEl.textContent = '';
        break;
      case 'processing':
        btn.disabled = true;
        btn.textContent = '⏳ Analysing…';
        if (statusEl) statusEl.textContent = msg || '';
        break;
      case 'done':
        btn.disabled = false;
        btn.textContent = '✨ Re-analyse';
        if (statusEl) { statusEl.textContent = '✅ Done'; statusEl.style.color = 'var(--accent2)'; }
        if (clearBtn) clearBtn.style.display = 'inline-flex';
        break;
      case 'error':
        btn.disabled = false;
        btn.textContent = '✨ Retry';
        if (statusEl) { statusEl.textContent = '❌ ' + (msg || 'Error'); statusEl.style.color = 'var(--danger)'; }
        if (clearBtn) clearBtn.style.display = 'inline-flex';
        break;
    }
  }

  /**
   * Inject the OCR toolbar row into #entryDlg .actions (before cancel button).
   * Safe to call multiple times – won't duplicate.
   */
  function injectOcrBar() {
    if (document.getElementById('ocrBarRow')) return;

    var actionsEl = document.querySelector('#entryDlg .actions');
    if (!actionsEl) return;

    var bar = document.createElement('div');
    bar.id = 'ocrBarRow';
    bar.className = 'ocr-bar';
    bar.innerHTML = [
      '<button id="ocrAnalyseBtn" type="button" class="ocr-btn" title="Use OCR + AI to analyse attached files and propose edits">',
      '  ✨ Analyse with AI',
      '</button>',
      '<span id="ocrStatusText" class="ocr-status-text"></span>',
      '<button id="ocrClearDraftBtn" type="button" class="ghost ocr-clear-btn" title="Clear AI draft" style="display:none">',
      '  Clear draft',
      '</button>',
    ].join('');

    // Insert before the first action button (after spacer if present)
    var spacer = actionsEl.querySelector('.spacer');
    if (spacer) {
      actionsEl.insertBefore(bar, spacer);
    } else {
      actionsEl.insertBefore(bar, actionsEl.firstChild);
    }

    // Wire events
    document.getElementById('ocrAnalyseBtn').addEventListener('click', onOcrAnalyse);
    document.getElementById('ocrClearDraftBtn').addEventListener('click', onClearDraft);
  }

  /**
   * Show/hide the OCR bar depending on whether we're in server mode.
   */
  function updateOcrBarVisibility() {
    var bar = document.getElementById('ocrBarRow');
    if (!bar) return;
    var isServer = getMode() === 'server';
    bar.style.display = isServer ? 'flex' : 'none';
  }

  // -------------------------------------------------------------------------
  // Main button handler
  // -------------------------------------------------------------------------
  async function onOcrAnalyse() {
    var mode = getMode();
    if (mode !== 'server') {
      alert('AI Analysis requires a connected server. Please configure a server in Settings.');
      return;
    }

    // Check provider/ocr capabilities for better messaging and early failures
    var ocrNote = '';
    try {
      var capResp = await fetch(getApiBase() + '/api/ocr/capabilities');
      if (capResp.ok) {
        var cap = await capResp.json();
        var provider = (cap.provider || '').toLowerCase();
        var vision = !!cap.vision_capable;
        var ocrAvail = cap.ocr && !!cap.ocr.available;
        var backend = cap.ocr ? (cap.ocr.backend || '') : '';
        // Read the live toggle value from settings UI (if open), else fall back to capabilities
        var ocrToggleEl = document.getElementById('ocrEnabledToggle');
        var ocrEnabled = ocrToggleEl ? ocrToggleEl.checked : (provider === 'deepseek' || ocrAvail);
        if (provider === 'deepseek') {
          if (ocrAvail) {
            ocrNote = 'Using traditional OCR (' + backend + ')';
          } else {
            alert('DeepSeek is text-only and no OCR is installed on the server. Please install EasyOCR/Tesseract or switch to a vision provider.');
            return;
          }
        } else if (!vision && !ocrAvail) {
          alert('Selected AI provider cannot read images and no OCR is installed. Please enable OCR or switch provider.');
          return;
        } else if (vision) {
          // Vision-capable provider; if OCR is available, we use both (fusion)
          if (ocrAvail && ocrEnabled) {
            ocrNote = 'Using Vision + OCR (' + backend + ')';
          } else {
            ocrNote = 'Using Vision model';
          }
        }
      }
    } catch (_e) { /* ignore */ }

    setOcrBtnState('uploading', ocrNote);
    removeAllConflictPopups();

    try {
      // Collect new (not-yet-uploaded) files from modalImages + modalFilesExtra
      var filesToUpload = [];
      if (global.modalImages) {
        global.modalImages.forEach(function (mi) {
          if (mi.file) filesToUpload.push(mi.file);
        });
      }
      if (global.modalFilesExtra) {
        global.modalFilesExtra.forEach(function (f) {
          if (f.file) filesToUpload.push(f.file);
        });
      }

      // Collect already-uploaded (existing) file URLs
      var existingUrls = [];
      if (global.modalImages) {
        global.modalImages.forEach(function (mi) {
          if (mi.existing && mi.src && (mi.src.startsWith('/uploads/') || mi.src.startsWith('http'))) {
            existingUrls.push(mi.src);
          }
        });
      }
      if (global.modalFilesExtra) {
        global.modalFilesExtra.forEach(function (f) {
          if (f.existing && f.url && (f.url.startsWith('/uploads/') || f.url.startsWith('http'))) {
            existingUrls.push(f.url);
          }
        });
      }

      if (filesToUpload.length === 0 && existingUrls.length === 0) {
        alert('Please add at least one image or file before running AI analysis.');
        setOcrBtnState('idle');
        return;
      }

      // Build form data
      var formData = new FormData();
      filesToUpload.forEach(function (f) { formData.append('files', f); });
      existingUrls.forEach(function (url) { formData.append('existingUrls', url); });

      var memoId = _ocrState.memoId;
      formData.append('memoId', memoId || '');

      var variant = getVariant();
      formData.append('variant', variant);

      var response = await fetch(getApiBase() + '/api/ocr/analyze?variant=' + encodeURIComponent(variant), {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        var errText = '';
        try { errText = await response.text(); } catch (_e) {}
        throw new Error(errText || 'Server error');
      }

      var draft = await response.json();
      _ocrState.draftId = draft.draftId;
      saveLocalDraft(memoId, draft);

      // Mark newly-uploaded files as existing server files so that a Re-analyse
      // click sends them as existingUrls instead of re-uploading them.
      if (filesToUpload.length > 0 && Array.isArray(draft.tempBin)) {
        var newUrls = draft.tempBin.slice(0, filesToUpload.length);
        var _upIdx = 0;
        if (global.modalImages) {
          global.modalImages.forEach(function (mi) {
            if (mi.file && _upIdx < newUrls.length) {
              mi.src = newUrls[_upIdx];
              mi.existing = true;
              delete mi.file;
              _upIdx++;
            }
          });
        }
        if (global.modalFilesExtra) {
          global.modalFilesExtra.forEach(function (f) {
            if (f.file && _upIdx < newUrls.length) {
              f.url = newUrls[_upIdx];
              f.existing = true;
              delete f.file;
              _upIdx++;
            }
          });
        }
      }

      setOcrBtnState('processing', 'Waiting for AI…');

      // Start polling
      startPolling(draft.draftId, function (updatedDraft) {
        saveLocalDraft(memoId, updatedDraft);
        if (updatedDraft.status === 'done') {
          setOcrBtnState('done');
          applyProposal(updatedDraft.proposed, memoId);
        } else if (updatedDraft.status === 'error') {
          setOcrBtnState('error', updatedDraft.error || 'Analysis failed');
        } else {
          setOcrBtnState('processing', 'AI is thinking…');
        }
      });

    } catch (err) {
      console.error('[OCR] Analysis failed:', err);
      setOcrBtnState('error', err.message || 'Unknown error');
    }
  }

  // -------------------------------------------------------------------------
  // Clear draft
  // -------------------------------------------------------------------------
  async function onClearDraft() {
    removeAllConflictPopups();
    var memoId = _ocrState.memoId;
    clearLocalDraft(memoId);
    _suggestedTags.clear();

    if (_ocrState.draftId) {
      stopPolling(_ocrState.draftId);
      try {
        await nativeFetch(
          getApiBase() + '/api/ocr/draft/' + encodeURIComponent(_ocrState.draftId),
          { method: 'DELETE' }
        );
      } catch (_e) { /* ignore */ }
      _ocrState.draftId = null;
    } else {
      // Clear all drafts for this memo on server
      var variant = getVariant();
      try {
        await nativeFetch(
          getApiBase() + '/api/ocr/drafts?memoId=' + encodeURIComponent(memoId || '') +
          '&variant=' + encodeURIComponent(variant),
          { method: 'DELETE' }
        );
      } catch (_e) { /* ignore */ }
    }

    // Refresh tag chips to remove ai styling
    if (typeof global.renderTagChips === 'function') global.renderTagChips();
    refreshSuggestedTagStyles();
    setOcrBtnState('idle');
  }

  // -------------------------------------------------------------------------
  // Modal open/close hooks (called by openEntryModal)
  // -------------------------------------------------------------------------
  function onModalOpen(memoId) {
    _ocrState.memoId = memoId || null;
    _ocrState.draftId = null;
    _suggestedTags.clear();
    removeAllConflictPopups();

    injectOcrBar();
    updateOcrBarVisibility();
    setOcrBtnState('idle');

    // Restore persisted draft only if analysis is still in progress.
    // Done/error states are one-time-only and should not persist across modal opens.
    if (getMode() === 'server') {
      var saved = loadLocalDraft(memoId);
      if (saved && saved.draftId) {
        if (saved.status === 'processing' || saved.status === 'pending') {
          _ocrState.draftId = saved.draftId;
          setOcrBtnState('processing', 'Resuming…');
          startPolling(saved.draftId, function (updatedDraft) {
            saveLocalDraft(memoId, updatedDraft);
            if (updatedDraft.status === 'done') {
              setOcrBtnState('done');
              applyProposal(updatedDraft.proposed, memoId);
            } else if (updatedDraft.status === 'error') {
              setOcrBtnState('error', updatedDraft.error || 'Analysis failed');
            }
          });
        } else {
          // done / error – clear so the next open starts fresh
          clearLocalDraft(memoId);
        }
      }
    }
  }

  function onModalClose() {
    // Stop any active polls when modal closes
    if (_ocrState.draftId) {
      stopPolling(_ocrState.draftId);
    }
    removeAllConflictPopups();
  }

  // -------------------------------------------------------------------------
  // Hook into memo-core.js globals
  // -------------------------------------------------------------------------
  /**
   * memo-core.js already calls window.MemoOcr.* directly inside openEntryModal,
   * onSaveEntry, cancelBtn, and renderTagChips via direct if-guards.
   * So patchCore() only needs to:
   *  1. Keep bar visibility in sync when detectMode is called.
   *  2. Nothing else – the direct hooks in memo-core.js are sufficient.
   */
  function patchCore() {
    // Keep bar visibility consistent with mode changes
    var origDetectMode = global.detectMode;
    if (typeof origDetectMode === 'function') {
      global.detectMode = async function () {
        var result = await origDetectMode.call(this);
        updateOcrBarVisibility();
        return result;
      };
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchCore);
  } else {
    // DOMContentLoaded already fired; wait one tick for memo-core to finish
    setTimeout(patchCore, 0);
  }

  // Expose for debugging
  global.MemoOcr = {
    onModalOpen: onModalOpen,
    onModalClose: onModalClose,
    commitSuggestedTags: commitSuggestedTags,
    refreshSuggestedTagStyles: refreshSuggestedTagStyles,
  };

})(window);
