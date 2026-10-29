// Reconcile an ordered list without detaching unchanged nodes (and their focus).
(function (global) {
  const animations = new Map();
  const reduced = global.matchMedia('(prefers-reduced-motion: reduce)');
  function animate(node, frames, options) {
    animations.get(node)?.cancel();
    if (!node.animate || document.hidden || global.__memoRestoring || reduced.matches) return null;
    const animation = node.animate(frames, options);
    animations.set(node, animation);
    animation.finished.catch(() => {}).finally(() => { if (animations.get(node) === animation) animations.delete(node); });
    return animation;
  }
  function cancelAnimations() { for (const animation of animations.values()) animation.cancel(); animations.clear(); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimations(); });
  reduced.addEventListener('change', () => { if (reduced.matches) cancelAnimations(); });
  function reconcile(parent, nodes) {
    const animate = global.__memoRenderReason === 'local' && !global.__memoRestoring && !document.hidden
      && !global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const before = new Map();
    if (animate) for (const node of parent.children) before.set(node, node.getBoundingClientRect());
    const wanted = new Set(nodes);
    for (const child of Array.from(parent.childNodes)) {
      if (!wanted.has(child)) { global.MemoLazy?.release?.(child); child.remove(); }
    }
    let next = parent.firstChild;
    for (const node of nodes) {
      if (node === next) next = next.nextSibling;
      else parent.insertBefore(node, next);
    }
    if (animate) for (const node of nodes) {
      if (!node.animate || !node.isConnected) continue;
      const rect = node.getBoundingClientRect(), old = before.get(node);
      if (rect.bottom < 0 || rect.top > innerHeight) continue;
      if (!old) global.MemoDom.animate(node, [{ opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }], { duration: 150, easing: 'ease-out' });
      else if (Math.abs(old.top - rect.top) > 1) global.MemoDom.animate(node,
        [{ translate: `0 ${old.top - rect.top}px` }, { translate: '0 0' }], { duration: 150, easing: 'ease-out' });
    }
  }
  // For keyed planner components whose controls act on stable record IDs.
  function patch(node, fresh) {
    if (node.nodeType !== fresh.nodeType || node.nodeName !== fresh.nodeName) { node.replaceWith(fresh); return fresh; }
    if (node.nodeType === Node.TEXT_NODE) { if (node.data !== fresh.data) node.data = fresh.data; return node; }
    for (const attr of Array.from(node.attributes)) if (!fresh.hasAttribute(attr.name)) node.removeAttribute(attr.name);
    for (const attr of fresh.attributes) if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
    const old = Array.from(node.childNodes), next = Array.from(fresh.childNodes);
    next.forEach((child, i) => { if (old[i]) patch(old[i], child); else node.append(child); });
    old.slice(next.length).forEach(child => child.remove());
    return node;
  }
  function assetKey(value) {
    const db = global.MemoStateDb;
    return db?.relForBlobUrl?.(value) || (typeof value === 'string' && /(^|\/)uploads\//.test(value)
      ? (db?.urlToRel?.(value) || value) : value);
  }
  global.MemoDom = { reconcile, assetKey, patch, animate };
})(window);
