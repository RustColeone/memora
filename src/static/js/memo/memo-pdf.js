// memo-pdf.js — pdf.js loading + PDF-attachment helpers for the reader adapter.
//
// The reader itself (static/reader/reader.js, the shared UniversalReader) opens
// and renders PDFs natively via pdf.js; all this module contributes is:
//   • ensure()  — MIME-proof lazy loader for the vendored pdf.js build. Dynamic
//     import() and module Workers reject a script served with the wrong MIME,
//     and Flask-on-Windows / capacitor:// / many static hosts serve .mjs as
//     application/octet-stream — so we fetch the .mjs as text and import it
//     through a Blob URL tagged text/javascript. Both main and worker are
//     vendored with WebView 85 compatibility. The adapter assigns the
//     result to window.pdfjsLib, which UniversalReader checks first.
//   • isPdf(att) / blob(att) — recognise a PDF attachment and read its bytes
//     (local blob store or server URL) as the Blob handed to the reader.
(function (global) {
  'use strict';
  var _pdfjs = null, _loading = null;

  function base() { return (global.STATIC_BASE || '/static/') + 'vendor/'; }
  function fetchText(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url); return r.text(); }); }
  function blobModuleUrl(code) { return URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); }

  function ensurePdfjs() {
    if (_pdfjs) return Promise.resolve(_pdfjs);
    if (_loading) return _loading;
    _loading = (async function () {
      var mainUrl = new URL(base() + 'pdf.min.mjs', document.baseURI).href;
      var workerUrl = new URL(base() + 'pdf.worker.min.mjs', document.baseURI).href;
      var mod, burl;
      try {
        burl = blobModuleUrl(await fetchText(mainUrl));
        mod = await import(burl);
      } catch (e) {
        mod = await import(mainUrl); // fallback: hosts that serve .mjs correctly
      } finally { if (burl) URL.revokeObjectURL(burl); }
      try { mod.GlobalWorkerOptions.workerSrc = blobModuleUrl(await fetchText(workerUrl)); }
      catch (e2) { try { mod.GlobalWorkerOptions.workerSrc = workerUrl; } catch (_e) {} }
      _pdfjs = mod; return mod;
    })().catch(function (error) { _loading = null; throw error; });
    return _loading;
  }

  function isPdf(a) {
    if (!a) return false;
    if (a.type === 'application/pdf') return true;
    return /\.pdf$/i.test(a.storedPath || a.url || a.name || '');
  }
  async function pdfBlob(att) {
    var sdb = global.MemoStateDb;
    if (att.storedPath && sdb && sdb.readBlob) {
      try { var b = await sdb.readBlob(att.storedPath); if (b) return b; } catch (_e) {}
    }
    if (att.url) { try { var r = await fetch(att.url); if (r.ok) return await r.blob(); } catch (_e) {} }
    return null;
  }

  global.MemoPdf = { ensure: ensurePdfjs, isPdf: isPdf, blob: pdfBlob };
})(window);
