// memo-saved-searches.js — Saved searches: name what you are looking at (the
// search text, folder, tags, dates, favourites) plus a few smart conditions,
// and reopen it later as a folder that updates by itself. Ported from
// ImageDB's saved-searches.js for the Memo page. Stored with the person's
// settings (key saved_searches) and carried in backups.
(function (global) {
  'use strict';

  const KEY = 'saved_searches';
  const LIMIT = 100;
  const $id = id => document.getElementById(id);
  const t = (text, vars) => (global.MemoI18n?.t ? global.MemoI18n.t(text, vars) : text);
  const sdb = () => global.MemoStateDb;
  let editing = null;

  function uid() { return 'ss_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function normalize(list) {
    return (Array.isArray(list) ? list : []).filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && item.rule && typeof item.rule === 'object')
      .slice(0, LIMIT).sort((a, b) => a.name.localeCompare(b.name));
  }
  function load() { return normalize(sdb()?.getItem?.(KEY)); }
  function save(list) { sdb()?.setItem?.(KEY, normalize(list)); }

  function currentRule() {
    const { activeFilters, els } = global.MemoCore.getState();
    const smart = global.MemoInsights?.smartView?.() || {};
    const category = els.categoryFilter && els.categoryFilter.value !== '__ALL__' ? els.categoryFilter.value : null;
    return {
      search: (els.searchBox?.value || '').trim(),
      cats: category ? [category] : [...(activeFilters.cats || [])],
      tags: [...(activeFilters.tags || [])], tagMatch: activeFilters.tagMatch === 'all' ? 'all' : 'any',
      dateFrom: activeFilters.dateFrom || null, dateTo: activeFilters.dateTo || null, favorite: !!activeFilters.favorite,
      autoAlbum: smart.autoAlbum || null,
    };
  }
  function describe(rule) {
    const parts = [];
    if (rule.search) parts.push('“' + rule.search + '”');
    if (rule.cats?.length) parts.push(rule.cats.join(', '));
    if (rule.tags?.length) parts.push(rule.tags.map(tag => '#' + tag).join(' '));
    if (rule.autoAlbum) parts.push(global.MemoAutoLabels?.albumName(rule.autoAlbum) || rule.autoAlbum);
    if (rule.days) parts.push(t('last {n} days', { n: rule.days }));
    if (rule.favorite) parts.push(t('favourites'));
    if (rule.missingDescription) parts.push(t('no description'));
    if (rule.missingTags) parts.push(t('no tags'));
    if (rule.missingFolder) parts.push(t('not in a folder'));
    return parts.join(' · ') || t('everything');
  }

  async function apply(item) {
    if (global.MEMO_VARIANT !== 'default' && global.MemoSpaShell?.switchTo) await global.MemoSpaShell.switchTo('default');
    const { activeFilters, els } = global.MemoCore.getState();
    const rule = item.rule;
    if (els.categoryFilter) els.categoryFilter.value = '__ALL__';
    activeFilters.cats = new Set(rule.cats || []);
    activeFilters.tags = new Set(rule.tags || []);
    activeFilters.tagMatch = rule.tagMatch === 'all' ? 'all' : 'any';
    activeFilters.dateFrom = rule.days ? null : (rule.dateFrom || null);
    activeFilters.dateTo = rule.days ? null : (rule.dateTo || null);
    activeFilters.favorite = !!rule.favorite;
    if (els.searchBox) els.searchBox.value = rule.search || '';
    $id('savedSearchDlg')?.close();
    const extras = { name: item.name, days: rule.days || 0, missingDescription: !!rule.missingDescription,
      missingTags: !!rule.missingTags, missingFolder: !!rule.missingFolder, autoAlbum: rule.autoAlbum || null };
    const any = extras.days || extras.missingDescription || extras.missingTags || extras.missingFolder || extras.autoAlbum;
    if (global.MemoInsights?.setSmartView) await global.MemoInsights.setSmartView(any ? extras : null);
    else global.MemoCore.renderFeed();
  }

  function fillForm(item = null) {
    editing = item;
    const rule = item?.rule || currentRule();
    $id('savedSearchName').value = item?.name || '';
    $id('savedSearchDays').value = String(rule.days || 0);
    $id('savedSearchMissingDescription').checked = !!rule.missingDescription;
    $id('savedSearchMissingTags').checked = !!rule.missingTags;
    $id('savedSearchMissingFolder').checked = !!rule.missingFolder;
    $id('savedSearchCurrent').textContent = t('Saves: {what}', { what: describe(rule) });
    $id('savedSearchSave').textContent = item ? t('Save changes') : t('Save search');
  }
  function render() {
    global.MemoInsights?.renderAlbums?.($id('savedSearchAlbums'));
    const list = $id('savedSearchList');
    list.replaceChildren();
    const items = load();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = t('No saved searches yet. Filter or search the Memo page, then save it here.');
      list.append(empty);
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'saved-search-row';
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'ghost saved-search-open';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const what = document.createElement('small');
      what.textContent = describe(item.rule);
      openBtn.append(name, what);
      openBtn.addEventListener('click', () => void apply(item));
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'ghost'; edit.textContent = t('Edit');
      edit.setAttribute('aria-label', t('Edit') + ': ' + item.name);
      edit.addEventListener('click', () => { fillForm(item); $id('savedSearchName').focus(); });
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'ghost'; remove.textContent = t('Delete');
      remove.setAttribute('aria-label', t('Delete') + ': ' + item.name);
      remove.addEventListener('click', async () => {
        if (!await global.MemoShell.confirm(t('Delete the saved search “{name}”?', { name: item.name }), { okLabel: t('Delete'), danger: true })) return;
        save(load().filter(other => other.id !== item.id));
        if (editing?.id === item.id) fillForm();
        render();
      });
      row.append(openBtn, edit, remove);
      list.append(row);
    }
  }
  function submit() {
    const name = $id('savedSearchName').value.trim();
    if (!name) { $id('savedSearchName').focus(); return; }
    const items = load();
    if (!editing && items.length >= LIMIT) { global.MemoShell?.toast?.(t('You can keep up to {n} saved searches.', { n: LIMIT }), { kind: 'error' }); return; }
    const rule = Object.assign({}, editing?.rule || currentRule(), {
      days: Number($id('savedSearchDays').value) || 0,
      missingDescription: $id('savedSearchMissingDescription').checked,
      missingTags: $id('savedSearchMissingTags').checked,
      missingFolder: $id('savedSearchMissingFolder').checked,
    });
    if (rule.days) { rule.dateFrom = null; rule.dateTo = null; }
    const item = { version: 1, id: editing?.id || uid(), name: name.slice(0, 80), rule };
    save([...items.filter(other => other.id !== item.id), item]);
    global.MemoShell?.toast?.(t('Saved'), { kind: 'success' });
    fillForm();
    render();
  }
  function open() {
    const dialog = $id('savedSearchDlg');
    if (!dialog || document.body.classList.contains('privacy-locked') || global.MEMO_VARIANT === 'planner') return;
    global.MemoAdvancedTools?.close?.();
    global.MemoShell?.closeMenu?.();
    fillForm();
    render();
    if (global.MemoTools?.showDialog) global.MemoTools.showDialog(dialog); else if (!dialog.open) dialog.showModal();
  }
  function wire() {
    $id('advancedSavedSearchBtn')?.addEventListener('click', open);
    $id('savedSearchClose')?.addEventListener('click', () => $id('savedSearchDlg').close());
    $id('savedSearchSave')?.addEventListener('click', submit);
    $id('savedSearchNew')?.addEventListener('click', () => fillForm());
    document.addEventListener('memo:privacy-locked', () => { editing = null; $id('savedSearchList')?.replaceChildren(); const d = $id('savedSearchDlg'); if (d?.open) d.close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  global.MemoSavedSearches = { open, apply, list: load, currentRule, KEY };
})(window);
