'use strict';

// Encryption at rest: AES-256-GCM with a key kept outside the data folder
// (by default /etc/envelo/secret.key), so copies of the data folder and its
// backups cannot be read without it.
//
// Formats:
//   ENV2 + iv + tag + body: bound to a context (what the file is and whose it
//     is) as additional authenticated data, so a file cannot be swapped for
//     another one encrypted with the same key.
//   ENV1 + iv + tag + body: older files, no context; still read.
//   anything else: plain text from before encryption, read only when allowed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAGIC = Buffer.from('ENV1');
const MAGIC2 = Buffer.from('ENV2');

function readKey(file) {
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`The key in ${file} is not a 32-byte base64 key.`);
  return key;
}

// The key file to use, in order: the configured one if it exists, a key that
// an earlier run created next to the data, or a new key (at the configured
// place if it can be written there, otherwise next to the data). This way a
// key is never replaced while data encrypted with it exists.
function loadKey(keyFile, fallbackFile = null) {
  if (fs.existsSync(keyFile)) return readKey(keyFile);
  if (fallbackFile && fs.existsSync(fallbackFile)) {
    console.warn(`Using the encryption key in ${fallbackFile} (${keyFile} does not exist).`);
    return readKey(fallbackFile);
  }
  const key = crypto.randomBytes(32);
  for (const file of [keyFile, fallbackFile].filter(Boolean)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (err) {
      if (file === fallbackFile || !fallbackFile) throw err;
    }
  }
  return key;
}

function encrypt(key, plain, context = null) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (context) cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([context ? MAGIC2 : MAGIC, iv, cipher.getAuthTag(), body]);
}

function isEncrypted(buf) {
  return buf.length >= 32 && (buf.subarray(0, 4).equals(MAGIC) || buf.subarray(0, 4).equals(MAGIC2));
}

//   context: must match what the file was encrypted with (ENV2 files)
//   allowPlain: accept a file that is not encrypted at all (old data)
function decrypt(key, buf, { context = null, allowPlain = true } = {}) {
  if (!isEncrypted(buf)) {
    if (!allowPlain) throw new Error('This file is not encrypted, but encrypted data was expected.');
    return buf;
  }
  const bound = buf.subarray(0, 4).equals(MAGIC2);
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (bound) decipher.setAAD(Buffer.from(context || ''));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
}

module.exports = { loadKey, encrypt, decrypt, isEncrypted };
