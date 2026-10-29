/* planner-projects.js — every project on one timeline you can swipe (weeks or
   months), and below it a card per project with its milestones. Tap a project
   on the timeline to open its card. */
(function () {
    'use strict';
    const P = window.Planner, S = P.Store, D = S.Dates, U = P.UI;
    const { t, esc, el, icon } = U;
    const ZOOM = { weeks: { dayPx: 66 / 7 }, months: { dayPx: 3 } };

    function zoom() { return S.state.ui.projZoom === 'months' ? 'months' : 'weeks'; }
    function activeId() {
        const ps = S.state.projects;
        const id = S.state.ui.activeProject;
        return ps.some((p) => p.id === id) ? id : (ps[0] ? ps[0].id : null);
    }
    function days(a, b) { return Math.round((D.parseISO(b) - D.parseISO(a)) / 86400000); }

    // The span shown: every project and milestone, and at least two weeks back
    // and two months ahead of today.
    function domain() {
        const today = D.iso(new Date());
        let min = D.iso(D.addDays(new Date(), -14)), max = D.iso(D.addDays(new Date(), 60));
        S.state.projects.forEach((p) => {
            [p.start, p.end].concat(S.milestonesOf(p).map((m) => m.due)).forEach((d) => {
                if (!d) return; if (d < min) min = d; if (d > max) max = d;
            });
        });
        // start on a Monday (weeks) or the 1st (months), end a little after
        const z = zoom(), m0 = D.parseISO(min);
        min = D.iso(z === 'weeks' ? D.startOfWeek(m0) : new Date(m0.getFullYear(), m0.getMonth(), 1));
        max = D.iso(D.addDays(D.parseISO(max), 14));
        return { min, max, today };
    }

    /* ---------------- the timeline ---------------- */
    let scrolledFor = '';
    function renderTimeline() {
        const box = document.getElementById('projTimeline'); if (!box) return;
        const ps = S.state.projects;
        box.innerHTML = '';
        box.hidden = !ps.length;
        if (!ps.length) return;
        const dom = domain(), px = ZOOM[zoom()].dayPx, width = Math.max(1, days(dom.min, dom.max)) * px;
        const x = (d) => days(dom.min, d) * px;
        const scroller = el('div', 'gantt-scroll');
        scroller.setAttribute('role', 'group');
        scroller.setAttribute('aria-label', t('All projects on a timeline'));
        const inner = el('div', 'gantt-inner');
        inner.style.width = width + 'px';

        const scale = el('div', 'gantt-scale');
        if (zoom() === 'weeks') {
            for (let d = D.parseISO(dom.min); D.iso(d) <= dom.max; d = D.addDays(d, 7)) {
                const di = D.iso(d), first = d.getDate() <= 7;
                const lab = el('span', 'gantt-tick' + (first ? ' month' : ''), esc(first ? U.shortDate(di) : String(d.getDate())));
                lab.style.left = x(di) + 'px';
                scale.appendChild(lab);
                const line = el('span', 'gantt-grid'); line.style.left = x(di) + 'px'; inner.appendChild(line);
            }
        } else {
            for (let d = D.parseISO(dom.min); D.iso(d) <= dom.max; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
                const di = D.iso(d);
                let name = ''; try { name = d.toLocaleDateString(U.locale(), d.getMonth() === 0 ? { month: 'short', year: 'numeric' } : { month: 'short' }); } catch (e) { /* */ }
                const lab = el('span', 'gantt-tick month', esc(name));
                lab.style.left = x(di) + 'px';
                scale.appendChild(lab);
                const line = el('span', 'gantt-grid'); line.style.left = x(di) + 'px'; inner.appendChild(line);
            }
        }
        inner.appendChild(scale);

        const active = activeId();
        ps.forEach((p) => {
            const lane = el('button', 'gantt-row' + (p.id === active ? ' sel' : ''));
            lane.type = 'button';
            const ms = S.milestonesOf(p), done = ms.filter((m) => m.done).length;
            lane.setAttribute('aria-label', t('{name}, {start} to {end}, {done} of {n} milestones', { name: p.name, start: U.shortDate(p.start), end: U.shortDate(p.end), done, n: ms.length }));
            lane.setAttribute('aria-pressed', String(p.id === active));
            const bar = el('span', 'gantt-bar', `<span class="gantt-label">${esc(p.name)}</span>`);
            bar.style.left = x(p.start) + 'px';
            bar.style.width = Math.max(14, x(p.end) - x(p.start)) + 'px';
            bar.style.background = p.color;
            lane.appendChild(bar);
            ms.forEach((m) => {
                const late = !m.done && m.due < dom.today;
                const dia = el('span', 'gantt-ms' + (m.done ? ' done' : late ? ' late' : ''));
                dia.style.left = x(m.due) + 'px';
                dia.title = `${m.title} · ${U.shortDate(m.due)}`;
                lane.appendChild(dia);
            });
            lane.addEventListener('click', () => {
                S.state.ui.activeProject = p.id; S.persist();
                const card = document.querySelector(`.pl-proj-card[data-project="${CSS.escape(p.id)}"]`);
                if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            });
            inner.appendChild(lane);
        });
        const now = el('span', 'gantt-today'); now.style.left = x(dom.today) + 'px';
        now.appendChild(el('span', 'gantt-today-l', esc(t('Today'))));
        inner.appendChild(now);
        scroller.appendChild(inner);
        box.appendChild(scroller);
        box.appendChild(el('span', 'gantt-fade'));
        // Open on this week; keep the person's own scroll after that.
        const key = zoom() + ':' + dom.min;
        if (scrolledFor !== key) {
            scrolledFor = key;
            requestAnimationFrame(() => { scroller.scrollLeft = Math.max(0, x(dom.today) - 7 * px * (zoom() === 'weeks' ? 1 : 4)); });
        } else if (box.__left != null) scroller.scrollLeft = box.__left;
        scroller.addEventListener('scroll', () => { box.__left = scroller.scrollLeft; }, { passive: true });
    }

    /* ---------------- the cards ---------------- */
    function msRow(p, m) {
        const li = el('li', 'pl-ms-row' + (m.done ? ' done' : ''));
        const today = D.iso(new Date()), late = !m.done && m.due < today;
        const check = el('button', 'todo-check' + (m.done ? ' on' : ''), m.done ? icon('check') : '');
        check.type = 'button';
        check.setAttribute('aria-pressed', String(!!m.done));
        check.setAttribute('aria-label', m.done ? t('Mark “{name}” not done', { name: m.title }) : t('Mark “{name}” done', { name: m.title }));
        check.addEventListener('click', () => S.toggleMilestone(p.id, m.id));
        li.appendChild(check);
        li.appendChild(el('span', 'pl-ms-n', esc(m.title)));
        li.appendChild(el('span', 'pl-ms-d' + (late ? ' pl-late' : ''), esc(late ? `${U.shortDate(m.due)} · ${U.dueText(m.due)}` : U.dayName(m.due, { long: true }))));
        const del = el('button', 'del', icon('x'));
        del.type = 'button';
        del.setAttribute('aria-label', t('Delete milestone “{name}”', { name: m.title }));
        del.addEventListener('click', () => S.deleteWithUndo(S.milestoneKey(p.id, m.id), t('“{name}” deleted', { name: m.title }), () => S.deleteMilestone(p.id, m.id)));
        li.appendChild(del);
        return li;
    }
    function addRow(p) {
        const form = el('form', 'pl-ms-add');
        form.innerHTML = `<input class="pl-ms-title" aria-label="${esc(t('New milestone'))}" placeholder="${esc(t('Add a milestone'))}" autocomplete="off">` +
            `<input class="pl-ms-due" type="date" aria-label="${esc(t('Due date'))}" value="${esc(D.iso(D.addDays(new Date(), 7)))}">` +
            `<button type="submit" class="primary" aria-label="${esc(t('Add milestone'))}">${icon('plus')}</button>`;
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const title = form.querySelector('.pl-ms-title').value.trim();
            if (!title) { form.querySelector('.pl-ms-title').focus(); return; }
            S.addMilestone(p.id, { title, due: form.querySelector('.pl-ms-due').value || D.iso(new Date()) });
            setTimeout(() => { const f = document.querySelector(`.pl-proj-card[data-project="${CSS.escape(p.id)}"] .pl-ms-title`); if (f) f.focus(); }, 0);
        });
        return form;
    }
    function projMenu(p, anchor) {
        const r = anchor.getBoundingClientRect();
        const items = [
            { html: icon('edit') + ' ' + esc(t('Edit project')), onClick: () => openProjectDialog(p) },
            { html: icon('trash') + ' ' + esc(t('Delete…')), danger: true, onClick: async () => {
                const ok = window.MemoShell && window.MemoShell.confirm
                    ? await window.MemoShell.confirm(t('Delete the project “{name}” and its milestones?', { name: p.name }), { okLabel: t('Delete'), danger: true })
                    : true;
                if (ok) S.deleteWithUndo(p.id, t('“{name}” deleted', { name: p.name }), () => S.deleteProject(p.id));
            } },
        ];
        if (window.MemoCtx && window.MemoCtx.showMenu) window.MemoCtx.showMenu(r.right - 8, r.bottom + 4, items);
        else openProjectDialog(p);
    }
    function card(p, open) {
        const ms = S.milestonesOf(p), done = ms.filter((m) => m.done).length;
        const today = D.iso(new Date());
        const c = el('section', 'pl-proj-card' + (open ? ' open' : ''));
        c.dataset.project = p.id;
        c.setAttribute('aria-label', p.name);
        const head = el('div', 'pl-proj-h');
        const toggle = el('button', 'pl-proj-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(open));
        const left = days(today, p.end);
        const when = today < p.start ? t('starts {when}', { when: U.dayName(p.start, { long: true }) })
            : left >= 0 ? (left === 1 ? t('1 day left') : t('{n} days left', { n: left })) : t('ended {when}', { when: U.shortDate(p.end) });
        toggle.innerHTML = `<span class="pl-proj-dot" style="background:${esc(p.color)}"></span><span class="pl-proj-t"><b>${esc(p.name)}</b>` +
            `<span>${esc(U.shortDate(p.start))} → ${esc(U.shortDate(p.end))} · ${esc(when)}</span></span><span class="pl-proj-pr">${esc(t('{done} of {n}', { done, n: ms.length }))}</span>`;
        toggle.addEventListener('click', () => { S.state.ui.activeProject = open ? '__none__' : p.id; S.persist(); });
        head.appendChild(toggle);
        const menu = el('button', 'h-menu', icon('more'));
        menu.type = 'button';
        menu.setAttribute('aria-label', t('{name} options', { name: p.name }));
        menu.setAttribute('aria-haspopup', 'menu');
        menu.addEventListener('click', () => projMenu(p, menu));
        head.appendChild(menu);
        c.appendChild(head);
        const prog = el('div', 'ms-bar');
        prog.setAttribute('role', 'progressbar');
        prog.setAttribute('aria-label', t('{name} milestones done', { name: p.name }));
        prog.setAttribute('aria-valuemin', '0'); prog.setAttribute('aria-valuemax', String(ms.length || 0)); prog.setAttribute('aria-valuenow', String(done));
        const fill = el('span'); fill.style.width = (ms.length ? Math.round(done / ms.length * 100) : 0) + '%'; fill.style.background = p.color;
        prog.appendChild(fill);
        c.appendChild(prog);
        if (open) {
            const list = el('ul', 'pl-ms-list');
            ms.filter((m) => !m.done).concat(ms.filter((m) => m.done)).forEach((m) => list.appendChild(msRow(p, m)));
            c.appendChild(list);
            c.appendChild(addRow(p));
        } else {
            const next = S.nextMilestone(p);
            c.appendChild(el('div', 'pl-proj-next', next
                ? `${esc(t('Next:'))} <b>${esc(next.title)}</b> · <span class="${next.due < today ? 'pl-late' : ''}">${esc(U.dayName(next.due, { long: true }))}</span>`
                : esc(ms.length ? t('All milestones done') : t('No milestones yet'))));
        }
        return c;
    }
    function renderCards() {
        const box = document.getElementById('projCards'); if (!box) return;
        box.innerHTML = '';
        const ps = S.state.projects;
        if (!ps.length) {
            const empty = el('div', 'pl-empty-card');
            empty.innerHTML = `<p>${esc(t('Projects keep a start, an end and milestones. The next milestone of each shows in your to-dos.'))}</p>`;
            const b = el('button', 'primary', esc(t('New project')));
            b.type = 'button';
            b.addEventListener('click', () => openProjectDialog());
            empty.appendChild(b);
            box.appendChild(empty);
            return;
        }
        const active = S.state.ui.activeProject === '__none__' ? null : activeId();
        ps.forEach((p) => box.appendChild(card(p, p.id === active)));
    }

    /* ---------------- project dialog (new or edit) ---------------- */
    let pjColor = S.COLORS[0], editingProjectId = null;
    function buildSwatches(container, selected, onPick) {
        container.innerHTML = '';
        container.setAttribute('role', 'radiogroup');
        container.setAttribute('aria-label', t('Project colour'));
        S.COLORS.forEach((c, index) => {
            const checked = c === selected;
            const sw = el('button', 'sw' + (checked ? ' on' : ''));
            sw.type = 'button';
            sw.style.background = c;
            sw.setAttribute('role', 'radio');
            sw.setAttribute('aria-label', t('Colour {n}', { n: index + 1 }));
            sw.setAttribute('aria-checked', String(checked));
            sw.tabIndex = checked ? 0 : -1;
            sw.addEventListener('click', () => {
                container.querySelectorAll('.sw').forEach((x) => {
                    x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); x.tabIndex = -1;
                });
                sw.classList.add('on'); onPick(c);
                sw.setAttribute('aria-checked', 'true'); sw.tabIndex = 0;
            });
            sw.addEventListener('keydown', (event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                const swatches = [...container.querySelectorAll('.sw')];
                const current = swatches.indexOf(sw);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? swatches.length - 1
                    : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + swatches.length) % swatches.length;
                event.preventDefault();
                swatches[next].click();
                swatches[next].focus();
            });
            container.appendChild(sw);
        });
    }
    function openProjectDialog(p) {
        const dlg = document.getElementById('projectDlg');
        const today = new Date();
        editingProjectId = p && p.id ? p.id : null;
        const title = dlg.querySelector('header strong'); if (title) title.textContent = editingProjectId ? t('Edit project') : t('New project');
        const save = dlg.querySelector('footer .primary'); if (save) save.textContent = editingProjectId ? t('Save') : t('Create');
        document.getElementById('pjName').value = p ? p.name : '';
        document.getElementById('pjStart').value = p ? p.start : D.iso(today);
        document.getElementById('pjEnd').value = p ? p.end : D.iso(D.addDays(today, 30));
        pjColor = p ? p.color : S.COLORS[S.state.projects.length % S.COLORS.length];
        buildSwatches(document.getElementById('pjSwatches'), pjColor, (c) => pjColor = c);
        dlg.showModal();
        // A new project starts at its name, like a new event or habit.
        if (!editingProjectId) document.getElementById('pjName').focus({ preventScroll: true });
    }

    function mount() {
        document.getElementById('addProjectBtn').addEventListener('click', () => openProjectDialog());
        document.querySelectorAll('#projZoom button').forEach((b) => b.addEventListener('click', () => { S.state.ui.projZoom = b.dataset.zoom; S.persist(); }));
        document.getElementById('projectDlg').addEventListener('close', function () {
            const id = editingProjectId; editingProjectId = null;
            if (this.returnValue !== 'save') return;
            const name = document.getElementById('pjName').value.trim();
            if (!name) return;
            let start = document.getElementById('pjStart').value || D.iso(new Date());
            let end = document.getElementById('pjEnd').value || start;
            if (end < start) { const x = start; start = end; end = x; }
            const data = { name, color: pjColor, start, end };
            if (id) S.updateProject(id, data); else S.addProject(data);
        });
    }

    function render() {
        document.querySelectorAll('#projZoom button').forEach((b) => {
            const on = b.dataset.zoom === zoom();
            b.classList.toggle('active', on); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on));
        });
        renderTimeline(); renderCards();
    }

    P.Projects = { mount, render, openProjectDialog };
})();
