/*
 * planner-store.js — Planner state for the memoDB "planner" sync variant.
 *
 * Phase 2 of the integration: the store now keeps ONE flat `entries[]` array
 * where each entry is a generic document `{ id, kind, ...fields }` with
 * kind ∈ {event, todo, project, habit}. The same array is what the
 * event-sourced OperationQueue reads/writes through the registered `entryStore`
 * adapter, so the Planner page rides the identical sync engine as memo/finance
 * (push/pull with ?variant=planner, last-write-wins per entry).
 *
 * Mutations route through OperationQueue.addOperation when a sync server is
 * present; otherwise they apply locally (offline-first). Entries persist in the
 * shared in-browser SQLite store (MemoStateDb) with a localStorage fallback.
 * UI preferences (calendar range/cursor, day window, active project) stay
 * device-local and un-synced.
 *
 * The public Store API is unchanged from the standalone prototype, so the
 * calendar / todos / projects / habits / archive modules are untouched.
 */
(function () {
    'use strict';
    const ENTRIES_KEY = 'plannerEntries.v1';   // localStorage-fallback key (also the legacy blob migrated into doc_entries)
    const UI_KEY = 'plannerUI.v1';             // device-local, un-synced prefs
    window.Planner = window.Planner || {};

    /* ---------- tiny date helpers (all local time) ---------- */
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    // Tolerant of missing/invalid input (e.g. a malformed project from an import
    // or sync): fall back to today rather than throwing and blanking the whole
    // planner render.
    const parseISO = (s) => { if (!s) return new Date(); const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const startOfWeek = (d) => addDays(d, -((d.getDay() + 6) % 7)); // Monday start
    const minutesOf = (hhmm) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return h * 60 + m; };
    const hhmm = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    const uid = () => Math.random().toString(36).slice(2, 9);

    const Dates = { pad, iso, parseISO, addDays, startOfWeek, minutesOf, hhmm, today: () => new Date() };

    /* ---------- tiny pub/sub so panels re-render on change ---------- */
    const subs = {};
    function on(evt, cb) { (subs[evt] = subs[evt] || []).push(cb); }
    function emit(evt, payload) { (subs[evt] || []).forEach((cb) => cb(payload)); }

    /* ---------- palette for color-coding ---------- */
    const COLORS = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#facc15'];

    /* ---------- in-memory state ---------- */
    let entries = [];          // the synced document array (one partition = 'planner')
    let ui = defaultUi();      // device-local preferences
    let syncEnabled = false;   // true once a reachable sync server is detected

    function defaultUi() {
        return { calRange: 'month', calCursor: iso(new Date()), calSelected: null, calCollapsed: false, activeProject: null,
            tab: 'today', projZoom: 'weeks', todoEditing: null, settings: { dayStart: 6, dayEnd: 24 } };
    }

    /* ---------- persistence (entries via MemoStateDb, UI via localStorage) ---------- */
    function stateDb() {
        const db = window.MemoStateDb;
        return (db && typeof db.ready === 'function' && db.ready()) ? db : null;
    }
    function saveEntries() {
        const sdb = stateDb();
        // Planner is a document variant in the shared SQLite store (doc_entries);
        // fall back to a localStorage blob only when sql.js is unavailable.
        if (sdb && sdb.saveDocs) sdb.saveDocs('planner', entries);
        else { try { localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries)); } catch (e) { /* quota */ } }
    }
    function loadEntries() {
        const sdb = stateDb();
        if (sdb && sdb.loadDocs) { entries = sdb.loadDocs('planner') || []; return; }
        try { const raw = localStorage.getItem(ENTRIES_KEY); entries = raw ? JSON.parse(raw) : []; }
        catch (e) { entries = []; }
    }
    // Re-read from storage and re-render (used after a whole-DB import restores
    // planner docs into the shared store on this page).
    function reload() { loadEntries(); normalizeEntries(); emit('change'); }
    function persistUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* quota */ } }
    function loadUI() {
        try { const raw = localStorage.getItem(UI_KEY); if (raw) ui = Object.assign(defaultUi(), JSON.parse(raw)); }
        catch (e) { ui = defaultUi(); }
        if (!ui.settings) ui.settings = { dayStart: 6, dayEnd: 24 };
        if (typeof ui.settings.dayStart !== 'number') ui.settings.dayStart = 6;
        if (typeof ui.settings.dayEnd !== 'number') ui.settings.dayEnd = 24;
    }
    // `persist()` in the public API now means "a UI-only pref changed" — save prefs
    // and re-render. Document mutations persist through dispatch() instead.
    function persist() { persistUI(); emit('change'); }

    /* ---------- entryStore adapter: how the OperationQueue sees our data ---------- */
    // Registered on MemoContracts so the shared op-queue drives this page's model.
    const entryStore = {
        getEntries() { return entries; },
        replaceAll(arr) { entries = Array.isArray(arr) ? arr : []; },
        save() { saveEntries(); },
        render() { emit('change'); },
    };
    function registerAdapter() {
        if (window.MemoContracts && typeof window.MemoContracts.registerService === 'function') {
            window.MemoContracts.registerService('entryStore', entryStore);
        }
    }

    /* ---------- mutation dispatch (op-queue when synced, local otherwise) ---------- */
    const nowIso = () => new Date().toISOString();
    function findEntry(id) { return entries.find((e) => e.id === id) || null; }

    // Local apply mirrors OperationQueue.applyOperationLocally so both paths
    // produce identically-shaped entries (last-write-wins per entry).
    function applyLocally(type, id, data) {
        if (type === 'create') {
            entries.push(Object.assign({ id }, data, { createdAt: nowIso(), updatedAt: nowIso() }));
        } else if (type === 'update') {
            const e = findEntry(id);
            if (e) { if (data) Object.assign(e, data); e.updatedAt = nowIso(); }
        } else if (type === 'delete') {
            const e = findEntry(id);
            if (e) { e.deletedAt = nowIso(); e.deletedBy = 'local'; }
        }
    }
    function dispatch(type, id, data) {
        const q = window.OperationQueue;
        if (q && q.deviceId != null) {
            // Routes through the event log: applies locally, enqueues, saves, renders.
            q.addOperation(type, id, data ? { data } : {});
        } else {
            applyLocally(type, id, data);
            saveEntries();
            const reason = window.__memoRenderReason;
            window.__memoRenderReason = 'local';
            try { emit('change'); } finally { window.__memoRenderReason = reason; }
        }
    }

    /* ---------- delete with Undo ---------- */
    // A delete waits a few seconds behind an Undo toast before it is written
    // (and synced): until then the item is only hidden. Leaving the page
    // commits whatever is still waiting.
    const pending = new Map();   // key -> { timer, commit }
    function isPending(key) { return pending.has(key); }
    function pendingKeys() { return Array.from(pending.keys()); }
    function commitPending(key) {
        const p = pending.get(key); if (!p) return;
        clearTimeout(p.timer); pending.delete(key);
        try { p.commit(); } catch (e) { console.warn('[planner] delete failed', e); }
    }
    function deleteWithUndo(key, message, commit) {
        if (pending.has(key)) return;
        const timer = setTimeout(() => commitPending(key), 6500);
        pending.set(key, { timer, commit });
        emit('change');
        const t = (s) => (window.MemoI18n && window.MemoI18n.t ? window.MemoI18n.t(s) : s);
        if (window.MemoShell && window.MemoShell.toast) {
            window.MemoShell.toast(message, { ms: 6000, action: { label: t('Undo'), onClick: () => {
                const p = pending.get(key); if (!p) return;
                clearTimeout(p.timer); pending.delete(key); emit('change');
            } } });
        }
    }
    function flushPending() { pendingKeys().forEach(commitPending); }
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushPending(); });

    /* ---------- selectors over the flat entries array ---------- */
    const live = (kind) => entries.filter((e) => e.kind === kind && !e.deletedAt && !pending.has(e.id));
    const selectors = {
        get events() { return live('event'); },
        get todos() { return live('todo'); },
        get projects() { return live('project'); },
        get habits() { return live('habit'); },
        get ui() { return ui; },
    };

    function normalizeEntries() {
        // Back-fill completion dates for older saves so the archive groups them.
        entries.forEach((e) => { if (e.kind === 'todo' && e.done && !e.completedAt) e.completedAt = e.due || iso(new Date()); });
    }

    /* ---------- server detection ---------- */
    function getApiBase() {
        return (window.MemoContracts && window.MemoContracts.getApiBase && window.MemoContracts.getApiBase()) || '';
    }
    function setApiBase(v) {
        if (window.MemoContracts && window.MemoContracts.setApiBase) window.MemoContracts.setApiBase(v);
        else window.API_BASE = v;
    }
    // Probe for a reachable backend. On http/https with no explicit server URL we
    // try the same origin (the page may be served by the Flask sync server). On a
    // pure static host (e.g. the offline build) /api/config 404s → local mode.
    async function detectServer() {
        const base = (getApiBase() || '').replace(/\/$/, '');
        let candidate = base;
        // Use the server URL the user configured on any page (shared localStorage
        // key) before falling back to same-origin. Without this the planner never
        // synced on a native build: location.origin is https://localhost, which
        // has no backend, so it stayed local while memo/finance synced fine.
        if (!candidate) { try { candidate = (localStorage.getItem('memo_server_url') || '').trim().replace(/\/$/, ''); } catch (e) { /* ignore */ } }
        if (!candidate && (location.protocol === 'http:' || location.protocol === 'https:')) candidate = location.origin;
        if (!candidate) return; // file:// or native without a server URL → local only
        try {
            const res = await Promise.race([
                fetch(candidate + '/api/config', { cache: 'no-store' }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
            ]);
            if (res && res.ok) {
                const cfg = await res.json().catch(() => ({}));
                if (cfg && cfg.server) {
                    syncEnabled = true;
                    setApiBase(candidate);
                    // Mark the mode the same way memo-core does. A same-origin web
                    // deployment is 'server' mode; a native (Capacitor) build stays
                    // offline-first 'capacitor' (it syncs to a REMOTE apiBase, not
                    // itself). Forcing 'server' on native would make memo-core's
                    // getStateDb() return null — breaking memo/finance persistence in
                    // the single-page shell (they'd read an empty localStorage bucket
                    // and keep rendering the last variant's stale entries).
                    var isNative = !!(window.Capacitor && (typeof window.Capacitor.isNativePlatform === 'function'
                        ? window.Capacitor.isNativePlatform() : window.Capacitor.Plugins));
                    if (window.MemoContracts && window.MemoContracts.setMode) {
                        window.MemoContracts.setMode(isNative ? 'capacitor' : 'server');
                    }
                }
            }
        } catch (e) { /* unreachable → stay local-only */ }
    }

    /* ---------- lifecycle ---------- */
    async function load() {
        loadUI();
        // Bring up the shared in-browser SQLite engine (no-op without OPFS/Capacitor).
        const sdb = window.MemoStateDb;
        if (sdb && typeof sdb.init === 'function') { try { await sdb.init(); } catch (e) { /* fall back to localStorage */ } }
        registerAdapter();
        loadEntries();
        normalizeEntries();
        if (window.OperationQueue) { window.OperationQueue.reloadQueue(); window.OperationQueue.init(); }
        emit('change');
        // Detect the sync server + start the op-queue in the BACKGROUND. This used
        // to be awaited here, so entering the planner stalled on a network round-
        // trip (detectServer has a 1.5s timeout) before the calendar could paint —
        // it felt like "a second+ to load the calendar". Now we paint from the
        // local store immediately and reconcile with the server when it answers.
        detectServer().then(function () {
            // Start the sync engine. In local mode its processQueue() is a no-op
            // (empty API base); with a server it performs the initial pull/push.
            if (window.OperationQueue) window.OperationQueue.processQueue();
        }).catch(function () {});
    }

    function getSettings() { return ui.settings; }
    function setSettings(patch) { Object.assign(ui.settings, patch); persistUI(); emit('change'); }

    /* ---------- events (one-off or repeating) ---------- */
    // A repeating event is one document: `repeat` is daily | weekdays | weekly
    // | monthly | yearly, counted from its `date`, optionally ending on
    // `repeatUntil`, with `skip` listing days taken out of the series.
    const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
    function isRepeating(e) { return !!(e && REPEATS.indexOf(e.repeat) >= 0); }
    function occursOn(e, isoDate) {
        if (!isRepeating(e)) return e.date === isoDate;
        if (!e.date || isoDate < e.date) return false;
        if (e.repeatUntil && isoDate > e.repeatUntil) return false;
        if (Array.isArray(e.skip) && e.skip.indexOf(isoDate) >= 0) return false;
        const d = parseISO(isoDate), s = parseISO(e.date);
        switch (e.repeat) {
            case 'daily': return true;
            case 'weekdays': { const w = d.getDay(); return w >= 1 && w <= 5; }
            case 'weekly': return d.getDay() === s.getDay();
            case 'monthly': return d.getDate() === s.getDate();
            case 'yearly': return d.getDate() === s.getDate() && d.getMonth() === s.getMonth();
        }
        return false;
    }
    // The events on a day. A repeating event comes back as a copy dated that
    // day, with `seriesDate` holding the date its series starts.
    function eventsForDate(isoDate) {
        return selectors.events.filter((e) => occursOn(e, isoDate))
            .map((e) => isRepeating(e) ? Object.assign({}, e, { date: isoDate, seriesDate: e.date }) : e)
            .sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || minutesOf(a.start) - minutesOf(b.start));
    }
    function skipOccurrence(id, isoDate) {
        const e = findEntry(id); if (!e) return;
        const skip = (Array.isArray(e.skip) ? e.skip : []).filter((d) => d !== isoDate).concat([isoDate]);
        dispatch('update', id, { skip });
    }
    // Events per day over a range (default: around today), repeats included.
    function countByDate(fromIso, toIso) {
        const m = {};
        if (!fromIso) {
            selectors.events.forEach((e) => { if (!isRepeating(e)) m[e.date] = (m[e.date] || 0) + 1; });
            const t0 = new Date(); fromIso = iso(addDays(t0, -62)); toIso = iso(addDays(t0, 62));
            for (let d = parseISO(fromIso); iso(d) <= toIso; d = addDays(d, 1)) {
                const di = iso(d), n = selectors.events.filter((e) => isRepeating(e) && occursOn(e, di)).length;
                if (n) m[di] = (m[di] || 0) + n;
            }
            return m;
        }
        for (let d = parseISO(fromIso); iso(d) <= toIso; d = addDays(d, 1)) {
            const di = iso(d), n = selectors.events.filter((e) => occursOn(e, di)).length;
            if (n) m[di] = n;
        }
        return m;
    }
    function addEvent(ev) { dispatch('create', uid(), Object.assign({ kind: 'event', color: COLORS[0] }, ev)); }
    function updateEvent(id, patch) { dispatch('update', id, patch); }
    function deleteEvent(id) { dispatch('delete', id); }

    /* ---------- todos (standalone + derived project milestones) ---------- */
    function addTodo(t) { dispatch('create', uid(), Object.assign({ kind: 'todo', done: false, priority: 'normal' }, t)); }
    function toggleTodo(id) {
        const t = findEntry(id); if (!t) return;
        const done = !t.done;
        dispatch('update', id, { done, completedAt: done ? iso(new Date()) : null });
    }
    function updateTodo(id, patch) { dispatch('update', id, patch); }
    function deleteTodo(id) { dispatch('delete', id); }

    // A completed todo older than 1 day is "archived": hidden from the live list
    // and only reachable via the Completed-history dialog.
    function ageDays(isoDate) { return Math.round((parseISO(iso(new Date())) - parseISO(isoDate)) / 86400000); }
    function isArchivedTodo(t) { return !!(t.done && t.completedAt && ageDays(t.completedAt) > 1); }
    function archivedCount() { return selectors.todos.filter(isArchivedTodo).length; }
    function completedByDate(isoDate) {
        return selectors.todos.filter((t) => t.done && t.completedAt === isoDate)
            .slice().sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }
    function completedCountByDate() {
        const m = {};
        selectors.todos.forEach((t) => { if (t.done && t.completedAt) m[t.completedAt] = (m[t.completedAt] || 0) + 1; });
        return m;
    }

    // The next pending milestone of each project surfaces as a todo. Clearing it
    // reveals the next one automatically.
    function milestoneKey(projectId, mId) { return 'ms:' + projectId + ':' + mId; }
    function milestonesOf(project) { return (project.milestones || []).filter((m) => !pending.has(milestoneKey(project.id, m.id))); }
    function nextMilestone(project) { return milestonesOf(project).find((m) => !m.done) || null; }
    function derivedTodos() {
        const list = selectors.todos.filter((t) => !isArchivedTodo(t)).map((t) => Object.assign({ kind: 'todo' }, t));
        selectors.projects.forEach((p) => {
            const m = nextMilestone(p);
            if (m) list.push({ kind: 'milestone', id: m.id, projectId: p.id, projectName: p.name,
                color: p.color, title: m.title, due: m.due, done: false, priority: 'normal' });
        });
        // pending first, then by due date
        return list.sort((a, b) => (a.done - b.done) || String(a.due).localeCompare(String(b.due)));
    }

    /* ---------- projects / milestones (milestones ride inside the project doc) ---------- */
    function addProject(p) {
        const id = uid();
        const proj = Object.assign({ kind: 'project', color: COLORS[selectors.projects.length % COLORS.length], milestones: [] }, p);
        ui.activeProject = id; persistUI();
        dispatch('create', id, proj);
        return Object.assign({ id }, proj);
    }
    function deleteProject(id) {
        dispatch('delete', id);
        if (ui.activeProject === id) {
            const rest = selectors.projects.filter((p) => p.id !== id);
            ui.activeProject = rest[0] ? rest[0].id : null; persistUI();
        }
    }
    function projectById(id) { return selectors.projects.find((p) => p.id === id) || null; }
    function addMilestone(projectId, m) {
        const p = projectById(projectId); if (!p) return;
        const milestones = (p.milestones || []).concat([Object.assign({ id: uid(), done: false }, m)])
            .sort((a, b) => String(a.due).localeCompare(String(b.due)));
        dispatch('update', projectId, { milestones });
    }
    function toggleMilestone(projectId, mId) {
        const p = projectById(projectId); if (!p) return;
        const milestones = (p.milestones || []).map((x) => x.id === mId ? Object.assign({}, x, { done: !x.done }) : x);
        dispatch('update', projectId, { milestones });
    }
    function updateMilestone(projectId, mId, patch) {
        const p = projectById(projectId); if (!p) return;
        const milestones = (p.milestones || []).map((x) => x.id === mId ? Object.assign({}, x, patch) : x)
            .sort((a, b) => String(a.due).localeCompare(String(b.due)));
        dispatch('update', projectId, { milestones });
    }
    function updateProject(id, patch) { dispatch('update', id, patch); }
    function deleteMilestone(projectId, mId) {
        const p = projectById(projectId); if (!p) return;
        const milestones = (p.milestones || []).filter((x) => x.id !== mId);
        dispatch('update', projectId, { milestones });
    }

    /* ---------- habits (logs ride inside the habit doc) ---------- */
    function addHabit(h) {
        dispatch('create', uid(), Object.assign({ kind: 'habit', icon: '✅', color: COLORS[selectors.habits.length % COLORS.length], logs: [] }, h));
    }
    function deleteHabit(id) { dispatch('delete', id); }
    function updateHabit(id, patch) { dispatch('update', id, patch); }
    function habitById(id) { return selectors.habits.find((h) => h.id === id) || null; }
    function logHabit(id, durationMin) {
        const h = habitById(id); if (!h) return;
        const today = iso(new Date());
        const logs = (h.logs || []).map((l) => Object.assign({}, l));
        let entry = logs.find((l) => l.date === today);
        if (!entry) { entry = { date: today, count: 0, durationMin: 0 }; logs.push(entry); }
        entry.count += 1;
        if (durationMin) entry.durationMin = durationMin;
        dispatch('update', id, { logs });
    }
    function unlogHabitToday(id) {
        const h = habitById(id); if (!h) return;
        const today = iso(new Date());
        dispatch('update', id, { logs: (h.logs || []).filter((l) => l.date !== today) });
    }
    function decrementHabit(id) {
        const h = habitById(id); if (!h) return;
        const today = iso(new Date());
        const logs = (h.logs || []).map((l) => Object.assign({}, l));
        const entry = logs.find((l) => l.date === today);
        if (!entry) return;
        entry.count = Math.max(0, entry.count - 1);
        const pruned = (entry.count === 0 && !entry.durationMin) ? logs.filter((l) => l !== entry) : logs;
        dispatch('update', id, { logs: pruned });
    }
    function habitCountToday(h) {
        const entry = (h.logs || []).find((l) => l.date === iso(new Date()));
        return entry ? entry.count : 0;
    }
    function habitAvgMin(h) {
        const withTime = (h.logs || []).filter((l) => l.durationMin > 0);
        if (!withTime.length) return 0;
        return Math.round(withTime.reduce((s, l) => s + l.durationMin, 0) / withTime.length);
    }
    // The weekdays a habit is meant for (0 = Monday). A habit that arrived
    // without them (an older or outside copy) counts every day.
    function habitDays(h) { return Array.isArray(h && h.targetDays) && h.targetDays.length ? h.targetDays : [0, 1, 2, 3, 4, 5, 6]; }
    function habitWeekProgress(h) {
        const monday = startOfWeek(new Date());
        const week = Array.from({ length: 7 }, (_, i) => iso(addDays(monday, i)));
        const doneDays = week.filter((day) => (h.logs || []).some((l) => l.date === day && l.count > 0));
        return { done: doneDays.length, target: h.timesPerWeek || habitDays(h).length, days: week, doneDays };
    }
    function isHabitDoneOn(h, isoDate) { return (h.logs || []).some((l) => l.date === isoDate && l.count > 0); }
    // Tick or untick a habit on any past day (forgot to log it).
    function setHabitDoneOn(id, isoDate, done) {
        const h = habitById(id); if (!h) return;
        let logs = (h.logs || []).map((l) => Object.assign({}, l));
        const entry = logs.find((l) => l.date === isoDate);
        if (done) { if (entry) entry.count = Math.max(1, entry.count || 0); else logs.push({ date: isoDate, count: 1, durationMin: 0 }); }
        else logs = logs.filter((l) => l.date !== isoDate);
        dispatch('update', id, { logs });
    }
    function isHabitDoneToday(h) {
        const today = iso(new Date());
        return (h.logs || []).some((l) => l.date === today && l.count > 0);
    }

    window.Planner.Store = {
        Dates, COLORS, uid, on, emit, persist, reload,
        load, getSettings, setSettings, get state() { return selectors; },
        eventsForDate, countByDate, addEvent, updateEvent, deleteEvent, occursOn, isRepeating, skipOccurrence, REPEATS,
        deleteWithUndo, isPending, pendingKeys, flushPending, milestoneKey, milestonesOf, updateMilestone, updateProject,
        habitDays, isHabitDoneOn, setHabitDoneOn, findEntry,
        addTodo, toggleTodo, updateTodo, deleteTodo, derivedTodos, nextMilestone,
        isArchivedTodo, archivedCount, completedByDate, completedCountByDate,
        addProject, deleteProject, projectById, addMilestone, toggleMilestone, deleteMilestone,
        addHabit, deleteHabit, updateHabit, habitById, logHabit, unlogHabitToday, decrementHabit, habitCountToday,
        habitAvgMin, habitWeekProgress, isHabitDoneToday,
        // exposed for diagnostics / tests
        get _entries() { return entries; }, get _syncEnabled() { return syncEnabled; },
    };
})();
