'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');

const context = {
  Uint8Array,
  TextEncoder,
  Set,
  Math,
  RangeError,
};
context.window = context;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'static', 'js', 'memo', 'memo-exif-edit.js'), 'utf8'),
  context,
  { filename: 'memo-exif-edit.js' },
);
const Exif = context.MemoExifEdit;

function concat(...arrays) {
  const size = arrays.reduce((sum, array) => sum + array.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  arrays.forEach((array) => { output.set(array, offset); offset += array.length; });
  return output;
}

function segment(marker, payload) {
  const length = payload.length + 2;
  return new Uint8Array([0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload]);
}

function ascii(value) {
  return new Uint8Array(Array.from(value, (char) => char.charCodeAt(0)));
}

const SOI = new Uint8Array([0xff, 0xd8]);
const APP0 = segment(0xe0, new Uint8Array([0x4a, 0x46, 0x49, 0x46]));
// The EXIF engine only rewrites marker segments before SOS; compressed scan
// bytes stay opaque, so this compact tail is sufficient for byte-level tests.
const SCAN = new Uint8Array([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
const bareJpeg = concat(SOI, APP0, SCAN);

assert.equal(Exif.isJpeg(bareJpeg), true);
assert.equal(Exif.writeEmbedded(new Uint8Array([1, 2, 3]), {}), null);

const edited = Exif.writeEmbedded(bareJpeg, {
  description: 'Workbench photo',
  artist: 'MemoSystem',
  copyright: '2026 Example',
  dateTime: '2026:08:02 14:30:00',
});
const info = Exif.readEmbedded(edited);
assert.equal(info.hasExif, true);
assert.equal(info.fields.description, 'Workbench photo');
assert.equal(info.fields.artist, 'MemoSystem');
assert.equal(info.fields.copyright, '2026 Example');
assert.equal(info.fields.dateTime, '2026:08:02 14:30:00');

// New backups use a versioned container even when the original had no embedded
// metadata, so revert can distinguish them from legacy raw-segment backups.
const bareBackup = Exif.captureMetadataSegments(bareJpeg);
assert.ok(bareBackup && bareBackup.length > 8);
assert.equal(String.fromCharCode(...bareBackup.slice(0, 4)), 'MEXB');
const restoredBare = Exif.restoreMetadataSegments(edited, bareBackup);
assert.deepEqual(Array.from(restoredBare), Array.from(bareJpeg));

// XMP and IPTC are not rewritten by a text edit, and a captured backup restores
// their original placement/bytes exactly after later edits.
const XMP = segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0xmp-payload'));
const IPTC = segment(0xed, ascii('Photoshop 3.0\0iptc-payload'));
const withSideMetadata = concat(SOI, XMP, IPTC, APP0, SCAN);
const backup = Exif.captureMetadataSegments(withSideMetadata);
assert.ok(backup && backup.length > XMP.length + IPTC.length);
const sideEdited = Exif.writeEmbedded(withSideMetadata, { artist: 'Changed' });
assert.equal(Exif.readEmbedded(sideEdited).fields.artist, 'Changed');
const sideRestored = Exif.restoreMetadataSegments(sideEdited, backup);
assert.deepEqual(Array.from(sideRestored), Array.from(withSideMetadata));

// Metadata is commonly interleaved with APP0/ICC/comment segments. Capture its
// original marker positions so a save + revert is byte-for-byte identical,
// including the conventional APP0-before-EXIF order.
const firstEditedLength = (edited[4] << 8) | edited[5];
const ORIGINAL_EXIF = edited.slice(2, 4 + firstEditedLength);
const APP2 = segment(0xe2, ascii('ICC_PROFILE\0profile-data'));
const COMMENT = segment(0xfe, ascii('camera comment'));
const interleaved = concat(SOI, APP0, XMP, APP2, ORIGINAL_EXIF, COMMENT, IPTC, SCAN);
const interleavedBackup = Exif.captureMetadataSegments(interleaved);
const interleavedEdited = Exif.writeEmbedded(interleaved, { artist: 'Changed again' });
const interleavedRestored = Exif.restoreMetadataSegments(interleavedEdited, interleavedBackup);
assert.deepEqual(Array.from(interleavedRestored), Array.from(interleaved));

// Existing databases contain the old raw concatenation format. It must remain
// reversible after the position-aware container ships.
const legacyBackup = concat(XMP, IPTC);
const legacyRestored = Exif.restoreMetadataSegments(sideEdited, legacyBackup);
assert.deepEqual(Array.from(legacyRestored), Array.from(withSideMetadata));

// APP1 has a 16-bit size field. Refuse an oversized rewrite instead of wrapping
// the length and returning corrupt JPEG bytes.
assert.throws(
  () => Exif.writeEmbedded(bareJpeg, { description: 'x'.repeat(70000) }),
  /too large/i,
);

console.log('memo-exif-edit byte-level tests passed');
