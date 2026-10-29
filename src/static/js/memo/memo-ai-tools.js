// memo-ai-tools.js — what an AI contact may look at, and the changes it may
// propose (memo-chats.js runs them through MemoAiClient.runTools).
//
// Reading needs no tap: search, open and add up whatever the contact's "Read"
// ticks allow, with Discover's privacy rules (memo-discover.js sources). Every
// change is only a proposal: a card on the reply that waits for a tap. A
// tapped card writes through the normal sync log (OperationQueue), so it
// syncs, backs up and undoes like anything done by hand; deletes only ever go
// to the Bin. The Vault is never reachable from here.
(function (global) {
  'use strict';

  var PAGES = ['notes', 'spending', 'plans'];
  var VARIANT = { notes: 'default', spending: 'finance', plans: 'planner' };
  var LIMIT = 25, MAX_IDS = 50, MAX_TODOS = 20;
  var PLAN_COLOR = '#60a5fa';
  var REMIND = { none: 0, '5_min': 5, '10_min': 10, '15_min': 15, '30_min': 30, '1_hour': 60 };
  var CARD_NOTE = 'Shown to the person as a card. Nothing is saved until they tap it, so do not say it is done.';
  var STOP = new Set('the a an and or of to in on at for with is are was were be my me i you your it this that what when where who how did do does have has had from about any some all'.split(' '));

  function t(s, v) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s, v) : String(s).replace(/\{(\w+)\}/g, function (_m, k) { return v && v[k] != null ? v[k] : ''; }); }
  function sdb() { var s = global.MemoStateDb; return s && s.ready && s.ready() ? s : null; }
  function src() { return global.MemoDiscover && global.MemoDiscover.sources; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function isoDay(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return isoDay(new Date()); }
  function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function round2(n) { return Math.round(num(n) * 100) / 100; }
  function str(v, n) { return String(v == null ? '' : v).trim().slice(0, n || 400); }
  function isDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
  function isTime(v) { return /^\d{2}:\d{2}$/.test(String(v || '')); }
  function tags(v) { return (Array.isArray(v) ? v : String(v || '').split(',')).map(function (x) { return String(x).replace(/^#/, '').trim(); }).filter(Boolean).slice(0, 20); }

  // ── permissions ──
  // canRead / canChange per page. Change needs Read. The Assistant made by
  // older builds has no canChange: it may propose everywhere it may read.
  function perms(person) {
    var r = (person && person.canRead) || {}, c = person && person.canChange;
    if (!c) c = person && person.id === 'assistant' ? { notes: true, spending: true, plans: true, me: true } : {};
    var read = { notes: !!r.notes, spending: !!r.spending, plans: !!r.plans, me: r.me !== false };
    var change = {};
    Object.keys(read).forEach(function (k) { change[k] = read[k] && !!c[k]; });
    return { read: read, change: change };
  }

  // ── data (privacy-filtered) ──
  function items(page) {
    var s = src();
    if (!s) return [];
    return page === 'notes' ? s.memos() : page === 'spending' ? s.finance() : s.plans();
  }
  function find(page, id) { return items(page).filter(function (e) { return e.id === id; })[0] || null; }
  function entryTime(e) { var s = src(); return s ? s.entryTime(e) : (e.ts || 0); }
  function itemDate(page, e) {
    if (page === 'spending' && isDay(String(e.purchaseDate || '').slice(0, 10))) return String(e.purchaseDate).slice(0, 10);
    if (page === 'plans' && (e.date || e.due)) return e.date || e.due;
    var at = entryTime(e);
    return at ? isoDay(new Date(at)) : '';
  }
  function amount(e) { return round2(e.total != null && e.total !== '' ? e.total : e.price); }
  function firstLine(text) { var s = src(); return s ? s.firstLine(text) : String(text || '').split('\n')[0]; }
  function money(n) { var s = src(); return s ? s.money(n) : '$' + num(n).toFixed(2); }
  function haystack(page, e) {
    if (page === 'plans') return [e.title, e.description, e.notes, e.kind].join(' ').toLowerCase();
    var extra = page === 'spending' ? (e.items || []).map(function (i) { return i && i.name; }).join(' ') : '';
    return [e.description, e.category, (e.tags || []).join(' '), extra].join(' ').toLowerCase();
  }
  function words(query) {
    return String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(function (w) { return w.length > 1 && !STOP.has(w); });
  }
  function score(hay, ws) {
    return ws.reduce(function (n, w) { return n + (hay.indexOf(w) >= 0 || (w.length > 3 && /s$/.test(w) && hay.indexOf(w.slice(0, -1)) >= 0) ? 1 : 0); }, 0);
  }
  function brief(page, e) {
    var o = { page: page, id: e.id, date: itemDate(page, e) };
    if (page === 'plans') {
      o.kind = e.kind;
      o.title = clip(e.title, 160);
      if (e.kind === 'event' && !e.allDay && e.start) o.time = e.start + (e.end ? '–' + e.end : '');
      if (e.kind === 'todo') o.done = !!e.done;
      if (e.remindAtStart) o.reminder = 'at the time';
      else if (e.remindBefore > 0) o.reminder = e.remindBefore + ' min before';
      return o;
    }
    o.text = clip(e.description, page === 'notes' ? 220 : 160);
    if (e.category) o.category = e.category;
    if (e.tags && e.tags.length) o.tags = e.tags.slice(0, 12);
    if (page === 'spending') {
      o.total = amount(e);
      var names = (e.items || []).map(function (i) { return i && i.name; }).filter(Boolean);
      if (names.length) o.items = names.slice(0, 8);
    }
    return o;
  }
  // A short human label for cards and the trace line.
  function label(page, e) {
    if (!e) return t('(not found)');
    if (page === 'plans') return clip(e.title || t('Untitled'), 70) + (e.date ? ' · ' + e.date + (e.start && !e.allDay ? ' ' + e.start : '') : e.due ? ' · ' + e.due : '');
    if (page === 'spending') return clip(firstLine(e.description) || e.category || t('Purchase'), 50) + ' · ' + money(amount(e)) + ' · ' + itemDate(page, e);
    return clip(firstLine(e.description) || t('Untitled note'), 70);
  }
  function categories(page) {
    var count = {};
    items(page).forEach(function (e) { if (e.category) count[e.category] = (count[e.category] || 0) + 1; });
    return Object.keys(count).sort(function (a, b) { return count[b] - count[a]; }).slice(0, 30);
  }
  function pageLabel(page) { return t({ notes: 'Notes', spending: 'Spending', plans: 'Plans', me: 'Me page' }[page] || page); }

  // ── one reply's working state ──
  //   opts.canPropose: false in a group for contacts nobody addressed
  //   opts.photoRel:   the photo just sent (a local blob path), if any
  function context(person, opts) {
    opts = opts || {};
    return { person: person, perms: perms(person), canPropose: opts.canPropose !== false, photoRel: opts.photoRel || null, actions: [], trace: [] };
  }

  // ── tool specs (neutral JSON schema; memo-ai-client adapts them) ──
  function S(description) { return { type: 'string', description: description }; }
  function N(description) { return { type: 'number', description: description }; }
  function B(description) { return { type: 'boolean', description: description }; }
  function E(values, description) { return { type: 'string', enum: values, description: description }; }
  function A(item, description) { return { type: 'array', items: item, description: description }; }
  function O(props, required) { return { type: 'object', properties: props, required: required || [] }; }

  function specs(ctx) {
    var p = ctx.perms, read = PAGES.filter(function (k) { return p.read[k]; }), out = [];
    var dateFrom = S('first day, YYYY-MM-DD'), dateTo = S('last day, YYYY-MM-DD');
    if (read.length) {
      out.push({ name: 'search', description: 'Search the records you may read (' + read.join(', ') + '). Matches any of the words, best matches first, then newest. ' +
        'Returns brief items with ids. Leave query empty to list by date; use from/to for dates.',
        parameters: O({ query: S('words to look for'), page: E(read, 'only this page; omit for all'), from: dateFrom, to: dateTo, limit: N('most items to return, default 25') }) });
      out.push({ name: 'get_item', description: 'Read one item in full by its id from search.', parameters: O({ page: E(read), id: S('the item id') }, ['page', 'id']) });
    }
    if (p.read.spending) {
      out.push({ name: 'spending_summary', description: 'Add up purchases: total, count, per category, and the biggest ones. Use it for "how much did I spend" questions.',
        parameters: O({ from: dateFrom, to: dateTo, category: S('category, partial names match'), query: S('words in the purchase or its items') }) });
    }
    if (!ctx.canPropose) return out;
    var photo = B('true to keep the photo the person just sent with this item');
    if (p.change.notes) out.push({ name: 'propose_note', description: 'Propose a new note. ' + CARD_NOTE,
      parameters: O({ text: S('the note'), category: S('a category already in use if one fits'), tags: A({ type: 'string' }, 'a few tags'), use_photo: photo }, ['text']) });
    if (p.change.spending) out.push({ name: 'propose_purchase', description: 'Propose a new purchase (spending). ' + CARD_NOTE,
      parameters: O({ description: S('what was bought, where'), total: N('total paid'), tax: N('tax, 0 if unknown'), category: S('a category already in use if one fits'),
        date: S('YYYY-MM-DD, default today'), tags: A({ type: 'string' }, 'a few tags'), store: S('the store or seller, if known'),
        items: A(O({ name: S('item'), amount: N('quantity'), unitPrice: N('price each'), totalPrice: N('line total'), kind: S('item (default), discount or fee (a tip, bag fee, delivery fee)') }, ['name']), 'line items, if known'),
        use_photo: photo }, ['description', 'total']) });
    if (p.change.plans) {
      out.push({ name: 'propose_todos', description: 'Propose one or more to-dos (Plans). ' + CARD_NOTE,
        parameters: O({ todos: A(O({ title: S('the to-do'), due: S('YYYY-MM-DD, optional') }, ['title']), 'the to-dos') }, ['todos']) });
      out.push({ name: 'propose_event', description: 'Propose a calendar event (Plans). ' + CARD_NOTE,
        parameters: O({ title: S('event'), date: S('YYYY-MM-DD'), start: S('HH:MM, 24-hour; omit for all day'), end: S('HH:MM'), notes: S('details'),
          reminder: E(Object.keys(REMIND).concat(['at_start']), 'phone alert: none, at_start, or minutes before') }, ['title', 'date']) });
      out.push({ name: 'propose_reminder', description: 'Propose a reminder: a Plans item that alerts the phone at that exact time. ' + CARD_NOTE,
        parameters: O({ what: S('what to be reminded of'), date: S('YYYY-MM-DD'), time: S('HH:MM, 24-hour') }, ['what', 'date', 'time']) });
    }
    var changeable = PAGES.filter(function (k) { return p.change[k]; });
    if (changeable.length) {
      out.push({ name: 'propose_changes', description: 'Propose changing existing items found with search: tags, category, done, or one item\'s text, amount or date. ' +
        'The card lists every item; the person can untick some. ' + CARD_NOTE,
        parameters: O({ page: E(changeable), ids: A({ type: 'string' }, 'item ids from search'), summary: S('short label, e.g. "Add tag #travel"'),
          add_tags: A({ type: 'string' }), remove_tags: A({ type: 'string' }), category: S('new category'), done: B('plans to-dos: mark done or not'),
          new_text: S('one item: its new text or title'), new_total: N('one purchase: its new total'), new_date: S('one item: YYYY-MM-DD') }, ['page', 'ids']) });
      out.push({ name: 'propose_move_to_bin', description: 'Propose moving items to the Bin (restorable for 30 days; never permanent). ' + CARD_NOTE,
        parameters: O({ page: E(changeable), ids: A({ type: 'string' }, 'item ids from search'), reason: S('why, in a few words') }, ['page', 'ids']) });
    }
    if (p.change.me) out.push({ name: 'propose_memory', description: 'Propose adding a fact about the person to their Me page, which every AI contact reads. Only for lasting facts or preferences they asked you to remember. ' + CARD_NOTE,
      parameters: O({ fact: S('one short sentence') }, ['fact']) });
    return out;
  }

  // ── tools ──
  function allowed(ctx, page, kind) { return PAGES.indexOf(page) >= 0 && ctx.perms[kind][page]; }
  function readPages(ctx, page) { return page ? (allowed(ctx, page, 'read') ? [page] : []) : PAGES.filter(function (k) { return ctx.perms.read[k]; }); }
  function inRange(d, a) { return (!isDay(a.from) || d >= a.from) && (!isDay(a.to) || d <= a.to); }
  function rangeLabel(a) {
    if (isDay(a.from) && isDay(a.to)) return a.from === a.to ? a.from : a.from + ' – ' + a.to;
    return isDay(a.from) ? t('from {d}', { d: a.from }) : isDay(a.to) ? t('until {d}', { d: a.to }) : '';
  }
  function traceLine(parts) { return parts.filter(Boolean).join(' · '); }

  function toolSearch(ctx, a) {
    var pages = readPages(ctx, a.page);
    if (!pages.length) return { error: 'You may not read that page.' };
    var ws = words(a.query), hits = [];
    pages.forEach(function (page) {
      items(page).forEach(function (e) {
        var d = itemDate(page, e);
        if (!inRange(d, a)) return;
        var s = ws.length ? score(haystack(page, e), ws) : 0;
        if (ws.length && !s) return;
        hits.push({ page: page, e: e, s: s, at: entryTime(e) });
      });
    });
    hits.sort(function (x, y) { return y.s - x.s || y.at - x.at; });
    var limit = Math.max(1, Math.min(50, parseInt(a.limit, 10) || LIMIT));
    ctx.trace.push(traceLine([t('Searched {what}', { what: pages.length === PAGES.length ? t('everything') : pages.map(pageLabel).join(', ').toLowerCase() }),
      a.query ? '“' + clip(a.query, 30) + '”' : '', rangeLabel(a), t('{n} items', { n: hits.length })]));
    return { count: Math.min(limit, hits.length), total_matches: hits.length, items: hits.slice(0, limit).map(function (h) { return brief(h.page, h.e); }) };
  }
  function toolGet(ctx, a) {
    if (!allowed(ctx, a.page, 'read')) return { error: 'You may not read that page.' };
    var e = find(a.page, a.id);
    if (!e) return { error: 'No item with that id.' };
    var o = brief(a.page, e);
    if (a.page === 'plans') { if (e.description || e.notes) o.notes = clip(e.description || e.notes, 2000); if (e.priority) o.priority = e.priority; }
    else {
      o.text = String(e.description || '').slice(0, 4000);
      o.photos = (e.images || []).length;
      if (a.page === 'spending') {
        o.tax = round2(e.tax);
        o.items = (e.items || []).filter(Boolean).slice(0, 40).map(function (i) { var l = { name: i.name, amount: i.amount, unitPrice: i.unitPrice, totalPrice: i.totalPrice }; if (i.kind) l.kind = i.kind; return l; });
        ['store', 'paidWith', 'notes'].forEach(function (k) { if (e[k]) o[k] = clip(e[k], 500); });
      }
    }
    ctx.trace.push(t('Opened {name}', { name: label(a.page, e) }));
    return o;
  }
  function toolSpending(ctx, a) {
    if (!ctx.perms.read.spending) return { error: 'You may not read spending.' };
    var ws = words(a.query), cat = String(a.category || '').toLowerCase().trim();
    var rows = items('spending').filter(function (e) {
      if (!inRange(itemDate('spending', e), a)) return false;
      if (cat && String(e.category || '').toLowerCase().indexOf(cat) < 0) return false;
      return !ws.length || score(haystack('spending', e), ws) > 0;
    });
    var total = 0, by = {};
    rows.forEach(function (e) {
      var v = amount(e), c = e.category || 'Uncategorized';
      total += v;
      by[c] = by[c] || { category: c, total: 0, count: 0 };
      by[c].total += v; by[c].count++;
    });
    var cats = Object.keys(by).map(function (k) { by[k].total = round2(by[k].total); return by[k]; }).sort(function (x, y) { return y.total - x.total; });
    ctx.trace.push(traceLine([t('Added up spending'), rangeLabel(a), a.category ? clip(a.category, 20) : '', t('{n} items', { n: rows.length })]));
    return { from: a.from || null, to: a.to || null, count: rows.length, total: round2(total), by_category: cats.slice(0, 15),
      biggest: rows.slice().sort(function (x, y) { return amount(y) - amount(x); }).slice(0, 5).map(function (e) { return brief('spending', e); }) };
  }

  function propose(ctx, action) {
    action.id = 'a' + (ctx.actions.length + 1);
    action.status = 'pending';
    ctx.actions.push(action);
    return { ok: true, card: action.id, note: CARD_NOTE };
  }
  function photoFor(ctx, a) { return a.use_photo && ctx.photoRel ? ctx.photoRel : null; }
  function liveIds(page, ids) {
    var seen = {};
    return (Array.isArray(ids) ? ids : []).map(String).filter(function (id) {
      if (seen[id] || !find(page, id)) return false;
      seen[id] = true; return true;
    }).slice(0, MAX_IDS);
  }

  function toolNote(ctx, a) {
    if (!ctx.perms.change.notes) return { error: 'You may not change notes.' };
    var text = str(a.text, 8000);
    if (!text) return { error: 'The note is empty.' };
    return propose(ctx, { type: 'create', page: 'notes', photoRel: photoFor(ctx, a),
      items: [{ description: text, category: str(a.category, 60) || 'Uncategorized', tags: tags(a.tags) }] });
  }
  function toolPurchase(ctx, a) {
    if (!ctx.perms.change.spending) return { error: 'You may not change spending.' };
    var total = round2(a.total);
    if (!(total >= 0)) return { error: 'total must be a number.' };
    var lines = (Array.isArray(a.items) ? a.items : []).filter(function (i) { return i && i.name; }).slice(0, 60).map(function (i) {
      var qty = parseInt(i.amount, 10) || 1, unit = round2(i.unitPrice);
      var line = { name: str(i.name, 120), description: '', amount: qty, unitPrice: unit, totalPrice: i.totalPrice != null ? round2(i.totalPrice) : round2(qty * unit) };
      // A discount lowers the total; a fee or tip is added after tax.
      if (i.kind === 'discount') { line.kind = 'discount'; line.amount = 1; line.unitPrice = -Math.abs(line.totalPrice); line.totalPrice = line.unitPrice; }
      else if (i.kind === 'fee') line.kind = 'fee';
      return line;
    });
    var purchase = { description: str(a.description, 2000) || t('Purchase'),
      total: total, tax: round2(a.tax), category: str(a.category, 60) || 'Uncategorized', purchaseDate: isDay(a.date) ? a.date : today(), tags: tags(a.tags), items: lines };
    if (str(a.store)) purchase.store = str(a.store, 60);
    return propose(ctx, { type: 'create', page: 'spending', photoRel: photoFor(ctx, a), items: [purchase] });
  }
  function toolTodos(ctx, a) {
    if (!ctx.perms.change.plans) return { error: 'You may not change plans.' };
    var list = (Array.isArray(a.todos) ? a.todos : []).map(function (x) { return typeof x === 'string' ? { title: x } : x; })
      .filter(function (x) { return x && str(x.title); }).slice(0, MAX_TODOS)
      .map(function (x) { var o = { kind: 'todo', title: str(x.title, 200) }; if (isDay(x.due)) o.due = x.due; return o; });
    if (!list.length) return { error: 'No to-dos given.' };
    return propose(ctx, { type: 'create', page: 'plans', items: list });
  }
  function eventItem(title, date, start, end, notes) {
    var allDay = !isTime(start);
    var o = { kind: 'event', title: str(title, 200), date: date, allDay: allDay, start: allDay ? '09:00' : start, description: str(notes, 2000) };
    var toMin = function (hm) { return parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3), 10); };
    var sM = toMin(o.start), eM = Math.min(Math.max(isTime(end) ? toMin(end) : sM + 30, sM + 15), 23 * 60 + 59);
    o.end = allDay ? '10:00' : pad(Math.floor(eM / 60)) + ':' + pad(eM % 60);
    return o;
  }
  function toolEvent(ctx, a) {
    if (!ctx.perms.change.plans) return { error: 'You may not change plans.' };
    if (!str(a.title) || !isDay(a.date)) return { error: 'An event needs a title and a date (YYYY-MM-DD).' };
    var o = eventItem(a.title, a.date, a.start, a.end, a.notes);
    if (a.reminder === 'at_start') { o.remindAtStart = true; o.remindBefore = 0; }
    else o.remindBefore = REMIND[a.reminder] || 0;
    return propose(ctx, { type: 'create', page: 'plans', items: [o] });
  }
  function toolReminder(ctx, a) {
    if (!ctx.perms.change.plans) return { error: 'You may not change plans.' };
    if (!str(a.what) || !isDay(a.date) || !isTime(a.time)) return { error: 'A reminder needs what, a date (YYYY-MM-DD) and a time (HH:MM).' };
    var o = eventItem(a.what, a.date, a.time, null, '');
    o.remindAtStart = true; o.remindBefore = 0;
    return propose(ctx, { type: 'reminder', page: 'plans', items: [o] });
  }
  function toolChanges(ctx, a) {
    if (!allowed(ctx, a.page, 'change')) return { error: 'You may not change that page.' };
    var ids = liveIds(a.page, a.ids);
    if (!ids.length) return { error: 'None of those ids exist on that page. Search first.' };
    var c = {};
    if (tags(a.add_tags).length && a.page !== 'plans') c.addTags = tags(a.add_tags);
    if (tags(a.remove_tags).length && a.page !== 'plans') c.removeTags = tags(a.remove_tags);
    if (str(a.category) && a.page !== 'plans') c.category = str(a.category, 60);
    if (typeof a.done === 'boolean' && a.page === 'plans') c.done = a.done;
    if (ids.length === 1) {
      if (str(a.new_text)) c.text = str(a.new_text, 8000);
      if (a.new_total != null && a.page === 'spending' && !isNaN(parseFloat(a.new_total))) c.total = round2(a.new_total);
      if (isDay(a.new_date)) c.date = a.new_date;
    }
    if (!Object.keys(c).length) return { error: 'Nothing to change. Give tags, a category, done, or (for one item) new_text, new_total or new_date.' };
    return propose(ctx, { type: 'update', page: a.page, ids: ids, change: c, summary: str(a.summary, 80) });
  }
  function toolBin(ctx, a) {
    if (!allowed(ctx, a.page, 'change')) return { error: 'You may not change that page.' };
    var ids = liveIds(a.page, a.ids);
    if (!ids.length) return { error: 'None of those ids exist on that page. Search first.' };
    return propose(ctx, { type: 'delete', page: a.page, ids: ids, reason: str(a.reason, 160) });
  }
  function toolMemory(ctx, a) {
    if (!ctx.perms.change.me) return { error: 'You may not change the Me page.' };
    var fact = str(a.fact, 300);
    if (!fact) return { error: 'The fact is empty.' };
    return propose(ctx, { type: 'memory', page: 'me', fact: fact });
  }

  var TOOLS = { search: toolSearch, get_item: toolGet, spending_summary: toolSpending, propose_note: toolNote, propose_purchase: toolPurchase,
    propose_todos: toolTodos, propose_event: toolEvent, propose_reminder: toolReminder, propose_changes: toolChanges,
    propose_move_to_bin: toolBin, propose_memory: toolMemory };

  function exec(ctx, name, args) {
    var fn = TOOLS[name];
    // Only the tools this contact was given: specs() decides, exec() re-checks.
    if (!fn || !specs(ctx).some(function (s) { return s.name === name; })) return { error: 'Unknown tool: ' + name };
    return fn(ctx, args && typeof args === 'object' ? args : {});
  }

  // ── applying a tapped card ──
  async function op(type, id, data, variant) {
    var q = global.OperationQueue;
    if (!q || !q.addOperation) throw new Error('Saving is not ready yet.');
    await q.addOperation(type, id, type === 'delete' ? {} : { data: data }, { variant: variant });
  }
  function raw(variant, id) {
    var s = sdb();
    if (!s) return null;
    var list = variant === 'planner' || variant === 'contacts' ? s.loadDocs(variant) : s.loadEntries(variant);
    return (list || []).filter(function (e) { return e.id === id; })[0] || null;
  }
  async function photoData(rel) {
    var s = sdb();
    if (!rel || !s || !s.readBlob) return null;
    try { if (!(await s.readBlob(rel))) return null; } catch (_e) { return null; }
    return { images: ['/' + rel], _storedPaths: [rel], _filesToUpload: [rel], imageMeta: {}, attachments: [], _attachments: [] };
  }
  function createData(page, item, now) {
    var stamp = new Date(now).toISOString();
    if (page === 'plans') {
      var o = { createdAt: stamp, updatedAt: stamp };
      ['kind', 'title', 'date', 'start', 'end', 'allDay', 'description', 'due', 'remindBefore', 'remindAtStart'].forEach(function (k) { if (item[k] !== undefined) o[k] = item[k]; });
      o.kind = o.kind === 'event' ? 'event' : 'todo';
      o.title = String(o.title || '').slice(0, 200);
      if (o.kind === 'todo') Object.assign(o, { done: false, priority: 'normal' });
      else o.color = o.color || PLAN_COLOR;
      return o;
    }
    var base = { description: item.description, category: item.category || 'Uncategorized', tags: item.tags || [], images: [], attachments: [],
      imageMeta: {}, ts: now, createdAt: stamp, updatedAt: stamp };
    if (page === 'spending') Object.assign(base, { purchaseDate: item.purchaseDate || today(), total: round2(item.total), tax: round2(item.tax),
      price: round2(num(item.total) - num(item.tax)), adjustment: 0, items: item.items || [] });
    return base;
  }
  function patchFor(page, e, c) {
    var p = {};
    if (c.addTags || c.removeTags) {
      var list = (e.tags || []).filter(function (x) { return !(c.removeTags || []).some(function (r) { return r.toLowerCase() === String(x).toLowerCase(); }); });
      (c.addTags || []).forEach(function (x) { if (!list.some(function (y) { return String(y).toLowerCase() === x.toLowerCase(); })) list.push(x); });
      p.tags = list;
    }
    if (c.category) p.category = c.category;
    if (typeof c.done === 'boolean' && e.kind === 'todo') { p.done = c.done; p.completedAt = c.done ? today() : null; }
    if (c.text) { if (page === 'plans') p.title = c.text; else p.description = c.text; }
    if (c.total != null) { p.total = c.total; p.price = round2(c.total - num(e.tax)); }
    if (c.date) { if (page === 'spending') p.purchaseDate = c.date; else if (page === 'plans') { if (e.kind === 'todo') p.due = c.date; else p.date = c.date; } }
    return p;
  }
  function same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
  function lower(list) { return (list || []).map(function (x) { return String(x).toLowerCase(); }); }
  // Apply a card. opts.skip: indexes (create) or ids (update/delete) the
  // person unticked. opts.key: the card's own id (message + card); new items
  // get ids derived from it, so the same card applied on two devices (or
  // again after Undo) lands on the same item instead of making a second one.
  // Returns the undo record stored on the card.
  async function apply(action, opts) {
    opts = opts || {};
    var skip = opts.skip || [], now = Date.now(), undo = [];
    var variant = VARIANT[action.page];
    var key = String(opts.key || (now.toString(36) + Math.random().toString(36).slice(2, 8))).replace(/[^a-z0-9]+/gi, '');
    if (action.type === 'create' || action.type === 'reminder') {
      var photo = await photoData(action.photoRel);
      var items = action.items || [];
      for (var i = 0; i < items.length; i++) {
        if (skip.indexOf(i) >= 0) continue;
        var id = (action.page === 'plans' ? 'p' : 'e') + '_ai_' + key + '_' + i;
        var data = createData(action.page, items[i], now);
        if (photo && action.page !== 'plans' && !undo.length) Object.assign(data, photo);
        await op('create', id, data, variant);
        undo.push({ variant: variant, id: id, created: true });
      }
    } else if (action.type === 'update') {
      var ids = action.ids.filter(function (x) { return skip.indexOf(x) < 0; });
      for (var j = 0; j < ids.length; j++) {
        var e = raw(variant, ids[j]);
        if (!e || e.deletedAt) continue;
        var patch = patchFor(action.page, e, action.change || {});
        if (!Object.keys(patch).length) continue;
        var before = {};
        Object.keys(patch).forEach(function (k) { before[k] = e[k] === undefined ? null : JSON.parse(JSON.stringify(e[k])); });
        await op('update', ids[j], patch, variant);
        undo.push({ variant: variant, id: ids[j], before: before, after: JSON.parse(JSON.stringify(patch)) });
      }
    } else if (action.type === 'delete') {
      var gone = action.ids.filter(function (x) { return skip.indexOf(x) < 0; });
      for (var k = 0; k < gone.length; k++) {
        var d = raw(variant, gone[k]);
        if (!d || d.deletedAt) continue;
        await op('delete', gone[k], null, variant);
        undo.push({ variant: variant, id: gone[k], deleted: true });
      }
    } else if (action.type === 'memory') {
      var me = raw('contacts', 'me');
      var about = me && !me.deletedAt && me.about ? String(me.about).replace(/\s+$/, '') : '';
      var next = (about ? about + '\n' : '') + action.fact;
      if (me && !me.deletedAt) await op('update', 'me', { about: next }, 'contacts');
      else await op('create', 'me', { id: 'me', kind: 'me', name: '', about: next, instructions: '', avatar: null }, 'contacts');
      undo.push({ variant: 'contacts', id: 'me', fact: action.fact });
    }
    return undo;
  }
  // Undo a card. It takes back only what the card did: fields someone has
  // changed since keep their new value, tags the card added are removed (and
  // ones it removed come back) without touching other tags, and a remembered
  // fact is taken out of the Me page without restoring an older copy of it.
  async function revert(undo) {
    var list = (undo || []).slice().reverse();
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (u.created) { await op('delete', u.id, null, u.variant); continue; }
      if (u.deleted) { await op('update', u.id, { deletedAt: null, deletedBy: null, permanentDeleteAt: null }, u.variant); continue; }
      var now = raw(u.variant, u.id);
      if (!now) continue;
      if (u.fact != null) {
        var lines = String(now.about || '').split('\n');
        var at = lines.lastIndexOf(u.fact);
        if (at >= 0) { lines.splice(at, 1); await op('update', u.id, { about: lines.join('\n').replace(/\s+$/, '') }, u.variant); }
        continue;
      }
      if (!u.before) continue;
      var after = u.after || u.before;   // cards applied before this version saved no `after`
      var back = {};
      Object.keys(u.before).forEach(function (k) {
        if (k === 'tags') {
          var added = (after.tags || []).filter(function (t) { return lower(u.before.tags).indexOf(String(t).toLowerCase()) < 0; });
          var removed = (u.before.tags || []).filter(function (t) { return lower(after.tags).indexOf(String(t).toLowerCase()) < 0; });
          var tags = (now.tags || []).filter(function (t) { return lower(added).indexOf(String(t).toLowerCase()) < 0; });
          removed.forEach(function (t) { if (lower(tags).indexOf(String(t).toLowerCase()) < 0) tags.push(t); });
          if (!same(tags, now.tags || [])) back.tags = tags;
        } else if (!u.after || same(now[k], after[k])) back[k] = u.before[k];
      });
      if (Object.keys(back).length) await op('update', u.id, back, u.variant);
    }
  }

  global.MemoAiTools = {
    PAGES: PAGES,
    VARIANT: VARIANT,
    perms: perms,
    context: context,
    specs: specs,
    exec: exec,
    apply: apply,
    revert: revert,
    find: find,
    label: label,
    pageLabel: pageLabel,
    categories: categories
  };
})(window);
