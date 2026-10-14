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
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
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

// Shape check only. The app validates individual records.
function isBudget(b) {
  return !!b && typeof b === 'object'
    && Array.isArray(b.envelopes) && Array.isArray(b.transactions)
    && !!b.assignments && typeof b.assignments === 'object' && !Array.isArray(b.assignments);
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function createApp({ dataDir, publicDir, secureCookies = false }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'db.json');
  const db = fs.existsSync(dbFile)
    ? JSON.parse(fs.readFileSync(dbFile, 'utf8'))
    : { users: {}, budgets: {}, sessions: {} };
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
    return { record, budget: Budget.fromJSON(record.budget) };
  }
  // What a member may see: the shared envelopes, their assignments and their
  // transactions, plus the owner's on-budget accounts to pay from.
  function sharedView(sh) {
    const { record, budget } = ownerBudget(sh.owner);
    const ids = new Set(sh.envelopeIds.filter((id) => budget.envelopes.some((e) => e.id === id)));
    const assignments = {};
    for (const [month, byEnv] of Object.entries(budget.assignments)) {
      for (const [envId, cents] of Object.entries(byEnv)) {
        if (ids.has(envId)) (assignments[month] = assignments[month] || {})[envId] = cents;
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
          envelopeId: t.envelopeId, accountId: t.accountId, createdBy: t.createdBy || sh.owner,
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
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
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
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new HttpError(413, 'The file is too large.'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
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
      return sendJson(res, 201, { user: { email } }, { 'Set-Cookie': cookie });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
      const { email, password } = credentials(await readJson(req));
      const user = db.users[email];
      // Always hash, so unknown emails take as long as wrong passwords.
      const ok = user
        ? checkPassword(password, user)
        : (hashPassword(password, 'envelo-dummy-salt'), false);
      if (!ok) {
        recordFailure(ip);
        throw new HttpError(401, 'Email or password is wrong.');
      }
      failures.delete(ip);
      const cookie = startSession(res, email);
      persist();
      return sendJson(res, 200, { user: { email } }, { 'Set-Cookie': cookie });
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
      return sendJson(res, 200, { user: { email: user.email } });
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
      if (!isBudget(budget)) throw new HttpError(400, 'This is not a valid budget.');
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

  function serveStatic(req, res, pathname) {
    const requested = pathname === '/' ? '/index.html' : pathname;
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
    res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS, 'Cache-Control': 'no-cache' });
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
  });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`Envelo listening on http://${host}:${port}`);
  });
}

module.exports = { createApp, isBudget };
