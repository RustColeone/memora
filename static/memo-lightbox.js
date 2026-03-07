/* ---------- Lightbox: focus-preserving, animated zoom; drag only while held ---------- */
let lbState = { eid: null, idx: 0, scale: 1, x: 0, y: 0, baseW: 0, baseH: 0, lastTap: 0 };
let lbDirectImages = null; // non-null when previewing edit-modal images directly

let rafId = null;
function scheduleDraw() { if (rafId) return; rafId = requestAnimationFrame(() => { rafId = null; applyLbTransform(); }); }
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function animateTo(targetScale, targetX, targetY, ms = 170) {
    const s0 = lbState.scale, x0 = lbState.x, y0 = lbState.y;
    const s1 = targetScale, x1 = targetX, y1 = targetY;
    const start = performance.now();
    function step(now) {
        const t = Math.min(1, (now - start) / ms);
        const k = easeOutCubic(t);
        lbState.scale = s0 + (s1 - s0) * k;
        lbState.x = x0 + (x1 - x0) * k;
        lbState.y = y0 + (y1 - y0) * k;
        scheduleDraw();
        if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}
let lbReopen = null;

// Preview images directly from the edit modal (blob: or /uploads/ URLs)
// without requiring a saved entry. Snapshots & restores modal state.
function openLightboxDirect(srcs, startIdx) {
    lbReopen = null;
    lbDirectImages = srcs.slice();
    if (els.entryDlg && els.entryDlg.open) {
        lbReopen = {
            type: 'entry',
            data: {
                wasEditingId: editingId,
                desc: els.desc ? els.desc.value : '',
                category: els.categoryInput ? els.categoryInput.value : '',
                newCategory: els.newCategory ? els.newCategory.value : '',
                tags: [...workingTags],
                images: modalImages.map(mi => ({ ...mi }))
            }
        };
        els.entryDlg.close();
    }
    lbState = { eid: null, idx: startIdx, scale: 1, x: 0, y: 0, baseW: 0, baseH: 0, lastTap: 0 };
    els.lbImg.onload = () => {
        const r = els.lbImg.getBoundingClientRect();
        lbState.baseW = r.width; lbState.baseH = r.height;
        lbState.scale = 1; lbState.x = 0; lbState.y = 0;
        applyLbTransform();
    };
    els.lbImg.src = srcs[startIdx];
    updateLbCounter();
    updateLbNavVisibility();
    els.lightbox.classList.add('open');
    els.lightbox.setAttribute('aria-hidden', 'false');
}

function openLightbox(eid, idx) {
    // Capture & close any open dialog so the lightbox is fully interactable
    lbReopen = null;
    if (els.entryDlg.open) {
        // Snapshot unsaved edit form state
        lbReopen = {
            type: 'entry',
            data: {
                wasEditingId: editingId,                 // null for "new", or entry id for "edit"
                desc: els.desc.value,
                category: els.categoryInput.value,
                newCategory: els.newCategory.value,
                tags: [...workingTags],
                images: modalImages.map(mi => ({ ...mi })) // shallow clone array of objects
            }
        };
        els.entryDlg.close();
    } else if (els.detailDlg.open) {
        lbReopen = {
            type: 'detail',
            data: { entryId: els.detailDlg.dataset.entryId }
        };
        els.detailDlg.close();
    }

    const e = db.entries.find(x => x.id === eid); if (!e) return;

    lbState = { eid, idx, scale: 1, x: 0, y: 0, baseW: 0, baseH: 0, lastTap: 0 };
    els.lbImg.onload = () => {
        const r = els.lbImg.getBoundingClientRect();
        lbState.baseW = r.width; lbState.baseH = r.height;
        lbState.scale = 1; lbState.x = 0; lbState.y = 0;
        applyLbTransform();
    };
    els.lbImg.src = e.images[idx];
    updateLbCounter();
    updateLbNavVisibility();
    els.lightbox.classList.add('open');
    els.lightbox.setAttribute('aria-hidden', 'false');
}

function closeLightbox() {
    lbDirectImages = null; // clear direct-preview mode
    els.lightbox.classList.remove('open');
    els.lightbox.setAttribute('aria-hidden', 'true');

    // Re-open the dialog we had before the lightbox, with its previous state
    const reopen = lbReopen; lbReopen = null;
    if (!reopen) return;

    if (reopen.type === 'detail') {
        // Rebuild detail view from the stored entry id
        openDetail(reopen.data.entryId);
    } else if (reopen.type === 'entry') {
        // Re-open the entry modal in the same "mode" (new vs edit) and restore snapshot
        const wasEditingId = reopen.data.wasEditingId;
        const entryObj = wasEditingId ? db.entries.find(e => e.id === wasEditingId) : null;

        // Open with the appropriate base data (will set editingId internally)
        openEntryModal(entryObj);

        // Now restore unsaved state onto the form
        els.desc.value = reopen.data.desc;
        ensureCategory(reopen.data.category);
        els.categoryInput.value = reopen.data.category;
        els.newCategory.value = reopen.data.newCategory || '';

        workingTags = new Set(reopen.data.tags || []);
        renderTagChips();

        modalImages = (reopen.data.images || []).map(mi => ({ ...mi }));
        rebuildDragGrid();
    }
}
function currentEntry() {
    if (lbDirectImages) return { images: lbDirectImages };
    return db.entries.find(x => x.id === lbState.eid);
}
function updateLbCounter() { const e = currentEntry(); if (!e) return; els.lbCounter.textContent = `${lbState.idx + 1}/${e.images.length}`; }
function updateLbNavVisibility() {
    const e = currentEntry(); if (!e) return;
    const single = e.images.length <= 1;
    els.lbPrev.style.display = single ? 'none' : '';
    els.lbNext.style.display = single ? 'none' : '';
}
function lbStep(delta) {
    const e = currentEntry(); if (!e || !e.images.length) return;
    lbState.idx = (lbState.idx + delta + e.images.length) % e.images.length;
    els.lbImg.onload = () => {
        const r = els.lbImg.getBoundingClientRect();
        lbState.baseW = r.width; lbState.baseH = r.height;
        lbState.scale = 1; lbState.x = 0; lbState.y = 0;
        scheduleDraw();
    };
    els.lbImg.src = e.images[lbState.idx];
    updateLbCounter(); updateLbNavVisibility();
}
function applyLbTransform() {
    els.lbImg.style.transform = `translate3d(${lbState.x}px, ${lbState.y}px, 0) scale(${lbState.scale})`;
    els.lbImg.style.cursor = lbState.scale > 1 ? 'grab' : 'zoom-in';
}

/* keep zoom focused on cursor */
function zoomToPointAnimated(newScale, clientX, clientY) {
    newScale = Math.max(1, Math.min(6, newScale));
    const rect = els.lbImg.getBoundingClientRect();
    /* cursor on image coordinate */
    const p1x = (clientX - rect.x);
    const p1y = (clientY - rect.y);
    const p2x = p1x / lbState.scale * newScale;
    const p2y = p1y / lbState.scale * newScale;
    /* cursor on image coordinate */
    const targetX = lbState.x - (p2x - p1x);
    const targetY = lbState.y - (p2y - p1y);
    animateTo(newScale, targetX, targetY, 170);
}

/* disable native drag & drops inside the lightbox */
['dragstart', 'dragover', 'drop'].forEach(type => {
    els.lightbox.addEventListener(type, (e) => { e.preventDefault(); });
    els.lbImg.addEventListener(type, (e) => { e.preventDefault(); });
});

/* wheel zoom (animated) */
let wheelAccum = 0, wheelRAF = null;
els.lightbox.addEventListener('wheel', (e) => {
    if (!els.lightbox.classList.contains('open')) return;
    e.preventDefault();
    wheelAccum += e.deltaY;
    if (wheelRAF) return;
    wheelRAF = requestAnimationFrame(() => {
        const factor = Math.exp(-wheelAccum * 0.0016);
        zoomToPointAnimated(lbState.scale * factor, e.clientX, e.clientY);
        wheelAccum = 0; wheelRAF = null;
    });
}, { passive: false });

/* mouse drag pan — ONLY while button held */
let isDragging = false, dragStart = { x: 0, y: 0 }, imgStart = { x: 0, y: 0 }, isImg = false;
els.lbImg.addEventListener('mousedown', (e) => {
    isImg = true;
    isDragging = true; dragStart = { x: e.clientX, y: e.clientY }; imgStart = { x: lbState.x, y: lbState.y };
    els.lbImg.style.cursor = 'grabbing';
    e.preventDefault();
});
els.lbImg.addEventListener('click', (e) => {
    //console.log(e.target)
});
window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    lbState.x = imgStart.x + (e.clientX - dragStart.x);
    lbState.y = imgStart.y + (e.clientY - dragStart.y);
    scheduleDraw();
});
window.addEventListener('mouseup', () => { if (isDragging) { isDragging = false; els.lbImg.style.cursor = 'grab'; } });

/* touch/pointer: pinch zoom + one-finger pan (only while finger down) */
const pointers = new Map();
let pinchStartScale = 1, pinchStartVec = null;
// Pinch gesture snapshot
let pinchStart = false;

els.lightbox.addEventListener('pointerdown', (e) => {
    if (e.target !== els.lbImg && e.target !== els.lightbox) return;
    els.lightbox.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // double-tap toggle zoom for touch
    if (e.pointerType !== 'mouse' && pointers.size === 1) {
        const now = performance.now();
        if (now - (lbState.lastTap || 0) < 300) {
            if (lbState.scale === 1) { zoomToPointAnimated(2.2, e.clientX, e.clientY); }
            else { animateTo(1, 0, 0, 170); }
        }
        lbState.lastTap = now;
    }

    // When the second finger lands, lock pinch anchor once
    if (pointers.size === 2 && !pinchStart) {
        const pts = [...pointers.values()];
        const c0x = (pts[0].x + pts[1].x) / 2;
        const c0y = (pts[0].y + pts[1].y) / 2;
        const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
        const d0 = Math.hypot(dx, dy) || 1;
        const s0 = lbState.scale;

        // compute anchor in image space once (relative to viewport center + base)
        const { cx, cy } = viewportCenter();
        const left0 = cx - (lbState.baseW * s0) / 2;
        const top0 = cy - (lbState.baseH * s0) / 2;
        const px = (c0x - left0 - lbState.x) / s0;
        const py = (c0y - top0 - lbState.y) / s0;
        pinchStart = true;
    }
});

els.lightbox.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const v = { x: pts[0].x - pts[1].x, y: pts[0].y - pts[1].y };
        const center = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        if (!pinchStartVec) { pinchStartVec = v; pinchStartScale = lbState.scale; }
        const startLen = Math.hypot(pinchStartVec.x, pinchStartVec.y) || 1;
        const len = Math.hypot(v.x, v.y);
        const s = Math.max(1, Math.min(6, pinchStartScale * (len / startLen)));
        const rect = els.lbImg.getBoundingClientRect();
        /* cursor on image coordinate */
        const p1x = (center.x - rect.x);
        const p1y = (center.y - rect.y);
        const p2x = p1x / lbState.scale * s;
        const p2y = p1y / lbState.scale * s;
        /* cursor on image coordinate */
        lbState.x = lbState.x - (p2x - p1x);
        lbState.y = lbState.y - (p2y - p1y);
        lbState.scale = s;

        lbState.x += center.x - (lbState._lastX ?? center.x);
        lbState.y += center.y - (lbState._lastY ?? center.y);
        lbState._lastX = center.x; lbState._lastY = center.y;

        scheduleDraw();
    } else if (pointers.size === 1) {
        // one-finger pan
        const p = [...pointers.values()][0];
        lbState.x += p.x - (lbState._lastX ?? p.x);
        lbState.y += p.y - (lbState._lastY ?? p.y);
        scheduleDraw();
        lbState._lastX = p.x; lbState._lastY = p.y;
    }
});

els.lightbox.addEventListener('pointerup', (e) => {
    lbState._lastX = null; lbState._lastY = null;
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);

    // if a finger lifted ends pinch, clear snapshot
    if (pointers.size < 2) {
        pinchStart = false;
    }

    // swipe navigation when not zoomed and no pinch
    if (pointers.size === 0 && lbState.scale === 1) {
        // (optional) add swipe detection here if you want
    }
});

els.lightbox.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pinchStart = false;
    lbState._lastX = null; lbState._lastY = null;
});


/* nav + close + keys */
els.lbPrev.addEventListener('click', () => lbStep(-1));
els.lbNext.addEventListener('click', () => lbStep(1));
els.lbClose.addEventListener('click', closeLightbox);
els.lightbox.addEventListener('click', (e) => {
    //console.log(e.target)
    if (e.target === els.lightbox && !isImg) closeLightbox();
    isImg = false;
});
document.addEventListener('keydown', (e) => {
    if (!els.lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') lbStep(-1);
    if (e.key === 'ArrowRight') lbStep(1);
});