/* planner-habits.js — habit cards (tick / count / timer) + setup dialog.
   Add-to-calendar lives in the event dialog now (pick a habit there). */
(function () {
    'use strict';
    const P = window.Planner, S = P.Store;
    const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

    // running timers: { habitId: { start: ms, interval: id } }
    const timers = {};

    function fmtDur(min) { if (!min) return '—'; return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`; }
    function fmtClock(sec) {
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    const U = P.UI, t = U.t;

    // The week, one circle per day: tap a past day to tick it if you forgot;
    // dashed days are rest days; later days wait.
    function weekDots(h) {
        const wrap = el('div', 'week-dots');
        const prog = S.habitWeekProgress(h);
        const days = S.habitDays(h), today = U.todayIso();
        const long = Array.from({ length: 7 }, (_, i) => { try { return S.Dates.addDays(S.Dates.startOfWeek(new Date()), i).toLocaleDateString(U.locale(), { weekday: 'long' }); } catch (e) { return ''; } });
        for (let i = 0; i < 7; i++) {
            const day = prog.days[i];
            const isTarget = days.includes(i);
            const isDone = prog.doneDays.includes(day);
            const future = day > today;
            const wd = el('button', 'week-dot' + (isTarget ? ' target' : ' off') + (isDone ? ' done' : '') + (day === today ? ' today' : '') + (future ? ' future' : ''));
            wd.type = 'button';
            wd.disabled = future;
            wd.setAttribute('aria-pressed', String(isDone));
            wd.setAttribute('aria-label', `${long[i]}${day === today ? ', ' + t('today') : ''}: ${isDone ? t('done') : isTarget ? t('not done') : t('rest day')}`);
            const d = el('span', 'd', isDone ? '<span class="svg-icon svg-icon-check"></span>' : '');
            if (isDone) d.style.background = h.color;
            wd.appendChild(d);
            wd.appendChild(el('span', 'wd', esc(DOW[i])));
            // Cards are patched in place and keep their first listeners, so
            // read the day and its state at tap time, not from this render.
            wd.dataset.day = day;
            wd.addEventListener('click', () => {
                const d = wd.dataset.day, current = S.habitById(h.id);
                if (!current || !d || d > U.todayIso()) return;
                S.setHabitDoneOn(h.id, d, !S.isHabitDoneOn(current, d));
            });
            wrap.appendChild(wd);
        }
        return wrap;
    }

    function actionArea(h) {
        const area = el('div', 'habit-actions');
        const running = timers[h.id];

        if (h.type === 'timer' && running) {
            const disp = el('div', 'h-main timer-display'); disp.id = 'timer-' + h.id;
            disp.textContent = fmtClock(Math.floor((Date.now() - running.start) / 1000));
            const stop = el('button', 'h-del stop', '<span class="svg-icon svg-icon-stop"></span> ' + esc(t('Stop')));
            stop.addEventListener('click', () => stopTimer(S.habitById(h.id)));
            area.appendChild(disp); area.appendChild(stop);
            return area;
        }

        if (h.type === 'timer') {
            const start = el('button', 'h-main', '<span class="svg-icon svg-icon-play"></span> ' + esc(t('Start')));
            start.setAttribute('aria-label', t('Start timer for {name}', { name: h.name }));
            start.addEventListener('click', () => startTimer(S.habitById(h.id)));
            area.appendChild(start);
        } else if (h.type === 'count') {
            const n = S.habitCountToday(h);
            const step = el('div', 'h-step');
            const minus = el('button', 'step-btn', '−');
            minus.setAttribute('aria-label', t('One less {name}', { name: h.name }));
            minus.addEventListener('click', () => S.decrementHabit(h.id));
            const val = el('span', 'val', String(n));
            val.setAttribute('aria-label', t('{n} today', { n }));
            const plus = el('button', 'step-btn', '＋');
            plus.setAttribute('aria-label', t('One more {name}', { name: h.name }));
            plus.addEventListener('click', () => S.logHabit(h.id));
            step.appendChild(minus); step.appendChild(val); step.appendChild(plus);
            area.appendChild(step);
        } else { // check — a tickbox button that greys out when done
            const done = S.isHabitDoneToday(h);
            const btn = el('button', 'h-main h-check' + (done ? ' done' : ''),
                `<span class="box">${done ? '<span class="svg-icon svg-icon-check"></span>' : ''}</span><span>${esc(done ? t('Done') : t('Mark done'))}</span>`);
            btn.setAttribute('aria-pressed', String(done));
            btn.setAttribute('aria-label', (done ? t('Mark {name} not done today', { name: h.name }) : t('Mark {name} done today', { name: h.name })));
            btn.addEventListener('click', () => {
                const current = S.habitById(h.id);
                if (current) S.isHabitDoneToday(current) ? S.unlogHabitToday(h.id) : S.logHabit(h.id);
            });
            area.appendChild(btn);
        }
        return area;
    }

    function startTimer(h) {
        if (timers[h.id]) return;
        timers[h.id] = { start: Date.now(), interval: setInterval(() => {
            const disp = document.getElementById('timer-' + h.id);
            if (disp) disp.textContent = fmtClock(Math.floor((Date.now() - timers[h.id].start) / 1000));
        }, 1000) };
        S.emit('change', { habitTimer: h.id });
    }
    function stopTimer(h) {
        const tm = timers[h.id]; if (!tm) return;
        clearInterval(tm.interval);
        const min = Math.max(1, Math.round((Date.now() - tm.start) / 60000));
        delete timers[h.id];
        S.logHabit(h.id, min); // persists + re-renders
    }
    function releaseTimers() {
        Object.keys(timers).forEach((id) => {
            clearInterval(timers[id].interval);
            delete timers[id];
        });
    }

    function openMenu(h, anchor) {
        const r = anchor.getBoundingClientRect();
        const items = [
            { html: '<span class="svg-icon svg-icon-edit"></span> ' + esc(t('Edit habit')), onClick: () => openHabitDialog(S.habitById(h.id)) },
            { html: '<span class="svg-icon svg-icon-trash"></span> ' + esc(t('Delete…')), danger: true, onClick: async () => {
                const current = S.habitById(h.id); if (!current) return;
                const ok = window.MemoShell && window.MemoShell.confirm
                    ? await window.MemoShell.confirm(t('Delete the habit “{name}” and its history?', { name: current.name }), { okLabel: t('Delete'), danger: true })
                    : true;
                if (ok) S.deleteWithUndo(h.id, t('“{name}” deleted', { name: current.name }), () => S.deleteHabit(h.id));
            } },
        ];
        if (window.MemoCtx && window.MemoCtx.showMenu) window.MemoCtx.showMenu(r.right - 8, r.bottom + 4, items);
        else openHabitDialog(S.habitById(h.id));
    }

    function card(h) {
        const c = el('div', 'habit-card');
        c.style.setProperty('--hb', h.color || '#60a5fa');
        const top = el('div', 'habit-top');
        top.appendChild(el('span', 'habit-dot'));
        const name = el('button', 'habit-name-btn');
        name.type = 'button';
        const prog = S.habitWeekProgress(h);
        const avg = S.habitAvgMin(h);
        const sub = [t('{done} of {target} days', { done: prog.done, target: prog.target })];
        if (h.type === 'timer' && avg) sub.push(t('avg {time}', { time: fmtDur(avg) }));
        if (h.type === 'count') sub.push(t('counts'));
        name.innerHTML = `<span class="habit-name">${esc(h.name)}</span><span class="habit-sub">${esc(sub.join(' · '))}</span>`;
        name.setAttribute('aria-label', t('Edit habit {name}', { name: h.name }));
        name.addEventListener('click', () => openHabitDialog(S.habitById(h.id)));
        top.appendChild(name);
        const ring = el('span', 'progress-ring', `<b>${prog.done}</b><span class="muted">/${prog.target}</span>`);
        ring.setAttribute('role', 'progressbar');
        ring.setAttribute('aria-label', t('{name} this week', { name: h.name }));
        ring.setAttribute('aria-valuemin', '0');
        ring.setAttribute('aria-valuemax', String(prog.target));
        ring.setAttribute('aria-valuenow', String(prog.done));
        ring.setAttribute('aria-valuetext', t('{done} of {target} days', { done: prog.done, target: prog.target }));
        top.appendChild(ring);
        const menu = el('button', 'h-menu', '<span class="svg-icon svg-icon-more"></span>');
        menu.type = 'button';
        menu.setAttribute('aria-label', t('{name} options', { name: h.name }));
        menu.setAttribute('aria-haspopup', 'menu');
        menu.addEventListener('click', (e) => { e.stopPropagation(); openMenu(h, menu); });
        top.appendChild(menu);
        c.appendChild(top);
        const rowEl = el('div', 'habit-row');
        rowEl.appendChild(weekDots(h));
        rowEl.appendChild(actionArea(h));
        c.appendChild(rowEl);
        return c;
    }

    const cardCache = new Map();
    function render() {
        const grid = document.getElementById('habitsGrid');
        const desired = S.state.habits.map(h => {
          const signature = h.type + ':' + !!timers[h.id];
          const fresh = card(h); fresh.dataset.habitId = h.id;
          const cached = cardCache.get(h.id);
          const node = cached && cached.signature === signature ? window.MemoDom.patch(cached.node, fresh) : fresh;
          cardCache.set(h.id, { node, signature }); return node;
        });
        for (const [id, cached] of cardCache) if (!desired.includes(cached.node)) cardCache.delete(id);
        const add = grid.querySelector('.add-card') || (() => {
            const a = el('button', 'habit-card add-card', '<span class="svg-icon svg-icon-plus"></span><span>' + esc(t('New habit')) + '</span>');
            a.type = 'button';
            a.addEventListener('click', () => openHabitDialog());
            return a;
        })();
        desired.push(add);
        window.MemoDom.reconcile(grid, desired);
    }

    /* ---------------- setup dialog (also used for editing) ---------------- */
    let hbType = 'check', hbDays = [0, 1, 2, 3, 4], hbColor = S.COLORS[0], editingHabitId = null;
    function openHabitDialog(habit) {
        const dlg = document.getElementById('habitDlg');
        editingHabitId = habit && habit.id ? habit.id : null;
        if (editingHabitId) {
            hbType = habit.type || 'check'; hbDays = S.habitDays(habit).slice(); hbColor = habit.color;
            document.getElementById('hbName').value = habit.name;
        } else {
            hbType = 'check'; hbDays = [0, 1, 2, 3, 4]; hbColor = S.COLORS[S.state.habits.length % S.COLORS.length];
            document.getElementById('hbName').value = '';
        }
        document.getElementById('habitDlgTitle').textContent = editingHabitId ? 'Edit habit' : 'New habit';
        document.getElementById('hbSaveBtn').textContent = editingHabitId ? 'Save' : 'Create habit';
        syncType(); syncDays(); syncSwatch();
        dlg.showModal();
        document.getElementById('hbName').focus({ preventScroll: true });
    }
    function syncType() {
        document.querySelectorAll('#hbType button').forEach((b) => {
            const selected = b.dataset.type === hbType;
            b.classList.toggle('on', selected);
            b.setAttribute('aria-checked', String(selected));
            b.tabIndex = selected ? 0 : -1;
        });
    }
    function syncDays() {
        document.querySelectorAll('#hbDays button').forEach((b) => {
            const selected = hbDays.includes(+b.dataset.day);
            b.classList.toggle('on', selected);
            b.setAttribute('aria-pressed', String(selected));
        });
    }
    function syncSwatch() {
        document.querySelectorAll('#hbSwatches .sw').forEach((x) => {
            const selected = x.dataset.c === hbColor;
            x.classList.toggle('on', selected);
            x.setAttribute('aria-checked', String(selected));
            x.tabIndex = selected ? 0 : -1;
        });
    }

    function mountDialog() {
        const days = document.getElementById('hbDays');
        const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        days.setAttribute('role', 'group');
        days.setAttribute('aria-label', 'Target days');
        dayNames.forEach((name, i) => {
            const lbl = name.slice(0, 3);
            const b = el('button', i === 6 ? 'sun' : null, lbl.slice(0, 1)); b.type = 'button'; b.dataset.day = i;
            b.setAttribute('aria-label', name);
            b.addEventListener('click', () => {
                // Guard: some WebViews (seen on the S25 / Samsung) dispatch TWO click
                // events for a single tap, which toggles the day twice and leaves it
                // unchanged — "tapped to cancel but still highlighted". Collapse a
                // rapid repeat on the same button into one toggle.
                const now = Date.now();
                if (now - (b.__lastToggle || 0) < 120) return;
                b.__lastToggle = now;
                if (hbDays.includes(i)) hbDays = hbDays.filter((x) => x !== i); else hbDays.push(i);
                syncDays();
            });
            days.appendChild(b);
        });
        const types = document.getElementById('hbType');
        types.setAttribute('role', 'radiogroup');
        types.setAttribute('aria-label', 'Habit type');
        document.querySelectorAll('#hbType button').forEach((b) => {
            b.setAttribute('role', 'radio');
            b.addEventListener('click', () => { hbType = b.dataset.type; syncType(); });
        });
        types.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            const buttons = [...types.querySelectorAll('[role="radio"]')];
            const current = buttons.indexOf(event.target.closest('[role="radio"]'));
            if (current < 0) return;
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
            event.preventDefault(); buttons[next].click(); buttons[next].focus();
        });
        const sw = document.getElementById('hbSwatches');
        sw.setAttribute('role', 'radiogroup');
        sw.setAttribute('aria-label', 'Habit color');
        S.COLORS.forEach((c, index) => {
            const s = el('button', 'sw'); s.type = 'button'; s.style.background = c; s.dataset.c = c;
            s.setAttribute('role', 'radio'); s.setAttribute('aria-label', 'Color ' + (index + 1));
            s.addEventListener('click', () => { hbColor = c; syncSwatch(); });
            s.addEventListener('keydown', (event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                const swatches = [...sw.querySelectorAll('.sw')];
                const current = swatches.indexOf(s);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? swatches.length - 1
                    : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + swatches.length) % swatches.length;
                event.preventDefault(); swatches[next].click(); swatches[next].focus();
            });
            sw.appendChild(s);
        });
        syncType(); syncDays(); syncSwatch();
        document.getElementById('habitDlg').addEventListener('close', function () {
            if (this.returnValue !== 'save') { editingHabitId = null; return; }
            const name = document.getElementById('hbName').value.trim();
            if (!name) { editingHabitId = null; return; }
            const data = {
                name, color: hbColor, type: hbType,
                targetDays: hbDays.slice().sort((a, b) => a - b),
                timesPerWeek: Math.max(1, hbDays.length),
                unit: 'time',
            };
            if (editingHabitId) S.updateHabit(editingHabitId, data); else S.addHabit(data);
            editingHabitId = null;
        });
    }

    function mount() {
        mountDialog();
        const addBtn = document.getElementById('addHabitBtn');
        if (addBtn) addBtn.addEventListener('click', () => openHabitDialog());
        window.addEventListener('pagehide', function (event) {
            if (window.MemoLifecycle?.retain(event) || (event && event.persisted)) return;
            releaseTimers();
        });
    }

    P.Habits = { mount, render };
})();
