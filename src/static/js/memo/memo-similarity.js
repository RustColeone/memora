// memo-similarity.js — on-device image embeddings for Find similar, duplicate
// review and similar-photo cleanup. Ported from ImageDB's similarity-index.js
// (same shard format).
//
// Each analyzed image has a 1024-value, L2-normalized embedding quantized to
// int8 (1 KiB), keyed by its stored path. Embeddings are derived data kept out
// of the SQLite working copy (which Memora holds in memory): they live in 16
// small shard files under MemoSystem/index/ on the phone, are loaded on first
// use, and are rebuilt by auto-organize if a shard is lost. They are never
// synced or put in a backup.
(function (global) {
  'use strict';
  const DIM = 1024;
  const SHARDS = 16;
  const MAGIC = 'IDBEMB1\0';
  const SUBDIR = 'index';
  const FLUSH_DELAY_MS = 4000;
  const RETRY_DELAY_MS = 15000;
  const vectors = new Map(); // stored path -> Int8Array(DIM)
  const dirty = new Set();
  let loadPromise = null;
  let loaded = false;
  let flushTimer = 0;
  let flushChain = Promise.resolve();

  function shardOf(blobId) {
    let hash = 5381;
    for (let index = 0; index < blobId.length; index++) hash = ((hash * 33) ^ blobId.charCodeAt(index)) >>> 0;
    return hash % SHARDS;
  }

  function shardName(shard) {
    return `emb1-${shard.toString(16)}.bin`;
  }

  // Shards are app files on the phone (the analysis itself only runs there).
  function persistent() {
    return !!global.Capacitor?.isNativePlatform?.() && !!global.MemoStateDb?.writeBlob;
  }
  const shardPath = shard => SUBDIR + '/' + shardName(shard);

  function decodeBase64(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const binary = atob(value);
      if (binary.length !== DIM) return null;
      const out = new Int8Array(DIM);
      for (let index = 0; index < DIM; index++) out[index] = (binary.charCodeAt(index) << 24) >> 24;
      return out;
    } catch { return null; }
  }

  function serialize(shard) {
    const encoder = new TextEncoder();
    const records = [];
    let size = MAGIC.length + 2;
    for (const [blobId, vector] of vectors) {
      if (shardOf(blobId) !== shard) continue;
      const id = encoder.encode(blobId);
      if (id.length > 255) continue;
      records.push([id, vector]);
      size += 1 + id.length + DIM;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (let index = 0; index < MAGIC.length; index++) bytes[offset++] = MAGIC.charCodeAt(index);
    bytes[offset++] = DIM & 0xff;
    bytes[offset++] = DIM >> 8;
    for (const [id, vector] of records) {
      bytes[offset++] = id.length;
      bytes.set(id, offset); offset += id.length;
      bytes.set(new Uint8Array(vector.buffer, vector.byteOffset, DIM), offset); offset += DIM;
    }
    return { bytes, count: records.length };
  }

  function parse(bytes, into) {
    if (bytes.length < MAGIC.length + 2) return;
    for (let index = 0; index < MAGIC.length; index++) if (bytes[index] !== MAGIC.charCodeAt(index)) return;
    if ((bytes[MAGIC.length] | (bytes[MAGIC.length + 1] << 8)) !== DIM) return;
    const decoder = new TextDecoder();
    let offset = MAGIC.length + 2;
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (!length || offset + length + DIM > bytes.length) break;
      const blobId = decoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
      into.set(blobId, new Int8Array(bytes.slice(offset, offset + DIM).buffer));
      offset += DIM;
    }
  }

  async function load() {
    if (loaded) return;
    if (!loadPromise) {
      loadPromise = (async () => {
        if (persistent()) {
          const found = new Map();
          for (let shard = 0; shard < SHARDS; shard++) {
            try {
              const blob = await global.MemoStateDb.readBlob(shardPath(shard));
              if (blob) parse(new Uint8Array(await blob.arrayBuffer()), found);
            } catch (error) {
              console.warn('[Similarity] shard unreadable; it will be rebuilt:', error);
            }
          }
          // Vectors written in this session before the load finished win.
          for (const [blobId, vector] of found) if (!vectors.has(blobId)) vectors.set(blobId, vector);
        }
        loaded = true;
      })().catch(error => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  }

  function scheduleFlush(delay = FLUSH_DELAY_MS) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { void flush(); }, delay);
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    flushChain = flushChain.then(async () => {
      if (!dirty.size || !persistent() || !loaded) return;
      const shards = [...dirty];
      dirty.clear();
      let failed = false;
      for (const shard of shards) {
        try {
          const { bytes, count } = serialize(shard);
          if (count) await global.MemoStateDb.writeBlob(shardPath(shard), new Blob([bytes], { type: 'application/octet-stream' }));
          else await global.MemoStateDb.deleteBlob(shardPath(shard));
        } catch (error) {
          dirty.add(shard);
          failed = true;
          console.warn('[Similarity] shard write failed; will retry:', error);
        }
      }
      // Retry on its own: otherwise a failed shard would wait for the next
      // new image and be lost if the app were closed first.
      if (failed) scheduleFlush(RETRY_DELAY_MS);
    }).catch(() => {});
    return flushChain;
  }

  async function put(blobId, base64) {
    const vector = decodeBase64(base64);
    if (!vector || typeof blobId !== 'string' || !blobId) return false;
    await load().catch(() => {});
    vectors.set(blobId, vector);
    dirty.add(shardOf(blobId));
    scheduleFlush();
    return true;
  }

  function remove(blobIds) {
    let changed = false;
    for (const blobId of blobIds || []) {
      if (vectors.delete(blobId)) { dirty.add(shardOf(blobId)); changed = true; }
    }
    if (changed) scheduleFlush();
  }

  // Drops vectors whose bytes are no longer stored (e.g. purged while the app was closed).
  function prune(liveBlobIds) {
    const live = liveBlobIds instanceof Set ? liveBlobIds : new Set(liveBlobIds);
    remove([...vectors.keys()].filter(blobId => !live.has(blobId)));
  }

  function dot(left, right) {
    let sum = 0;
    for (let index = 0; index < DIM; index++) sum += left[index] * right[index];
    return sum / (127 * 127);
  }

  // Cosine similarity of the quantized, normalized vectors, best first.
  async function similar(blobId, { candidates = null, limit = 60, minScore = 0.55 } = {}) {
    await load();
    const query = vectors.get(blobId);
    if (!query) return [];
    const out = [];
    const pool = candidates ? candidates : vectors.keys();
    for (const other of pool) {
      if (other === blobId) continue;
      const vector = vectors.get(other);
      if (!vector) continue;
      const score = dot(query, vector);
      if (score >= minScore) out.push({ blobId: other, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  async function clear() {
    vectors.clear();
    dirty.clear();
    clearTimeout(flushTimer);
    if (!persistent()) return;
    for (let shard = 0; shard < SHARDS; shard++) {
      try { await global.MemoStateDb.deleteBlob(shardPath(shard)); } catch (_) {}
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
  window.addEventListener('pagehide', () => { void flush(); });

  global.MemoSimilarity = {
    load,
    put,
    remove,
    prune,
    similar,
    flush,
    clear,
    has: blobId => vectors.has(blobId),
    vector: blobId => vectors.get(blobId) || null,
    size: () => vectors.size,
    loaded: () => loaded,
    dim: DIM,
  };
})(window);
