/* planner-archive.js — "Completed todos" history dialog.
   A compact month/year calendar (like the main Calendar) for browsing tasks
   you finished on a given day. Completed todos age out of the live list after
   a day and live here; you can edit, delete, or re-add a copy to today. */
(function () {
    'use strict';
    const P = window.Planner, S = P.Store, D = S.Dates;
    const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    let range = 'month', cursor = new Date(), selected = D.iso(new Date()), collapsed = false;

    function label() {
        return range === 'year' ? String(cursor.getFullYear())
            : `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
    }
    function shift(dir) {
        cursor = range === 'year'
            ? new Date(cursor.getFullYear() + dir, cursor.getMonth(), 1)
            : new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
        render();
    }

    function renderMonth(host, counts) {
        const y = cursor.getFullYear(), m = cursor.getMonth();
        const grid = el('div', 'cal-month-grid');
        DOW.forEach((w) => grid.appendChild(el('div', 'cal-dow', w)));
        const start = D.startOfWeek(new Date(y, m, 1));
        const todayIso = D.iso(new Date());
        for (let i = 0; i < 42; i++) {
            const day = D.addDays(start, i), di = D.iso(day);
            const cell = el('div', 'cal-day');
            if (day.getMonth() !== m) cell.classList.add('out');
            if (di === todayIso) cell.classList.add('today');
            if (di === selected) cell.classList.add('selected');
            cell.appendChild(el('div', 'dnum', String(day.getDate())));
            if (counts[di]) cell.appendChild(el('div', 'ev-count', counts[di]));
            cell.addEventListener('click', () => { selected = di; render(); });
            grid.appendChild(cell);
        }
        host.appendChild(grid);
    }

    function renderYear(host, counts) {
        const y = cursor.getFullYear();
        const grid = el('div', 'cal-year-grid');
        for (let m = 0; m < 12; m++) {
            const mini = el('div', 'cal-mini');
            mini.appendChild(el('h4', null, MONTHS[m]));
            const mg = el('div', 'mini-grid');
            const start = D.startOfWeek(new Date(y, m, 1));
            for (let i = 0; i < 42; i++) {
                const day = D.addDays(start, i);
                const mc = el('div', 'mc');
                if (day.getMonth() === m) { mc.textContent = day.getDate(); if (counts[D.iso(day)]) mc.classList.add('has'); }
                mg.appendChild(mc);
            }
            mini.appendChild(mg);
            mini.addEventListener('click', () => { range = 'month'; cursor = new Date(y, m, 1); render(); });
            grid.appendChild(mini);
        }
        host.appendChild(grid);
    }

    function renderList() {
        const titleEl = document.getElementById('archDayTitle');
        const list = document.getElementById('archList');
        list.innerHTML = '';
        const items = S.completedByDate(selected);
        const dd = D.parseISO(selected);
        titleEl.textContent = `${DOW[(dd.getDay() + 6) % 7]}, ${MONTHS[dd.getMonth()]} ${dd.getDate()} — ${items.length} completed`;
        if (!items.length) { list.appendChild(el('li', 'muted', 'Nothing completed on this day.')); return; }
        items.forEach((t) => {
            const li = el('li', 'arch-item');
            li.appendChild(el('span', 'arch-check', '<span class="svg-icon svg-icon-check"></span>'));
            const main = el('div', 'arch-main');
            main.appendChild(el('div', 'arch-title', esc(t.title)));
            const meta = el('div', 'arch-meta');
            if (t.priority === 'high') meta.appendChild(el('span', 'pill high', 'high'));
            meta.appendChild(el('span', null, 'done ' + selected));
            main.appendChild(meta);
            li.appendChild(main);

            const actions = el('div', 'arch-actions');
            const edit = el('button', 'tiny ghost', '<span class="svg-icon svg-icon-edit"></span>'); edit.type = 'button'; edit.title = 'Edit title';
            edit.addEventListener('click', () => {
                const v = window.prompt('Edit completed task', t.title);
                if (v && v.trim()) S.updateTodo(t.id, { title: v.trim() });
            });
            const readd = el('button', 'tiny ghost', '<span class="svg-icon svg-icon-duplicate"></span>'); readd.type = 'button'; readd.title = 'Add a copy to today';
            readd.addEventListener('click', () => {
                S.addTodo({ title: t.title, due: D.iso(new Date()), priority: t.priority || 'normal' });
                readd.innerHTML = '<span class="svg-icon svg-icon-check"></span>'; setTimeout(() => { readd.innerHTML = '<span class="svg-icon svg-icon-duplicate"></span>'; }, 900);
            });
            const del = el('button', 'del', '<span class="svg-icon svg-icon-trash"></span>'); del.type = 'button'; del.title = 'Delete record';
            del.addEventListener('click', async () => {
                const tr = (x, v) => (window.Planner.UI ? window.Planner.UI.t(x, v) : x);
                const ok = window.MemoShell && window.MemoShell.confirm
                    ? await window.MemoShell.confirm(tr('Delete “{name}” from history?', { name: t.title }), { okLabel: tr('Delete'), danger: true })
                    : true;
                if (ok) S.deleteTodo(t.id);
            });
            actions.appendChild(edit); actions.appendChild(readd); actions.appendChild(del);
            li.appendChild(actions);
            list.appendChild(li);
        });
    }

    function applyCollapsed() {
        const host = document.getElementById('archCal');
        const btn = document.getElementById('archCalToggle');
        const tb = document.getElementById('archRange').parentElement; // .arch-toolbar
        host.style.display = collapsed ? 'none' : '';
        tb.classList.toggle('collapsed', collapsed);
        btn.textContent = collapsed ? '▸' : '▾';
        btn.title = collapsed ? 'Show calendar' : 'Collapse calendar';
    }
    function render() {
        document.getElementById('archLabel').textContent = label();
        document.querySelectorAll('#archRange button').forEach((b) => b.classList.toggle('active', b.dataset.range === range));
        const host = document.getElementById('archCal');
        host.innerHTML = '';
        const counts = S.completedCountByDate();
        if (range === 'year') renderYear(host, counts); else renderMonth(host, counts);
        renderList();
        applyCollapsed();
    }

    function updateBtn() {
        const n = S.archivedCount();
        document.getElementById('archiveBtn').innerHTML = n ? `<span class="svg-icon svg-icon-folder"></span> History (${n})` : '<span class="svg-icon svg-icon-folder"></span> History';
    }

    function open() {
        range = 'month'; cursor = new Date(); selected = D.iso(new Date());
        document.getElementById('archiveDlg').showModal();
        render();
    }

    function mount() {
        document.getElementById('archiveBtn').addEventListener('click', open);
        document.getElementById('archPrev').addEventListener('click', () => shift(-1));
        document.getElementById('archNext').addEventListener('click', () => shift(1));
        document.getElementById('archToday').addEventListener('click', () => { cursor = new Date(); selected = D.iso(new Date()); render(); });
        document.getElementById('archCalToggle').addEventListener('click', () => { collapsed = !collapsed; applyCollapsed(); });
        document.querySelectorAll('#archRange button').forEach((b) =>
            b.addEventListener('click', () => { range = b.dataset.range; render(); }));
        S.on('change', () => {
            updateBtn();
            const dlg = document.getElementById('archiveDlg');
            if (dlg.open) render();
        });
        updateBtn();
    }

    P.Archive = { mount };
})();
