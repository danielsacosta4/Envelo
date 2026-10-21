'use strict';

// Envelo server: accounts, sessions and per-user budget storage.
// Dependency-free (Node 18+). All data lives in one JSON file under DATA_DIR,
// written atomically. Fine for a household; swap the store for a database if
// you ever need more.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { importActualZip } = require('./actual-import.js');
const Budget = require('../src/budget.js');
const store = require('./secure-store.js');
const totp = require('./totp.js');

// Version from package.json, shown by `update` and the app.
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || 'dev';
  } catch {
    return 'dev';
  }
})();

const COOKIE = 'envelo_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 3 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const RECEIPT_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const RECOVERY_CODES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const BACKUPS_KEPT = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEARTBEAT_MS = 25 * 1000;
const SHARE_ROLES = ['view', 'edit'];
const MAX_MEMBER_CENTS = 1e10; // 100 million: anything above is a typo or an attack
// A calendar date that exists (not 2026-02-31).
function realDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Passwords: scrypt, run off the main thread so a login never stalls other
// requests. New hashes use a higher cost; older ones (no `kdf` on the user)
// are checked with the old cost and upgraded at the next sign-in.
const KDF = { N: 2 ** 16, r: 8, p: 1 };
const LEGACY_KDF = { N: 2 ** 14, r: 8, p: 1 };
function scryptHex(password, salt, kdf) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { ...kdf, maxmem: 256 * 1024 * 1024 }, (err, buf) => (err ? reject(err) : resolve(buf.toString('hex'))));
  });
}
function hashPassword(password, salt) {
  return scryptHex(password, salt, KDF);
}
async function checkPassword(password, user) {
  // Overlong input is never a valid password; still spend the time.
  if (typeof password !== 'string' || password.length > 200 || !user) {
    await scryptHex('not-a-password', 'envelo-dummy-salt', KDF);
    return false;
  }
  const actual = Buffer.from(await scryptHex(password, user.salt, user.kdf || LEGACY_KDF), 'hex');
  const expected = Buffer.from(user.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Shape check plus the shared safety check (forbidden property names, plain
// IDs, sane values). Clients are never trusted with what reaches other users.
function isBudget(b) {
  return !!b && typeof b === 'object'
    && Array.isArray(b.envelopes) && Array.isArray(b.transactions)
    && !!b.assignments && typeof b.assignments === 'object' && !Array.isArray(b.assignments);
}
function budgetProblems(b) {
  if (!isBudget(b)) return ['not a budget'];
  return Budget.validateBudget(b);
}

// Lookup tables keyed by email or token hash never inherit anything, so a key
// like "__proto__" or "constructor" can only ever be missing.
function table(obj) {
  const t = Object.create(null);
  if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) t[k] = obj[k];
  return t;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

//   trustProxy: requests come through a reverse proxy on this machine; take
//     the client address from X-Forwarded-For and HTTPS from X-Forwarded-Proto
//   registration: 'open' | 'invite' | 'closed' (the first account can always register)
function createApp({ dataDir, publicDir, secureCookies = false, keyFile, trustProxy = false, registration = 'invite', receiptQuotaMb = 200 }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Leftovers from an import that crashed half way (they can hold a budget).
  fs.rmSync(path.join(dataDir, 'tmp'), { recursive: true, force: true });
  // Written once the data has been saved encrypted. From then on a plain-text
  // db.json is refused: it would mean someone put it there.
  const encryptedMark = path.join(dataDir, '.encrypted');
  let encryptedMarked = fs.existsSync(encryptedMark);
  const dbFile = path.join(dataDir, 'db.json');
  // The encryption key lives outside the data folder when the installer set
  // one up; otherwise it is created next to the data.
  const localKey = path.join(dataDir, 'secret.key');
  const key = store.loadKey(keyFile || localKey, keyFile ? localKey : null);
  let db = { users: table(), budgets: table(), sessions: table() };
  if (fs.existsSync(dbFile)) {
    let text;
    try {
      text = store.decrypt(key, fs.readFileSync(dbFile), { context: 'envelo:db', allowPlain: !fs.existsSync(encryptedMark) }).toString('utf8');
    } catch (err) {
      if (/not encrypted/.test(err.message)) throw new Error(`${dbFile} is not encrypted, but this Envelo has saved encrypted data before. Restore it from a backup in ${path.join(dataDir, 'backups')}.`);
      throw new Error(`Cannot decrypt ${dbFile}: the encryption key does not match. Check KEY_FILE (${keyFile || localKey}).`);
    }
    db = JSON.parse(text);
    db.users = table(db.users);
    db.budgets = table(db.budgets);
    db.sessions = table(db.sessions);
  }
  const receiptsDir = path.join(dataDir, 'receipts');
  // Local admin commands (`envelo reset-password ...`) prove themselves with
  // this token, which only root and the service can read.
  const adminToken = crypto.randomBytes(24).toString('hex');
  try {
    const tokenFile = path.join(dataDir, 'admin.token');
    fs.writeFileSync(tokenFile, adminToken, { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o600); // the mode above only applies to a new file
  } catch (err) {
    console.error('Could not write the admin token:', err.message);
  }
  if (!Array.isArray(db.shares)) db.shares = [];
  if (!Array.isArray(db.invites)) db.invites = [];
  if (!['open', 'invite', 'closed'].includes(db.registration)) db.registration = registration;

  // Failed sign-ins and password checks, counted per client address and per
  // account. A success clears only that account's count, so signing in to an
  // account of your own never resets the count for guesses at someone else's.
  const attempts = new Map(); // 'ip:…' or 'acct:…' -> { count, since }
  const LIMIT = { ip: 30, acct: 6 };
  const MAX_TRACKED = 20000;
  function clientIp(req) {
    if (trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }
  function isHttps(req) {
    return !!req.socket.encrypted || (trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
  }
  function limitKeys(req, email) {
    const keys = [`ip:${clientIp(req)}`];
    if (email) keys.push(`acct:${email}`);
    return keys;
  }
  function checkLimit(keys) {
    const now = Date.now();
    for (const k of keys) {
      const e = attempts.get(k);
      if (!e) continue;
      if (now - e.since > LOGIN_WINDOW_MS) attempts.delete(k);
      else if (e.count >= LIMIT[k.slice(0, k.indexOf(':'))]) {
        throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
      }
    }
  }
  function recordFailure(keys) {
    const now = Date.now();
    for (const k of keys) {
      const e = attempts.get(k);
      if (!e || now - e.since > LOGIN_WINDOW_MS) {
        attempts.delete(k);
        attempts.set(k, { count: 1, since: now });
      } else e.count += 1;
    }
    while (attempts.size > MAX_TRACKED) attempts.delete(attempts.keys().next().value);
  }
  // A password check on a signed-in request (change password, delete
  // account, two-step changes): limited like sign-in.
  async function confirmPassword(req, user, password, message = 'Your password is not right.') {
    const keys = limitKeys(req, user.email);
    checkLimit(keys);
    if (!(await checkPassword(String(password || ''), user))) {
      recordFailure(keys);
      throw new HttpError(403, message);
    }
  }

  // Live updates: every open tab keeps an event stream; a save is announced
  // to the owner's other tabs and to everyone the budget is shared with.
  const streams = new Map(); // email -> Set of responses
  function notify(email, event, data) {
    for (const res of streams.get(email) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function announceBudget(owner, revision, clientId) {
    notify(owner, 'budget', { revision, clientId: clientId || null });
    for (const sh of db.shares) if (sh.owner === owner) notify(sh.member, 'shared', { shareId: sh.id });
  }
  const heartbeat = setInterval(() => {
    for (const set of streams.values()) for (const res of set) res.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Sharing: an owner shares some envelopes with another user, who can view
  // them or also add spending to them. The owner's Ready to Assign pays for
  // them; only the owner assigns money.
  const shareById = (id) => db.shares.find((sh) => sh.id === id);
  function shareOut(sh) {
    return { id: sh.id, owner: sh.owner, member: sh.member, role: sh.role, envelopeIds: sh.envelopeIds, createdAt: sh.createdAt };
  }
  function ownerBudget(owner) {
    const record = db.budgets[owner];
    if (!record || !record.budget) throw new HttpError(404, 'The shared budget no longer exists.');
    return { record, budget: Budget.fromJSON(record.budget, { trusted: true }) };
  }
  // What a member may see: the shared envelopes, their assignments and their
  // transactions, plus the owner's on-budget accounts to pay from.
  function sharedView(sh) {
    const { record, budget } = ownerBudget(sh.owner);
    const ids = new Set(sh.envelopeIds.filter((id) => budget.envelopes.some((e) => e.id === id)));
    const assignments = Object.create(null);
    for (const [month, byEnv] of Object.entries(budget.assignments)) {
      if (!/^\d{4}-\d{2}$/.test(month) || !byEnv || typeof byEnv !== 'object') continue;
      for (const [envId, cents] of Object.entries(byEnv)) {
        if (!ids.has(envId)) continue;
        if (!assignments[month]) assignments[month] = Object.create(null);
        assignments[month][envId] = cents;
      }
    }
    return {
      share: shareOut(sh),
      revision: record.revision || 0,
      budget: {
        version: 1,
        currency: budget.currency,
        envelopes: budget.envelopes.filter((e) => ids.has(e.id)).map((e) => ({ ...e, hidden: false })),
        transactions: budget.transactions.filter((t) => ids.has(t.envelopeId)).map((t) => ({
          id: t.id, date: t.date, payee: t.payee, note: t.note, amount: t.amount,
          envelopeId: t.envelopeId, accountId: t.accountId, createdBy: t.createdBy || sh.owner, contribution: !!t.contribution,
        })),
        assignments,
        accounts: budget.accounts.filter((a) => !a.offBudget).map((a) => ({ id: a.id, name: a.name, offBudget: false })),
        recurring: [],
        hiddenGroups: [],
      },
    };
  }
  function saveOwnerBudget(owner, budget, clientId) {
    const record = db.budgets[owner];
    const revision = (record.revision || 0) + 1;
    db.budgets[owner] = { budget, savedAt: new Date().toISOString(), revision };
    persist();
    announceBudget(owner, revision, clientId);
    return revision;
  }

  function persist() {
    const now = Date.now();
    for (const [key, s] of Object.entries(db.sessions)) {
      if (s.expires < now) delete db.sessions[key];
    }
    const tmp = `${dbFile}.tmp`;
    fs.writeFileSync(tmp, store.encrypt(key, Buffer.from(JSON.stringify(db)), 'envelo:db'), { mode: 0o600 });
    fs.renameSync(tmp, dbFile);
    if (!encryptedMarked) {
      try { fs.writeFileSync(encryptedMark, '', { mode: 0o600 }); } catch { /* read-only data dir */ }
      encryptedMarked = true;
    }
    backupDaily();
  }

  // Keep one copy of the data file per day, for the last BACKUPS_KEPT days.
  function backupDaily() {
    const dir = path.join(dataDir, 'backups');
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `db-${today}.json`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(file) && fs.existsSync(dbFile)) {
        fs.copyFileSync(dbFile, file);
        fs.chmodSync(file, 0o600);
      }
      const all = fs.readdirSync(dir).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) {
        fs.unlinkSync(path.join(dir, old));
      }
    } catch (err) {
      console.error('Backup failed:', err.message);
    }
  }

  function sendJson(res, status, body, extraHeaders = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    });
    res.end(data);
  }

  function sessionCookie(token, maxAgeSeconds, req) {
    const secure = secureCookies || (req && isHttps(req));
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  }

  function readJson(req) {
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new HttpError(415, 'Send JSON.');
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, 'Request is too large.'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
        } catch {
          reject(new HttpError(400, 'Invalid JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  function readRaw(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      // Past the limit, keep reading but drop the bytes, so the browser gets
      // the 413 answer instead of a broken connection.
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= limit) chunks.push(chunk);
      });
      req.on('end', () => {
        if (size > limit) reject(new HttpError(413, `The file is too large (the limit is ${Math.round(limit / 1048576)} MB).`));
        else resolve(Buffer.concat(chunks));
      });
      req.on('error', reject);
    });
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const session = db.sessions[sha256(token)];
    if (!session || session.expires < Date.now()) return null;
    return db.users[session.email] || null;
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in first.');
    return user;
  }

  function userOut(user) {
    return { email: user.email, twofa: !!user.totp, recoveryLeft: user.totp ? (user.recovery || []).length : 0 };
  }

  function currentToken(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return token ? sha256(token) : null;
  }

  function endSessions(email, exceptKey = null) {
    for (const [k, sess] of Object.entries(db.sessions)) {
      if (sess.email === email && k !== exceptKey) delete db.sessions[k];
    }
    closeStreams(email, (res) => res.sessionKey !== exceptKey);
  }
  // Live-update streams belong to a session and end with it.
  function closeStreams(email, which = () => true) {
    for (const res of [...(streams.get(email) || [])]) if (which(res)) res.end();
  }

  function validPassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      throw new HttpError(400, 'Password must be 8 to 200 characters.');
    }
  }

  async function setPassword(user, password) {
    validPassword(password);
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = await hashPassword(password, user.salt);
    user.kdf = { ...KDF };
    delete user.mustChangePassword;
  }

  function newRecoveryCodes(user) {
    const codes = [];
    for (let i = 0; i < RECOVERY_CODES; i++) {
      const c = crypto.randomBytes(5).toString('hex').toUpperCase();
      codes.push(`${c.slice(0, 5)}-${c.slice(5)}`);
    }
    user.recoverySalt = crypto.randomBytes(16).toString('hex');
    user.recovery = codes.map((c) => sha256(`${user.recoverySalt}:${c}`));
    return codes;
  }

  // A 6-digit code from the app, or an unused recovery code (used up).
  function checkSecondFactor(user, code) {
    const clean = String(code || '').trim().toUpperCase();
    const step = totp.verify(user.totp, clean, { lastStep: user.totpLastStep || -1 });
    if (step >= 0) {
      user.totpLastStep = step;
      return true;
    }
    const typed = clean.replace(/\s/g, '');
    // Codes from before salting are unsalted hashes.
    const hashed = user.recoverySalt ? sha256(`${user.recoverySalt}:${typed}`) : sha256(typed);
    const i = (user.recovery || []).indexOf(hashed);
    if (i >= 0) {
      user.recovery.splice(i, 1);
      return true;
    }
    return false;
  }

  function receiptDir(email) {
    return path.join(receiptsDir, sha256(email).slice(0, 32));
  }
  function receiptBytes(email) {
    let total = 0;
    try {
      for (const f of fs.readdirSync(receiptDir(email))) total += fs.statSync(path.join(receiptDir(email), f)).size;
    } catch { /* no folder yet */ }
    return total;
  }
  // Attachment files that no transaction or scheduled transaction uses any
  // more are deleted once they are a week old (a fresh upload is not yet
  // saved in the budget, and undo may bring a transaction back).
  const RECEIPT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
  function cleanReceipts(email, budget) {
    const used = new Set();
    for (const t of budget.transactions || []) if (t && t.receiptId) used.add(t.receiptId);
    for (const r of budget.recurring || []) if (r && r.receiptId) used.add(r.receiptId);
    const dir = receiptDir(email);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    const now = Date.now();
    for (const f of files) {
      const id = f.replace(/\.bin$/, '');
      if (used.has(id)) continue;
      try {
        if (now - fs.statSync(path.join(dir, f)).mtimeMs > RECEIPT_GRACE_MS) fs.rmSync(path.join(dir, f), { force: true });
      } catch { /* gone already */ }
    }
  }

  function removeUser(email) {
    delete db.users[email];
    delete db.budgets[email];
    endSessions(email);
    db.shares = db.shares.filter((sh) => sh.owner !== email && sh.member !== email);
    fs.rmSync(receiptDir(email), { recursive: true, force: true });
  }

  function addInvite(email, by) {
    if (db.users[email] || db.invites.some((i) => i.email === email)) return;
    db.invites.push({ email, by, at: new Date().toISOString() });
    if (db.invites.length > 1000) db.invites.shift();
  }

  function startSession(req, email) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.sessions[sha256(token)] = { email, expires: Date.now() + SESSION_MS };
    return sessionCookie(token, SESSION_MS / 1000, req);
  }

  function credentials(body) {
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
    return { email, password };
  }

  async function api(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/register') {
      // Every attempt counts against the address, so accounts cannot be
      // created (or probed) in bulk.
      const ipKeys = limitKeys(req);
      checkLimit(ipKeys);
      recordFailure(ipKeys);
      const { email, password } = credentials(await readJson(req));
      if (password.length < 8 || password.length > 200) {
        throw new HttpError(400, 'Password must be 8 to 200 characters.');
      }
      const first = Object.keys(db.users).length === 0;
      const invited = db.invites.some((i) => i.email === email);
      if (!first && db.registration === 'closed') throw new HttpError(403, 'New accounts are switched off on this Envelo.');
      if (!first && db.registration === 'invite' && !invited) {
        throw new HttpError(403, 'Ask the owner of this Envelo to invite this email first.');
      }
      if (db.users[email]) throw new HttpError(409, 'This email cannot be used. If it is yours, sign in instead.');
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[email] = { email, salt, hash: await hashPassword(password, salt), kdf: { ...KDF }, createdAt: new Date().toISOString() };
      db.invites = db.invites.filter((i) => i.email !== email);
      const cookie = startSession(req, email);
      persist();
      return sendJson(res, 201, { user: userOut(db.users[email]) }, { 'Set-Cookie': cookie });
    }

    if (req.method === 'GET' && pathname === '/api/registration') {
      return sendJson(res, 200, { mode: Object.keys(db.users).length === 0 ? 'open' : db.registration });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readJson(req);
      const { email, password } = credentials(body);
      const keys = limitKeys(req, email);
      checkLimit(keys);
      const user = db.users[email];
      // Always hash, so unknown emails take as long as wrong passwords.
      if (!(await checkPassword(password, user))) {
        recordFailure(keys);
        throw new HttpError(401, 'Email or password is wrong.');
      }
      // After an admin reset, a new password must be chosen before going on.
      // Asked before the code, so the code is not used up by this round trip.
      if (user.mustChangePassword && !body.newPassword) {
        return sendJson(res, 403, { error: 'Choose a new password.', needNewPassword: true, needCode: !!user.totp && !body.code });
      }
      // Two-step sign-in: the password was right, now the code is needed.
      if (user.totp) {
        if (!body.code) return sendJson(res, 401, { error: 'Enter the code from your authenticator app.', needCode: true });
        if (!checkSecondFactor(user, body.code)) {
          recordFailure(keys);
          persist();
          return sendJson(res, 401, { error: 'That code is not right. Try the newest one.', needCode: true });
        }
      }
      if (user.mustChangePassword) await setPassword(user, body.newPassword);
      else if (!user.kdf) {
        // Upgrade an older, cheaper hash now that the password is known.
        user.hash = await hashPassword(password, user.salt);
        user.kdf = { ...KDF };
      }
      attempts.delete(`acct:${email}`);
      const cookie = startSession(req, email);
      persist();
      return sendJson(res, 200, { user: userOut(user) }, { 'Set-Cookie': cookie });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) {
        const key = sha256(token);
        const sess = db.sessions[key];
        delete db.sessions[key];
        if (sess) closeStreams(sess.email, (r) => r.sessionKey === key);
        persist();
      }
      // The browser also drops anything it cached for this site.
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, req), 'Clear-Site-Data': '"cache"' });
    }

    if (req.method === 'POST' && pathname === '/api/sessions/revoke') {
      const user = requireUser(req);
      endSessions(user.email, currentToken(req));
      persist();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/version') {
      return sendJson(res, 200, { version: VERSION });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      const user = requireUser(req);
      return sendJson(res, 200, { user: userOut(user) });
    }

    if (req.method === 'GET' && pathname === '/api/budget') {
      const user = requireUser(req);
      const record = db.budgets[user.email] || null;
      return sendJson(res, 200, {
        budget: record ? record.budget : null,
        savedAt: record ? record.savedAt : null,
        revision: record ? record.revision || 0 : 0,
      });
    }

    if (req.method === 'PUT' && pathname === '/api/budget') {
      const user = requireUser(req);
      const budget = await readJson(req);
      const problems = budgetProblems(budget);
      if (problems.length) throw new HttpError(400, `This budget has data Envelo cannot accept: ${problems.slice(0, 3).join('; ')}.`);
      // Optimistic locking: a save based on an older revision is refused, so
      // two devices cannot silently overwrite each other.
      const current = db.budgets[user.email];
      const currentRevision = current ? current.revision || 0 : 0;
      const ifMatch = req.headers['if-match'];
      if (ifMatch !== undefined && Number(ifMatch) !== currentRevision) {
        return sendJson(res, 409, {
          error: 'Your budget was changed on another device.',
          budget: current ? current.budget : null,
          savedAt: current ? current.savedAt : null,
          revision: currentRevision,
        });
      }
      const savedAt = new Date().toISOString();
      const revision = currentRevision + 1;
      db.budgets[user.email] = { budget, savedAt, revision };
      persist();
      announceBudget(user.email, revision, req.headers['x-client-id']);
      setImmediate(() => cleanReceipts(user.email, budget));
      return sendJson(res, 200, { savedAt, revision });
    }

    if (req.method === 'POST' && pathname === '/api/password') {
      const user = requireUser(req);
      const body = await readJson(req);
      await confirmPassword(req, user, body?.current, 'Your current password is not right.');
      await setPassword(user, body?.next);
      // Other devices must sign in again with the new password.
      endSessions(user.email, currentToken(req));
      persist();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/account/delete') {
      const user = requireUser(req);
      const body = await readJson(req);
      await confirmPassword(req, user, body?.password);
      removeUser(user.email);
      persist();
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, req), 'Clear-Site-Data': '"cache"' });
    }

    if (req.method === 'POST' && pathname === '/api/2fa/setup') {
      const user = requireUser(req);
      const body = await readJson(req);
      if (user.totp) throw new HttpError(409, 'Two-step sign-in is already on.');
      // A stolen session alone must not be enough to change how you sign in.
      await confirmPassword(req, user, body?.password);
      user.totpPending = totp.newSecret();
      persist();
      return sendJson(res, 200, { secret: user.totpPending, uri: totp.otpauthUri(user.totpPending, user.email) });
    }

    if (req.method === 'POST' && pathname === '/api/2fa/enable') {
      const user = requireUser(req);
      const body = await readJson(req);
      if (!user.totpPending) throw new HttpError(400, 'Start the setup again.');
      const step = totp.verify(user.totpPending, body?.code);
      if (step < 0) throw new HttpError(400, 'That code is not right. Check the time on your phone and try the newest code.');
      user.totp = user.totpPending;
      user.totpLastStep = step;
      delete user.totpPending;
      const codes = newRecoveryCodes(user);
      // Anyone else signed in must now go through the second step too.
      endSessions(user.email, currentToken(req));
      persist();
      return sendJson(res, 200, { recoveryCodes: codes, user: userOut(user) });
    }

    if (req.method === 'POST' && pathname === '/api/2fa/disable') {
      const user = requireUser(req);
      const body = await readJson(req);
      await confirmPassword(req, user, body?.password);
      delete user.totp;
      delete user.totpLastStep;
      delete user.recovery;
      delete user.recoverySalt;
      endSessions(user.email, currentToken(req));
      persist();
      return sendJson(res, 200, { user: userOut(user) });
    }

    if (req.method === 'POST' && pathname === '/api/2fa/recovery') {
      const user = requireUser(req);
      const body = await readJson(req);
      if (!user.totp) throw new HttpError(400, 'Two-step sign-in is off.');
      await confirmPassword(req, user, body?.password);
      const codes = newRecoveryCodes(user);
      persist();
      return sendJson(res, 200, { recoveryCodes: codes, user: userOut(user) });
    }

    // Receipts: stored encrypted, one folder per user.
    if (req.method === 'POST' && pathname === '/api/receipts') {
      const user = requireUser(req);
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!RECEIPT_TYPES[type]) throw new HttpError(415, 'Attachments must be a photo (WebP, JPEG or PNG) or a PDF.');
      const isPdf = type === 'application/pdf';
      const bytes = await readRaw(req, isPdf ? MAX_PDF_BYTES : MAX_RECEIPT_BYTES);
      if (!bytes.length) throw new HttpError(400, 'The file is empty.');
      if (isPdf && bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(415, 'That file is not a PDF.');
      if (receiptBytes(user.email) + bytes.length > receiptQuotaMb * 1024 * 1024) {
        throw new HttpError(413, `Your attachments use all the space allowed (${receiptQuotaMb} MB). Remove some old ones first.`);
      }
      const id = crypto.randomUUID();
      const dir = receiptDir(user.email);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const payload = Buffer.concat([Buffer.from(`${type}\n`), bytes]);
      fs.writeFileSync(path.join(dir, `${id}.bin`), store.encrypt(key, payload, `envelo:receipt:${path.basename(dir)}:${id}`), { mode: 0o600 });
      return sendJson(res, 201, { id });
    }

    const receiptMatch = pathname.match(/^\/api\/receipts\/([0-9a-f-]{36})$/);
    if (receiptMatch) {
      const user = requireUser(req);
      const file = path.join(receiptDir(user.email), `${receiptMatch[1]}.bin`);
      if (!fs.existsSync(file)) throw new HttpError(404, 'Receipt not found.');
      if (req.method === 'DELETE') {
        fs.rmSync(file, { force: true });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        const plain = store.decrypt(key, fs.readFileSync(file), { context: `envelo:receipt:${path.basename(path.dirname(file))}:${receiptMatch[1]}` });
        const nl = plain.indexOf(10);
        const type = plain.subarray(0, nl).toString('utf8');
        const body = plain.subarray(nl + 1);
        const headers = {
          'Content-Type': RECEIPT_TYPES[type] ? type : 'application/octet-stream',
          'Content-Length': body.length,
          'Cache-Control': 'private, max-age=86400',
          ...SECURITY_HEADERS,
        };
        if (type === 'application/pdf') {
          // The page policy (object-src 'none') would stop the browser's PDF
          // viewer. A PDF opens on its own, outside the app, so it goes without.
          delete headers['Content-Security-Policy'];
          headers['Content-Disposition'] = 'inline; filename="attachment.pdf"';
        }
        res.writeHead(200, headers);
        return res.end(body);
      }
    }

    // Admin commands from the `envelo` tool on the server itself.
    if (req.method === 'POST' && pathname.startsWith('/api/admin/')) {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const given = Buffer.from(String(req.headers['x-admin-token'] || ''));
      const want = Buffer.from(adminToken);
      if (!local || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        throw new HttpError(403, 'Not allowed.');
      }
      const body = await readJson(req);
      if (pathname === '/api/admin/users') {
        return sendJson(res, 200, {
          users: Object.values(db.users).map((u) => ({ email: u.email, createdAt: u.createdAt, twofa: !!u.totp })),
          invites: db.invites.map((i) => i.email), registration: db.registration,
        });
      }
      if (pathname === '/api/admin/registration') {
        const mode = String(body?.mode || '');
        if (!['open', 'invite', 'closed'].includes(mode)) throw new HttpError(400, 'Use open, invite or closed.');
        db.registration = mode;
        persist();
        return sendJson(res, 200, { registration: mode });
      }
      if (pathname === '/api/admin/invite') {
        const email = String(body?.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Give an email address.');
        addInvite(email, 'admin');
        persist();
        return sendJson(res, 200, { email });
      }
      const email = String(body?.email || '').trim().toLowerCase();
      const user = db.users[email];
      if (!user) throw new HttpError(404, `No account for ${email}.`);
      if (pathname === '/api/admin/reset-password') {
        const temp = crypto.randomBytes(9).toString('base64url');
        await setPassword(user, temp);
        user.mustChangePassword = true;
        endSessions(email);
        persist();
        return sendJson(res, 200, { email, temporaryPassword: temp });
      }
      if (pathname === '/api/admin/reset-2fa') {
        delete user.totp;
        delete user.totpLastStep;
        delete user.recovery;
        delete user.recoverySalt;
        delete user.totpPending;
        persist();
        return sendJson(res, 200, { email });
      }
      if (pathname === '/api/admin/delete-user') {
        removeUser(email);
        persist();
        return sendJson(res, 200, { email });
      }
      throw new HttpError(404, 'Unknown command.');
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const user = requireUser(req);
      const mine = streams.get(user.email);
      let total = 0;
      for (const set of streams.values()) total += set.size;
      if ((mine && mine.size >= 8) || total >= 1000) throw new HttpError(429, 'Too many open windows.');
      res.sessionKey = currentToken(req);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...SECURITY_HEADERS,
      });
      res.write('retry: 3000\n\n');
      if (!streams.has(user.email)) streams.set(user.email, new Set());
      streams.get(user.email).add(res);
      req.on('close', () => {
        const set = streams.get(user.email);
        if (set) {
          set.delete(res);
          if (!set.size) streams.delete(user.email);
        }
      });
      return undefined;
    }

    // Invites: who may create an account while sign-up is invite-only.
    if (req.method === 'GET' && pathname === '/api/invites') {
      const user = requireUser(req);
      return sendJson(res, 200, { mode: db.registration, invites: db.invites.filter((i) => i.by === user.email).map((i) => i.email) });
    }
    if (req.method === 'POST' && pathname === '/api/invites') {
      const user = requireUser(req);
      const body = await readJson(req);
      const email = String(body?.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter an email address.');
      addInvite(email, user.email);
      persist();
      return sendJson(res, 200, { email });
    }
    const inviteMatch = pathname.match(/^\/api\/invites\/(.+)$/);
    if (inviteMatch && req.method === 'DELETE') {
      const user = requireUser(req);
      const email = decodeURIComponent(inviteMatch[1]).toLowerCase();
      db.invites = db.invites.filter((i) => !(i.email === email && i.by === user.email));
      persist();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/shares') {
      const user = requireUser(req);
      return sendJson(res, 200, {
        outgoing: db.shares.filter((sh) => sh.owner === user.email).map(shareOut),
        incoming: db.shares.filter((sh) => sh.member === user.email).map(shareOut),
      });
    }

    if (req.method === 'POST' && pathname === '/api/shares') {
      const user = requireUser(req);
      const body = await readJson(req);
      const member = String(body?.member || '').trim().toLowerCase();
      if (!EMAIL_RE.test(member) || member.length > 254) throw new HttpError(400, 'Enter the email address of the person to share with.');
      if (member === user.email) throw new HttpError(400, 'You cannot share with yourself.');
      const role = SHARE_ROLES.includes(body?.role) ? body.role : 'view';
      const { budget } = ownerBudget(user.email);
      const envelopeIds = [...new Set(Array.isArray(body?.envelopeIds) ? body.envelopeIds : [])]
        .filter((id) => budget.envelopes.some((e) => e.id === id));
      if (!envelopeIds.length) throw new HttpError(400, 'Pick at least one envelope to share.');
      // One share per person: sharing again updates it.
      let sh = db.shares.find((x) => x.owner === user.email && x.member === member);
      if (sh) Object.assign(sh, { role, envelopeIds });
      else {
        sh = { id: crypto.randomUUID(), owner: user.email, member, role, envelopeIds, createdAt: new Date().toISOString() };
        db.shares.push(sh);
      }
      // Sharing with someone also lets them create an account. Whether the
      // email already has an account is not revealed.
      if (!db.users[member]) addInvite(member, user.email);
      persist();
      notify(member, 'shared', { shareId: sh.id });
      return sendJson(res, 200, { share: shareOut(sh) });
    }

    const shareMatch = pathname.match(/^\/api\/shares\/([\w-]+)$/);
    if (shareMatch && req.method === 'DELETE') {
      const user = requireUser(req);
      const sh = shareById(shareMatch[1]);
      // The owner can stop sharing; the member can leave.
      if (!sh || (sh.owner !== user.email && sh.member !== user.email)) throw new HttpError(404, 'Not found.');
      db.shares = db.shares.filter((x) => x !== sh);
      persist();
      notify(sh.member, 'shared', { shareId: sh.id, removed: true });
      return sendJson(res, 200, { ok: true });
    }

    // Adding money to a shared envelope: the member put money into one of the
    // owner's accounts for that envelope (say, a transfer to the joint
    // account). It raises the envelope and the account, not Ready to Assign.
    const moneyMatch = pathname.match(/^\/api\/shared\/([\w-]+)\/money$/);
    if (moneyMatch && req.method === 'POST') {
      const user = requireUser(req);
      const sh = shareById(moneyMatch[1]);
      if (!sh || sh.member !== user.email) throw new HttpError(404, 'Not found.');
      if (sh.role !== 'edit') throw new HttpError(403, 'You can only view these envelopes.');
      // Read the request first, then the owner's latest budget, so a slow
      // request can never save an old copy over newer changes.
      const body = await readJson(req);
      const { budget } = ownerBudget(sh.owner);
      const amount = Number(body?.amount);
      if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_MEMBER_CENTS) throw new HttpError(400, 'Enter an amount to add.');
      if (!sh.envelopeIds.includes(body?.envelopeId) || !budget.envelopes.some((e) => e.id === body.envelopeId)) throw new HttpError(400, 'Pick one of the shared envelopes.');
      if (!budget.accounts.some((a) => a.id === body?.accountId && !a.offBudget)) throw new HttpError(400, 'Pick the account the money went into.');
      if (!realDate(body?.date)) throw new HttpError(400, 'Date must be YYYY-MM-DD.');
      budget.transactions.push({
        id: crypto.randomUUID(),
        date: body.date,
        payee: String(body.payee || `From ${user.email}`).slice(0, 80),
        note: String(body.note || '').slice(0, 140),
        amount,
        envelopeId: body.envelopeId,
        accountId: body.accountId,
        createdBy: user.email,
        contribution: true,
      });
      saveOwnerBudget(sh.owner, budget, req.headers['x-client-id']);
      return sendJson(res, 201, sharedView(sh));
    }

    const sharedMatch = pathname.match(/^\/api\/shared\/([\w-]+)(\/transactions(?:\/([\w:-]+))?)?$/);
    if (sharedMatch) {
      const user = requireUser(req);
      const sh = shareById(sharedMatch[1]);
      if (!sh || sh.member !== user.email) throw new HttpError(404, 'Not found.');
      if (req.method === 'GET' && !sharedMatch[2]) return sendJson(res, 200, sharedView(sh));
      if (sh.role !== 'edit') throw new HttpError(403, 'You can only view these envelopes.');
      const clientId = req.headers['x-client-id'];
      // As above: the request body first, then the owner's latest budget.
      const body = req.method === 'POST' ? await readJson(req) : null;
      const { budget } = ownerBudget(sh.owner);

      if (req.method === 'POST' && sharedMatch[2] && !sharedMatch[3]) {
        const amount = Number(body?.amount);
        if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_MEMBER_CENTS) throw new HttpError(400, 'Enter an amount.');
        if (!realDate(body?.date)) throw new HttpError(400, 'Date must be YYYY-MM-DD.');
        if (!sh.envelopeIds.includes(body?.envelopeId)) throw new HttpError(400, 'Pick one of the shared envelopes.');
        if (!budget.accounts.some((a) => a.id === body?.accountId && !a.offBudget)) throw new HttpError(400, 'Pick an account.');
        let tx;
        try {
          tx = Budget.addTransaction(budget, {
            kind: 'spend', date: body.date, payee: String(body.payee || '').slice(0, 80), note: String(body.note || '').slice(0, 140),
            amount, envelopeId: body.envelopeId, accountId: body.accountId,
          });
        } catch (err) {
          throw new HttpError(400, err instanceof Error && err.message.length < 120 ? err.message : 'That transaction could not be added.');
        }
        tx.createdBy = user.email;
        saveOwnerBudget(sh.owner, budget, clientId);
        return sendJson(res, 201, sharedView(sh));
      }

      if (req.method === 'DELETE' && sharedMatch[3]) {
        const tx = budget.transactions.find((t) => t.id === sharedMatch[3]);
        if (!tx || !sh.envelopeIds.includes(tx.envelopeId) || tx.createdBy !== user.email) {
          throw new HttpError(403, 'You can only delete spending you added.');
        }
        Budget.removeTransaction(budget, tx.id);
        saveOwnerBudget(sh.owner, budget, clientId);
        return sendJson(res, 200, sharedView(sh));
      }
      throw new HttpError(404, 'Not found.');
    }

    if (req.method === 'POST' && pathname === '/api/import/actual') {
      const user = requireUser(req);
      // A zip content type also keeps plain cross-site forms from posting here.
      if (!/application\/(zip|x-zip-compressed|octet-stream)/.test(String(req.headers['content-type'] || ''))) {
        throw new HttpError(415, 'Send the .zip file exported from Actual.');
      }
      const zip = await readRaw(req, MAX_IMPORT_BYTES);
      const current = db.budgets[user.email];
      let result;
      try {
        result = importActualZip(zip, {
          currency: current && current.budget ? current.budget.currency : 'EUR',
          tmpDir: path.join(dataDir, 'tmp'),
        });
      } catch (err) {
        // Messages written for people pass through; anything else (a database
        // or parser error) is logged and replaced, so internals do not leak.
        const friendly = err && err.constructor === Error && !err.code && err.message.length < 200;
        if (!friendly) console.error('Actual import failed:', err);
        throw new HttpError(400, friendly ? err.message : 'This file could not be read as an Actual export.');
      }
      // Not saved here: the app shows a summary and saves after the user confirms.
      return sendJson(res, 200, result);
    }

    throw new HttpError(404, 'Not found.');
  }

  const prints = new Map(); // relative path -> { mtime, hash }
  function fingerprint(rel) {
    const file = path.join(publicDir, rel);
    try {
      const { mtimeMs } = fs.statSync(file);
      const known = prints.get(rel);
      if (known && known.mtime === mtimeMs) return known.hash;
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
      prints.set(rel, { mtime: mtimeMs, hash });
      return hash;
    } catch {
      return VERSION;
    }
  }

  function serveStatic(req, res, pathname) {
    // The installable-app files live in src/ but must be served from the root
    // so the service worker can look after the whole app.
    const ROOT_FILES = { '/': '/index.html', '/manifest.webmanifest': '/src/manifest.webmanifest', '/sw.js': '/src/sw.js' };
    const requested = ROOT_FILES[pathname] || pathname;
    // Only the app is public: index.html and files under src/.
    if (requested !== '/index.html' && !requested.startsWith('/src/')) {
      res.writeHead(404, SECURITY_HEADERS).end('Not found');
      return;
    }
    const file = path.normalize(path.join(publicDir, requested));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, SECURITY_HEADERS).end('Not found');
      return;
    }
    const type = CONTENT_TYPES[path.extname(file)] || 'application/octet-stream';
    if (requested === '/index.html') {
      // Every script and stylesheet link carries a fingerprint of the file, so
      // after an update no browser or proxy can keep serving an old copy next
      // to the new page. The page also says which version it belongs to.
      const html = fs.readFileSync(file, 'utf8')
        .replace(/(src|href)="(src\/[^"?]+\.(?:js|css))"/g, (m, attr, rel) => `${attr}="${rel}?v=${fingerprint(rel)}"`)
        .replace('<head>', `<head>\n  <meta name="envelo-version" content="${VERSION}">`);
      res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    const extra = pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {};
    res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS, 'Cache-Control': 'no-cache', ...extra });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname.startsWith('/api/')) {
        // Requests that change something must come from this site's own pages.
        // Browsers always send Origin on such requests; tools like the admin
        // CLI send none and authenticate otherwise.
        if (!['GET', 'HEAD'].includes(req.method)) {
          // Modern browsers say where a request comes from (Sec-Fetch-Site),
          // unaffected by a proxy that rewrites Host; older ones send Origin.
          const site = req.headers['sec-fetch-site'];
          if (site !== undefined) {
            if (site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'This request did not come from Envelo.');
          } else if (req.headers.origin !== undefined) {
            let host = '';
            try { host = new URL(req.headers.origin).host; } catch { /* not a URL */ }
            const expected = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
            if (!host || host !== expected) throw new HttpError(403, 'This request did not come from Envelo.');
          }
        }
        if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
        await api(req, res, pathname);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, pathname);
      } else {
        res.writeHead(405, SECURITY_HEADERS).end('Method not allowed');
      }
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Something went wrong on the server.' });
      }
    }
  });

  server.on('close', () => clearInterval(heartbeat));
  return server;
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const server = createApp({
    dataDir: process.env.DATA_DIR || path.join(root, 'data'),
    publicDir: root,
    secureCookies: process.env.SECURE_COOKIES === '1',
    keyFile: process.env.KEY_FILE || undefined,
    trustProxy: process.env.TRUST_PROXY === '1',
    receiptQuotaMb: Number(process.env.RECEIPT_QUOTA_MB) > 0 ? Number(process.env.RECEIPT_QUOTA_MB) : 200,
    registration: ['open', 'invite', 'closed'].includes(process.env.REGISTRATION) ? process.env.REGISTRATION : 'invite',
  });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`Envelo listening on http://${host}:${port}`);
  });
}

module.exports = { createApp, isBudget };
