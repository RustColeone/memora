(function (global) {
  'use strict';
  // Android's alarm plugin, or the desktop app's Windows notifications.
  const plugin = () => global.Capacitor?.Plugins?.PlannerReminders || global.MemoDesktop?.reminders;
  const t = key => global.MemoI18n?.t(key) || key;
  let last = '', running = null, requested = false, failure = false;
  // A repeating event carries the times it comes round over the next 30 days
  // (at most 40) and holds one alarm, which the phone moves on to the next
  // time after each one; the window moves on whenever the app reopens.
  const REPEAT_DAYS = 30, REPEAT_MAX = 40;
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  function occursOn(e, day) {
    if (!e.date || day < e.date) return false;
    if (e.repeatUntil && day > e.repeatUntil) return false;
    if (Array.isArray(e.skip) && e.skip.includes(day)) return false;
    const d = parse(day), s = parse(e.date);
    switch (e.repeat) {
      case 'daily': return true;
      case 'weekdays': return d.getDay() >= 1 && d.getDay() <= 5;
      case 'weekly': return d.getDay() === s.getDay();
      case 'monthly': return d.getDate() === s.getDate();
      case 'yearly': return d.getDate() === s.getDate() && d.getMonth() === s.getMonth();
    }
    return false;
  }
  function dates(e) {
    if (!['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(e.repeat)) return [e.date];
    const out = [], today = new Date();
    for (let i = 0; i <= REPEAT_DAYS && out.length < REPEAT_MAX; i++) {
      const day = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
      if (occursOn(e, day)) out.push(day);
    }
    return out;
  }
  // Android refuses more than 500 pending alarms per app (and a reboot would
  // then fail to restore them), so only the soonest are handed over; the
  // window moves on as those go by and the app reopens.
  const MAX_ALARMS = 400;
  const dueKey = x => x.date + ' ' + x.start + ' ' + String(99999 - x.remindBefore).padStart(5, '0');
  function events() {
    // Past days would take the soonest slots; keep yesterday, which the phone
    // may still deliver if Android held the alarm back.
    const yesterday = iso(new Date(Date.now() - 86400000));
    return (global.MemoStateDb?.loadDocs('planner') || []).filter(e => e.kind === 'event' && !e.deletedAt && (e.remindBefore > 0 || e.remindAtStart))
      .map(e => {
        const days = dates(e).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(String(day)) && day >= yesterday);
        if (!days.length) return null;
        const x = { id: String(e.id), date: days[0], start: e.allDay ? '09:00' : e.start || '09:00',
          remindBefore: e.remindAtStart ? 0 : Number(e.remindBefore), channel: t('Planner reminders'), body: t('An event is coming up. Open Planner.') };
        if (e.repeat) x.dates = days;
        return x;
      })
      .filter(Boolean)
      .sort((a, b) => dueKey(a).localeCompare(dueKey(b)))
      .slice(0, MAX_ALARMS);
  }
  async function refresh() {
    const label = document.getElementById('evReminderStatus'), button = document.getElementById('evReminderEnable');
    if (!label || !button) return;
    let enabled = false;
    try { enabled = !!(await plugin()?.status())?.enabled; } catch (_) {}
    label.textContent = t(!plugin() ? 'Reminders require the Android app on this device.' : failure ? 'Could not schedule reminders. Retry.' : enabled
      ? 'Reminders enabled. Android may delay alerts to save battery. All-day reminders use 9 AM.'
      : 'Notifications are disabled on this device. Enable them to receive reminders.');
    button.hidden = !plugin() || (enabled && !failure);
    button.textContent = t(failure ? 'Retry reminders' : 'Enable reminders');
  }
  function reconcile(force = false) {
    if (!plugin() || !global.MemoStateDb?.ready()) return Promise.resolve();
    if (force) last = '';
    requested = true;
    if (running) return running;
    running = (async () => {
      while (requested) {
        requested = false;
        const next = events(), signature = JSON.stringify(next);
        if (signature === last) continue;
        await global.MemoStateDb.flush();
        await plugin().replace({ events: next });
        last = signature; failure = false;
      }
    })().catch(() => { failure = true; }).finally(() => { running = null; void refresh(); });
    return running;
  }
  async function resume() {
    await reconcile(true);
    if ((await plugin()?.consumeOpen())?.open && global.MemoSpaShell) await global.MemoSpaShell.switchTo('planner');
  }
  document.addEventListener('click', async event => {
    if (event.target.id !== 'evReminderEnable') return;
    try {
      if (!failure) { const status = await plugin().enable(); if (!status.enabled) await plugin().settings(); }
      await reconcile(true);
    } catch (_) { failure = true; }
    void refresh();
  });
  global.addEventListener('memo:metadata-health', event => { if (!event.detail?.pending && !event.detail?.lastPersistError) void reconcile(); });
  global.addEventListener('memo:resume', () => void resume());
  document.addEventListener('memo:localechange', () => { void reconcile(); void refresh(); });
  global.addEventListener('load', () => { Promise.resolve(global.MemoAppReady).then(resume).catch(() => {}); }, { once: true });
  global.MemoPlannerReminders = { reconcile, refresh, events };
})(window);
