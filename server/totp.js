'use strict';

// Time-based one-time passwords (RFC 6238), as used by authenticator apps:
// 6 digits, 30-second steps, SHA-1. Codes one step either side are accepted
// to allow for clock drift.

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const n = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(n % 1e6).padStart(6, '0');
}

// Returns the time step the code matched, or -1. Pass `lastStep` to refuse a
// code that was already used.
function verify(secret, code, { now = Date.now(), window = 1, lastStep = -1 } = {}) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return -1;
  const step = Math.floor(now / 30000);
  for (let d = -window; d <= window; d++) {
    const s = step + d;
    if (s <= lastStep) continue;
    const expected = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return s;
  }
  return -1;
}

function otpauthUri(secret, account, issuer = 'Envelo') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { base32Encode, base32Decode, newSecret, codeAt, verify, otpauthUri };
