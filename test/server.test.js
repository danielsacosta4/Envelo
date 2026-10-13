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
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Small client that keeps the session cookie, like a browser does.
function client(base) {
  let cookie = '';
  return async function call(method, url, body) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
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
