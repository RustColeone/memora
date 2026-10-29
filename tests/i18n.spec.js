// i18n (memo-i18n.js): translation table + t() (fallback + interpolation) and
// the data-i18n DOM applier, driving the header/menu/Settings chrome across
// languages, with a persisted Settings language picker.
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoI18n, null, { timeout: 15000 });
}

test('t() resolves the active locale, falls back to English, and interpolates', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const I = window.MemoI18n;
    I.setLocale('es');
    const es = I.t('filters');
    I.setLocale('fr');
    const fr = I.t('calendar');
    I.setLocale('xx');                 // unknown → English
    const fallbackLocale = I.t('filters');
    const unknownKey = I.t('nope_missing_key'); // unknown key → the key itself
    return { es, fr, fallbackLocale, unknownKey };
  });
  expect(r.es).toBe('Filtros');
  expect(r.fr).toBe('Calendrier');
  expect(r.fallbackLocale).toBe('Filters'); // xx unknown → en
  expect(r.unknownKey).toBe('nope_missing_key');
});

test('choosing a language translates the chrome, persists, and survives reload', async ({ page }) => {
  await boot(page);
  const es = await page.evaluate(() => {
    window.MemoI18n.choose('es');
    return {
      filters: document.querySelector('#filtersBtn .btn-label').textContent,
      chat: document.querySelector('#chatBtn .btn-label').textContent,
      placeholder: document.getElementById('searchBox').getAttribute('placeholder'),
      htmlLang: document.documentElement.getAttribute('lang'),
      stored: localStorage.getItem('memoLang'),
    };
  });
  expect(es.filters).toBe('Filtros');
  expect(es.chat).toBe('Chat');       // 'Chat' is the same word in es
  expect(es.placeholder).toBe('Buscar descripción / etiquetas…');
  expect(es.htmlLang).toBe('es');
  expect(JSON.parse(es.stored)).toEqual({ useSystem: false, locale: 'es' });

  await page.reload();
  await boot(page);
  // Wait for MemoCore to render the dynamic recycle-bin badge (JS-built chrome).
  await page.waitForFunction(() => window.MemoCore && /\S/.test(document.querySelector('#recycleBinBtn .btn-label')?.textContent || ''), null, { timeout: 15000 });
  const after = await page.evaluate(() => ({
    filters: document.querySelector('#filtersBtn .btn-label').textContent,
    settingsTitle: document.querySelector('#settingsDlg [data-i18n="settings"]').textContent,
    bin: document.querySelector('#recycleBinBtn .btn-label').textContent,
    lang: document.documentElement.getAttribute('lang'),
  }));
  expect(after.filters).toBe('Filtros');       // persisted across reload
  expect(after.settingsTitle).toBe('Ajustes'); // shared Settings dialog also localised
  expect(after.bin).toBe('Papelera');          // JS-rendered badge localised too
  expect(after.lang).toBe('es');
});

test('Settings language picker is populated and switching it re-localises the page', async ({ page }) => {
  await boot(page);
  const opts = await page.evaluate(() => [...document.getElementById('languageSelect').options].map(o => o.value));
  expect(opts).toContain('system');
  expect(opts).toEqual(expect.arrayContaining(['en', 'es', 'fr', 'de', 'zh']));

  const de = await page.evaluate(() => {
    const sel = document.getElementById('languageSelect');
    sel.value = 'de';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      filters: document.querySelector('#filtersBtn .btn-label').textContent,
      verify: document.querySelector('[data-i18n="verifyRepair"]').textContent,
    };
  });
  expect(de.filters).toBe('Filter');            // German
  expect(de.verify).toBe('Prüfen & Reparieren');
});

test('finance page header is localised by the same shared machinery', async ({ page }) => {
  await page.goto('/finance.html');
  await page.waitForFunction(() => window.MemoI18n, null, { timeout: 15000 });
  const fr = await page.evaluate(() => {
    window.MemoI18n.choose('fr');
    return document.querySelector('#filtersBtn .btn-label').textContent;
  });
  expect(fr).toBe('Filtres');
});
