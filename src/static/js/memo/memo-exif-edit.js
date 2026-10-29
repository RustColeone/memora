// memo-exif-edit.js — read and rewrite embedded EXIF in JPEG bytes.
//
// Privacy-first scope: strip GPS (location) + device identity, and edit a few
// text fields (Artist / Copyright / Description / DateTime). All OTHER tags are
// preserved verbatim. The source TIFF byte order is retained and preserved tag
// values are copied byte-for-byte. XMP (APP1) and IPTC (APP13) are left alone.
(function (global) {
  'use strict';

  var TAG = {
    IMAGE_DESCRIPTION: 0x010e,
    MAKE: 0x010f,
    MODEL: 0x0110,
    ORIENTATION: 0x0112,
    SOFTWARE: 0x0131,
    DATETIME: 0x0132,
    ARTIST: 0x013b,
    COPYRIGHT: 0x8298,
    EXIF_IFD_PTR: 0x8769,
    GPS_IFD_PTR: 0x8825
  };
  var DEVICE_TAGS_IFD0 = new Set([TAG.MAKE, TAG.MODEL, TAG.SOFTWARE]);
  var DEVICE_TAGS_EXIF = new Set([
    0xa430, // camera owner
    0xa431, // body serial
    0xa435, // lens serial
    0xc62f, // raw camera serial
    0xa433  // lens make
  ]);
  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };
  var BACKUP_MAGIC = [0x4d, 0x45, 0x58, 0x42]; // "MEXB"
  var BACKUP_VERSION = 1;

  function isJpeg(bytes) {
    return !!(bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8);
  }

  function u16be(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function findExifApp1(bytes) {
    if (!isJpeg(bytes)) return null;
    var offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      var marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) return null; // SOS / EOI
      var length = u16be(bytes, offset + 2);
      if (length < 2) return null;
      var segmentEnd = offset + 2 + length;
      if (segmentEnd > bytes.length) return null;
      if (marker === 0xe1) {
        var payload = offset + 4;
        if (payload + 6 <= segmentEnd
            && bytes[payload] === 0x45 && bytes[payload + 1] === 0x78
            && bytes[payload + 2] === 0x69 && bytes[payload + 3] === 0x66
            && bytes[payload + 4] === 0 && bytes[payload + 5] === 0) {
          return { segStart: offset, segEnd: segmentEnd, tiffStart: payload + 6 };
        }
      }
      offset = segmentEnd;
    }
    return null;
  }

  // Parse IFD0 + Exif/GPS sub-IFDs into ordered entry lists. Each entry keeps
  // its dereferenced raw bytes so preserved values can be emitted untouched.
  function parseTiff(bytes, tiffStart, tiffEnd) {
    tiffEnd = Math.min(Number.isFinite(tiffEnd) ? tiffEnd : bytes.length, bytes.length);
    if (tiffStart + 8 > tiffEnd) return null;
    var little = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
    var big = bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d;
    if (!little && !big) return null;
    function rd16(offset) {
      return little
        ? (bytes[offset] | (bytes[offset + 1] << 8))
        : ((bytes[offset] << 8) | bytes[offset + 1]);
    }
    function rd32(offset) {
      return (little
        ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000))
        : (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3])) >>> 0;
    }
    if (rd16(tiffStart + 2) !== 42) return null;

    function readIfd(relativeOffset) {
      var base = tiffStart + relativeOffset;
      if (base < tiffStart || base + 2 > tiffEnd) return null;
      var count = rd16(base);
      if (base + 2 + count * 12 + 4 > tiffEnd) return null;
      var entries = [];
      for (var index = 0; index < count; index++) {
        var entryOffset = base + 2 + index * 12;
        var tag = rd16(entryOffset);
        var type = rd16(entryOffset + 2);
        var itemCount = rd32(entryOffset + 4);
        var unitSize = TYPE_SIZE[type];
        if (!unitSize || itemCount > Math.floor((tiffEnd - tiffStart) / unitSize)) return null;
        var size = unitSize * itemCount;
        var valueOffset = size <= 4 ? entryOffset + 8 : tiffStart + rd32(entryOffset + 8);
        if (valueOffset < tiffStart || valueOffset + size > tiffEnd) return null;
        entries.push({
          tag: tag,
          type: type,
          count: itemCount,
          value: bytes.slice(valueOffset, valueOffset + size)
        });
      }
      return entries;
    }

    var ifd0 = readIfd(rd32(tiffStart + 4));
    if (!ifd0) return null;
    function bytesToU32(value) {
      if (!value || value.length < 4) return 0;
      return (little
        ? (value[0] | (value[1] << 8) | (value[2] << 16) | (value[3] * 0x1000000))
        : (value[0] * 0x1000000 + (value[1] << 16) + (value[2] << 8) + value[3])) >>> 0;
    }
    var exifPointer = ifd0.find(function (entry) { return entry.tag === TAG.EXIF_IFD_PTR; });
    var gpsPointer = ifd0.find(function (entry) { return entry.tag === TAG.GPS_IFD_PTR; });
    var exif = exifPointer ? readIfd(bytesToU32(exifPointer.value)) : null;
    var gps = gpsPointer ? readIfd(bytesToU32(gpsPointer.value)) : null;
    return { little: little, ifd0: ifd0, exif: exif, gps: gps, hasGps: !!gpsPointer };
  }

  function asciiValue(entry) {
    if (!entry || entry.type !== 2) return '';
    var value = '';
    for (var index = 0; index < entry.value.length; index++) {
      if (!entry.value[index]) break;
      value += String.fromCharCode(entry.value[index]);
    }
    return value.trim();
  }

  function readEmbedded(bytes) {
    var app1 = findExifApp1(bytes);
    if (!app1) return { hasExif: false, hasGps: false, hasDevice: false, fields: {}, other: 0 };
    var tiff = parseTiff(bytes, app1.tiffStart, app1.segEnd);
    if (!tiff) return { hasExif: false, hasGps: false, hasDevice: false, fields: {}, other: 0 };
    function get(tag) {
      return tiff.ifd0.find(function (entry) { return entry.tag === tag; });
    }
    var fields = {
      description: asciiValue(get(TAG.IMAGE_DESCRIPTION)),
      artist: asciiValue(get(TAG.ARTIST)),
      copyright: asciiValue(get(TAG.COPYRIGHT)),
      dateTime: asciiValue(get(TAG.DATETIME)),
      make: asciiValue(get(TAG.MAKE)),
      model: asciiValue(get(TAG.MODEL)),
      software: asciiValue(get(TAG.SOFTWARE))
    };
    var deviceCount = [TAG.MAKE, TAG.MODEL, TAG.SOFTWARE].filter(function (tag) { return !!get(tag); }).length;
    if (tiff.exif) {
      deviceCount += tiff.exif.filter(function (entry) { return DEVICE_TAGS_EXIF.has(entry.tag); }).length;
    }
    return {
      hasExif: true,
      hasGps: tiff.hasGps,
      hasDevice: deviceCount > 0,
      fields: fields,
      ifd0Count: tiff.ifd0.length,
      exifCount: tiff.exif ? tiff.exif.length : 0
    };
  }

  function buildApp1(little, ifd0Base, subIfds) {
    function w16(value) {
      return little ? [value & 0xff, (value >> 8) & 0xff] : [(value >> 8) & 0xff, value & 0xff];
    }
    function w32(value) {
      return little
        ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
        : [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    }
    function sortByTag(entries) {
      return entries.slice().sort(function (a, b) { return a.tag - b.tag; });
    }
    function blockSize(entries) { return 2 + entries.length * 12 + 4; }
    function bigSize(entries) {
      return entries.reduce(function (sum, entry) {
        return sum + (entry.value.length > 4 ? entry.value.length + (entry.value.length & 1) : 0);
      }, 0);
    }

    subIfds = (subIfds || []).filter(function (item) { return item.entries && item.entries.length; });
    var ifd0 = sortByTag(ifd0Base.concat(subIfds.map(function (item) {
      return { tag: item.ptrTag, type: 4, count: 1, value: new Uint8Array([0, 0, 0, 0]) };
    })));

    var headerSize = 8;
    var ifd0Big = headerSize + blockSize(ifd0);
    var cursor = ifd0Big + bigSize(ifd0);
    subIfds.forEach(function (item) {
      item.start = cursor;
      item.entries = sortByTag(item.entries);
      cursor += blockSize(item.entries) + bigSize(item.entries);
    });
    subIfds.forEach(function (item) {
      var pointer = ifd0.find(function (entry) { return entry.tag === item.ptrTag; });
      pointer.value = new Uint8Array(w32(item.start));
    });

    function emitIfd(entries, bigStart) {
      var head = [];
      var overflow = [];
      var bigCursor = bigStart;
      head.push.apply(head, w16(entries.length));
      entries.forEach(function (entry) {
        head.push.apply(head, w16(entry.tag));
        head.push.apply(head, w16(entry.type));
        head.push.apply(head, w32(entry.count));
        if (entry.value.length <= 4) {
          head.push(entry.value[0] || 0, entry.value[1] || 0, entry.value[2] || 0, entry.value[3] || 0);
        } else {
          head.push.apply(head, w32(bigCursor));
          for (var index = 0; index < entry.value.length; index++) overflow.push(entry.value[index]);
          if (entry.value.length & 1) overflow.push(0);
          bigCursor += entry.value.length + (entry.value.length & 1);
        }
      });
      head.push.apply(head, w32(0));
      return { head: head, overflow: overflow };
    }

    var parts = [little ? 0x49 : 0x4d, little ? 0x49 : 0x4d];
    parts.push.apply(parts, w16(42));
    parts.push.apply(parts, w32(headerSize));
    var ifd0Output = emitIfd(ifd0, ifd0Big);
    parts.push.apply(parts, ifd0Output.head);
    parts.push.apply(parts, ifd0Output.overflow);
    subIfds.forEach(function (item) {
      var output = emitIfd(item.entries, item.start + blockSize(item.entries));
      parts.push.apply(parts, output.head);
      parts.push.apply(parts, output.overflow);
    });

    var tiff = new Uint8Array(parts);
    var exifHeader = [0x45, 0x78, 0x69, 0x66, 0, 0];
    var payloadLength = exifHeader.length + tiff.length;
    var segmentLength = payloadLength + 2;
    if (segmentLength > 0xffff) {
      throw new RangeError('The rewritten EXIF segment is too large for a JPEG APP1 segment.');
    }
    var app1 = new Uint8Array(4 + payloadLength);
    app1[0] = 0xff;
    app1[1] = 0xe1;
    app1[2] = (segmentLength >> 8) & 0xff;
    app1[3] = segmentLength & 0xff;
    app1.set(exifHeader, 4);
    app1.set(tiff, 4 + exifHeader.length);
    return app1;
  }

  // Return NEW JPEG bytes with the requested edits. Empty text clears its tag.
  // Other EXIF tags, XMP, IPTC and the compressed pixels are preserved.
  function writeEmbedded(bytes, edits) {
    edits = edits || {};
    if (!isJpeg(bytes)) return null;
    var app1 = findExifApp1(bytes);
    var parsed = app1 ? parseTiff(bytes, app1.tiffStart, app1.segEnd) : null;
    var little = parsed ? parsed.little : true;
    var ifd0 = parsed
      ? parsed.ifd0.filter(function (entry) { return entry.tag !== TAG.GPS_IFD_PTR && entry.tag !== TAG.EXIF_IFD_PTR; })
      : [];
    // MakerNote + Interop embed TIFF-relative offsets that become invalid after
    // relocation. MakerNotes also often carry serial/device identity.
    var exif = parsed && parsed.exif
      ? parsed.exif.filter(function (entry) { return entry.tag !== 0x927c && entry.tag !== 0xa005; })
      : null;
    var gps = (!edits.stripGps && parsed && parsed.gps) ? parsed.gps.slice() : null;

    if (edits.stripDevice) {
      ifd0 = ifd0.filter(function (entry) { return !DEVICE_TAGS_IFD0.has(entry.tag); });
      if (exif) exif = exif.filter(function (entry) { return !DEVICE_TAGS_EXIF.has(entry.tag); });
    }
    function setText(tag, value) {
      ifd0 = ifd0.filter(function (entry) { return entry.tag !== tag; });
      if (value !== null && value !== undefined && String(value).length) {
        var encoded = new TextEncoder().encode(String(value).replace(/\0/g, '') + '\0');
        ifd0.push({ tag: tag, type: 2, count: encoded.length, value: encoded });
      }
    }
    if (Object.prototype.hasOwnProperty.call(edits, 'description')) setText(TAG.IMAGE_DESCRIPTION, edits.description);
    if (Object.prototype.hasOwnProperty.call(edits, 'artist')) setText(TAG.ARTIST, edits.artist);
    if (Object.prototype.hasOwnProperty.call(edits, 'copyright')) setText(TAG.COPYRIGHT, edits.copyright);
    if (Object.prototype.hasOwnProperty.call(edits, 'dateTime')) setText(TAG.DATETIME, edits.dateTime);

    var subIfds = [];
    if (exif && exif.length) subIfds.push({ ptrTag: TAG.EXIF_IFD_PTR, entries: exif });
    if (gps && gps.length) subIfds.push({ ptrTag: TAG.GPS_IFD_PTR, entries: gps });
    return spliceApp1(bytes, app1, buildApp1(little, ifd0, subIfds));
  }

  function spliceApp1(bytes, oldApp1, newApp1) {
    var before = bytes.slice(0, 2);
    var rest;
    if (oldApp1) {
      rest = concat(bytes.slice(2, oldApp1.segStart), bytes.slice(oldApp1.segEnd));
    } else {
      rest = bytes.slice(2);
    }
    return concat(before, newApp1, rest);
  }

  function concat() {
    var arrays = Array.prototype.slice.call(arguments);
    var size = arrays.reduce(function (sum, array) { return sum + array.length; }, 0);
    var output = new Uint8Array(size);
    var offset = 0;
    arrays.forEach(function (array) { output.set(array, offset); offset += array.length; });
    return output;
  }

  function matches(bytes, at, signature) {
    if (at < 0 || at + signature.length > bytes.length) return false;
    for (var index = 0; index < signature.length; index++) {
      if (bytes[at + index] !== signature[index]) return false;
    }
    return true;
  }

  function matchesString(bytes, at, value) {
    if (at < 0 || at + value.length > bytes.length) return false;
    for (var index = 0; index < value.length; index++) {
      if (bytes[at + index] !== value.charCodeAt(index)) return false;
    }
    return true;
  }

  function pushU32be(output, value) {
    output.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  function readU32be(bytes, offset) {
    return (bytes[offset] * 0x1000000
      + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8)
      + bytes[offset + 3]) >>> 0;
  }

  function encodeMetadataBackup(records) {
    var output = BACKUP_MAGIC.concat([BACKUP_VERSION]);
    pushU32be(output, records.length);
    records.forEach(function (record) {
      pushU32be(output, record.position);
      pushU32be(output, record.bytes.length);
      for (var index = 0; index < record.bytes.length; index++) output.push(record.bytes[index]);
    });
    return new Uint8Array(output);
  }

  function decodeMetadataBackup(backup) {
    if (!backup || backup.length < BACKUP_MAGIC.length
        || !matches(backup, 0, BACKUP_MAGIC)) return null;
    if (backup.length < 9 || backup[4] !== BACKUP_VERSION) return { invalid: true };
    var count = readU32be(backup, 5);
    var offset = 9;
    var records = [];
    for (var index = 0; index < count; index++) {
      if (offset + 8 > backup.length) return { invalid: true };
      var position = readU32be(backup, offset);
      var length = readU32be(backup, offset + 4);
      offset += 8;
      if (length < 4 || offset + length > backup.length) return { invalid: true };
      var segment = backup.slice(offset, offset + length);
      if (segment[0] !== 0xff || u16be(segment, 2) + 2 !== segment.length
          || !isMetadataSegment(segment, 0)) return { invalid: true };
      records.push({ position: position, bytes: segment });
      offset += length;
    }
    if (offset !== backup.length) return { invalid: true };
    return { records: records };
  }

  // Capture original EXIF APP1 + XMP APP1 + IPTC APP13 segments together with
  // their marker-order positions. Versioned placement data lets revert rebuild
  // the exact original JPEG header instead of moving every segment after SOI.
  function captureMetadataSegments(bytes) {
    if (!isJpeg(bytes)) return null;
    var records = [];
    var offset = 2;
    var segmentIndex = 0;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      var marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      var length = u16be(bytes, offset + 2);
      if (length < 2) break;
      var segmentEnd = offset + 2 + length;
      if (segmentEnd > bytes.length) break;
      var isExif = marker === 0xe1 && matches(bytes, offset + 4, [0x45, 0x78, 0x69, 0x66, 0, 0]);
      var isXmp = marker === 0xe1 && matchesString(bytes, offset + 4, 'http://ns.adobe.com/xap/1.0/');
      var isIptc = marker === 0xed;
      if (isExif || isXmp || isIptc) {
        records.push({ position: segmentIndex, bytes: bytes.slice(offset, segmentEnd) });
      }
      offset = segmentEnd;
      segmentIndex++;
    }
    return encodeMetadataBackup(records);
  }

  function isMetadataSegment(bytes, offset) {
    var marker = bytes[offset + 1];
    return (marker === 0xe1
      && (matches(bytes, offset + 4, [0x45, 0x78, 0x69, 0x66, 0, 0])
        || matchesString(bytes, offset + 4, 'http://ns.adobe.com/xap/1.0/')))
      || marker === 0xed;
  }

  // Drop current EXIF/XMP/IPTC and reinsert the captured original segments.
  // New backups carry original marker positions. Legacy backups were raw
  // concatenated metadata segments (including an empty array for "none") and
  // remain supported by inserting them immediately after SOI.
  function restoreMetadataSegments(bytes, backup) {
    if (!isJpeg(bytes)) return null;
    var decoded = decodeMetadataBackup(backup);
    if (decoded && decoded.invalid) return null;
    var keep = [];
    var tail = new Uint8Array(0);
    var offset = 2;
    while (offset < bytes.length) {
      if (offset + 4 > bytes.length || bytes[offset] !== 0xff) {
        tail = bytes.slice(offset);
        break;
      }
      var marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) {
        tail = bytes.slice(offset);
        break;
      }
      var length = u16be(bytes, offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) {
        tail = bytes.slice(offset);
        break;
      }
      var segmentEnd = offset + 2 + length;
      if (!isMetadataSegment(bytes, offset)) keep.push(bytes.slice(offset, segmentEnd));
      offset = segmentEnd;
    }
    if (decoded) {
      var restored = keep.slice();
      for (var recordIndex = 0; recordIndex < decoded.records.length; recordIndex++) {
        var record = decoded.records[recordIndex];
        if (record.position > restored.length) return null;
        restored.splice(record.position, 0, record.bytes);
      }
      var positioned = [bytes.slice(0, 2)].concat(restored, [tail]);
      return concat.apply(null, positioned);
    }
    var arrays = [bytes.slice(0, 2), backup || new Uint8Array(0)].concat(keep, [tail]);
    return concat.apply(null, arrays);
  }

  global.MemoExifEdit = {
    isJpeg: isJpeg,
    readEmbedded: readEmbedded,
    writeEmbedded: writeEmbedded,
    captureMetadataSegments: captureMetadataSegments,
    restoreMetadataSegments: restoreMetadataSegments
  };
})(window);
