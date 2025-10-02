// Finance variant: table view with purchaseDate, price, tax, adjustment, total
(function(){
  const { els } = window.MemoCore.getState();

  function formatMoney(val, isTax = false) {
    if (val === '' || val == null) return '';
    const s = String(val).trim();
    if (isTax && s.endsWith('%')) { return s; }
    return `$${s}`;
  }
  function formatMoneyFixed(val) {
    const num = typeof val === 'number' ? val : parseFloat(val) || 0;
    return `$${num.toFixed(2)}`;
  }
  function computeTotal(price, tax, adjustment) {
    let priceVal = parseFloat(price) || 0;
    let adjVal = parseFloat(adjustment) || 0;
    let taxVal = 0;
    const taxInput = (typeof tax === 'string' ? tax.trim() : '');
    if (taxInput.endsWith('%')) {
      const perc = parseFloat(taxInput.slice(0, -1));
      if (!isNaN(perc)) taxVal = priceVal * (perc / 100);
    } else if (taxInput !== '') {
      const abs = parseFloat(taxInput);
      if (!isNaN(abs)) taxVal = abs;
    }
    return +(priceVal + taxVal + adjVal).toFixed(2);
  }
  function updateTotalField() {
    if (!els.price || !els.tax || !els.adjustment || !els.total) return;
    const t = computeTotal(els.price.value, els.tax.value, els.adjustment.value);
    els.total.value = isNaN(t) ? '' : t;
  }
  ['input','change'].forEach(ev => {
    if (els.price) els.price.addEventListener(ev, updateTotalField);
    if (els.tax) els.tax.addEventListener(ev, updateTotalField);
    if (els.adjustment) els.adjustment.addEventListener(ev, updateTotalField);
  });

  function getTaxAmount(price, tax) {
    const priceVal = parseFloat(price) || 0;
    if (tax == null || tax === '') return 0;
    const s = String(tax).trim();
    if (s.endsWith('%')) {
      const perc = parseFloat(s.slice(0, -1));
      return isNaN(perc) ? 0 : priceVal * (perc / 100);
    }
    const abs = parseFloat(s);
    return isNaN(abs) ? 0 : abs;
  }

  function openEntryModalHook(entry) {
    function todayLocalYMD() {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    if (els.entryDate) els.entryDate.value = entry ? (entry.purchaseDate || (entry.ts ? (new Date(entry.ts)).toISOString().slice(0,10) : '')) : todayLocalYMD();
    if (els.price) els.price.value = entry ? (entry.price ?? '') : '';
    if (els.tax) els.tax.value = entry ? (entry.tax ?? '') : '';
    if (els.adjustment) els.adjustment.value = entry ? (entry.adjustment ?? '') : '';
    setTimeout(updateTotalField, 1);
  }

  function collectAdditionalFields(entry, isNew) {
    const purchaseDate = els.entryDate && els.entryDate.value ? els.entryDate.value : (new Date()).toISOString().slice(0,10);
    const price = els.price && els.price.value ? parseFloat(els.price.value) : 0;
    const tax = els.tax && els.tax.value ? els.tax.value : '';
    const adjustment = els.adjustment && els.adjustment.value ? parseFloat(els.adjustment.value) : 0;
    const total = computeTotal(price, tax, adjustment);
    entry.purchaseDate = purchaseDate; entry.price = price; entry.tax = tax; entry.adjustment = adjustment; entry.total = total;
  }

  function normalizeServerMemo(m) {
    return {
      id: m.id,
      description: m.description || '',
      category: m.category || 'Uncategorized',
      tags: m.tags || [],
      ts: m.ts || Date.now(),
      images: m.images || [],
      attachments: m.attachments || [],
      purchaseDate: m.purchaseDate || (m.ts ? new Date(m.ts).toISOString().slice(0,10) : ''),
      price: m.price || 0,
      tax: m.tax || '',
      adjustment: m.adjustment || 0,
      total: m.total || 0,
    };
  }

  function renderFeed() {
    const { db, activeFilters } = window.MemoCore.getState();
    const q = els.searchBox ? els.searchBox.value.toLowerCase().trim() : '';
    const cat = els.categoryFilter ? els.categoryFilter.value : '__ALL__';
    const df = activeFilters.dateFrom ? new Date(activeFilters.dateFrom).getTime() : null;
    const dt = activeFilters.dateTo ? (new Date(activeFilters.dateTo).getTime() + 24 * 3600 * 1000 - 1) : null;

    const filtered = db.entries
      .filter(e => (cat === '__ALL__' ? true : e.category === cat))
      .filter(e => activeFilters.cats.size ? activeFilters.cats.has(e.category) : true)
      .filter(e => {
        const pdt = new Date(e.purchaseDate || e.ts).getTime();
        if (df && pdt < df) return false;
        if (dt && pdt > dt) return false;
        if (activeFilters.tags.size && !e.tags?.some(t => activeFilters.tags.has(t))) return false;
        if (!q) return true;
        const inDesc = (e.description || '').toLowerCase().includes(q);
        const inTags = (e.tags || []).some(t => (t || '').toLowerCase().includes(q));
        return inDesc || inTags;
      })
      .sort((a, b) => {
        const ad = new Date(a.purchaseDate || a.ts).getTime();
        const bd = new Date(b.purchaseDate || b.ts).getTime();
        return bd - ad;
      });

    // Compute totals across filtered entries
    const totals = filtered.reduce((acc, e) => {
      const priceNum = parseFloat(e.price) || 0;
      const adjNum = parseFloat(e.adjustment) || 0;
      const taxNum = getTaxAmount(e.price, e.tax);
      const totalNum = typeof e.total === 'number' ? e.total : computeTotal(e.price, e.tax, e.adjustment);
      acc.price += priceNum;
      acc.tax += taxNum;
      acc.adj += adjNum;
      acc.total += totalNum;
      return acc;
    }, { price: 0, tax: 0, adj: 0, total: 0 });

    if (els.feed) els.feed.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'tablewrap';
    const table = document.createElement('table'); table.className = 'listtable';
    table.innerHTML = `
      <thead>
        <tr>
          <th class="col-date">Date</th>
          <th class="col-desc">Description</th>
          <th class="col-images">Images</th>
          <th class="col-price">Price</th>
          <th class="col-tax">Tax</th>
          <th class="col-adj">Adjustments</th>
          <th class="col-total">Total</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    // Expose filtered list for chat context
    window.MemoVariant.__lastFiltered = () => filtered.slice();
    for (const e of filtered) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-id', e.id);
      const dateCell = document.createElement('td'); dateCell.className = 'col-date';
      dateCell.textContent = e.purchaseDate || (e.ts ? (new Date(e.ts)).toISOString().slice(0,10) : ''); tr.appendChild(dateCell);

      const descCell = document.createElement('td'); descCell.className = 'col-desc';
      const descWrap = document.createElement('div'); descWrap.className = 'desc-cell';
      const descText = document.createElement('div'); descText.className = 'desc-text';
      const short = (e.description || ''); descText.textContent = short.length > 60 ? short.slice(0, 60) + '…' : short;
      if (e.tags?.length) {
        const tagBar = document.createElement('div'); tagBar.className = 'tagbar';
        tagBar.innerHTML = (e.tags || []).map(t => `<span class="tagpill">#${t}</span>`).join('');
        descText.appendChild(tagBar);
      }
      descWrap.appendChild(descText); descCell.appendChild(descWrap); tr.appendChild(descCell);

      const imagesCell = document.createElement('td'); imagesCell.className = 'col-images images-cell';
  const isImage = window.MemoCore.isImage;
  const imgsAll = Array.isArray(e.images) ? e.images.filter(Boolean) : [];
  const imgs = imgsAll.filter(src => isImage(src));
  const otherFiles = (e.attachments || []).filter(a => a && a.url && !isImage(a.url));
  const count = imgs.length;
      if (count > 0) {
        const container = document.createElement('div'); container.className = 'inline-thumbs';
        if (count <= 2) {
          imgs.forEach((src, i) => { const im = document.createElement('img'); im.src = src; im.className = 'thumb'; im.title = 'Click to preview'; im.addEventListener('click', (ev) => { ev.stopPropagation(); openLightbox(e.id, i); }); container.appendChild(im); });
        } else {
          const first = document.createElement('img'); first.src = imgs[0]; first.className = 'thumb'; first.title = 'Click to preview'; first.addEventListener('click', (ev) => { ev.stopPropagation(); openLightbox(e.id, 0); }); container.appendChild(first);
          const more = document.createElement('div'); more.className = 'thumb more'; more.textContent = `+${count - 1}`; more.title = 'Click to preview'; more.addEventListener('click', (ev) => { ev.stopPropagation(); openLightbox(e.id, 1); }); container.appendChild(more);
        }
        imagesCell.appendChild(container);
      }
      if (otherFiles.length) {
        const fl = document.createElement('div');
        fl.style.display = 'flex'; fl.style.flexDirection = 'column'; fl.style.gap = '2px'; fl.style.marginTop = '4px';
        otherFiles.slice(0,3).forEach(a => {
          const link = document.createElement('a'); link.href = a.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '📄 ' + (a.name || a.url.split('/').pop()); link.style.fontSize='11px'; link.style.color='#93c5fd'; link.style.textDecoration='none'; fl.appendChild(link);
        });
        if (otherFiles.length > 3) {
          const more = document.createElement('div'); more.className='muted'; more.style.fontSize='10px'; more.textContent = '+'+(otherFiles.length-3)+' more'; fl.appendChild(more);
        }
        imagesCell.appendChild(fl);
      }
      tr.appendChild(imagesCell);

      const priceCell = document.createElement('td'); priceCell.className = 'col-price'; priceCell.textContent = formatMoney(e.price); tr.appendChild(priceCell);
      const taxCell = document.createElement('td'); taxCell.className = 'col-tax'; taxCell.textContent = formatMoney(e.tax, true); tr.appendChild(taxCell);
      const adjCell = document.createElement('td'); adjCell.className = 'col-adj'; adjCell.textContent = formatMoney(e.adjustment); tr.appendChild(adjCell);
      const totalCell = document.createElement('td'); totalCell.className = 'col-total'; totalCell.textContent = formatMoney(e.total); tr.appendChild(totalCell);

      tr.addEventListener('click', () => openDetail(e.id));
      tbody.appendChild(tr);
    }

    if (filtered.length === 0) {
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = 7; td.className = 'muted'; td.textContent = 'No entries. Click the + button to add one, or adjust filters.'; tr.appendChild(td); tbody.appendChild(tr);
    }

    // Add a visible table footer with totals (primary source of truth)
    const tfoot = document.createElement('tfoot');
    tfoot.innerHTML = `
      <tr class="totals-row">
        <td class="col-date"></td>
        <td class="col-desc totals-label">Totals</td>
        <td class="col-images"></td>
        <td class="col-price">${formatMoneyFixed(totals.price)}</td>
        <td class="col-tax">${formatMoneyFixed(totals.tax)}</td>
        <td class="col-adj">${formatMoneyFixed(totals.adj)}</td>
        <td class="col-total">${formatMoneyFixed(totals.total)}</td>
      </tr>`;
    table.appendChild(tfoot);
    wrap.appendChild(table);

    // Fixed totals bar that appears only when tfoot is not visible
    const sticky = document.createElement('div');
    sticky.className = 'totals-sticky hidden';
    sticky.innerHTML = `
      <div class="inner">
        <table class="listtable">
          <tbody>
            <tr>
              <td class="col-date"></td>
              <td class="col-desc totals-label">Totals</td>
              <td class="col-images"></td>
              <td class="col-price">${formatMoneyFixed(totals.price)}</td>
              <td class="col-tax">${formatMoneyFixed(totals.tax)}</td>
              <td class="col-adj">${formatMoneyFixed(totals.adj)}</td>
              <td class="col-total">${formatMoneyFixed(totals.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
    wrap.appendChild(sticky);

    // Toggle sticky bar when footer totals row is out of view
    try {
      const target = tfoot.querySelector('.totals-row') || tfoot;
      const io = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (entry && entry.isIntersecting) {
          sticky.classList.add('hidden');
        } else {
          // Only show if we actually have rows (avoid showing on empty state)
          if (filtered.length > 0) sticky.classList.remove('hidden');
        }
      }, { threshold: 0.01 });
      io.observe(target);
    } catch (e) {
      // IntersectionObserver not available; leave sticky hidden
    }

    if (els.feed) els.feed.appendChild(wrap);
    updateFilterIndicator();
  }

  function openDetail(id) {
    const { db } = window.MemoCore.getState();
    const e = db.entries.find(x => x.id === id);
    if (!e || !els.detailContent) return;
    const isImage = window.MemoCore.isImage;
    const imgsOnly = (e.images || []).filter(src => isImage(src));
    const otherFiles = (e.attachments || []).filter(a => a && a.url && !isImage(a.url));
    const imgs = imgsOnly.map((src, i) => `<img data-eid="${e.id}" data-idx="${i}" src="${src}" alt="" class="thumb" style="width:60px;height:60px;margin:2px;cursor:pointer;">`).join('');
    els.detailContent.innerHTML = `
      <div class="muted">Date: ${e.purchaseDate || (e.ts ? (new Date(e.ts)).toISOString().slice(0, 10) : '')} • ${e.category}</div>
      <h3>${e.description ? e.description.replace(/</g, '&lt;').replace(/\n/g, '<br>') : '(No description)'}</h3>
      <div class="tagsline">${(e.tags || []).map(t => `<span class="tagpill">#${t}</span>`).join('')}</div>
      <table class="feed-table" style="margin:14px 0 10px 0;max-width:480px;">
          <tr><th>Price</th><th>Tax</th><th>Adjustment</th><th>Total</th></tr>
          <tr>
              <td>${e.price ?? ''}</td>
              <td>${e.tax ?? ''}</td>
              <td>${e.adjustment ?? ''}</td>
              <td>${e.total ?? ''}</td>
          </tr>
      </table>
      <div class="thumbs" id="detailThumbs" style="margin-top:10px">${imgs || '<span class="muted">No images</span>'}</div>
      ${otherFiles.length ? `<div class="filelist" style="margin-top:10px;display:grid;gap:6px;">` + otherFiles.map(a=>`<a href="${a.url}" target="_blank" rel="noopener" style="color:#93c5fd;text-decoration:none;font-size:13px;">📄 ${a.name || a.url.split('/').pop()}</a>`).join('') + `</div>`:''}
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
        const arr = imgsOnly.slice(); const item = arr.splice(startIdx, 1)[0]; arr.splice(dst, 0, item);
        const nonImgs = (e.images || []).filter(src => !isImage(src));
        e.images = arr.concat(nonImgs);
        openDetail(e.id);
      });
      im.addEventListener('click', () => openLightbox(e.id, idx));
    });
    if (els.detailDlg) { els.detailDlg.dataset.entryId = id; els.detailDlg.showModal(); }
  }

  window.MemoVariant = {
    renderFeed,
    openDetail,
    normalizeServerMemo,
    openEntryModalHook,
    collectAdditionalFields,
  };

  window.MemoCore.start();
})();
