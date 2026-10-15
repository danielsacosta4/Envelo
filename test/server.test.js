const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server.js');

const ROOT = path.join(__dirname, '..');

// Start a server on a random port with its own data directory.
async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelo-test-'));
  const server = createApp({ dataDir, publicDir: ROOT });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    dataDir,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

// Small client that keeps the session cookie, like a browser does.
function client(base) {
  let cookie = '';
  const call = async function call(method, url, body, ifMatch) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (method === 'PUT_IF') { method = 'PUT'; headers['If-Match'] = String(ifMatch); }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  call.cookie = () => cookie;
  return call;
}

const sampleBudget = () => ({
  version: 1,
  currency: 'EUR',
  envelopes: [{ id: 'e1', name: 'Groceries', group: 'Daily', goal: null }],
  transactions: [],
  assignments: { '2026-10': { e1: 30000 } },
});

test('register, then the session works; logout ends it', async () => {
  const s = await start();
  try {
    const call = client(s.base);
    assert.equal((await call('GET', '/api/me')).status, 401);

    const reg = await call('POST', '/api/register', { email: 'Ana@Example.com', password: 'correct horse' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.email, 'ana@example.com');

    assert.equal((await call('GET', '/api/me')).body.user.email, 'ana@example.com');

    await call('POST', '/api/logout');
    assert.equal((await call('GET', '/api/me')).status, 401);
  } finally {
    await s.close();
  }
});

test('login with the right password works, wrong password is refused', async () => {
  const s = await start();
  try {
    const call = client(s.base);
    await call('POST', '/api/register', { email: 'bo@example.com', password: 'longenough1' });
    await call('POST', '/api/logout');

    const bad = await call('POST', '/api/login', { email: 'bo@example.com', password: 'wrongpass1' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'Email or password is wrong.');

    const good = await call('POST', '/api/login', { email: 'bo@example.com', password: 'longenough1' });
    assert.equal(good.status, 200);
  } finally {
    await s.close();
  }
});

test('registration rejects bad input and duplicates', async () => {
  const s = await start();
  try {
    const call = client(s.base);
    assert.equal((await call('POST', '/api/register', { email: 'not-an-email', password: 'longenough1' })).status, 400);
    assert.equal((await call('POST', '/api/register', { email: 'c@example.com', password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/register', { email: 'c@example.com', password: 'longenough1' })).status, 201);
    assert.equal((await call('POST', '/api/register', { email: 'C@example.com', password: 'longenough1' })).status, 409);
  } finally {
    await s.close();
  }
});

test('budget is stored on the server and survives a new client', async () => {
  const s = await start();
  try {
    const first = client(s.base);
    await first('POST', '/api/register', { email: 'd@example.com', password: 'longenough1' });
    assert.equal((await first('GET', '/api/budget')).body.budget, null);

    const put = await first('PUT', '/api/budget', sampleBudget());
    assert.equal(put.status, 200);
    assert.ok(put.body.savedAt);

    // A brand-new client (another device) signs in and sees the same data.
    const second = client(s.base);
    await second('POST', '/api/login', { email: 'd@example.com', password: 'longenough1' });
    const got = await second('GET', '/api/budget');
    assert.deepEqual(got.body.budget, sampleBudget());
  } finally {
    await s.close();
  }
});

test("users cannot see or overwrite each other's budgets", async () => {
  const s = await start();
  try {
    const a = client(s.base);
    await a('POST', '/api/register', { email: 'a@example.com', password: 'longenough1' });
    await a('PUT', '/api/budget', sampleBudget());

    const b = client(s.base);
    await b('POST', '/api/register', { email: 'b@example.com', password: 'longenough1' });
    assert.equal((await b('GET', '/api/budget')).body.budget, null);

    const other = { ...sampleBudget(), currency: 'USD' };
    await b('PUT', '/api/budget', other);
    assert.deepEqual((await a('GET', '/api/budget')).body.budget, sampleBudget());
  } finally {
    await s.close();
  }
});

test('budget endpoint refuses malformed data and anonymous callers', async () => {
  const s = await start();
  try {
    const anon = client(s.base);
    assert.equal((await anon('GET', '/api/budget')).status, 401);
    assert.equal((await anon('PUT', '/api/budget', sampleBudget())).status, 401);

    const call = client(s.base);
    await call('POST', '/api/register', { email: 'e@example.com', password: 'longenough1' });
    assert.equal((await call('PUT', '/api/budget', { envelopes: 'nope' })).status, 400);
    assert.equal((await call('PUT', '/api/budget', [])).status, 400);
  } finally {
    await s.close();
  }
});

test('login is rate limited after repeated failures', async () => {
  const s = await start();
  try {
    const call = client(s.base);
    await call('POST', '/api/register', { email: 'f@example.com', password: 'longenough1' });
    await call('POST', '/api/logout');
    let last;
    for (let i = 0; i < 11; i++) {
      last = await call('POST', '/api/login', { email: 'f@example.com', password: 'nope-nope-1' });
    }
    assert.equal(last.status, 429);
  } finally {
    await s.close();
  }
});

test('passwords are not stored in plain text and the data file is private', async () => {
  const s = await start();
  try {
    const call = client(s.base);
    await call('POST', '/api/register', { email: 'g@example.com', password: 'plaintext-secret' });
    const raw = fs.readFileSync(path.join(s.dataDir, 'db.json'), 'utf8');
    assert.equal(raw.includes('plaintext-secret'), false);
    const mode = fs.statSync(path.join(s.dataDir, 'db.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await s.close();
  }
});

test('only the app is served publicly; data and server code are not', async () => {
  const s = await start();
  try {
    const page = await fetch(s.base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Envelo<\/title>/);
    assert.equal((await fetch(s.base + '/src/app.js')).status, 200);
    assert.equal((await fetch(s.base + '/server/server.js')).status, 404);
    assert.equal((await fetch(s.base + '/package.json')).status, 404);
    assert.equal((await fetch(s.base + '/src/../package.json')).status, 404);
    assert.equal((await fetch(s.base + '/data/db.json')).status, 404);
  } finally {
    await s.close();
  }
});

test('API writes require a JSON content type (basic CSRF protection)', async () => {
  const s = await start();
  try {
    const res = await fetch(s.base + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ email: 'h@example.com', password: 'longenough1' }),
    });
    assert.equal(res.status, 415);
  } finally {
    await s.close();
  }
});

test('a save based on an old revision is refused with the latest data', async () => {
  const s = await start();
  try {
    const call = client(s.base);
    await call('POST', '/api/register', { email: 'r@example.com', password: 'longenough1' });
    const put = (rev, body) => fetchWith(s.base, call, rev, body);
    const first = await put(0, sampleBudget());
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 1);
    // Another device saved revision 2 meanwhile.
    const second = await put(1, { ...sampleBudget(), currency: 'USD' });
    assert.equal(second.body.revision, 2);
    // This device still thinks it is on revision 1.
    const stale = await put(1, { ...sampleBudget(), currency: 'GBP' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.revision, 2);
    assert.equal(stale.body.budget.currency, 'USD');
    assert.equal((await call('GET', '/api/budget')).body.revision, 2);
  } finally {
    await s.close();
  }
});

test('the server keeps a daily backup of the data file', async () => {
  const s = await start();
  try {
    const call = client(s.base);
    await call('POST', '/api/register', { email: 'k@example.com', password: 'longenough1' });
    const files = fs.readdirSync(path.join(s.dataDir, 'backups'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^db-\d{4}-\d{2}-\d{2}\.json$/);
  } finally {
    await s.close();
  }
});

// PUT /api/budget with an If-Match revision, reusing the client's cookie.
async function fetchWith(base, call, revision, body) {
  const res = await call('PUT_IF', '/api/budget', body, revision);
  return res;
}

test('the Actual import endpoint converts a zip without saving it', { skip: (() => { try { require('node:child_process').execFileSync('python3', ['--version']); return false; } catch { return true; } })() }, async () => {
  const s = await start();
  try {
    const file = path.join(s.dataDir, 'actual.zip');
    require('node:child_process').execFileSync('python3', [path.join(__dirname, 'fixtures', 'make-actual-zip.py'), file]);
    const zip = fs.readFileSync(file);
    const anon = await fetch(s.base + '/api/import/actual', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip });
    assert.equal(anon.status, 401);

    const call = client(s.base);
    await call('POST', '/api/register', { email: 'z@example.com', password: 'longenough1' });
    const cookie = (await fetch(s.base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'z@example.com', password: 'longenough1' }),
    })).headers.get('set-cookie').split(';')[0];
    const wrongType = await fetch(s.base + '/api/import/actual', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: zip });
    assert.equal(wrongType.status, 415);
    const ok = await fetch(s.base + '/api/import/actual', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/zip' }, body: zip });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.summary.transactions, 13);
    assert.equal(body.budget.accounts.length, 3);
    // Nothing saved until the app confirms.
    assert.equal((await call('GET', '/api/budget')).body.budget, null);
    const bad = await fetch(s.base + '/api/import/actual', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/zip' }, body: Buffer.from('nope') });
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});

test('the server reports its version', async () => {
  const s = await start();
  try {
    const res = await fetch(s.base + '/api/version');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, require('../package.json').version);
  } finally {
    await s.close();
  }
});

const sharedBudget = () => ({
  version: 1,
  currency: 'EUR',
  accounts: [{ id: 'a1', name: 'Joint', offBudget: false }, { id: 'a2', name: 'Mortgage', offBudget: true }],
  envelopes: [
    { id: 'e1', name: 'Groceries', group: 'Daily', target: null },
    { id: 'e2', name: 'Secret gift', group: 'Fun', target: null },
  ],
  transactions: [
    { id: 't1', date: '2026-10-01', payee: 'Salary', note: '', amount: 300000, envelopeId: null, accountId: 'a1' },
    { id: 't2', date: '2026-10-02', payee: 'Shop', note: '', amount: -2000, envelopeId: 'e1', accountId: 'a1' },
    { id: 't3', date: '2026-10-03', payee: 'Jeweller', note: '', amount: -9000, envelopeId: 'e2', accountId: 'a1' },
  ],
  assignments: { '2026-10': { e1: 40000, e2: 10000 } },
});

test('sharing envelopes: members see only those, and can add spending when allowed', async () => {
  const s = await start();
  try {
    const owner = client(s.base);
    const member = client(s.base);
    const stranger = client(s.base);
    await owner('POST', '/api/register', { email: 'owner@example.com', password: 'longenough1' });
    await member('POST', '/api/register', { email: 'member@example.com', password: 'longenough1' });
    await stranger('POST', '/api/register', { email: 'stranger@example.com', password: 'longenough1' });
    await owner('PUT', '/api/budget', sharedBudget());

    assert.equal((await owner('POST', '/api/shares', { member: 'owner@example.com', envelopeIds: ['e1'] })).status, 400);
    assert.equal((await owner('POST', '/api/shares', { member: 'member@example.com', envelopeIds: [] })).status, 400);
    const made = await owner('POST', '/api/shares', { member: 'Member@Example.com', envelopeIds: ['e1', 'nope'], role: 'view' });
    assert.equal(made.status, 200);
    assert.deepEqual(made.body.share.envelopeIds, ['e1']);
    const id = made.body.share.id;

    const incoming = await member('GET', '/api/shares');
    assert.equal(incoming.body.incoming.length, 1);
    assert.equal(incoming.body.incoming[0].owner, 'owner@example.com');

    const view = await member('GET', `/api/shared/${id}`);
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.budget.envelopes.map((e) => e.name), ['Groceries']);
    assert.deepEqual(view.body.budget.transactions.map((t) => t.payee), ['Shop']);
    assert.deepEqual(view.body.budget.assignments, { '2026-10': { e1: 40000 } });
    assert.deepEqual(view.body.budget.accounts.map((a) => a.name), ['Joint']);
    assert.equal((await stranger('GET', `/api/shared/${id}`)).status, 404);

    // View only: no writes.
    const spend = { date: '2026-10-05', payee: 'Market', amount: 1500, envelopeId: 'e1', accountId: 'a1' };
    assert.equal((await member('POST', `/api/shared/${id}/transactions`, spend)).status, 403);

    await owner('POST', '/api/shares', { member: 'member@example.com', envelopeIds: ['e1'], role: 'edit' });
    assert.equal((await member('POST', `/api/shared/${id}/transactions`, { ...spend, envelopeId: 'e2' })).status, 400);
    assert.equal((await member('POST', `/api/shared/${id}/transactions`, { ...spend, accountId: 'a2' })).status, 400);
    const added = await member('POST', `/api/shared/${id}/transactions`, spend);
    assert.equal(added.status, 201);
    const mine = added.body.budget.transactions.find((t) => t.payee === 'Market');
    assert.equal(mine.createdBy, 'member@example.com');

    // The owner's budget has it, with a new revision.
    const ob = await owner('GET', '/api/budget');
    assert.equal(ob.body.revision, 2);
    assert.ok(ob.body.budget.transactions.some((t) => t.payee === 'Market' && t.amount === -1500));

    // Members can delete only what they added.
    assert.equal((await member('DELETE', `/api/shared/${id}/transactions/t2`)).status, 403);
    assert.equal((await member('DELETE', `/api/shared/${id}/transactions/${mine.id}`)).status, 200);

    // The member can leave; then the share is gone.
    assert.equal((await member('DELETE', `/api/shares/${id}`)).status, 200);
    assert.equal((await member('GET', `/api/shared/${id}`)).status, 404);
  } finally {
    await s.close();
  }
});

test('open tabs get live events when the budget changes', async () => {
  const s = await start();
  try {
    const call = client(s.base);
    await call('POST', '/api/register', { email: 'live@example.com', password: 'longenough1' });
    assert.equal((await fetch(`${s.base}/api/events`)).status, 401);
    const ctrl = new AbortController();
    const res = await fetch(`${s.base}/api/events`, { headers: { Cookie: call.cookie() }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const got = (async () => {
      let text = '';
      while (!text.includes('event: budget')) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    })();
    await call('PUT', '/api/budget', sampleBudget());
    const text = await got;
    assert.match(text, /"revision":1/);
    ctrl.abort();
  } finally {
    await s.close();
  }
});

const totp = require('../server/totp.js');

test('the data file is encrypted at rest and still loads after a restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelo-test-'));
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'envelo-key-')), 'secret.key');
  const boot = async () => {
    const server = createApp({ dataDir, publicDir: ROOT, keyFile });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  let { server, base } = await boot();
  const call = client(base);
  await call('POST', '/api/register', { email: 'enc@example.com', password: 'longenough1' });
  await call('PUT', '/api/budget', sampleBudget());
  const raw = fs.readFileSync(path.join(dataDir, 'db.json'));
  assert.equal(raw.subarray(0, 4).toString(), 'ENV1');
  assert.ok(!raw.includes(Buffer.from('Groceries')));
  assert.ok(!raw.includes(Buffer.from('enc@example.com')));
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  ({ server, base } = await boot());
  const again = client(base);
  await again('POST', '/api/login', { email: 'enc@example.com', password: 'longenough1' });
  assert.equal((await again('GET', '/api/budget')).body.budget.envelopes[0].name, 'Groceries');
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
});

test('changing the password signs out other devices', async () => {
  const s = await start();
  try {
    const a = client(s.base);
    const b = client(s.base);
    await a('POST', '/api/register', { email: 'pw@example.com', password: 'longenough1' });
    await b('POST', '/api/login', { email: 'pw@example.com', password: 'longenough1' });
    assert.equal((await a('POST', '/api/password', { current: 'wrong-one!', next: 'brand-new-pass' })).status, 403);
    assert.equal((await a('POST', '/api/password', { current: 'longenough1', next: 'short' })).status, 400);
    assert.equal((await a('POST', '/api/password', { current: 'longenough1', next: 'brand-new-pass' })).status, 200);
    assert.equal((await a('GET', '/api/me')).status, 200);
    assert.equal((await b('GET', '/api/me')).status, 401);
    assert.equal((await client(s.base)('POST', '/api/login', { email: 'pw@example.com', password: 'brand-new-pass' })).status, 200);
  } finally {
    await s.close();
  }
});

test('two-step sign-in: setup, sign in with a code or a recovery code, and turn off', async () => {
  const s = await start();
  try {
    const a = client(s.base);
    await a('POST', '/api/register', { email: 'tf@example.com', password: 'longenough1' });
    const setup = await a('POST', '/api/2fa/setup');
    assert.match(setup.body.uri, /^otpauth:\/\/totp\/Envelo:tf%40example.com\?secret=/);
    assert.equal((await a('POST', '/api/2fa/enable', { code: '000000' })).status, 400);
    const step = Math.floor(Date.now() / 30000);
    const on = await a('POST', '/api/2fa/enable', { code: totp.codeAt(setup.body.secret, step) });
    assert.equal(on.status, 200);
    assert.equal(on.body.recoveryCodes.length, 10);
    assert.equal(on.body.user.twofa, true);

    const b = client(s.base);
    const noCode = await b('POST', '/api/login', { email: 'tf@example.com', password: 'longenough1' });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.body.needCode, true);
    assert.equal((await b('GET', '/api/me')).status, 401);
    // The code used to enable cannot be used again.
    assert.equal((await b('POST', '/api/login', { email: 'tf@example.com', password: 'longenough1', code: totp.codeAt(setup.body.secret, step) })).status, 401);
    const rc = on.body.recoveryCodes[0];
    assert.equal((await b('POST', '/api/login', { email: 'tf@example.com', password: 'longenough1', code: rc.toLowerCase() })).status, 200);
    assert.equal((await b('GET', '/api/me')).body.user.recoveryLeft, 9);
    // A recovery code works once.
    assert.equal((await client(s.base)('POST', '/api/login', { email: 'tf@example.com', password: 'longenough1', code: rc })).status, 401);

    assert.equal((await a('POST', '/api/2fa/disable', { password: 'nope-nope' })).status, 403);
    assert.equal((await a('POST', '/api/2fa/disable', { password: 'longenough1' })).body.user.twofa, false);
    assert.equal((await client(s.base)('POST', '/api/login', { email: 'tf@example.com', password: 'longenough1' })).status, 200);
  } finally {
    await s.close();
  }
});

test('admin commands: temporary password must be changed at the next sign-in', async () => {
  const s = await start();
  try {
    const a = client(s.base);
    await a('POST', '/api/register', { email: 'adm@example.com', password: 'longenough1' });
    const token = fs.readFileSync(path.join(s.dataDir, 'admin.token'), 'utf8');
    const admin = (cmd, body, t = token) => fetch(`${s.base}/api/admin/${cmd}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': t }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal((await admin('users', {}, 'x'.repeat(token.length))).status, 403);
    assert.deepEqual((await admin('users', {})).body.users.map((u) => u.email), ['adm@example.com']);
    const reset = await admin('reset-password', { email: 'adm@example.com' });
    assert.equal(reset.status, 200);
    assert.equal((await a('GET', '/api/me')).status, 401);
    const b = client(s.base);
    const first = await b('POST', '/api/login', { email: 'adm@example.com', password: reset.body.temporaryPassword });
    assert.equal(first.status, 403);
    assert.equal(first.body.needNewPassword, true);
    assert.equal((await b('POST', '/api/login', { email: 'adm@example.com', password: reset.body.temporaryPassword, newPassword: 'my-new-password' })).status, 200);
    assert.equal((await client(s.base)('POST', '/api/login', { email: 'adm@example.com', password: 'my-new-password' })).status, 200);
  } finally {
    await s.close();
  }
});

test('receipts are stored encrypted, only for their owner, and go with a deleted account', async () => {
  const s = await start();
  try {
    const a = client(s.base);
    await a('POST', '/api/register', { email: 'rc@example.com', password: 'longenough1' });
    const image = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(200, 7)]);
    const up = await fetch(`${s.base}/api/receipts`, { method: 'POST', headers: { Cookie: a.cookie(), 'Content-Type': 'image/webp' }, body: image });
    assert.equal(up.status, 201);
    const { id } = await up.json();
    const bad = await fetch(`${s.base}/api/receipts`, { method: 'POST', headers: { Cookie: a.cookie(), 'Content-Type': 'text/html' }, body: 'x' });
    assert.equal(bad.status, 415);
    const got = await fetch(`${s.base}/api/receipts/${id}`, { headers: { Cookie: a.cookie() } });
    assert.equal(got.headers.get('content-type'), 'image/webp');
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(image));
    const files = fs.readdirSync(path.join(s.dataDir, 'receipts'), { recursive: true }).filter((f) => String(f).endsWith('.bin'));
    assert.equal(files.length, 1);
    assert.ok(!fs.readFileSync(path.join(s.dataDir, 'receipts', String(files[0]))).includes(Buffer.from('WEBP')));
    const other = client(s.base);
    await other('POST', '/api/register', { email: 'other@example.com', password: 'longenough1' });
    assert.equal((await fetch(`${s.base}/api/receipts/${id}`, { headers: { Cookie: other.cookie() } })).status, 404);

    assert.equal((await a('POST', '/api/account/delete', { password: 'wrong-password' })).status, 403);
    assert.equal((await a('POST', '/api/account/delete', { password: 'longenough1' })).status, 200);
    assert.equal((await client(s.base)('POST', '/api/login', { email: 'rc@example.com', password: 'longenough1' })).status, 401);
    assert.equal(fs.readdirSync(path.join(s.dataDir, 'receipts')).length, 0);
  } finally {
    await s.close();
  }
});

test('the installable-app files are served from the root', async () => {
  const s = await start();
  try {
    const m = await fetch(`${s.base}/manifest.webmanifest`);
    assert.equal(m.status, 200);
    assert.match(m.headers.get('content-type'), /manifest\+json/);
    const sw = await fetch(`${s.base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('service-worker-allowed'), '/');
    assert.match((await fetch(`${s.base}/`)).headers.get('content-security-policy'), /default-src 'self'/);
  } finally {
    await s.close();
  }
});
