// Regression tests for bugs found during the QA pass.
const { test, expect } = require('@playwright/test');

// ── Finance percentage tax ──────────────────────────────────────────────────
// Bug: insertEntry ran num(e.tax), coercing "8%" → 8, so a percentage tax was
// silently stored as a flat $8 on save/reload; and the row cell showed the raw
// tax field instead of the computed amount.
test('finance percentage tax is stored raw and the row shows the computed amount', async ({ page }) => {
  await page.goto('/finance.html');
  await page.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready() && window.MemoCore && window.MemoVariant, null, { timeout: 15000 });
  const res = await page.evaluate(async () => {
    window.MemoStateDb.saveEntries([
      // subtotal 50; 8% tax = $4.00 (a flat-8 bug would instead show $8.00)
      { id: 'pct', description: 'pct', category: 'X', tags: [], images: [], purchaseDate: '2025-01-01', tax: '8%', total: 54, items: [{ name: 'a', amount: 1, unitPrice: 50, totalPrice: 50 }] },
    ], 'finance');
    await window.MemoStateDb.flush();
    const stored = window.MemoStateDb.loadEntries('finance').find(e => e.id === 'pct').tax;
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('finance');
    window.MemoVariant.renderFeed();
    const taxCells = [...document.querySelectorAll('#feed td.col-tax')].map(c => c.textContent.trim());
    return { stored, taxCells };
  });
  expect(String(res.stored)).toBe('8%');       // percentage preserved through storage
  expect(res.taxCells).toContain('$4.00');     // computed 8% of $50, not a flat $8
  expect(res.taxCells).not.toContain('$8.00');
});

test('finance flat tax and empty tax still work', async ({ page }) => {
  await page.goto('/finance.html');
  await page.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
  const out = await page.evaluate(async () => {
    window.MemoStateDb.saveEntries([
      { id: 'flat', description: 'f', category: 'X', tags: [], images: [], purchaseDate: '2025-01-01', tax: '5', total: 105, items: [] },
      { id: 'none', description: 'n', category: 'X', tags: [], images: [], purchaseDate: '2025-01-01', tax: '', total: 100, items: [] },
    ], 'finance');
    await window.MemoStateDb.flush();
    const rows = window.MemoStateDb.loadEntries('finance');
    return { flat: rows.find(e => e.id === 'flat').tax, none: rows.find(e => e.id === 'none').tax };
  });
  expect(Number(out.flat)).toBe(5);
  expect(out.none == null || out.none === '' || Number(out.none) === 0).toBe(true);
});

// ── Planner robustness ──────────────────────────────────────────────────────
// Bug: a project missing start/end made parseISO(undefined).split throw inside
// the Gantt domain(), which aborted the whole renderAll — blanking the calendar,
// todos and habits too.
test('planner survives a malformed project (no start/end) without blanking the page', async ({ page }) => {
  await page.goto('/planner.html');
  await page.waitForFunction(() => window.MemoStateDb && window.MemoStateDb.ready() && window.Planner && window.Planner.Store, null, { timeout: 15000 });
  const res = await page.evaluate(async () => {
    const iso = new Date().toISOString();
    window.MemoStateDb.saveDocs('planner', [
      { id: 'bad', kind: 'project', name: 'NoDates', color: '#f00', milestones: [], createdAt: iso, updatedAt: iso },
      { id: 't1', kind: 'todo', title: 'still here', due: '2025-01-01', done: false, createdAt: iso, updatedAt: iso },
      { id: 'h1', kind: 'habit', name: 'Gym', type: 'check', targetDays: [1], logs: [], color: '#0f0', createdAt: iso, updatedAt: iso },
    ]);
    await window.MemoStateDb.flush();
    let threw = false;
    try { window.Planner.Store.reload(); } catch (e) { threw = true; }
    return {
      threw,
      todoText: (document.getElementById('todoList') || {}).textContent || '',
      // Habits render AFTER Projects in renderAll, so their presence proves the
      // Gantt render didn't abort the pass.
      habitsRendered: !!(document.getElementById('habitsGrid') && document.getElementById('habitsGrid').children.length),
      ganttHasProject: /NoDates/.test((document.getElementById('projCards') || {}).textContent || ''),
    };
  });
  expect(res.threw).toBe(false);
  expect(res.todoText).toContain('still here');
  expect(res.habitsRendered).toBe(true);
  expect(res.ganttHasProject).toBe(true);
});
