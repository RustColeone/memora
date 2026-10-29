// memo-finance-entry.js — the purchase form in the finance entry dialog.
//
// One amount first: a purchase can be just a total and what it was. Receipt
// lines are optional; when there are any, the total is worked out from them
// (items, discounts that lower the taxed amount, then tax, then fees and tips)
// and checked against a total the person typed or a scan read. Each line is a
// row that opens in place to edit; one ready line at the bottom adds the next.
// "Scan a receipt" photographs a receipt, keeps the photo with the purchase and
// fills the form from it on the device (memo-receipt.js); the person checks it.
//
// The dialog is shared with the notes page in the one-page app, so this module
// adds its own blocks next to the shared fields (#desc, tags, photos) and lays
// them out with CSS order under body.finance-variant, rather than moving them.
// The variant module (memo-variant-finance.js) calls open/collect/applyItems.
(function (global) {
  'use strict';

  var PAID = ['card', 'cash', 'transfer'];
  var built = false;
  var dlg = null, content = null;
  var st = { items: [], editing: -1, kind: 'item', open: {}, paid: '', scan: null, entry: null };

  function t(s, vars) {
    var I = global.MemoI18n;
    var out = I && I.t ? I.t(s, vars) : s;
    if (!(I && I.t) && vars) Object.keys(vars).forEach(function (k) { out = out.split('{' + k + '}').join(String(vars[k])); });
    return out;
  }
  function byId(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function round2(n) { return Math.round((+n || 0) * 100) / 100; }
  function num(v) { if (v == null) return NaN; var s = String(v).trim().replace(/[$€£¥\s]/g, ''); if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.'); return s === '' ? NaN : parseFloat(s); }
  function money(n) { n = round2(n); return (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2); }
  function plain(n) { n = round2(n); return (n < 0 ? '−' : '') + Math.abs(n).toFixed(2); }
  function wide() { return global.matchMedia && global.matchMedia('(orientation: landscape) and (max-height: 500px), (min-width: 900px)').matches; }
  function isNative() { return !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform()); }
  function toast(msg, opts) { if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast(msg, opts || {}); }

  // ── Lines ───────────────────────────────────────────────────────────────
  function normalizeItem(src) {
    src = src || {};
    var qty = parseFloat(src.amount), unit = parseFloat(src.unitPrice), tot = parseFloat(src.totalPrice);
    qty = isNaN(qty) ? 0 : qty; unit = isNaN(unit) ? 0 : unit;
    var out = { name: String(src.name || ''), description: String(src.description || ''), amount: qty, unitPrice: unit,
      // Trust a stored total (imported/OCR lines need not be qty × unit).
      totalPrice: isNaN(tot) ? round2(qty * unit) : tot };
    if (src.kind === 'discount' || src.kind === 'fee') out.kind = src.kind;
    if (out.kind === 'discount') { out.totalPrice = -Math.abs(out.totalPrice); out.unitPrice = -Math.abs(out.unitPrice); }
    if (src.unsure) out.unsure = true;
    return out;
  }
  function taxAmount(base, tax) {
    var s = String(tax == null ? '' : tax).trim();
    if (!s) return 0;
    if (/%$/.test(s)) { var p = parseFloat(s); return isNaN(p) ? 0 : base * p / 100; }
    var a = num(s); return isNaN(a) ? 0 : a;
  }
  function sums() {
    var goods = 0, disc = 0, fees = 0;
    st.items.forEach(function (it) {
      var v = +it.totalPrice || 0;
      if (it.kind === 'discount') disc += v; else if (it.kind === 'fee') fees += v; else goods += v;
    });
    var taxable = goods + disc;
    var tax = taxAmount(taxable, taxInput().value);
    return { goods: round2(goods), disc: round2(disc), fees: round2(fees), taxable: round2(taxable), tax: round2(tax), total: round2(taxable + tax + fees) };
  }
  function totalInput() { return byId('total'); }
  function taxInput() { return byId('tax'); }
  // What the person typed as the total (or a scan read off the receipt);
  // null while the field just shows the lines' total.
  function typedTotal() {
    var el = totalInput();
    if (!el || el.dataset.auto === '1') return null;
    var v = num(el.value);
    return isNaN(v) ? null : round2(v);
  }
  function mismatch() {
    if (!st.items.length) return null;
    var typed = typedTotal();
    if (typed == null) return null;
    var s = sums(), diff = round2(typed - s.total);
    return Math.abs(diff) > 0.005 ? { typed: typed, lines: s.total, diff: diff } : null;
  }

  // ── Building the blocks (once per dialog) ───────────────────────────────
  var ICON = {
    scan: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 9h8M8 12h8M8 15h5"/></svg>',
    list: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    tax: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M19 5L5 19"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/></svg>',
    tag: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/></svg>',
    more: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    cal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
  };
  function rowOf(id, sel) { var el = byId(id); return el ? el.closest(sel || '.row') : null; }
  function directChild(node) { while (node && node.parentElement !== content) node = node.parentElement; return node; }
  function fold(id, cls, icon, key, valueId) {
    return '<button type="button" class="fx-fold ' + cls + ' finance-only" id="' + id + '" aria-expanded="false">' + icon +
      '<span class="fx-fold-k" data-i18n="' + key + '">' + esc(t(key)) + '</span><span class="fx-fold-v" id="' + valueId + '"></span></button>';
  }
  function lbl(key, attrs) { return '<span class="fx-lbl" ' + (attrs || '') + ' data-i18n="' + key + '">' + esc(t(key)) + '</span>'; }

  function build() {
    dlg = byId('entryDlg');
    content = dlg && dlg.querySelector('.content');
    if (!content) return false;
    if (built && content.querySelector('.fx-total')) return true;
    built = true;
    dlg.classList.add('fx-dialog');

    // The shared rows, marked so finance can place and fold them.
    var mark = function (node, cls) { node = directChild(node); if (node) node.classList.add(cls); };
    mark(rowOf('desc'), 'fx-desc-row');
    mark(byId('categoryInput'), 'fx-oldcat-row');
    mark(rowOf('tagInput'), 'fx-tags-row');
    mark(rowOf('dropzone'), 'fx-photos-row');
    mark(content.querySelector('.images-order-row'), 'fx-order-row');

    // Finance-only inputs leave their old rows, which then go.
    var date = byId('entryDate'), sheet = byId('entrySheet'), tax = byId('tax');
    // A select already given the app's own dropdown keeps it: move both.
    var sheetUi = sheet && sheet.previousElementSibling && sheet.previousElementSibling.classList.contains('cs') ? sheet.previousElementSibling : null;
    var oldRows = [date && directChild(date), byId('itemsTable') && directChild(byId('itemsTable')), tax && directChild(tax)];
    [date, sheetUi, sheet, tax].forEach(function (el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
    var oldTotal = byId('total'); if (oldTotal && oldTotal.parentNode) oldTotal.parentNode.removeChild(oldTotal);
    oldRows.forEach(function (row) { if (row && row.parentNode) row.parentNode.removeChild(row); });

    var html = '' +
      '<button type="button" class="fx-scan finance-only" id="fxScanBtn" hidden>' + ICON.scan +
        '<span class="fx-scan-text"><span class="fx-scan-title" data-i18n="Scan a receipt">' + esc(t('Scan a receipt')) + '</span>' +
        '<span class="fx-scan-sub" data-i18n="Fills the total, date, store and items">' + esc(t('Fills the total, date, store and items')) + '</span></span></button>' +
      '<div class="fx-banner finance-only" id="fxBanner" role="status" hidden><img class="fx-banner-thumb" id="fxBannerThumb" alt="">' +
        '<div class="fx-banner-text"><p id="fxBannerMsg"></p><span class="fx-banner-sub" id="fxBannerSub"></span>' +
        '<button type="button" class="fx-btn fx-small" id="fxScanUndo" data-i18n="Undo, keep the photo only">' + esc(t('Undo, keep the photo only')) + '</button></div></div>' +
      '<div class="fx-total finance-only"><label class="fx-lbl" for="total" data-i18n="Total">' + esc(t('Total')) + '</label>' +
        '<div class="fx-amount"><span class="fx-cur" aria-hidden="true">$</span><input id="total" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"><span class="fx-src" id="fxTotalSrc"></span></div>' +
        '<div class="fx-hint" id="fxTotalHint"></div></div>' +
      '<label class="fx-lbl fx-what-lbl finance-only" for="desc" data-i18n="What">' + esc(t('What')) + '</label>' +
      '<div class="fx-cat finance-only">' + lbl('Category', 'id="fxCatLbl"') + '<div class="fx-chips" id="fxCatChips" role="group" aria-labelledby="fxCatLbl"></div></div>' +
      '<div class="fx-when finance-only">' + lbl('When', 'id="fxWhenLbl"') + '<div class="fx-chips" id="fxDateChips" role="group" aria-labelledby="fxWhenLbl">' +
        '<button type="button" class="fx-chip" data-day="0" data-i18n="Today">' + esc(t('Today')) + '</button>' +
        '<button type="button" class="fx-chip" data-day="-1" data-i18n="Yesterday">' + esc(t('Yesterday')) + '</button>' +
        '<span class="fx-chip fx-date-chip" id="fxDateChip">' + ICON.cal + '<span id="fxDateLabel"></span></span></div></div>' +
      '<div class="fx-itemsblock finance-only" id="fxItemsBlock">' +
        fold('fxItemsFold', 'fx-itemsfold', ICON.list, 'Items', 'fxItemsV') +
        '<section class="fx-items" id="fxItems" aria-labelledby="fxItemsTitle">' +
          '<div class="fx-items-head"><span class="fx-items-title" id="fxItemsTitle" data-i18n="Items">' + esc(t('Items')) + '</span><span class="fx-items-hint" id="fxItemsHint"></span></div>' +
          '<div id="fxRows"></div>' +
          '<div class="fx-add" id="fxAdd">' +
            '<div class="fx-seg" role="group" aria-label="' + esc(t('Line type')) + '" data-i18n-aria="Line type">' +
              '<button type="button" data-kind="item" data-i18n="Item">' + esc(t('Item')) + '</button>' +
              '<button type="button" data-kind="discount" data-i18n="Discount">' + esc(t('Discount')) + '</button>' +
              '<button type="button" data-kind="fee" data-i18n="Fee / tip">' + esc(t('Fee / tip')) + '</button></div>' +
            '<div class="fx-addline"><input id="fxAddName" class="fx-in" autocomplete="off" enterkeyhint="next">' +
              '<input id="fxAddQty" class="fx-in fx-num" inputmode="decimal" autocomplete="off" value="1" enterkeyhint="next" aria-label="' + esc(t('Quantity')) + '" data-i18n-aria="Quantity">' +
              '<input id="fxAddPrice" class="fx-in fx-num" inputmode="decimal" autocomplete="off" placeholder="0.00" enterkeyhint="done">' +
              '<button type="button" class="fx-plus" id="fxAddBtn" aria-label="' + esc(t('Add line')) + '" data-i18n-aria="Add line">' + ICON.plus + '</button></div>' +
            '<div class="fx-add-hint" data-i18n="Enter adds it and starts another.">' + esc(t('Enter adds it and starts another.')) + '</div></div>' +
          '<div class="fx-sums" id="fxSums">' +
            '<div class="fx-sum"><span data-i18n="Items">' + esc(t('Items')) + '</span><span id="fxSumGoods"></span></div>' +
            '<div class="fx-sum" id="fxSumDiscRow"><span data-i18n="Discounts">' + esc(t('Discounts')) + '</span><span class="fx-minus" id="fxSumDisc"></span></div>' +
            '<div class="fx-taxslot" id="fxTaxSlotItems"></div>' +
            '<div class="fx-sum" id="fxSumFeesRow"><span data-i18n="Fees and tips">' + esc(t('Fees and tips')) + '</span><span id="fxSumFees"></span></div>' +
            '<div class="fx-sum fx-big"><span data-i18n="Total">' + esc(t('Total')) + '</span><span id="fxSumTotal"></span></div>' +
            '<div class="fx-ok" id="fxOk" hidden>' + ICON.check + '<span id="fxOkMsg"></span></div></div>' +
        '</section>' +
        '<div class="fx-warn" id="fxWarn" role="status" hidden><p id="fxWarnMsg"></p><div class="fx-warn-acts">' +
          '<button type="button" class="fx-btn fx-small" id="fxWarnAdd"></button><button type="button" class="fx-btn fx-small" id="fxWarnUse"></button></div></div>' +
      '</div>' +
      '<div class="fx-taxblock finance-only" id="fxTaxBlock">' + fold('fxTaxFold', 'fx-taxfold', ICON.tax, 'Tax', 'fxTaxV') +
        '<div class="fx-taxslot" id="fxTaxSlotSolo"></div></div>' +
      fold('fxTagsFold', 'fx-tagsfold', ICON.tag, 'Tags', 'fxTagsV') +
      fold('fxMoreFold', 'fx-morefold', ICON.more, 'More details', 'fxMoreV') +
      '<div class="fx-photos-lbl finance-only">' + lbl('Photos & files') + '</div>' +
      '<div class="fx-details finance-only" id="fxDetails">' +
        '<div class="fx-photo-hint fx-hint" data-i18n="Only a scanned receipt fills in the items; other photos and PDFs are just kept with the purchase.">' + esc(t('Only a scanned receipt fills in the items; other photos and PDFs are just kept with the purchase.')) + '</div>' +
        '<div class="fx-field"><label class="fx-lbl" for="fxStore" data-i18n="Store">' + esc(t('Store')) + '</label><input id="fxStore" class="fx-in" autocomplete="off"></div>' +
        '<div class="fx-field">' + lbl('Paid with', 'id="fxPaidLbl"') + '<div class="fx-chips" id="fxPaidChips" role="group" aria-labelledby="fxPaidLbl"></div>' +
          '<input id="fxPaidOther" class="fx-in" autocomplete="off" hidden></div>' +
        '<div class="fx-field fx-sheet-field"><label class="fx-lbl" for="entrySheet" data-i18n="Sheet">' + esc(t('Sheet')) + '</label></div>' +
        '<div class="fx-field"><label class="fx-lbl" for="fxNotes" data-i18n="Notes">' + esc(t('Notes')) + '</label><textarea id="fxNotes" class="fx-in" rows="2"></textarea></div>' +
      '</div>';
    var holder = document.createElement('div');
    holder.innerHTML = html;
    while (holder.firstChild) content.appendChild(holder.firstChild);

    // Put the moved inputs in their new places.
    var dateChip = byId('fxDateChip');
    if (date) { date.classList.add('fx-date-input'); dateChip.appendChild(date); }
    if (sheet) { var field = content.querySelector('.fx-sheet-field'); if (sheetUi) field.appendChild(sheetUi); field.appendChild(sheet); }
    var taxRow = document.createElement('div');
    taxRow.className = 'fx-taxrow'; taxRow.id = 'fxTaxRow';
    taxRow.innerHTML = '<label for="tax" class="fx-taxlbl" id="fxTaxLbl"></label><span class="fx-taxamt" id="fxTaxAmt"></span>';
    var taxEl = tax || document.createElement('input');
    taxEl.id = 'tax'; taxEl.type = 'text'; taxEl.className = 'fx-in fx-num fx-tax'; taxEl.setAttribute('inputmode', 'decimal'); taxEl.autocomplete = 'off';
    taxRow.insertBefore(taxEl, taxRow.querySelector('.fx-taxamt'));
    byId('fxTaxSlotSolo').appendChild(taxRow);

    wire();
    return true;
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  function wire() {
    var onFold = function (key, focusId) {
      return function () {
        st.open[key] = !st.open[key];
        render();
        if (st.open[key] && focusId) { var f = byId(focusId); if (f) try { f.focus({ preventScroll: false }); } catch (_e) {} }
      };
    };
    byId('fxItemsFold').addEventListener('click', onFold('items', 'fxAddName'));
    byId('fxTaxFold').addEventListener('click', onFold('tax', 'tax'));
    byId('fxTagsFold').addEventListener('click', onFold('tags', 'tagInput'));
    byId('fxMoreFold').addEventListener('click', onFold('more'));

    byId('fxCatChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cat]');
      if (b) { setCategory(b.dataset.cat); return; }
      if (e.target.closest('.fx-chip-all') && global.MemoCategoryPicker) {
        global.MemoCategoryPicker.open({ title: t('Category'), allowCreate: true, onChoose: setCategory });
      }
    });
    byId('fxDateChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-day]');
      if (!b) return;
      var d = new Date(); d.setDate(d.getDate() + Number(b.dataset.day));
      byId('entryDate').value = ymd(d);
      renderDate();
      byId('entryDate').dispatchEvent(new Event('change', { bubbles: true }));
    });
    var date = byId('entryDate');
    if (date) {
      date.addEventListener('change', renderDate);
      date.addEventListener('input', renderDate);
      // A desktop browser opens its calendar only from the small icon.
      date.addEventListener('click', function () { try { if (date.showPicker) date.showPicker(); } catch (_e) {} });
    }

    var total = totalInput();
    total.addEventListener('input', function () {
      total.dataset.auto = (total.value.trim() === '' && st.items.length) ? '1' : '0';
      renderSums();
    });
    total.addEventListener('blur', function () {
      var v = num(total.value);
      if (total.dataset.auto !== '1' && !isNaN(v)) total.value = round2(v).toFixed(2);
      renderSums();
    });
    taxInput().addEventListener('input', renderSums);

    // Rows: tap to open in place.
    byId('fxRows').addEventListener('click', function (e) {
      var row = e.target.closest('.fx-row');
      if (row) { openRow(Number(row.dataset.i)); return; }
      if (e.target.closest('#fxEdDone')) { closeRow(); return; }
      if (e.target.closest('#fxEdRemove')) removeRow(st.editing);
    });
    byId('fxRows').addEventListener('input', function (e) { if (e.target.closest('.fx-edit')) readEditor(); });
    byId('fxRows').addEventListener('keydown', function (e) {
      if (!e.target.closest('.fx-edit')) return;
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); closeRow(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRow(); }
    });

    // The ready line at the bottom.
    content.querySelector('.fx-seg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-kind]'); if (!b) return;
      st.kind = b.dataset.kind; renderAddLine();
      try { byId('fxAddName').focus(); } catch (_e) {}
    });
    byId('fxAddBtn').addEventListener('click', function () { addLine(true); });
    byId('fxAddName').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (isNaN(num(byId('fxAddPrice').value))) byId(st.kind === 'item' ? 'fxAddQty' : 'fxAddPrice').focus();
      else addLine(true);
    });
    byId('fxAddQty').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); byId('fxAddPrice').focus(); } });
    byId('fxAddPrice').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addLine(true); } });

    byId('fxWarnAdd').addEventListener('click', function () {
      var m = mismatch(); if (!m) return;
      st.items.push(m.diff > 0
        ? normalizeItem({ name: t('Other'), amount: 1, unitPrice: m.diff, totalPrice: m.diff })
        : normalizeItem({ name: t('Difference'), amount: 1, unitPrice: m.diff, totalPrice: m.diff, kind: 'discount' }));
      render();
    });
    byId('fxWarnUse').addEventListener('click', function () { var el = totalInput(); el.dataset.auto = '1'; render(); });

    byId('fxPaidChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-paid]'); if (!b) return;
      var v = b.dataset.paid;
      if (v === 'other') { st.paid = st.paid && PAID.indexOf(st.paid) < 0 ? st.paid : ''; st.paidOther = true; renderPaid(); byId('fxPaidOther').focus(); return; }
      st.paidOther = false;
      st.paid = st.paid === v ? '' : v;
      renderPaid(); renderFolds();
    });
    byId('fxPaidOther').addEventListener('input', function () { st.paid = byId('fxPaidOther').value.trim(); renderFolds(); });
    byId('fxStore').addEventListener('input', renderFolds);

    byId('fxScanBtn').addEventListener('click', scan);
    byId('fxScanUndo').addEventListener('click', undoScan);

    // Fold summaries follow the shared tag chips and photo grid.
    if (global.MutationObserver) {
      var mo = new MutationObserver(function () { if (isFinance()) renderFolds(); });
      ['tagChips', 'dragGrid'].forEach(function (id) { var el = byId(id); if (el) mo.observe(el, { childList: true, subtree: true }); });
    }

    // Save: finish an open row or a typed line first; refuse a total the lines
    // contradict until the person picks which one is right.
    dlg.addEventListener('click', function (e) {
      if (!isFinance() || !e.target.closest('#saveBtn')) return;
      closeRow(true);
      addLine(false);
      var m = mismatch();
      if (m) {
        e.preventDefault(); e.stopImmediatePropagation();
        render();
        var w = byId('fxWarn'); if (w && w.scrollIntoView) w.scrollIntoView({ block: 'center', behavior: 'smooth' });
        toast(t('The lines and the receipt total differ. Pick one of the two fixes first.'), { kind: 'error' });
        return;
      }
      var desc = byId('desc');
      if (desc && !desc.value.trim()) {
        var fill = byId('fxStore').value.trim() || (st.items[0] && st.items[0].name) || '';
        if (fill) desc.value = fill;
      }
    }, true);
    dlg.addEventListener('close', function () {
      var desc = byId('desc');
      if (desc && desc.dataset.fxPlaceholder != null) {
        desc.placeholder = desc.dataset.fxPlaceholder;
        if (desc.dataset.fxRows) desc.setAttribute('rows', desc.dataset.fxRows); else desc.removeAttribute('rows');
        delete desc.dataset.fxPlaceholder; delete desc.dataset.fxRows;
      }
      if (st.scan && st.scan.thumb) { try { URL.revokeObjectURL(st.scan.thumb); } catch (_e) {} }
      st.scan = null;
    });
  }

  function isFinance() { return document.body.classList.contains('finance-variant') || (global.MemoCore && global.MemoCore.getVariant && global.MemoCore.getVariant() === 'finance'); }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // ── Category, date, payment ─────────────────────────────────────────────
  function liveEntries() {
    try { return (global.MemoCore.getState().db.entries || []).filter(function (e) { return e && !e.deletedAt; }); } catch (_e) { return []; }
  }
  function setCategory(cat) {
    if (!cat) return;
    if (typeof global.ensureCategory === 'function') global.ensureCategory(cat);
    var sel = byId('categoryInput');
    if (sel) {
      if (!Array.prototype.some.call(sel.options, function (o) { return o.value === cat; })) {
        var o = document.createElement('option'); o.value = cat; o.textContent = cat; sel.appendChild(o);
      }
      sel.value = cat;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    renderCats();
  }
  function renderCats() {
    var sel = byId('categoryInput'), cur = sel ? sel.value : '';
    var seen = {}, cats = [];
    if (cur && cur !== 'Uncategorized') { cats.push(cur); seen[cur] = 1; }
    liveEntries().slice().sort(function (a, b) { return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')); })
      .forEach(function (e) { var c = e.category; if (c && c !== 'Uncategorized' && !seen[c] && cats.length < 5) { seen[c] = 1; cats.push(c); } });
    byId('fxCatChips').innerHTML = cats.map(function (c) {
      return '<button type="button" class="fx-chip' + (c === cur ? ' on' : '') + '" data-cat="' + esc(c) + '" aria-pressed="' + (c === cur) + '">' + esc(c) + '</button>';
    }).join('') + '<button type="button" class="fx-chip fx-ghost fx-chip-all">' + esc(cats.length ? t('All…') : t('Choose…')) + '</button>';
  }
  function renderDate() {
    var date = byId('entryDate'); if (!date) return;
    var v = date.value, today = ymd(new Date()), y = new Date(); y.setDate(y.getDate() - 1);
    var which = v === today ? '0' : v === ymd(y) ? '-1' : (v ? 'pick' : '');
    byId('fxDateChips').querySelectorAll('[data-day]').forEach(function (b) { var on = b.dataset.day === which; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    var chip = byId('fxDateChip');
    chip.classList.toggle('on', which === 'pick');
    var label = t('Pick a date');
    if (which === 'pick') {
      var d = new Date(v + 'T12:00:00');
      var loc = (global.MemoI18n && global.MemoI18n.getLocale && global.MemoI18n.getLocale()) || undefined;
      try { label = d.toLocaleDateString(loc, d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_e) { label = v; }
    }
    byId('fxDateLabel').textContent = label;
    date.setAttribute('aria-label', t('Pick a date'));
  }
  function paidLabel(v) { return v === 'card' ? t('Card') : v === 'cash' ? t('Cash') : v === 'transfer' ? t('Transfer') : v; }
  function renderPaid() {
    var other = st.paidOther || (st.paid && PAID.indexOf(st.paid) < 0);
    byId('fxPaidChips').innerHTML = PAID.map(function (k) {
      return '<button type="button" class="fx-chip' + (st.paid === k ? ' on' : '') + '" data-paid="' + k + '" aria-pressed="' + (st.paid === k) + '">' + esc(paidLabel(k)) + '</button>';
    }).join('') + '<button type="button" class="fx-chip' + (other ? ' on' : ' fx-ghost') + '" data-paid="other" aria-pressed="' + !!other + '">' + esc(t('Other…')) + '</button>';
    var input = byId('fxPaidOther');
    input.hidden = !other;
    input.placeholder = t('How you paid');
    if (other && document.activeElement !== input) input.value = PAID.indexOf(st.paid) < 0 ? st.paid : '';
  }

  // ── Rows ────────────────────────────────────────────────────────────────
  function rowMeta(it) {
    if (it.unsure) return t('Hard to read: check the price');
    var note = it.description ? it.description : '';
    if (it.kind === 'discount') return note || t('Lowers the taxed amount');
    if (it.kind === 'fee') return t('Not taxed') + (note ? ' · ' + note : '');
    var q = +it.amount || 0;
    var base = q === 1 && round2(it.unitPrice) === round2(it.totalPrice) ? '' : (q + ' × ' + plain(it.unitPrice));
    return [base, note].filter(Boolean).join(' · ');
  }
  function kindName(k) { return k === 'discount' ? t('Discount') : k === 'fee' ? t('Fee / tip') : t('Item'); }
  function rowHtml(it, i) {
    var badge = it.kind ? '<span class="fx-kind fx-kind-' + it.kind + '">' + esc(kindName(it.kind)) + '</span>' : '';
    var meta = rowMeta(it);
    return '<button type="button" class="fx-row' + (it.unsure ? ' fx-unsure' : '') + '" data-i="' + i + '">' +
      '<span class="fx-row-n">' + badge + '<span class="fx-row-name">' + esc(it.name || '—') + '</span></span>' +
      '<span class="fx-row-t' + (it.totalPrice < 0 ? ' fx-minus' : '') + '">' + esc(plain(it.totalPrice)) + '</span>' +
      (meta ? '<span class="fx-row-m">' + esc(meta) + '</span>' : '') + '</button>';
  }
  function editorHtml(it) {
    var f = function (id, key, value, extra) {
      return '<div class="fx-field"><label for="' + id + '">' + esc(t(key)) + '</label><input id="' + id + '" class="fx-in' + (extra || '') + '" value="' + esc(value) + '" autocomplete="off"' + (extra ? ' inputmode="decimal"' : '') + '></div>';
    };
    var money = it.kind
      ? '<div class="fx-grid2">' + f('fxEdAmt', 'Amount', plain(Math.abs(it.totalPrice)).replace('−', ''), ' fx-num') + '</div>'
      : '<div class="fx-grid3">' + f('fxEdQty', 'Qty', String(it.amount), ' fx-num') + f('fxEdUnit', 'Each', (+it.unitPrice || 0).toFixed(2), ' fx-num') +
        '<div class="fx-field"><span class="fx-l">' + esc(t('Line')) + '</span><output class="fx-out" id="fxEdLine">' + esc(plain(it.totalPrice)) + '</output></div></div>';
    return '<div class="fx-edit" data-i="' + st.editing + '">' +
      f('fxEdName', it.kind ? kindName(it.kind) : 'Item', it.name) +
      f('fxEdNote', 'Note (optional)', it.description) + money +
      '<div class="fx-edit-acts"><button type="button" class="fx-btn fx-danger" id="fxEdRemove">' + esc(t('Remove')) + '</button><span class="fx-sp"></span>' +
      '<button type="button" class="fx-btn fx-primary fx-small" id="fxEdDone">' + esc(t('Done')) + '</button></div></div>';
  }
  function openRow(i) {
    if (st.editing >= 0) readEditor();
    st.editing = i;
    renderRows();
    var n = byId('fxEdName'); if (n) try { n.focus({ preventScroll: true }); } catch (_e) { n.focus(); }
  }
  function readEditor() {
    var it = st.items[st.editing]; if (!it) return;
    it.name = (byId('fxEdName') || {}).value || '';
    it.description = ((byId('fxEdNote') || {}).value || '').trim();
    if (it.kind) {
      var a = Math.abs(num(byId('fxEdAmt').value)); a = isNaN(a) ? 0 : round2(a);
      it.amount = 1; it.unitPrice = it.kind === 'discount' ? -a : a; it.totalPrice = it.unitPrice;
    } else {
      var q = num(byId('fxEdQty').value), u = num(byId('fxEdUnit').value);
      it.amount = isNaN(q) ? 0 : q; it.unitPrice = isNaN(u) ? 0 : u; it.totalPrice = round2(it.amount * it.unitPrice);
      var out = byId('fxEdLine'); if (out) out.textContent = plain(it.totalPrice);
    }
    delete it.unsure;   // the person has looked at it
    renderSums();
  }
  function closeRow(silent) {
    if (st.editing < 0) return;
    readEditor();
    var it = st.items[st.editing];
    if (it) it.name = it.name.trim();
    st.editing = -1;
    if (!silent) render(); else renderRows();
  }
  function removeRow(i) {
    var gone = st.items[i]; if (!gone) return;
    st.items.splice(i, 1); st.editing = -1;
    render();
    toast(t('Line removed'), { action: { label: t('Undo'), onClick: function () { st.items.splice(Math.min(i, st.items.length), 0, gone); render(); } } });
  }
  function addLine(focusNext) {
    var nameEl = byId('fxAddName'), priceEl = byId('fxAddPrice'), qtyEl = byId('fxAddQty');
    if (!nameEl) return false;
    var name = nameEl.value.trim(), price = num(priceEl.value), qty = num(qtyEl.value);
    if (isNaN(price)) { if (name && focusNext) priceEl.focus(); return false; }
    if (st.kind === 'item') {
      qty = isNaN(qty) || qty <= 0 ? 1 : qty;
      st.items.push(normalizeItem({ name: name, amount: qty, unitPrice: price, totalPrice: round2(qty * price) }));
    } else {
      var a = round2(Math.abs(price));
      st.items.push(normalizeItem({ name: name || kindName(st.kind), amount: 1, unitPrice: a, totalPrice: a, kind: st.kind }));
    }
    nameEl.value = ''; priceEl.value = ''; qtyEl.value = '1';
    st.kind = 'item';
    st.open.items = true;
    render();
    if (focusNext) try { nameEl.focus({ preventScroll: true }); } catch (_e) { nameEl.focus(); }
    return true;
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  function renderRows() {
    byId('fxRows').innerHTML = st.items.map(function (it, i) { return i === st.editing ? editorHtml(it) : rowHtml(it, i); }).join('');
    var n = st.items.length;
    byId('fxItemsHint').textContent = n ? t('Tap a row to edit') : '';
  }
  function renderAddLine() {
    content.querySelectorAll('.fx-seg [data-kind]').forEach(function (b) { var on = b.dataset.kind === st.kind; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    var item = st.kind === 'item';
    byId('fxAddQty').hidden = !item;
    byId('fxAdd').classList.toggle('fx-add-noqty', !item);
    var nameEl = byId('fxAddName'), priceEl = byId('fxAddPrice');
    nameEl.placeholder = item ? t('Next item') : st.kind === 'discount' ? t('Coupon or savings') : t('Fee or tip');
    nameEl.setAttribute('aria-label', item ? t('Next item') : kindName(st.kind));
    priceEl.setAttribute('aria-label', item ? t('Price each') : t('Amount'));
  }
  function renderSums() {
    var s = sums(), has = st.items.length > 0, total = totalInput();
    // Tax sits under the lines when there are any, else under its own fold.
    var row = byId('fxTaxRow'), slot = byId(has ? 'fxTaxSlotItems' : 'fxTaxSlotSolo');
    if (row && row.parentNode !== slot) slot.appendChild(row);
    var taxStr = taxInput().value.trim();
    byId('fxTaxLbl').textContent = has ? t('Tax') : t('Tax included');
    taxInput().placeholder = t('8.25% or 1.74');
    var solo = num(total.value);
    var taxIncl = 0;
    if (!has && taxStr) {
      if (/%$/.test(taxStr)) { var p = parseFloat(taxStr); taxIncl = isNaN(p) || isNaN(solo) ? 0 : solo - solo / (1 + p / 100); }
      else { taxIncl = taxAmount(0, taxStr); }
    }
    byId('fxTaxAmt').textContent = has ? plain(s.tax) : (taxStr ? plain(taxIncl) : '');
    byId('fxSumGoods').textContent = plain(s.goods);
    byId('fxSumDiscRow').hidden = !s.disc; byId('fxSumDisc').textContent = plain(s.disc);
    byId('fxSumFeesRow').hidden = !s.fees; byId('fxSumFees').textContent = plain(s.fees);
    byId('fxSumTotal').textContent = plain(s.total);

    // No total typed: once there are lines, the field shows what they add up to.
    if (has && total.dataset.auto !== '1' && total.value.trim() === '' && document.activeElement !== total) total.dataset.auto = '1';
    if (has && total.dataset.auto === '1' && document.activeElement !== total) total.value = s.total.toFixed(2);
    if (!has && total.dataset.auto === '1') { total.dataset.auto = '0'; }
    var typed = typedTotal(), m = mismatch();
    var nGoods = st.items.filter(function (i) { return !i.kind; }).length;
    var src = '';
    if (has && typed == null) src = (taxStr ? t('{n} items + tax', { n: nGoods }) : t('{n} items', { n: nGoods }));
    else if (has && !m) src = st.scan ? t('from the receipt') : t('matches the lines');
    byId('fxTotalSrc').textContent = src;
    byId('fxTotalHint').textContent = has ? '' : t('Or just type it: no items needed for a one-amount purchase.');
    byId('fxTotalHint').hidden = has;
    var ok = has && typed != null && !m;
    byId('fxOk').hidden = !ok;
    byId('fxOkMsg').textContent = st.scan ? t('Lines match the receipt total') : t('Matches the total you typed');
    var w = byId('fxWarn');
    w.hidden = !m;
    if (m) {
      byId('fxWarnMsg').innerHTML = '<strong>' + esc(t('The receipt says {total}.', { total: money(m.typed) })) + '</strong> ' +
        esc(m.diff > 0 ? t('The lines add up to {lines}, so {diff} is missing.', { lines: money(m.lines), diff: money(m.diff) })
                       : t('The lines add up to {lines}, {diff} more than the receipt.', { lines: money(m.lines), diff: money(-m.diff) }));
      byId('fxWarnAdd').textContent = m.diff > 0 ? t('Add {diff} as a line', { diff: money(m.diff) }) : t('Add {diff} as a discount', { diff: money(-m.diff) });
      byId('fxWarnUse').textContent = t('Use {lines}', { lines: money(m.lines) });
    }
    byId('fxTaxV').textContent = taxStr ? taxStr + (has ? '' : ' · ' + plain(taxIncl)) : t('Optional');
  }
  function tagNames() {
    var chips = byId('tagChips');
    return chips ? Array.prototype.map.call(chips.querySelectorAll('.chip'), function (c) { return (c.firstChild && c.firstChild.textContent || '').trim(); }).filter(Boolean) : [];
  }
  function renderFolds() {
    var tags = tagNames();
    byId('fxTagsV').textContent = tags.length ? tags.map(function (x) { return '#' + x; }).join(' ') : t('None');
    var photos = ((global.modalImages || []).length) + ((global.modalFilesExtra || []).length);
    var parts = [];
    if (photos) parts.push(photos === 1 ? t('1 photo') : t('{n} photos', { n: photos }));
    var store = byId('fxStore').value.trim(); if (store) parts.push(store);
    if (st.paid) parts.push(paidLabel(st.paid));
    var sheet = byId('entrySheet'); if (sheet && sheet.value && sheet.value !== 'General') parts.push(sheet.value);
    byId('fxMoreV').textContent = parts.length ? parts.join(' · ') : t('Photos, store, sheet');
    byId('fxItemsV').textContent = t('Add receipt lines');
  }
  function render() {
    if (!build()) return;
    var has = st.items.length > 0;
    if (has || wide()) st.open.items = true;
    var open = st.open;
    content.classList.toggle('fx-open-items', !!open.items);
    content.classList.toggle('fx-open-tax', !!open.tax && !has);
    content.classList.toggle('fx-open-tags', !!open.tags);
    content.classList.toggle('fx-open-more', !!open.more);
    content.classList.toggle('fx-has-items', has);
    [['fxTaxFold', open.tax], ['fxTagsFold', open.tags], ['fxMoreFold', open.more], ['fxItemsFold', open.items]].forEach(function (p) {
      byId(p[0]).setAttribute('aria-expanded', String(!!p[1]));
    });
    renderRows(); renderAddLine(); renderSums(); renderFolds();
  }

  // ── Scan a receipt ──────────────────────────────────────────────────────
  function aiReader() {
    var mode = global.MemoContracts && global.MemoContracts.getMode ? global.MemoContracts.getMode() : global.MODE;
    if (mode === 'server') return 'server';
    var K = global.MemoAiKey, key = K && K.getActiveKey ? K.getActiveKey() : null;
    if (key && K.supportsVision && K.supportsVision(key.provider, key.model) && global.MemoAiClient) return 'key';
    return null;
  }
  function scanAvailable() { return (isNative() && global.MemoOcrNative && global.MemoOcrNative.available()) || !!aiReader(); }

  function pickPhoto() {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment');
      input.style.display = 'none';
      input.addEventListener('change', function () { resolve(Array.prototype.slice.call(input.files || [])); input.remove(); }, { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }
  async function takePages() {
    var scanner = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.DocumentScanner;
    if (isNative() && scanner && scanner.scan) {
      try {
        var out = await scanner.scan({ pageLimit: 4 });
        if (out && out.cancelled) return [];
        var stamp = ymd(new Date());
        return (out && out.pages || []).filter(function (p) { return p && p.data; }).map(function (p, i) {
          var bin = atob(String(p.data).replace(/^data:[^,]*,/, '')), bytes = new Uint8Array(bin.length);
          for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          return new File([bytes], 'receipt-' + stamp + (i ? '-' + (i + 1) : '') + '.jpg', { type: p.mime || 'image/jpeg' });
        });
      } catch (_e) { /* no scanner (no Play services): fall back to the camera */ }
    }
    return pickPhoto();
  }
  async function readPages(files) {
    var N = global.MemoOcrNative;
    if (isNative() && N && N.available()) {
      var lines = [], offset = 0, text = [];
      for (var i = 0; i < files.length; i++) {
        var url = URL.createObjectURL(files[i]);
        try {
          var r = await N.recognize(url, { lines: true, maxDim: 2600 });
          (r.lines || []).forEach(function (l) { lines.push({ text: l.text, left: l.left, right: l.right, top: l.top + offset, bottom: l.bottom + offset }); });
          offset += (r.height || 4000) + 200;
          if (r.text) text.push(r.text);
        } finally { try { URL.revokeObjectURL(url); } catch (_e) {} }
      }
      return global.MemoReceipt.parse(lines.length ? { lines: lines } : { text: text.join('\n') });
    }
    var ai = aiReader();
    if (ai === 'key') {
      var p = await global.MemoAiClient.analyzeImages(files, '', 'finance');
      return p ? { store: '', date: p.purchaseDate || '', items: p.items || [], tax: num(p.tax) || null, total: num(p.total) || null, category: p.category, description: p.description } : null;
    }
    if (ai === 'server') {
      // The server reads attached photos through the AI analysis bar.
      var btn = byId('ocrAnalyseBtn');
      if (btn && !btn.disabled) { btn.click(); toast(t('Reading the receipt with your server…')); }
      return 'server';
    }
    return null;
  }
  function snapshot() {
    var total = totalInput();
    return { items: st.items.map(function (i) { return Object.assign({}, i); }), total: total.value, auto: total.dataset.auto, tax: taxInput().value,
      desc: byId('desc').value, date: byId('entryDate').value, store: byId('fxStore').value, cat: (byId('categoryInput') || {}).value };
  }
  async function scan() {
    var files = await takePages();
    if (!files.length) return;
    if (global.MemoCore && global.MemoCore.addImages) await global.MemoCore.addImages(files);
    var before = snapshot();
    var thumb = URL.createObjectURL(files[0]);
    showBanner(thumb, t('Reading the receipt…'), '', false);
    var result = null;
    try { result = await readPages(files); }
    catch (e) { console.warn('[receipt] could not read', e); }
    if (result === 'server') { hideBanner(); return; }
    var filled = result && ((result.items && result.items.length) || result.total);
    if (!filled) {
      st.scan = { thumb: thumb, before: null };
      showBanner(thumb, t('Couldn’t read this receipt.'), t('The photo is kept with this purchase; type the total.'), false);
      try { totalInput().focus(); } catch (_e) {}
      return;
    }
    st.scan = { thumb: thumb, before: before };
    fill(result);
    var unsure = st.items.some(function (i) { return i.unsure; });
    showBanner(thumb, '<strong>' + esc(t('Filled in from your receipt.')) + '</strong> ' +
      esc(unsure ? t('Check the highlighted lines, then Save.') : (mismatch() ? t('Some lines don’t add up; check them, then Save.') : t('Check it, then Save.'))),
      t('The photo is kept with this purchase.'), true, true);
  }
  function fill(r) {
    st.items = (r.items || []).map(normalizeItem);
    st.editing = -1;
    var total = totalInput();
    if (r.total != null && !isNaN(+r.total)) { total.value = round2(r.total).toFixed(2); total.dataset.auto = '0'; }
    else total.dataset.auto = st.items.length ? '1' : '0';
    if (r.tax != null && !isNaN(+r.tax)) taxInput().value = round2(r.tax).toFixed(2);
    if (r.date) byId('entryDate').value = r.date;
    var storeEl = byId('fxStore');
    if (r.store && !storeEl.value.trim()) storeEl.value = r.store;
    var desc = byId('desc');
    if (desc && !desc.value.trim()) desc.value = r.store || r.description || '';
    // The same store as an earlier purchase: use that purchase's category.
    var store = (storeEl.value || '').trim().toLowerCase();
    var same = store && liveEntries().filter(function (e) { return String(e.store || '').trim().toLowerCase() === store && e.category && e.category !== 'Uncategorized'; })
      .sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); })[0];
    if (same) setCategory(same.category);
    else if (r.category) setCategory(r.category);
    st.open.items = true;
    renderDate(); renderCats();
    render();
  }
  function showBanner(thumb, html, sub, undo, isHtml) {
    var b = byId('fxBanner');
    byId('fxBannerThumb').src = thumb;
    byId('fxBannerThumb').alt = t('Receipt photo');
    byId('fxBannerMsg')[isHtml ? 'innerHTML' : 'textContent'] = html;
    byId('fxBannerSub').textContent = sub || '';
    byId('fxScanUndo').hidden = !undo;
    b.hidden = false;
    byId('fxScanBtn').hidden = true;
  }
  function hideBanner() { byId('fxBanner').hidden = true; }
  function undoScan() {
    var s = st.scan && st.scan.before; if (!s) return;
    st.items = s.items; st.editing = -1;
    var total = totalInput(); total.value = s.total; total.dataset.auto = s.auto || '0';
    taxInput().value = s.tax; byId('desc').value = s.desc; byId('entryDate').value = s.date; byId('fxStore').value = s.store;
    if (s.cat) setCategory(s.cat);
    st.scan.before = null;
    hideBanner();
    renderDate(); render();
  }

  // ── The variant's hooks ─────────────────────────────────────────────────
  function legacyItems(entry) {
    var items = [];
    if (entry && entry.price) items.push({ name: 'Item', description: entry.description || '', amount: 1, unitPrice: entry.price, totalPrice: entry.price });
    if (entry && entry.adjustment) items.push({ name: 'Adjustment', description: '', amount: 1, unitPrice: entry.adjustment, totalPrice: entry.adjustment });
    return items;
  }
  function open(entry) {
    if (!build()) return;
    st.entry = entry || null;
    var title = byId('dlgTitle'); if (title) title.textContent = entry ? t('Edit purchase') : t('New purchase');
    var desc = byId('desc');
    if (desc) {
      if (desc.dataset.fxPlaceholder == null) { desc.dataset.fxPlaceholder = desc.placeholder || ''; desc.dataset.fxRows = desc.getAttribute('rows') || ''; }
      desc.placeholder = t('What did you buy?');
      desc.rows = 1;
    }
    // Copy: Cancel must never have edited the stored entry.
    // An old entry stored as one price (no lines) opens as just that amount.
    var legacyAmount = entry && !(Array.isArray(entry.items) && entry.items.length) && entry.price && !entry.adjustment;
    var items = entry && Array.isArray(entry.items) && entry.items.length ? entry.items : (entry && !legacyAmount ? legacyItems(entry) : []);
    st.items = items.map(normalizeItem);
    st.editing = -1; st.kind = 'item'; st.scan = null; st.paidOther = false;
    st.open = { items: st.items.length > 0, tax: false, tags: false, more: false };
    var total = totalInput(), stored = entry ? parseFloat(entry.total) : NaN;
    if (legacyAmount && !(stored > 0)) stored = parseFloat(entry.price) + (taxAmount(parseFloat(entry.price), entry.tax) || 0);
    var tax = taxInput(); tax.value = entry && entry.tax != null && entry.tax !== 0 ? String(entry.tax) : '';
    if (st.items.length) {
      var lines = sums().total;
      // A stored total that differs from the lines was typed from a receipt.
      if (!isNaN(stored) && Math.abs(stored - lines) > 0.005) { total.value = stored.toFixed(2); total.dataset.auto = '0'; }
      else { total.value = lines.toFixed(2); total.dataset.auto = '1'; }
    } else {
      total.value = !isNaN(stored) && stored ? stored.toFixed(2) : '';
      total.dataset.auto = '0';
      st.open.tax = !!tax.value;
    }
    byId('fxStore').value = entry && entry.store || '';
    byId('fxNotes').value = entry && entry.notes || '';
    st.paid = entry && entry.paidWith || '';
    byId('fxPaidOther').value = PAID.indexOf(st.paid) < 0 ? st.paid : '';
    ['fxAddName', 'fxAddPrice'].forEach(function (id) { byId(id).value = ''; });
    byId('fxAddQty').value = '1';
    hideBanner();
    byId('fxScanBtn').hidden = !!entry || !scanAvailable();
    renderCats(); renderDate(); renderPaid();
    render();
    // New purchase: start at the amount, unless the person already moved on
    // (the dialog places its own first focus, so wait for that and compare).
    if (!entry) requestAnimationFrame(function () {
      var first = document.activeElement;
      setTimeout(function () {
        if (dlg.open && document.activeElement === first && first !== byId('desc')) try { total.focus({ preventScroll: true }); } catch (_e) {}
      }, 60);
    });
  }
  function collect(entry) {
    closeRow(true);
    addLine(false);
    var items = st.items.map(function (i) { var o = normalizeItem(i); delete o.unsure; return o; });
    var tax = taxInput().value.trim();
    entry.items = items;
    entry.tax = tax;
    entry.total = items.length ? sums().total : (typedTotal() || 0);
    var store = byId('fxStore').value.trim(), notes = byId('fxNotes').value.trim(), paid = String(st.paid || '').trim();
    if (store) entry.store = store; else delete entry.store;
    if (notes) entry.notes = notes; else delete entry.notes;
    if (paid) entry.paidWith = paid; else delete entry.paidWith;
    delete entry.price; delete entry.adjustment;
  }
  function applyItems(items) {
    if (!Array.isArray(items) || !items.length || !build()) return;
    st.items = items.map(normalizeItem);
    st.editing = -1; st.open.items = true;
    var total = totalInput();
    if (!total.value.trim()) total.dataset.auto = '1';
    render();
  }
  function captureDraft() {
    if (!built) return null;
    if (st.editing >= 0) readEditor();
    return { items: st.items.map(function (i) { return Object.assign({}, i); }), editing: st.editing, kind: st.kind, open: Object.assign({}, st.open),
      auto: (totalInput() || {}).dataset ? totalInput().dataset.auto : '0', paid: st.paid };
  }
  function restoreDraft(d) {
    if (!d || !build()) return;
    st.items = (d.items || []).map(normalizeItem);
    st.editing = typeof d.editing === 'number' && d.editing < st.items.length ? d.editing : -1;
    st.kind = d.kind || 'item'; st.open = d.open || {}; st.paid = d.paid || '';
    // The core restores the inputs right after this; draw once they are back.
    setTimeout(function () {
      var total = totalInput(); if (total) total.dataset.auto = d.auto || '0';
      renderCats(); renderDate(); renderPaid(); render();
    }, 0);
  }

  global.MemoFinanceEntry = {
    open: open, collect: collect, applyItems: applyItems, captureDraft: captureDraft, restoreDraft: restoreDraft,
    normalizeItem: normalizeItem, taxAmount: taxAmount, fill: function (r) { build(); fill(r); }, scanAvailable: scanAvailable,
    _state: st, _readPages: readPages,
  };
})(window);
