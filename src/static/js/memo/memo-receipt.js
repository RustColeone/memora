// memo-receipt.js — turn the text of a receipt photo into a purchase.
//
// Input is what the phone's text reader saw: lines with their positions
// ({ text, left, top, right, bottom }), or plain text when positions are not
// known. Lines are first put back into printed rows (a receipt prints the name
// on the left and the price on the right, and the reader often returns them as
// separate blocks), then each row is read as an item, a discount, a fee, the
// subtotal, the tax or the total. The store is the first name-like row at the
// top; the date is the first plausible date anywhere.
//
// parse(input) -> { store, date, items: [{ name, description, amount,
//   unitPrice, totalPrice, kind?, unsure? }], subtotal, tax, total, mismatch }
// Everything runs on the device; nothing is sent anywhere.
(function (global) {
  'use strict';

  // A price at the end of a row: "4.29", "$4.29", "4,29", "1,234.56", "2.00-",
  // "-2.00", optionally followed by a tax flag ("4.29 F", "4.29 T", "4.29 *").
  var PRICE_AT_END = /(-?)\s*[$€£¥]?\s*([0-9OoSsIl|B]{1,6}(?:[.,][0-9]{3})*[.,][0-9OoSsIl|]{2})\s*(-?)\s*(?:[A-Z*]{1,2}|[A-Z]\s?[A-Z])?\s*$/;
  var QTY_AT = /(\d+(?:[.,]\d+)?)\s*(?:lb|lbs|kg|g|oz|ea|pcs?)?\s*[@xX×]\s*[$€£¥]?\s*(\d+[.,]\d{2})(?:\s*\/\s*(?:lb|kg|ea|oz))?/i;

  var KW = {
    savingsSummary: /\b(YOU SAVED|TOTAL SAVINGS|SAVINGS TODAY|YOUR SAVINGS)\b/,
    subtotal: /\b(SUB\s*-?\s*TOTAL|SUBTOTAL|SUBTTL|SOUS[\s-]?TOTAL|ZWISCHENSUMME|SUBTOTALE)\b|小计|小計/,
    tax: /\b(TAX|TAXES|VAT|GST|HST|PST|QST|MWST|TVA|IVA|IMPUESTO|USt)\b|税/,
    total: /\b(TOTAL|TOTALE|AMOUNT DUE|BALANCE DUE|TOTAL DUE|GRAND TOTAL|SUMME|GESAMT|MONTANT|IMPORTE)\b|合计|合計|总计|總計|总额|應付|应付/,
    fee: /\b(TIP|GRATUITY|SERVICE CHARGE|SERVICE FEE|BAG FEE|BAG CHARGE|BOTTLE DEPOSIT|DEPOSIT|CRV|DELIVERY FEE|FEE|TRINKGELD|POURBOIRE|PROPINA)\b|小费|服务费/,
    discount: /\b(DISCOUNT|COUPON|SAVINGS|SAVED|PROMO|MEMBER SAVINGS|REWARD|MARKDOWN|INSTANT SAVINGS|RABATT|REMISE|DESCUENTO)\b|优惠|折扣|减免/,
    payment: /\b(CHANGE|CASH|TEND(ER|ERED)?|VISA|MASTERCARD|MASTER CARD|AMEX|DISCOVER CARD|DEBIT|CREDIT|PAYMENT|PAID|AUTH|APPROVAL|APPROVED|ACCOUNT|ACCT|CARD ?#|CHIP|CONTACTLESS|EMV|AID|TERMINAL|REF ?#|TRAN(S|SACTION)?|CASHIER|REGISTER|LANE|ITEMS SOLD|ITEM COUNT|NUMBER OF ITEMS|BALANCE|POINTS|REWARDS BALANCE)\b|找零|现金|現金|刷卡/,
  };
  var NOT_STORE = /(\b(WELCOME|RECEIPT|INVOICE|THANK|THANKS|CUSTOMER COPY|STORE ?#|TEL|PHONE|WWW\.|HTTP|\.COM|ORDER|TABLE|SERVER|GUESTS?)\b)|(\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})|(\d+\s+[A-Z0-9.' ]+\s(ST|STREET|AVE|AVENUE|RD|ROAD|BLVD|DR|DRIVE|LN|LANE|WAY|HWY|PKWY|CT|PL|SUITE|STE)\b)/i;

  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function letters(s) { var m = String(s).match(/[A-Za-zÀ-ɏ぀-ヿ㐀-鿿가-힯]/g); return m ? m.length : 0; }
  function round2(n) { return Math.round(n * 100) / 100; }

  // "4,29" → 4.29; "1,234.56" → 1234.56; OCR look-alikes are fixed and flagged.
  function readMoney(token) {
    var fixed = String(token).replace(/[Oo]/g, '0').replace(/[Ss]/g, '5').replace(/[Il|]/g, '1').replace(/B/g, '8');
    var unsure = fixed !== String(token);
    if (/^\d{1,3}(,\d{3})+\.\d{2}$/.test(fixed)) fixed = fixed.replace(/,/g, '');
    else if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(fixed)) fixed = fixed.replace(/\./g, '').replace(',', '.');
    else fixed = fixed.replace(',', '.');
    var n = parseFloat(fixed);
    return isNaN(n) ? null : { value: n, unsure: unsure };
  }

  // Title-case a name read in capitals ("WHOLE MILK" → "Whole Milk"); leave
  // mixed case and non-Latin scripts as printed.
  function tidyName(s) {
    var t = clean(s).replace(/^\d{5,}\s+/, '').replace(/\s+\d{5,}$/, '').replace(/[*#]+$/, '').replace(/^[-–:.,]+|[-–:.,]+$/g, '').trim();
    if (/[a-z]/.test(t) || !/[A-Z]{2}/.test(t)) return t;
    return t.toLowerCase().replace(/(^|[\s/&(-])([a-zÀ-ɏ])/g, function (_m, p, c) { return p + c.toUpperCase(); });
  }

  // ── Lines back into printed rows ────────────────────────────────────────
  function rowsFromLines(lines) {
    var items = (lines || []).filter(function (l) { return l && clean(l.text); }).map(function (l) {
      var top = +l.top || 0, bottom = +l.bottom || top + 10;
      return { text: clean(l.text), left: +l.left || 0, right: +l.right || 0, top: top, bottom: bottom, cy: (top + bottom) / 2, h: Math.max(1, bottom - top) };
    });
    if (!items.length) return [];
    var hs = items.map(function (i) { return i.h; }).sort(function (a, b) { return a - b; });
    var medianH = hs[Math.floor(hs.length / 2)];
    items.sort(function (a, b) { return a.cy - b.cy || a.left - b.left; });
    var rows = [];
    items.forEach(function (it) {
      var best = null, bestD = Infinity;
      rows.forEach(function (r) {
        var d = Math.abs(r.cy - it.cy);
        var overlaps = r.parts.some(function (p) { return it.left < p.right - 2 && it.right > p.left + 2; });
        if (d < medianH * 0.55 && !overlaps && d < bestD) { best = r; bestD = d; }
      });
      if (best) { best.parts.push(it); best.cy = (best.cy * (best.parts.length - 1) + it.cy) / best.parts.length; }
      else rows.push({ cy: it.cy, parts: [it] });
    });
    rows.sort(function (a, b) { return a.cy - b.cy; });
    return rows.map(function (r) {
      r.parts.sort(function (a, b) { return a.left - b.left; });
      return r.parts.map(function (p) { return p.text; }).join('  ');
    });
  }

  function rowsFromText(text) {
    return String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  }

  // ── One row → what it is ────────────────────────────────────────────────
  function readRow(text) {
    var row = { text: text, upper: text.toUpperCase(), price: null, unsure: false, rest: text, qty: null, unit: null };
    // "2 @ 4.29" alone is a quantity line, not a price.
    var alone = QTY_AT.exec(text);
    if (alone && letters(text.replace(QTY_AT, '').replace(/\b(lb|lbs|kg|g|oz|ea|pcs?)\b/gi, '')) === 0 && !PRICE_AT_END.test(text.slice(alone.index + alone[0].length))) {
      row.qty = parseFloat(alone[1].replace(',', '.'));
      row.unit = parseFloat(alone[2].replace(',', '.'));
      row.rest = '';
      row.kind = 'qty';
      return row;
    }
    var m = PRICE_AT_END.exec(text);
    if (m) {
      var money = readMoney(m[2]);
      // A bare 5+ digit "price" with no separator was never matched; a token
      // that is mostly look-alike letters is not a price.
      if (money && !(money.unsure && !/\d/.test(m[2]))) {
        row.price = (m[1] === '-' || m[3] === '-') ? -money.value : money.value;
        row.unsure = money.unsure;
        row.rest = clean(text.slice(0, m.index));
      }
    }
    var q = QTY_AT.exec(row.rest);
    if (q) {
      row.qty = parseFloat(q[1].replace(',', '.'));
      row.unit = parseFloat(q[2].replace(',', '.'));
      row.rest = clean(row.rest.slice(0, q.index) + ' ' + row.rest.slice(q.index + q[0].length));
    }
    var U = row.upper;
    if (KW.savingsSummary.test(U)) row.kind = 'skip';
    else if (KW.subtotal.test(U)) row.kind = 'subtotal';
    else if (KW.tax.test(U) && !/\bTAX\s*(ID|NO|#|EXEMPT)/.test(U)) row.kind = 'tax';
    else if (KW.total.test(U) && !KW.payment.test(U.replace(KW.total, ' '))) row.kind = 'total';
    else if (KW.payment.test(U)) row.kind = 'skip';
    else if (row.price != null && (row.price < 0 || KW.discount.test(U))) row.kind = 'discount';
    else if (row.price != null && KW.fee.test(U)) row.kind = 'fee';
    else if (row.price != null && letters(row.rest) >= 2) row.kind = 'item';
    else if (row.price != null && row.qty != null) row.kind = 'qtyprice';   // "2 @ 4.29  8.58"
    else if (row.price != null) row.kind = 'price';                          // a price alone
    else if (row.qty != null) row.kind = 'qty';                              // "2 @ 4.29" under its item
    else if (letters(row.rest) >= 2) row.kind = 'name';
    else row.kind = 'skip';
    return row;
  }

  // ── Dates ───────────────────────────────────────────────────────────────
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function ymd(y, m, d) {
    y = +y; m = +m; d = +d;
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) return null;
    var now = Date.now();
    if (dt.getTime() > now + 36 * 3600 * 1000 || dt.getTime() < now - 10 * 366 * 24 * 3600 * 1000) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  function findDate(rows) {
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i], m, r;
      if ((m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(t)) && (r = ymd(m[1], m[2], m[3]))) return r;
      if ((m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t)) && (r = ymd(m[1], m[2], m[3]))) return r;
      if ((m = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/.exec(t)) && (r = ymd(m[3], m[2], m[1]))) return r;
      if ((m = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/.exec(t))) {
        r = +m[1] > 12 ? ymd(m[3], m[2], m[1]) : ymd(m[3], m[1], m[2]);
        if (r) return r;
      }
      if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(t)) && (r = ymd(m[3], MONTHS[m[1].toLowerCase()], m[2]))) return r;
      if ((m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i.exec(t)) && (r = ymd(m[3], MONTHS[m[2].toLowerCase()], m[1]))) return r;
    }
    return '';
  }

  function findStore(rows, firstPriceRow) {
    var limit = Math.min(rows.length, Math.max(1, firstPriceRow < 0 ? 5 : Math.min(firstPriceRow, 6)));
    for (var i = 0; i < limit; i++) {
      var t = clean(rows[i].replace(/#\s*\d+/g, '').replace(/\bstore\s*\d+/i, ''));
      if (letters(t) < 3 || NOT_STORE.test(t) || findDate([t]) || PRICE_AT_END.test(t)) continue;
      return tidyName(t).slice(0, 60);
    }
    return '';
  }

  function line(name, price, opts) {
    opts = opts || {};
    var qty = opts.qty != null && opts.qty > 0 ? opts.qty : 1;
    var unit = opts.unit != null ? opts.unit : round2(price / qty);
    var out = { name: tidyName(name) || '', description: '', amount: qty, unitPrice: unit, totalPrice: round2(price) };
    if (opts.kind && opts.kind !== 'item') out.kind = opts.kind;
    if (opts.unsure || (out.name && letters(out.name) < 3)) out.unsure = true;
    return out;
  }

  function parse(input) {
    input = input || {};
    var rows = Array.isArray(input.lines) && input.lines.length ? rowsFromLines(input.lines) : rowsFromText(input.text);
    var read = rows.map(readRow);
    var items = [], subtotal = null, taxes = [], totals = [];
    var pendingName = null, nameRun = [], priceRun = [], firstPriceRow = -1;

    // Text without positions often lists a run of names and then their
    // prices: pair a run of lone prices with the same number of names just
    // above it (marked unsure, so the person checks them).
    function flushPrices() {
      if (!priceRun.length) return;
      var names = nameRun.slice(-priceRun.length);
      priceRun.slice(-names.length).forEach(function (p, k) { items.push(line(names[k], p.price, { unsure: true })); });
      priceRun = []; nameRun = []; pendingName = null;
    }

    read.forEach(function (r, i) {
      if (r.price != null && firstPriceRow < 0 && (r.kind === 'item' || r.kind === 'price' || r.kind === 'qtyprice')) firstPriceRow = i;
      if (r.kind !== 'price') flushPrices();
      switch (r.kind) {
        case 'subtotal': if (r.price != null) subtotal = r.price; pendingName = null; break;
        case 'tax': if (r.price != null) taxes.push(r.price); pendingName = null; break;
        case 'total': if (r.price != null && r.price > 0) totals.push(r.price); pendingName = null; break;
        case 'discount': items.push(line(r.rest || 'Discount', -Math.abs(r.price), { kind: 'discount', unsure: r.unsure })); pendingName = null; break;
        case 'fee': items.push(line(r.rest, r.price, { kind: 'fee', unsure: r.unsure })); pendingName = null; break;
        case 'item':
          items.push(line(r.rest, r.price, { qty: r.qty, unit: r.unit, unsure: r.unsure }));
          pendingName = null; nameRun = [];
          break;
        case 'qtyprice':
          if (pendingName) { items.push(line(pendingName, r.price, { qty: r.qty, unit: r.unit, unsure: r.unsure })); pendingName = null; nameRun = []; }
          break;
        case 'qty':
          // "2 @ 4.29" printed under the item it belongs to.
          if (items.length && items[items.length - 1].kind == null && !pendingName) {
            var prev = items[items.length - 1];
            prev.amount = r.qty; prev.unitPrice = r.unit;
          }
          break;
        case 'name':
          pendingName = r.rest; nameRun.push(r.rest);
          break;
        case 'price':
          // A price on its own line, right under its name.
          if (pendingName && !priceRun.length && nameRun.length === 1) { items.push(line(pendingName, r.price, { unsure: r.unsure })); pendingName = null; nameRun = []; }
          else priceRun.push(r);
          break;
      }
    });
    flushPrices();

    var tax = taxes.length ? round2(taxes.reduce(function (s, v) { return s + v; }, 0)) : null;
    var lineSum = round2(items.reduce(function (s, it) { return s + (it.kind === 'fee' ? 0 : it.totalPrice); }, 0));
    var fees = round2(items.reduce(function (s, it) { return s + (it.kind === 'fee' ? it.totalPrice : 0); }, 0));
    var total = totals.length ? Math.max.apply(null, totals) : null;
    if (total == null && subtotal != null) total = round2(subtotal + (tax || 0) + fees);
    if (total == null && items.length) total = round2(lineSum + (tax || 0) + fees);
    var expected = round2(lineSum + (tax || 0) + fees);
    // Prices that already include the tax (VAT receipts): the lines alone add
    // up to the total, and the tax line is only a breakdown.
    var taxIncluded = tax != null && total != null && items.length > 0 && Math.abs(round2(lineSum + fees) - total) <= 0.011;
    if (taxIncluded) expected = round2(lineSum + fees);
    return {
      store: findStore(rows, firstPriceRow),
      date: findDate(rows),
      items: items,
      subtotal: subtotal,
      tax: taxIncluded ? null : tax,
      taxIncluded: taxIncluded ? tax : null,
      total: total,
      // The lines do not add up to the printed total: some line was missed or misread.
      mismatch: total != null && items.length > 0 && Math.abs(expected - total) > 0.011,
      rows: rows,
    };
  }

  global.MemoReceipt = { parse: parse, _rowsFromLines: rowsFromLines, _readRow: readRow, _findDate: findDate };
})(window);
