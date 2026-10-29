// Persistent primary destinations; the existing SPA controller owns navigation.
(function (global) {
  const nav = document.createElement('nav');
  nav.id = 'primaryNav'; nav.className = 'primary-nav'; nav.setAttribute('data-i18n-aria', 'Main navigation');
  // Discover (memo-discover.js) is a layer over the current page, not a page.
  nav.innerHTML = [['default','Memo','book','index.html'],['finance','Finance','cash','finance.html'],['planner','Planner','calendar','planner.html']]
    .map(([variant,label,icon,url]) => `<a href="${url}" data-variant="${variant}"><span class="svg-icon svg-icon-${icon}" aria-hidden="true"></span><span data-i18n="${label}">${global.MemoI18n.t(label)}</span></a>`).join('') +
    `<a href="#discover" data-view="discover"><span class="svg-icon svg-icon-compass" aria-hidden="true"></span><span data-i18n="Discover">${global.MemoI18n.t('Discover')}</span></a>`;
  function reflect() {
    nav.setAttribute('aria-label', global.MemoI18n.t('Main navigation'));
    global.MemoI18n.apply(nav);
    const variant = global.MemoSpaShell?.getVariant() || global.MEMO_VARIANT || 'default';
    const discover = !!global.MemoDiscover?.isOpen();
    nav.querySelectorAll('a').forEach(link => {
      const current = discover ? link.dataset.view === 'discover' : link.dataset.variant === variant;
      if (current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
  }
  function init() { document.body.classList.add('has-primary-nav'); document.body.append(nav); reflect(); }
  document.addEventListener('memo:variant-changed', reflect);
  document.addEventListener('memo:localechange', reflect);
  document.addEventListener('click', event => {
    if (event.target.closest('#mobileSyncBackupBtn')) {
      if (global.MemoSyncStatus) { global.MemoSyncStatus.open(); return; }
      document.getElementById('mobileSettingsBtn')?.click();
      for (const id of ['exportDataBtn', 'serverUrlInput']) document.getElementById(id)?.closest('.settings-section')?.classList.remove('collapsed');
      return;
    }
    const link = event.target.closest('#primaryNav a');
    if (link && link.dataset.variant && !global.MemoSpaShell) localStorage.setItem('memo_variant', link.dataset.variant);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
