// Local-only image editing journal. A source blob is written once per session;
// subsequent checkpoints write just the recipe, atomically with its source ID.
(function (global) {
  let opening, pending = Promise.resolve();
  function database() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('memo-image-drafts', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('recipes');
        request.result.createObjectStore('sources');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = () => { opening = null; reject(request.error); };
    });
    return opening;
  }
  function transaction(db, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['recipes', 'sources'], mode, { durability: 'strict' });
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Image draft could not be saved.'));
      tx.onerror = () => {}; // The abort event is the final result.
      work(tx.objectStore('recipes'), tx.objectStore('sources'), value => { result = value; });
    });
  }
  function enqueue(work) {
    const result = pending.catch(() => {}).then(work);
    pending = result;
    // Autosave callers report errors without leaving an unhandled rejection.
    result.catch(() => {});
    return result;
  }
  async function read(variant, withSource = true) {
    await pending.catch(() => {});
    const db = await database();
    return transaction(db, 'readonly', (recipes, sources, done) => {
      recipes.get(variant).onsuccess = event => {
        const recipe = event.target.result;
        if (!recipe || !withSource) { done(recipe || null); return; }
        sources.get(recipe.id).onsuccess = event => done({ ...recipe, blob: event.target.result });
      };
    });
  }
  function save(recipe, blob) {
    // Recipes contain plain JSON fields; the source Blob is stored separately.
    // Snapshot now so later slider/undo mutations cannot alter a queued write.
    const copy = typeof global.structuredClone === 'function'
      ? global.structuredClone(recipe) : JSON.parse(JSON.stringify(recipe));
    return enqueue(async () => {
      if (!blob) throw new Error('The image source is unavailable.');
      const db = await database();
      await transaction(db, 'readwrite', (recipes, sources) => {
        recipes.get(copy.variant).onsuccess = event => {
          const previous = event.target.result;
          if (previous?.id !== copy.id) {
            sources.put(blob, copy.id);
            if (previous) sources.delete(previous.id);
          }
          recipes.put(copy, copy.variant);
        };
      });
      document.dispatchEvent(new Event('memo:image-draft-changed'));
    });
  }
  function clear(variant, id) {
    return enqueue(async () => {
      const db = await database();
      await transaction(db, 'readwrite', (recipes, sources) => {
        recipes.get(variant).onsuccess = event => {
          const previous = event.target.result;
          // A delayed export cannot delete a newer editing session.
          if (!previous || (id && previous.id !== id)) return;
          recipes.delete(variant); sources.delete(previous.id);
        };
      });
      document.dispatchEvent(new Event('memo:image-draft-changed'));
    });
  }
  global.MemoImageDraft = { read, save, clear, settled: () => pending };
})(window);
