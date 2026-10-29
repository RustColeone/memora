// memo-chats.js — AI contacts, group chats and the Me profile (Discover).
//
// Data (synced documents, memo-state-db DOC_VARIANTS):
//   contacts  { kind: 'contact' | 'group' | 'me', … } — Assistant is created
//             the first time an AI key exists; 'me' is the person's profile.
//   messages  { chatId, role: 'user' | 'assistant', authorId, text, at, refs,
//               image?, photoRel?, actions?, trace? }
//             one document per message, so threads from two devices merge.
// A reply is built from three layers: Memora's own rules, the Me page, then
// the contact's personality. Below them go only the notes, spending and plans
// this contact may read, picked by matching the message, with Discover's
// privacy rules (memo-discover.js sources). The Vault is never sent.
// With tools (memo-ai-tools.js) the contact can look things up itself and
// propose changes: each proposal is a card on its reply (`actions`, with its
// status, so it syncs) that does nothing until the person taps it.
(function (global) {
  'use strict';

  var CONTACTS = 'contacts', MESSAGES = 'messages';
  var ME_ID = 'me', ASSISTANT_ID = 'assistant', SERVER_KEY = 'server';
  var MAX_GROUP = 4, RECENT = 5, HISTORY = 20, CONTEXT_ITEMS = 12, MAX_STEPS = 5;
  var COLORS = ['#e0a458', '#7aa2ff', '#8fcf9f', '#e58fb5', '#f4c27a', '#9ad0e8', '#c9a3f2', '#f29b9b'];
  var STOP = new Set('the a an and or of to in on at for with is are was were be been my me i you your it this that what when where who how did do does have has had from about can could should would will just any some our we they them their there here please tell show find'.split(' '));
  var PERM_ROWS = [['notes', 'Notes'], ['spending', 'Spending'], ['plans', 'Plans'], ['me', 'Me page']];

  var ui = { chat: null, editor: null, me: null, chatId: null, sending: false, typing: [], error: '',
    serverAi: null, photo: null, unticked: {}, editing: null, cardBusy: null };

  function t(s, v) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s, v) : String(s).replace(/\{(\w+)\}/g, function (_m, k) { return v && v[k] != null ? v[k] : ''; }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function icon(name) { return '<span class="svg-icon svg-icon-' + name + '" aria-hidden="true"></span>'; }
  function sdb() { var s = global.MemoStateDb; return s && s.ready && s.ready() ? s : null; }
  function newId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  function live(d) { return d && !d.deletedAt; }
  function docs(col) { return sdb() ? (sdb().loadDocs(col) || []).filter(live) : []; }
  function hasVaultKey() { return !!(global.MemoAiKey && global.MemoAiKey.isConfigured && global.MemoAiKey.isConfigured()); }
  function serverAiOn() { return !!(ui.serverAi && ui.serverAi.available); }
  // AI is usable with a key in the Vault, or through the sync server's own AI.
  function hasKey() { return hasVaultKey() || serverAiOn(); }
  function toast(message, kind) { if (global.MemoShell && global.MemoShell.toast) global.MemoShell.toast(message, { kind: kind || 'info' }); }
  function apiBase() { return String((global.MemoContracts && global.MemoContracts.getApiBase && global.MemoContracts.getApiBase()) || '').replace(/\/$/, ''); }
  function isNative() { var C = global.Capacitor; return !!(C && (typeof C.isNativePlatform === 'function' ? C.isNativePlatform() : C.Plugins)); }
  function locale() { return (global.MemoI18n && global.MemoI18n.getLocale && global.MemoI18n.getLocale()) || undefined; }

  // "Your server's AI": the sync server says in /api/config whether it has
  // one (never which key). A phone with no server set asks nobody.
  async function loadServerAi() {
    var q = global.OperationQueue;
    if (!q || !q.serverConfig || (!apiBase() && isNative())) return;
    var cfg = await q.serverConfig(apiBase());
    var next = cfg && cfg.server && cfg.ai && cfg.ai.available ? { available: true, vision: !!cfg.ai.vision } : null;
    if (JSON.stringify(next) === JSON.stringify(ui.serverAi)) return;
    ui.serverAi = next;
    ensureAssistant(); refreshDiscover(); renderChat();
  }
  // Which AI answers for this contact: its own key, the Vault's default key,
  // or the server's AI (picked, or the only one there is).
  function activeFor(person) {
    var server = serverAiOn() ? { provider: SERVER_KEY, apiBase: apiBase(), model: '' } : null;
    if (person.keyId === SERVER_KEY) return server;
    var key = global.MemoAiKey && global.MemoAiKey.getActiveKey(person.keyId || undefined);
    if (key) return person.model ? Object.assign({}, key, { model: person.model }) : key;
    return server;
  }
  function seesPhotos(active) {
    if (!active) return false;
    if (active.provider === SERVER_KEY) return !!(ui.serverAi && ui.serverAi.vision);
    return !!(global.MemoAiKey && global.MemoAiKey.supportsVision(active.provider, active.model));
  }

  async function write(col, type, id, doc) {
    var q = global.OperationQueue;
    if (type === 'create') doc = Object.assign({}, doc, { deletedAt: null, deletedBy: null });
    if (q && q.addOperation) { await q.addOperation(type, id, type === 'delete' ? {} : { data: doc }, { variant: col }); return; }
    var s = sdb();
    if (!s) return;
    var all = s.loadDocs(col) || [], now = new Date().toISOString(), i = all.findIndex(function (d) { return d.id === id; });
    if (type === 'delete') { if (i >= 0) all[i] = Object.assign({}, all[i], { deletedAt: now }); }
    else if (i >= 0) all[i] = Object.assign({}, all[i], doc, { updatedAt: now });
    else all.push(Object.assign({ createdAt: now }, doc, { id: id, updatedAt: now }));
    s.saveDocs(col, all);
  }
  async function upsertContact(doc) {
    var exists = docs(CONTACTS).some(function (d) { return d.id === doc.id; });
    await write(CONTACTS, exists ? 'update' : 'create', doc.id, doc);
  }

  // ── people ──
  function me() {
    return docs(CONTACTS).filter(function (d) { return d.id === ME_ID; })[0] ||
      { id: ME_ID, kind: 'me', name: '', about: '', instructions: '', avatar: null };
  }
  // kind 'agent': an outside agent with an Agent API token. It posts cards
  // into its thread from the server; the person does not chat with it.
  function contacts() {
    return docs(CONTACTS).filter(function (d) { return d.kind === 'contact' || d.kind === 'group' || d.kind === 'agent'; })
      .sort(function (a, b) { return (a.id === ASSISTANT_ID ? -1 : 0) - (b.id === ASSISTANT_ID ? -1 : 0) || String(a.name).localeCompare(String(b.name)); });
  }
  function contact(id) { return contacts().filter(function (c) { return c.id === id; })[0] || null; }
  function colorFor(name) { var h = 0; String(name || '').split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) >>> 0; }); return COLORS[h % COLORS.length]; }
  function avatarHtml(person, size) {
    var cls = 'chat-av' + (size ? ' chat-av-' + size : '');
    if (!person) return '<span class="' + cls + '"></span>';
    if (person.kind === 'group') return '<span class="' + cls + ' chat-av-group">' + icon('users') + '</span>';
    var a = person.avatar || {};
    if (a.image) return '<span class="' + cls + '"><img src="' + esc(a.image) + '" alt=""></span>';
    var letter = (a.letter || String(person.name || (person.kind === 'me' ? t('Me') : '?')).trim().charAt(0) || '?').toUpperCase();
    var color = a.color || colorFor(person.name);
    return '<span class="' + cls + '" style="--av:' + esc(color) + '">' + esc(letter) + '</span>';
  }
  // Assistant appears the first time a key exists; old single-chat history
  // (settings chat_default / chat_finance) becomes its thread, once.
  // One run at a time: concurrent callers wait for the same one. The run
  // starts a microtask later so `ensuring` is set first — its own writes fire
  // sync events that call back in here synchronously.
  var ensuring = null;
  function ensureAssistant() {
    if (!ensuring) ensuring = Promise.resolve().then(ensureAssistantNow).finally(function () { ensuring = null; });
    return ensuring;
  }
  async function ensureAssistantNow() {
    if (!hasKey() || !sdb()) return;
    if (!docs(CONTACTS).some(function (d) { return d.id === ASSISTANT_ID; }) &&
        !(sdb().loadDocs(CONTACTS) || []).some(function (d) { return d.id === ASSISTANT_ID; })) {
      await write(CONTACTS, 'create', ASSISTANT_ID, { id: ASSISTANT_ID, kind: 'contact', name: t('Assistant'), persona: '', keyId: null, model: '',
        canRead: { notes: true, spending: true, plans: true, me: true }, canChange: { notes: true, spending: true, plans: true, me: true },
        avatar: { letter: 'A', color: COLORS[0] } });
    }
    if (sdb().getItem('chats_migrated_v1')) return;
    sdb().setItem('chats_migrated_v1', { at: Date.now() });   // claim first: one pass only
    var moved = 0;
    var variants = ['default', 'finance'];
    for (var v = 0; v < variants.length; v++) {
      var list = sdb().getItem('chat_' + variants[v]);
      if (!Array.isArray(list)) continue;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m || !m.content || (m.role !== 'user' && m.role !== 'assistant')) continue;
        var at = Date.parse(m.ts || '') || Date.now();
        await write(MESSAGES, 'create', 'm_old_' + variants[v] + '_' + (m.id || i), { chatId: ASSISTANT_ID, role: m.role,
          authorId: m.role === 'assistant' ? ASSISTANT_ID : ME_ID, text: String(m.content), at: at, createdAt: new Date(at).toISOString() });
        moved++;
      }
    }
    sdb().setItem('chats_migrated_v1', { at: Date.now(), moved: moved });
  }

  // ── messages ──
  function messagesFor(chatId) {
    return docs(MESSAGES).filter(function (m) { return m.chatId === chatId; }).sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
  }
  function recentChats() {
    var last = {};
    docs(MESSAGES).forEach(function (m) { if (!last[m.chatId] || (m.at || 0) > (last[m.chatId].at || 0)) last[m.chatId] = m; });
    return Object.keys(last).map(function (id) { return { contact: contact(id), last: last[id] }; })
      .filter(function (r) { return r.contact; })
      .sort(function (a, b) { return (b.last.at || 0) - (a.last.at || 0); }).slice(0, RECENT);
  }

  // ── context: what this contact may read, matched to the message ──
  function tokens(text) {
    return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(function (w) { return w.length > 2 && !STOP.has(w); });
  }
  function buildContext(person, text) {
    var D = global.MemoDiscover && global.MemoDiscover.sources;
    if (!D) return { lines: [], refs: [] };
    var can = person.canRead || {};
    var words = tokens(text), pool = [];
    var score = function (hay) { hay = hay.toLowerCase(); return words.reduce(function (n, w) { return n + (hay.indexOf(w) >= 0 ? 1 : 0); }, 0); };
    // The local calendar day (toISOString would give the UTC day: tomorrow, on an evening here).
    var day = function (ms) { if (!ms) return ''; var d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    if (can.notes) D.memos().forEach(function (e) {
      pool.push({ variant: 'default', id: e.id, at: D.entryTime(e), s: score([e.description, e.category, (e.tags || []).join(' ')].join(' ')),
        line: '[Note ' + day(D.entryTime(e)) + (e.category ? ' · ' + e.category : '') + '] ' + String(e.description || '').replace(/\s+/g, ' ').slice(0, 240),
        label: D.firstLine(e.description) });
    });
    if (can.spending) D.finance().forEach(function (e) {
      pool.push({ variant: 'finance', id: e.id, at: D.entryTime(e), s: score([e.description, e.category, (e.items || []).map(function (i) { return i && i.name; }).join(' ')].join(' ')),
        line: '[Spending ' + (e.purchaseDate || day(D.entryTime(e))) + ' · ' + (e.category || '') + ' · ' + D.money(e.total != null ? e.total : e.price) + '] ' + String(e.description || '').slice(0, 160),
        label: D.firstLine(e.description) || e.category });
    });
    if (can.plans) D.plans().forEach(function (d) {
      pool.push({ variant: 'planner', id: d.id, at: D.entryTime(d), s: score([d.title, d.notes].join(' ')),
        line: '[Plan ' + (d.kind || '') + (d.date ? ' ' + d.date : '') + (d.start ? ' ' + d.start : '') + (d.kind === 'todo' ? (d.done ? ' done' : ' open') : '') + '] ' + String(d.title || '').slice(0, 160),
        label: d.title });
    });
    var matched = pool.filter(function (p) { return p.s > 0; }).sort(function (a, b) { return b.s - a.s || b.at - a.at; }).slice(0, CONTEXT_ITEMS);
    // Nothing matched: give the newest few so "what did I do lately" works.
    var lines = (matched.length ? matched : pool.sort(function (a, b) { return b.at - a.at; }).slice(0, 6)).map(function (p) { return p.line; });
    if (can.spending) {
      var m = D.thisMonth();
      if (m.any) lines.push('[Spending this month] total ' + D.money(m.total) + (m.top ? ', top category ' + m.top + ' ' + D.money(m.topAmount) : ''));
    }
    var refs = matched.filter(function (p) { return p.s >= Math.min(2, words.length); }).slice(0, 2).map(function (p) { return { variant: p.variant, id: p.id, label: String(p.label || '').slice(0, 60) }; });
    return { lines: lines, refs: refs };
  }
  // extra: { tools, canPropose, proposers: [names], photo } for this reply.
  function systemPrompt(person, group, context, extra) {
    extra = extra || {};
    var who = me(), now = new Date(), T = global.MemoAiTools;
    var p = T ? T.perms(person) : { read: { me: true }, change: {} };
    var parts = ['You are ' + (person.name || 'Assistant') + ', an AI contact inside Memora, the person\'s private app for notes, spending and plans. ' +
      'Today is ' + now.toDateString() + '. Answer from their records when they are relevant. Never invent notes, amounts, dates or events; ' +
      'if the records do not say, say so. You never see their Vault (passwords and keys). Keep replies short and natural unless asked for more.'];
    if (who.name) parts.push('The person\'s name is ' + who.name + '.');
    if (p.read.me && who.about) parts.push('About them, in their words: ' + String(who.about).slice(0, 1500));
    if (p.read.me && who.instructions) parts.push('Their instructions for every AI contact: ' + String(who.instructions).slice(0, 1500));
    if (person.persona) parts.push('Your own personality and role: ' + String(person.persona).slice(0, 2000));
    if (group) parts.push('This is a group chat named "' + group.name + '" with ' + groupMembers(group).map(function (m) { return m.name; }).join(', ') +
      '. Messages from others start with their name. Reply only as yourself, briefly, and do not write lines for the others.');
    if (extra.tools) {
      var pad = function (n) { return String(n).padStart(2, '0'); };
      parts.push('It is ' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) +
        ' local time. You have tools to search and read their records (only what you were allowed). Look things up instead of guessing, in a few tool calls at most.');
      if (extra.canPropose) {
        parts.push('To change anything (add, edit, organise, move to the Bin, set a reminder, remember a fact) call a propose_ tool. Each shows the person a card ' +
          'they tap; nothing changes until they do, so never say it is done — say in a few words what the card does. Use ids only from tool results.');
        var cats = [];
        if (p.change.notes) cats.push('Note categories in use: ' + (T.categories('notes').join(', ') || 'none yet') + '.');
        if (p.change.spending) cats.push('Spending categories in use: ' + (T.categories('spending').join(', ') || 'none yet') + '.');
        if (cats.length) parts.push(cats.join(' '));
      } else if (extra.proposers && extra.proposers.length) {
        parts.push('Only ' + extra.proposers.join(', ') + ' can make changes in this chat this time; you only talk.');
      } else parts.push('You cannot change anything; you can only look and answer.');
      if (extra.photo) parts.push('The person attached a photo to their last message. To keep it, propose the fitting item with use_photo true.');
    }
    parts.push(context.lines.length ? 'Their records that may be relevant:\n' + context.lines.join('\n') : 'No records were shared for this message.');
    return parts.join('\n\n');
  }
  function groupMembers(group) { return (group.members || []).map(contact).filter(function (c) { return c && c.kind === 'contact'; }).slice(0, MAX_GROUP); }
  function named(members, text) {
    var lower = String(text).toLowerCase();
    return members.filter(function (m) { return lower.indexOf('@' + String(m.name).toLowerCase()) >= 0; });
  }
  function responders(chat, text) {
    if (chat.kind !== 'group') return [chat];
    var members = groupMembers(chat), picked = named(members, text);
    return picked.length ? picked : members;
  }
  // Who may propose changes: the contact you talk to; in a group, the ones
  // you @mention, or else the first member allowed to change anything.
  function proposers(chat, text, people) {
    if (chat.kind !== 'group') return people.map(function (p) { return p.id; });
    var picked = named(people, text);
    if (picked.length) return picked.map(function (p) { return p.id; });
    var T = global.MemoAiTools;
    var first = people.filter(function (p) { var c = T ? T.perms(p).change : {}; return c.notes || c.spending || c.plans || c.me; })[0];
    return first ? [first.id] : [];
  }
  var STATUS_WORDS = { pending: 'waiting for a tap', done: 'applied', cancelled: 'cancelled', undone: 'undone' };
  // The thread as one contact sees it: its own lines are "assistant",
  // everyone else's (the person, other contacts) are "user". Cards and their
  // outcome ride along, so the contact knows what was applied.
  function turnsFor(person, chat, thread) {
    var group = chat.kind === 'group';
    return thread.slice(-HISTORY).map(function (m) {
      var text = String(m.text || '');
      if (m.actions && m.actions.length) text += (text ? '\n' : '') + '[Cards: ' + m.actions.map(function (a) { return cardTitle(a) + ' — ' + (STATUS_WORDS[a.status] || a.status); }).join('; ') + ']';
      if (m.image) text = '[photo] ' + text;
      if (m.role === 'assistant' && m.authorId === person.id) return { role: 'assistant', content: text };
      if (m.role === 'assistant') { var other = contact(m.authorId); return { role: 'user', content: (other ? other.name : 'Someone') + ': ' + text }; }
      return { role: 'user', content: group ? (me().name || 'Me') + ': ' + text : text };
    });
  }

  // ── photos ──
  function scaled(file, max, quality) {
    return createImageBitmap(file).then(function (bitmap) {
      var k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * k)); canvas.height = Math.max(1, Math.round(bitmap.height * k));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      return canvas.toDataURL('image/jpeg', quality);
    });
  }
  // A small copy rides in the message (it syncs); the AI gets a mid-size
  // copy; the original goes to this device's file store so a tapped card can
  // keep it with the new item.
  async function preparePhoto(file, messageId) {
    var shot = { thumb: await scaled(file, 360, 0.72), ai: await scaled(file, 1600, 0.85), rel: null };
    var s = sdb();
    if (s && s.writeBlob) {
      var d = new Date(), pad = function (n) { return String(n).padStart(2, '0'); };
      var ext = (/\.(jpe?g|png|webp|gif|heic)$/i.exec(file.name || '') || [null, 'jpg'])[1].toLowerCase();
      var rel = 'uploads/' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '/chat_' + messageId.replace(/[^a-z0-9_]/gi, '') + '.' + ext;
      try { await s.writeBlob(rel, file); shot.rel = rel; } catch (_e) { /* the card then adds the item without the photo */ }
    }
    return shot;
  }
  async function photoText(shot) {
    if (shot.ocr != null) return shot.ocr;
    shot.ocr = '';
    var O = global.MemoOcrNative;
    if (O && O.available && O.available()) { try { shot.ocr = String(((await O.recognize(shot.ai)) || {}).text || '').trim(); } catch (_e) {} }
    return shot.ocr;
  }

  async function replyAs(person, chat, text, shot, mayPropose, proposerNames) {
    var active = activeFor(person);
    if (!active) throw new Error(t('Add an AI key in the Vault first.'));
    var T = global.MemoAiTools;
    var context = buildContext(person, text);
    var ctx = T ? T.context(person, { canPropose: mayPropose, photoRel: shot && shot.rel }) : null;
    var tools = ctx ? T.specs(ctx) : [];
    var turns = turnsFor(person, chat, messagesFor(chat.id));
    var images = [];
    if (shot) {
      if (seesPhotos(active)) images = [shot.ai];
      else {
        var read = await photoText(shot);
        var last = turns[turns.length - 1];
        if (last) last.content += read ? '\n\n[Text read from the photo on this device]\n' + read.slice(0, 6000) : '\n\n[A photo is attached, but this AI cannot see photos.]';
      }
    }
    var system = systemPrompt(person, chat.kind === 'group' ? chat : null, context,
      { tools: tools.length, canPropose: mayPropose, proposers: proposerNames, photo: !!shot });
    var exec = function (name, args) { return T.exec(ctx, name, args); };
    var out;
    try {
      out = await global.MemoAiClient.runTools(active, system, turns, { tools: tools, exec: exec, images: images, maxSteps: MAX_STEPS });
    } catch (error) {
      // Some self-hosted models cannot call tools at all: answer without them.
      if (!tools.length || !/tool|function/i.test(String(error && error.message)) || !(active.provider === 'custom' || active.provider === SERVER_KEY)) throw error;
      ctx.actions = []; ctx.trace = [];
      out = await global.MemoAiClient.runTools(active, system, turns, { tools: [], images: images });
    }
    return { text: out.text || (ctx && ctx.actions.length ? '' : t('(No response)')), refs: context.refs,
      actions: ctx ? ctx.actions : [], trace: ctx ? ctx.trace.slice(0, 6) : [] };
  }

  async function send(chatId, text, photo) {
    text = String(text || '').trim();
    var chat = contact(chatId);
    if ((!text && !photo) || !chat || ui.sending || chat.kind === 'agent') return;
    if (!hasKey()) { toast(t('Add an AI key in the Vault first.'), 'error'); return; }
    ui.sending = true; ui.error = '';
    var at = Date.now(), userId = newId('m'), shot = null;
    var doc = { chatId: chatId, role: 'user', authorId: ME_ID, text: text.slice(0, 8000), at: at, createdAt: new Date(at).toISOString() };
    try {
      if (photo) {
        try { shot = await preparePhoto(photo, userId); }
        catch (_e) { throw new Error(t('Could not read that photo.')); }
        doc.image = shot.thumb;
        if (shot.rel) doc.photoRel = shot.rel;
      }
      await write(MESSAGES, 'create', userId, doc);
      renderChat();
      var people = responders(chat, text), allowed = proposers(chat, text, people);
      var allowedNames = allowed.map(function (id) { var c = contact(id); return c ? c.name : ''; }).filter(Boolean);
      for (var i = 0; i < people.length; i++) {
        var person = people[i];
        ui.typing = [person.id]; renderChat();
        var reply = await replyAs(person, chat, text, shot, allowed.indexOf(person.id) >= 0, allowedNames);
        var when = Date.now();
        var out = { chatId: chatId, role: 'assistant', authorId: person.id, text: String(reply.text || '').slice(0, 12000),
          refs: reply.refs, at: when, createdAt: new Date(when).toISOString() };
        if (reply.actions.length) out.actions = reply.actions;
        if (reply.trace.length) out.trace = reply.trace;
        await write(MESSAGES, 'create', newId('m'), out);
        renderChat();
      }
    } catch (error) {
      ui.error = error && error.message ? error.message : String(error);
    } finally {
      ui.sending = false; ui.typing = [];
      renderChat();
    }
  }

  // ── cards ──
  function pageTag(a) { return a.type === 'memory' ? t('All contacts') : global.MemoAiTools ? global.MemoAiTools.pageLabel(a.page) : a.page; }
  function cardTitle(a) {
    var n = (a.items || a.ids || []).length;
    if (a.type === 'reminder') return t('Reminder');
    if (a.type === 'memory') return t('Add to your Me page');
    if (a.type === 'delete') return t('Move to Bin');
    if (a.type === 'update') return a.summary || t('Change {n} items', { n: n });
    if (a.page === 'notes') return t('New note');
    if (a.page === 'spending') return a.photoRel ? t('Add purchase from photo') : t('Add purchase');
    var first = (a.items || [])[0] || {};
    if (first.kind === 'event') return t('New event');
    return n > 1 ? t('Add {n} to-dos', { n: n }) : t('Add to-do');
  }
  function cardIcon(a) {
    return a.type === 'reminder' ? 'timer' : a.type === 'delete' ? 'trash' : a.type === 'memory' ? 'user' : a.type === 'update' ? 'edit'
      : a.page === 'spending' ? 'cash' : a.page === 'plans' ? 'calendar' : 'book';
  }
  function fmtDay(day) {
    var p = String(day || '').split('-').map(Number);
    if (p.length !== 3 || !p[0]) return String(day || '');
    try { return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(locale(), { weekday: 'short', month: 'short', day: 'numeric' }); } catch (_e) { return day; }
  }
  function fmtTime(hm) {
    var p = String(hm || '').split(':').map(Number);
    try { return new Date(2000, 0, 1, p[0] || 0, p[1] || 0).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }); } catch (_e) { return hm; }
  }
  function money(n) { return global.MemoDiscover && global.MemoDiscover.sources ? global.MemoDiscover.sources.money(n) : '$' + (Number(n) || 0).toFixed(2); }
  function remindersOnPhone() { return !!(global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.PlannerReminders); }
  function whenText(ev) { return fmtDay(ev.date) + ' · ' + (ev.allDay ? t('All day') : fmtTime(ev.start)); }
  function alertText(ev) {
    if (ev.remindAtStart) return remindersOnPhone() ? t('Notification on this phone') : t('At the time (alerts need the Android app)');
    return ev.remindBefore > 0 ? t('{n} min before', { n: ev.remindBefore }) : t('None');
  }
  function row(k, v) { return '<div class="act-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
  function tick(key, pick, text) {
    var off = (ui.unticked[key] || []).indexOf(pick) >= 0;
    return '<button type="button" class="act-item" data-act="card-tick" data-pick="' + esc(pick) + '" aria-pressed="' + (!off) + '">' +
      '<span class="act-box' + (off ? ' off' : '') + '">' + icon('check') + '</span><span>' + esc(text) + '</span></button>';
  }
  function changeText(c) {
    var out = [];
    if (c.addTags) out.push(t('Add tag {tags}', { tags: c.addTags.map(function (x) { return '#' + x; }).join(' ') }));
    if (c.removeTags) out.push(t('Remove tag {tags}', { tags: c.removeTags.map(function (x) { return '#' + x; }).join(' ') }));
    if (c.category) out.push(t('Category: {name}', { name: c.category }));
    if (typeof c.done === 'boolean') out.push(c.done ? t('Mark done') : t('Mark not done'));
    if (c.text) out.push(t('New text: “{text}”', { text: String(c.text).slice(0, 120) }));
    if (c.total != null) out.push(t('New amount {amount}', { amount: money(c.total) }));
    if (c.date) out.push(t('New date {date}', { date: fmtDay(c.date) }));
    return out.join(' · ');
  }
  function cardBody(m, a, key) {
    var T = global.MemoAiTools, items = a.items || [], html = '';
    if (a.type === 'memory') return '<p class="act-quote">“' + esc(a.fact) + '”</p><p class="act-note">' + esc(t('Every AI contact will know this.')) + '</p>';
    if (a.type === 'update' || a.type === 'delete') {
      if (a.type === 'update') html += '<p class="act-note act-change">' + esc(changeText(a.change || {})) + '</p>';
      if (a.ids.length === 1) html += row(t('Item'), esc(T.label(a.page, T.find(a.page, a.ids[0]))));
      else html += '<div class="act-items">' + a.ids.map(function (id) { return tick(key, id, T.label(a.page, T.find(a.page, id))); }).join('') + '</div>';
      if (a.reason) html += '<p class="act-note">' + esc(a.reason) + '</p>';
      return html;
    }
    if (a.page === 'plans' && (items.length > 1 || (items[0] && items[0].kind === 'todo'))) {
      return '<div class="act-items">' + items.map(function (x, i) { return tick(key, String(i), x.title + (x.due ? ' · ' + fmtDay(x.due) : '')); }).join('') + '</div>';
    }
    var x = items[0] || {};
    if (a.page === 'plans') return row(t('What'), esc(x.title)) + row(t('When'), esc(whenText(x))) + row(t('Alert'), esc(alertText(x)));
    if (a.page === 'spending') {
      html += row(t('What'), esc(x.description)) + row(t('Amount'), esc(money(x.total) + ' · ' + (x.category || ''))) + row(t('Date'), esc(fmtDay(x.purchaseDate)));
      if (x.items && x.items.length) html += row(t('Items'), x.items.slice(0, 8).map(function (i) { return esc(i.name) + ' <span class="muted">' + esc(money(i.totalPrice)) + '</span>'; }).join('<br>') +
        (x.items.length > 8 ? '<br><span class="muted">' + esc(t('and {n} more', { n: x.items.length - 8 })) + '</span>' : '') + (x.tax ? '<br>' + esc(t('Tax')) + ' <span class="muted">' + esc(money(x.tax)) + '</span>' : ''));
    } else {
      html += row(t('What'), esc(String(x.description || '').slice(0, 400)).replace(/\n/g, '<br>'));
      if (x.category && x.category !== 'Uncategorized') html += row(t('Category'), esc(x.category));
      if (x.tags && x.tags.length) html += row(t('Tags'), esc(x.tags.map(function (g) { return '#' + g; }).join(' ')));
    }
    if (a.photoRel) html += '<p class="act-note">' + icon('image') + ' ' + esc(t('Photo kept with the item')) + '</p>';
    return html;
  }
  function cardForm(a) {
    var x = (a.items || [])[0] || {};
    var field = function (name, labelText, value, type) {
      return '<label class="act-field"><span>' + esc(labelText) + '</span><input name="' + name + '" type="' + (type || 'text') + '" value="' + esc(value == null ? '' : value) + '"' + (type === 'number' ? ' step="0.01" inputmode="decimal"' : '') + '></label>';
    };
    if (a.type === 'memory') return '<label class="act-field"><span>' + esc(t('Fact')) + '</span><textarea name="fact" rows="2">' + esc(a.fact) + '</textarea></label>';
    if (a.page === 'plans' && (a.items.length > 1 || x.kind === 'todo')) return a.items.map(function (it, i) { return field('title' + i, t('To-do'), it.title); }).join('');
    if (a.page === 'plans') return field('title', t('What'), x.title) + field('date', t('Date'), x.date, 'date') + (x.allDay ? '' : field('start', t('Time'), x.start, 'time'));
    if (a.page === 'spending') return field('description', t('What'), x.description) + field('total', t('Amount'), x.total, 'number') +
      field('category', t('Category'), x.category) + field('purchaseDate', t('Date'), x.purchaseDate, 'date');
    return '<label class="act-field"><span>' + esc(t('Note')) + '</span><textarea name="description" rows="3">' + esc(x.description) + '</textarea></label>' +
      field('category', t('Category'), x.category) + field('tags', t('Tags'), (x.tags || []).join(', '));
  }
  function readCardForm(card, a) {
    var get = function (n) { var el = card.querySelector('[name="' + n + '"]'); return el ? String(el.value || '').trim() : null; };
    if (a.type === 'memory') return { fact: get('fact') || a.fact };
    var items = JSON.parse(JSON.stringify(a.items || []));
    var x = items[0] || {};
    if (a.page === 'plans' && (items.length > 1 || x.kind === 'todo')) items.forEach(function (it, i) { it.title = get('title' + i) || it.title; });
    else if (a.page === 'plans') {
      x.title = get('title') || x.title;
      if (/^\d{4}-\d{2}-\d{2}$/.test(get('date') || '')) x.date = get('date');
      if (/^\d{2}:\d{2}/.test(get('start') || '')) {
        var old = x.start; x.start = get('start').slice(0, 5);
        var mins = function (hm) { return parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10); };
        var len = Math.max(15, mins(x.end || old) - mins(old)), end = Math.min(mins(x.start) + len, 23 * 60 + 59);
        x.end = String(Math.floor(end / 60)).padStart(2, '0') + ':' + String(end % 60).padStart(2, '0');
      }
    } else if (a.page === 'spending') {
      x.description = get('description') || x.description;
      var total = parseFloat(get('total'));
      if (!isNaN(total)) x.total = Math.round(total * 100) / 100;
      x.category = get('category') || x.category;
      if (/^\d{4}-\d{2}-\d{2}$/.test(get('purchaseDate') || '')) x.purchaseDate = get('purchaseDate');
    } else {
      x.description = get('description') || x.description;
      x.category = get('category') || 'Uncategorized';
      x.tags = String(get('tags') || '').split(',').map(function (g) { return g.replace(/^#/, '').trim(); }).filter(Boolean);
    }
    return { items: items };
  }
  function pickCount(a, key) {
    if (a.type === 'memory') return 1;
    var off = ui.unticked[key] || [];
    var all = a.type === 'update' || a.type === 'delete' ? a.ids : (a.items || []).map(function (_x, i) { return String(i); });
    return all.filter(function (p) { return off.indexOf(p) < 0; }).length;
  }
  function doneText(a) {
    var n = (a.undo || []).length, x = (a.items || [])[0] || {};
    if (a.type === 'reminder') return t('Set') + ' · ' + whenText(x) + ' · ' + x.title;
    if (a.type === 'memory') return t('Added to your Me page');
    if ((a.type === 'delete' || a.type === 'update') && !n) return t('Nothing to change: those items are gone');
    if (a.type === 'delete') return t('Moved {n} to the Bin', { n: n });
    if (a.type === 'update') return t('Changed {n}', { n: n });
    if (n > 1) return t('Added {n}', { n: n });
    return t('Added') + ' · ' + String(a.page === 'plans' ? x.title : String(x.description || '').split('\n')[0]).slice(0, 60);
  }
  function cardHtml(m, a) {
    var key = m.id + ':' + a.id, open = a.status === 'pending';
    var html = '<div class="act act-is-' + esc(a.status) + '" data-msg="' + esc(m.id) + '" data-card="' + esc(a.id) + '">' +
      '<div class="act-head">' + icon(cardIcon(a)) + '<span class="act-title">' + esc(cardTitle(a)) + '</span><span class="act-tag">' + esc(pageTag(a)) + '</span></div>';
    if (!open) {
      var first = (a.undo || [])[0];
      var openable = a.status === 'done' && first && first.variant !== 'contacts' && a.type !== 'delete';
      html += '<div class="act-done">' + (a.status === 'done' ? icon('check') : '') +
        (openable ? '<button type="button" class="act-open" data-act="ref" data-variant="' + esc(first.variant) + '" data-id="' + esc(first.id) + '">' + esc(doneText(a)) + '</button>'
          : '<span>' + esc(a.status === 'done' ? doneText(a) : a.status === 'undone' ? t('Undone') : t('Cancelled')) + '</span>') +
        (a.status === 'done' && a.undo && a.undo.length ? '<button type="button" class="act-undo" data-act="card-undo">' + esc(t('Undo')) + '</button>' : '') + '</div>';
      return html + '</div>';
    }
    if (ui.editing === key) {
      return html + '<div class="act-body act-form">' + cardForm(a) + '</div><div class="act-foot">' +
        '<button type="button" class="primary" data-act="card-save">' + esc(t('Save')) + '</button><button type="button" class="ghost" data-act="card-unedit">' + esc(t('Cancel')) + '</button></div></div>';
    }
    var n = pickCount(a, key), many = (a.items || a.ids || []).length > 1;
    var go = a.type === 'reminder' ? t('Set reminder') : a.type === 'memory' ? t('Add to Me') : a.type === 'delete' ? (many ? t('Move {n} to Bin', { n: n }) : t('Move to Bin'))
      : a.type === 'update' ? t('Apply to {n}', { n: n }) : many ? t('Add {n}', { n: n }) : t('Add');
    var editable = a.type === 'create' || a.type === 'reminder' || a.type === 'memory';
    return html + '<div class="act-body">' + cardBody(m, a, key) + '</div><div class="act-foot">' +
      '<button type="button" class="primary' + (a.type === 'delete' ? ' act-danger' : '') + '" data-act="card-apply"' + (n ? '' : ' disabled') + '>' + esc(go) + '</button>' +
      (editable ? '<button type="button" class="ghost" data-act="card-edit">' + esc(t('Edit')) + '</button>' : '') +
      '<button type="button" class="ghost" data-act="card-cancel">' + esc(t('Cancel')) + '</button></div></div>';
  }
  function findCard(card) {
    var m = docs(MESSAGES).filter(function (x) { return x.id === card.dataset.msg; })[0];
    var a = m && (m.actions || []).filter(function (x) { return x.id === card.dataset.card; })[0];
    return a ? { m: m, a: a, key: m.id + ':' + a.id } : null;
  }
  async function saveCard(m, id, patch) {
    var actions = (m.actions || []).map(function (x) { return x.id === id ? Object.assign({}, x, patch) : x; });
    await write(MESSAGES, 'update', m.id, { actions: actions });
  }
  // Reminders alert only with notifications allowed; ask once, on the tap.
  async function ensureAlerts(a) {
    var ev = (a.items || []).filter(function (x) { return x.kind === 'event' && (x.remindAtStart || x.remindBefore > 0); });
    var plugin = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.PlannerReminders;
    if (!ev.length || !plugin) return;
    try { var s = await plugin.status(); if (!s || !s.enabled) await plugin.enable(); } catch (_e) {}
    if (global.MemoPlannerReminders) global.MemoPlannerReminders.reconcile(true);
  }
  async function onCard(act, el) {
    var card = el.closest('.act');
    if (!card) return;
    // A tap while the last one is still being written (Save, then Set at
    // once) waits for it instead of being dropped; the card is read afresh.
    while (ui.cardBusy) { try { await ui.cardBusy; } catch (_e) {} }
    var hit = findCard(card);
    if (!hit) return;
    var a = hit.a, key = hit.key;
    if (act === 'card-tick') {
      var off = (ui.unticked[key] || []).slice(), i = off.indexOf(el.dataset.pick);
      if (i >= 0) off.splice(i, 1); else off.push(el.dataset.pick);
      ui.unticked[key] = off; renderChat(); return;
    }
    if (act === 'card-edit') { ui.editing = key; renderChat(); var f = ui.chat.querySelector('.act-form input, .act-form textarea'); if (f) f.focus(); return; }
    if (act === 'card-unedit') { ui.editing = null; renderChat(); return; }
    var release;
    ui.cardBusy = new Promise(function (r) { release = r; });
    try {
      if (act === 'card-save') { var patch = readCardForm(card, a); ui.editing = null; await saveCard(hit.m, a.id, patch); }
      else if (act === 'card-cancel' && a.status === 'pending') await saveCard(hit.m, a.id, { status: 'cancelled' });
      else if (act === 'card-apply' && a.status === 'pending') {
        var skip = ui.unticked[key] || [];
        if (a.type === 'create' || a.type === 'reminder') skip = skip.map(Number);
        var undo = await global.MemoAiTools.apply(a, { skip: skip, key: hit.m.id + '_' + a.id });
        await saveCard(hit.m, a.id, { status: 'done', undo: undo, doneAt: Date.now() });
        delete ui.unticked[key];
        if (global.MemoNativeUi && global.MemoNativeUi.haptic) global.MemoNativeUi.haptic(a.type === 'delete' ? 'destructiveSuccess' : 'selection');
        ensureAlerts(a);
        if (a.type === 'memory') renderMenuProfile();
      } else if (act === 'card-undo' && a.status === 'done') {
        await global.MemoAiTools.revert(a.undo);
        await saveCard(hit.m, a.id, { status: 'undone' });
        if (a.type === 'memory') renderMenuProfile();
      }
    } catch (error) {
      toast((error && error.message) || String(error), 'error');
    } finally {
      ui.cardBusy = null;
      release();
      renderChat();
    }
  }

  // ── chat screen ──
  function sheet(id, cls) {
    var dlg = document.createElement('dialog');
    dlg.id = id; dlg.className = 'chat-screen ' + (cls || '');
    document.body.appendChild(dlg);
    return dlg;
  }
  function keyLabel(person) {
    if (person.kind === 'agent') return t('Outside agent');
    var active = activeFor(person);
    if (active && active.provider === SERVER_KEY) return t('Your server’s AI');
    var key = global.MemoAiKey && global.MemoAiKey.getActiveKey(person.keyId || undefined);
    if (!key) return t('No AI key');
    var P = global.MemoVault && global.MemoVault.PROVIDERS;
    return ((P && P[key.provider] && P[key.provider].label) || key.provider) + ' · ' + (person.model || key.model || '');
  }
  function openChat(chatId) {
    var chat = contact(chatId);
    if (!chat) return;
    if (!ui.chat || !document.body.contains(ui.chat)) {
      ui.chat = sheet('chatScreen', 'chat-thread');
      ui.chat.addEventListener('click', onChatClick);
      ui.chat.addEventListener('keydown', function (e) {
        if (e.target.classList.contains('chat-input') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitComposer(); }
      });
      ui.chat.addEventListener('input', function (e) { if (e.target.classList.contains('chat-input')) grow(e.target); });
      ui.chat.addEventListener('change', function (e) {
        if (!e.target.classList.contains('chat-attach-input') || !e.target.files || !e.target.files[0]) return;
        setPhoto(e.target.files[0]);
        e.target.value = '';
      });
      ui.chat.addEventListener('close', function () { setPhoto(null); ui.editing = null; });
    }
    if (ui.chatId !== chatId) setPhoto(null);
    ui.chatId = chatId; ui.error = '';
    ui.chat.innerHTML = '<div class="chat-head"><button type="button" class="chat-back" data-act="close" aria-label="' + esc(t('Back')) + '">' + icon('chevron-left') + '</button>' +
      '<span class="chat-head-who"></span><button type="button" class="chat-head-more" data-act="edit" aria-label="' + esc(t('Edit contact')) + '">' + icon('more') + '</button></div>' +
      '<div class="chat-msgs" role="log" aria-live="polite"></div>' +
      '<div class="chat-mentions"></div><div class="chat-photo-chip" hidden></div>' +
      '<div class="chat-compose"><label class="chat-attach" aria-label="' + esc(t('Add a photo')) + '" title="' + esc(t('Add a photo')) + '">' + icon('image') +
      '<input type="file" accept="image/*" class="chat-attach-input" hidden></label><textarea class="chat-input" rows="1" placeholder="' + esc(chat.kind === 'group' ? t('Message the group · @ to pick') : t('Message {name}', { name: chat.name })) + '"></textarea>' +
      '<button type="button" class="chat-send" data-act="send" aria-label="' + esc(t('Send')) + '">' + icon('send') + '</button></div>';
    if (chat.kind === 'agent') {
      ui.chat.querySelector('.chat-compose').outerHTML = '<p class="chat-agent-note">' + icon('info') + '<span>' +
        esc(t('{name} is an outside agent. It sends changes here as cards; nothing changes until you tap one.', { name: chat.name })) + '</span></p>';
    }
    if (!ui.chat.open) ui.chat.showModal();
    renderChat(true);
  }
  // Highlight "@Name" for the group's members (names may have spaces).
  function mentionHtml(html, names) {
    if (!names.length) return html;
    var alts = names.slice().sort(function (a, b) { return b.length - a.length; })
      .map(function (n) { return esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    return html.replace(new RegExp('@(' + alts.join('|') + ')', 'gi'), '<span class="chat-mention">@$1</span>');
  }
  function grow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; }
  function renderChat(jump) {
    if (!ui.chat || !ui.chat.open) return;
    var chat = contact(ui.chatId);
    if (!chat) { ui.chat.close(); return; }
    ui.chat.querySelector('.chat-head-who').innerHTML = avatarHtml(chat, 'sm') + '<span><strong>' + esc(chat.name) + '</strong><small>' +
      esc(chat.kind === 'group' ? groupMembers(chat).map(function (m) { return m.name; }).join(', ') : keyLabel(chat)) + '</small></span>';
    var box = ui.chat.querySelector('.chat-msgs');
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    var thread = messagesFor(ui.chatId), self = me();
    var names = chat.kind === 'group' ? groupMembers(chat).map(function (c) { return c.name; }) : [];
    var html = thread.length ? '' : '<p class="chat-empty">' + esc(chat.kind === 'group' ? t('Say hello to the group.') : t('Ask {name} anything about your notes, spending or plans.', { name: chat.name })) + '</p>';
    thread.forEach(function (m) {
      var mine = m.role === 'user';
      var who = mine ? self : contact(m.authorId);
      var cards = (m.actions || []).map(function (a) { return cardHtml(m, a); }).join('');
      var bubble = m.text || (!cards && !m.image) ? '<div class="chat-bubble">' + mentionHtml(esc(m.text).replace(/\n/g, '<br>'), names) +
        (m.refs && m.refs.length ? m.refs.map(function (r) {
          return '<button type="button" class="chat-ref" data-act="ref" data-variant="' + esc(r.variant) + '" data-id="' + esc(r.id) + '">' +
            icon(r.variant === 'finance' ? 'cash' : r.variant === 'planner' ? 'calendar' : 'book') + '<span>' + esc(r.label) + '</span></button>';
        }).join('') : '') + '</div>' : '';
      html += '<div class="chat-msg' + (mine ? ' mine' : '') + '">' + avatarHtml(who, 'xs') + '<div class="chat-bubble-wrap' + (cards ? ' has-cards' : '') + '">' +
        (!mine && chat.kind === 'group' ? '<span class="chat-who">' + esc(who ? who.name : '') + '</span>' : '') +
        (m.image ? '<img class="chat-photo" src="' + esc(m.image) + '" alt="' + esc(t('Photo')) + '">' : '') + bubble + cards +
        (m.trace && m.trace.length ? '<div class="chat-trace">' + icon('search') + '<span>' + esc(m.trace.join(' · ')) + '</span></div>' : '') + '</div></div>';
    });
    ui.typing.forEach(function (id) { var c = contact(id); if (c) html += '<div class="chat-typing">' + avatarHtml(c, 'xs') + esc(t('{name} is replying…', { name: c.name })) + '</div>'; });
    if (ui.error) html += '<div class="chat-error" role="alert">' + esc(ui.error) + '</div>';
    // A sync can re-render while a card is being edited: keep what was typed.
    var typed = {}, focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.name : null;
    box.querySelectorAll('.act-form [name]').forEach(function (f) { typed[f.name] = f.value; });
    box.innerHTML = html;
    box.querySelectorAll('.act-form [name]').forEach(function (f) { if (typed[f.name] != null) f.value = typed[f.name]; if (f.name === focused) f.focus(); });
    if (jump || near) box.scrollTop = box.scrollHeight;
    var mentions = ui.chat.querySelector('.chat-mentions');
    mentions.innerHTML = chat.kind === 'group' ? groupMembers(chat).map(function (m) { return '<button type="button" data-act="mention" data-name="' + esc(m.name) + '">@' + esc(m.name) + '</button>'; }).join('') : '';
    var sendBtn = ui.chat.querySelector('.chat-send');   // none in an outside agent's thread
    if (sendBtn) sendBtn.disabled = ui.sending;
  }
  function setPhoto(file) {
    if (ui.photo && ui.photo.url) URL.revokeObjectURL(ui.photo.url);
    ui.photo = file ? { file: file, url: URL.createObjectURL(file) } : null;
    var chip = ui.chat && ui.chat.querySelector('.chat-photo-chip');
    if (!chip) return;
    chip.hidden = !ui.photo;
    chip.innerHTML = ui.photo ? '<img src="' + esc(ui.photo.url) + '" alt=""><span>' + esc(t('Photo ready to send')) + '</span>' +
      '<button type="button" data-act="photo-drop" aria-label="' + esc(t('Remove photo')) + '">' + icon('x') + '</button>' : '';
  }
  function submitComposer() {
    var input = ui.chat.querySelector('.chat-input');
    var text = input.value, photo = ui.photo && ui.photo.file;
    if ((!text.trim() && !photo) || ui.sending) return;
    input.value = ''; grow(input);
    setPhoto(null);
    send(ui.chatId, text, photo);
  }
  async function onChatClick(e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act;
    if (act.indexOf('card-') === 0) { await onCard(act, el); return; }
    if (act === 'photo-drop') { setPhoto(null); return; }
    if (act === 'close') ui.chat.close();
    else if (act === 'send') submitComposer();
    else if (act === 'edit') openEditor(ui.chatId);
    else if (act === 'mention') { var input = ui.chat.querySelector('.chat-input'); input.value = (input.value ? input.value.replace(/\s*$/, ' ') : '') + '@' + el.dataset.name + ' '; input.focus(); }
    else if (act === 'ref') {
      ui.chat.close();
      if (global.MemoDiscover) global.MemoDiscover.close();
      var shell = global.MemoSpaShell;
      if (shell && shell.getVariant() !== el.dataset.variant) await shell.switchTo(el.dataset.variant);
      if (el.dataset.variant !== 'planner') setTimeout(function () { if (global.MemoVariant && global.MemoVariant.openDetail) global.MemoVariant.openDetail(el.dataset.id); }, 60);
    }
  }

  // ── contact / group editor ──
  function keyOptions(selected) {
    var keys = global.MemoVault ? global.MemoVault.aiKeyCache() : [];
    var P = (global.MemoVault && global.MemoVault.PROVIDERS) || {};
    return '<option value="">' + esc(keys.length ? t('Default key') : serverAiOn() ? t('Your server’s AI') : t('Default key')) + '</option>' + keys.map(function (k) {
      var p = P[k.provider] || {};
      var sees = global.MemoAiKey ? global.MemoAiKey.supportsVision(k.provider, k.model) : p.vision;
      return '<option value="' + esc(k.id) + '"' + (k.id === selected ? ' selected' : '') + '>' + esc((k.label || p.label || k.provider) + (sees ? '' : ' · ' + t('chat only'))) + '</option>';
    }).join('') + (serverAiOn() && keys.length || selected === SERVER_KEY ? '<option value="' + SERVER_KEY + '"' + (selected === SERVER_KEY ? ' selected' : '') + '>' +
      esc(t('Your server’s AI') + (ui.serverAi && !ui.serverAi.vision ? ' · ' + t('chat only') : '')) + '</option>' : '');
  }
  // What this contact may read and change, page by page. Change needs Read.
  function permGrid(d) {
    var p = global.MemoAiTools ? global.MemoAiTools.perms(d) : { read: d.canRead || {}, change: {} };
    return '<div class="chat-form-label">' + esc(t('What {name} may do', { name: d.name || t('this contact') })) + '</div>' +
      '<div class="perm-grid" role="group"><span class="perm-h"></span><span class="perm-h">' + esc(t('Read')) + '</span><span class="perm-h">' + esc(t('Change')) + '</span>' +
      PERM_ROWS.map(function (r) {
        return '<span class="perm-name">' + esc(t(r[1])) + '</span>' +
          '<label class="perm-c"><input type="checkbox" name="can_' + r[0] + '" aria-label="' + esc(t('Read') + ' · ' + t(r[1])) + '"' + (p.read[r[0]] ? ' checked' : '') + '></label>' +
          '<label class="perm-c"><input type="checkbox" name="change_' + r[0] + '" aria-label="' + esc(t('Change') + ' · ' + t(r[1])) + '"' + (p.change[r[0]] ? ' checked' : '') + (p.read[r[0]] ? '' : ' disabled') + '></label>';
      }).join('') + '</div>' +
      '<p class="muted chat-hint">' + esc(t('Change always shows a card you tap first. Change needs Read. The Vault is never shared with any AI.')) + '</p>';
  }
  function avatarPicker(person) {
    return '<div class="chat-av-pick">' + avatarHtml(person, 'lg') + '<div class="chat-av-buttons">' +
      '<label class="chat-av-photo">' + icon('image') + ' ' + esc(t('Photo')) + '<input type="file" accept="image/*" data-act="photo" hidden></label>' +
      (person.avatar && person.avatar.image ? '<button type="button" class="ghost" data-act="photo-clear">' + esc(t('Use a letter')) + '</button>' : '') +
      '<span class="chat-colors">' + COLORS.map(function (c) { return '<button type="button" data-act="color" data-color="' + c + '" style="--av:' + c + '" aria-label="' + esc(t('Colour')) + '"></button>'; }).join('') + '</span>' +
      '</div></div>';
  }
  function openEditor(id, kind) {
    var existing = id ? contact(id) : null;
    var draft = existing ? JSON.parse(JSON.stringify(existing)) : { id: newId(kind === 'group' ? 'g' : 'c'), kind: kind || 'contact', name: '', persona: '', keyId: null, model: '',
      canRead: { notes: true, spending: true, plans: false, me: true }, canChange: {}, members: [], avatar: { color: COLORS[Math.floor(Math.random() * COLORS.length)] } };
    if (!ui.editor || !document.body.contains(ui.editor)) {
      ui.editor = sheet('chatContactDlg', 'chat-form');
      ui.editor.addEventListener('click', onEditorClick);
      ui.editor.addEventListener('change', onEditorChange);
      ui.editor.addEventListener('submit', onEditorSubmit);
    }
    ui.editor._draft = draft; ui.editor._isNew = !existing;
    renderEditor();
    if (!ui.editor.open) ui.editor.showModal();
  }
  function renderEditor() {
    var d = ui.editor._draft, group = d.kind === 'group';
    if (d.kind === 'agent') return renderAgentEditor(d);
    var html = '<form class="chat-form-body"><div class="chat-head"><button type="button" class="chat-back" data-act="close" aria-label="' + esc(t('Back')) + '">' + icon('chevron-left') + '</button>' +
      '<strong class="chat-form-title">' + esc(ui.editor._isNew ? (group ? t('New group') : t('New contact')) : (group ? t('Edit group') : t('Edit contact'))) + '</strong>' +
      '<button class="primary" type="submit">' + esc(t('Save')) + '</button></div><div class="chat-form-fields">';
    if (!group) html += avatarPicker(d);
    html += '<label class="field"><span>' + esc(t('Name')) + '</span><input type="text" name="name" maxlength="40" required value="' + esc(d.name) + '" placeholder="' + esc(group ? t('House crew') : t('Mei')) + '"></label>';
    if (group) {
      var all = contacts().filter(function (c) { return c.kind === 'contact'; });
      html += '<div class="field"><span>' + esc(t('Members (up to {n})', { n: MAX_GROUP })) + '</span><div class="chat-members">' + all.map(function (c) {
        return '<label class="chat-member"><input type="checkbox" name="member" value="' + esc(c.id) + '"' + ((d.members || []).indexOf(c.id) >= 0 ? ' checked' : '') + '>' + avatarHtml(c, 'xs') + esc(c.name) + '</label>';
      }).join('') + '</div></div>';
    } else {
      html += '<label class="field"><span>' + esc(t('Personality — how this contact talks')) + '</span><textarea name="persona" rows="4" maxlength="2000" placeholder="' + esc(t('A clumsy but devoted maid. Cheerful, apologises a lot, keeps answers short.')) + '">' + esc(d.persona) + '</textarea></label>' +
        '<label class="field"><span>' + esc(t('AI key')) + '</span><select name="keyId">' + keyOptions(d.keyId) + '</select></label>' +
        '<label class="field"><span>' + esc(t('Model (optional)')) + '</span><input type="text" name="model" spellcheck="false" value="' + esc(d.model || '') + '" placeholder="' + esc(t('the key\'s model')) + '"></label>' +
        permGrid(d);
    }
    if (!ui.editor._isNew && d.id !== ASSISTANT_ID) html += '<button type="button" class="ghost danger-text chat-delete" data-act="delete">' + icon('trash') + ' ' + esc(group ? t('Delete group') : t('Delete contact')) + '</button>';
    if (!ui.editor._isNew) html += '<button type="button" class="ghost chat-delete" data-act="clear">' + esc(t('Clear this chat')) + '</button>';
    ui.editor.innerHTML = html + '</div></form>';
  }
  // An outside agent: rename it, clear its thread, or remove it. Its access is
  // its token, managed on the server (memora-server token list / revoke).
  function renderAgentEditor(d) {
    ui.editor.innerHTML = '<form class="chat-form-body"><div class="chat-head"><button type="button" class="chat-back" data-act="close" aria-label="' + esc(t('Back')) + '">' + icon('chevron-left') + '</button>' +
      '<strong class="chat-form-title">' + esc(t('Outside agent')) + '</strong><button class="primary" type="submit">' + esc(t('Save')) + '</button></div><div class="chat-form-fields">' +
      '<label class="field"><span>' + esc(t('Name')) + '</span><input type="text" name="name" maxlength="40" required value="' + esc(d.name) + '"></label>' +
      '<p class="muted chat-hint">' + esc(t('This agent reaches Memora with its own token from your server. To stop it, revoke the token there: memora-server token revoke.')) + '</p>' +
      '<button type="button" class="ghost chat-delete" data-act="clear">' + esc(t('Clear this chat')) + '</button>' +
      '<button type="button" class="ghost danger-text chat-delete" data-act="delete">' + icon('trash') + ' ' + esc(t('Delete contact')) + '</button>' +
      '</div></form>';
  }
  function readForm() {
    var f = new FormData(ui.editor.querySelector('form')), d = ui.editor._draft;
    d.name = String(f.get('name') || '').trim();
    if (d.kind === 'agent') return d;
    if (d.kind === 'group') d.members = f.getAll('member').map(String).slice(0, MAX_GROUP);
    else {
      d.persona = String(f.get('persona') || '');
      d.keyId = String(f.get('keyId') || '') || null;
      d.model = String(f.get('model') || '').trim();
      d.canRead = {}; d.canChange = {};
      PERM_ROWS.forEach(function (r) {
        d.canRead[r[0]] = f.get('can_' + r[0]) === 'on';
        d.canChange[r[0]] = d.canRead[r[0]] && f.get('change_' + r[0]) === 'on';
      });
    }
    return d;
  }
  async function onEditorSubmit(e) {
    e.preventDefault();
    var d = readForm();
    if (!d.name) return;
    if (d.kind === 'group' && d.members.length < 2) { toast(t('Pick at least two members.'), 'error'); return; }
    await upsertContact(d);
    ui.editor.close();
    if (ui.editor._isNew) openChat(d.id); else renderChat();
    refreshDiscover();
  }
  async function onEditorClick(e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act;
    if (act === 'close') ui.editor.close();
    else if (act === 'color') { readForm(); ui.editor._draft.avatar = { color: el.dataset.color }; renderEditor(); }
    else if (act === 'photo-clear') { readForm(); ui.editor._draft.avatar = { color: colorFor(ui.editor._draft.name) }; renderEditor(); }
    else if (act === 'delete' || act === 'clear') {
      var d = ui.editor._draft;
      var ok = !global.MemoShell || await global.MemoShell.confirm(act === 'delete' ? t('Delete {name} and its chat on every device?', { name: d.name }) : t('Clear this chat on every device?'), { okLabel: act === 'delete' ? t('Delete') : t('Clear'), danger: true });
      if (!ok) return;
      var thread = messagesFor(d.id);
      for (var i = 0; i < thread.length; i++) await write(MESSAGES, 'delete', thread[i].id);
      if (act === 'delete') { await write(CONTACTS, 'delete', d.id); if (ui.chat && ui.chat.open) ui.chat.close(); }
      ui.editor.close();
      renderChat(); refreshDiscover();
    }
  }
  async function onEditorChange(e) {
    if (e.target.dataset && e.target.dataset.act === 'photo' && e.target.files && e.target.files[0]) {
      var target = e.currentTarget === ui.me ? ui.me : ui.editor;
      try {
        var image = await shrink(e.target.files[0]);
        if (target === ui.me) { readMeForm(); ui.me._draft.avatar = { image: image }; renderMe(); }
        else { readForm(); ui.editor._draft.avatar = { image: image }; renderEditor(); }
      } catch (_e) { toast(t('Could not read that photo.'), 'error'); }
    }
    if (ui.editor && ui.editor.open && /^can_/.test(e.target.name || '')) {
      var pair = ui.editor.querySelector('input[name="change_' + e.target.name.slice(4) + '"]');
      if (pair) { pair.disabled = !e.target.checked; if (!e.target.checked) pair.checked = false; }
    }
    if (ui.editor && ui.editor.open && e.target.name === 'member') {
      var picked = ui.editor.querySelectorAll('input[name=member]:checked');
      if (picked.length > MAX_GROUP) { e.target.checked = false; toast(t('A group has up to {n} members.', { n: MAX_GROUP })); }
    }
  }
  // A small square JPEG, so the avatar syncs inside its contact document.
  async function shrink(file) {
    var bitmap = await createImageBitmap(file);
    var side = Math.min(bitmap.width, bitmap.height), size = 160;
    var canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    if (bitmap.close) bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  // ── Me ──
  function openMe() {
    if (!ui.me || !document.body.contains(ui.me)) {
      ui.me = sheet('meDlg', 'chat-form');
      ui.me.addEventListener('click', onMeClick);
      ui.me.addEventListener('change', onEditorChange);
      ui.me.addEventListener('submit', async function (e) {
        e.preventDefault();
        await upsertContact(readMeForm());
        ui.me.close();
        renderMenuProfile(); refreshDiscover();
        toast(t('Saved.'));
      });
    }
    if (global.MemoShell && global.MemoShell.menuOpen && global.MemoShell.menuOpen()) global.MemoShell.closeMenu();
    ui.me._draft = JSON.parse(JSON.stringify(me()));
    renderMe();
    if (!ui.me.open) ui.me.showModal();
  }
  function renderMe() {
    var d = ui.me._draft;
    ui.me.innerHTML = '<form class="chat-form-body"><div class="chat-head"><button type="button" class="chat-back" data-act="close" aria-label="' + esc(t('Back')) + '">' + icon('chevron-left') + '</button>' +
      '<strong class="chat-form-title">' + esc(t('Me')) + '</strong><button class="primary" type="submit">' + esc(t('Save')) + '</button></div><div class="chat-form-fields">' +
      avatarPicker(d) +
      '<label class="field"><span>' + esc(t('Name the AI calls you')) + '</span><input type="text" name="name" maxlength="40" value="' + esc(d.name) + '"></label>' +
      '<label class="field"><span>' + esc(t('About me')) + '</span><textarea name="about" rows="4" maxlength="1500" placeholder="' + esc(t('Where you live, what you do, what you like…')) + '">' + esc(d.about) + '</textarea></label>' +
      '<label class="field"><span>' + esc(t('Instructions for every AI contact')) + '</span><textarea name="instructions" rows="3" maxlength="1500" placeholder="' + esc(t('Answer in English unless I write Cantonese. Use metric.')) + '">' + esc(d.instructions) + '</textarea></label>' +
      '<p class="chat-notice">' + icon('info') + '<span>' + esc(t('This page is sent with every chat to the AI provider you picked. Keep secrets in the Vault, never here.')) + '</span></p>' +
      '</div></form>';
  }
  function readMeForm() {
    var f = new FormData(ui.me.querySelector('form')), d = ui.me._draft;
    d.kind = 'me'; d.id = ME_ID;
    d.name = String(f.get('name') || '').trim();
    d.about = String(f.get('about') || '');
    d.instructions = String(f.get('instructions') || '');
    return d;
  }
  function onMeClick(e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'close') ui.me.close();
    else if (el.dataset.act === 'color') { readMeForm(); ui.me._draft.avatar = { color: el.dataset.color }; renderMe(); }
    else if (el.dataset.act === 'photo-clear') { readMeForm(); ui.me._draft.avatar = { color: colorFor(ui.me._draft.name) }; renderMe(); }
  }

  // ── Discover and the menu ──
  function refreshDiscover() { if (global.MemoDiscover && global.MemoDiscover.isOpen()) global.MemoDiscover.render(); }
  function preview(m) { return String(m.text || '').replace(/\s+/g, ' ').slice(0, 80); }
  function relTime(at) {
    var d = new Date(at), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function renderDiscover(slot) {
    loadServerAi();
    if (!hasKey()) { slot.innerHTML = ''; return; }
    ensureAssistant().then(function () { fill(slot); });
    fill(slot);
  }
  function fill(slot) {
    if (!slot.isConnected) return;
    var recent = recentChats(), people = contacts();
    var html = '';
    if (recent.length) {
      html += '<div class="discover-label discover-label-row"><span>' + esc(t('Recent chats')) + '</span></div><div class="chat-list">' + recent.map(function (r) {
        var m = r.last, author = m.role === 'assistant' && r.contact.kind === 'group' ? contact(m.authorId) : null;
        return '<button type="button" class="chat-row" data-chat="' + esc(r.contact.id) + '">' + avatarHtml(r.contact) +
          '<span class="chat-row-text"><span class="chat-row-name">' + esc(r.contact.name) + (r.contact.kind === 'group' ? ' <span class="chat-count">' + groupMembers(r.contact).length + '</span>' : '') + '</span>' +
          '<span class="chat-row-sub">' + esc((m.role === 'user' ? t('You') + ': ' : author ? author.name + ': ' : '') + preview(m)) + '</span></span>' +
          '<span class="chat-row-time">' + esc(relTime(m.at)) + '</span></button>';
      }).join('') + '</div>';
    }
    html += '<div class="discover-label discover-label-row"><span>' + esc(t('Contacts')) + '</span><span class="chat-new-links">' +
      '<button type="button" data-new="contact">+ ' + esc(t('Contact')) + '</button><button type="button" data-new="group">+ ' + esc(t('Group')) + '</button></span></div>' +
      '<div class="chat-people">' + people.map(function (p) {
        return '<button type="button" class="chat-person" data-chat="' + esc(p.id) + '">' + avatarHtml(p) + '<span>' + esc(p.name) + '</span></button>';
      }).join('') + '<button type="button" class="chat-person chat-person-new" data-new="contact"><span class="chat-av chat-av-add">' + icon('plus') + '</span><span>' + esc(t('New')) + '</span></button></div>';
    slot.innerHTML = html;
    if (!slot._wired) {
      slot._wired = true;
      slot.addEventListener('click', function (e) {
        var el = e.target.closest && e.target.closest('[data-chat], [data-new]');
        if (!el) return;
        if (el.dataset.chat) openChat(el.dataset.chat);
        else openEditor(null, el.dataset.new);
      });
    }
  }
  function headActions() {
    return hasKey() ? '<button type="button" data-chat-new="contact" aria-label="' + esc(t('New contact')) + '">' + icon('user-add') + '</button>' : '';
  }
  // The person at the top of the menu (both the main and the Planner menus).
  function renderMenuProfile() {
    var who = me();
    document.querySelectorAll('.mobile-menu-header').forEach(function (head) {
      var btn = head.querySelector('.menu-profile');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-profile';
        var title = head.querySelector('h3');
        if (title) title.hidden = true;
        head.insertBefore(btn, head.firstChild);
      }
      btn.innerHTML = avatarHtml(who, 'menu') + '<span class="menu-profile-text"><strong>' + esc(who.name || t('Me')) + '</strong><small>' +
        esc(t('Profile and AI instructions')) + '</small></span>' + icon('chevron-right');
    });
  }

  global.addEventListener('click', function (e) {
    var target = e.target && e.target.closest ? e.target : null;
    if (!target) return;
    if (target.closest('.menu-profile')) { e.preventDefault(); openMe(); return; }
    var head = target.closest('[data-chat-new]');
    if (head) { openEditor(null, head.dataset.chatNew); return; }
    // The old single "Chat" buttons open the Assistant now.
    if (target.closest('#chatBtn, #mobileChatBtn')) {
      e.preventDefault(); e.stopPropagation();
      if (global.MemoShell && global.MemoShell.menuOpen && global.MemoShell.menuOpen()) global.MemoShell.closeMenu();
      ensureAssistant().then(function () { if (contact(ASSISTANT_ID)) openChat(ASSISTANT_ID); });
    }
  }, true);
  global.addEventListener('memo:sync-state', function () { renderChat(); renderMenuProfile(); });
  document.addEventListener('memo:variant-changed', renderMenuProfile);
  global.addEventListener('memo:vault-change', function () { ensureAssistant(); });
  function init() { renderMenuProfile(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  global.addEventListener('load', function () { renderMenuProfile(); ensureAssistant(); loadServerAi(); });

  global.MemoChats = {
    renderDiscover: renderDiscover,
    headActions: headActions,
    openChat: openChat,
    openEditor: openEditor,
    openMe: openMe,
    send: send,
    contacts: contacts,
    me: me,
    messagesFor: messagesFor,
    recentChats: recentChats,
    ensureAssistant: ensureAssistant,
    aiReady: hasKey,
    busy: function () { return ui.sending; },
    refreshServerAi: loadServerAi,
    _activeFor: activeFor,
    _buildContext: buildContext,
    _systemPrompt: systemPrompt,
    _responders: responders,
    ASSISTANT_ID: ASSISTANT_ID
  };
})(window);
