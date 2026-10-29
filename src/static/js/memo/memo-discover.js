// memo-discover.js — Discover: the fourth bottom tab, useful with or without AI.
//
// Without an AI key: one search across notes, spending and plans, On this
// day, this month's spending, what is next in the planner and a rediscovered
// note, plus one quiet card inviting a key. With a key, the AI chats module
// (memo-chats.js) adds recent chats and contacts above On this day.
//
// It is a layer over the current page (the bottom tabs stay), so Memo,
// Finance and Planner keep their own switching. Privacy holds: a locked page
// is left out until the app is unlocked, and Safe notes stay hidden at Safe level.
(function (global) {
  'use strict';

  var view = null;
  var state = { open: false, query: '', scope: 'all', searchTimer: 0 };
  var SCOPES = [['all', 'All'], ['default', 'Notes'], ['finance', 'Spending'], ['planner', 'Plans']];

  function t(s, v) { return global.MemoI18n && global.MemoI18n.t ? global.MemoI18n.t(s, v) : String(s).replace(/\{(\w+)\}/g, function (_m, k) { return v && v[k] != null ? v[k] : ''; }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function icon(name) { return '<span class="svg-icon svg-icon-' + name + '" aria-hidden="true"></span>'; }
  function sdb() { var s = global.MemoStateDb; return s && s.ready && s.ready() ? s : null; }
  function locale() { return (global.MemoI18n && global.MemoI18n.getLocale && global.MemoI18n.getLocale()) || undefined; }

  // ── data, privacy applied ──
  function variantAllowed(variant) {
    var P = global.MemoPrivacy;
    if (!P || !P.levelOf) return true;
    return P.levelOf(variant) !== 3 || !!(P.session && P.session.appUnlocked);
  }
  function live(e) { return e && !e.deletedAt; }
  // Safe notes follow the feed: hidden while Memo is at Safe level (2).
  function memos() {
    if (!variantAllowed('default') || !sdb()) return [];
    var P = global.MemoPrivacy, hideSafe = !!(P && P.levelOf && P.levelOf('default') === 2);
    return (sdb().loadEntries('default') || []).filter(function (e) { return live(e) && !(hideSafe && e.safe); });
  }
  function finance() { return variantAllowed('finance') && sdb() ? (sdb().loadEntries('finance') || []).filter(live) : []; }
  function plans() { return variantAllowed('planner') && sdb() ? (sdb().loadDocs('planner') || []).filter(live) : []; }
  function entryTime(e) {
    if (typeof e.ts === 'number' && e.ts) return e.ts;
    var d = Date.parse(e.purchaseDate || e.createdAt || e.date || '');
    return isNaN(d) ? 0 : d;
  }
  function firstLine(text) { return String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean)[0] || ''; }
  function fmtDate(ms) { try { return new Date(ms).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' }); } catch (_e) { return new Date(ms).toDateString(); } }
  // Same as the Finance page (memo-variant-finance.js formatMoneyFixed).
  function money(n) { return '$' + (Number(n) || 0).toFixed(2); }
  function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  function searchAll(query, scope) {
    var words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var out = [];
    var matches = function (text) { text = text.toLowerCase(); return words.every(function (w) { return text.indexOf(w) >= 0; }); };
    if (scope === 'all' || scope === 'default') memos().forEach(function (e) {
      if (matches([e.description, e.category, (e.tags || []).join(' ')].join(' '))) out.push({ variant: 'default', id: e.id, title: firstLine(e.description) || t('Untitled note'), sub: e.category, at: entryTime(e) });
    });
    if (scope === 'all' || scope === 'finance') finance().forEach(function (e) {
      var items = (e.items || []).map(function (i) { return i && i.name; }).join(' ');
      if (matches([e.description, e.category, items, (e.tags || []).join(' ')].join(' '))) out.push({ variant: 'finance', id: e.id, title: firstLine(e.description) || e.category || t('Purchase'), sub: money(e.total != null ? e.total : e.price) + ' · ' + (e.category || ''), at: entryTime(e) });
    });
    if (scope === 'all' || scope === 'planner') plans().forEach(function (d) {
      if (matches([d.title, d.notes, d.kind].join(' '))) out.push({ variant: 'planner', id: d.id, title: d.title || t('Untitled'), sub: d.kind === 'event' ? (d.date || '') + (d.start ? ' ' + d.start : '') : t(d.kind || ''), at: entryTime(d) });
    });
    out.sort(function (a, b) { return b.at - a.at; });
    return out.slice(0, 60);
  }
  function onThisDay() {
    var now = new Date();
    return memos().filter(function (e) {
      var at = entryTime(e);
      if (!at) return false;
      var d = new Date(at);
      return d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getFullYear() < now.getFullYear();
    }).sort(function (a, b) { return entryTime(b) - entryTime(a); }).slice(0, 3);
  }
  function thisMonth() {
    var now = new Date(), prefix = isoDay(now).slice(0, 7), total = 0, byCat = {};
    finance().forEach(function (e) {
      var day = String(e.purchaseDate || '').slice(0, 7) || (entryTime(e) ? isoDay(new Date(entryTime(e))).slice(0, 7) : '');
      if (day !== prefix) return;
      var amount = Number(e.total != null ? e.total : e.price) || 0;
      total += amount;
      var c = e.category || t('Uncategorized');
      byCat[c] = (byCat[c] || 0) + amount;
    });
    var top = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; })[0];
    return { total: total, top: top, topAmount: top ? byCat[top] : 0, any: Object.keys(byCat).length > 0 };
  }
  function upNext() {
    var today = isoDay(new Date());
    var events = plans().filter(function (d) { return d.kind === 'event' && d.date && d.date >= today; })
      .sort(function (a, b) { return (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')); });
    if (events.length) return { title: events[0].title || t('Event'), when: events[0].date === today ? t('Today') + (events[0].start ? ' ' + events[0].start : '') : events[0].date + (events[0].start ? ' ' + events[0].start : '') };
    var todo = plans().filter(function (d) { return d.kind === 'todo' && !d.done; })[0];
    return todo ? { title: todo.title || t('To-do'), when: todo.due ? String(todo.due).slice(0, 10) : t('To do') } : null;
  }
  // One older note, the same one all day.
  function rediscover() {
    // Not one already shown under On this day.
    var shown = onThisDay().map(function (e) { return e.id; });
    var list = memos().filter(function (e) { return entryTime(e) && Date.now() - entryTime(e) > 30 * 86400000 && shown.indexOf(e.id) < 0; });
    if (!list.length) return null;
    var seed = Number(isoDay(new Date()).replace(/-/g, ''));
    return list[seed % list.length];
  }

  // ── view ──
  function build() {
    if (view && document.body.contains(view)) return view;
    view = document.createElement('section');
    view.id = 'discoverView';
    view.className = 'discover-view';
    view.hidden = true;
    view.setAttribute('aria-label', t('Discover'));
    view.innerHTML = '<header class="discover-head"><h2>' + icon('compass') + ' <span data-i18n="Discover">' + esc(t('Discover')) + '</span></h2>' +
      '<span class="discover-head-actions"></span>' +
      '<button type="button" class="discover-menu-btn" aria-label="' + esc(t('Menu')) + '">' + icon('menu') + '</button></header>' +
      '<div class="discover-body"></div>';
    view.addEventListener('click', onClick);
    view.addEventListener('input', onInput);
    document.body.appendChild(view);
    return view;
  }
  function render() {
    if (!view || view.hidden) return;
    var body = view.querySelector('.discover-body');
    var keep = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('discover-search');
    var html = '<label class="discover-search-wrap">' + icon('search') +
      '<input type="search" class="discover-search" enterkeyhint="search" autocomplete="off" placeholder="' + esc(t('Search notes, spending and plans')) + '" value="' + esc(state.query) + '">' +
      (state.query ? '<button type="button" class="discover-clear" data-act="clear" aria-label="' + esc(t('Clear search')) + '">' + icon('x') + '</button>' : '') + '</label>' +
      '<div class="discover-scopes" role="group" aria-label="' + esc(t('Search in')) + '">' + SCOPES.map(function (s) {
        return '<button type="button" data-scope="' + s[0] + '" aria-pressed="' + (state.scope === s[0]) + '">' + esc(t(s[1])) + '</button>';
      }).join('') + '</div>';
    if (state.query.trim()) html += resultsHtml(searchAll(state.query, state.scope));
    else html += homeHtml();
    body.innerHTML = html;
    var chats = global.MemoChats && global.MemoChats.renderDiscover;
    var slot = body.querySelector('.discover-chats-slot');
    if (chats && slot) chats(slot);
    if (keep) { var input = body.querySelector('.discover-search'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    var head = view.querySelector('.discover-head-actions');
    head.innerHTML = global.MemoChats && global.MemoChats.headActions ? global.MemoChats.headActions() : '';
  }
  function resultsHtml(results) {
    if (!results.length) return '<p class="discover-empty">' + esc(t('Nothing found.')) + '</p>';
    var icons = { default: 'book', finance: 'cash', planner: 'calendar' };
    return '<div class="discover-results">' + results.map(function (r) {
      return '<button type="button" class="discover-result" data-open="' + r.variant + '" data-id="' + esc(r.id) + '">' + icon(icons[r.variant]) +
        '<span class="discover-result-text"><span class="discover-result-title">' + esc(r.title) + '</span>' +
        '<span class="discover-result-sub">' + esc([r.at ? fmtDate(r.at) : '', r.sub].filter(Boolean).join(' · ')) + '</span></span></button>';
    }).join('') + '</div>';
  }
  function noteCard(e, label) {
    return '<button type="button" class="discover-card" data-open="default" data-id="' + esc(e.id) + '"><span class="discover-card-date">' + esc(label) + '</span>' +
      '<span class="discover-card-text">' + esc(firstLine(e.description) || t('Untitled note')) + '</span></button>';
  }
  function homeHtml() {
    var html = '<div class="discover-chats-slot"></div>';
    var days = onThisDay();
    html += '<div class="discover-label">' + esc(t('On this day')) + '</div>';
    if (days.length) {
      html += days.map(function (e) {
        var years = new Date().getFullYear() - new Date(entryTime(e)).getFullYear();
        return noteCard(e, fmtDate(entryTime(e)) + ' · ' + (years === 1 ? t('a year ago') : t('{n} years ago', { n: years })));
      }).join('');
    } else html += '<p class="discover-quiet">' + esc(t('Nothing from this day in earlier years yet.')) + '</p>';
    var month = thisMonth(), next = upNext();
    if (month.any || next) {
      html += '<div class="discover-row">';
      if (month.any) html += '<button type="button" class="discover-card" data-go="finance"><span class="discover-card-date">' + esc(t('This month')) + '</span>' +
        '<span class="discover-card-big">' + esc(money(month.total)) + '</span><span class="discover-card-sub">' + esc(t('Top: {name} {amount}', { name: month.top, amount: money(month.topAmount) })) + '</span></button>';
      if (next) html += '<button type="button" class="discover-card" data-go="planner"><span class="discover-card-date">' + esc(t('Up next')) + '</span>' +
        '<span class="discover-card-text">' + esc(next.title) + '</span><span class="discover-card-sub">' + esc(next.when) + '</span></button>';
      html += '</div>';
    }
    var old = rediscover();
    if (old) html += '<div class="discover-label">' + esc(t('Rediscover')) + '</div>' + noteCard(old, fmtDate(entryTime(old)) + (old.category ? ' · ' + old.category : ''));
    var hasKey = global.MemoChats && global.MemoChats.aiReady ? global.MemoChats.aiReady() : !!(global.MemoAiKey && global.MemoAiKey.isConfigured && global.MemoAiKey.isConfigured());
    if (!hasKey) {
      html += '<button type="button" class="discover-invite" data-act="add-key">' + icon('sparkles') + '<span><strong>' + esc(t('Chat with your notes')) + '</strong>' +
        '<span>' + esc(t('Bring your own key: add one in the Vault, under AI keys. DeepSeek is low cost; Gemini has a free tier.')) + '</span></span></button>';
    }
    return html;
  }

  // ── actions ──
  function onInput(event) {
    if (!event.target.classList.contains('discover-search')) return;
    state.query = event.target.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(render, 120);
  }
  async function onClick(event) {
    var el = event.target.closest && event.target.closest('button');
    if (!el || !view.contains(el)) return;
    if (el.classList.contains('discover-menu-btn')) { if (global.MemoShell) global.MemoShell.openMenu(); return; }
    if (el.dataset.scope) { state.scope = el.dataset.scope; render(); return; }
    if (el.dataset.act === 'add-key') { if (global.MemoVaultUi) global.MemoVaultUi.open(); return; }
    if (el.dataset.act === 'clear') { state.query = ''; render(); var input = view.querySelector('.discover-search'); if (input) input.focus(); return; }
    if (el.dataset.go) { await goTo(el.dataset.go); return; }
    if (el.dataset.open) await openResult(el.dataset.open, el.dataset.id);
  }
  async function goTo(variant) {
    close();
    var shell = global.MemoSpaShell;
    if (shell && shell.getVariant() !== variant) await shell.switchTo(variant);
  }
  async function openResult(variant, id) {
    await goTo(variant);
    if (variant === 'planner') return;
    // The page just mounted; open the entry once its view is ready.
    setTimeout(function () { if (global.MemoVariant && global.MemoVariant.openDetail) global.MemoVariant.openDetail(id); }, 60);
  }

  function open() {
    build();
    if (global.MemoShell && global.MemoShell.menuOpen && global.MemoShell.menuOpen()) global.MemoShell.closeMenu();
    view.hidden = false;
    state.open = true;
    document.body.classList.add('discover-open');
    render();
    reflectNav();
    document.dispatchEvent(new CustomEvent('memo:discover', { detail: { open: true } }));
  }
  function close() {
    if (!state.open) return false;
    state.open = false;
    if (view) view.hidden = true;
    document.body.classList.remove('discover-open');
    reflectNav();
    document.dispatchEvent(new CustomEvent('memo:discover', { detail: { open: false } }));
    return true;
  }
  function reflectNav() {
    var nav = document.getElementById('primaryNav');
    if (!nav) return;
    var variant = (global.MemoSpaShell && global.MemoSpaShell.getVariant()) || global.MEMO_VARIANT || 'default';
    nav.querySelectorAll('a').forEach(function (a) {
      var current = state.open ? a.dataset.view === 'discover' : a.dataset.variant === variant;
      if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  // The bottom tab, the menu tile, and leaving Discover through another tab.
  // Window capture runs before the single-page shell's document handler.
  global.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    var tab = target.closest('#primaryNav a');
    if (tab && tab.dataset.view === 'discover') { event.preventDefault(); event.stopPropagation(); open(); return; }
    if (target.closest('#mobileDiscoverBtn')) { event.preventDefault(); open(); return; }
    if (tab && state.open) {
      var current = (global.MemoSpaShell && global.MemoSpaShell.getVariant()) || global.MEMO_VARIANT || 'default';
      if (tab.dataset.variant === current) { event.preventDefault(); event.stopPropagation(); }
      close();
    }
  }, true);
  document.addEventListener('memo:variant-changed', function () {
    document.querySelectorAll('#mobileDiscoverBtn').forEach(function (b) { b.hidden = false; });
    reflectNav();
  });
  ['memo:vault-change', 'memo:sync-state', 'memo:localechange', 'memo:privacy-unlocked', 'memo:privacy-locked'].forEach(function (name) {
    (name.indexOf('privacy') >= 0 || name === 'memo:localechange' ? document : global).addEventListener(name, function () { if (state.open) render(); });
  });
  function init() { document.querySelectorAll('#mobileDiscoverBtn').forEach(function (b) { b.hidden = false; }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  global.MemoDiscover = {
    open: open,
    close: close,
    isOpen: function () { return state.open; },
    handleBack: function () { return close(); },
    render: render,
    search: searchAll,
    // Privacy-filtered data, shared with the AI chats' context.
    sources: { memos: memos, finance: finance, plans: plans, entryTime: entryTime, firstLine: firstLine, money: money, thisMonth: thisMonth },
    _home: { onThisDay: onThisDay, thisMonth: thisMonth, upNext: upNext, rediscover: rediscover }
  };
})(window);
