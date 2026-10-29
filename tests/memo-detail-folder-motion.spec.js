const { test, expect } = require('@playwright/test');

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function installDeterministicViewTransitions(page) {
  await page.addInitScript(() => {
    const calls = [];
    const pending = [];

    const capture = () => {
      const feedHero = document.querySelector('#feed .card[data-id="hero"] .thumbs img');
      const detailHero = document.querySelector('#detailDlg #detailThumbs img');
      const feed = document.getElementById('feed');
      const dialog = document.getElementById('detailDlg');
      return {
        feedName: feedHero ? feedHero.style.viewTransitionName : null,
        detailName: detailHero ? detailHero.style.viewTransitionName : null,
        feedSuppression: feed ? feed.style.viewTransitionName : null,
        dialogOpen: !!(dialog && dialog.open),
      };
    };

    document.startViewTransition = update => {
      const call = {
        before: capture(),
        after: null,
        skipped: false,
        finished: false,
      };
      calls.push(call);

      let resolveFinished;
      const finished = new Promise(resolve => { resolveFinished = resolve; });
      const slot = {
        finish() {
          if (call.finished) return;
          call.finished = true;
          resolveFinished();
        },
      };
      pending.push(slot);

      const updateResult = update();
      call.after = capture();
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(updateResult),
        finished,
        skipTransition() {
          call.skipped = true;
          slot.finish();
        },
      };
    };

    window.__memoVtProbe = {
      calls,
      finish(index) { if (pending[index]) pending[index].finish(); },
      finishAll() { pending.forEach(slot => slot.finish()); },
      reset() {
        calls.length = 0;
        pending.length = 0;
      },
    };
  });
}

async function bootMemo(page, memos, categories = []) {
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoCore && window.MemoStateDb && window.MemoStateDb.ready()
      && window.MemoMotion && window.MemoFilterBootstrapped,
    null,
    { timeout: 15000 },
  );
  await page.evaluate(async ({ memos, categories }) => {
    window.MemoStateDb.importBundle({ version: 1, finance: [], memos }, 'replace');
    await window.MemoStateDb.flush();
    const state = window.MemoCore.getState();
    state.db.entries = window.MemoStateDb.loadEntries('default') || [];
    state.settings.timeSplit = { enabled: false, period: 'month' };
    categories.forEach(category => {
      const select = document.getElementById('categoryFilter');
      if ([...select.options].some(option => option.value === category)) return;
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      select.appendChild(option);
    });
    window.MemoCore.renderFeed();
  }, { memos, categories });
}

async function waitForFeedImage(page, id) {
  await page.waitForFunction(entryId => {
    const image = document.querySelector(`#feed .card[data-id="${entryId}"] .thumbs img`);
    return !!(image && (image.currentSrc || image.getAttribute('src')));
  }, id);
}

test('thumbnail/detail morph hands off its native name, cleans up, and X reverses it', async ({ page }) => {
  await installDeterministicViewTransitions(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await bootMemo(page, [
    { id: 'hero', description: 'Morph target', category: 'Uncategorized', tags: [], images: [IMG], ts: 3000 },
  ]);
  await waitForFeedImage(page, 'hero');
  await page.evaluate(async () => {
    window.__memoVtProbe.finishAll();
    await Promise.resolve();
    window.__memoVtProbe.reset();
    document.querySelector('#feed .card[data-id="hero"]').click();
  });

  await expect(page.locator('#detailDlg')).toHaveAttribute('open', '');
  let calls = await page.evaluate(() => window.__memoVtProbe.calls);
  expect(calls).toHaveLength(1);
  expect(calls[0].before).toEqual({
    feedName: 'memo-detail-hero',
    detailName: null,
    feedSuppression: 'none',
    dialogOpen: false,
  });
  expect(calls[0].after).toEqual({
    feedName: '',
    detailName: 'memo-detail-hero',
    feedSuppression: 'none',
    dialogOpen: true,
  });

  await page.evaluate(() => window.__memoVtProbe.finish(0));
  await page.waitForFunction(() => {
    const feed = document.getElementById('feed');
    const feedHero = document.querySelector('#feed .card[data-id="hero"] .thumbs img');
    const detailHero = document.querySelector('#detailDlg #detailThumbs img');
    return feed.style.viewTransitionName === ''
      && feedHero.style.viewTransitionName === ''
      && detailHero.style.viewTransitionName === '';
  });
  expect(await page.locator('#detailDlg').evaluate(dialog => dialog.classList.contains('detail-morph'))).toBe(true);

  await page.locator('#detailDlg .modal-close').click();
  await expect(page.locator('#detailDlg')).not.toHaveAttribute('open', '');
  calls = await page.evaluate(() => window.__memoVtProbe.calls);
  expect(calls).toHaveLength(2);
  expect(calls[1].before).toEqual({
    feedName: '',
    detailName: 'memo-detail-hero',
    feedSuppression: 'none',
    dialogOpen: true,
  });
  expect(calls[1].after).toEqual({
    feedName: 'memo-detail-hero',
    detailName: '',
    feedSuppression: 'none',
    dialogOpen: false,
  });

  await page.evaluate(() => window.__memoVtProbe.finish(1));
  await page.waitForFunction(() => {
    const feed = document.getElementById('feed');
    const feedHero = document.querySelector('#feed .card[data-id="hero"] .thumbs img');
    const detailHero = document.querySelector('#detailDlg #detailThumbs img');
    return feed.style.viewTransitionName === ''
      && feedHero.style.viewTransitionName === ''
      && detailHero.style.viewTransitionName === '';
  });
  expect(await page.locator('#detailDlg').evaluate(dialog => dialog.classList.contains('detail-morph'))).toBe(false);
});

test('an image-less memo opens detail without requesting a shared transition', async ({ page }) => {
  await installDeterministicViewTransitions(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await bootMemo(page, [
    { id: 'plain', description: 'No image', category: 'Uncategorized', tags: [], images: [], ts: 3000 },
  ]);
  await page.evaluate(() => {
    window.__memoVtProbe.finishAll();
    window.__memoVtProbe.reset();
    document.querySelector('#feed .card[data-id="plain"]').click();
  });

  await expect(page.locator('#detailDlg')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => window.__memoVtProbe.calls.length)).toBe(0);
  expect(await page.locator('#detailDlg').evaluate(dialog => dialog.classList.contains('detail-morph'))).toBe(false);
  await expect(page.locator('#detailDlg #detailThumbs img')).toHaveCount(0);
});

test('reduced motion bypasses the shared transition even when a thumbnail exists', async ({ page }) => {
  await installDeterministicViewTransitions(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bootMemo(page, [
    { id: 'hero', description: 'Reduced motion', category: 'Uncategorized', tags: [], images: [IMG], ts: 3000 },
  ]);
  await waitForFeedImage(page, 'hero');
  await page.evaluate(() => {
    window.__memoVtProbe.finishAll();
    window.__memoVtProbe.reset();
    document.querySelector('#feed .card[data-id="hero"]').click();
  });

  await expect(page.locator('#detailDlg')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => window.__memoVtProbe.calls.length)).toBe(0);
  expect(await page.locator('#detailDlg').evaluate(dialog => dialog.classList.contains('detail-morph'))).toBe(false);
  expect(await page.locator('#feed .card[data-id="hero"] .thumbs img').evaluate(image => image.style.viewTransitionName)).toBe('');
  expect(await page.locator('#detailDlg #detailThumbs img').evaluate(image => image.style.viewTransitionName)).toBe('');
});

test('a cancelled queued morph cannot reopen detail after privacy teardown', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await bootMemo(page, [
    { id: 'hero', description: 'Private pending detail', category: 'Uncategorized', tags: [], images: [IMG], ts: 3000 },
  ]);
  await waitForFeedImage(page, 'hero');

  const result = await page.evaluate(async () => {
    let delayedUpdate = null;
    let resolveFinished = null;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    document.startViewTransition = update => {
      delayedUpdate = update;
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished,
        skipTransition() { resolveFinished(); },
      };
    };

    document.querySelector('#feed .card[data-id="hero"]').click();
    const beforeCancel = {
      dialogOpen: document.getElementById('detailDlg').open,
      heroName: document.querySelector('#feed .card[data-id="hero"] .thumbs img').style.viewTransitionName,
    };
    document.dispatchEvent(new CustomEvent('memo:privacy-locked'));
    const afterCancel = {
      dialogOpen: document.getElementById('detailDlg').open,
      heroName: document.querySelector('#feed .card[data-id="hero"] .thumbs img').style.viewTransitionName,
    };
    await delayedUpdate();
    await Promise.resolve();
    return {
      beforeCancel,
      afterCancel,
      afterDelayedUpdate: {
        dialogOpen: document.getElementById('detailDlg').open,
        detailImages: document.querySelectorAll('#detailDlg #detailThumbs img').length,
        heroName: document.querySelector('#feed .card[data-id="hero"] .thumbs img').style.viewTransitionName,
        feedSuppression: document.getElementById('feed').style.viewTransitionName,
      },
    };
  });

  expect(result.beforeCancel).toEqual({ dialogOpen: false, heroName: 'memo-detail-hero' });
  expect(result.afterCancel).toEqual({ dialogOpen: false, heroName: '' });
  expect(result.afterDelayedUpdate).toEqual({
    dialogOpen: false,
    detailImages: 0,
    heroName: '',
    feedSuppression: '',
  });
});

test('folder enter snapshots are inert and ID-free, then system Back tears down its reverse layer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await bootMemo(page, [
    { id: 'work-1', description: 'Inside Work', category: 'Work', tags: [], images: [], ts: 3000 },
  ], ['Work']);
  // The compact mobile category select is optional in the current shell, but
  // older/native chrome still provides it. Mount that supported counterpart so
  // direct circular navigation proves both controls remain synchronized.
  await page.evaluate(() => {
    const mobile = document.createElement('select');
    mobile.id = 'mobileCategoryFilter';
    document.body.appendChild(mobile);
    window.MemoTheme.syncCategoryOptions();
  });
  await page.waitForSelector('#feed .folder-card[data-folder="Work"]');

  const entering = await page.evaluate(() => {
    document.querySelector('#feed .folder-card[data-folder="Work"]').click();
    const layers = [...document.querySelectorAll('.nav-reveal')];
    return {
      category: document.getElementById('categoryFilter').value,
      mobileCategory: document.getElementById('mobileCategoryFilter')?.value,
      breadcrumbHidden: document.getElementById('breadcrumb').hidden,
      entryMounted: !!document.querySelector('#feed .card[data-id="work-1"]'),
      feedVisibility: document.getElementById('feed').style.visibility,
      layerCount: layers.length,
      layersAccessible: layers.every(layer => layer.getAttribute('aria-hidden') === 'true' && layer.inert),
      clonedIds: document.querySelectorAll('.nav-reveal [id]').length,
      contentsSuppressed: layers.every(layer => layer.querySelector('.nav-reveal-content')?.style.viewTransitionName === 'none'),
    };
  });
  expect(entering).toEqual({
    category: 'Work',
    mobileCategory: 'Work',
    breadcrumbHidden: false,
    entryMounted: true,
    feedVisibility: 'hidden',
    layerCount: 2,
    layersAccessible: true,
    clonedIds: 0,
    contentsSuppressed: true,
  });

  await page.waitForFunction(() => (
    document.querySelectorAll('.nav-reveal').length === 0
    && document.getElementById('feed').style.visibility === ''
  ), null, { timeout: 3000 });

  const exiting = await page.evaluate(() => {
    const handled = window.MemoShell.handleSystemBack();
    const layers = [...document.querySelectorAll('.nav-reveal')];
    return {
      handled,
      category: document.getElementById('categoryFilter').value,
      mobileCategory: document.getElementById('mobileCategoryFilter')?.value,
      breadcrumbHidden: document.getElementById('breadcrumb').hidden,
      folderMounted: !!document.querySelector('#feed .folder-card[data-folder="Work"]'),
      feedVisibility: document.getElementById('feed').style.visibility,
      layerCount: layers.length,
      layersAccessible: layers.every(layer => layer.getAttribute('aria-hidden') === 'true' && layer.inert),
      clonedIds: document.querySelectorAll('.nav-reveal [id]').length,
    };
  });
  expect(exiting).toEqual({
    handled: true,
    category: '__ALL__',
    mobileCategory: '__ALL__',
    breadcrumbHidden: true,
    folderMounted: true,
    feedVisibility: '',
    layerCount: 1,
    layersAccessible: true,
    clonedIds: 0,
  });

  await page.waitForFunction(() => document.querySelectorAll('.nav-reveal').length === 0, null, { timeout: 3000 });
  expect(await page.evaluate(() => document.getElementById('feed').style.visibility)).toBe('');
});
