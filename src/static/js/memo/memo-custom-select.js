// memo-custom-select.js — replace the OS-native <select> popup with our own styled
// dropdown for a unified feel across platforms. Drop-in: the real <select> is kept
// (hidden, still the source of truth), so existing `.value` reads and `change`
// listeners keep working. Ported from ImageDB's custom-select.js, plus a global
// observer for memoSystem's detach/attach view architecture: variant DOMs and
// on-demand dialogs are inserted after load, so we enhance selects as they appear.
// Enhance a control by leaving it visible; opt out with data-no-custom.
'use strict';

(() => {
  let _open = null;   // { close, root, list } of the currently-open dropdown

  const CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';

  // A position:fixed element is offset by the nearest ancestor that establishes a
  // containing block for it — any non-none transform/perspective/filter/will-change/
  // contain. The mobile-sheet dialogs keep `transform: translateY(<drag>)` even at rest
  // (drag defaults to 0px), so a fixed dropdown inside them is laid out from the dialog's
  // padding box, not the viewport, and drops by the dialog's top edge. Return that origin
  // so viewport coordinates can be de-offset. {0,0} when nothing transforms (true viewport).
  function containingBlockOffset(el) {
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.transform !== 'none' || cs.perspective !== 'none' ||
          (cs.filter && cs.filter !== 'none') ||
          /transform|perspective/.test(cs.willChange || '') ||
          /paint|layout|strict|content/.test(cs.contain || '')) {
        const rect = n.getBoundingClientRect();
        return { dx: rect.left + n.clientLeft, dy: rect.top + n.clientTop };
      }
    }
    return { dx: 0, dy: 0 };
  }

  function closeOpen() { if (_open) _open.close(); }
  // Outside interaction closes the open dropdown.
  document.addEventListener('pointerdown', e => { if (_open && !_open.root.contains(e.target)) closeOpen(); }, true);
  window.addEventListener('resize', closeOpen);
  window.addEventListener('blur', closeOpen);
  // A scroll anywhere but inside the open list closes it (position is fixed, so it
  // wouldn't otherwise follow the trigger).
  document.addEventListener('scroll', e => { if (_open && !(_open.list.contains(e.target))) closeOpen(); }, true);

  function enhance(sel) {
    if (!sel || sel.__csDone || sel.multiple) return;
    sel.__csDone = true;

    const root = document.createElement('div');
    root.className = 'cs';
    sel.parentNode.insertBefore(root, sel);
    root.appendChild(sel);
    sel.classList.add('cs-native');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (sel.getAttribute('aria-label')) trigger.setAttribute('aria-label', sel.getAttribute('aria-label'));
    const labelEl = document.createElement('span');
    labelEl.className = 'cs-label';
    const chev = document.createElement('span');
    chev.className = 'cs-chev';
    chev.innerHTML = CHEVRON;
    trigger.append(labelEl, chev);
    root.appendChild(trigger);

    const list = document.createElement('div');
    list.className = 'cs-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    root.appendChild(list);

    let hi = -1;   // highlighted index while open

    const syncLabel = () => {
      const o = sel.options[sel.selectedIndex];
      labelEl.textContent = o ? o.textContent : '';
      trigger.classList.toggle('cs-placeholder', !o || o.value === '');
    };
    const reflectDisabled = () => { trigger.disabled = sel.disabled; root.classList.toggle('cs-off', sel.disabled); };

    const buildList = () => {
      list.textContent = '';
      [...sel.options].forEach((o, i) => {
        const item = document.createElement('div');
        item.className = 'cs-item' + (i === sel.selectedIndex ? ' cs-sel' : '') + (i === hi ? ' cs-hi' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(i === sel.selectedIndex));
        item.dataset.i = String(i);
        item.textContent = o.textContent;
        if (o.disabled) item.classList.add('cs-disabled');
        item.addEventListener('mouseenter', () => { hi = i; paintHi(); });
        item.addEventListener('click', () => choose(i));
        list.appendChild(item);
      });
    };
    const paintHi = () => list.querySelectorAll('.cs-item').forEach((el, i) => el.classList.toggle('cs-hi', i === hi));

    function choose(i) {
      const o = sel.options[i];
      if (!o || o.disabled) return;
      if (sel.selectedIndex !== i) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncLabel();
      close();
      trigger.focus();
    }

    function position() {
      const r = trigger.getBoundingClientRect();
      const off = containingBlockOffset(list);
      list.style.position = 'fixed';
      list.style.left = (r.left - off.dx) + 'px';
      list.style.minWidth = r.width + 'px';
      list.style.maxHeight = '';
      list.hidden = false;
      const lh = Math.min(list.scrollHeight, 260);
      const below = window.innerHeight - r.bottom;
      if (below < lh + 10 && r.top > below) {
        list.style.top = (Math.max(6, r.top - lh - 6) - off.dy) + 'px';
        list.style.maxHeight = Math.min(260, r.top - 12) + 'px';
      } else {
        list.style.top = (r.bottom + 6 - off.dy) + 'px';
        list.style.maxHeight = Math.min(260, below - 12) + 'px';
      }
    }

    function open() {
      if (sel.disabled || !sel.options.length) return;
      syncLabel();
      hi = sel.selectedIndex;
      buildList();
      position();
      trigger.setAttribute('aria-expanded', 'true');
      root.classList.add('cs-open');
      _open = ctl;
      list.querySelector('.cs-sel')?.scrollIntoView({ block: 'nearest' });
    }
    function close() {
      list.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      root.classList.remove('cs-open');
      if (_open === ctl) _open = null;
    }
    const ctl = { root, list, close };

    function step(dir) {
      const n = sel.options.length;
      for (let k = 0; k < n; k++) {
        hi = (hi + dir + n) % n;
        if (!sel.options[hi].disabled) break;
      }
      paintHi();
      list.querySelectorAll('.cs-item')[hi]?.scrollIntoView({ block: 'nearest' });
    }

    trigger.addEventListener('click', () => (list.hidden ? open() : close()));
    trigger.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) open(); else step(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (list.hidden) open(); else choose(hi);
      } else if (e.key === 'Escape') {
        if (!list.hidden) { e.preventDefault(); close(); trigger.focus(); }
      } else if (e.key === 'Home' || e.key === 'End') {
        if (!list.hidden) { e.preventDefault(); hi = e.key === 'Home' ? 0 : sel.options.length - 1; paintHi(); }
      }
    });

    // Keep the trigger in sync however the <select> changes: user events, option
    // (re)population, disabled toggles, AND programmatic `.value` / `.selectedIndex`
    // assignments — those fire no event and don't touch attributes, so we intercept the
    // property setters (that's how settings restore the saved value on load).
    sel.addEventListener('change', syncLabel);
    const mo = new MutationObserver(() => { reflectDisabled(); syncLabel(); if (!list.hidden) { buildList(); position(); } });
    mo.observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    const proto = window.HTMLSelectElement && HTMLSelectElement.prototype;
    for (const prop of ['value', 'selectedIndex']) {
      const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) continue;
      Object.defineProperty(sel, prop, {
        configurable: true, enumerable: d.enumerable,
        get() { return d.get.call(this); },
        set(v) { d.set.call(this, v); syncLabel(); if (!list.hidden) buildList(); },
      });
    }

    reflectDisabled();
    syncLabel();
  }

  // Replace the OS colour picker on <input type="color"> with a swatch that opens a
  // preset palette; a rainbow "more" swatch falls back to the native picker for any colour.
  const COLOR_PRESETS = ['#ffffff', '#000000', '#f2f2f2', '#cccccc', '#888888', '#444444',
    '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];

  function enhanceColor(input) {
    if (!input || input.__csDone || (input.type || '').toLowerCase() !== 'color') return;
    input.__csDone = true;

    const root = document.createElement('span');
    root.className = 'cc';
    input.parentNode.insertBefore(root, input);
    root.appendChild(input);
    input.classList.add('cs-native');

    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'cc-swatch';
    swatch.setAttribute('aria-haspopup', 'true');
    swatch.setAttribute('aria-label', input.getAttribute('aria-label') || 'Choose colour');
    const dot = document.createElement('span');
    dot.className = 'cc-dot';
    swatch.appendChild(dot);
    root.appendChild(swatch);

    const list = document.createElement('div');
    list.className = 'cc-list';
    list.hidden = true;
    root.appendChild(list);

    const syncDot = () => { dot.style.background = input.value || '#ffffff'; };
    const build = () => {
      const grid = document.createElement('div');
      grid.className = 'cc-grid';
      COLOR_PRESETS.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cc-preset' + ((input.value || '').toLowerCase() === c.toLowerCase() ? ' cc-cur' : '');
        b.style.background = c;
        b.title = c;
        b.addEventListener('click', () => choose(c));
        grid.appendChild(b);
      });
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'cc-preset cc-more';
      more.title = 'Custom colour';
      more.addEventListener('click', () => { close(); try { input.showPicker ? input.showPicker() : input.click(); } catch (_) { input.click(); } });
      grid.appendChild(more);
      list.textContent = '';
      list.appendChild(grid);
    };
    function choose(c) {
      input.value = c;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      syncDot();
      close();
    }
    function position() {
      const r = swatch.getBoundingClientRect();
      const off = containingBlockOffset(list);
      list.hidden = false;
      list.style.position = 'fixed';
      list.style.left = (Math.max(6, Math.min(r.left, window.innerWidth - list.offsetWidth - 6)) - off.dx) + 'px';
      const lh = list.offsetHeight, below = window.innerHeight - r.bottom;
      list.style.top = (((below < lh + 10 && r.top > below) ? Math.max(6, r.top - lh - 6) : r.bottom + 6) - off.dy) + 'px';
    }
    function open() { build(); position(); root.classList.add('cs-open'); _open = ctl; }
    function close() { list.hidden = true; root.classList.remove('cs-open'); if (_open === ctl) _open = null; }
    const ctl = { root, list, close };

    swatch.addEventListener('click', () => (list.hidden ? open() : close()));
    input.addEventListener('input', syncDot);
    input.addEventListener('change', syncDot);
    const d = window.HTMLInputElement && Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (d && d.set) Object.defineProperty(input, 'value', { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); syncDot(); } });
    syncDot();
  }

  function enhanceAll(root = document) {
    // Every visible <select> gets the unified dropdown. Opt out with data-no-custom;
    // hidden selects (e.g. a picker's source select) are skipped.
    if (!root.querySelectorAll) return;
    root.querySelectorAll('select:not([hidden]):not([data-no-custom]):not(.cs-native)').forEach(enhance);
    root.querySelectorAll('input[type="color"]:not([data-no-custom]):not(.cs-native)').forEach(enhanceColor);
  }

  // memoSystem inserts variant DOMs and on-demand dialogs after load, so a one-time
  // enhanceAll isn't enough. Watch for added controls and enhance them as they appear.
  // Feed re-renders add many card nodes but no selects, so the guarded query stays cheap.
  const bodyMo = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches('select:not([hidden]):not([data-no-custom]):not(.cs-native)')) enhance(n);
        else if (n.matches && n.matches('input[type="color"]:not([data-no-custom]):not(.cs-native)')) enhanceColor(n);
        else if (n.querySelector && n.querySelector('select, input[type="color"]')) enhanceAll(n);
      }
    }
  });

  function startObserver() {
    if (document.body) bodyMo.observe(document.body, { childList: true, subtree: true });
  }

  window.CustomSelect = { enhance, enhanceColor, enhanceAll };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { enhanceAll(); startObserver(); });
  } else {
    enhanceAll();
    startObserver();
  }
})();
