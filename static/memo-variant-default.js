// Default variant: card grid with ts-based date, no finance fields
(function(){
  const { els } = window.MemoCore.getState();

  function normalizeServerMemo(m) {
    return {
      id: m.id,
      description: m.description || '',
      category: m.category || 'Uncategorized',
      tags: m.tags || [],
      ts: m.ts || Date.now(),
      images: m.images || [],
    };
  }

  function renderFeed() {
    const { db, settings, activeFilters } = window.MemoCore.getState();
    const q = els.searchBox ? els.searchBox.value.toLowerCase().trim() : '';
    const cat = els.categoryFilter ? els.categoryFilter.value : '__ALL__';
    const df = activeFilters.dateFrom ? new Date(activeFilters.dateFrom).getTime() : null;
    const dt = activeFilters.dateTo ? (new Date(activeFilters.dateTo).getTime() + 24 * 3600 * 1000 - 1) : null;

    const filtered = db.entries
      .filter(e => (cat === '__ALL__' ? true : e.category === cat))
      .filter(e => activeFilters.cats.size ? activeFilters.cats.has(e.category) : true)
      .filter(e => {
        if (df && e.ts < df) return false;
        if (dt && e.ts > dt) return false;
        if (activeFilters.tags.size && !e.tags?.some(t => activeFilters.tags.has(t))) return false;
        if (!q) return true;
        const inDesc = (e.description || '').toLowerCase().includes(q);
        const inTags = (e.tags || []).some(t => (t || '').toLowerCase().includes(q));
        return inDesc || inTags;
      })
      .sort((a, b) => b.ts - a.ts);

    if (els.feed) els.feed.innerHTML = '';
    for (const e of filtered) {
      const card = document.createElement('div');
      card.className = 'card';

      const count = e.images?.length || 0;
      const thumbs = [];
      if (count <= 4) {
        for (let i = 0; i < count; i++) {
          thumbs.push(`<span class="twrap"><img data-eid="${e.id}" data-idx="${i}" src="${e.images[i]}" alt=""></span>`);
        }
      } else {
        for (let i = 0; i < 3; i++) {
          thumbs.push(`<span class="twrap"><img data-eid="${e.id}" data-idx="${i}" src="${e.images[i]}" alt=""></span>`);
        }
        const extra = count - 3;
        thumbs.push(`<div class="more" data-eid="${e.id}" data-idx="3">+${extra}</div>`);
      }

      card.innerHTML = `
        <div class="muted">${fmtDate(e.ts)} • ${e.category}</div>
        <div title="${(e.description || '').replace(/"/g, '&quot;')}">${(e.description || '').length > 120 ? e.description.slice(0, 120) + '…' : (e.description || '')}</div>
        <div class="thumbs">${(count ? thumbs.join('') : '<span class="muted">No images</span>')}</div>
        <div class="tagsline">${(e.tags || []).map(t => `<span class="tagpill">#${t}</span>`).join('')}</div>
        <div class="inline"><button class="ghost">Open</button></div>
      `;
      card.querySelector('button').addEventListener('click', () => openDetail(e.id));
      card.querySelectorAll('.thumbs img').forEach(img => {
        img.addEventListener('click', () => openLightbox(e.id, parseInt(img.dataset.idx, 10)));
      });
      const more = card.querySelector('.thumbs .more');
      if (more) { more.addEventListener('click', () => openLightbox(e.id, parseInt(more.dataset.idx, 10))); }
      if (els.feed) els.feed.appendChild(card);
    }

    if (filtered.length === 0 && els.feed) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No entries. Click the + button to add one, or adjust filters.';
      els.feed.appendChild(empty);
    }
    updateFilterIndicator();
  }

  function openDetail(id) {
    const { db } = window.MemoCore.getState();
    const e = db.entries.find(x => x.id === id);
    if (!e || !els.detailContent) return;
    const imgs = (e.images || []).map((src, i) => `<img data-eid="${e.id}" data-idx="${i}" src="${src}" alt="">`).join('');
    els.detailContent.innerHTML = `
      <div class="muted">${fmtDate(e.ts)} • ${e.category}</div>
      <h3>${e.description ? e.description.replace(/</g, '&lt;') : '(No description)'}</h3>
      <div class="tagsline">${(e.tags || []).map(t => `<span class="tagpill">#${t}</span>`).join('')}</div>
      <div class="thumbs" id="detailThumbs" style="margin-top:10px">${imgs || '<span class="muted">No images</span>'}</div>
      <div class="muted">Tip: Click to view. Drag to reorder (saves on drop).</div>
    `;
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
        const arr = e.images.slice(); const item = arr.splice(startIdx, 1)[0]; arr.splice(dst, 0, item);
        e.images = arr; openDetail(e.id);
      });
      im.addEventListener('click', () => openLightbox(e.id, idx));
    });
    if (els.detailDlg) { els.detailDlg.dataset.entryId = id; els.detailDlg.showModal(); }
  }

  window.MemoVariant = {
    renderFeed,
    openDetail,
    normalizeServerMemo,
  };

  window.MemoCore.start();
})();
