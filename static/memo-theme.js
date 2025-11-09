/**
 * memo-theme.js
 * Handles dark/light theme toggle and mobile menu functionality
 * Syncs theme settings across variants using localStorage
 */

(function() {
    'use strict';

    // Use same SETTINGS_KEY as memo-core.js for cross-variant sync
    const THEME_STORAGE_KEY = 'memoTheme';
    
    // Initialize theme on page load
    function initTheme() {
        const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
        applyTheme(savedTheme);
        updateThemeButton(savedTheme);
    }
    
    // Apply theme to document
    function applyTheme(theme) {
        if (theme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    }
    
    // Update theme toggle button icon
    function updateThemeButton(theme) {
        const btn = document.getElementById('themeToggleBtn');
        if (btn) {
            btn.textContent = theme === 'light' ? '☀️' : '🌙';
            btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
        }
    }
    
    // Toggle between light and dark theme
    function toggleTheme() {
        const currentTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        localStorage.setItem(THEME_STORAGE_KEY, newTheme);
        applyTheme(newTheme);
        updateThemeButton(newTheme);
    }
    
    // Mobile Menu Functions
    function openMobileMenu() {
        const menu = document.getElementById('mobileMenu');
        const overlay = document.getElementById('mobileOverlay');
        if (menu) menu.classList.add('open');
        if (overlay) overlay.classList.add('open');
        
        // Sync category filter options from desktop to mobile
        syncCategoryOptions();
    }
    
    function closeMobileMenu() {
        const menu = document.getElementById('mobileMenu');
        const overlay = document.getElementById('mobileOverlay');
        if (menu) menu.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
    }
    
    // Sync category filter options between desktop and mobile
    function syncCategoryOptions() {
        const desktopFilter = document.getElementById('categoryFilter');
        const mobileFilter = document.getElementById('mobileCategoryFilter');
        
        if (desktopFilter && mobileFilter) {
            // Clear mobile options first
            mobileFilter.innerHTML = '';
            
            // Copy all options from desktop to mobile
            Array.from(desktopFilter.options).forEach(opt => {
                const newOpt = document.createElement('option');
                newOpt.value = opt.value;
                newOpt.textContent = opt.textContent;
                if (opt.selected) newOpt.selected = true;
                mobileFilter.appendChild(newOpt);
            });
        }
    }
    
    // Sync filter changes between desktop and mobile
    function setupFilterSync() {
        const desktopCat = document.getElementById('categoryFilter');
        const mobileCat = document.getElementById('mobileCategoryFilter');
        const desktopSearch = document.getElementById('searchBox');
        const mobileSearch = document.getElementById('mobileSearchBox');
        
        // Sync category filter: desktop -> mobile
        if (desktopCat && mobileCat) {
            desktopCat.addEventListener('change', () => {
                mobileCat.value = desktopCat.value;
            });
            
            // Sync category filter: mobile -> desktop
            mobileCat.addEventListener('change', () => {
                desktopCat.value = mobileCat.value;
                desktopCat.dispatchEvent(new Event('change'));
                closeMobileMenu();
            });
        }
        
        // Sync search box: desktop -> mobile
        if (desktopSearch && mobileSearch) {
            desktopSearch.addEventListener('input', () => {
                mobileSearch.value = desktopSearch.value;
            });
            
            // Sync search box: mobile -> desktop
            mobileSearch.addEventListener('input', () => {
                desktopSearch.value = mobileSearch.value;
                desktopSearch.dispatchEvent(new Event('input'));
            });
        }
    }
    
    // Setup mobile menu button delegations
    function setupMobileMenuButtons() {
        // Map mobile buttons to desktop button clicks
        const buttonPairs = [
            ['mobileChatBtn', 'chatBtn'],
            ['mobileFiltersBtn', 'filtersBtn'],
            ['mobileCalendarBtn', 'calendarBtn'],
            ['mobileRecycleBinBtn', 'recycleBinBtn'],
            ['mobileChooseDirBtn', 'chooseDirBtn']
        ];
        
        buttonPairs.forEach(([mobileId, desktopId]) => {
            const mobileBtn = document.getElementById(mobileId);
            const desktopBtn = document.getElementById(desktopId);
            
            if (mobileBtn && desktopBtn) {
                mobileBtn.addEventListener('click', () => {
                    desktopBtn.click();
                    closeMobileMenu();
                });
            }
        });
    }
    
    // Initialize everything when DOM is ready
    function init() {
        // Initialize theme
        initTheme();
        
        // Theme toggle button
        const themeBtn = document.getElementById('themeToggleBtn');
        if (themeBtn) {
            themeBtn.addEventListener('click', toggleTheme);
        }
        
        // Hamburger menu button
        const hamburgerBtn = document.getElementById('hamburgerBtn');
        if (hamburgerBtn) {
            hamburgerBtn.addEventListener('click', openMobileMenu);
        }
        
        // Mobile menu close button
        const closeBtn = document.getElementById('mobileMenuClose');
        if (closeBtn) {
            closeBtn.addEventListener('click', closeMobileMenu);
        }
        
        // Mobile overlay click to close
        const overlay = document.getElementById('mobileOverlay');
        if (overlay) {
            overlay.addEventListener('click', closeMobileMenu);
        }
        
        // Setup filter sync
        setupFilterSync();
        
        // Setup mobile menu button delegations
        setupMobileMenuButtons();
        
        // Close menu on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeMobileMenu();
            }
        });
        
        // Listen for storage events to sync theme across tabs/variants
        window.addEventListener('storage', (e) => {
            if (e.key === THEME_STORAGE_KEY) {
                const newTheme = e.newValue || 'dark';
                applyTheme(newTheme);
                updateThemeButton(newTheme);
            }
        });
    }
    
    // Run init when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
