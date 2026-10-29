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
    if (window.MemoTheme) window.MemoTheme.closeMobileMenu();
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
      window.MemoShell && window.MemoShell.toast('No filtered entries to export. Adjust filters and try again.', { kind: 'info' });
      return;
    }

    var sheet = (variant === 'finance' && window.MemoVariant && typeof window.MemoVariant.activeSheet === 'function')
      ? window.MemoVariant.activeSheet() : '';
    var title = variant === 'finance'
      ? ('Finance — ' + (sheet || 'General') + ' — Quick Export')
      : 'Memo Quick Export';
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
      window.MemoShell && window.MemoShell.toast('Popup blocked. Please allow popups to export.', { kind: 'error' });
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

  // ── Detailed PDF, generated on-device with jsPDF (works fully offline) ──
  // jsPDF is a lazy vendor: fetch it only when a detailed export actually runs.
  var _jspdfPromise = null;
  function ensureJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf);
    if (_jspdfPromise) return _jspdfPromise;
    _jspdfPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = (window.STATIC_BASE || '/static/') + 'vendor/jspdf.umd.min.js';
      s.onload = function () { (window.jspdf && window.jspdf.jsPDF) ? resolve(window.jspdf) : reject(new Error('PDF engine failed to initialize')); };
      s.onerror = function () { _jspdfPromise = null; reject(new Error('Could not load the PDF engine')); };
      document.head.appendChild(s);
    });
    return _jspdfPromise;
  }
  // Entry images may be blob:/data:/http URLs already, or a stored path that only
  // the local store can resolve — the latter is what makes this work offline.
  async function resolveImageUrl(entry, i) {
    var raw = (entry.images || [])[i];
    if (!raw) return null;
    if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
    var stored = Array.isArray(entry._storedPaths) ? entry._storedPaths[i] : null;
    var sdb = window.MemoStateDb;
    if (stored && sdb && typeof sdb.blobUrl === 'function') {
      try { var u = await sdb.blobUrl(stored); if (u) return u; } catch (_e) {}
    }
    return raw;
  }
  function loadImageForPdf(url) {
    return new Promise(function (resolve) {
      if (!url) { resolve(null); return; }
      var img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
          c.getContext('2d').drawImage(img, 0, 0);
          resolve({ dataUrl: c.toDataURL('image/jpeg', 0.82), w: c.width, h: c.height });
        } catch (_e) { resolve(null); }   // cross-origin taint → skip the image, keep the text
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }
  function downloadBlob(blob, filename) {
    var blobUrl = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = blobUrl; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { try { URL.revokeObjectURL(blobUrl); a.remove(); } catch (_e) {} }, 1000);
  }
  async function exportDetailedClientPdf(pageSize) {
    var entries = getFilteredEntries();
    if (!entries.length) { window.MemoShell && window.MemoShell.toast('No filtered entries to export. Adjust filters and try again.', { kind: 'info' }); return; }
    var jspdf;
    try { jspdf = await ensureJsPdf(); } catch (e) { window.MemoShell && window.MemoShell.toast((e && e.message) || 'PDF engine unavailable', { kind: 'error' }); return; }
    var variant = detectVariant();
    var isImage = (window.MemoCore && window.MemoCore.isImage) || function () { return true; };
    var doc = new jspdf.jsPDF({ orientation: 'portrait', unit: 'pt', format: pageSize.toLowerCase(), compress: true });
    var pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
    var M = 40, cw = pw - M * 2, y = M;
    function ensure(space) { if (y + space > ph - M) { doc.addPage(); y = M; } }
    function textBlock(str, size, style, r, g, b, lh) {
      doc.setFont('helvetica', style || 'normal'); doc.setFontSize(size); doc.setTextColor(r, g, b);
      var lines = doc.splitTextToSize(String(str == null ? '' : str), cw);
      for (var i = 0; i < lines.length; i++) { ensure(lh); doc.text(lines[i], M, y + lh - 4); y += lh; }
    }
    textBlock(variant === 'finance' ? 'Finance — Detailed Export' : 'Memo — Detailed Export', 18, 'bold', 20, 20, 20, 22);
    textBlock('Generated ' + new Date().toLocaleString() + '  ·  ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies'), 9, 'normal', 120, 120, 120, 14);
    y += 4;
    for (var idx = 0; idx < entries.length; idx++) {
      var e = entries[idx];
      ensure(40);
      doc.setDrawColor(220); doc.line(M, y, pw - M, y); y += 12;
      textBlock(e.description || '(No description)', 13, 'bold', 25, 25, 25, 17);
      var dateText = variant === 'finance' ? (e.purchaseDate || '') : (function () { try { return new Date(e.ts || Date.now()).toLocaleString(); } catch (_x) { return ''; } })();
      textBlock((e.category || 'Uncategorized') + '   ·   ' + dateText, 9, 'normal', 110, 110, 110, 13);
      textBlock((e.tags || []).length ? '#' + e.tags.join('   #') : 'No tags', 9, 'normal', 130, 130, 130, 12);
      if (variant === 'finance') {
        if (e.total != null || e.tax != null) textBlock('Total: ' + (e.total == null ? '' : e.total) + '     Tax: ' + (e.tax == null ? '' : e.tax), 9, 'bold', 40, 40, 40, 13);
        (Array.isArray(e.items) ? e.items : []).forEach(function (it) {
          textBlock('•  ' + (it.name || '') + (it.totalPrice != null ? '  —  ' + it.totalPrice : ''), 9, 'normal', 70, 70, 70, 12);
        });
      }
      y += 4;
      var imgs = (e.images || []);
      for (var i = 0; i < imgs.length; i++) {
        if (!isImage(imgs[i])) continue;
        var info = await loadImageForPdf(await resolveImageUrl(e, i));
        if (!info || !info.w) continue;
        var iw = cw, ih = info.h * (cw / info.w);
        var maxH = ph - M * 2;
        if (ih > maxH) { ih = maxH; iw = info.w * (maxH / info.h); }
        ensure(ih + 8);
        try { doc.addImage(info.dataUrl, 'JPEG', M, y, iw, ih); } catch (_e) {}
        y += ih + 10;
      }
      var files = getAllFileLinks(e).filter(function (f) { return !/^Image \d+$/.test(f.label); });
      if (files.length) {
        textBlock('Attachments:', 9, 'bold', 40, 40, 40, 13);
        files.forEach(function (f) { textBlock('•  ' + f.label, 9, 'normal', 90, 90, 90, 12); });
      }
      y += 8;
    }
    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(doc.output('blob'), (variant === 'finance' ? 'finance' : 'memo') + '-detailed-' + ts + '.pdf');
    window.MemoShell && window.MemoShell.toast('Detailed PDF exported', { kind: 'success' });
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
    dom.modeHint.textContent = (mode === 'detailed')
      ? 'Detailed mode builds a PDF on your device — full entry details + embedded images. Works offline.'
      : 'Quick mode uses browser print-to-PDF.';
    dom.runBtn.disabled = false;
    setDialogStatus(dom, '');
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
        await exportDetailedClientPdf(pageSize);
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
