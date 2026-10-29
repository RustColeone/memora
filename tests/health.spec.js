// Library Health + Organize quiz (memo-health.js). Health score: +1 tags, +1
// filed (category ≠ Uncategorized). The quiz surfaces the least-organized
// entries first and each save files the entry via MemoCore.batchApply.
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.MemoHealth && window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready(), null, { timeout: 15000 });
}

// e1 score2 (tags+filed), e2 score1 (filed only), e3 score1 (tags only), e4 score0.
async function seed(page) {
  await page.evaluate(async () => {
    const now = Date.now();
    const bundle = { version: 1, finance: [], memos: [
      { id: 'e1', description: 'organized', category: 'Work', tags: ['a'], images: [], ts: now },
      { id: 'e2', description: 'partial-cat', category: 'Work', tags: [], images: [], ts: now - 1000 },
      { id: 'e3', description: 'partial-tag', category: 'Uncategorized', tags: ['b'], images: [], ts: now - 2000 },
      { id: 'e4', description: 'unorg', category: 'Uncategorized', tags: [], images: [], ts: now - 3000 },
    ] };
    window.MemoStateDb.importBundle(bundle, 'replace');
    await window.MemoStateDb.flush();
    window.MemoCore.getState().db.entries = window.MemoStateDb.loadEntries('default') || [];
  });
}

test('health bar + score reflect organization counts', async ({ page }) => {
  await boot(page);
  await seed(page);
  const r = await page.evaluate(() => {
    window.MemoHealth.refresh();
    return {
      score: document.getElementById('healthScore').textContent,
      green: document.getElementById('healthBarGreen').style.width,
      amber: document.getElementById('healthBarAmber').style.width,
      organized: document.getElementById('healthOrganized').textContent,
      partial: document.getElementById('healthPartial').textContent,
      unorg: document.getElementById('healthUnorg').textContent,
      total: document.getElementById('healthTotal').textContent,
    };
  });
  // c2=1, c1=2, c0=1, total=4 → green 25%, amber 50%, score (2+2)/8 = 50%
  expect(r.organized).toBe('1');
  expect(r.partial).toBe('2');
  expect(r.unorg).toBe('1');
  expect(r.total).toBe('4');
  expect(parseFloat(r.green)).toBeCloseTo(25, 1); // browser may normalise '25.0%'→'25%'
  expect(parseFloat(r.amber)).toBeCloseTo(50, 1);
  expect(r.score).toBe('50%');
});

test('computeScore scores tags + filing independently', async ({ page }) => {
  await boot(page);
  const scores = await page.evaluate(() => {
    const s = window.MemoHealth.computeScore;
    return {
      both: s({ tags: ['x'], category: 'Work' }),
      filedOnly: s({ tags: [], category: 'Work' }),
      taggedOnly: s({ tags: ['x'], category: 'Uncategorized' }),
      neither: s({ tags: [], category: 'Uncategorized' }),
    };
  });
  expect(scores).toEqual({ both: 2, filedOnly: 1, taggedOnly: 1, neither: 0 });
});

test('the quiz surfaces the least-organized entry first and saving files it', async ({ page }) => {
  await boot(page);
  await seed(page);
  const first = await page.evaluate(() => {
    window.MemoHealth.openQuiz();
    return {
      open: document.getElementById('quizDlg').open,
      progress: document.getElementById('quizProgress').textContent,
      desc: document.getElementById('quizDesc').textContent,
      backDisabled: document.getElementById('quizBackBtn').disabled,
    };
  });
  expect(first.open).toBe(true);
  expect(first.progress).toBe('1 of 3'); // e2,e3,e4 are score<2
  expect(first.desc).toBe('unorg');      // e4 (score 0) sorts first
  expect(first.backDisabled).toBe(true);

  // File e4 into a new folder + add a tag, then Save & Next.
  await page.evaluate(() => {
    document.getElementById('quizNewCat').value = 'Filed';
    document.getElementById('quizAddCatBtn').click();      // adds + selects the option
    document.getElementById('quizTagInput').value = 'done';
    document.getElementById('quizAddTagBtn').click();
    document.getElementById('quizSaveBtn').click();         // async batchApply
  });
  await page.waitForFunction(() => {
    const e = window.MemoCore.getState().db.entries.find(x => x.id === 'e4');
    return e && e.category === 'Filed' && (e.tags || []).includes('done');
  }, null, { timeout: 10000 });

  // The local projection updates before the durable checkpoint completes.
  // The quiz advances after that checkpoint, so wait for its visible result.
  await expect(page.locator('#quizProgress')).toHaveText('2 of 3');

  const after = await page.evaluate(() => ({
    progress: document.getElementById('quizProgress').textContent,
    // health improved: e4 went score0 → score2, so organized is now 2
    organized: (window.MemoHealth.refresh(), document.getElementById('healthOrganized').textContent),
  }));
  expect(after.progress).toBe('2 of 3'); // advanced to the next card
  expect(after.organized).toBe('2');     // e1 + newly-filed e4
});
