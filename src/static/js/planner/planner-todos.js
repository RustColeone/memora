/* planner-todos.js — the to-do list: standalone to-dos plus each project's next
   milestone, grouped by when they are due. Adding takes a due chip; tapping a
   row opens it in place to edit; delete waits behind Undo. */
(function () {
    'use strict';
    const P = window.Planner, S = P.Store, D = S.Dates, U = P.UI;
    const { t, esc, el, icon } = U;

    let addDue = 'today', addHigh = false;
    function dueFromChip(v) {
        if (v === 'today') return D.iso(new Date());
        if (v === 'tomorrow') return D.iso(D.addDays(new Date(), 1));
        if (v === 'none') return '';
        return v;   // a picked date
    }

    function group(item) {
        if (item.done) return 'done';
        if (!item.due) return 'none';
        const n = U.daysFromToday(item.due);
        if (n < 0) return 'late';
        if (n === 0) return 'today';
        if (n <= 6) return 'week';
        return 'later';
    }
    const GROUPS = [['late', 'Overdue'], ['today', 'Today'], ['week', 'This week'], ['later', 'Later'], ['none', 'No date'], ['done', 'Done']];

    function check(item) {
        const b = el('button', 'todo-check' + (item.done ? ' on' : ''), item.done ? icon('check') : '');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(!!item.done));
        b.setAttribute('aria-label', item.done ? t('Mark “{name}” not done', { name: item.title }) : t('Mark “{name}” done', { name: item.title }));
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (item.kind === 'milestone') S.toggleMilestone(item.projectId, item.id); else S.toggleTodo(item.id);
        });
        return b;
    }

    function row(item) {
        const li = el('li', 'todo-item' + (item.done ? ' done' : '') + (item.kind === 'milestone' ? ' is-milestone' : ''));
        li.appendChild(check(item));
        const main = el('button', 'todo-main');
        main.type = 'button';
        const late = !item.done && item.due && U.daysFromToday(item.due) < 0;
        const meta = [];
        if (item.kind === 'milestone') meta.push(`<span class="pill proj" style="background:${esc(item.color)}">${icon('flag')} ${esc(item.projectName)}</span>`);
        if (item.due) meta.push(`<span class="${late ? 'pl-late' : ''}">${esc(U.dueText(item.due))}</span>`);
        if (item.note) meta.push(`<span class="todo-note">${esc(item.note)}</span>`);
        main.innerHTML = `<span class="todo-text">${esc(item.title)}</span>${meta.length ? `<span class="todo-meta">${meta.join('')}</span>` : ''}`;
        main.setAttribute('aria-label', item.kind === 'milestone' ? t('Open {name}', { name: item.projectName }) : t('Edit “{name}”', { name: item.title }));
        main.addEventListener('click', () => {
            if (item.kind === 'milestone') { S.state.ui.activeProject = item.projectId; P.setTab('projects'); return; }
            S.state.ui.todoEditing = S.state.ui.todoEditing === item.id ? null : item.id; S.persist();
        });
        li.appendChild(main);
        if (item.priority === 'high' && !item.done) li.appendChild(el('span', 'pill high', esc(t('high'))));
        return li;
    }

    function editor(item) {
        const li = el('li', 'todo-item todo-editing');
        li.dataset.todoId = 'edit:' + item.id;
        const box = el('div', 'todo-edit');
        box.innerHTML = `<div class="field"><label for="tdEdTitle">${esc(t('To-do'))}</label><input id="tdEdTitle" autocomplete="off" value="${esc(item.title)}"></div>` +
            `<div class="field"><span class="pl-lbl">${esc(t('Due'))}</span><div class="pl-chips" id="tdEdDue"></div></div>` +
            `<div class="field"><label for="tdEdNote">${esc(t('Note'))}</label><input id="tdEdNote" autocomplete="off" placeholder="${esc(t('Optional'))}" value="${esc(item.note || '')}"></div>` +
            `<div class="todo-edit-acts"><button type="button" class="ghost danger" id="tdEdDel">${esc(t('Delete'))}</button><span class="spacer"></span>` +
            `<button type="button" class="primary" id="tdEdDone">${esc(t('Done'))}</button></div>`;
        li.appendChild(box);
        let due = item.due || '', high = item.priority === 'high';
        const dueBox = box.querySelector('#tdEdDue');
        function drawDue() {
            const today = D.iso(new Date()), tom = D.iso(D.addDays(new Date(), 1));
            const sel = due === today ? 'today' : due === tom ? 'tomorrow' : due ? 'pick' : 'none';
            const pick = el('span', 'pl-chip pl-date-chip' + (sel === 'pick' ? ' on' : ''), `${icon('calendar')}<span>${esc(sel === 'pick' ? U.dayName(due, { long: true }) : t('Pick a date'))}</span><input type="date" aria-label="${esc(t('Due date'))}" value="${esc(due)}">`);
            const hi = el('button', 'pl-chip pl-hi' + (high ? ' on' : ''), esc('! ' + t('High')));
            hi.type = 'button'; hi.setAttribute('aria-pressed', String(high));
            hi.addEventListener('click', () => { high = !high; drawDue(); });
            U.chipGroup(dueBox, [{ value: 'today', label: t('Today') }, { value: 'tomorrow', label: t('Tomorrow') }, { value: 'none', label: t('No date') }], sel,
                (v) => { due = dueFromChip(v); drawDue(); });
            dueBox.insertBefore(pick, dueBox.lastElementChild);
            dueBox.appendChild(hi);
            const input = pick.querySelector('input');
            input.addEventListener('change', () => { due = input.value; drawDue(); });
            input.addEventListener('click', () => { try { if (input.showPicker) input.showPicker(); } catch (_) {} });
        }
        drawDue();
        const save = () => {
            const title = box.querySelector('#tdEdTitle').value.trim();
            S.state.ui.todoEditing = null;
            S.updateTodo(item.id, { title: title || item.title, due, priority: high ? 'high' : 'normal', note: box.querySelector('#tdEdNote').value.trim() });
        };
        box.querySelector('#tdEdDone').addEventListener('click', save);
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'date') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); S.state.ui.todoEditing = null; S.persist(); }
        });
        box.querySelector('#tdEdDel').addEventListener('click', () => {
            S.state.ui.todoEditing = null;
            S.deleteWithUndo(item.id, t('“{name}” deleted', { name: item.title }), () => S.deleteTodo(item.id));
        });
        return li;
    }

    const rowCache = new Map();
    function render() {
        const list = document.getElementById('todoList');
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const items = S.derivedTodos();
        const open = items.filter((x) => !x.done).length;
        document.getElementById('todoCount').textContent = open === 1 ? t('1 open') : t('{n} open', { n: open });
        const editing = S.state.ui.todoEditing;
        const desired = [];
        const buckets = {};
        items.forEach((x) => { (buckets[group(x)] = buckets[group(x)] || []).push(x); });
        GROUPS.forEach(([key, name]) => {
            const rows = (buckets[key] || []).sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9')) || ((b.priority === 'high') - (a.priority === 'high')));
            if (!rows.length) return;
            const head = el('li', 'todo-group' + (key === 'late' ? ' late' : ''), `<span>${esc(t(name))}</span><span>${rows.length}</span>`);
            head.dataset.todoId = 'group:' + key;
            const oldHead = rowCache.get(head.dataset.todoId);
            const headNode = oldHead ? window.MemoDom.patch(oldHead, head) : head;
            rowCache.set(head.dataset.todoId, headNode); desired.push(headNode);
            rows.forEach((x) => {
                if (x.kind === 'todo' && x.id === editing) {
                    const node = rowCache.get('edit:' + x.id) || editor(x);
                    rowCache.set('edit:' + x.id, node); desired.push(node);
                    return;
                }
                const li = row(x);
                const key2 = x.kind + ':' + (x.projectId || '') + ':' + x.id;
                li.dataset.todoId = key2;
                const old = rowCache.get(key2);
                const node = old ? window.MemoDom.patch(old, li) : li;
                rowCache.set(key2, node); desired.push(node);
            });
        });
        if (!items.length) {
            const empty = el('li', 'muted pl-empty', esc(t('Nothing yet — add a to-do above.')));
            empty.dataset.todoId = 'empty';
            desired.push(empty);
        }
        window.MemoDom.reconcile(list, desired);
        // A row that moved (e.g. ticked into Done) keeps keyboard focus.
        if (focused && focused.isConnected && document.activeElement !== focused) { try { focused.focus({ preventScroll: true }); } catch (_) {} }
        for (const [key, node] of rowCache) if (!desired.includes(node)) rowCache.delete(key);
        const ed = list.querySelector('#tdEdTitle');
        if (ed && !ed.dataset.focused) { ed.dataset.focused = '1'; try { ed.focus({ preventScroll: false }); } catch (_) {} }
    }

    function drawAddChips() {
        const box = document.getElementById('todoDueChips'); if (!box) return;
        const picked = addDue !== 'today' && addDue !== 'tomorrow' && addDue !== 'none';
        const pick = el('span', 'pl-chip pl-date-chip' + (picked ? ' on' : ''), `${icon('calendar')}<span>${esc(picked ? U.dayName(addDue, { long: true }) : t('Pick a date'))}</span><input type="date" aria-label="${esc(t('Due date'))}" value="${esc(picked ? addDue : '')}">`);
        const hi = el('button', 'pl-chip pl-hi' + (addHigh ? ' on' : ''), esc('! ' + t('High')));
        hi.type = 'button'; hi.setAttribute('aria-pressed', String(addHigh));
        hi.addEventListener('click', () => { addHigh = !addHigh; drawAddChips(); });
        U.chipGroup(box, [{ value: 'today', label: t('Today') }, { value: 'tomorrow', label: t('Tomorrow') }, { value: 'none', label: t('No date') }], picked ? 'pick' : addDue,
            (v) => { addDue = v; drawAddChips(); });
        box.insertBefore(pick, box.lastElementChild);
        box.appendChild(hi);
        const input = pick.querySelector('input');
        input.addEventListener('change', () => { if (input.value) { addDue = input.value; drawAddChips(); } });
        input.addEventListener('click', () => { try { if (input.showPicker) input.showPicker(); } catch (_) {} });
    }

    function addFromInput() {
        const inp = document.getElementById('todoInput');
        const v = inp.value.trim();
        if (!v) return;
        S.addTodo({ title: v, due: dueFromChip(addDue), priority: addHigh ? 'high' : 'normal' });
        inp.value = '';
        addHigh = false; drawAddChips();
        inp.focus();
    }

    function mount() {
        document.getElementById('todoAddBtn').addEventListener('click', addFromInput);
        document.getElementById('todoInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFromInput(); });
        drawAddChips();
        document.addEventListener('memo:localechange', drawAddChips);
    }

    P.Todos = { mount, render };
})();
