// Default variant: card grid with ts-based date, no finance fields
(function(){
  const { els } = window.MemoCore.getState();

  // Tracks the current "view" (category / folder) so the staggered entrance
  // plays on a real view switch but not on every search keystroke (same view).
  let _lastViewKey = null;
  let _folderRevealContext = null;

  // Flash-free re-render: reuse a card's existing DOM node when its content
  // signature is unchanged, so a sync/hydrate re-render never rebuilds (and thus
  // never re-decodes) unchanged cards' images. Keyed 'e:'+id for entry cards and
  // 'f:'+cat for folder cards; value is { node, sig }.
  const _cardCache = new Map();
  function _entryCardSig(e, showCategory) {
    return JSON.stringify([
      e.description || '', e.category || '', e.ts || 0, !!showCategory,
      e.tags || [], (e.images || []).map(window.MemoDom.assetKey),
      (e.attachments || []).map(a => (a && (a.url || a.storedPath || a.name)) || ''),
      !!e._hasConflict, !!e._importing, !!e.favorite,
    ]);
  }
  function _folderCardSig(cat, entries) {
    const isImage = window.MemoCore.isImage;
    const previews = [];
    for (const e of entries) {
      for (const src of (e.images || [])) { if (isImage(src)) { previews.push(src); break; } }
      if (previews.length >= 3) break;
    }
    return JSON.stringify([cat, entries.length, previews]);
  }
  // Reused nodes carry group/fold classes from their previous slot; the render
  // loop re-applies the correct ones, so clear the transient set first.
  function _resetCardGroupClasses(node) {
    node.classList.remove('time-group-card', 'collapsed', 'folding-in', 'folding-out');
    delete node.dataset.group;
  }

  // Infinite-scroll windowing: render the first FEED_PAGE_SIZE image cards and grow
  // the window as a 1px sentinel scrolls into view. Reset when the view changes.
  const FEED_PAGE_SIZE = 60;
  let feedWindowCount = FEED_PAGE_SIZE;
  let feedWindowObserver = null;
  let _feedWindowKey = null;
  let restoredWindow = null;
  window.addEventListener('pagehide', event => {
    if (window.MemoLifecycle?.retain(event) || (event && event.persisted)) return;
    if (feedWindowObserver) feedWindowObserver.disconnect();
    feedWindowObserver = null;
  });

  // A PDF attachment renders in our reader (dark, paged) rather than the
  // browser's native white PDF viewer.
  function isPdfAttachment(a) {
    if (!a) return false;
    if (a.type === 'application/pdf') return true;
    return /\.pdf$/i.test(a.storedPath || a.url || a.name || '');
  }

  // In Capacitor mode, hide manual folder selection and browser-only saving hint
  if (typeof window !== 'undefined' && window.CAP_BOOT) {
    try {
      document.querySelectorAll('#chooseDirBtn,[data-hide-when-server]').forEach(el => { el.hidden = true; });
    } catch (e) { /* noop */ }
  }

  function normalizeServerMemo(m) {
    return {
      id: m.id,
      description: m.description || '',
      category: m.category || 'Uncategorized',
      tags: m.tags || [],
      ts: m.ts || Date.now(),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      deletedAt: m.deletedAt || null,
      deletedBy: m.deletedBy || null,
      permanentDeleteAt: m.permanentDeleteAt || null,
      images: m.images || [],
      attachments: m.attachments || [], // new field for non-image files
      imageMeta: m.imageMeta || {},
    };
  }

  function renderFeed() {
    const { db, settings, activeFilters } = window.MemoCore.getState();
    if (feedWindowObserver) { feedWindowObserver.disconnect(); feedWindowObserver = null; }
    // Recycle bin is a feed VIEW (like Safe), not a dialog — short-circuit here.
    if (trashView) { renderTrash(); return; }
    window.MemoCore.releaseTrashFeed();
    const q = els.searchBox ? els.searchBox.value.toLowerCase().trim() : '';
    const cat = els.categoryFilter ? els.categoryFilter.value : '__ALL__';
    const df = activeFilters.dateFrom ? new Date(activeFilters.dateFrom).getTime() : null;
    const dt = activeFilters.dateTo ? (new Date(activeFilters.dateTo).getTime() + 24 * 3600 * 1000 - 1) : null;
    const smartRule = window.MemoInsights && window.MemoInsights.hasSmartConditions() ? window.MemoInsights.smartView() : null;

    const filtered = db.entries
      .filter(e => e.deletedAt === null || e.deletedAt === undefined) // ← Exclude deleted entries
      // Privacy projection: hide Safe entries (unless Safe view is open) and gate
      // everything behind an unlocked L3. Applied first so folders/counts/tags
      // downstream never reveal a hidden entry. See memo-privacy.js.
      .filter(e => !window.MemoPrivacy || window.MemoPrivacy.canViewEntry(e))
      .filter(e => (cat === '__ALL__' ? true : e.category === cat))
      .filter(e => activeFilters.cats.size ? activeFilters.cats.has(e.category) : true)
      .filter(e => {
        if (df && e.ts < df) return false;
        if (dt && e.ts > dt) return false;
        if (activeFilters.tags.size) {
          const _et = e.tags || [];
          const _ok = (activeFilters.tagMatch === 'all')
            ? Array.from(activeFilters.tags).every(t => _et.includes(t))
            : _et.some(t => activeFilters.tags.has(t));
          if (!_ok) return false;
        }
        if (!q) return true;
        const inDesc = (e.description || '').toLowerCase().includes(q);
        const inTags = (e.tags || []).some(t => (t || '').toLowerCase().includes(q));
        // What is in the photos (on-device labels), in any UI language.
        return inDesc || inTags || !!(window.MemoInsights && window.MemoInsights.entryMatchesSearch(e, q));
      })
      .filter(e => activeFilters.favorite ? !!e.favorite : true)
      // Smart views: a smart album, Find similar, or a saved search's extras.
      .filter(e => !smartRule || window.MemoInsights.matchesSmart(e, smartRule))
      // Favourites float to the very top (their own pinned group in time-split);
      // Find similar orders by similarity instead.
      .sort((a, b) => {
        if (smartRule && smartRule.similarTo) return window.MemoInsights.entryScore(b, smartRule) - window.MemoInsights.entryScore(a, smartRule);
        const fa = a.favorite ? 1 : 0, fb = b.favorite ? 1 : 0;
        if (fa !== fb) return fb - fa;
        return b.ts - a.ts;
      });

  // Drop any prior infinite-scroll observer before rebuilding the feed. The feed
  // itself is cleared+repopulated atomically by renderGrid's replaceChildren
  // (which reuses unchanged card nodes), so we no longer wipe innerHTML here —
  // that wipe is what destroyed decoded images and flashed the screen on sync.
  if (feedWindowObserver) { feedWindowObserver.disconnect(); feedWindowObserver = null; }

  // Expose filtered list for external consumers (e.g., chat context)
  window.MemoVariant.__lastFiltered = () => filtered.slice();

    initGroupControl();
    const ts = normalizeTimeSplit(settings);
    syncGroupControl(ts);

    // Root view (no category/search/tag/date filter) collapses each category into
    // a folder card, like ImageDB. Inside a category (or any other filter) we show
    // the entries themselves, time-divider grouped.
    const categoryFiltered = (cat !== '__ALL__') || (activeFilters.cats && activeFilters.cats.size > 0);
    const otherFilters = !!(q || df || dt || (activeFilters.tags && activeFilters.tags.size) || activeFilters.favorite || smartRule);
    if (window.MemoInsights) window.MemoInsights.updateBanner();

    // Breadcrumb: show the current category with a Home crumb back to the root.
    let breadcrumbName = null;
    if (cat !== '__ALL__') breadcrumbName = cat;
    else if (activeFilters.cats && activeFilters.cats.size === 1) breadcrumbName = Array.from(activeFilters.cats)[0];
    updateBreadcrumb(breadcrumbName);
    // Remember which folder we're in so a new entry defaults to that category.
    currentCategory = breadcrumbName;

    // One unified render (ImageDB's order): at root, real-category "Albums" folder
    // cards + a loose "Uncategorized" (or time-period) section; inside a category or
    // any filter, just the matching entries. Inside a single category the per-card
    // "• category" is redundant, so showCategory is off there.
    const isFiltering = categoryFiltered || otherFilters;
    // Window ownership follows the complete result-set identity, not just the
    // category. Otherwise an expanded feed can leak its 120-card window into a
    // fresh search/tag/date result that should start at one page.
    const feedViewKey = JSON.stringify({
      category: cat,
      breadcrumb: breadcrumbName || '',
      query: q,
      dateFrom: activeFilters.dateFrom || '',
      dateTo: activeFilters.dateTo || '',
      categories: Array.from(activeFilters.cats || []).sort(),
      tags: Array.from(activeFilters.tags || []).sort(),
      timeSplit: ts.enabled ? ts.period : 'flat',
      smart: smartRule ? (smartRule.autoAlbum || (smartRule.similarTo && smartRule.similarTo.path) || smartRule.name || 'smart') : '',
    });
    renderGrid(filtered, {
      isFiltering,
      // Find similar keeps its best-first order: no date dividers.
      ts: smartRule && smartRule.similarTo ? Object.assign({}, ts, { enabled: false }) : ts,
      showCategory: !categoryFiltered,
      nonCatFilters: otherFilters,
      viewKey: feedViewKey,
    });

    // Lazy-load thumbnails near the viewport instead of fetching them all now.
    if (window.MemoLazy && els.feed) window.MemoLazy.hydrate(els.feed);
    // (Re)wire the add-card's hold-for-camera + FAB auto-hide for this render.
    if (window.MemoCapture && window.MemoCapture.initAddCard) window.MemoCapture.initAddCard();

    if (filtered.length === 0 && els.feed) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.gridColumn = '1 / -1';
      empty.textContent = 'No entries yet. Use the + card (or the + button) to add one, or adjust filters.';
      els.feed.appendChild(empty);
    }

    // Staggered "one by one" entrance — on the first render and on view switches
    // (opening/closing a folder, changing category), covering thumbnail-load
    // flashes. Skipped while typing in search since the view key is unchanged.
    const viewKey = String(cat) + '|' + (breadcrumbName || '');
    if (window.MemoMotion && els.feed && viewKey !== _lastViewKey &&
        !window.__memoTabSwitching && !window.__memoRestoring &&
        !(window.MemoMotion.circularRevealActive && window.MemoMotion.circularRevealActive())) {
      window.MemoMotion.stagger(els.feed.children, 'pop');
    }
    _lastViewKey = viewKey;

    // Re-apply selection visuals to the freshly-built cards (no-op unless active).
    if (window.MemoSelect) window.MemoSelect.render();

    updateFilterIndicator();
  }

  // Newest-activity-first [category, entries] pairs, EXCLUDING the loose
  // 'Uncategorized' pile. Loose entries never form a folder/category — clicking one
  // must open its detail, not navigate into a category (that was the bug).
  function getFolders(entries) {
    const byCat = new Map();
    for (const e of entries) {
      const c = e.category || 'Uncategorized';
      if (c === 'Uncategorized') continue;
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(e);
    }
    return Array.from(byCat.entries()).sort((a, b) => {
      const am = Math.max.apply(null, a[1].map(e => e.ts || 0));
      const bm = Math.max.apply(null, b[1].map(e => e.ts || 0));
      return bm - am;
    });
  }

  const dividerLabel = (key, fallback) =>
    (window.MemoI18n && window.MemoI18n.t && window.MemoI18n.t(key)) || fallback;

  // Unified feed render (mirrors ImageDB's foldable order):
  //   [Albums divider + folder cards]              — root only, real categories
  //   [Uncategorized | time-period dividers]       — the loose / filtered entries
  //   add-card at the top of the newest section
  //   image cards (windowed) + a 1px infinite-scroll sentinel
  // Every folder/entry card carries .time-group-card + data-group so its whole
  // section folds when its divider is clicked.
  function renderGrid(filtered, opts) {
    if (!els.feed) return;
    const timeSplit = !!opts.ts.enabled;
    const period = opts.ts.period;
    const showCategory = opts.showCategory;

    // Root shows Albums (real categories) + the loose Uncategorized pile as images.
    // Any active filter drops the folders and treats the whole result as images.
    const folders = opts.isFiltering ? [] : getFolders(filtered);
    const images = opts.isFiltering
      ? filtered
      : filtered.filter(e => (e.category || 'Uncategorized') === 'Uncategorized');

    // Reset the scroll window on a view change; cap it when IO is unavailable.
    if (opts.viewKey !== _feedWindowKey) { _feedWindowKey = opts.viewKey; feedWindowCount = restoredWindow || FEED_PAGE_SIZE; restoredWindow = null; }
    if (typeof IntersectionObserver !== 'function') feedWindowCount = images.length;
    const visible = images.slice(0, Math.min(feedWindowCount, images.length));

    // Add-card: shown at root and inside a category; hidden for non-category filters
    // (search / tags / date) and in select mode.
    const inSelect = window.MemoSelect && window.MemoSelect.active && window.MemoSelect.active();
    const showAdd = !inSelect && !opts.nonCatFilters;

    // Build the desired order without moving cached cards out of the live feed.
    const desired = [];
    const frag = { appendChild(node) { desired.push(node); } };
    const kept = new Set();

    // ── Albums (folder cards) ──
    // The cards live in one shelf (a swipeable row, or a compact grid); folding
    // the divider hides the whole shelf.
    if (folders.length) {
      frag.appendChild(makeFeedDivider('__folders__', dividerLabel('albums', 'Folders'), folders.length));
      const shelf = getFolderShelf();
      _resetCardGroupClasses(shelf);
      shelf.classList.add('time-group-card');
      shelf.dataset.group = '__folders__';
      if (collapsedGroups.has('__folders__')) shelf.classList.add('collapsed');
      const folderCards = [];
      for (const [cat, entries] of folders) {
        const card = buildFolderCard(cat, entries);
        _resetCardGroupClasses(card);
        folderCards.push(card);
        kept.add('f:' + cat);
      }
      window.MemoDom.reconcile(shelf, folderCards);
      frag.appendChild(shelf);
    }

    // ── Loose section: an "Uncategorized" divider (root, non-time-split) that heads
    // the add-card + loose cards — shown even with no loose cards yet, so the New Entry
    // card always sits UNDER "Uncategorized" (Albums · album cards · Uncategorized ·
    // Add card · loose cards), matching ImageDB.
    const showUncat = !opts.isFiltering && !timeSplit && (showAdd || visible.length > 0);
    if (showUncat) frag.appendChild(makeFeedDivider('__uncategorized__', dividerLabel('uncategorized', 'Uncategorized')));

    // Add-card at the top of the newest / uncategorized section (non-split placement).
    if (showAdd && !timeSplit) frag.appendChild(buildAddCard(showUncat ? '__uncategorized__' : null));

    // ── Image cards (windowed), time-period dividers when splitting ──
    let lastGroup = null;
    let addPlaced = !showAdd || !timeSplit;
    for (const e of visible) {
      let group = null;
      if (timeSplit) {
        const grp = e.favorite ? '__favorites__' : timePeriodKey(e.ts, period);
        if (grp !== lastGroup) {
          lastGroup = grp;
          frag.appendChild(makeFeedDivider(grp, grp === '__favorites__' ? '★ Favourites' : grp));
          if (!addPlaced) { frag.appendChild(buildAddCard(grp)); addPlaced = true; }
        }
        group = lastGroup;
      } else if (showUncat) {
        group = '__uncategorized__';
      }
      const card = buildCard(e, { showCategory: showCategory });
      _resetCardGroupClasses(card);
      if (group != null) {
        card.classList.add('time-group-card');
        card.dataset.group = group;
        if (collapsedGroups.has(group)) card.classList.add('collapsed');
      }
      frag.appendChild(card);
      kept.add('e:' + e.id);
    }
    // Time-split on but no images to anchor the add-card → still offer it.
    if (showAdd && timeSplit && !addPlaced) frag.appendChild(buildAddCard(null));

    // Only insert, move or remove nodes whose place in the view changed.
    window.MemoDom.reconcile(els.feed, desired);
    // One-line tag fitting needs the cards' final width, so measure next frame.
    requestAnimationFrame(function () { relayoutTags(); });
    // Evict cached nodes for cards no longer on screen so the cache stays bounded.
    for (const key of _cardCache.keys()) { if (!kept.has(key)) _cardCache.delete(key); }

    appendFeedWindowSentinel(images, opts, visible.length);
  }

  // Grow an existing feed in place. Keeping the already-rendered cards alive
  // preserves focus/selection state and turns infinite scroll from repeated
  // O(total-rendered) rebuilds into O(new-page) work.
  function appendFeedWindow(images, opts, start) {
    if (!els.feed || start >= images.length) return;
    const end = Math.min(start + FEED_PAGE_SIZE, images.length);
    const timeSplit = !!opts.ts.enabled;
    const period = opts.ts.period;
    const showUncat = !opts.isFiltering && !timeSplit && images.length > 0;
    const groupKey = e => (e.favorite ? '__favorites__' : timePeriodKey(e.ts, period));
    let lastGroup = timeSplit && start > 0 ? groupKey(images[start - 1]) : null;
    const fragment = document.createDocumentFragment();
    const addedCards = [];

    for (let i = start; i < end; i += 1) {
      const entry = images[i];
      let group = null;
      if (timeSplit) {
        const nextGroup = groupKey(entry);
        if (nextGroup !== lastGroup) fragment.appendChild(makeFeedDivider(nextGroup, nextGroup === '__favorites__' ? '★ Favourites' : nextGroup));
        lastGroup = nextGroup;
        group = nextGroup;
      } else if (showUncat) {
        group = '__uncategorized__';
      }

      const card = buildCard(entry, { showCategory: opts.showCategory });
      _resetCardGroupClasses(card);
      if (group != null) {
        card.classList.add('time-group-card');
        card.dataset.group = group;
        if (collapsedGroups.has(group)) card.classList.add('collapsed');
      }
      fragment.appendChild(card);
      addedCards.push(card);
    }

    // Snapshot lazy targets before the fragment is consumed by appendChild, then
    // observe only this page instead of rescanning every prior card.
    const lazyImages = Array.from(fragment.querySelectorAll('img[data-src]:not([data-lazy-done])'));
    els.feed.appendChild(fragment);
    if (window.MemoLazy) {
      if (window.MemoLazy.observe) lazyImages.forEach(img => window.MemoLazy.observe(img));
      else if (window.MemoLazy.hydrate) window.MemoLazy.hydrate(els.feed);
    }
    if (window.MemoMotion && !window.__memoRestoring && addedCards.length) window.MemoMotion.stagger(addedCards, 'pop');
    requestAnimationFrame(function () { addedCards.forEach(function (c) { layoutTagsline(c.querySelector('.tagsline')); }); });

    appendFeedWindowSentinel(images, opts, end);
  }

  function appendFeedWindowSentinel(images, opts, renderedCount) {
    if (!els.feed || renderedCount >= images.length) return;
    const sentinel = document.createElement('div');
    sentinel.className = 'feed-window-sentinel';
    els.feed.appendChild(sentinel);
    if (typeof IntersectionObserver !== 'function') return;

    feedWindowObserver = new IntersectionObserver(items => {
      if (!sentinel.isConnected || trashView || window.MEMO_VARIANT !== 'default') return;
      if (!items.some(item => item.isIntersecting)) return;
      if (feedWindowObserver) feedWindowObserver.disconnect();
      feedWindowObserver = null;
      sentinel.remove();
      feedWindowCount = Math.min(renderedCount + FEED_PAGE_SIZE, images.length);
      appendFeedWindow(images, opts, renderedCount);
    }, { rootMargin: '800px 0px' });
    feedWindowObserver.observe(sentinel);
  }

  // Folder breadcrumb (‹ Home › Category). Hidden at the root.
  function syncMobileCategory() {
    if (window.MemoTheme && typeof window.MemoTheme.syncCategoryOptions === 'function') {
      window.MemoTheme.syncCategoryOptions();
    }
  }

  function exitFolder() {
    const st = window.MemoCore.getState();
    const leaving = currentCategory || (els.categoryFilter && els.categoryFilter.value !== '__ALL__' ? els.categoryFilter.value : '');
    const revealContext = _folderRevealContext && _folderRevealContext.category === leaving
      ? _folderRevealContext : null;
    const clearCategory = () => {
      if (st.activeFilters && st.activeFilters.cats) st.activeFilters.cats.clear();
      if (els.categoryFilter) els.categoryFilter.value = '__ALL__';
      syncMobileCategory();
    };
    if (revealContext && window.MemoMotion && window.MemoMotion.circularReveal) {
      const restoreY = revealContext.scrollY;
      _folderRevealContext = null;
      window.MemoMotion.circularReveal(() => {
        clearCategory();
        renderFeed();
        window.scrollTo(0, restoreY);
        requestAnimationFrame(() => window.scrollTo(0, restoreY));
      }, {
        direction: 'exit',
        originAfter: () => Array.from(els.feed.querySelectorAll('.folder-card'))
          .find(card => card.dataset.folder === leaving) || null,
      });
      return;
    }
    _folderRevealContext = null;
    clearCategory();
    // Non-tile navigation (the category picker/filter panel) retains the shared
    // feed crossfade because there is no physical folder origin to reveal from.
    if (els.categoryFilter) els.categoryFilter.dispatchEvent(new Event('change'));
    else renderFeed();
  }

  function updateBreadcrumb(catName) {
    const bc = document.getElementById('breadcrumb');
    if (!bc) return;
    if (!bc._wired) {
      bc._wired = true;
      const back = bc.querySelector('.bc-back');
      if (back) back.addEventListener('click', () => {
        exitFolder();
      });
    }
    if (catName) {
      bc.hidden = false;
      const nm = bc.querySelector('.bc-name');
      if (nm) nm.textContent = catName;
    } else {
      bc.hidden = true;
    }
  }

  function buildFolderCard(cat, entries) {
    const _key = 'f:' + cat, _sig = _folderCardSig(cat, entries);
    const _cached = _cardCache.get(_key);
    if (_cached && _cached.sig === _sig && _cached.node) return _cached.node;
    const isImage = window.MemoCore.isImage;
    const card = document.createElement('div');
    card.className = 'card folder-card clickable';
    card.dataset.folder = cat;
    const previews = [];
    for (const e of entries) {
      for (const src of (e.images || [])) {
        if (isImage(src)) { previews.push(src); break; }
      }
      if (previews.length >= 3) break;
    }
    const lazySrc = (src) => (window.MemoLazy ? window.MemoLazy.thumbUrl(src, 240) : src);
    const n = entries.length;
    const thumbs = document.createElement('div');
    thumbs.className = 'folder-thumbs';
    if (previews.length) {
      previews.forEach(src => {
        const image = document.createElement('img');
        image.className = 'lazy-img';
        image.dataset.src = lazySrc(src);
        image.loading = 'lazy';
        image.alt = '';
        thumbs.appendChild(image);
      });
    } else {
      const empty = document.createElement('span');
      empty.className = 'folder-empty';
      const icon = document.createElement('span');
      icon.className = 'svg-icon svg-icon-folder';
      empty.appendChild(icon);
      thumbs.appendChild(empty);
    }
    const badge = document.createElement('span');
    badge.className = 'folder-badge';
    const badgeIcon = document.createElement('span');
    badgeIcon.className = 'svg-icon svg-icon-folder';
    badge.appendChild(badgeIcon);
    thumbs.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'folder-meta';
    const name = document.createElement('div');
    name.className = 'folder-name';
    name.textContent = cat || 'Uncategorized';
    const count = document.createElement('div');
    count.className = 'muted';
    count.textContent = `${n} ${n === 1 ? 'entry' : 'entries'}`;
    meta.append(name, count);
    card.append(thumbs, meta);
    card.addEventListener('click', () => {
      // In select mode a folder card selects/deselects the whole folder instead of
      // navigating into it — the user picks folders as units at the root.
      const S = window.MemoSelect;
      if (S && S.active && S.active()) { S.toggleFolder(cat); return; }
      openCategory(cat, card);
    });
    if (window.MemoCtx) window.MemoCtx.attachLongPress(card, ev => showFolderMenu(ev, cat));
    _cardCache.set(_key, { node: card, sig: _sig });
    return card;
  }

  // ── Context menus (shared MemoCtx; "Select" enters the fancy select toolbar) ──
  function entryById(id) {
    try { return window.MemoCore.getState().db.entries.find(x => x.id === id); } catch (_e) { return null; }
  }
  async function toggleFavorite(id) {
    const e = entryById(id); if (!e) return;
    const next = !e.favorite;
    if (window.MemoCore && window.MemoCore.batchApply) await window.MemoCore.batchApply([id], { favorite: next });
    if (window.MemoShell) window.MemoShell.toast(next ? 'Added to favourites' : 'Removed from favourites');
  }
  async function entryImgAction(kind, entry) {
    const mc = window.MemoCrop, isImage = window.MemoCore.isImage;
    const imgs = (entry.images || []).filter(s => isImage(s));
    if (!mc || !imgs.length) return;
    // "Share safely?" — offer Privacy blur first when the photo shows faces or
    // personal text (from on-device analysis; off in Privacy settings).
    if (kind === 'share' && window.MemoShareBlurOffer && window.MemoTools) {
      const target = window.MemoTools.targetsFor(entry)[0];
      if (target && await window.MemoShareBlurOffer.ask(target) !== 'share') return;
    }
    try {
      const blob = await mc.srcToBlob(imgs[0]);
      const name = ((entry.description || 'image').replace(/\s+/g, ' ').trim().slice(0, 40)) || 'image';
      if (kind === 'copy') await mc.copyBlob(blob);
      else if (kind === 'save') {
        const how = mc.saveToPhone ? await mc.saveToPhone(blob, name) : (mc.saveBlob(blob, name), 'download');
        if (window.MemoShell) window.MemoShell.toast(how === 'gallery' ? 'Saved to your gallery' : 'Image downloaded', { kind: 'success' });
      }
      else if (kind === 'share') await mc.shareBlob(blob, name);
    } catch (err) { if (err && err.name !== 'AbortError') console.warn('entry ' + kind + ' failed:', err); }
  }
  function showEntryMenu(ev, id) {
    const e = entryById(id); if (!e || !window.MemoCtx) return;
    const S = window.MemoSelect;
    let items;
    if (S && S.active()) {
      items = [
        { html: S.has(id) ? 'Remove from selection' : 'Add to selection', onClick: () => S.toggle(id) },
        { sep: true },
        { html: 'Exit select mode', onClick: () => S.exit() },
      ];
    } else {
      const hasImg = (e.images || []).some(s => window.MemoCore.isImage(s));
      items = [
        { html: 'Edit', onClick: () => window.openEntryModal && window.openEntryModal(e) },
        { html: 'Select', onClick: () => S && S.enter(id, true) },
      ];
      if (hasImg) items.push(
        { sep: true },
        { html: '<span class="svg-icon svg-icon-copy"></span> Copy image', onClick: () => entryImgAction('copy', e) },
        { html: '<span class="svg-icon svg-icon-save"></span> Save to Phone', onClick: () => entryImgAction('save', e) },
        { html: '<span class="svg-icon svg-icon-share"></span> Share image', onClick: () => entryImgAction('share', e) },
      );
      const P = window.MemoPrivacy;
      if (P && P.levelOf && P.levelOf('default') >= 2) {
        const entrySafe = P.isEntrySafe(e);
        items.push(
          { sep: true },
          { html: entrySafe ? '<span class="svg-icon svg-icon-key"></span> Remove from Safe' : '<span class="svg-icon svg-icon-key"></span> Move to Safe', onClick: () => P.setEntriesSafe([id], !entrySafe) },
        );
      }
      items.push(
        { sep: true },
        { html: 'Delete', danger: true, onClick: () => deleteEntry(id) },
      );
    }
    window.MemoCtx.showMenu(ev.clientX, ev.clientY, items);
  }
  function categoryIds(cat) {
    try {
      return window.MemoCore.getState().db.entries
        .filter(e => !e.deletedAt && (e.category || 'Uncategorized') === cat).map(e => e.id);
    } catch (_e) { return []; }
  }
  function showFolderMenu(ev, cat) {
    if (!window.MemoCtx) return;
    const S = window.MemoSelect;
    const ids = categoryIds(cat);
    window.MemoCtx.showMenu(ev.clientX, ev.clientY, [
      { html: 'Select folder', onClick: () => { if (S) S.toggleFolder(cat); } },
      { sep: true },
      { html: 'Rename folder', onClick: () => renameCategory(cat) },
      { sep: true },
      { html: 'Delete folder', danger: true, onClick: () => deleteAlbum(cat) },
    ]);
  }
  async function deleteEntry(id) {
    const core = window.MemoCore;
    if (core && core.batchDelete) await core.batchDelete([id]);
    if (window.MemoShell) window.MemoShell.toast('Moved to recycle bin', { action: { label: 'Undo', onClick: function () { core && core.restore && core.restore(id); } } });
  }
  async function deleteAlbum(cat) {
    const ids = categoryIds(cat);
    const ok = window.MemoShell
      ? await window.MemoShell.confirm(`Delete folder "${cat}" and move its ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} to the recycle bin?`, { danger: true, okLabel: 'Delete' })
      : confirm(`Delete folder "${cat}" and move its ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} to the recycle bin?`);
    if (!ok) return;
    const core = window.MemoCore, st = core.getState();
    if (ids.length && core.batchDelete) await core.batchDelete(ids);
    const cats = st.settings.categories || [];
    const i = cats.indexOf(cat);
    if (i >= 0 && cat !== 'Uncategorized') cats.splice(i, 1);
    if (els.categoryFilter && els.categoryFilter.value === cat) {
      els.categoryFilter.value = '__ALL__';
      els.categoryFilter.dispatchEvent(new Event('change'));   // back to root (cross-faded)
    } else { core.saveAll && core.saveAll(); renderFeed(); }
  }
  async function renameCategory(oldName) {
    const input = window.MemoShell
      ? await window.MemoShell.prompt('Rename folder', oldName, { okLabel: 'Rename' })
      : prompt('Rename folder', oldName);
    if (input == null) return;
    const trimmed = String(input).trim();
    if (!trimmed || trimmed === oldName) return;
    const core = window.MemoCore, st = core.getState();
    const ids = categoryIds(oldName);
    if (ids.length && core.batchApply) await core.batchApply(ids, { category: trimmed });
    const cats = st.settings.categories || [];
    const oi = cats.indexOf(oldName);
    if (oi >= 0 && oldName !== 'Uncategorized') cats.splice(oi, 1);
    if (window.ensureCategory) window.ensureCategory(trimmed);
    if (els.categoryFilter && els.categoryFilter.value === oldName) openCategory(trimmed);
    else { core.saveAll && core.saveAll(); renderFeed(); }
  }

  function openCategory(cat, originEl) {
    // A folder card is built from an entry's category, which may not yet be a
    // <select> option (e.g. just synced from another device). Guarantee the option
    // exists first — otherwise `select.value = cat` silently becomes "" and the view
    // filters by "" (0 entries) with the breadcrumb hidden.
    if (window.ensureCategory) window.ensureCategory(cat);
    // Opening a folder IS applying a category filter — the filter is global, so keep
    // activeFilters.cats in sync. The Filters panel then shows this folder checked and
    // the funnel lights up, and exitFolder/handleBack already clear it.
    const setCategory = () => {
      const state = window.MemoCore.getState();
      if (state.activeFilters) state.activeFilters.cats = new Set([cat]);
      if (els.categoryFilter) els.categoryFilter.value = cat;
      syncMobileCategory();
    };
    if (els.categoryFilter) {
      if (!Array.from(els.categoryFilter.options).some(o => o.value === cat)) {
        const o = document.createElement('option'); o.value = cat; o.textContent = cat;
        els.categoryFilter.appendChild(o);
      }
    }
    const rect = originEl && originEl.getBoundingClientRect ? originEl.getBoundingClientRect() : null;
    const fromFolderTile = !!(rect && rect.width && rect.height && window.MemoMotion && window.MemoMotion.circularReveal);
    if (fromFolderTile) {
      _folderRevealContext = { category: cat, scrollY: window.scrollY || 0 };
      window.MemoMotion.circularReveal(() => { setCategory(); renderFeed(); }, {
        direction: 'enter',
        origin: originEl,
      });
      return;
    }
    _folderRevealContext = null;
    setCategory();
    // The no-origin path is used by the picker/filter UI and keeps its existing
    // cross-fade. A circular snapshot behind closing dialogs would be obscured.
    if (els.categoryFilter) {
      els.categoryFilter.dispatchEvent(new Event('change'));
    } else {
      renderFeed();
    }
  }

  // The shell calls this after it has dismissed transient UI and dialogs. Back
  // from a folder returns to the root album view without clearing unrelated
  // searches or date/tag filters.
  function handleBack() {
    // Back leaves the recycle-bin view first.
    if (trashView) { exitTrash(); return true; }
    const state = window.MemoCore.getState();
    const hasCategory = els.categoryFilter && els.categoryFilter.value && els.categoryFilter.value !== '__ALL__';
    const hasCategoryFilter = state.activeFilters && state.activeFilters.cats && state.activeFilters.cats.size;
    if (!hasCategory && !hasCategoryFilter) return false;
    exitFolder();
    return true;
  }

  // Build a single memo card. Memo cards keep their text/time emphasis (unlike
  // ImageDB's image-first cards) — this just factors the markup out of the loop.
  function buildCard(e, opts) {
    const showCategory = !opts || opts.showCategory !== false;
    const _key = 'e:' + e.id, _sig = _entryCardSig(e, showCategory);
    const _cached = _cardCache.get(_key);
    if (_cached && _cached.sig === _sig && _cached.node) return _cached.node;
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = e.id;

    if (e.favorite) {
      card.classList.add('is-fav');
      const favBadge = document.createElement('span');
      favBadge.className = 'card-fav';
      favBadge.setAttribute('aria-label', 'Favourite');
      favBadge.innerHTML = '<span class="svg-icon svg-icon-star"></span>';
      card.appendChild(favBadge);
    }

    // Add conflict indicator styling
    if (e._hasConflict) {
      card.style.borderColor = '#f59e0b';
      card.style.borderWidth = '2px';
      card.style.backgroundColor = 'rgba(245, 158, 11, 0.05)';
    }

    const isImage = window.MemoCore.isImage;
    const imageList = (e.images || []).filter(src => isImage(src));
    // MIME type decides: see MemoCore.isImageAttachment (a blob:-URL PDF used to
    // be misfiled as an image and then rendered nowhere at all).
    const otherFiles = (e.attachments || []).filter(a => a && !window.MemoCore.isImageAttachment(a));

    const count = imageList.length;

    const lazySrc = (src) => (window.MemoLazy ? window.MemoLazy.thumbUrl(src, 240) : src);
    if (e._hasConflict) {
      const conflictBanner = document.createElement('div');
      conflictBanner.style.cssText = 'background:#f59e0b;color:#000;padding:4px 8px;border-radius:6px;font-size:11px;font-weight:600;margin-bottom:6px';
      conflictBanner.innerHTML = '<span class="svg-icon svg-icon-warning"></span> SYNC CONFLICT - Please review';
      card.appendChild(conflictBanner);
    }
    if (e._importing) {
      const importBadge = document.createElement('div');
      importBadge.className = 'import-badge';
      importBadge.innerHTML = '<span class="svg-icon svg-icon-refresh spin"></span> importing…';
      card.appendChild(importBadge);
    }

    const meta = document.createElement('div');
    meta.className = 'muted card-meta';
    const dateStr = (window.MemoView && window.MemoView.formatCardDate) ? window.MemoView.formatCardDate(e.ts) : fmtDate(e.ts);
    meta.textContent = dateStr + (showCategory && e.category && e.category !== 'Uncategorized' ? ' • ' + e.category : '');
    const description = document.createElement('div');
    description.className = 'card-desc';
    description.title = e.description || '';
    // Keep the DOM bounded; CSS line-clamp does the visual truncation per card size.
    description.textContent = (e.description || '').slice(0, 280);
    card.append(meta, description);

    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    const appendThumb = (i) => {
      const wrap = document.createElement('span');
      wrap.className = 'twrap';
      const image = document.createElement('img');
      image.className = 'lazy-img';
      image.dataset.eid = e.id;
      image.dataset.idx = String(i);
      image.dataset.src = lazySrc(imageList[i]);
      image.loading = 'lazy';
      image.alt = '';
      wrap.appendChild(image);
      thumbs.appendChild(wrap);
    };
    if (!count) {
      const empty = document.createElement('span');
      empty.className = 'muted';
      empty.textContent = 'No images';
      thumbs.appendChild(empty);
    } else if (count <= 4) {
      for (let i = 0; i < count; i++) appendThumb(i);
    } else {
      for (let i = 0; i < 3; i++) appendThumb(i);
      const more = document.createElement('div');
      more.className = 'more';
      more.dataset.eid = e.id;
      more.dataset.idx = '3';
      more.textContent = '+' + (count - 3);
      thumbs.appendChild(more);
    }
    card.appendChild(thumbs);

    if (otherFiles.length) {
      const attachments = document.createElement('div');
      attachments.className = 'attachments';
      attachments.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:4px';
      otherFiles.slice(0, 3).forEach(a => {
        const fileUrl = a.url || a.storedPath || '';
        const name = a.name || fileUrl.split('/').pop() || 'Attachment';
        const link = document.createElement(isPdfAttachment(a) ? 'button' : 'a');
        link.className = isPdfAttachment(a) ? 'filelink filelink-pdf' : 'filelink';
        link.title = name;
        if (link.tagName === 'BUTTON') link.type = 'button';
        else { link.href = fileUrl; link.target = '_blank'; link.rel = 'noopener'; }
        const icon = document.createElement('span');
        icon.className = 'svg-icon svg-icon-file';
        link.append(icon, document.createTextNode(' ' + name));
        attachments.appendChild(link);
      });
      if (otherFiles.length > 3) {
        const more = document.createElement('div');
        more.className = 'muted';
        more.style.fontSize = '11px';
        more.textContent = `+${otherFiles.length - 3} more file(s)`;
        attachments.appendChild(more);
      }
      card.appendChild(attachments);
    }

    const tags = document.createElement('div');
    tags.className = 'tagsline';
    (e.tags || []).forEach(t => {
      const pill = document.createElement('span');
      pill.className = 'tagpill';
      pill.textContent = '#' + t;
      tags.appendChild(pill);
    });
    card.appendChild(tags);
    // Whole card opens the entry; only thumbnails divert to the lightbox.
    // In select mode a click toggles selection instead of opening.
    card.classList.add('clickable');
    card.addEventListener('click', () => {
      if (window.MemoSelect && window.MemoSelect.active()) { window.MemoSelect.toggle(e.id); return; }
      openDetail(e.id);
    });
    if (window.MemoSelect) window.MemoSelect.decorate(card, e.id);
    // Long-press / right-click → context menu (Select is one item, not the default).
    if (window.MemoCtx) window.MemoCtx.attachLongPress(card, ev => showEntryMenu(ev, e.id));
    const inSelect = () => window.MemoSelect && window.MemoSelect.active();
    card.querySelectorAll('.thumbs img').forEach(img => {
      img.addEventListener('click', (ev) => { if (inSelect()) return; ev.stopPropagation(); if (window.MemoReader) window.MemoReader.open(e, parseInt(img.dataset.idx, 10)); });
    });
    const more = card.querySelector('.thumbs .more');
    if (more) { more.addEventListener('click', (ev) => { if (inSelect()) return; ev.stopPropagation(); if (window.MemoReader) window.MemoReader.open(e, parseInt(more.dataset.idx, 10)); }); }
    card.querySelectorAll('.filelink-pdf').forEach(btn => {
      btn.addEventListener('click', (ev) => { if (inSelect()) return; ev.stopPropagation(); if (window.MemoReader) window.MemoReader.open(e, 0); });
    });
    _cardCache.set(_key, { node: card, sig: _sig });
    return card;
  }

  // ── Time-divider helpers ──────────────────────────────────────────
  const collapsedGroups = new Set();
  let currentCategory = null; // the folder we're viewing, or null at root

  function normalizeTimeSplit(settings) {
    const ts = (settings && typeof settings.timeSplit === 'object' && settings.timeSplit) || {};
    return { enabled: ts.enabled !== false, period: ts.period || 'month' };
  }

  function timePeriodKey(tsMillis, period) {
    const d = new Date(tsMillis);
    if (isNaN(d.getTime())) return 'Undated';
    if (period === 'year') return String(d.getFullYear());
    if (period === 'day') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    if (period === 'week') {
      const monday = new Date(d);
      const dow = (monday.getDay() + 6) % 7; // 0 = Monday
      monday.setDate(monday.getDate() - dow);
      monday.setHours(0, 0, 0, 0);
      return 'Week of ' + monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function buildAddCard(group) {
    const ac = document.createElement('div');
    ac.className = 'card add-card';
    ac.id = 'addCard'; // single add-card per render; wired by memo-capture.js
    ac.setAttribute('role', 'button');
    ac.setAttribute('aria-label', 'New entry (hold for camera)');
    ac.innerHTML = `
      <svg class="add-card-progress" aria-hidden="true"><rect class="ac-rect-fill" x="1.5" y="1.5" width="97%" height="97%" rx="14" ry="14" pathLength="100"></rect></svg>
      <div class="add-card-inner"><div class="add-card-plus">+</div><div>New entry</div><div class="add-card-hint">Tap to add · hold for <span class="svg-icon svg-icon-camera"></span></div></div>`;
    if (group != null) {
      ac.classList.add('time-group-card');
      ac.dataset.group = group;
      if (collapsedGroups.has(group)) ac.classList.add('collapsed');
    }
    return ac;
  }

  // Fade + scale a group's cards as they fold away / unfold. The .collapsed end state
  // is display:none (no empty grid gaps); the transient .folding-out / .folding-in
  // classes drive the transition in each direction.
  function foldGroupCards(cards, collapse) {
    cards.forEach(c => {
      if (collapse) {
        c.classList.add('folding-out');
        let done = false;
        const finish = () => {
          if (done) return; done = true;
          c.removeEventListener('transitionend', finish);
          c.classList.add('collapsed'); c.classList.remove('folding-out');
        };
        c.addEventListener('transitionend', finish);
        setTimeout(finish, 260);                 // fallback if transitionend never fires
      } else {
        c.classList.remove('collapsed');
        c.classList.add('folding-in');            // start hidden…
        requestAnimationFrame(() => requestAnimationFrame(() => c.classList.remove('folding-in')));  // …then transition in
      }
    });
  }

  // A collapsible feed divider. Toggling it folds every card carrying data-group=key.
  // Used for time periods and for the "Albums" / "Uncategorized" sections alike, so
  // any pile can be folded away. `key` is the fold key; `label` is the shown text.
  // The Folders divider also shows its count and ends with the row/grid toggle.
  function makeFeedDivider(key, label, count) {
    const d = document.createElement('div');
    d.className = 'time-divider' + (collapsedGroups.has(key) ? ' collapsed' : '');
    d.dataset.group = key;
    d.innerHTML = `<span class="time-divider-chevron">▼</span><span class="time-divider-label"></span><span class="time-divider-line"></span>`;
    d.querySelector('.time-divider-label').textContent = label;
    const setCollapsed = (collapsed) => {
      if (d.classList.contains('collapsed') === collapsed) return;
      d.classList.toggle('collapsed', collapsed);
      if (collapsed) collapsedGroups.add(key); else collapsedGroups.delete(key);
      const sel = (window.CSS && CSS.escape) ? CSS.escape(key) : key.replace(/"/g, '\\"');
      foldGroupCards(els.feed.querySelectorAll(`.time-group-card[data-group="${sel}"]`), collapsed);
    };
    d.addEventListener('click', () => setCollapsed(!d.classList.contains('collapsed')));
    if (count != null) {
      const c = document.createElement('span');
      c.className = 'time-divider-count';
      c.textContent = String(count);
      d.querySelector('.time-divider-label').after(c);
    }
    if (key === '__folders__') d.appendChild(buildFolderViewToggle());
    return d;
  }

  // ── Folder shelf: a swipeable row (default) or a compact, vertically
  // flowing grid. The choice is a per-device view preference.
  const FOLDER_VIEW_KEY = 'memoFolderView';
  let _folderShelf = null;
  function folderView() {
    try { return localStorage.getItem(FOLDER_VIEW_KEY) === 'grid' ? 'grid' : 'strip'; } catch (_e) { return 'strip'; }
  }
  function getFolderShelf() {
    if (!_folderShelf) {
      _folderShelf = document.createElement('div');
      _folderShelf.className = 'folder-shelf';
    }
    _folderShelf.classList.toggle('is-grid', folderView() === 'grid');
    return _folderShelf;
  }
  function folderToggleLabel(grid) {
    const t = window.MemoI18n ? window.MemoI18n.t : (x => x);
    return t(grid ? 'Show folders in a row' : 'Show all folders as a grid');
  }
  // Shown only while the section is unfolded (CSS hides it on a folded divider).
  function buildFolderViewToggle() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'folder-view-toggle';
    b.innerHTML = '<span class="svg-icon svg-icon-grid" aria-hidden="true"></span>';
    const reflect = () => {
      const grid = folderView() === 'grid';
      b.setAttribute('aria-pressed', String(grid));
      b.setAttribute('aria-label', folderToggleLabel(grid));
      b.title = folderToggleLabel(grid);
    };
    reflect();
    b.addEventListener('click', (event) => {
      event.stopPropagation();   // the divider itself folds the section
      const grid = folderView() !== 'grid';
      try { localStorage.setItem(FOLDER_VIEW_KEY, grid ? 'grid' : 'strip'); } catch (_e) {}
      const shelf = getFolderShelf();
      const apply = () => { shelf.classList.toggle('is-grid', grid); if (!grid) shelf.scrollLeft = 0; };
      if (window.MemoMotion && window.MemoMotion.flip) window.MemoMotion.flip([shelf], apply, { selector: '.folder-card', key: el => el.dataset.folder });
      else apply();
      reflect();
    });
    return b;
  }

  // Toolbar control: a one-time wiring of the Group-by-time toggle + period
  // buttons.  Reads/writes settings.timeSplit and re-renders on change.
  let _groupCtrlWired = false;
  function initGroupControl() {
    if (_groupCtrlWired) return;
    const toggle = document.getElementById('timeSplitToggle');
    const periods = document.getElementById('timeSplitPeriods');
    if (!toggle || !periods) return; // control not present on this page
    _groupCtrlWired = true;
    toggle.addEventListener('change', () => {
      const { settings } = window.MemoCore.getState();
      settings.timeSplit = normalizeTimeSplit(settings);
      settings.timeSplit.enabled = toggle.checked;
      window.MemoCore.saveAll();
      renderFeed();
    });
    const selectPeriod = (period) => {
      const { settings } = window.MemoCore.getState();
      settings.timeSplit = normalizeTimeSplit(settings);
      settings.timeSplit.period = period;
      settings.timeSplit.enabled = true;
      window.MemoCore.saveAll();
      renderFeed();
    };
    if (window.MemoView && window.MemoView.wireChoiceGroup) {
      window.MemoView.wireChoiceGroup('timeSplitPeriods', 'data-period', selectPeriod);
    } else {
      periods.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-period]');
        if (btn) selectPeriod(btn.dataset.period);
      });
    }
  }

  function syncGroupControl(ts) {
    const toggle = document.getElementById('timeSplitToggle');
    const periods = document.getElementById('timeSplitPeriods');
    if (!toggle || !periods) return;
    toggle.checked = !!ts.enabled;
    periods.classList.toggle('disabled', !ts.enabled);
    if (window.MemoView && window.MemoView.syncChoiceGroup) {
      window.MemoView.syncChoiceGroup('timeSplitPeriods', 'data-period', ts.period, ts.enabled);
    } else {
      periods.setAttribute('aria-disabled', String(!ts.enabled));
      periods.querySelectorAll('button[data-period]').forEach(b => {
        const selected = b.dataset.period === ts.period;
        b.classList.toggle('active', selected);
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(selected));
        b.disabled = !ts.enabled;
        b.tabIndex = ts.enabled && selected ? 0 : -1;
      });
    }
  }

  // The Detail dialog's ··· overflow menu. Same .modal-menu-wrap pattern finance /
  // planner detail views can mount with their own actions.
  function mkDetailItem(icon, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'modal-menu-item';
    b.innerHTML = `<span class="svg-icon ${icon}"></span> ${label}`;
    b.addEventListener('click', () => {
      const pop = document.getElementById('detailMenuPopup'); if (pop) pop.classList.remove('open');
      onClick();
    });
    return b;
  }
  function gifSource(entry) {
    const images = entry.images || [];
    const isImage = window.MemoCore.isImage;
    for (let index = 0; index < images.length; index++) {
      const src = images[index];
      if (!isImage(src)) continue;
      const stored = Array.isArray(entry._storedPaths) ? entry._storedPaths[index] : '';
      if (/^data:image\/gif/i.test(src || '') || /\.gif(?:[?#]|$)/i.test(src || '') || /\.gif(?:[?#]|$)/i.test(stored || '')) {
        return { src, name: String(stored || src || 'animation.gif').split('/').pop() };
      }
    }
    return null;
  }
  function buildDetailMenu(e, imageList) {
    const btn = document.getElementById('detailMenuBtn');
    const pop = document.getElementById('detailMenuPopup');
    if (!btn || !pop) return;
    const items = [];
    const favItem = mkDetailItem('svg-icon-star', e.favorite ? 'Remove from favourites' : 'Add to favourites', () => toggleFavorite(e.id));
    if (e.favorite) favItem.classList.add('is-fav');
    items.push(favItem);
    if (imageList.length >= 2 && window.MemoPanel) {
      const combineItem = mkDetailItem('svg-icon-image', 'Combine to panel', () => {
        const sources = (e.images || []).map((url, index) => ({
          url,
          entryId: e.id,
          index,
          storedPath: Array.isArray(e._storedPaths) ? (e._storedPaths[index] || null) : null,
          safe: !!e.safe,
        })).filter(item => window.MemoCore.isImage(item.url));
        window.MemoPanel.open(sources);
      });
      combineItem.id = 'detailCombineBtn';
      items.push(combineItem);
    }
    if (imageList.length >= 2 && window.MemoGif) {
      const createItem = mkDetailItem('svg-icon-play', 'Create GIF', () => window.MemoGif.open(imageList));
      createItem.id = 'detailGifBtn';
      items.push(createItem);
    }
    if (imageList.length && window.MemoTools) {
      const toolsItem = mkDetailItem('svg-icon-sparkles', window.MemoI18n.t('Image tools'), () => window.MemoTools.open(e.id, (e.images || []).indexOf(imageList[0])));
      toolsItem.id = 'detailToolsBtn';
      items.push(toolsItem);
    }
    // The same tools as a button beside Edit, where people look for them.
    const toolsAction = document.getElementById('detailToolsAction');
    if (toolsAction) {
      toolsAction.hidden = !(imageList.length && window.MemoTools);
      toolsAction.onclick = () => window.MemoTools.open(e.id, (e.images || []).indexOf(imageList[0]));
    }
    if (imageList.length && window.MemoImageEditor) items.push(mkDetailItem('svg-icon-edit', imageList.length > 1 ? window.MemoI18n.t('Choose image to edit') : window.MemoI18n.t('Edit image'), () => {
      if (imageList.length === 1) window.MemoImageEditor.openEntry(e, (e.images || []).indexOf(imageList[0]));
      else { window.MemoReader.open(e, 0); window.MemoShell?.toast(window.MemoI18n.t('Choose a page, then use Edit image in its actions menu.')); }
    }));
    const editableGif = gifSource(e);
    if (editableGif && window.MemoGifEditor) items.push(mkDetailItem('svg-icon-edit', 'Edit GIF', () => window.MemoGifEditor.open(editableGif.src, editableGif.name)));
    if (imageList.length && window.MemoExifEditor) {
      const exifItem = mkDetailItem('svg-icon-settings', 'Edit EXIF metadata', () => window.MemoExifEditor.pickFromLibrary());
      exifItem.id = 'detailExifBtn';
      items.push(exifItem);
    }
    if (imageList.length) {
      items.push(mkDetailItem('svg-icon-copy', 'Copy image', () => entryImgAction('copy', e)));
      items.push(mkDetailItem('svg-icon-download', 'Save to Phone', () => entryImgAction('save', e)));
      items.push(mkDetailItem('svg-icon-share', 'Share image', () => entryImgAction('share', e)));
    }
    pop.innerHTML = '';
    items.forEach(it => pop.appendChild(it));
    btn.style.display = items.length ? '' : 'none';
    if (!btn._wired) {
      btn._wired = true;
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); pop.classList.toggle('open'); });
      document.addEventListener('click', (ev) => { if (ev.target !== btn && !pop.contains(ev.target)) pop.classList.remove('open'); });
    }
  }

  function openDetailNow(id, heroSeed) {
    const { db } = window.MemoCore.getState();
    const e = db.entries.find(x => x.id === id);
    if (!e || !els.detailContent) return;
    const isImage = window.MemoCore.isImage;
    const imageList = (e.images || []).filter(src => isImage(src));
    // MIME type decides: see MemoCore.isImageAttachment (a blob:-URL PDF used to
    // be misfiled as an image and then rendered nowhere at all).
    const otherFiles = (e.attachments || []).filter(a => a && !window.MemoCore.isImageAttachment(a));
    els.detailContent.innerHTML = '';
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `${fmtDate(e.ts)} • ${e.category || 'Uncategorized'}`;
    const description = document.createElement('h3');
    description.style.whiteSpace = 'pre-line';
    description.textContent = e.description || '(No description)';
    const tags = document.createElement('div');
    tags.className = 'tagsline';
    (e.tags || []).forEach(t => {
      const pill = document.createElement('span');
      pill.className = 'tagpill';
      pill.textContent = '#' + t;
      tags.appendChild(pill);
    });
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    thumbs.id = 'detailThumbs';
    thumbs.style.marginTop = '10px';
    let heroUpgrade = null;
    if (imageList.length) {
      imageList.forEach((src, i) => {
        const image = document.createElement('img');
        image.dataset.eid = e.id;
        image.dataset.idx = String(i);
        if (i === 0 && heroSeed && heroSeed !== src) {
          image.src = heroSeed;
          heroUpgrade = () => {
            if (image.isConnected && image.src !== src) image.src = src;
          };
        } else image.src = src;
        image.alt = '';
        thumbs.appendChild(image);
      });
    } else {
      const empty = document.createElement('span');
      empty.className = 'muted';
      empty.textContent = 'No images';
      thumbs.appendChild(empty);
    }
    els.detailContent.append(meta, description, tags, thumbs);

    if (otherFiles.length) {
      const fileList = document.createElement('div');
      fileList.className = 'filelist';
      fileList.style.cssText = 'margin-top:10px;display:grid;gap:6px';
      otherFiles.forEach(a => {
        const fileUrl = a.url || a.storedPath || '';
        const name = a.name || fileUrl.split('/').pop() || 'Attachment';
        const link = document.createElement(isPdfAttachment(a) ? 'button' : 'a');
        if (link.tagName === 'BUTTON') {
          link.type = 'button';
          link.className = 'filelink-pdf';
          link.style.cssText = 'color:#93c5fd;background:none;border:none;padding:0;cursor:pointer;text-align:left;font-size:13px';
        } else {
          link.href = fileUrl;
          link.target = '_blank';
          link.rel = 'noopener';
          link.style.cssText = 'color:#93c5fd;text-decoration:none;font-size:13px';
        }
        const icon = document.createElement('span');
        icon.className = 'svg-icon svg-icon-file';
        link.append(icon, document.createTextNode(' ' + name));
        fileList.appendChild(link);
      });
      els.detailContent.appendChild(fileList);
    }
    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.textContent = 'Tip: Open an image to view it. Drag to reorder (saves on drop).';
    els.detailContent.appendChild(tip);
    // Combine / GIF now live in the header ··· overflow menu (buildDetailMenu).
    buildDetailMenu(e, imageList);
    // Suggested tags, Find similar and a QR chip from on-device analysis.
    if (window.MemoInsights) window.MemoInsights.renderDetail(e);
    const cont = els.detailContent.querySelector('#detailThumbs');
    let startIdx = null;
    cont.querySelectorAll('img').forEach((im, idx) => {
      im.draggable = true;
      im.addEventListener('dragstart', () => { startIdx = idx; im.style.opacity = .5; });
      im.addEventListener('dragend', async () => {
        im.style.opacity = 1;
        startIdx = null;
        if (MODE === 'server') {
          const entry = db.entries.find(x => x.id === id);
          await ServerAPI.update(id, { images: entry.images });
        } else {
          saveAll();
        }
      });
      im.addEventListener('dragover', (ev) => ev.preventDefault());
      im.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const dst = idx; if (startIdx === null || startIdx === dst) return;
        const arr = imageList.slice(); const item = arr.splice(startIdx, 1)[0]; arr.splice(dst, 0, item);
        // Map re-ordered subset back onto entry.images preserving non-image refs
        const remaining = (e.images || []).filter(src => !isImage(src));
        e.images = arr.concat(remaining);
        openDetailNow(e.id);
      });
      im.addEventListener('click', () => { if (window.MemoReader) window.MemoReader.open(e, idx); });
    });
    // PDF attachments open in the reader — close the modal first so it's on top.
    els.detailContent.querySelectorAll('.filelink-pdf').forEach(btn => {
      btn.addEventListener('click', () => { if (els.detailDlg && els.detailDlg.open) els.detailDlg.close(); if (window.MemoReader) window.MemoReader.open(e, 0); });
    });
    if (els.detailDlg) {
      els.detailDlg.dataset.entryId = id;
      if (window.MemoCore && window.MemoCore.setActiveEntryFilter) window.MemoCore.setActiveEntryFilter(id);
      els.detailDlg.showModal();
    }
    return {
      hero: thumbs.querySelector('img'),
      upgrade: heroUpgrade,
    };
  }

  function feedDetailHero(id) {
    if (!els.feed) return null;
    return Array.from(els.feed.querySelectorAll('.card[data-id]')).find(card => card.dataset.id === String(id))
      ?.querySelector('.thumbs img') || null;
  }

  function openDetail(id) {
    if (els.detailDlg && els.detailDlg.open) return openDetailNow(id);
    const source = feedDetailHero(id);
    const seed = source && (source.currentSrc || source.getAttribute('src') || '');
    const motion = window.MemoMotion;
    if (!source || !seed || !motion || typeof motion.sharedElementTransition !== 'function') {
      return openDetailNow(id);
    }
    return motion.sharedElementTransition({
      from: source,
      name: 'memo-detail-hero',
      suppress: [els.feed],
      mutate: useMorph => {
        if (useMorph && els.detailDlg) els.detailDlg.classList.add('detail-morph');
        return openDetailNow(id, useMorph ? seed : null);
      },
      to: result => result && result.hero,
      onFinished: result => { if (result && result.upgrade) result.upgrade(); },
    });
  }

  function closeDetail() {
    if (!els.detailDlg || !els.detailDlg.open) return;
    const id = els.detailDlg.dataset.entryId;
    const source = els.detailContent && els.detailContent.querySelector('#detailThumbs img');
    const target = id ? feedDetailHero(id) : null;
    const motion = window.MemoMotion;
    if (!els.detailDlg.classList.contains('detail-morph') || !source || !target ||
        !motion || typeof motion.sharedElementTransition !== 'function') {
      els.detailDlg.close();
      return;
    }
    motion.sharedElementTransition({
      from: source,
      name: 'memo-detail-hero',
      suppress: [els.feed],
      mutate: () => { els.detailDlg.close(); return target; },
      to: result => result,
    });
  }

  if (els.detailDlg) {
    els.detailDlg.addEventListener('close', () => {
      if (!els.detailDlg.open) els.detailDlg.classList.remove('detail-morph');
    });
  }

  // Fit a card's tag row to ONE line: show as many pills as fit, then a "+N" pill
  // for the rest. If not even one pill fits, still show it and let the +N overlap
  // its end (see .tags-overlap). Runs after the cards are in the DOM (needs width).
  function layoutTagsline(el) {
    if (!el) return;
    var pills = Array.prototype.slice.call(el.querySelectorAll('.tagpill')).filter(function (p) { return !p.classList.contains('tag-more'); });
    var oldMore = el.querySelector('.tag-more'); if (oldMore) oldMore.remove();
    el.classList.remove('tags-overlap');
    pills.forEach(function (p) { p.style.display = ''; });
    if (!pills.length) return;
    var avail = el.clientWidth;
    if (!avail) return;
    var cs = getComputedStyle(el); var gap = parseFloat(cs.columnGap || cs.gap) || 6;
    var widths = pills.map(function (p) { return p.offsetWidth; });   // batch read
    var moreW = 30;                                                    // reserve for "+N"
    var used = 0, shown = 0;
    for (var i = 0; i < pills.length; i++) {
      var need = widths[i] + (i > 0 ? gap : 0);
      var reserve = (i < pills.length - 1) ? (moreW + gap) : 0;
      if (used + need + reserve <= avail) { used += need; shown++; } else break;
    }
    if (shown >= pills.length) return;                                 // all fit
    if (shown === 0) shown = 1;                                        // always show one
    for (var j = shown; j < pills.length; j++) pills[j].style.display = 'none';   // batch write
    var more = document.createElement('span');
    more.className = 'tagpill tag-more';
    more.textContent = '+' + (pills.length - shown);
    el.appendChild(more);
    if (shown === 1 && widths[0] + moreW + gap > avail) el.classList.add('tags-overlap');
  }
  function relayoutTags(scope) {
    var root = scope || els.feed; if (!root) return;
    root.querySelectorAll('.tagsline').forEach(layoutTagsline);
  }

  // ── Recycle bin as a feed view (mirrors the Safe toggle) ────────────────────
  let trashView = false;
  function renderTrash() {
    const C = window.MemoCore;
    const deleted = (C && C.deletedEntries ? C.deletedEntries() : [])
      .filter(e => !window.MemoPrivacy || window.MemoPrivacy.canViewEntry(e));
    updateBreadcrumb(null);           // the trash banner stands in for the breadcrumb
    updateTrashBanner(deleted.length);
    if (!els.feed) return;
    C.renderTrashFeed(deleted);
  }
  function updateTrashBanner(count) {
    const bar = document.getElementById('trashBanner');
    if (!bar) return;
    bar.hidden = !trashView;
    if (!bar._wired) {
      bar._wired = true;
      // The banner is shared shell chrome and is wired exactly once, but BOTH
      // memo and finance can be the variant showing it. Dispatch through the
      // ACTIVE variant instead of closing over this module's own functions —
      // otherwise whichever variant opened the bin first would own the buttons
      // (Exit would silently do nothing on the other one).
      const active = () => window.MemoVariant || null;
      const exit = bar.querySelector('.trash-exit');
      if (exit) exit.addEventListener('click', () => {
        const v = active();
        if (v && typeof v.exitTrash === 'function') v.exitTrash();
      });
      const empty = bar.querySelector('.trash-empty');
      if (empty) empty.addEventListener('click', async () => {
        if (window.MemoCore && window.MemoCore.emptyRecycleBin) await window.MemoCore.emptyRecycleBin();
        // renderFeed() re-enters the variant's trash view when it's active.
        const v = active();
        if (v && typeof v.renderFeed === 'function') v.renderFeed();
      });
    }
    const c = bar.querySelector('.trash-count');
    if (c) c.textContent = count + ' item' + (count === 1 ? '' : 's');
    const emptyBtn = bar.querySelector('.trash-empty');
    if (emptyBtn) emptyBtn.disabled = !count;
  }
  function setTrashView(on) {
    trashView = !!on;
    document.body.classList.toggle('trash-view', trashView);
    if (els.recycleBinBtn) els.recycleBinBtn.classList.toggle('active', trashView);
    renderFeed();
    if (els.feed) window.MemoDom.animate(els.feed, [{ opacity: 0.7 }, { opacity: 1 }], { duration: 140 });
  }
  function toggleTrash() { setTrashView(!trashView); }
  function exitTrash() { if (trashView) setTrashView(false); }

  var __variantModule = {
    captureView: () => ({ window: feedWindowCount, collapsed: [...collapsedGroups], trash: trashView }),
    restoreView: state => {
      restoredWindow = Math.max(FEED_PAGE_SIZE, Number(state.window) || FEED_PAGE_SIZE);
      _feedWindowKey = null;
      collapsedGroups.clear(); (state.collapsed || []).forEach(g => collapsedGroups.add(g));
      trashView = !!state.trash;
    },
    renderFeed,
    openDetail,
    closeDetail,
    openCategory,        // navigate into a folder (routes through the global filter)
    normalizeServerMemo,
    preferredNewCategory: () => currentCategory,
    relayoutTags,        // re-fit one-line tag rows (called on card-size change)
    toggleTrash,         // recycle bin as a feed view (mirrors Safe)
    exitTrash,
    isTrashView: () => trashView,
    handleBack,
    exitFolder,
    __lastFiltered: () => [], // replaced after first render
  };

  // Register in the shell's variant registry so the single-page shell can flip
  // MemoCore between memo and finance without a page reload. In the classic
  // multi-page build only this module loads, so it also starts core directly.
  window.MemoVariantRegistry = window.MemoVariantRegistry || {};
  window.MemoVariantRegistry['default'] = __variantModule;
  if (!window.MemoVariant) window.MemoVariant = __variantModule;
  if (window.__MEMO_SPA__) {
    if (typeof window.MemoShellVariantReady === 'function') window.MemoShellVariantReady('default');
  } else {
    window.MemoCore.start();
  }
})();
