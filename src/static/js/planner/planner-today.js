/* planner-today.js — the Today tab: today's events with a "now" line, what is
   due (overdue first), today's habits with one-tap logging, and what is coming
   up over the next week. Every row opens the thing it shows. */
(function () {
    'use strict';
    const P = window.Planner, S = P.Store, U = P.UI;
    const { t, esc, el, icon } = U;
    const UPCOMING_DAYS = 7, UPCOMING_MAX = 8;

    function minutes(hhmm) { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); }
    function untilText(mins) {
        if (mins < 60) return t('in {n} min', { n: mins });
        const h = Math.floor(mins / 60), m = mins % 60;
        return m ? t('in {h} h {m} min', { h, m }) : t('in {h} h', { h });
    }

    function eventRow(e, nowMin, isToday) {
        const past = isToday && !e.allDay && minutes(e.end || e.start) <= nowMin;
        const b = el('button', 'pl-ev-row' + (past ? ' past' : ''));
        b.type = 'button';
        const time = e.allDay ? t('All day') : `${e.start}–${e.end}`;
        let meta = '';
        if (isToday && !e.allDay && !past) {
            const s = minutes(e.start);
            meta = s > nowMin ? untilText(s - nowMin) : t('Now');
        }
        if (S.isRepeating(e)) meta = (meta ? meta + ' · ' : '') + t('Repeats');
        b.innerHTML = `<span class="pl-ev-t">${esc(time)}</span><span class="pl-ev-bar" style="background:${esc(e.color || '#60a5fa')}"></span>` +
            `<span class="pl-ev-main"><span class="pl-ev-n">${esc(e.title)}</span>${meta ? `<span class="pl-ev-m">${esc(meta)}</span>` : ''}</span>`;
        b.addEventListener('click', () => P.Calendar.openEventDialog(e));
        return b;
    }

    function todoRow(item) {
        const li = el('div', 'pl-due-row');
        const check = el('button', 'todo-check');
        check.type = 'button';
        check.setAttribute('aria-label', t('Mark “{name}” done', { name: item.title }));
        check.addEventListener('click', () => { if (item.kind === 'milestone') S.toggleMilestone(item.projectId, item.id); else S.toggleTodo(item.id); });
        const late = item.due && U.daysFromToday(item.due) < 0;
        const main = el('button', 'pl-due-main');
        main.type = 'button';
        const proj = item.kind === 'milestone' ? `<span class="pl-proj-name" style="color:${esc(item.color)}">${esc(item.projectName)}</span> · ` : '';
        main.innerHTML = `<span class="pl-due-n">${esc(item.title)}</span><span class="pl-due-m">${proj}<span class="${late ? 'pl-late' : ''}">${esc(U.dueText(item.due) || t('No date'))}</span></span>`;
        main.addEventListener('click', () => {
            if (item.kind === 'milestone') { S.state.ui.activeProject = item.projectId; P.setTab('projects'); }
            else { S.state.ui.todoEditing = item.id; P.setTab('todos'); }
        });
        li.appendChild(check); li.appendChild(main);
        if (item.priority === 'high') li.appendChild(el('span', 'pill high', esc(t('high'))));
        return li;
    }

    function habitButton(h) {
        const done = S.isHabitDoneToday(h);
        if (h.type === 'count') {
            const n = S.habitCountToday(h);
            const b = el('button', 'pl-hb' + (n ? ' done' : ''));
            b.type = 'button';
            b.innerHTML = `${esc(h.name)} · <b>${n}</b> <span class="pl-hb-plus" aria-hidden="true">＋</span>`;
            b.setAttribute('aria-label', t('Add one to {name}, now {n}', { name: h.name, n }));
            b.addEventListener('click', () => S.logHabit(h.id));
            return b;
        }
        const b = el('button', 'pl-hb' + (done ? ' done' : ''));
        b.type = 'button';
        b.setAttribute('aria-pressed', String(done));
        const avg = h.type === 'timer' && done ? (S.state.habits.find((x) => x.id === h.id).logs || []).find((l) => l.date === U.todayIso()) : null;
        const extra = avg && avg.durationMin ? ` · ${avg.durationMin} min` : '';
        b.innerHTML = `<span class="pl-hb-k">${done ? icon('check') : ''}</span>${esc(h.name)}${esc(extra)}`;
        b.addEventListener('click', () => {
            if (h.type === 'timer' && !done) { P.setTab('habits'); return; }
            done ? S.unlogHabitToday(h.id) : S.logHabit(h.id);
        });
        return b;
    }

    function upcoming() {
        const out = [];
        const todos = S.derivedTodos().filter((x) => !x.done && x.due);
        const seen = new Set();   // a repeating event shows once: its next time
        for (let i = 1; i <= UPCOMING_DAYS && out.length < UPCOMING_MAX; i++) {
            const day = U.iso(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + i));
            S.eventsForDate(day).forEach((e) => {
                if (S.isRepeating(e)) { if (seen.has(e.id)) return; seen.add(e.id); }
                out.push({ day, kind: 'event', e });
            });
            todos.filter((x) => x.due === day).forEach((x) => out.push({ day, kind: 'todo', x }));
        }
        return out.slice(0, UPCOMING_MAX);
    }
    function upRow(u) {
        const d = U.parse(u.day);
        const b = el('button', 'pl-up-row');
        b.type = 'button';
        const label = `<span class="pl-up-d">${esc(U.weekdayShort(d).toUpperCase())}<b>${d.getDate()}</b></span>`;
        if (u.kind === 'event') {
            const rep = S.isRepeating(u.e) ? ` <span class="pl-up-rep">${U.icon('repeat')}</span>` : '';
            b.innerHTML = label + `<span class="pl-up-n"><span class="pl-dot" style="background:${esc(u.e.color || '#60a5fa')}"></span>${esc(u.e.title)}${rep}</span>` +
                `<span class="pl-up-tm">${esc(u.e.allDay ? t('All day') : u.e.start)}</span>`;
            b.addEventListener('click', () => P.Calendar.openEventDialog(u.e));
        } else {
            const proj = u.x.kind === 'milestone' ? ' · ' + u.x.projectName : '';
            b.innerHTML = label + `<span class="pl-up-n"><span class="pl-sq" aria-hidden="true"></span>${esc(u.x.title + proj)}</span><span class="pl-up-tm"></span>`;
            b.addEventListener('click', () => {
                if (u.x.kind === 'milestone') { S.state.ui.activeProject = u.x.projectId; P.setTab('projects'); }
                else { S.state.ui.todoEditing = u.x.id; P.setTab('todos'); }
            });
        }
        return b;
    }

    function render() {
        const body = document.getElementById('todayBody'); if (!body) return;
        const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
        const today = U.todayIso();
        body.innerHTML = '';

        // Today
        const card = el('section', 'pl-card pl-today-card');
        card.setAttribute('aria-labelledby', 'plTodayH');
        const head = el('div', 'pl-card-h');
        head.innerHTML = `<h2 id="plTodayH">${esc(t('Today'))} · ${esc(U.dayName(today, { long: true }))}</h2>`;
        const add = el('button', 'pl-add', icon('plus') + `<span class="pl-add-l">${esc(t('Add'))}</span>`);
        add.type = 'button';
        add.addEventListener('click', async () => {
            const pick = window.MemoShell && window.MemoShell.choose
                ? await window.MemoShell.choose(t('Add to today'), { okLabel: t('Event'), okValue: 'event', secondaryLabel: t('To-do'), secondaryValue: 'todo' })
                : 'event';
            if (pick === 'event') P.Calendar.openEventDialog({ date: today });
            else if (pick === 'todo') { P.setTab('todos'); setTimeout(() => { const i = document.getElementById('todoInput'); if (i) i.focus(); }, 60); }
        });
        head.appendChild(add);
        card.appendChild(head);

        const events = S.eventsForDate(today);
        if (!events.length) card.appendChild(el('p', 'pl-empty', esc(t('Nothing scheduled today.'))));
        let lineDone = false;
        events.forEach((e) => {
            if (!lineDone && !e.allDay && minutes(e.start) > nowMin) {
                card.appendChild(el('div', 'pl-now', esc(t('Now {time}', { time: S.Dates.hhmm(nowMin) }))));
                lineDone = true;
            }
            card.appendChild(eventRow(e, nowMin, true));
        });
        if (events.length && !lineDone) card.appendChild(el('div', 'pl-now', esc(t('Now {time}', { time: S.Dates.hhmm(nowMin) }))));

        const due = S.derivedTodos().filter((x) => !x.done && x.due && x.due <= today)
            .sort((a, b) => String(a.due).localeCompare(String(b.due)) || ((b.priority === 'high') - (a.priority === 'high')));
        if (due.length) {
            card.appendChild(el('div', 'pl-sub', esc(t('Due'))));
            due.forEach((x) => card.appendChild(todoRow(x)));
        }
        const habits = S.state.habits.filter((h) => S.habitDays(h).indexOf((now.getDay() + 6) % 7) >= 0);
        if (habits.length) {
            card.appendChild(el('div', 'pl-sub', esc(t('Habits today'))));
            const row = el('div', 'pl-hb-row');
            habits.forEach((h) => row.appendChild(habitButton(h)));
            card.appendChild(row);
        }
        body.appendChild(card);

        // Coming up
        const up = upcoming();
        const upCard = el('section', 'pl-card pl-up-card');
        upCard.setAttribute('aria-labelledby', 'plUpH');
        upCard.appendChild(el('div', 'pl-card-h', `<h2 id="plUpH">${esc(t('Coming up'))}</h2>`));
        if (!up.length) upCard.appendChild(el('p', 'pl-empty', esc(t('Nothing in the next 7 days.'))));
        up.forEach((u) => upCard.appendChild(upRow(u)));
        const more = el('button', 'pl-more-link', esc(t('Open the calendar')) + ' ›');
        more.type = 'button';
        more.addEventListener('click', () => P.setTab('calendar'));
        upCard.appendChild(more);
        body.appendChild(upCard);
    }

    function mount() {}
    P.Today = { mount, render };
})();
