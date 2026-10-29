/* planner-calendar.js — day / 3-day or week / month / year views, the selected
   day's plans under the month, and the event sheet (repeat, length, reminder). */
(function () {
    'use strict';
    const P = window.Planner, S = P.Store, D = S.Dates, U = P.UI;
    const { t, esc, el } = U;
    // press-and-hold to add (mirrors ImageDB's add-card ring)
    const HOLD_RING_DELAY = 180;   // dead time: a quick tap never flashes the ring
    const HOLD_FILL_MS = 480;      // ring fill duration — must match CSS animation

    const cursor = () => D.parseISO(S.state.ui.calCursor);
    const setCursor = (d) => { S.state.ui.calCursor = D.iso(d); };
    const narrow = () => (P.narrow ? P.narrow() : window.matchMedia('(max-width: 640px)').matches);
    // On a phone held upright the week view shows three days at a time.
    const weekSpan = () => (narrow() ? 3 : 7);
    function monthName(m, len) { try { return new Date(2026, m, 1).toLocaleDateString(U.locale(), { month: len || 'long' }); } catch (e) { return ''; } }
    function dowNames(len) { const mon = new Date(2026, 9, 19); return Array.from({ length: 7 }, (_, i) => { try { return D.addDays(mon, i).toLocaleDateString(U.locale(), { weekday: len || 'short' }); } catch (e) { return ''; } }); }

    /* build the SVG border-progress ring that fills during a hold */
    function makeHoldRing() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cal-hold'); svg.setAttribute('aria-hidden', 'true');
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('class', 'rfill');
        r.setAttribute('x', '1.5'); r.setAttribute('y', '1.5');
        r.setAttribute('width', '97%'); r.setAttribute('height', '94%');
        r.setAttribute('rx', '9'); r.setAttribute('ry', '9'); r.setAttribute('pathLength', '100');
        svg.appendChild(r);
        return svg;
    }
    /* tap = tapFn(); hold past the grace+fill = holdFn(). Swallows the trailing
       click so a fired hold never also triggers the tap. Works for mouse + touch. */
    function attachHold(elm, ring, holdFn, tapFn) {
        let ringTimer = null, holdTimer = null, origin = null, firedAt = 0;
        const start = () => ring.classList.add('running');
        const reset = () => { ring.classList.remove('running'); void ring.getBoundingClientRect(); };
        const cancel = () => { clearTimeout(ringTimer); clearTimeout(holdTimer); origin = null; reset(); };
        elm.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;
            origin = { x: e.clientX, y: e.clientY };
            ringTimer = setTimeout(() => {
                start();
                holdTimer = setTimeout(() => { firedAt = Date.now(); reset(); origin = null; holdFn(); }, HOLD_FILL_MS);
            }, HOLD_RING_DELAY);
        });
        elm.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') cancel(); });
        elm.addEventListener('pointercancel', cancel);
        elm.addEventListener('pointermove', (e) => {
            if (!origin) return;
            const dx = e.clientX - origin.x, dy = e.clientY - origin.y;
            if (dx * dx + dy * dy > 100) cancel();   // moved → scroll/drag, not a hold
        });
        elm.addEventListener('touchend', cancel);
        elm.addEventListener('click', (e) => {
            if (Date.now() - firedAt < 700) { e.preventDefault(); e.stopPropagation(); return; }
            tapFn();
        });
        elm.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            tapFn();
        });
    }

    function wireRovingGrid(grid, selector, columns, preferred) {
        const cells = [...grid.querySelectorAll(selector)];
        if (!cells.length) return;
        const initial = preferred && cells.includes(preferred) ? preferred : cells[0];
        cells.forEach((cell) => { cell.tabIndex = cell === initial ? 0 : -1; });
        grid.addEventListener('keydown', (event) => {
            const current = event.target.closest(selector);
            const index = cells.indexOf(current);
            if (index < 0) return;
            let next = index;
            if (event.key === 'ArrowRight') next = Math.min(cells.length - 1, index + 1);
            else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
            else if (event.key === 'ArrowDown') next = Math.min(cells.length - 1, index + columns);
            else if (event.key === 'ArrowUp') next = Math.max(0, index - columns);
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = cells.length - 1;
            else return;
            event.preventDefault();
            current.tabIndex = -1;
            cells[next].tabIndex = 0;
            cells[next].focus({ preventScroll: true });
        });
    }

    /* ---------------- navigation ---------------- */
    let motionDirection = 0, navigationAnimation = null;
    function weekDays() {
        const d = cursor();
        return weekSpan() === 7 ? Array.from({ length: 7 }, (_, i) => D.addDays(D.startOfWeek(d), i))
            : Array.from({ length: 3 }, (_, i) => D.addDays(d, i));
    }
    function shift(dir) {
        motionDirection = dir;
        const r = S.state.ui.calRange, d = cursor();
        if (r === 'day') setCursor(D.addDays(d, dir));
        else if (r === 'week') setCursor(D.addDays(d, dir * weekSpan()));
        else if (r === 'month') setCursor(new Date(d.getFullYear(), d.getMonth() + dir, 1));
        else setCursor(new Date(d.getFullYear() + dir, d.getMonth(), 1));
        S.persist();
    }
    function setRange(r) { motionDirection = 1; S.state.ui.calRange = r; S.persist(); }
    function goToday() { setCursor(new Date()); S.state.ui.calSelected = D.iso(new Date()); S.persist(); }

    function label() {
        const d = cursor(), r = S.state.ui.calRange;
        if (r === 'year') return String(d.getFullYear());
        if (r === 'month') { try { return d.toLocaleDateString(U.locale(), { month: 'long', year: 'numeric' }); } catch (e) { return ''; } }
        if (r === 'week') {
            const days = weekDays(), a = days[0], b = days[days.length - 1];
            return a.getMonth() === b.getMonth() ? `${U.shortDate(D.iso(a))} – ${b.getDate()}` : `${U.shortDate(D.iso(a))} – ${U.shortDate(D.iso(b))}`;
        }
        return U.dayName(D.iso(d), { long: true });
    }

    /* ---------------- month view ---------------- */
    function dueOn(isoDate) { return S.derivedTodos().filter((x) => !x.done && x.due === isoDate); }
    function selectedDay() {
        const sel = S.state.ui.calSelected, d = cursor();
        if (sel && D.parseISO(sel).getMonth() === d.getMonth() && D.parseISO(sel).getFullYear() === d.getFullYear()) return sel;
        const today = new Date();
        return today.getMonth() === d.getMonth() && today.getFullYear() === d.getFullYear() ? D.iso(today) : D.iso(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    function renderMonth(body) {
        const d = cursor(), y = d.getFullYear(), m = d.getMonth();
        const grid = el('div', 'cal-month-grid');
        grid.setAttribute('role', 'grid');
        grid.setAttribute('aria-label', label());
        grid.setAttribute('aria-colcount', '7');
        grid.setAttribute('aria-rowcount', '6');
        dowNames('short').forEach((w) => { const heading = el('div', 'cal-dow', esc(w)); heading.setAttribute('role', 'columnheader'); grid.appendChild(heading); });
        const first = new Date(y, m, 1);
        const start = D.startOfWeek(first);
        const todayIso = D.iso(new Date());
        const sel = selectedDay();
        for (let i = 0; i < 42; i++) {
            const day = D.addDays(start, i), di = D.iso(day);
            const evs = S.eventsForDate(di), todos = dueOn(di);
            const cell = el('div', 'cal-day');
            cell.title = t('Tap to see the day · hold to add an event');
            cell.setAttribute('role', 'gridcell');
            cell.dataset.date = di;
            const n = evs.length + todos.length;
            cell.setAttribute('aria-label', `${U.dayName(di, { long: true })}, ${n === 1 ? t('1 thing') : t('{n} things', { n })}`);
            cell.setAttribute('aria-selected', String(di === sel));
            if (day.getMonth() !== m) cell.classList.add('out');
            if (di === todayIso) cell.classList.add('today');
            if (di === sel) cell.classList.add('sel');
            if ((day.getDay() + 6) % 7 >= 5) cell.classList.add('wkend');
            const ring = makeHoldRing(); cell.appendChild(ring);
            cell.appendChild(el('div', 'dnum', String(day.getDate())));
            if (n) {
                const dots = el('div', 'dots');
                evs.slice(0, 3).forEach((e) => { const dot = el('span', 'dot'); dot.style.background = e.color; dots.appendChild(dot); });
                if (todos.length && dots.children.length < 4) dots.appendChild(el('span', 'dot dot-todo'));
                cell.appendChild(dots);
            }
            // tap → that day's plans below (tap it again → its day view); hold → add an event
            attachHold(cell, ring, () => openEventDialog({ date: di }), () => {
                if (di === sel) { setCursor(day); setRange('day'); return; }
                S.state.ui.calSelected = di;
                if (day.getMonth() !== m) setCursor(new Date(day.getFullYear(), day.getMonth(), 1));
                S.persist();
            });
            grid.appendChild(cell);
        }
        wireRovingGrid(grid, '.cal-day', 7, grid.querySelector('.cal-day.sel') || grid.querySelector('.cal-day.today'));
        body.appendChild(grid);
    }
    function renderAgenda() {
        const box = document.getElementById('calAgenda'); if (!box) return;
        box.innerHTML = '';
        if (S.state.ui.calRange !== 'month') { box.hidden = true; return; }
        box.hidden = false;
        const di = selectedDay();
        const evs = S.eventsForDate(di), todos = dueOn(di);
        const head = el('div', 'pl-agenda-h');
        head.innerHTML = `<h3>${esc(U.dayName(di, { long: true }))}</h3><span class="muted">${esc((evs.length + todos.length) === 1 ? t('1 thing') : t('{n} things', { n: evs.length + todos.length }))}</span>`;
        box.appendChild(head);
        if (!evs.length && !todos.length) box.appendChild(el('p', 'pl-empty', esc(t('Nothing planned.'))));
        evs.forEach((e) => {
            const b = el('button', 'pl-ev-row');
            b.type = 'button';
            const meta = [S.isRepeating(e) ? t('Repeats') : '', e.remindAtStart ? t('Reminder at start') : e.remindBefore ? t('Reminder {n} min before', { n: e.remindBefore }) : ''].filter(Boolean).join(' · ');
            b.innerHTML = `<span class="pl-ev-t">${esc(e.allDay ? t('All day') : e.start + '–' + e.end)}</span><span class="pl-ev-bar" style="background:${esc(e.color || '#60a5fa')}"></span>` +
                `<span class="pl-ev-main"><span class="pl-ev-n">${esc(e.title)}</span>${meta ? `<span class="pl-ev-m">${esc(meta)}</span>` : ''}</span>`;
            b.addEventListener('click', () => openEventDialog(e));
            box.appendChild(b);
        });
        todos.forEach((x) => {
            const b = el('button', 'pl-ev-row');
            b.type = 'button';
            b.innerHTML = `<span class="pl-ev-t">${esc(t('Due'))}</span><span class="pl-ev-bar" style="background:${esc(x.kind === 'milestone' ? x.color : 'var(--muted)')}"></span>` +
                `<span class="pl-ev-main"><span class="pl-ev-n">${esc(x.title)}</span><span class="pl-ev-m">${esc(x.kind === 'milestone' ? x.projectName : t('To-do'))}</span></span>`;
            b.addEventListener('click', () => {
                if (x.kind === 'milestone') { S.state.ui.activeProject = x.projectId; P.setTab('projects'); }
                else { S.state.ui.todoEditing = x.id; P.setTab('todos'); }
            });
            box.appendChild(b);
        });
        const add = el('button', 'pl-add-day', `${U.icon('plus')}<span>${esc(t('Add on {day}', { day: U.dayName(di, { long: true }) }))}</span>`);
        add.type = 'button';
        add.addEventListener('click', () => openEventDialog({ date: di }));
        box.appendChild(add);
    }

    /* ---------------- year view ---------------- */
    function renderYear(body) {
        const y = cursor().getFullYear();
        const counts = S.countByDate(`${y}-01-01`, `${y}-12-31`);
        const grid = el('div', 'cal-year-grid');
        for (let m = 0; m < 12; m++) {
            const mini = el('div', 'cal-mini');
            mini.setAttribute('role', 'button');
            mini.tabIndex = 0;
            mini.setAttribute('aria-label', t('Open {month}', { month: monthName(m) + ' ' + y }));
            mini.appendChild(el('h4', null, esc(monthName(m))));
            const mg = el('div', 'mini-grid');
            const first = new Date(y, m, 1), start = D.startOfWeek(first);
            for (let i = 0; i < 42; i++) {
                const day = D.addDays(start, i);
                const mc = el('div', 'mc');
                if (day.getMonth() === m) {
                    mc.textContent = day.getDate();
                    if (counts[D.iso(day)]) mc.classList.add('has');
                }
                mg.appendChild(mc);
            }
            mini.appendChild(mg);
            mini.addEventListener('click', () => { setCursor(new Date(y, m, 1)); setRange('month'); });
            mini.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                setCursor(new Date(y, m, 1)); setRange('month');
            });
            grid.appendChild(mini);
        }
        body.appendChild(grid);
    }

    /* ---------------- day / 3-day / week time grid ---------------- */
    function renderTime(body, days) {
        const todayIso = D.iso(new Date());
        const LABEL_W = 46;
        // Visible day window (from calendar settings). Only these hours render,
        // so the schedule fills the panel instead of leaving empty sleep hours.
        const st = S.getSettings();
        const startH = Math.max(0, Math.min(23, st.dayStart || 0));
        const endH = Math.max(startH + 1, Math.min(24, st.dayEnd || 24));
        const winStart = startH * 60, winEnd = endH * 60, winMins = winEnd - winStart;
        const wrapH = narrow()
            ? Math.min(720, Math.max(380, (window.innerHeight || 800) - 250))
            : Math.min(760, Math.max(360, (window.innerHeight || 800) - 220));
        // At least 48 px an hour (a one-hour event shows its name and time);
        // a longer day then scrolls inside the frame, starting near now.
        const hourPx = Math.max(48, (wrapH - 2) / (winMins / 60));
        const gridH = Math.round(hourPx * winMins / 60);
        const pxPerMin = hourPx / 60;
        const tickMin = hourPx >= 90 ? 30 : hourPx >= 34 ? 60 : 120;
        const snap = (mins) => Math.round(mins / 15) * 15;
        const short = dowNames('short');

        const cols = `repeat(${days.length}, minmax(0, 1fr))`;
        if (days.length > 1) {
            const head = el('div', 'cal-week-head');
            head.style.marginLeft = LABEL_W + 'px';
            head.style.gridTemplateColumns = cols;
            days.forEach((day) => {
                const di = D.iso(day);
                const wh = el('button', 'wh' + (di === todayIso ? ' today' : ''), `${esc(short[(day.getDay() + 6) % 7])}<b>${day.getDate()}</b>`);
                wh.type = 'button';
                wh.setAttribute('aria-label', t('Open {day}', { day: U.dayName(di, { long: true }) }));
                wh.addEventListener('click', () => { setCursor(day); setRange('day'); });
                head.appendChild(wh);
            });
            body.appendChild(head);
        }
        // All-day events sit in their own row above the hours.
        const alldays = days.map((day) => S.eventsForDate(D.iso(day)).filter((e) => e.allDay));
        if (alldays.some((a) => a.length)) {
            const row = el('div', 'cal-allday');
            row.style.gridTemplateColumns = `${LABEL_W}px ${cols}`;
            row.appendChild(el('span', 'cal-allday-k', esc(t('All day'))));
            alldays.forEach((list) => {
                const cell = el('div', 'cal-allday-c');
                list.forEach((e) => {
                    const b = el('button', 'cal-event allday', `<b>${esc(e.title)}</b>`);
                    b.type = 'button';
                    b.style.background = e.color;
                    b.addEventListener('click', () => openEventDialog(e));
                    cell.appendChild(b);
                });
                row.appendChild(cell);
            });
            body.appendChild(row);
        }

        const wrap = el('div', 'cal-timewrap');
        wrap.style.height = wrapH + 'px';
        const grid = el('div', 'cal-timegrid');
        grid.style.height = gridH + 'px';
        for (let m = winStart; m < winEnd; m += tickMin) {
            const row = el('div', 'cal-hourrow');
            row.style.gridTemplateColumns = LABEL_W + 'px 1fr';
            row.style.height = (Math.min(tickMin, winEnd - m) * pxPerMin) + 'px';
            row.appendChild(el('div', 'cal-hourlabel', D.hhmm(m)));
            row.appendChild(el('div'));
            grid.appendChild(row);
        }
        const colsEl = el('div', 'cal-daycols');
        colsEl.style.left = LABEL_W + 'px';
        colsEl.style.gridTemplateColumns = cols;
        days.forEach((day) => {
            const di = D.iso(day);
            const col = el('div', 'cal-daycol');
            col.addEventListener('click', (ev) => {
                if (ev.target !== col) return;
                const mins = winStart + snap(ev.offsetY / pxPerMin);
                openEventDialog({ date: di, start: D.hhmm(Math.max(winStart, Math.min(mins, winEnd - 15))) });
            });
            S.eventsForDate(di).forEach((e) => {
                if (e.allDay) return;
                const rawS = D.minutesOf(e.start), rawE = Math.max(D.minutesOf(e.end), rawS + 15);
                if (rawE <= winStart || rawS >= winEnd) return;            // outside window
                const sMin = Math.max(winStart, rawS), eMin = Math.min(winEnd, rawE);
                const h = Math.max(18, (eMin - sMin) * pxPerMin);
                // Tall enough: name and time on two lines; else one line.
                const node = el('button', 'cal-event' + (h < 36 ? ' short' : ''));
                node.type = 'button';
                node.style.top = ((sMin - winStart) * pxPerMin) + 'px';
                node.style.height = h + 'px';
                node.style.background = e.color;
                node.innerHTML = `<b>${esc(e.title)}</b><span class="et">${h < 36 ? esc(e.start) : esc(e.start + '–' + e.end)}</span>`;
                node.setAttribute('aria-label', `${e.title}, ${e.start}–${e.end}`);
                node.addEventListener('click', (ev) => { ev.stopPropagation(); openEventDialog(e); });
                col.appendChild(node);
            });
            if (di === todayIso) {
                const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
                if (nowMin >= winStart && nowMin <= winEnd) {
                    const line = el('div', 'now-line');
                    line.style.top = ((nowMin - winStart) * pxPerMin) + 'px';
                    col.appendChild(line);
                }
            }
            colsEl.appendChild(col);
        });
        grid.appendChild(colsEl);
        wrap.appendChild(grid);
        body.appendChild(wrap);
        if (gridH > wrapH) {
            const firstEv = days.map((d) => S.eventsForDate(D.iso(d)).filter((e) => !e.allDay).map((e) => D.minutesOf(e.start))).flat().sort((a, b) => a - b)[0];
            const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
            const showToday = days.some((d) => D.iso(d) === todayIso);
            const focus = showToday ? nowMin - 60 : (firstEv != null ? firstEv - 30 : 8 * 60);
            requestAnimationFrame(() => { wrap.scrollTop = Math.max(0, (focus - winStart) * pxPerMin); });
        }
    }

    /* ---------------- event sheet ---------------- */
    let editingId = null, editingOccurrence = null, pickedColor = S.COLORS[0], durMin = 30, repeat = '';
    const DURATIONS = [15, 30, 60, 120];
    function durLabel(m) { return m < 60 ? t('{n} min', { n: m }) : t('{n} h', { n: m / 60 }); }
    function buildSwatches(container, selected, onPick) {
        container.innerHTML = '';
        container.setAttribute('role', 'radiogroup');
        container.setAttribute('aria-label', t('Event colour'));
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
                sw.classList.add('on'); sw.setAttribute('aria-checked', 'true'); sw.tabIndex = 0; onPick(c);
            });
            sw.addEventListener('keydown', (event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                const swatches = [...container.querySelectorAll('.sw')];
                const current = swatches.indexOf(sw);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? swatches.length - 1
                    : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + swatches.length) % swatches.length;
                event.preventDefault(); swatches[next].click(); swatches[next].focus();
            });
            container.appendChild(sw);
        });
    }
    function fillHabitSelect() {
        const sel = document.getElementById('evHabit');
        sel.innerHTML = '';
        sel.appendChild(new Option(t('— none —'), ''));
        S.state.habits.forEach((h) => {
            const avg = S.habitAvgMin(h);
            sel.appendChild(new Option(h.name + (avg ? ` (~${avg}m)` : ''), h.id));
        });
        sel.value = '';
    }
    // picking a habit prefills the event from that habit's name / colour / avg time
    function applyHabit(id) {
        const h = S.habitById(id); if (!h) return;
        document.getElementById('evTitle').value = h.name;
        setDuration(S.habitAvgMin(h) || 30);
        pickedColor = h.color;
        buildSwatches(document.getElementById('evSwatches'), pickedColor, (c) => pickedColor = c);
    }
    function addDur(hhmm, dur) { const m = D.minutesOf(hhmm) + dur; return D.hhmm(Math.min(m, 23 * 60 + 59)); }
    function setDuration(mins) {
        durMin = mins;
        const start = document.getElementById('evStart').value || '09:00';
        document.getElementById('evEnd').value = addDur(start, mins);
        syncTimeUI();
    }
    function syncTimeUI() {
        const allDay = document.getElementById('evAllDay').checked;
        document.getElementById('evTimes').hidden = allDay;
        const start = document.getElementById('evStart').value || '09:00', end = document.getElementById('evEnd').value || addDur(start, 30);
        durMin = Math.max(15, D.minutesOf(end) - D.minutesOf(start));
        document.getElementById('evEndsLabel').textContent = t('ends {time}', { time: end });
        const preset = DURATIONS.indexOf(durMin) >= 0 ? String(durMin) : 'custom';
        U.markChip(document.getElementById('evDurChips'), document.getElementById('evEndRow').hidden ? preset : 'custom');
    }
    function syncDayUI() {
        const date = document.getElementById('evDate').value;
        const n = date ? U.daysFromToday(date) : null;
        const which = n === 0 ? '0' : n === 1 ? '1' : 'pick';
        document.querySelectorAll('#evDayChips [data-day]').forEach((b) => { const on = b.dataset.day === which; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
        document.getElementById('evDateChip').classList.toggle('on', which === 'pick');
        document.getElementById('evDateLabel').textContent = which === 'pick' && date ? U.dayName(date, { long: true }) : t('Pick a date');
        syncRepeatUI();
    }
    function repeatSummary(r, date) {
        const d = D.parseISO(date || D.iso(new Date()));
        if (r === 'daily') return t('Every day');
        if (r === 'weekdays') return t('Every weekday');
        if (r === 'weekly') return t('Every {day}', { day: dowNames('long')[(d.getDay() + 6) % 7] });
        if (r === 'monthly') return t('Every month on the {n}', { n: d.getDate() });
        if (r === 'yearly') return t('Every year on {date}', { date: U.shortDate(date).replace(/,? \d{4}$/, '') });
        return '';
    }
    function syncRepeatUI() {
        U.markChip(document.getElementById('evRepeatChips'), repeat);
        const row = document.getElementById('evUntilRow');
        row.hidden = !repeat;
        document.getElementById('evRepeatSummary').textContent = repeatSummary(repeat, document.getElementById('evDate').value);
        document.getElementById('evUntilClear').hidden = !document.getElementById('evUntil').value;
    }
    function remindValue(ev) { return ev.remindAtStart ? 'at' : String(ev.remindBefore || 0); }
    function openEventDialog(ev) {
        ev = ev || {};
        const dlg = document.getElementById('eventDlg');
        editingId = ev.id || null;
        // A repeating event opens its whole series; remember which day was tapped.
        editingOccurrence = ev.id && ev.seriesDate ? ev.date : null;
        const series = ev.id ? (S.findEntry(ev.id) || ev) : ev;
        document.getElementById('eventDlgTitle').textContent = editingId ? t('Edit event') : t('New event');
        document.getElementById('evId').value = editingId || '';
        document.getElementById('evTitle').value = series.title || '';
        document.getElementById('evDate').value = series.date || ev.date || D.iso(new Date());
        document.getElementById('evStart').value = series.start || ev.start || '09:00';
        document.getElementById('evEnd').value = series.end || addDur(series.start || ev.start || '09:00', 30);
        document.getElementById('evAllDay').checked = !!series.allDay;
        document.getElementById('evDesc').value = series.description || '';
        document.getElementById('evRemind').value = remindValue(series);
        repeat = S.isRepeating(series) ? series.repeat : '';
        document.getElementById('evUntil').value = series.repeatUntil || '';
        const dl = document.getElementById('evDayLbl');
        if (dl) dl.textContent = repeat ? t('Starts') : t('Day');
        document.getElementById('evEndRow').hidden = true;
        U.markChip(document.getElementById('evRemindChips'), remindValue(series));
        window.MemoPlannerReminders?.refresh();
        document.getElementById('evDeleteBtn').style.display = editingId ? '' : 'none';
        document.getElementById('evMore').open = !!series.description;
        fillHabitSelect();
        pickedColor = series.color || S.COLORS[0];
        buildSwatches(document.getElementById('evSwatches'), pickedColor, (c) => pickedColor = c);
        syncTimeUI(); syncDayUI();
        dlg.showModal();
        if (!editingId) setTimeout(() => document.getElementById('evTitle').focus(), 30);
    }

    function wireDialog() {
        const dlg = document.getElementById('eventDlg');
        U.chipGroup(document.getElementById('evDurChips'),
            DURATIONS.map((m) => ({ value: String(m), label: durLabel(m) })).concat([{ value: 'custom', label: t('Set end…') }]), '30', (v) => {
                if (v === 'custom') { document.getElementById('evEndRow').hidden = false; syncTimeUI(); document.getElementById('evEnd').focus(); return; }
                document.getElementById('evEndRow').hidden = true; setDuration(Number(v));
            });
        const REP = [['', 'Never'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
        U.chipGroup(document.getElementById('evRepeatChips'), REP.map(([v, l]) => ({ value: v, label: t(l) })), '', (v) => {
            repeat = v; const dl = document.getElementById('evDayLbl'); if (dl) dl.textContent = repeat ? t('Starts') : t('Day'); syncRepeatUI();
        });
        const REM = [['0', 'Off'], ['at', 'At start'], ['10', '10 min before'], ['60', '1 h before'], ['1440', '1 day before']];
        U.chipGroup(document.getElementById('evRemindChips'), REM.map(([v, l]) => ({ value: v, label: t(l) })), '0', (v) => {
            document.getElementById('evRemind').value = v; U.markChip(document.getElementById('evRemindChips'), v);
        });
        document.getElementById('evDayChips').addEventListener('click', (e) => {
            const b = e.target.closest('[data-day]'); if (!b) return;
            document.getElementById('evDate').value = D.iso(D.addDays(new Date(), Number(b.dataset.day)));
            syncDayUI();
        });
        const date = document.getElementById('evDate');
        date.addEventListener('change', syncDayUI);
        date.addEventListener('click', () => { try { if (date.showPicker) date.showPicker(); } catch (_) {} });
        document.getElementById('evStart').addEventListener('change', () => {
            if (document.getElementById('evEndRow').hidden) setDuration(durMin); else syncTimeUI();
        });
        document.getElementById('evEnd').addEventListener('change', syncTimeUI);
        document.getElementById('evAllDay').addEventListener('change', syncTimeUI);
        document.getElementById('evUntil').addEventListener('change', syncRepeatUI);
        document.getElementById('evUntilClear').addEventListener('click', () => { document.getElementById('evUntil').value = ''; syncRepeatUI(); });
        document.getElementById('evHabit').addEventListener('change', (e) => { if (e.target.value) applyHabit(e.target.value); });

        // Delete: a repeating event asks whether to drop just the tapped day.
        document.getElementById('evDeleteBtn').addEventListener('click', async (e) => {
            e.preventDefault();
            const id = editingId, series = id && S.findEntry(id); if (!series) return;
            let what = 'all';
            if (S.isRepeating(series)) {
                const day = editingOccurrence || series.date;
                what = window.MemoShell && window.MemoShell.choose
                    ? await window.MemoShell.choose(t('Delete “{name}” only on {day}, or every time?', { name: series.title, day: U.dayName(day, { long: true }) }),
                        { okLabel: t('Every time'), okValue: 'all', secondaryLabel: t('Only that day'), secondaryValue: 'one', danger: true })
                    : 'all';
                if (!what) return;
                if (what === 'one') { dlg.close('cancel'); S.skipOccurrence(id, day); return; }
            }
            dlg.close('cancel');
            S.deleteWithUndo(id, t('“{name}” deleted', { name: series.title }), () => S.deleteEvent(id));
        });
        dlg.addEventListener('close', () => {
            if (dlg.returnValue === 'save') {
                const allDay = document.getElementById('evAllDay').checked;
                let start = document.getElementById('evStart').value || '09:00';
                let end = document.getElementById('evEnd').value || addDur(start, 30);
                if (!allDay) {   // enforce a 15-minute minimum duration
                    const sM = D.minutesOf(start), eM = D.minutesOf(end);
                    if (eM < sM + 15) end = D.hhmm(Math.min(sM + 15, 24 * 60 - 1));
                }
                const data = {
                    title: document.getElementById('evTitle').value.trim() || t('Untitled'),
                    date: document.getElementById('evDate').value || D.iso(new Date()),
                    start, end, allDay,
                    description: document.getElementById('evDesc').value.trim(),
                    remindBefore: Number(document.getElementById('evRemind').value) || 0,
                    remindAtStart: document.getElementById('evRemind').value === 'at',
                    color: pickedColor,
                    repeat: repeat || '',
                    repeatUntil: repeat ? (document.getElementById('evUntil').value || '') : '',
                };
                if (editingId) S.updateEvent(editingId, data); else S.addEvent(data);
            }
            editingId = null; editingOccurrence = null;
        });
    }

    /* ---------------- calendar settings (day window) ---------------- */
    function openSettings() {
        const st = S.getSettings();
        const ss = document.getElementById('setDayStart'), se = document.getElementById('setDayEnd');
        ss.innerHTML = ''; se.innerHTML = '';
        for (let h = 0; h <= 23; h++) ss.appendChild(new Option(D.hhmm(h * 60), h));
        for (let h = 1; h <= 24; h++) se.appendChild(new Option(h === 24 ? '24:00 (midnight)' : D.hhmm(h * 60), h));
        ss.value = st.dayStart; se.value = st.dayEnd;
        document.getElementById('calSettingsDlg').showModal();
    }
    function wireSettings() {
        document.getElementById('calSettingsBtn').addEventListener('click', openSettings);
        document.getElementById('calSettingsDlg').addEventListener('close', function () {
            if (this.returnValue !== 'save') return;
            const ds = +document.getElementById('setDayStart').value;
            const de = +document.getElementById('setDayEnd').value;
            S.setSettings({ dayStart: ds, dayEnd: Math.max(ds + 1, de) });
        });
    }

    /* ---------------- public ---------------- */
    function render() {
        const body = document.getElementById('calBody');
        body.innerHTML = '';
        document.getElementById('calLabel').textContent = label();
        document.querySelectorAll('#calRange button').forEach((b) => {
            const selected = b.dataset.range === S.state.ui.calRange;
            b.classList.toggle('active', selected);
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', String(selected));
            b.tabIndex = selected ? 0 : -1;
            if (b.dataset.range === 'week') b.textContent = weekSpan() === 3 ? t('3 days') : t('Week');
        });
        const r = S.state.ui.calRange;
        const panel = document.querySelector('.panel--calendar');
        if (panel) panel.dataset.range = r;
        if (r === 'month') renderMonth(body);
        else if (r === 'year') renderYear(body);
        else if (r === 'week') renderTime(body, weekDays());
        else renderTime(body, [cursor()]);
        renderAgenda();
        if (motionDirection && body.animate && !document.hidden && !window.__memoRestoring && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
            navigationAnimation?.cancel();
            navigationAnimation = window.MemoDom.animate(body, [{ opacity: 0.6, translate: (motionDirection * 10) + 'px 0' }, { opacity: 1, translate: '0 0' }],
                { duration: 160, easing: 'ease-out' });
        }
        motionDirection = 0;
    }

    function mount() {
        document.getElementById('calPrev').addEventListener('click', () => shift(-1));
        document.getElementById('calNext').addEventListener('click', () => shift(1));
        document.getElementById('calToday').addEventListener('click', goToday);
        document.querySelectorAll('#calRange button').forEach((b) =>
            b.addEventListener('click', () => setRange(b.dataset.range)));
        const rangeGroup = document.getElementById('calRange');
        rangeGroup.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            const buttons = [...rangeGroup.querySelectorAll('button')];
            const current = buttons.indexOf(event.target.closest('button'));
            if (current < 0) return;
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
            event.preventDefault();
            setRange(buttons[next].dataset.range);
            buttons[next].focus();
        });
        U.onSwipe(document.getElementById('calBody'), (dir) => shift(dir));
        document.getElementById('calAddBtn').addEventListener('click', () => {
            const r = S.state.ui.calRange;
            const date = r === 'month' ? selectedDay() : (r === 'day' || r === 'week') ? S.state.ui.calCursor : D.iso(new Date());
            openEventDialog({ date });
        });
        wireDialog();
        wireSettings();
    }

    P.Calendar = { mount, render, openEventDialog };
})();
