// memo-backup.js — size-based, multi-part backup packing for offline data
// protection.
//
// The core idea: pack by SIZE, not by date. Entries are sorted oldest→newest
// and greedily binned into parts purely by accumulated blob bytes. A part keeps
// absorbing entries until the next one would push it past the cap, at which
// point it "spills" into a new part. So one 9 GB month splits across many parts
// while several small months share one part — which is the whole point when a
// library has no sync server and a single ZIP would be too big to build in
// phone memory.
//
// Each part is written STORED (already-compressed images), sized against the
// same byte budget it was packed against, and carries its own self-contained
// memosystem.json envelope + uploads/ blobs, so ANY single part imports on its
// own. Because parts are packed by size, their date ranges can overlap across
// re-exports; import dedups by entry id, so overlapping parts are harmless.
(function (global) {
  'use strict';

  // JSZip keeps each selected archive in memory and expands members on demand.
  // Inspect the central directory before handing it to JSZip so hostile paths,
  // oversized members, and tiny high-ratio archives cannot reach extraction or
  // mutate local storage. These limits mirror the hardened ImageDB importer.
  var MIB = 1024 * 1024;
  var MAX_IMPORT_ARCHIVE_BYTES = 128 * MIB;
  var MAX_IMPORT_EXPANDED_BYTES = 144 * MIB;
  var MAX_IMPORT_MEMBER_BYTES = 96 * MIB;
  var MAX_IMPORT_JSON_BYTES = 16 * MIB;
  var MAX_IMPORT_ZIP_MEMBERS = 20000;
  var MAX_IMPORT_COMPRESSION_RATIO = 200;
  var MAX_IMPORT_FILENAME_BYTES = 1024;
  var BACKUP_SET_MANIFEST_FILE = 'memosystem-backup.json';

  // Per-part byte budget. A part is zipped in memory before it is written, so
  // this bounds peak memory use. Module-level `let` so a stress test can force
  // smaller splits. Keep normal parts below the importer whole-buffer ceiling.
  var EXPORT_PART_CAP_BYTES = 64 * MIB;

  function getPartCap() { return EXPORT_PART_CAP_BYTES; }
  function setPartCap(n) {
    if (typeof n === 'number' && isFinite(n) && n > 0) EXPORT_PART_CAP_BYTES = n;
    return EXPORT_PART_CAP_BYTES;
  }

  function zipUint16(view, offset) { return view.getUint16(offset, true); }
  function zipUint32(view, offset) { return view.getUint32(offset, true); }

  function inspectZipDirectory(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) throw new Error('Invalid or truncated ZIP');
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var min = Math.max(0, bytes.byteLength - 65557); // EOCD + maximum legal comment
    var eocd = -1;
    for (var search = bytes.byteLength - 22; search >= min; search--) {
      if (zipUint32(view, search) === 0x06054b50
          && search + 22 + zipUint16(view, search + 20) === bytes.byteLength) {
        eocd = search;
        break;
      }
    }
    if (eocd < 0) throw new Error('ZIP central directory not found');

    var disk = zipUint16(view, eocd + 4);
    var centralDisk = zipUint16(view, eocd + 6);
    var entriesOnDisk = zipUint16(view, eocd + 8);
    var entryCount = zipUint16(view, eocd + 10);
    var centralSize = zipUint32(view, eocd + 12);
    var centralOffset = zipUint32(view, eocd + 16);
    if (disk || centralDisk || entriesOnDisk !== entryCount) throw new Error('Multi-disk ZIPs are not supported');
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported');
    }
    if (entryCount > MAX_IMPORT_ZIP_MEMBERS) {
      throw new Error('ZIP contains too many files (' + entryCount + '; limit ' + MAX_IMPORT_ZIP_MEMBERS + ')');
    }
    if (centralOffset + centralSize > eocd) throw new Error('Invalid ZIP central-directory bounds');

    var decoder = new TextDecoder();
    var members = new Map();
    var totalExpanded = 0;
    var pos = centralOffset;
    for (var index = 0; index < entryCount; index++) {
      if (pos + 46 > eocd || zipUint32(view, pos) !== 0x02014b50) {
        throw new Error('Invalid ZIP central-directory entry');
      }
      var flags = zipUint16(view, pos + 8);
      var method = zipUint16(view, pos + 10);
      var compressed = zipUint32(view, pos + 20);
      var expanded = zipUint32(view, pos + 24);
      var nameLength = zipUint16(view, pos + 28);
      var extraLength = zipUint16(view, pos + 30);
      var memberCommentLength = zipUint16(view, pos + 32);
      var memberDisk = zipUint16(view, pos + 34);
      var recordEnd = pos + 46 + nameLength + extraLength + memberCommentLength;
      if (recordEnd > eocd || nameLength === 0 || nameLength > MAX_IMPORT_FILENAME_BYTES) {
        throw new Error('Invalid ZIP filename record');
      }
      if (memberDisk) throw new Error('Multi-disk ZIPs are not supported');
      if (flags & 1) throw new Error('Encrypted ZIPs are not supported');
      if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression method: ' + method);
      if (compressed === 0xffffffff || expanded === 0xffffffff) throw new Error('ZIP64 members are not supported');

      var nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLength);
      var name = (flags & 0x800) ? decoder.decode(nameBytes) : String.fromCharCode.apply(null, nameBytes);
      var segments = name.replace(/\\/g, '/').split('/');
      if (!name || name.indexOf('\0') >= 0 || name.charAt(0) === '/' || name.indexOf('\\') >= 0
          || segments.some(function (segment) { return segment === '..'; })) {
        throw new Error('Unsafe ZIP path: ' + (name || '(empty)'));
      }
      if (members.has(name)) throw new Error('Duplicate ZIP member: ' + name);
      if (expanded > MAX_IMPORT_MEMBER_BYTES) {
        throw new Error('ZIP member is too large: ' + name + ' (' + Math.ceil(expanded / MIB) + ' MiB)');
      }
      if (expanded > MIB && (compressed === 0 || expanded / compressed > MAX_IMPORT_COMPRESSION_RATIO)) {
        throw new Error('ZIP member has an unsafe compression ratio: ' + name);
      }
      totalExpanded += expanded;
      if (totalExpanded > MAX_IMPORT_EXPANDED_BYTES) {
        throw new Error('ZIP expands beyond the ' + (MAX_IMPORT_EXPANDED_BYTES / MIB) + ' MiB safety limit');
      }
      members.set(name, { compressed: compressed, expanded: expanded, directory: /\/$/.test(name) });
      pos = recordEnd;
    }
    if (pos !== centralOffset + centralSize) throw new Error('Unsupported data in ZIP central directory');
    var envelope = members.get('memosystem.json');
    if (envelope && envelope.expanded > MAX_IMPORT_JSON_BYTES) {
      throw new Error('memosystem.json exceeds the ' + (MAX_IMPORT_JSON_BYTES / MIB) + ' MiB safety limit');
    }
    var manifest = members.get(BACKUP_SET_MANIFEST_FILE);
    if (manifest && manifest.expanded > 2 * MIB) throw new Error('Backup-set manifest is unexpectedly large');
    return { members: members, totalExpanded: totalExpanded };
  }

  async function preflightImportFile(file) {
    var declaredSize = Number(file && file.size);
    if (isFinite(declaredSize) && declaredSize > MAX_IMPORT_ARCHIVE_BYTES) {
      throw new Error('ZIP is too large (' + Math.ceil(declaredSize / MIB) + ' MiB; limit '
        + (MAX_IMPORT_ARCHIVE_BYTES / MIB) + ' MiB)');
    }
    var buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_IMPORT_ARCHIVE_BYTES) {
      throw new Error('ZIP is too large (' + Math.ceil(buffer.byteLength / MIB) + ' MiB; limit '
        + (MAX_IMPORT_ARCHIVE_BYTES / MIB) + ' MiB)');
    }
    var bytes = new Uint8Array(buffer);
    inspectZipDirectory(bytes);
    return bytes;
  }

  async function sha256Bytes(bytes) {
    if (!(global.crypto && global.crypto.subtle)) throw new Error('SHA-256 is unavailable in this browser');
    var digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.prototype.map.call(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function validateBackupSetManifest(manifest) {
    if (!manifest || manifest.type !== 'memosystem-backup-set' || manifest.version !== 1
        || typeof manifest.id !== 'string' || !manifest.id || !Array.isArray(manifest.parts)
        || !manifest.parts.length || typeof manifest.full_library !== 'boolean') {
      throw new Error('Invalid MemoSystem backup-set manifest');
    }
    if (manifest.parts.length > MAX_IMPORT_ZIP_MEMBERS) throw new Error('Backup-set manifest contains too many parts');
    var seen = new Set();
    manifest.parts.forEach(function (part, index) {
      if (!part || typeof part.name !== 'string' || !part.name || /[\\/\0]/.test(part.name)
          || seen.has(part.name) || !/^[a-f0-9]{64}$/i.test(part.sha256 || '')
          || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > MAX_IMPORT_ARCHIVE_BYTES
          || !Number.isSafeInteger(part.part) || part.part !== index + 1) {
        throw new Error('Invalid part record in MemoSystem backup-set manifest');
      }
      seen.add(part.name);
    });
    var counts = manifest.counts;
    if (!counts || ['memos', 'finance', 'planner'].some(function (key) {
      return !Number.isSafeInteger(counts[key]) || counts[key] < 0;
    })) throw new Error('Invalid counts in MemoSystem backup-set manifest');
    return manifest;
  }

  async function readBackupSetManifest(file, JSZipCtor) {
    if (!file || file.size > 2 * MIB) throw new Error('Backup-set manifest archive is unexpectedly large');
    var bytes = await preflightImportFile(file);
    var zip = await JSZipCtor.loadAsync(bytes);
    var names = Object.keys(zip.files).filter(function (name) { return !zip.files[name].dir; });
    if (names.length !== 1 || names[0] !== BACKUP_SET_MANIFEST_FILE) {
      throw new Error('Invalid MemoSystem backup-set manifest archive');
    }
    var manifest;
    try { manifest = JSON.parse(await zip.file(BACKUP_SET_MANIFEST_FILE).async('string')); }
    catch (error) { throw new Error('Invalid backup-set manifest JSON: ' + error.message); }
    return validateBackupSetManifest(manifest);
  }

  async function preflightBackupSetSelection(files, JSZipCtor) {
    var selected = Array.prototype.slice.call(files || []);
    var manifests = selected.filter(function (file) { return /memoSystem-backup-00_manifest_/i.test(file.name || ''); });
    if (!manifests.length) return { dataFiles: selected, manifest: null };
    if (manifests.length !== 1) throw new Error('Select only one MemoSystem backup-set manifest');
    var manifestFile = manifests[0];
    var manifest = await readBackupSetManifest(manifestFile, JSZipCtor);
    var dataFiles = selected.filter(function (file) { return file !== manifestFile; });
    var byName = new Map();
    dataFiles.forEach(function (file) {
      if (byName.has(file.name)) throw new Error('Duplicate selected backup part: ' + file.name);
      byName.set(file.name, file);
    });
    var expectedNames = new Set(manifest.parts.map(function (part) { return part.name; }));
    var unexpected = dataFiles.find(function (file) { return !expectedNames.has(file.name); });
    if (unexpected) throw new Error('Selected ZIP is not part of this backup set: ' + unexpected.name);
    var missing = manifest.parts.filter(function (part) { return !byName.has(part.name); });
    if (missing.length) {
      throw new Error('Backup set is incomplete; missing ' + missing.length + ' part(s), starting with ' + missing[0].name);
    }

    // Verify all bytes and the embedded set identity before the first part is
    // allowed to mutate blobs or metadata. Process one file at a time so memory
    // remains bounded by the per-archive limit.
    for (var i = 0; i < manifest.parts.length; i++) {
      var record = manifest.parts[i];
      var file = byName.get(record.name);
      if (file.size !== record.bytes) throw new Error('Backup part size mismatch: ' + record.name);
      var bytes = await preflightImportFile(file);
      if (await sha256Bytes(bytes) !== record.sha256.toLowerCase()) {
        throw new Error('Backup part checksum failed: ' + record.name);
      }
      var zip = await JSZipCtor.loadAsync(bytes);
      var envelopeFile = zip.file('memosystem.json');
      if (!envelopeFile) throw new Error('Backup part has no memosystem.json envelope: ' + record.name);
      var envelope;
      try { envelope = JSON.parse(await envelopeFile.async('string')); }
      catch (error) { throw new Error('Invalid memosystem.json in ' + record.name + ': ' + error.message); }
      var set = envelope && envelope.backup_set;
      if (!set || set.id !== manifest.id || set.part !== record.part || set.parts !== manifest.parts.length) {
        throw new Error('Backup part identity does not match the selected manifest: ' + record.name);
      }
    }
    return {
      dataFiles: manifest.parts.map(function (part) { return byName.get(part.name); }),
      manifest: manifest
    };
  }

  // A stored blob lives app-private under a stable "uploads/<date>/<file>" rel
  // path. Linked/remote (http/https), ephemeral (blob:) and inline (data:)
  // URLs have no local bytes — they contribute 0 to the cap and are skipped.
  function toRel(u) {
    if (!u) return null;
    u = String(u);
    if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) return null;
    if (/^https?:\/\//i.test(u)) return null;
    var stripped = u.replace(/^\//, '');
    if (stripped.indexOf('uploads/') !== 0) return null;
    return stripped;
  }

  // Every stored-blob rel path an entry references (images + attachments),
  // de-duplicated in reference order.
  function collectEntryRels(entry) {
    var out = [];
    var seen = Object.create(null);
    function push(u) {
      var r = toRel(u);
      if (r && !seen[r]) { seen[r] = 1; out.push(r); }
    }
    var stored = Array.isArray(entry && entry._storedPaths) ? entry._storedPaths : null;
    var imgs = stored || (Array.isArray(entry && entry.images) ? entry.images : []);
    imgs.forEach(push);
    (Array.isArray(entry && entry.attachments) ? entry.attachments : []).forEach(function (a) {
      push(a && typeof a === 'object' ? (a.storedPath || a.url) : a);
    });
    return out;
  }

  // Greedy size packer. `items`: [{ ts, bytes, ... }]. Sorts oldest→newest,
  // then fills a part until the NEXT item would exceed `cap`, spilling into a
  // fresh part at that point.
  //
  // The `curBytes > 0 &&` guard is the forward-progress guarantee: the first
  // item always lands in the current part even if it alone exceeds the cap, so
  // there are never empty parts and never an infinite spill. Returns an array
  // of parts, each an array of the original item objects (input untouched).
  function planParts(items, cap) {
    cap = (typeof cap === 'number' && cap > 0) ? cap : EXPORT_PART_CAP_BYTES;
    var sorted = (items || []).slice().sort(function (a, b) {
      return (a.ts || 0) - (b.ts || 0);
    });
    var parts = [];
    var cur = [];
    var curBytes = 0;
    for (var i = 0; i < sorted.length; i++) {
      var add = sorted[i].bytes || 0;
      if (curBytes > 0 && curBytes + add > cap) {
        parts.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(sorted[i]);
      curBytes += add;
    }
    if (cur.length) parts.push(cur);
    return parts;
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }
  function dateOf(ts) {
    var d = new Date(typeof ts === 'number' ? ts : Date.now());
    if (isNaN(d.getTime())) d = new Date();
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  // Named by the actual min/max timestamps in the part, 1-based and
  // zero-padded so a lexical sort matches export order:
  //   memoSystem-backup-01_<earliest>_<latest>.zip
  function partName(index, minTs, maxTs, setToken) {
    var token = setToken ? String(setToken).replace(/[^a-z0-9]/gi, '').slice(0, 16) + '-' : '';
    return 'memoSystem-backup-' + token + two(index) + '_' + dateOf(minTs) + '_' + dateOf(maxTs) + '.zip';
  }

  global.MemoBackup = {
    getPartCap: getPartCap,
    setPartCap: setPartCap,
    toRel: toRel,
    collectEntryRels: collectEntryRels,
    planParts: planParts,
    dateOf: dateOf,
    partName: partName,
    inspectZipDirectory: inspectZipDirectory,
    preflightImportFile: preflightImportFile,
    preflightBackupSetSelection: preflightBackupSetSelection,
    sha256Bytes: sha256Bytes,
    manifestFile: BACKUP_SET_MANIFEST_FILE,
    getMaxImportMemberBytes: function () { return MAX_IMPORT_MEMBER_BYTES; }
  };
})(window);
