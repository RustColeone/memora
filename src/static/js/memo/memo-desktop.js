// memo-desktop.js — Memora for Windows (desktop/main.cjs, through preload.cjs).
//
// Loads first. In the desktop app the page lives at app://memora and gets
// window.MemoDesktop; elsewhere this file does nothing. Like CapacitorHttp on
// the phone, every fetch to another address (AI providers, sync servers) goes
// through the app instead of the browser, so CORS and mixed-content rules
// never block a provider or a sync server on the home network. Storage and
// reminders reuse the phone's code (memo-native-store.js,
// memo-planner-reminders.js) on the app's versions of the same calls.
(function (global) {
  'use strict';
  var D = global.MemoDesktop;
  if (!D) return;
  document.documentElement.classList.add('desktop-mode');

  var pageFetch = global.fetch.bind(global);
  function isOutside(url) {
    return /^https?:$/.test(url.protocol) && url.origin !== global.location.origin;
  }
  global.fetch = async function (input, init) {
    var request = new Request(input, init);
    var url = new URL(request.url);
    if (!isOutside(url)) return pageFetch(input, init);
    if (request.signal && request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    var body = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
    var headers = {};
    request.headers.forEach(function (value, key) { headers[key] = value; });
    var pending = D.http.request({ url: request.url, method: request.method, headers: headers, body: body });
    var out = request.signal
      ? await Promise.race([pending, new Promise(function (_r, reject) {
        request.signal.addEventListener('abort', function () { reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      })])
      : await pending;
    if (out.error) throw new TypeError('Failed to fetch: ' + out.error);
    var empty = [101, 204, 205, 304].indexOf(out.status) >= 0;
    return new Response(empty ? null : out.body, { status: out.status, statusText: out.statusText, headers: out.headers });
  };

  global.MemoDesktopApp = {
    available: true,
    server: D.server,
    info: D.info
  };
})(window);
