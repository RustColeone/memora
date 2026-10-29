/* planner-app.js — bootstrap: load store, mount modules, folder tabs, render loop. */
(function () {
    'use strict';
    const P = window.Planner, S = P.Store;
    const TABS = ['today', 'calendar', 'todos', 'projects', 'habits'];

    const rendered = new Map();
    function renderAll(change = {}) {
        const state = S.state;
        const today = S.Dates.iso(new Date());
        const pendingKeys = S.pendingKeys();
        const keys = {
            // Only dated, open to-dos show on the calendar.
            Calendar: [state.events, state.habits.map(h => [h.id, h.name]), state.ui.calRange, state.ui.calCursor, state.ui.calSelected, state.ui.settings, today,
                S.derivedTodos().filter(x => x.due && !x.done).map(x => [x.id, x.due, x.title, x.color, x.projectName]), pendingKeys, narrow()],
            Todos: [S.derivedTodos(), state.ui.todoEditing, pendingKeys, today],
            Projects: [state.projects, state.ui.activeProject, state.ui.projZoom, pendingKeys, today],
            Habits: [state.habits, today, pendingKeys],
            Today: [state.events, S.derivedTodos(), state.habits, state.projects, today, nowMinute, pendingKeys],
        };
        for (const name of Object.keys(keys)) {
            if (!P[name]) continue;
            const signature = JSON.stringify(keys[name]);
            if (rendered.get(name) === signature && !(name === 'Habits' && change.habitTimer)) continue;
            P[name].render(); rendered.set(name, signature);
        }
        renderTabs();
    }

    /* ---------- folder tabs ---------- */
    function activeTab() { const t = S.state.ui.tab; return TABS.indexOf(t) >= 0 ? t : 'today'; }
    function setTab(tab, opts) {
        if (TABS.indexOf(tab) < 0) return;
        S.state.ui.tab = tab;
        S.persist();
        if (opts && opts.focus) { const b = document.getElementById('plTab-' + tab); if (b) b.focus(); }
        const panel = document.getElementById('plPanel-' + tab);
        if (panel && window.MemoDom && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
            window.MemoDom.animate(panel, [{ opacity: 0.6 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
        }
        const scroller = document.scrollingElement; if (scroller && scroller.scrollTop > 120) scroller.scrollTop = 0;
    }
    function renderTabs() {
        const tab = activeTab();
        document.querySelectorAll('#plTabs .pl-tab').forEach((b) => {
            const on = b.dataset.tab === tab;
            b.classList.toggle('on', on);
            b.setAttribute('aria-selected', String(on));
            b.tabIndex = on ? 0 : -1;
        });
        document.querySelectorAll('.pl-panels > .pl-panel').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
        const open = S.derivedTodos().filter((t) => !t.done).length;
        const badge = document.getElementById('plTodoBadge');
        if (badge) { badge.hidden = !open; badge.textContent = String(open); }
    }
    function wireTabs() {
        const bar = document.getElementById('plTabs'); if (!bar) return;
        bar.addEventListener('click', (e) => { const b = e.target.closest('.pl-tab'); if (b) setTab(b.dataset.tab); });
        bar.addEventListener('keydown', (e) => {
            const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
            if (keys.indexOf(e.key) < 0) return;
            e.preventDefault();
            const i = TABS.indexOf(activeTab());
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1
                : (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + TABS.length) % TABS.length;
            setTab(TABS[next], { focus: true });
        });
    }
    // Phones held upright: tabs on top and a 3-day week. Landscape and wide
    // windows: tabs down the left side (CSS) and the full week.
    const NARROW = window.matchMedia('(max-width: 640px)');
    function narrow() { return NARROW.matches; }

    // The Today view's "now" line moves with the clock.
    let nowMinute = 0;
    function tick() {
        const m = Math.floor(Date.now() / 60000);
        if (m === nowMinute) return;
        nowMinute = m;
        if (activeTab() === 'today' && !document.hidden) renderAll();
    }

    function todayPill() {
        const pill = document.getElementById('todayPill'); if (!pill) return;
        const d = new Date();
        pill.textContent = d.toLocaleDateString(P.UI ? P.UI.locale() : undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }

    async function init() {
        // Async: brings up the in-browser SQLite engine, loads/seed entries,
        // detects a sync server, and starts the operation queue.
        await S.load();
        // one-time wiring
        P.Calendar.mount();
        P.Todos.mount();
        P.Projects.mount();
        P.Habits.mount();
        P.Archive.mount();
        if (P.Today) P.Today.mount();
        wireTabs();
        todayPill();
        nowMinute = Math.floor(Date.now() / 60000);
        setInterval(tick, 15000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); renderAll(); } });
        NARROW.addEventListener('change', () => renderAll());
        document.addEventListener('memo:localechange', () => { rendered.clear(); todayPill(); renderAll(); });
        // re-render whenever state changes
        S.on('change', renderAll);
        const restoringView = !!window.__memoRestoring;
        globalThis.MemoRestore?.prepare('planner');
        renderAll();
        await globalThis.MemoRestore?.ready();
        if (window.MemoMotion && !window.__plannerEntering && !restoringView) {
            requestAnimationFrame(function () {
                const panel = document.querySelector('.pl-panels > .pl-panel:not([hidden])');
                if (panel) window.MemoMotion.stagger([panel], 'pop');
            });
        }
    }

    P.setTab = setTab;
    P.activeTab = activeTab;
    P.narrow = narrow;
    P.ready = document.readyState === 'loading'
      ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true })).then(init)
      : init();
})();
