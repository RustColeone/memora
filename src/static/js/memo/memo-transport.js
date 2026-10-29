// One bounded, authenticated transport for browser and Capacitor requests.
(function (global) {
  'use strict';
  function base() { return global.MemoRuntime?.getApiBase?.() || global.API_BASE || ''; }
  function headersFor(url, serverBase) {
    try {
      const target = new URL(url, global.location.href);
      const server = new URL(serverBase || global.location.origin, global.location.href);
      return target.origin === server.origin && /^\/(api|uploads)\//.test(target.pathname)
        ? (global.MemoAuth?.headers?.() || {}) : {};
    } catch (_) { return {}; }
  }
  async function request(url, options = {}, serverBase = base()) {
    const absolute = new URL(url, global.location.href).href;
    const headers = Object.fromEntries(new Headers(options.headers || {}).entries());
    Object.assign(headers, headersFor(absolute, serverBase));
    const method = (options.method || 'GET').toUpperCase();
    const native = global.Capacitor?.Plugins?.CapacitorHttp;
    if (native && !(options.body instanceof FormData)) {
      let data = options.body;
      if (typeof data === 'string' && Object.entries(headers).some(([k, v]) => k.toLowerCase() === 'content-type' && v.includes('json'))) data = JSON.parse(data);
      const args = { url: absolute, method, headers, data, connectTimeout: 10000,
        readTimeout: 30000, responseType: options.responseType || 'text' };
      const response = native.request ? await native.request(args) : await native[method.toLowerCase()](args);
      const raw = response.data;
      return {
        ok: response.status >= 200 && response.status < 300, status: response.status,
        json: async () => typeof raw === 'string' ? JSON.parse(raw) : raw,
        text: async () => typeof raw === 'string' ? raw : JSON.stringify(raw),
        blob: async () => {
          if (raw instanceof Blob) return raw;
          if (typeof raw !== 'string') throw new Error('Invalid native file response');
          const bytes = Uint8Array.from(atob(raw.replace(/^data:[^,]*,/, '')), c => c.charCodeAt(0));
          const mime = Object.entries(response.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
          return new Blob([bytes], { type: mime || 'application/octet-stream' });
        }
      };
    }
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await global.fetch(absolute, { ...options, headers, signal: controller.signal });
      // Include reading the body in the deadline, not just receiving headers.
      const bytes = await response.arrayBuffer();
      return new Response([204, 205, 304].includes(response.status) ? null : bytes,
        { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  global.MemoTransport = { request, headersFor };
})(window);
