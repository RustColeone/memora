// Opt-in emulator delivery test, preserving the existing Planner event schedule.
const { chromium, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const path = require('path');
const serial = process.argv[2] || 'emulator-5554';
if (!/^emulator-\d+$/.test(serial)) throw new Error('Reminder permission and delivery check is emulator-only');
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true }).trim();
let browser, port, page;
(async () => {
  try {
    adb('shell', 'pm', 'grant', 'com.laplacengan.memora', 'android.permission.POST_NOTIFICATIONS');
    adb('shell', 'am', 'start', '-W', '-n', 'com.laplacengan.memora/.MainActivity');
    port = adb('forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + adb('shell', 'pidof', 'com.laplacengan.memora'));
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true });
    page = browser.contexts()[0].pages()[0];
    console.log('Attached:', page.url());
    await page.waitForFunction(() => !!window.MemoAppReady && !!window.MemoPlannerReminders, null, { timeout: 60000 }); await page.evaluate(() => MemoAppReady);
    const id = 'memora-reminder-check-' + Date.now();
    const delay = await page.evaluate(async id => {
      await MemoPlannerReminders.reconcile(true);
      const date = new Date(Date.now() + 120000), pad = n => String(n).padStart(2, '0');
      date.setSeconds(0, 0);
      const event = { id, date: `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`, start: `${pad(date.getHours())}:${pad(date.getMinutes())}`, remindBefore: 1, channel: 'Planner reminders', body: 'Synthetic reminder delivery check' };
      await Capacitor.Plugins.PlannerReminders.replace({ events: [...MemoPlannerReminders.events(), event] });
      return date.getTime() - 60000 - Date.now();
    }, id);
    expect(adb('shell', 'dumpsys', 'alarm').includes('memora.PLANNER_REMINDER')).toBe(true);
    console.log('PASS: persisted local alarm registered; due in ' + Math.round(delay / 1000) + ' seconds');
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    const deadline = Date.now() + delay + 90000;
    while (Date.now() < deadline) {
      const notifications = adb('shell', 'dumpsys', 'notification', '--noredact');
      if (notifications.includes('tag=' + id)) {
        console.log('PASS: Android delivered reminder while app was backgrounded');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error('Reminder did not appear before the delivery deadline');
  } finally {
    if (page) try { await page.evaluate(() => window.MemoPlannerReminders?.reconcile(true)); } catch (_) {}
    if (browser) await browser.close();
    if (port) adb('forward', '--remove', 'tcp:' + port);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
