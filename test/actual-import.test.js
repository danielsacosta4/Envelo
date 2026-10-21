const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const B = require('../src/budget.js');
const { importActualZip, readZipEntry } = require('../server/actual-import.js');

const hasPython = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();
const hasSqliteCli = (() => { try { execFileSync('sqlite3', ['--version']); return true; } catch { return false; } })();
const hasNodeSqlite = (() => { try { require('node:sqlite'); return true; } catch { return false; } })();

function fixture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'envelo-fx-')), 'actual.zip');
  execFileSync('python3', [path.join(__dirname, 'fixtures', 'make-actual-zip.py'), file]);
  return fs.readFileSync(file);
}

function check(engine) {
  const { budget, summary } = importActualZip(fixture(), { currency: 'EUR', engine });
  assert.equal(summary.name, 'Home budget');
  assert.deepEqual(budget.accounts.map((a) => `${a.name}${a.offBudget ? ' (off budget)' : ''}`), ['Checking', 'Savings', 'Mortgage (off budget)']);
  assert.equal(summary.offBudgetAccounts, 1);
  assert.deepEqual(budget.envelopes.map((e) => `${e.group}/${e.name}`).sort(), ['Bills/Rent', 'Daily/Groceries', 'Imported/Uncategorized']);
  assert.equal(summary.transactions, 13);
  assert.equal(summary.transfers, 2);
  assert.equal(summary.uncategorized, 1);

  const b = B.fromJSON(budget);
  const env = (n) => b.envelopes.find((e) => e.name === n).id;
  const acct = (n) => b.accounts.find((a) => a.name === n).id;
  // Income 2500 + starting balance 1000, minus 900 + 300 - 1 assigned. The
  // mortgage (off budget) and its starting balance do not count.
  assert.equal(B.readyToAssign(b, '2026-10'), 230100);
  assert.equal(B.assignedIn(b, '2026-10', env('Rent')), 90000);
  // 300 from the merged category plus a negative -1.
  assert.equal(B.assignedIn(b, '2026-10', env('Groceries')), 29900);
  // Merged category + split child land in Groceries; the other split child in Rent.
  assert.equal(B.envelopeStatus(b, env('Groceries'), '2026-10').activity, -7000);
  // Rent: 900 + split 20 + the 500 mortgage payment categorized as Rent.
  assert.equal(B.envelopeStatus(b, env('Rent'), '2026-10').activity, -142000);
  assert.equal(B.accountBalance(b, acct('Checking')), 180300);
  assert.equal(B.accountBalance(b, acct('Savings')), 20000);
  // Off-budget: -10 spend + 500 payment in - 200,000 loan starting balance.
  assert.equal(B.accountBalance(b, acct('Mortgage')), -19951000);
  assert.equal(b.transactions.filter((t) => t.transferId).length, 4);
  assert.ok(b.transactions.filter((t) => t.accountId === acct('Mortgage')).every((t) => !t.envelopeId));
  assert.ok(b.transactions.find((t) => t.payee === 'Landlord').reconciled);
  assert.equal(b.transactions.filter((t) => t.payee === 'Market').length, 3);
  assert.equal(b.transactions.find((t) => t.payee === 'Starting balance' && t.accountId === acct('Checking')).date, '2026-09-30');
  B.monthView(b, '2026-10');
}

test('imports an Actual export with node:sqlite', { skip: !hasPython || !hasNodeSqlite }, () => check('node'));
test('imports an Actual export with the sqlite3 command', { skip: !hasPython || !hasSqliteCli }, () => check('cli'));

test('rejects files that are not Actual exports', () => {
  assert.throws(() => readZipEntry(Buffer.from('not a zip at all, definitely not'), 'db.sqlite'), /not a zip/);
});

test('a zip that unpacks to far more than it says is refused', () => {
  const zlib = require('node:zlib');
  const { readZipEntry } = require('../server/actual-import.js');
  const raw = zlib.deflateRawSync(Buffer.alloc(250 * 1024 * 1024));
  const name = Buffer.from('db.sqlite');
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(1000, 22); lh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(raw.length, 20); cd.writeUInt32LE(1000, 24); cd.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([lh, name, raw]);
  const cdBuf = Buffer.concat([cd, name]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(body.length, 16);
  assert.throws(() => readZipEntry(Buffer.concat([body, cdBuf, eocd]), 'db.sqlite'), /too large/);
});
