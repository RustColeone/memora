(function () {
  'use strict';

  var Runtime = window.MemoRuntime || null;
  var Contracts = window.MemoContracts || null;
  function getApiBase() {
    return Runtime ? Runtime.getApiBase() : (Contracts ? Contracts.getApiBase() : '');
  }
  function getMode() {
    return Contracts ? Contracts.getMode() : (window.MODE || 'local');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function closeMobileMenu() {
    var menu = document.getElementById('mobileMenu');
    var overlay = document.getElementById('mobileOverlay');
    if (menu) menu.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }

  function detectVariant() {
    if (window.MEMO_VARIANT) return String(window.MEMO_VARIANT).toLowerCase();
    var meta = document.querySelector('meta[name="memo-variant"]');
    var value = meta ? String(meta.getAttribute('content') || '').toLowerCase() : '';
    return value === 'finance' ? 'finance' : 'default';
  }

  function getFilteredEntries() {
    if (window.MemoVariant && typeof window.MemoVariant.__lastFiltered === 'function') {
      return window.MemoVariant.__lastFiltered() || [];
    }
    return [];
  }

  function getAllFileLinks(entry) {
    var files = [];
    var images = Array.isArray(entry.images) ? entry.images : [];
    images.forEach(function (url, idx) {
      if (!url) return;
      files.push({
        label: 'Image ' + (idx + 1),
        url: url
      });
    });

    var attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    attachments.forEach(function (attachment, idx) {
      if (!attachment) return;
      var url = attachment.url || attachment.storedPath || '';
      if (!url) return;
      files.push({
        label: attachment.name || ('Attachment ' + (idx + 1)),
        url: url
      });
    });

    return files;
  }

  function renderEntryDetailsHtml(entry, variant) {
    var dateText = '';
    if (variant === 'finance') {
      dateText = escapeHtml(entry.purchaseDate || '');
    } else {
      try {
        dateText = new Date(entry.ts || Date.now()).toLocaleString();
      } catch (_e) {
        dateText = '';
      }
      dateText = escapeHtml(dateText);
    }

    var tags = Array.isArray(entry.tags) && entry.tags.length
      ? entry.tags.map(function (tag) { return '<span class="tag">#' + escapeHtml(tag) + '</span>'; }).join(' ')
      : '<span class="muted">No tags</span>';

    var files = getAllFileLinks(entry);
    var filesHtml = files.length
      ? ('<ul>' + files.map(function (f) {
          return '<li><a href="' + escapeHtml(f.url) + '" target="_blank" rel="noopener">' + escapeHtml(f.label) + ' — ' + escapeHtml(f.url) + '</a></li>';
        }).join('') + '</ul>')
      : '<div class="muted">No linked files</div>';

    var financeExtras = '';
    if (variant === 'finance') {
      var items = Array.isArray(entry.items) ? entry.items : [];
      var itemRows = items.length
        ? ('<table><thead><tr><th>Name</th><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead><tbody>' +
            items.map(function (item) {
              return '<tr>' +
                '<td>' + escapeHtml(item.name || '') + '</td>' +
                '<td>' + escapeHtml(item.description || '') + '</td>' +
                '<td>' + escapeHtml(item.amount == null ? '' : item.amount) + '</td>' +
                '<td>' + escapeHtml(item.unitPrice == null ? '' : item.unitPrice) + '</td>' +
                '<td>' + escapeHtml(item.totalPrice == null ? '' : item.totalPrice) + '</td>' +
              '</tr>';
            }).join('') +
          '</tbody></table>')
        : '<div class="muted">No itemized rows</div>';

      financeExtras =
        '<div><strong>Tax:</strong> ' + escapeHtml(entry.tax == null ? '' : entry.tax) + '</div>' +
        '<div><strong>Total:</strong> ' + escapeHtml(entry.total == null ? '' : entry.total) + '</div>' +
        '<div style="margin-top:8px"><strong>Items:</strong>' + itemRows + '</div>';
    }

    return (
      '<article class="entry">' +
        '<h2>' + escapeHtml(entry.description || '(No description)') + '</h2>' +
        '<div><strong>Category:</strong> ' + escapeHtml(entry.category || 'Uncategorized') + '</div>' +
        '<div><strong>Date:</strong> ' + dateText + '</div>' +
        '<div><strong>Tags:</strong> ' + tags + '</div>' +
        financeExtras +
        '<div style="margin-top:8px"><strong>Linked files:</strong>' + filesHtml + '</div>' +
      '</article>'
    );
  }

  function quickExportPdf(pageSize) {
    var variant = detectVariant();
    var entries = getFilteredEntries();
    if (!entries.length) {
      alert('No filtered entries to export. Adjust filters and try again.');
      return;
    }

    var title = variant === 'finance' ? 'Finance Quick Export' : 'Memo Quick Export';
    var html = [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<title>' + escapeHtml(title) + '</title>',
      '<style>',
      '@page { size: ' + pageSize + '; margin: 14mm; }',
      'body { font-family: Arial, sans-serif; color: #222; }',
      'h1 { margin: 0 0 10px 0; font-size: 20px; }',
      '.meta { color: #666; margin-bottom: 14px; }',
      '.entry { break-inside: avoid; border: 1px solid #ddd; border-radius: 8px; padding: 10px; margin: 0 0 12px 0; }',
      '.entry h2 { margin: 0 0 8px 0; font-size: 16px; }',
      '.tag { display: inline-block; background: #f1f1f1; border-radius: 10px; padding: 2px 8px; margin-right: 6px; margin-top: 4px; }',
      '.muted { color: #777; }',
      'table { border-collapse: collapse; width: 100%; margin-top: 6px; }',
      'th, td { border: 1px solid #ddd; padding: 6px; text-align: left; font-size: 12px; }',
      'a { color: #0645ad; }',
      '</style></head><body>',
      '<h1>' + escapeHtml(title) + '</h1>',
      '<div class="meta">Generated: ' + escapeHtml(new Date().toLocaleString()) + ' | Entries: ' + entries.length + ' | Page size: ' + pageSize + '</div>'
    ];

    entries.forEach(function (entry) {
      html.push(renderEntryDetailsHtml(entry, variant));
    });

    html.push('</body></html>');

    var printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Popup blocked. Please allow popups to export.');
      return;
    }

    printWindow.document.open();
    printWindow.document.write(html.join(''));
    printWindow.document.close();
    setTimeout(function () {
      printWindow.focus();
      printWindow.print();
    }, 300);
  }

  function resolveApiBase() {
    var base = getApiBase().trim();
    if (base) return base;
    if (location.protocol === 'http:' || location.protocol === 'https:') return '';
    return '';
  }

  function isServerDetailedAvailable() {
    if (!navigator.onLine) return false;
    var base = resolveApiBase();
    var mode = (getMode() || '').toLowerCase();
    return mode === 'server' || base !== '' || location.protocol === 'http:' || location.protocol === 'https:';
  }

  async function exportDetailedServerPdf(pageSize) {
    if (!isServerDetailedAvailable()) {
      alert('Detailed server export is available only when online with server access.');
      return;
    }

    var entries = getFilteredEntries();
    if (!entries.length) {
      alert('No filtered entries to export. Adjust filters and try again.');
      return;
    }

    var entryIds = entries.map(function (entry) { return entry.id; }).filter(Boolean);
    if (!entryIds.length) {
      alert('Unable to determine entry IDs for export.');
      return;
    }

    var variant = detectVariant();
    var apiBase = resolveApiBase();
    var url = apiBase + '/api/export/detailed-pdf?variant=' + encodeURIComponent(variant);

    try {
      var response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryIds: entryIds,
          pageSize: pageSize
        })
      });

      if (!response.ok) {
        var errorText = await response.text();
        throw new Error(errorText || ('Export failed with status ' + response.status));
      }

      var blob = await response.blob();
      var blobUrl = URL.createObjectURL(blob);
      var downloadLink = document.createElement('a');
      var ts = new Date().toISOString().replace(/[:.]/g, '-');
      var variantLabel = variant === 'finance' ? 'finance' : 'memo';
      downloadLink.href = blobUrl;
      downloadLink.download = variantLabel + '-detailed-export-' + ts + '.pdf';
      document.body.appendChild(downloadLink);
      downloadLink.click();
      setTimeout(function () {
        URL.revokeObjectURL(blobUrl);
        document.body.removeChild(downloadLink);
      }, 1000);
    } catch (error) {
      console.error('Detailed PDF export failed:', error);
      alert('Detailed PDF export failed: ' + (error && error.message ? error.message : String(error)));
    }
  }

  function getExportDom() {
    return {
      openBtn: document.getElementById('mobileExportPdfBtn'),
      dialog: document.getElementById('exportPdfDlg'),
      mode: document.getElementById('pdfExportMode'),
      modeHint: document.getElementById('pdfExportModeHint'),
      size: document.getElementById('pdfExportPageSize'),
      status: document.getElementById('pdfExportStatus'),
      cancelBtn: document.getElementById('pdfExportCancelBtn'),
      runBtn: document.getElementById('pdfExportRunBtn')
    };
  }

  function setDialogStatus(dom, text, tone) {
    if (!dom.status) return;
    dom.status.textContent = text || '';
    dom.status.style.color = tone === 'error' ? '#ef4444' : 'var(--muted)';
  }

  function syncDialogState(dom) {
    if (!dom.mode || !dom.modeHint || !dom.runBtn) return;

    var mode = dom.mode.value;
    var detailedAvailable = isServerDetailedAvailable();

    if (mode === 'detailed') {
      dom.modeHint.textContent = detailedAvailable
        ? 'Detailed mode uses server rendering with bookmarks and embedded files.'
        : 'Detailed mode requires internet and reachable server connection.';
      dom.runBtn.disabled = !detailedAvailable;
      setDialogStatus(dom, detailedAvailable ? '' : 'Detailed mode is currently unavailable offline.', detailedAvailable ? '' : 'error');
    } else {
      dom.modeHint.textContent = 'Quick mode uses browser print-to-PDF.';
      dom.runBtn.disabled = false;
      setDialogStatus(dom, '');
    }
  }

  function openExportDialog(dom) {
    if (!dom.dialog) return;
    if (dom.mode) dom.mode.value = 'quick';
    if (dom.size) dom.size.value = 'A4';
    syncDialogState(dom);
    dom.dialog.showModal();
  }

  function closeExportDialog(dom) {
    if (dom.dialog && dom.dialog.open) dom.dialog.close();
  }

  async function runDialogExport(dom) {
    if (!dom.mode || !dom.size || !dom.runBtn) return;
    var mode = dom.mode.value;
    var pageSize = String(dom.size.value || 'A4').toUpperCase();
    if (pageSize !== 'A4' && pageSize !== 'LETTER' && pageSize !== 'LEGAL') {
      setDialogStatus(dom, 'Invalid page size selected.', 'error');
      return;
    }

    var entries = getFilteredEntries();
    if (!entries.length) {
      setDialogStatus(dom, 'No filtered entries to export. Adjust filters first.', 'error');
      return;
    }

    dom.runBtn.disabled = true;
    var originalText = dom.runBtn.textContent;
    dom.runBtn.textContent = 'Exporting...';
    try {
      if (mode === 'detailed') {
        await exportDetailedServerPdf(pageSize);
      } else {
        quickExportPdf(pageSize);
      }
      closeExportDialog(dom);
    } finally {
      dom.runBtn.textContent = originalText;
      syncDialogState(dom);
    }
  }

  function init() {
    var dom = getExportDom();
    if (!dom.openBtn || !dom.dialog) return;

    dom.openBtn.addEventListener('click', function () {
      closeMobileMenu();
      openExportDialog(dom);
    });

    if (dom.cancelBtn) {
      dom.cancelBtn.addEventListener('click', function () {
        closeExportDialog(dom);
      });
    }

    if (dom.mode) {
      dom.mode.addEventListener('change', function () {
        syncDialogState(dom);
      });
    }

    if (dom.runBtn) {
      dom.runBtn.addEventListener('click', function () {
        runDialogExport(dom);
      });
    }

    dom.dialog.addEventListener('click', function (event) {
      if (event.target === dom.dialog) {
        closeExportDialog(dom);
      }
    });

    function onConnectivityChange() {
      if (dom.dialog.open) syncDialogState(dom);
    }

    window.addEventListener('online', onConnectivityChange);
    window.addEventListener('offline', onConnectivityChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
