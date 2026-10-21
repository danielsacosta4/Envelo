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

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function checkPassword(password, user) {
  const actual = Buffer.from(hashPassword(password, user.salt), 'hex');
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

function createApp({ dataDir, publicDir, secureCookies = false, keyFile }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'db.json');
  // The encryption key lives outside the data folder when the installer set
  // one up; otherwise it is created next to the data.
  const localKey = path.join(dataDir, 'secret.key');
  const key = store.loadKey(keyFile || localKey, keyFile ? localKey : null);
  let db = { users: table(), budgets: table(), sessions: table() };
  if (fs.existsSync(dbFile)) {
    let text;
    try {
      text = store.decrypt(key, fs.readFileSync(dbFile)).toString('utf8');
    } catch {
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
    fs.writeFileSync(path.join(dataDir, 'admin.token'), adminToken, { mode: 0o600 });
  } catch (err) {
    console.error('Could not write the admin token:', err.message);
  }
  if (!Array.isArray(db.shares)) db.shares = [];
  const failures = new Map(); // ip -> { count, since }

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
    fs.writeFileSync(tmp, store.encrypt(key, Buffer.from(JSON.stringify(db))), { mode: 0o600 });
    fs.renameSync(tmp, dbFile);
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

  function sessionCookie(token, maxAgeSeconds) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureCookies ? '; Secure' : ''}`;
  }

  function readJson(req) {
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
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
  }

  function validPassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      throw new HttpError(400, 'Password must be 8 to 200 characters.');
    }
  }

  function setPassword(user, password) {
    validPassword(password);
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = hashPassword(password, user.salt);
    delete user.mustChangePassword;
  }

  function newRecoveryCodes(user) {
    const codes = [];
    for (let i = 0; i < RECOVERY_CODES; i++) {
      const c = crypto.randomBytes(5).toString('hex').toUpperCase();
      codes.push(`${c.slice(0, 5)}-${c.slice(5)}`);
    }
    user.recovery = codes.map((c) => sha256(c));
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
    const hashed = sha256(clean.replace(/\s/g, ''));
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

  function removeUser(email) {
    delete db.users[email];
    delete db.budgets[email];
    endSessions(email);
    db.shares = db.shares.filter((sh) => sh.owner !== email && sh.member !== email);
    fs.rmSync(receiptDir(email), { recursive: true, force: true });
  }

  function startSession(res, email) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.sessions[sha256(token)] = { email, expires: Date.now() + SESSION_MS };
    return sessionCookie(token, SESSION_MS / 1000);
  }

  function rateLimited(ip) {
    const entry = failures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.since > LOGIN_WINDOW_MS) {
      failures.delete(ip);
      return false;
    }
    return entry.count >= LOGIN_MAX_FAILURES;
  }

  function recordFailure(ip) {
    const entry = failures.get(ip);
    if (!entry || Date.now() - entry.since > LOGIN_WINDOW_MS) {
      failures.set(ip, { count: 1, since: Date.now() });
    } else {
      entry.count += 1;
    }
  }

  function credentials(body) {
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
    return { email, password };
  }

  async function api(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/register') {
      const { email, password } = credentials(await readJson(req));
      if (password.length < 8 || password.length > 200) {
        throw new HttpError(400, 'Password must be 8 to 200 characters.');
      }
      if (db.users[email]) throw new HttpError(409, 'An account with this email already exists.');
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[email] = { email, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
      const cookie = startSession(res, email);
      persist();
      return sendJson(res, 201, { user: userOut(db.users[email]) }, { 'Set-Cookie': cookie });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
      const body = await readJson(req);
      req.body = body;
      const { email, password } = credentials(body);
      const user = db.users[email];
      // Always hash, so unknown emails take as long as wrong passwords.
      const ok = user
        ? checkPassword(password, user)
        : (hashPassword(password, 'envelo-dummy-salt'), false);
      if (!ok) {
        recordFailure(ip);
        throw new HttpError(401, 'Email or password is wrong.');
      }
      // Two-step sign-in: the password was right, now the code is needed.
      if (user.totp) {
        const body = req.body || {};
        if (!body.code) return sendJson(res, 401, { error: 'Enter the code from your authenticator app.', needCode: true });
        if (!checkSecondFactor(user, body.code)) {
          recordFailure(ip);
          persist();
          return sendJson(res, 401, { error: 'That code is not right. Try the newest one.', needCode: true });
        }
      }
      // After an admin reset, a new password must be chosen before going on.
      if (user.mustChangePassword) {
        const body = req.body || {};
        if (!body.newPassword) return sendJson(res, 403, { error: 'Choose a new password.', needNewPassword: true });
        setPassword(user, body.newPassword);
      }
      failures.delete(ip);
      const cookie = startSession(res, email);
      persist();
      return sendJson(res, 200, { user: userOut(user) }, { 'Set-Cookie': cookie });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) {
        delete db.sessions[sha256(token)];
        persist();
      }
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
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
      return sendJson(res, 200, { savedAt, revision });
    }

    if (req.method === 'POST' && pathname === '/api/password') {
      const user = requireUser(req);
      const body = await readJson(req);
      if (!checkPassword(String(body?.current || ''), user)) throw new HttpError(403, 'Your current password is not right.');
      setPassword(user, body?.next);
      // Other devices must sign in again with the new password.
      endSessions(user.email, currentToken(req));
      persist();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/account/delete') {
      const user = requireUser(req);
      const body = await readJson(req);
      if (!checkPassword(String(body?.password || ''), user)) throw new HttpError(403, 'Your password is not right.');
      removeUser(user.email);
      persist();
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    if (req.method === 'POST' && pathname === '/api/2fa/setup') {
      const user = requireUser(req);
      if (user.totp) throw new HttpError(409, 'Two-step sign-in is already on.');
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
      persist();
      return sendJson(res, 200, { recoveryCodes: codes, user: userOut(user) });
    }

    if (req.method === 'POST' && pathname === '/api/2fa/disable') {
      const user = requireUser(req);
      const body = await readJson(req);
      if (!checkPassword(String(body?.password || ''), user)) throw new HttpError(403, 'Your password is not right.');
      delete user.totp;
      delete user.totpLastStep;
      delete user.recovery;
      persist();
      return sendJson(res, 200, { user: userOut(user) });
    }

    if (req.method === 'POST' && pathname === '/api/2fa/recovery') {
      const user = requireUser(req);
      const body = await readJson(req);
      if (!user.totp) throw new HttpError(400, 'Two-step sign-in is off.');
      if (!checkPassword(String(body?.password || ''), user)) throw new HttpError(403, 'Your password is not right.');
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
      const id = crypto.randomUUID();
      const dir = receiptDir(user.email);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const payload = Buffer.concat([Buffer.from(`${type}\n`), bytes]);
      fs.writeFileSync(path.join(dir, `${id}.bin`), store.encrypt(key, payload), { mode: 0o600 });
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
        const plain = store.decrypt(key, fs.readFileSync(file));
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
      const given = String(req.headers['x-admin-token'] || '');
      if (!local || given.length !== adminToken.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(adminToken))) {
        throw new HttpError(403, 'Not allowed.');
      }
      const body = await readJson(req);
      if (pathname === '/api/admin/users') {
        return sendJson(res, 200, { users: Object.values(db.users).map((u) => ({ email: u.email, createdAt: u.createdAt, twofa: !!u.totp })) });
      }
      const email = String(body?.email || '').trim().toLowerCase();
      const user = db.users[email];
      if (!user) throw new HttpError(404, `No account for ${email}.`);
      if (pathname === '/api/admin/reset-password') {
        const temp = crypto.randomBytes(9).toString('base64url');
        setPassword(user, temp);
        user.mustChangePassword = true;
        endSessions(email);
        persist();
        return sendJson(res, 200, { email, temporaryPassword: temp });
      }
      if (pathname === '/api/admin/reset-2fa') {
        delete user.totp;
        delete user.totpLastStep;
        delete user.recovery;
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
      persist();
      notify(member, 'shared', { shareId: sh.id });
      return sendJson(res, 200, { share: shareOut(sh), registered: !!db.users[member] });
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
      const { budget } = ownerBudget(sh.owner);
      const body = await readJson(req);
      const amount = Number(body?.amount);
      if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Enter an amount to add.');
      if (!sh.envelopeIds.includes(body?.envelopeId) || !budget.envelopes.some((e) => e.id === body.envelopeId)) throw new HttpError(400, 'Pick one of the shared envelopes.');
      if (!budget.accounts.some((a) => a.id === body?.accountId && !a.offBudget)) throw new HttpError(400, 'Pick the account the money went into.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body?.date || ''))) throw new HttpError(400, 'Date must be YYYY-MM-DD.');
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
      const { budget } = ownerBudget(sh.owner);
      const clientId = req.headers['x-client-id'];

      if (req.method === 'POST' && sharedMatch[2] && !sharedMatch[3]) {
        const body = await readJson(req);
        if (!sh.envelopeIds.includes(body?.envelopeId)) throw new HttpError(400, 'Pick one of the shared envelopes.');
        if (!budget.accounts.some((a) => a.id === body?.accountId && !a.offBudget)) throw new HttpError(400, 'Pick an account.');
        let tx;
        try {
          tx = Budget.addTransaction(budget, {
            kind: 'spend', date: body.date, payee: String(body.payee || '').slice(0, 80), note: String(body.note || '').slice(0, 140),
            amount: Number(body.amount), envelopeId: body.envelopeId, accountId: body.accountId,
          });
        } catch (err) {
          throw new HttpError(400, err.message);
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
        throw new HttpError(400, err.message);
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
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname.startsWith('/api/')) {
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
  });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`Envelo listening on http://${host}:${port}`);
  });
}

module.exports = { createApp, isBudget };
