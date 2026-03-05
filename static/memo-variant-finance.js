// Finance variant: table view with purchaseDate, items, tax, total
(function(){
  const { els } = window.MemoCore.getState();
  document.body.classList.add('finance-variant');

  // ─── Viewport-class system ───────────────────────────────────────────────
  // CSS @media rules don't re-evaluate on orientation change in Capacitor's
  // WebView; drive column-hiding via body classes instead (updated by JS).
  // Maps a width to a named bucket so re-render only fires when we cross a
  // breakpoint — not on every pixel of a smooth resize.
  function _vwBucket(w) {
    if (w >= 880) return 'xl';
    if (w >= 600) return 'lg';
    if (w >= 420) return 'sm';
    if (w >= 360) return 'xs';
    if (w >= 340) return 'xxs';
    return 'tiny';
  }
  let _lastVwBucket = null;

  function updateVwClasses() {
    const w = (window.visualViewport ? window.visualViewport.width : 0) || window.innerWidth;
    document.body.classList.toggle('vw-lt-880', w < 880);
    document.body.classList.toggle('vw-lt-600', w < 600);
    document.body.classList.toggle('vw-lt-420', w < 420);
    document.body.classList.toggle('vw-lt-360', w < 360);
    document.body.classList.toggle('vw-lt-340', w < 340);
    // Re-render only when we cross a breakpoint boundary so table-layout:fixed
    // recalculates column widths. Guards against render loops on smooth resize.
    const bucket = _vwBucket(w);
    if (bucket !== _lastVwBucket) {
      _lastVwBucket = bucket;
      clearTimeout(window.__financeVwTimer);
      window.__financeVwTimer = setTimeout(function() {
        if (window.MemoVariant && typeof window.MemoVariant.renderFeed === 'function') {
          window.MemoVariant.renderFeed();
        }
      }, 180);
    }
  }
  updateVwClasses();
  window.addEventListener('resize', updateVwClasses);
  window.addEventListener('orientationchange', function() { setTimeout(updateVwClasses, 320); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateVwClasses);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // New elements
  els.itemsTable = document.querySelector('#itemsTable tbody');
  els.addItemBtn = document.getElementById('addItemBtn');

  // In Capacitor mode, hide manual folder selection and browser-only saving hint
  if (typeof window !== 'undefined' && window.CAP_BOOT) {
    try {
      document.querySelectorAll('#chooseDirBtn,[data-hide-when-server]').forEach(el => { el.hidden = true; });
    } catch (e) { /* noop */ }
  }

  function formatMoney(val, isTax = false) {
    if (val === '' || val == null) return '';
    const s = String(val).trim();
    if (isTax && s.endsWith('%')) { return s; }
    const num = parseFloat(s);
    if (!isNaN(num)) return `$${num.toFixed(2)}`;
    return `$${s}`;
  }
  function formatMoneyFixed(val) {
    const num = typeof val === 'number' ? val : parseFloat(val) || 0;
    return `$${num.toFixed(2)}`;
  }

  function updateGrandTotal() {
      if (!els.itemsTable || !els.total) return;
      // Sum all row totals
      const rows = Array.from(els.itemsTable.querySelectorAll('tr'));
      let subtotal = 0;
      rows.forEach(tr => {
          const totalInput = tr.querySelector('.row-total');
          subtotal += parseFloat(totalInput.value) || 0;
      });
      
      // Calculate tax
      let taxVal = 0;
      const taxInput = els.tax ? els.tax.value.trim() : '';
      if (taxInput.endsWith('%')) {
          const perc = parseFloat(taxInput.slice(0, -1));
          if (!isNaN(perc)) taxVal = subtotal * (perc / 100);
      } else if (taxInput !== '') {
          const abs = parseFloat(taxInput);
          if (!isNaN(abs)) taxVal = abs;
      }
      
      const grandTotal = subtotal + taxVal;
      els.total.value = grandTotal.toFixed(2);
  }

  function createRow(item = {}, index) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
          <td class="col-id">${index + 1}</td>
          <td class="col-name"><textarea class="row-name" rows="1" placeholder="Item">${item.name || ''}</textarea></td>
          <td class="col-desc"><textarea class="row-desc" rows="1" placeholder="Desc">${item.description || ''}</textarea></td>
          <td class="col-qty"><input type="number" class="row-qty" value="${item.amount || 1}" min="0" step="any"></td>
          <td class="col-unit"><input type="number" class="row-unit" value="${item.unitPrice || 0}" min="0" step="0.01"></td>
          <td class="col-total"><input type="number" class="row-total" value="${item.totalPrice || 0}" readonly></td>
          <td class="col-action"><button class="ghost small danger row-del" title="Remove">×</button></td>
      `;
      
      const qtyInput = tr.querySelector('.row-qty');
      const unitInput = tr.querySelector('.row-unit');
      const totalInput = tr.querySelector('.row-total');
      const delBtn = tr.querySelector('.row-del');

      // Auto-resize textareas
      const nameInput = tr.querySelector('.row-name');
      const descInput = tr.querySelector('.row-desc');
      function autoResize(el) {
          el.style.height = 'auto';
          el.style.height = el.scrollHeight + 'px';
      }
      nameInput.addEventListener('input', () => autoResize(nameInput));
      descInput.addEventListener('input', () => autoResize(descInput));
      setTimeout(() => { autoResize(nameInput); autoResize(descInput); }, 0);

      function updateRowTotal() {
          const qty = parseFloat(qtyInput.value) || 0;
          const unit = parseFloat(unitInput.value) || 0;
          const total = qty * unit;
          totalInput.value = total.toFixed(2);
          updateGrandTotal();
      }

      qtyInput.addEventListener('input', updateRowTotal);
      unitInput.addEventListener('input', updateRowTotal);
      delBtn.addEventListener('click', () => {
          tr.remove();
          renumberRows();
          updateGrandTotal();
      });

      return tr;
  }

  function renumberRows() {
      const rows = els.itemsTable.querySelectorAll('tr');
      rows.forEach((tr, i) => {
          tr.querySelector('.col-id').textContent = i + 1;
      });
  }

  function getTaxAmount(subtotal, tax) {
    if (tax == null || tax === '') return 0;
    const s = String(tax).trim();
    if (s.endsWith('%')) {
      const perc = parseFloat(s.slice(0, -1));
      return isNaN(perc) ? 0 : subtotal * (perc / 100);
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
    
    // Setup Items Table
    if (els.itemsTable) {
        els.itemsTable.innerHTML = '';
        let items = entry && entry.items ? entry.items : [];
        
        // Migration for legacy entries
        if (entry && !entry.items && (entry.price || entry.adjustment)) {
            if (entry.price) {
                items.push({
                    name: 'Item',
                    description: entry.description || '',
                    amount: 1,
                    unitPrice: entry.price,
                    totalPrice: entry.price
                });
            }
            if (entry.adjustment) {
                items.push({
                    name: 'Adjustment',
                    description: '',
                    amount: 1,
                    unitPrice: entry.adjustment,
                    totalPrice: entry.adjustment
                });
            }
        }
        
        if (items.length === 0) items = [{amount:1, unitPrice:0, totalPrice:0}];
        
        items.forEach((item, i) => {
            els.itemsTable.appendChild(createRow(item, i));
        });
    }

    if (els.tax) els.tax.value = entry ? (entry.tax ?? '') : '';
    
    // Bind Add Button
    if (els.addItemBtn) {
        els.addItemBtn.onclick = (e) => {
            e.preventDefault();
            const rowCount = els.itemsTable.querySelectorAll('tr').length;
            els.itemsTable.appendChild(createRow({amount:1, unitPrice:0, totalPrice:0}, rowCount));
            updateGrandTotal();
        };
    }
    
    if (els.tax) els.tax.oninput = updateGrandTotal;
    
    setTimeout(updateGrandTotal, 1);
  }

  function collectAdditionalFields(entry, isNew) {
    const purchaseDate = els.entryDate && els.entryDate.value ? els.entryDate.value : (new Date()).toISOString().slice(0,10);
    
    const items = [];
    if (els.itemsTable) {
        els.itemsTable.querySelectorAll('tr').forEach(tr => {
            items.push({
                name: tr.querySelector('.row-name').value.trim(),
                description: tr.querySelector('.row-desc').value.trim(),
                amount: parseFloat(tr.querySelector('.row-qty').value) || 0,
                unitPrice: parseFloat(tr.querySelector('.row-unit').value) || 0,
                totalPrice: parseFloat(tr.querySelector('.row-total').value) || 0
            });
        });
    }

    const tax = els.tax && els.tax.value ? els.tax.value : '';
    const total = els.total ? (parseFloat(els.total.value) || 0) : 0;
    
    entry.purchaseDate = purchaseDate; 
    entry.items = items;
    entry.tax = tax; 
    entry.total = total;
    
    // Remove legacy fields
    delete entry.price;
    delete entry.adjustment;
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
      attachments: m.attachments || [],
      purchaseDate: m.purchaseDate || (m.ts ? new Date(m.ts).toISOString().slice(0,10) : ''),
      items: m.items || [],
      tax: m.tax || '',
      total: m.total || 0,
      // Keep legacy for read-only if needed, but UI prefers items
      price: m.price,
      adjustment: m.adjustment
    };
  }

  function renderFeed() {
    const { db, activeFilters } = window.MemoCore.getState();
    const q = els.searchBox ? els.searchBox.value.toLowerCase().trim() : '';
    const cat = els.categoryFilter ? els.categoryFilter.value : '__ALL__';
    const df = activeFilters.dateFrom ? new Date(activeFilters.dateFrom).getTime() : null;
    const dt = activeFilters.dateTo ? (new Date(activeFilters.dateTo).getTime() + 24 * 3600 * 1000 - 1) : null;

    const filtered = db.entries
      .filter(e => e.deletedAt === null || e.deletedAt === undefined)
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
        // Also search in item names
        const inItems = (e.items || []).some(i => (i.name || '').toLowerCase().includes(q));
        return inDesc || inTags || inItems;
      })
      .sort((a, b) => {
        const ad = new Date(a.purchaseDate || a.ts).getTime();
        const bd = new Date(b.purchaseDate || b.ts).getTime();
        return bd - ad;
      });

    // Compute totals
    const totals = filtered.reduce((acc, e) => {
      // Calculate subtotal from items if available, else use legacy price
      let subtotal = 0;
      if (e.items && e.items.length) {
          subtotal = e.items.reduce((s, i) => s + (i.totalPrice || 0), 0);
      } else {
          subtotal = (parseFloat(e.price) || 0) + (parseFloat(e.adjustment) || 0);
      }
      
      const taxNum = getTaxAmount(subtotal, e.tax);
      const totalNum = typeof e.total === 'number' ? e.total : (subtotal + taxNum);
      
      acc.subtotal += subtotal;
      acc.tax += taxNum;
      acc.total += totalNum;
      return acc;
    }, { subtotal: 0, tax: 0, total: 0 });

    if (els.feed) { els.feed.innerHTML = ''; els.feed.dataset.listmode = 'table'; }
    const wrap = document.createElement('div'); wrap.className = 'tablewrap';
    const table = document.createElement('table'); table.className = 'listtable';
    table.innerHTML = `
      <thead>
        <tr>
          <th class="col-date">Date</th>
          <th class="col-desc">Description</th>
          <th class="col-images">Images</th>
          <th class="col-price">Subtotal</th>
          <th class="col-tax">Tax</th>
          <th class="col-total">Total</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    window.MemoVariant.__lastFiltered = () => filtered.slice();
    for (const e of filtered) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-id', e.id);
      
      if (e._hasConflict) {
        tr.style.borderLeft = '4px solid #f59e0b';
        tr.style.backgroundColor = 'rgba(245, 158, 11, 0.05)';
      }
      
      const dateCell = document.createElement('td'); dateCell.className = 'col-date';
      dateCell.textContent = e.purchaseDate || (e.ts ? (new Date(e.ts)).toISOString().slice(0,10) : ''); tr.appendChild(dateCell);

      const descCell = document.createElement('td'); descCell.className = 'col-desc';
      const descWrap = document.createElement('div'); descWrap.className = 'desc-cell';
      
      if (e._hasConflict) {
        const conflictBanner = document.createElement('div');
        conflictBanner.style.background = '#f59e0b';
        conflictBanner.style.color = '#000';
        conflictBanner.style.padding = '2px 6px';
        conflictBanner.style.borderRadius = '4px';
        conflictBanner.style.fontSize = '10px';
        conflictBanner.style.fontWeight = '600';
        conflictBanner.style.marginBottom = '4px';
        conflictBanner.textContent = '⚠️ SYNC CONFLICT';
        descWrap.appendChild(conflictBanner);
      }
      
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
      const otherFiles = (e.attachments || []).filter(a => {
        if (!a) return false;
        const checkPath = a.storedPath || a.url;
        const isImageFile = isImage(checkPath);
        if (a.type && !isImageFile) {
          return !a.type.startsWith('image/');
        }
        return !isImageFile;
      });
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

      // Calculate subtotal for display
      let subtotal = 0;
      if (e.items && e.items.length) {
          subtotal = e.items.reduce((s, i) => s + (i.totalPrice || 0), 0);
      } else {
          subtotal = (parseFloat(e.price) || 0) + (parseFloat(e.adjustment) || 0);
      }

        const priceCell = document.createElement('td'); priceCell.className = 'col-price'; priceCell.textContent = formatMoney(subtotal); tr.appendChild(priceCell);
      const taxCell = document.createElement('td'); taxCell.className = 'col-tax'; taxCell.textContent = formatMoney(e.tax, true); tr.appendChild(taxCell);
      const totalCell = document.createElement('td'); totalCell.className = 'col-total'; totalCell.textContent = formatMoney(e.total); tr.appendChild(totalCell);

      tr.addEventListener('click', () => openDetail(e.id));
      tbody.appendChild(tr);
    }

    if (filtered.length === 0) {
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = 6; td.className = 'muted'; td.textContent = 'No entries. Click the + button to add one, or adjust filters.'; tr.appendChild(td); tbody.appendChild(tr);
    }

    const tfoot = document.createElement('tfoot');
    tfoot.innerHTML = `
      <tr class="totals-row">
        <td class="col-date"></td>
        <td class="col-desc totals-label">Totals</td>
        <td class="col-images"></td>
        <td class="col-price">${formatMoneyFixed(totals.subtotal)}</td>
        <td class="col-tax">${formatMoneyFixed(totals.tax)}</td>
        <td class="col-total">${formatMoneyFixed(totals.total)}</td>
      </tr>`;
    table.appendChild(tfoot);
    wrap.appendChild(table);

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
              <td class="col-price">${formatMoneyFixed(totals.subtotal)}</td>
              <td class="col-tax">${formatMoneyFixed(totals.tax)}</td>
              <td class="col-total">${formatMoneyFixed(totals.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
    wrap.appendChild(sticky);

    try {
      const target = tfoot.querySelector('.totals-row') || tfoot;
      const io = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (entry && entry.isIntersecting) {
          sticky.classList.add('hidden');
        } else {
          if (filtered.length > 0) sticky.classList.remove('hidden');
        }
      }, { threshold: 0.01 });
      io.observe(target);
    } catch (e) { }

    if (els.feed) els.feed.appendChild(wrap);
    updateFilterIndicator();
  }

  function openDetail(id) {
    const { db } = window.MemoCore.getState();
    const e = db.entries.find(x => x.id === id);
    if (!e || !els.detailContent) return;
    const isImage = window.MemoCore.isImage;
    const imgsOnly = (e.images || []).filter(src => isImage(src));
    const otherFiles = (e.attachments || []).filter(a => {
      if (!a) return false;
      const checkPath = a.storedPath || a.url;
      const isImageFile = isImage(checkPath);
      if (a.type && !isImageFile) {
        return !a.type.startsWith('image/');
      }
      return !isImageFile;
    });
    const imgs = imgsOnly.map((src, i) => `<img data-eid="${e.id}" data-idx="${i}" src="${src}" alt="" class="thumb" style="width:60px;height:60px;margin:2px;cursor:pointer;">`).join('');
    
    // Build items table HTML
    let itemsHtml = '';
    let items = e.items || [];
    // Migration for display
    if (items.length === 0 && (e.price || e.adjustment)) {
        if (e.price) items.push({name:'Item', description:e.description, amount:1, unitPrice:e.price, totalPrice:e.price});
        if (e.adjustment) items.push({name:'Adjustment', description:'', amount:1, unitPrice:e.adjustment, totalPrice:e.adjustment});
    }
    
    if (items.length > 0) {
        itemsHtml = `
        <div style="overflow-x:auto;margin:14px 0 10px 0;">
            <table class="feed-table" style="width:100%;border-collapse:collapse;">
                <thead>
                    <tr style="background:var(--card);border-bottom:1px solid var(--border);">
                        <th style="padding:8px;text-align:left;">#</th>
                        <th style="padding:8px;text-align:left;">Name</th>
                        <th style="padding:8px;text-align:left;">Desc</th>
                        <th style="padding:8px;text-align:right;">Qty</th>
                        <th style="padding:8px;text-align:right;">Unit</th>
                        <th style="padding:8px;text-align:right;">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map((item, i) => `
                    <tr style="border-bottom:1px solid var(--border);">
                        <td style="padding:8px;">${i+1}</td>
                        <td style="padding:8px;"><div class="clamp-scroll">${item.name || ''}</div></td>
                        <td style="padding:8px;"><div class="clamp-scroll">${item.description || ''}</div></td>
                        <td style="padding:8px;text-align:right;">${item.amount}</td>
                        <td style="padding:8px;text-align:right;">${formatMoney(item.unitPrice)}</td>
                        <td style="padding:8px;text-align:right;">${formatMoney(item.totalPrice)}</td>
                    </tr>
                    `).join('')}
                    <tr style="font-weight:bold;background:var(--card);">
                        <td colspan="5" style="padding:8px;text-align:right;">Tax</td>
                        <td style="padding:8px;text-align:right;">${formatMoney(e.tax, true)}</td>
                    </tr>
                    <tr style="font-weight:bold;background:var(--card);">
                        <td colspan="5" style="padding:8px;text-align:right;">Total</td>
                        <td style="padding:8px;text-align:right;">${formatMoney(e.total)}</td>
                    </tr>
                </tbody>
            </table>
        </div>
        <button class="ghost small" id="copyCsvBtn" style="margin-bottom:10px;">Copy Table as CSV</button>
        `;
    }

    els.detailContent.innerHTML = `
      <div class="muted">Date: ${e.purchaseDate || (e.ts ? (new Date(e.ts)).toISOString().slice(0, 10) : '')} • ${e.category}</div>
      <h3>${e.description ? e.description.replace(/</g, '&lt;').replace(/\n/g, '<br>') : '(No description)'}</h3>
      <div class="tagsline">${(e.tags || []).map(t => `<span class="tagpill">#${t}</span>`).join('')}</div>
      
      ${itemsHtml}
      
      <div class="thumbs" id="detailThumbs" style="margin-top:10px">${imgs || '<span class="muted">No images</span>'}</div>
      ${otherFiles.length ? `<div class="filelist" style="margin-top:10px;display:grid;gap:6px;">` + otherFiles.map(a=>`<a href="${a.url}" target="_blank" rel="noopener" style="color:#93c5fd;text-decoration:none;font-size:13px;">📄 ${a.name || a.url.split('/').pop()}</a>`).join('') + `</div>`:''}
      <div class="muted">Tip: Click to view. Drag to reorder (saves on drop).</div>
    `;
    
    // Bind Copy CSV
    const copyBtn = els.detailContent.querySelector('#copyCsvBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const headers = ['ID', 'Name', 'Description', 'Quantity', 'Unit Price', 'Total Price'];
            const rows = items.map((item, i) => [
                i + 1,
                `"${(item.name || '').replace(/"/g, '""')}"`,
                `"${(item.description || '').replace(/"/g, '""')}"`,
                item.amount,
                item.unitPrice,
                item.totalPrice
            ]);
            const csvContent = [
                headers.join(','),
                ...rows.map(r => r.join(','))
            ].join('\n');
            
            navigator.clipboard.writeText(csvContent).then(() => {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                setTimeout(() => copyBtn.textContent = originalText, 2000);
            });
        });
    }

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
