const path = require('node:path');
const { test, expect } = require('@playwright/test');

const editScript = path.join(__dirname, '..', 'src', 'static', 'js', 'memo', 'memo-exif-edit.js');
const editorScript = path.join(__dirname, '..', 'src', 'static', 'js', 'memo', 'memo-exif-editor.js');

const editorMarkup = `
  <dialog id="metadataEditorDlg">
    <strong id="metadataEditorTitle">Advanced metadata</strong>
    <span id="metadataEditorFileName"></span>
    <button id="metadataEditorClose" type="button">Close</button>
    <p id="metadataEmbeddedNote"></p>
    <div id="metadataUnsupported" hidden></div>
    <div id="metadataEmbeddedFields" hidden>
      <textarea id="metadataDescription"></textarea>
      <input id="metadataCreator">
      <input id="metadataCopyright">
      <input id="metadataCapturedAt" type="datetime-local">
    </div>
    <section id="metadataReadonlySection" hidden><div id="metadataReadonlyGrid"></div></section>
    <div id="metadataPrivacyActions" hidden>
      <button id="metadataStripBtn" type="button" hidden>Strip</button>
      <button id="metadataRevertBtn" type="button" hidden>Revert</button>
    </div>
    <div id="metadataEditorStatus" hidden></div>
    <button id="metadataEditorCancel" type="button">Cancel</button>
    <button id="metadataEditorSave" type="button" disabled>Save</button>
  </dialog>`;

test.beforeEach(async ({ page }) => {
  await page.setContent(editorMarkup);
  await page.addScriptTag({ path: editScript });
  await page.evaluate(() => {
    const soi = [0xff, 0xd8];
    const app0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46];
    const scan = [0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];
    window.__editorLog = [];
    window.__editorBlob = new Blob([new Uint8Array([...soi, ...app0, ...scan])], { type: 'image/jpeg' });
    window.__entries = [{
      id: 'memo-1',
      description: 'Workbench',
      images: ['/uploads/2026-08-02/photo.jpg'],
      _storedPaths: ['uploads/2026-08-02/photo.jpg'],
      imageMeta: {},
      tags: [],
      attachments: [],
      deletedAt: null,
    }, {
      id: 'memo-remote',
      description: 'Remote image',
      images: ['https://cdn.example.test/remote.jpg'],
      _storedPaths: [],
      imageMeta: {},
      tags: [],
      attachments: [],
      deletedAt: null,
    }];
    window.MemoContracts = { getMode: () => 'local' };
    window.MemoPrivacy = { canViewEntry: () => true };
    window.MemoShell = { toast: (message, options) => window.__editorLog.push(['toast', message, options || {}]) };
    window.MemoLibraryPicker = { open: (options) => { window.__pickerOptions = options; } };
    window.MemoStateDb = {
      ready: () => true,
      urlToRel: (value) => String(value || '').replace(/^\/+/, ''),
      readBlob: async () => window.__editorBlob,
      writeBlob: async (storedPath, blob) => {
        window.__editorLog.push(['write', storedPath]);
        window.__editorBlob = blob;
      },
      saveEntries: () => window.__editorLog.push(['save']),
      flush: async () => window.__editorLog.push(['flush']),
      hydrateImageAt: async (entry, index, storedPath) => {
        window.__editorLog.push(['hydrate', storedPath]);
        entry.images[index] = 'blob:fresh-' + window.__editorLog.length;
      },
    };
    window.MemoCore = {
      getState: () => ({ db: { entries: window.__entries }, activeFilters: {} }),
      getVariant: () => 'default',
      renderFeed: () => window.__editorLog.push(['render']),
      hydrateMountedImages: async () => {},
      persistEntryMediaMutation: async () => window.__editorLog.push(['corePersist']),
    };
  });
  await page.addScriptTag({ path: editorScript });
});

test('JPEG picker descriptor edits and reverts one stable image path', async ({ page }) => {
  await page.evaluate(() => window.MemoExifEditor.pickFromLibrary());
  const picker = await page.evaluate(() => ({
    mode: window.__pickerOptions.mode,
    filter: window.__pickerOptions.filter,
    selectionUnit: window.__pickerOptions.selectionUnit,
    descriptors: window.__pickerOptions.returnDescriptors,
  }));
  expect(picker).toEqual({ mode: 'single', filter: 'jpeg', selectionUnit: 'image', descriptors: true });

  await page.evaluate(() => window.__pickerOptions.onDone({
    entryId: 'memo-1',
    index: 0,
    ref: 'uploads/2026-08-02/photo.jpg',
    storedPath: 'uploads/2026-08-02/photo.jpg',
    mime: 'image/jpeg',
    name: 'photo.jpg',
  }));
  await expect(page.locator('#metadataEditorDlg')).toBeVisible();
  await expect(page.locator('#metadataEditorSave')).toBeEnabled();
  await page.locator('#metadataDescription').fill('Edited in MemoSystem');
  await page.locator('#metadataCreator').fill('Example Artist');
  await page.locator('#metadataEditorSave').click();
  await expect(page.locator('#metadataEditorDlg')).toBeHidden();

  const saved = await page.evaluate(async () => {
    const entry = window.__entries[0];
    const bytes = new Uint8Array(await window.__editorBlob.arrayBuffer());
    return {
      record: entry.imageMeta['uploads/2026-08-02/photo.jpg'],
      embedded: window.MemoExifEdit.readEmbedded(bytes),
      log: window.__editorLog.map((item) => item[0]),
    };
  });
  expect(atob(saved.record.embeddedBackup).slice(0, 4)).toBe('MEXB');
  expect(saved.record.embeddedEditedAt).toBeTruthy();
  expect(saved.embedded.fields.description).toBe('Edited in MemoSystem');
  expect(saved.embedded.fields.artist).toBe('Example Artist');
  expect(saved.log).toEqual(expect.arrayContaining(['save', 'flush', 'write', 'hydrate', 'corePersist']));
  expect(saved.log.indexOf('save')).toBeLessThan(saved.log.indexOf('write')); // backup precedes overwrite

  await page.evaluate(() => window.MemoExifEditor.open({
    entryId: 'memo-1', index: 0, storedPath: 'uploads/2026-08-02/photo.jpg',
  }));
  await expect(page.locator('#metadataRevertBtn')).toBeVisible();
  await page.locator('#metadataRevertBtn').click();
  await expect(page.locator('#metadataEditorDlg')).toBeHidden();
  const reverted = await page.evaluate(async () => {
    const bytes = new Uint8Array(await window.__editorBlob.arrayBuffer());
    return {
      imageMeta: window.__entries[0].imageMeta,
      embedded: window.MemoExifEdit.readEmbedded(bytes),
    };
  });
  expect(reverted.imageMeta).toEqual({});
  expect(reverted.embedded.hasExif).toBe(false);
});

test('remote references stay read-only with a clear reason', async ({ page }) => {
  await page.evaluate(() => window.MemoExifEditor.open({
    entryId: 'memo-remote', index: 0, ref: 'https://cdn.example.test/remote.jpg',
  }));
  await expect(page.locator('#metadataEditorDlg')).toBeVisible();
  await expect(page.locator('#metadataEditorSave')).toBeDisabled();
  await expect(page.locator('#metadataUnsupported')).toContainText('no writable local file');
  expect(await page.evaluate(() => window.__editorLog.some((item) => item[0] === 'write'))).toBe(false);
});
