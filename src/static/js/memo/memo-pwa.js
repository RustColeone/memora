// Packaged assets are owned by the APK. Browser workers activate when their
// previous clients close; foregrounding never reloads a live editor.
(function (global) {
  async function start() {
    // The desktop app serves its own files (app://memora); no worker there.
    if (!navigator.serviceWorker || !global.isSecureContext || global.MemoDesktop) return;
    const native = global.MemoLifecycle?.native() || global.Capacitor?.isNativePlatform?.() || !!global.MemoDesktop;
    if (native) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        if ([registration.active, registration.waiting, registration.installing].some(worker => worker && new URL(worker.scriptURL).pathname === '/sw.js')) await registration.unregister();
      }
      // Existing clients can still be controlled until navigation. Remove only
      // derived shell caches so the retiring cache-first worker reads APK bytes.
      for (const name of await caches.keys()) if (name.startsWith('memora-shell-')) await caches.delete(name);
      global.MemoLifecycle?.trace('packaged-worker-retired');
      return;
    }
    const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    navigator.serviceWorker.addEventListener('controllerchange', () => global.MemoLifecycle?.trace('worker-controller-change'));
    registration.addEventListener('updatefound', () => global.MemoLifecycle?.trace('worker-update-found'));
  }
  if (document.readyState === 'complete') start().catch(console.warn);
  else global.addEventListener('load', () => start().catch(console.warn), { once: true });
})(window);
