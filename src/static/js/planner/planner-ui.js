/* planner-ui.js — small helpers shared by the planner modules: translation,
   element building, friendly dates, chip groups and swipe. */
(function () {
    'use strict';
    const P = window.Planner = window.Planner || {};

    function t(s, vars) {
        const I = window.MemoI18n;
        let out = I && I.t ? I.t(s, vars) : s;
        if (!(I && I.t) && vars) Object.keys(vars).forEach((k) => { out = out.split('{' + k + '}').join(String(vars[k])); });
        return out;
    }
    function locale() { return (window.MemoI18n && window.MemoI18n.getLocale && window.MemoI18n.getLocale()) || undefined; }
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
    function icon(name) { return '<span class="svg-icon svg-icon-' + name + '" aria-hidden="true"></span>'; }

    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const parse = (s) => { const [y, m, d] = String(s || '').split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
    const todayIso = () => iso(new Date());
    function daysFromToday(isoDate) { return Math.round((parse(isoDate) - parse(todayIso())) / 86400000); }
    // "Today", "Tomorrow", "Yesterday", else "Thu, Oct 22" (year when not this year).
    function dayName(isoDate, opts) {
        opts = opts || {};
        const n = daysFromToday(isoDate);
        if (!opts.long) { if (n === 0) return t('Today'); if (n === 1) return t('Tomorrow'); if (n === -1) return t('Yesterday'); }
        const d = parse(isoDate);
        const f = { weekday: 'short', month: 'short', day: 'numeric' };
        if (d.getFullYear() !== new Date().getFullYear()) f.year = 'numeric';
        try { return d.toLocaleDateString(locale(), f); } catch (e) { return isoDate; }
    }
    function shortDate(isoDate) {
        const d = parse(isoDate), f = { month: 'short', day: 'numeric' };
        if (d.getFullYear() !== new Date().getFullYear()) f.year = 'numeric';
        try { return d.toLocaleDateString(locale(), f); } catch (e) { return isoDate; }
    }
    function weekdayShort(d) { try { return d.toLocaleDateString(locale(), { weekday: 'short' }); } catch (e) { return ''; } }
    // A due date as the to-do list words it: "Today", "4 days late", "Sat, Oct 24".
    function dueText(isoDate) {
        if (!isoDate) return '';
        const n = daysFromToday(isoDate);
        if (n < -1) return t('{n} days late', { n: -n });
        return dayName(isoDate);
    }

    // A row of single-choice chips. items: [{ value, label }]; returns the group.
    function chipGroup(container, items, selected, onPick, opts) {
        opts = opts || {};
        container.innerHTML = '';
        items.forEach((it) => {
            const b = el('button', 'pl-chip' + (it.cls ? ' ' + it.cls : ''));
            b.type = 'button';
            b.dataset.value = String(it.value);
            b.innerHTML = it.html || esc(it.label);
            const on = String(it.value) === String(selected);
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
            b.addEventListener('click', () => onPick(it.value, b));
            container.appendChild(b);
        });
        if (opts.extra) container.appendChild(opts.extra);
        return container;
    }
    function markChip(container, value) {
        container.querySelectorAll('.pl-chip[data-value]').forEach((b) => {
            const on = b.dataset.value === String(value);
            b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
        });
    }

    // Horizontal swipe on an element: fn(-1) for a swipe right (back), fn(1) left.
    function onSwipe(node, fn) {
        let x0 = null, y0 = null, t0 = 0;
        node.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
        node.addEventListener('touchend', (e) => {
            if (x0 == null) return;
            const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
            x0 = null;
            if (Date.now() - t0 > 700 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
            fn(dx < 0 ? 1 : -1);
        }, { passive: true });
    }

    P.UI = { t, esc, el, icon, iso, parse, todayIso, daysFromToday, dayName, shortDate, weekdayShort, dueText, chipGroup, markChip, onSwipe, locale };
})();
