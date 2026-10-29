// Test helpers for password-protected exports: answer the password dialog,
// and turn a downloaded .memora file back into the ZIP it was sealed from
// (same format as src/static/js/memo/memo-crypto.js), so tests can keep
// inspecting the ZIP and import it through the older plain-ZIP path.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASSWORD = 'test-backup-password';
const HEADER = 41;

async function answerPassword(page, password = PASSWORD) {
  const dlg = page.locator('dialog.password-dlg[open]');
  await dlg.waitFor({ timeout: 15000 });
  await dlg.locator('#passwordDlgFirst').fill(password);
  if (await dlg.locator('#passwordDlgSecond').count()) await dlg.locator('#passwordDlgSecond').fill(password);
  await dlg.locator('.actions .primary').click();
}

// Click an export button and give it the test password.
async function clickExport(page, selector = '#exportDataBtn', password = PASSWORD) {
  await page.click(selector);
  await answerPassword(page, password);
}

function decryptMemora(buffer, password = PASSWORD) {
  const b = Buffer.from(buffer);
  if (b.subarray(0, 6).toString('latin1') !== 'MEMORA') throw new Error('Not a Memora envelope');
  const header = b.subarray(0, HEADER);
  const iterations = b.readUInt32BE(9);
  const salt = b.subarray(13, 29);
  const iv = b.subarray(29, 41);
  const tag = b.subarray(b.length - 16);
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(b.subarray(HEADER, b.length - 16)), decipher.final()]);
}

const plainName = name => name.replace(/\.memora$/i, '');

// A Playwright download -> { name, bytes } of the plain ZIP.
async function readPlain(download, password = PASSWORD) {
  const bytes = fs.readFileSync(await download.path());
  const name = download.suggestedFilename();
  return /\.memora$/i.test(name) ? { name: plainName(name), bytes: decryptMemora(bytes, password) } : { name, bytes };
}

// Save a download as a plain ZIP in `dir`; returns the file path.
async function savePlain(download, dir, password = PASSWORD) {
  const file = await readPlain(download, password);
  const target = path.join(dir, file.name);
  fs.writeFileSync(target, file.bytes);
  return target;
}

module.exports = { PASSWORD, answerPassword, clickExport, decryptMemora, plainName, readPlain, savePlain };
