// Notebook stats: an example mod. Copy this folder into your mods folder, then
// turn it on in Settings → Mods and tap Apply changes. See docs/MODS.md.
Memora.mod('notebook-stats', function (memora) {
  memora.i18n.add([
    ['Notebook stats', 'Estadísticas del cuaderno', 'Statistiques du carnet', 'Notizbuch-Statistik', '笔记统计'],
    ['Notes', 'Notas', 'Notes', 'Notizen', '笔记'],
    ['Words in notes', 'Palabras en notas', 'Mots dans les notes', 'Wörter in Notizen', '笔记字数'],
    ['Spent this month', 'Gastado este mes', 'Dépensé ce mois-ci', 'Diesen Monat ausgegeben', '本月支出'],
    ['Open to-dos', 'Tareas pendientes', 'Tâches ouvertes', 'Offene Aufgaben', '未完成的待办'],
  ]);
  const t = memora.i18n.t;

  function stats() {
    const notes = memora.data.list('notes');
    const words = notes.reduce((n, e) => n + String(e.description || '').split(/\s+/).filter(Boolean).length, 0);
    const now = new Date();   // this month on this device (toISOString would be the UTC one)
    const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const spent = memora.data.list('spending')
      .filter((e) => String(e.purchaseDate || '').startsWith(month))
      .reduce((n, e) => n + (Number(e.total) || 0), 0);
    const todos = memora.data.list('plans').filter((e) => e.kind === 'todo' && !e.done).length;
    return [[t('Notes'), notes.length], [t('Words in notes'), words], [t('Spent this month'), spent.toFixed(2)], [t('Open to-dos'), todos]];
  }

  function draw(body) {
    body.innerHTML = '';
    const list = document.createElement('dl');
    list.className = 'notebook-stats';
    for (const [label, value] of stats()) {
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value;
      list.append(dt, dd);
    }
    body.append(list);
  }

  let open = null;
  memora.menu.add({ label: t('Notebook stats'), icon: 'svg-icon-chart', run: () => {
    open = memora.ui.sheet(t('Notebook stats'), draw);
    open.element.addEventListener('close', () => { open = null; });
  } });
  // Keep an open sheet up to date while you work.
  memora.on('saved', () => { if (open) draw(open.element.querySelector('.content')); });
});
