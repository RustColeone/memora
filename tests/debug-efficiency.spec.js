const { test, expect } = require('@playwright/test');

function installDebugProbe(enabled) {
  try {
    if (enabled) localStorage.setItem('memo_debug', '1');
    else localStorage.removeItem('memo_debug');
  } catch (_error) {}

  const consoleMethods = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };
  const listeners = [];
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function debugProbeAddEventListener(type, listener, options) {
    const stack = new Error().stack || '';
    if (stack.includes('memo-debug.js')) listeners.push(type);
    return originalAddEventListener.call(this, type, listener, options);
  };

  const textContent = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  let debugContentWrites = 0;
  Object.defineProperty(Node.prototype, 'textContent', {
    configurable: textContent.configurable,
    enumerable: textContent.enumerable,
    get: textContent.get,
    set(value) {
      if (this && this.id === 'debugLogContent') debugContentWrites += 1;
      return textContent.set.call(this, value);
    },
  });

  window.__debugEfficiencyProbe = {
    consoleMethods,
    listeners,
    get debugContentWrites() { return debugContentWrites; },
  };
}

async function boot(page, enabled) {
  await page.addInitScript(installDebugProbe, enabled);
  await page.goto('/index.html');
  await page.waitForFunction(
    () => window.MemoCore && window.MemoStateDb?.ready() && document.readyState === 'complete',
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(250);
}

test('disabled debug mode leaves production console, listeners, and dialog DOM untouched', async ({ page }) => {
  await boot(page, false);

  const result = await page.evaluate(() => {
    const probe = window.__debugEfficiencyProbe;
    console.log('ordinary production log');
    document.body.click();
    window.dispatchEvent(new Event('resize'));
    return {
      consoleUnchanged: ['log', 'warn', 'error', 'info'].every(
        method => console[method] === probe.consoleMethods[method],
      ),
      debugListeners: probe.listeners,
      debugContentWrites: probe.debugContentWrites,
    };
  });

  expect(result).toEqual({
    consoleUnchanged: true,
    debugListeners: [],
    debugContentWrites: 0,
  });
});

test('enabled debug mode captures while closed and hydrates only while the dialog is open', async ({ page }) => {
  await boot(page, true);

  const closed = await page.evaluate(() => {
    const probe = window.__debugEfficiencyProbe;
    const beforeEntries = window.DebugLog.entries.length;
    console.log('captured while closed');
    return {
      consoleWrapped: console.log !== probe.consoleMethods.log,
      captured: window.DebugLog.entries.length === beforeEntries + 1,
      contentIncludesMessage: document.getElementById('debugLogContent').textContent.includes('captured while closed'),
      writes: probe.debugContentWrites,
      listeners: probe.listeners,
    };
  });
  expect(closed.consoleWrapped).toBe(true);
  expect(closed.captured).toBe(true);
  expect(closed.contentIncludesMessage).toBe(false);
  expect(closed.writes).toBe(0);
  expect(closed.listeners).toEqual(expect.arrayContaining(['click', 'resize', 'orientationchange']));

  const opened = await page.evaluate(() => {
    const probe = window.__debugEfficiencyProbe;
    const beforeOpen = probe.debugContentWrites;
    document.getElementById('mobileDebugLogBtn').click();
    const afterOpen = probe.debugContentWrites;
    console.log('captured while open');
    return {
      open: document.getElementById('debugLogDlg').open,
      hydrationWrites: afterOpen - beforeOpen,
      openLogWrites: probe.debugContentWrites - afterOpen,
      content: document.getElementById('debugLogContent').textContent,
    };
  });
  expect(opened.open).toBe(true);
  expect(opened.hydrationWrites).toBe(1);
  expect(opened.openLogWrites).toBe(1);
  expect(opened.content).toContain('captured while closed');
  expect(opened.content).toContain('captured while open');

  await page.evaluate(() => document.getElementById('debugLogDlg').close());
  await page.waitForFunction(() => !document.getElementById('debugLogDlg').open);
  const closedAgain = await page.evaluate(() => {
    const probe = window.__debugEfficiencyProbe;
    const before = probe.debugContentWrites;
    console.log('second closed log');
    return {
      writes: probe.debugContentWrites - before,
      captured: window.DebugLog.entries.some(entry => entry.message === 'second closed log'),
    };
  });
  expect(closedAgain).toEqual({ writes: 0, captured: true });
});
