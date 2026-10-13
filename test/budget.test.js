const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/budget.js');

function sample() {
  const b = B.create();
  const rent = B.addEnvelope(b, { name: 'Rent', group: 'Bills' });
  const food = B.addEnvelope(b, { name: 'Groceries', group: 'Daily' });
  const fund = B.addEnvelope(b, { name: 'Emergency', group: 'Savings', goal: 100000 });
  return { b, rent, food, fund };
}

test('income fills Ready to Assign only up to its month', () => {
  const { b } = sample();
  B.addTransaction(b, { kind: 'income', date: '2026-09-30', amount: 300000, payee: 'Salary' });
  B.addTransaction(b, { kind: 'income', date: '2026-10-02', amount: 300000, payee: 'Salary' });
  assert.equal(B.readyToAssign(b, '2026-09'), 300000);
  assert.equal(B.readyToAssign(b, '2026-10'), 600000);
});

test('assigning moves money out of Ready to Assign', () => {
  const { b, rent } = sample();
  B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 200000 });
  B.setAssigned(b, '2026-10', rent.id, 150000);
  assert.equal(B.readyToAssign(b, '2026-10'), 50000);
});

test('over-assigning shows as negative Ready to Assign', () => {
  const { b, rent } = sample();
  B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 100000 });
  B.setAssigned(b, '2026-10', rent.id, 120000);
  assert.equal(B.readyToAssign(b, '2026-10'), -20000);
});

test('unspent money rolls over into the next month', () => {
  const { b, food } = sample();
  B.addTransaction(b, { kind: 'income', date: '2026-09-01', amount: 50000 });
  B.setAssigned(b, '2026-09', food.id, 50000);
  B.addTransaction(b, { kind: 'spend', date: '2026-09-10', amount: 12000, envelopeId: food.id });
  const oct = B.envelopeStatus(b, food.id, '2026-10');
  assert.equal(oct.carryover, 38000);
  assert.equal(oct.available, 38000);
  assert.equal(oct.activity, 0);
});

test('spending in the current month reduces available, not assigned', () => {
  const { b, food } = sample();
  B.setAssigned(b, '2026-10', food.id, 40000);
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 15000, envelopeId: food.id });
  const s = B.envelopeStatus(b, food.id, '2026-10');
  assert.equal(s.assigned, 40000);
  assert.equal(s.activity, -15000);
  assert.equal(s.available, 25000);
  assert.equal(s.overspent, false);
});

test('overspending is flagged and carries negative into later months', () => {
  const { b, food } = sample();
  B.setAssigned(b, '2026-10', food.id, 10000);
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 25000, envelopeId: food.id });
  assert.equal(B.envelopeStatus(b, food.id, '2026-10').overspent, true);
  assert.equal(B.envelopeStatus(b, food.id, '2026-11').available, -15000);
});

test('goal shows how much is still needed to reach the target balance', () => {
  const { b, fund } = sample();
  B.setAssigned(b, '2026-10', fund.id, 30000);
  assert.equal(B.envelopeStatus(b, fund.id, '2026-10').needed, 70000);
  B.setAssigned(b, '2026-11', fund.id, 90000);
  assert.equal(B.envelopeStatus(b, fund.id, '2026-11').needed, 0);
});

test('monthView groups envelopes by group name', () => {
  const { b } = sample();
  const view = B.monthView(b, '2026-10');
  assert.deepEqual(view.groups.map((g) => g.name), ['Bills', 'Daily', 'Savings']);
});

test('spend requires an existing envelope and positive amount', () => {
  const { b } = sample();
  assert.throws(() => B.addTransaction(b, { kind: 'spend', date: '2026-10-01', amount: 100 }), /Pick an envelope/);
  assert.throws(() => B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 0 }), /greater than zero/);
  assert.throws(() => B.addTransaction(b, { kind: 'income', date: '2026-13-01', amount: 100 }), /YYYY-MM-DD/);
});

test('an envelope with transactions cannot be removed', () => {
  const { b, food } = sample();
  B.addTransaction(b, { kind: 'spend', date: '2026-10-01', amount: 100, envelopeId: food.id });
  assert.throws(() => B.removeEnvelope(b, food.id), /Delete this envelope's transactions/);
});

test('removing an envelope clears its assignments', () => {
  const { b, rent } = sample();
  B.setAssigned(b, '2026-10', rent.id, 5000);
  B.removeEnvelope(b, rent.id);
  assert.equal(b.assignments['2026-10'], undefined);
});

test('shiftMonth wraps across years', () => {
  assert.equal(B.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(B.shiftMonth('2026-12', 1), '2027-01');
});

test('parseMoney handles common separators', () => {
  assert.equal(B.parseMoney('1234.56'), 123456);
  assert.equal(B.parseMoney('1,234.56'), 123456);
  assert.equal(B.parseMoney('1.234,56'), 123456);
  assert.equal(B.parseMoney('12,5'), 1250);
  assert.equal(B.parseMoney('1,234'), 123400);
  assert.equal(B.parseMoney('-40'), -4000);
  assert.equal(B.parseMoney('.'), NaN);
  assert.equal(B.parseMoney('abc'), NaN);
  assert.equal(B.parseMoney(''), NaN);
});

test('fromJSON rejects files that are not backups', () => {
  assert.throws(() => B.fromJSON({ foo: 1 }), /not an Envelo backup/);
  const ok = B.fromJSON({ envelopes: [], transactions: [], assignments: {} });
  assert.equal(ok.currency, 'EUR');
});

test('imports an Actual Budget CSV export', () => {
  const b = B.create();
  const csv = [
    'Account,Date,Payee,Notes,Category,Amount,Split_Amount,Cleared',
    'Checking,2026-10-01,Employer,,Income,2500.00,0,true',
    'Checking,2026-10-03,Market,"weekly, big shop",Groceries,-82.40,0,true',
    'Checking,2026-10-04,Landlord,,Bills: Rent,-900,0,true',
    'Checking,2026-10-05,Transfer : Savings,,,-200,0,true',
    'Checking,2026-10-06,Shop refund,,Groceries,10.00,0,true',
  ].join('\n');
  const r = B.importTransactionsCsv(b, csv);
  assert.equal(r.imported, 4);
  assert.equal(r.income, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.envelopesCreated, 2);
  const rent = b.envelopes.find((e) => e.name === 'Rent');
  assert.equal(rent.group, 'Bills');
  assert.equal(B.readyToAssign(b, '2026-10'), 250000);
  const groc = b.envelopes.find((e) => e.name === 'Groceries');
  assert.equal(B.envelopeStatus(b, groc.id, '2026-10').activity, -7240);
  assert.equal(b.transactions.find((t) => t.payee === 'Market').note, 'weekly, big shop');

  const again = B.importTransactionsCsv(b, csv);
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 4);
});

test('CSV import supports Inflow/Outflow columns and DD/MM/YYYY dates', () => {
  const b = B.create();
  const csv = 'Date,Payee,Category Group,Category,Outflow,Inflow\n13/10/2026,Cafe,Fun,Coffee,3.50,\n';
  const r = B.importTransactionsCsv(b, csv);
  assert.equal(r.imported, 1);
  assert.equal(b.transactions[0].date, '2026-10-13');
  assert.equal(b.transactions[0].amount, -350);
  assert.equal(b.envelopes[0].group, 'Fun');
});

test('CSV import rejects files without the needed columns', () => {
  assert.throws(() => B.importTransactionsCsv(B.create(), 'foo,bar\n1,2'), /Date and Amount/);
});
