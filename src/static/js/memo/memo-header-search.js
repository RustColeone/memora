// memo-header-search.js — header search on phones and tablets.
//
// Up to 1100px the bar hides the search field (memo-navigation.css), so a
// Search button expands #searchBox across the bar. On phones it takes Bin's
// place; Bin stays in the menu. ✕, Escape and system Back clear the query and
// collapse it. A page restored with a query starts expanded so the active
// search stays visible.
(function (global) {
  'use strict';

  global.MemoI18n.addMessages([
    ['Search', 'Buscar', 'Rechercher', 'Suchen', '搜索'],
    ['Close search', 'Cerrar búsqueda', 'Fermer la recherche', 'Suche schließen', '关闭搜索'],
  ]);

  var phone = global.matchMedia('(max-width: 1100px)');
  function box() { return document.getElementById('searchBox'); }
  function toggle() { return document.getElementById('searchToggleBtn'); }
  function isOpen() { return document.body.classList.contains('header-search-open'); }

  function setOpen(open) {
    document.body.classList.toggle('header-search-open', open);
    var t = toggle(); if (!t) return;
    var label = global.MemoI18n.t(open ? 'Close search' : 'Search');
    t.setAttribute('aria-expanded', String(open));
    t.setAttribute('aria-label', label);
    t.title = label;
  }

  function open() {
    setOpen(true);
    var b = box();
    if (b) { try { b.focus({ preventScroll: true }); } catch (_e) { b.focus(); } }
  }

  // Returns true when something was closed (for the system Back chain).
  function close() {
    if (!isOpen() || !phone.matches) return false;
    var b = box();
    if (b && b.value) {
      b.value = '';
      b.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setOpen(false);
    var t = toggle(); if (t) { try { t.focus({ preventScroll: true }); } catch (_e) { t.focus(); } }
    return true;
  }

  function reflect() {
    var b = box();
    setOpen(!!(phone.matches && b && b.value));
  }

  function init() {
    var t = toggle(), b = box();
    if (!t || !b) return;
    t.addEventListener('click', function () { if (isOpen()) close(); else open(); });
    b.addEventListener('keydown', function (event) { if (event.key === 'Escape' && isOpen()) { event.preventDefault(); close(); } });
    // Leaving an empty field collapses it again.
    b.addEventListener('blur', function () {
      setTimeout(function () { if (isOpen() && !b.value && document.activeElement !== t) setOpen(false); }, 0);
    });
    if (phone.addEventListener) phone.addEventListener('change', reflect);
    document.addEventListener('memo:variant-changed', reflect);
    document.addEventListener('memo:localechange', function () { setOpen(isOpen()); });
    reflect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  global.MemoHeaderSearch = { open: open, close: close, isOpen: isOpen };
})(window);
