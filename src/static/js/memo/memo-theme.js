/**
 * memo-theme.js — memo/finance-only chrome: desktop↔mobile filter/search sync
 * and mobile-menu button delegation. Theme toggle + hamburger open/close now
 * live in the shared memo-shell.js (loaded by every page); this keeps only the
 * pieces that assume a category filter, a search box and the rich toolbar.
 */
(function () {
    'use strict';

    function closeMenu() { if (window.MemoShell) window.MemoShell.closeMenu(); }

    // Copy all <option>s (and the selected one) from a desktop select into its
    // mobile-menu counterpart. Generic; no-ops if either element is absent.
    function syncOptions(desktopId, mobileId) {
        const desktopSel = document.getElementById(desktopId);
        const mobileSel = document.getElementById(mobileId);
        if (desktopSel && mobileSel) {
            mobileSel.innerHTML = '';
            Array.from(desktopSel.options).forEach(opt => {
                const newOpt = document.createElement('option');
                newOpt.value = opt.value;
                newOpt.textContent = opt.textContent;
                if (opt.disabled) newOpt.disabled = true;
                if (opt.selected) newOpt.selected = true;
                mobileSel.appendChild(newOpt);
            });
        }
    }
    function syncCategoryOptions() { syncOptions('categoryFilter', 'mobileCategoryFilter'); }

    // Keep the desktop and mobile search boxes (and, where present, the category
    // select) in step.
    function setupFilterSync() {
        const desktopCat = document.getElementById('categoryFilter');
        const mobileCat = document.getElementById('mobileCategoryFilter');
        const desktopSearch = document.getElementById('searchBox');
        const mobileSearch = document.getElementById('mobileSearchBox');

        if (desktopCat && mobileCat) {
            desktopCat.addEventListener('change', () => { mobileCat.value = desktopCat.value; });
            mobileCat.addEventListener('change', () => {
                desktopCat.value = mobileCat.value;
                desktopCat.dispatchEvent(new Event('change'));
                closeMenu();
            });
        }
        if (desktopSearch && mobileSearch) {
            desktopSearch.addEventListener('input', () => { mobileSearch.value = desktopSearch.value; });
            mobileSearch.addEventListener('compositionstart', () => {
                desktopSearch.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            });
            mobileSearch.addEventListener('compositionend', event => {
                desktopSearch.value = mobileSearch.value;
                desktopSearch.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: event.data || '' }));
            });
            mobileSearch.addEventListener('input', event => {
                desktopSearch.value = mobileSearch.value;
                desktopSearch.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: !!event.isComposing }));
            });
        }
    }

    // Mobile-menu action buttons delegate to their desktop counterparts, then
    // close the menu. (The in-menu Day/Week/Month/Year group buttons are NOT in
    // this list, so selecting a period leaves the menu open — by design.)
    function setupMobileMenuButtons() {
        const buttonPairs = [
            ['mobileChatBtn', 'chatBtn'],
            ['mobileFiltersBtn', 'filtersBtn'],
            ['mobileRecycleBinBtn', 'recycleBinBtn'],
            ['mobileChooseDirBtn', 'chooseDirBtn']
        ];
        buttonPairs.forEach(([mobileId, desktopId]) => {
            const mobileBtn = document.getElementById(mobileId);
            const desktopBtn = document.getElementById(desktopId);
            if (mobileBtn && desktopBtn) {
                mobileBtn.addEventListener('click', () => { desktopBtn.click(); closeMenu(); });
            }
        });
    }

    function init() {
        setupFilterSync();
        setupMobileMenuButtons();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Back-compat: other modules call MemoTheme.closeMobileMenu() to close the menu.
    window.MemoTheme = { closeMobileMenu: closeMenu, syncCategoryOptions: syncCategoryOptions };
})();
