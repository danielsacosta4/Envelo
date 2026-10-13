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
  assert.deepEqual(budget.accounts.map((a) => a.name), ['Checking', 'Savings']);
  assert.deepEqual(budget.envelopes.map((e) => `${e.group}/${e.name}`).sort(), ['Bills/Rent', 'Daily/Groceries', 'Imported/Uncategorized']);
  assert.equal(summary.transactions, 9);
  assert.equal(summary.offBudgetSkipped, 1);
  assert.equal(summary.transfers, 1);
  assert.equal(summary.uncategorized, 1);
  assert.equal(summary.negativeBudgetsSkipped, 1);

  const b = B.fromJSON(budget);
  const env = (n) => b.envelopes.find((e) => e.name === n).id;
  const acct = (n) => b.accounts.find((a) => a.name === n).id;
  // Income 2500 + starting balance 1000, minus 900 + 300 assigned.
  assert.equal(B.readyToAssign(b, '2026-10'), 230000);
  assert.equal(B.assignedIn(b, '2026-10', env('Rent')), 90000);
  assert.equal(B.assignedIn(b, '2026-10', env('Groceries')), 30000);
  // Merged category + split child land in Groceries; the other split child in Rent.
  assert.equal(B.envelopeStatus(b, env('Groceries'), '2026-10').activity, -7000);
  assert.equal(B.envelopeStatus(b, env('Rent'), '2026-10').activity, -92000);
  assert.equal(B.accountBalance(b, acct('Checking')), 230300);
  assert.equal(B.accountBalance(b, acct('Savings')), 20000);
  assert.equal(b.transactions.filter((t) => t.transferId).length, 2);
  assert.ok(b.transactions.find((t) => t.payee === 'Landlord').reconciled);
  assert.equal(b.transactions.filter((t) => t.payee === 'Market').length, 3);
  assert.equal(b.transactions.find((t) => t.payee === 'Starting balance').date, '2026-09-30');
  B.monthView(b, '2026-10');
}

test('imports an Actual export with node:sqlite', { skip: !hasPython || !hasNodeSqlite }, () => check('node'));
test('imports an Actual export with the sqlite3 command', { skip: !hasPython || !hasSqliteCli }, () => check('cli'));

test('rejects files that are not Actual exports', () => {
  assert.throws(() => readZipEntry(Buffer.from('not a zip at all, definitely not'), 'db.sqlite'), /not a zip/);
});
