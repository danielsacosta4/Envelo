'use strict';

// Encryption at rest: AES-256-GCM with a key kept outside the data folder
// (by default /etc/envelo/secret.key), so copies of the data folder and its
// backups cannot be read without it. Files without the header are plain text
// from older versions and are read as they are.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAGIC = Buffer.from('ENV1');

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

function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function isEncrypted(buf) {
  return buf.length >= 32 && buf.subarray(0, 4).equals(MAGIC);
}

function decrypt(key, buf) {
  if (!isEncrypted(buf)) return buf;
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
}

module.exports = { loadKey, encrypt, decrypt, isEncrypted };
