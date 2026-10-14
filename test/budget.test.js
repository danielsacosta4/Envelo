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

test('overspending resets to zero next month and comes out of Ready to Assign', () => {
  const { b, food } = sample();
  B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 50000 });
  B.setAssigned(b, '2026-10', food.id, 10000);
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 25000, envelopeId: food.id });
  assert.equal(B.envelopeStatus(b, food.id, '2026-10').overspent, true);
  assert.equal(B.envelopeStatus(b, food.id, '2026-10').available, -15000);
  // October's Ready to Assign is unchanged; November pays for the overspending.
  assert.equal(B.readyToAssign(b, '2026-10'), 40000);
  assert.equal(B.envelopeStatus(b, food.id, '2026-11').available, 0);
  assert.equal(B.envelopeStatus(b, food.id, '2026-11').carryover, 0);
  assert.equal(B.readyToAssign(b, '2026-11'), 25000);
});

test('an envelope can carry its overspending forward instead', () => {
  const { b, food } = sample();
  B.updateEnvelope(b, food.id, { name: 'Groceries', group: 'Daily', carryOverspending: true });
  B.setAssigned(b, '2026-10', food.id, 10000);
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 25000, envelopeId: food.id });
  assert.equal(B.envelopeStatus(b, food.id, '2026-11').available, -15000);
  assert.equal(B.readyToAssign(b, '2026-11'), -10000);
});

test('negative assigned amounts move money back to Ready to Assign', () => {
  const { b, food } = sample();
  B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 10000 });
  B.setAssigned(b, '2026-10', food.id, -500);
  assert.equal(B.readyToAssign(b, '2026-10'), 10500);
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
  assert.throws(() => B.removeEnvelope(b, food.id), /Move or delete this envelope's transactions/);
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

function withTarget(target) {
  const b = B.create();
  const env = B.addEnvelope(b, { name: 'T', group: 'G' });
  B.setTarget(b, env.id, target);
  return { b, id: env.id, st: (m) => B.envelopeStatus(b, env.id, m) };
}

test('monthly target asks for the amount every month, until its end', () => {
  const { b, id, st } = withTarget({ type: 'monthly', amount: 5000, until: '2026-11' });
  assert.equal(st('2026-10').needed, 5000);
  B.setAssigned(b, '2026-10', id, 2000);
  assert.equal(st('2026-10').needed, 3000);
  assert.equal(st('2026-10').underfunded, true);
  B.setAssigned(b, '2026-10', id, 5000);
  assert.equal(st('2026-10').needed, 0);
  assert.equal(st('2026-11').needed, 5000);
  assert.equal(st('2026-12').needed, 0);
});

test('weekly target counts the weekday in the month', () => {
  // October 2026 has 4 Mondays, November 2026 has 5.
  const { st } = withTarget({ type: 'weekly', amount: 2000, weekday: 1 });
  assert.equal(B.weekdaysInMonth('2026-10', 1), 4);
  assert.equal(st('2026-10').needed, 8000);
  assert.equal(B.weekdaysInMonth('2026-11', 1), 5);
  assert.equal(st('2026-11').needed, 10000);
});

test('refill target tops up to the amount, ignoring this month\'s spending', () => {
  const { b, id, st } = withTarget({ type: 'refill', amount: 40000 });
  B.setAssigned(b, '2026-10', id, 40000);
  B.addTransaction(b, { kind: 'spend', date: '2026-10-10', amount: 30000, envelopeId: id });
  assert.equal(st('2026-10').needed, 0);
  // November starts with 100 left, so it needs 300 to refill.
  assert.equal(st('2026-11').needed, 30000);
});

test('balance target needs whatever is missing', () => {
  const { b, id, st } = withTarget({ type: 'balance', amount: 200000 });
  B.setAssigned(b, '2026-10', id, 50000);
  assert.equal(st('2026-10').needed, 150000);
  assert.ok(Math.abs(st('2026-10').progress - 0.25) < 1e-9);
});

test('by-date target spreads the amount and asks more after a missed month', () => {
  const { b, id, st } = withTarget({ type: 'byDate', amount: 120000, date: '2027-03' });
  // Oct..Mar = 6 months
  assert.equal(st('2026-10').needed, 20000);
  B.setAssigned(b, '2026-10', id, 20000);
  // Skip November entirely.
  assert.equal(st('2026-11').needed, 20000);
  // December: 100000 missing over 4 months = 25000
  assert.equal(st('2026-12').needed, 25000);
  // After the date, everything missing is due at once.
  assert.equal(st('2027-05').needed, 100000);
});

test('repeating bill restarts after it is paid', () => {
  const { b, id, st } = withTarget({ type: 'repeating', amount: 48000, every: 12, next: '2027-03' });
  assert.equal(st('2026-10').needed, 8000); // 480 over 6 months
  assert.equal(st('2026-10').due, '2027-03');
  for (const m of ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']) {
    B.setAssigned(b, m, id, 8000);
  }
  B.addTransaction(b, { kind: 'spend', date: '2027-03-15', amount: 48000, envelopeId: id });
  assert.equal(st('2027-04').due, '2028-03');
  assert.equal(st('2027-04').needed, 4000); // 480 over 12 months
});

test('fund all targets assigns what is needed while money lasts', () => {
  const b = B.create();
  const a = B.addEnvelope(b, { name: 'A', target: { type: 'monthly', amount: 30000 } });
  const c = B.addEnvelope(b, { name: 'C', target: { type: 'monthly', amount: 50000 } });
  B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 60000 });
  assert.equal(B.monthView(b, '2026-10').underfunded, 80000);
  assert.equal(B.fundAllTargets(b, '2026-10'), 60000);
  assert.equal(B.assignedIn(b, '2026-10', a.id), 30000);
  assert.equal(B.assignedIn(b, '2026-10', c.id), 30000);
  assert.equal(B.readyToAssign(b, '2026-10'), 0);
});

test('targets validate their fields', () => {
  const b = B.create();
  const e = B.addEnvelope(b, { name: 'X' });
  assert.throws(() => B.setTarget(b, e.id, { type: 'byDate', amount: 100 }), /month/);
  assert.throws(() => B.setTarget(b, e.id, { type: 'monthly', amount: 0 }), /greater than zero/);
  assert.throws(() => B.setTarget(b, e.id, { type: 'repeating', amount: 100, every: 0, next: '2027-01' }), /1 to 120/);
  B.setTarget(b, e.id, null);
  assert.equal(B.envelopeStatus(b, e.id, '2026-10').needed, null);
});

test('accounts: starting balance is income, transfers do not touch the budget', () => {
  const b = B.create();
  const chk = B.addAccount(b, { name: 'Checking', balance: 100000, date: '2026-10-01' });
  const sav = B.addAccount(b, { name: 'Savings', balance: 0 });
  assert.equal(B.readyToAssign(b, '2026-10'), 100000);
  B.addTransaction(b, { kind: 'transfer', date: '2026-10-02', amount: 30000, accountId: chk.id, toAccountId: sav.id });
  assert.equal(B.accountBalance(b, chk.id), 70000);
  assert.equal(B.accountBalance(b, sav.id), 30000);
  assert.equal(B.readyToAssign(b, '2026-10'), 100000);
  // Deleting one leg removes both.
  const leg = b.transactions.find((t) => t.transferId && t.accountId === sav.id);
  B.removeTransaction(b, leg.id);
  assert.equal(b.transactions.filter((t) => t.transferId).length, 0);
});

test('reconcile adds an adjustment for the difference and marks transactions', () => {
  const b = B.create();
  const chk = B.addAccount(b, { name: 'Checking', balance: 50000, date: '2026-10-01' });
  const env = B.addEnvelope(b, { name: 'Food' });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 2000, envelopeId: env.id, accountId: chk.id });
  assert.equal(B.reconcileAccount(b, chk.id, 47500, '2026-10-10'), -500);
  assert.equal(B.accountBalance(b, chk.id), 47500);
  assert.equal(b.accounts[0].reconciledBalance, 47500);
  assert.ok(b.transactions.filter((t) => t.accountId === chk.id).every((t) => t.reconciled));
  assert.equal(B.reconcileAccount(b, chk.id, 47500, '2026-10-11'), 0);
});

test('old budgets get a Main account holding their transactions', () => {
  const old = { envelopes: [], transactions: [{ id: 't', date: '2026-10-01', amount: 100, envelopeId: null }], assignments: {} };
  const b = B.fromJSON(old);
  assert.equal(b.accounts.length, 1);
  assert.equal(b.accounts[0].name, 'Main account');
  assert.equal(b.transactions[0].accountId, b.accounts[0].id);
});

test('envelopes can be renamed, regrouped and deleted with their transactions moved', () => {
  const b = B.create();
  const a = B.addEnvelope(b, { name: 'Food' });
  const c = B.addEnvelope(b, { name: 'Groceries' });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 2000, envelopeId: a.id });
  B.updateEnvelope(b, a.id, { name: 'Eating out', group: 'Fun' });
  assert.equal(b.envelopes[0].name, 'Eating out');
  assert.equal(b.envelopes[0].group, 'Fun');
  assert.throws(() => B.deleteEnvelope(b, a.id, null), /Pick an envelope/);
  B.deleteEnvelope(b, a.id, c.id);
  assert.equal(b.envelopes.length, 1);
  assert.equal(b.transactions[0].envelopeId, c.id);
});

test('transactions can be edited, including changing their type', () => {
  const b = B.create();
  const env = B.addEnvelope(b, { name: 'Food' });
  const t = B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 2000, envelopeId: env.id, payee: 'Shop' });
  B.updateTransaction(b, t.id, { kind: 'spend', date: '2026-10-06', amount: 2500, envelopeId: env.id, payee: 'Market' });
  assert.equal(b.transactions.length, 1);
  assert.equal(b.transactions[0].id, t.id);
  assert.equal(b.transactions[0].amount, -2500);
  assert.equal(b.transactions[0].payee, 'Market');
  B.updateTransaction(b, t.id, { kind: 'income', date: '2026-10-06', amount: 2500 });
  assert.equal(B.transactionKind(b.transactions[0]), 'income');
});

test('recurring transactions are created when due, and month ends are clamped', () => {
  const b = B.create();
  const env = B.addEnvelope(b, { name: 'Rent' });
  B.addRecurring(b, { kind: 'spend', amount: 90000, payee: 'Landlord', envelopeId: env.id, freq: 'monthly', every: 1, next: '2026-01-31' });
  assert.equal(B.applyRecurring(b, '2026-03-15'), 2);
  assert.deepEqual(b.transactions.map((t) => t.date), ['2026-01-31', '2026-02-28']);
  assert.equal(b.recurring[0].next, '2026-03-31');
  assert.equal(B.applyRecurring(b, '2026-03-15'), 0);
  B.addRecurring(b, { kind: 'income', amount: 5000, freq: 'weekly', every: 2, next: '2026-03-02' });
  // Rent on the 31st, plus pay every 2 weeks on the 2nd, 16th and 30th.
  assert.equal(B.applyRecurring(b, '2026-03-31'), 4);
});

test('report sums spending per envelope and income per month', () => {
  const b = B.create();
  const food = B.addEnvelope(b, { name: 'Food' });
  B.addTransaction(b, { kind: 'income', date: '2026-09-01', amount: 100000 });
  B.addTransaction(b, { kind: 'spend', date: '2026-09-10', amount: 3000, envelopeId: food.id });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-10', amount: 5000, envelopeId: food.id });
  const r = B.report(b, '2026-10', 3);
  assert.deepEqual(r.months, ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(r.income, [0, 100000, 0]);
  assert.deepEqual(r.spending, [0, 3000, 5000]);
  assert.equal(r.rows[0].name, 'Food');
  assert.equal(r.rows[0].total, 8000);
});

test('off-budget accounts keep a balance but never touch the budget', () => {
  const b = B.create();
  const chk = B.addAccount(b, { name: 'Checking', balance: 100000, date: '2026-10-01' });
  const loan = B.addAccount(b, { name: 'Mortgage', balance: -20000000, date: '2026-10-01', offBudget: true });
  const inv = B.addAccount(b, { name: 'Investments', balance: 500000, date: '2026-10-01', offBudget: true });
  const env = B.addEnvelope(b, { name: 'Mortgage' });
  // Starting balances of off-budget accounts are not income.
  assert.equal(B.readyToAssign(b, '2026-10'), 100000);
  // Spending inside an off-budget account needs no envelope and changes nothing.
  B.addTransaction(b, { kind: 'spend', date: '2026-10-02', amount: 1000, accountId: inv.id });
  assert.equal(B.readyToAssign(b, '2026-10'), 100000);
  assert.equal(B.accountBalance(b, inv.id), 499000);
  // Paying the mortgage from Checking is spending and needs an envelope.
  assert.throws(() => B.addTransaction(b, { kind: 'transfer', date: '2026-10-03', amount: 50000, accountId: chk.id, toAccountId: loan.id }), /pick an envelope/);
  B.setAssigned(b, '2026-10', env.id, 50000);
  B.addTransaction(b, { kind: 'transfer', date: '2026-10-03', amount: 50000, accountId: chk.id, toAccountId: loan.id, envelopeId: env.id });
  assert.equal(B.envelopeStatus(b, env.id, '2026-10').available, 0);
  assert.equal(B.accountBalance(b, loan.id), -19950000);
  assert.equal(B.readyToAssign(b, '2026-10'), 50000);
  // Money coming into the budget from an off-budget account is income.
  B.addTransaction(b, { kind: 'transfer', date: '2026-10-04', amount: 20000, accountId: inv.id, toAccountId: chk.id });
  assert.equal(B.readyToAssign(b, '2026-10'), 70000);
  // Reports leave off-budget activity out.
  const r = B.report(b, '2026-10', 1);
  assert.deepEqual(r.income, [120000]);
  assert.deepEqual(r.spending, [50000]);
  // Reconciling an off-budget account does not touch Ready to Assign.
  B.reconcileAccount(b, inv.id, 480000, '2026-10-05');
  assert.equal(B.readyToAssign(b, '2026-10'), 70000);
});

test('hidden envelopes and groups stay in totals but not in Fund all targets', () => {
  const b = B.create();
  const a = B.addEnvelope(b, { name: 'Old', group: 'Archive', target: { type: 'monthly', amount: 1000 } });
  const c = B.addEnvelope(b, { name: 'Food', group: 'Daily', target: { type: 'monthly', amount: 2000 } });
  B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 10000 });
  B.setAssigned(b, '2026-10', a.id, 500);
  B.updateEnvelope(b, a.id, { name: 'Old', group: 'Archive', hidden: true });
  assert.equal(B.envelopeStatus(b, a.id, '2026-10').hidden, true);
  assert.equal(B.monthView(b, '2026-10').underfunded, 2000);
  B.fundAllTargets(b, '2026-10');
  assert.equal(B.assignedIn(b, '2026-10', a.id), 500);
  assert.equal(B.assignedIn(b, '2026-10', c.id), 2000);
  assert.equal(B.readyToAssign(b, '2026-10'), 7500);
  B.setGroupHidden(b, 'Daily', true);
  assert.equal(B.envelopeStatus(b, c.id, '2026-10').hidden, true);
  assert.deepEqual(B.fromJSON(JSON.parse(JSON.stringify(b))).hiddenGroups, ['Daily']);
  B.setGroupHidden(b, 'Daily', false);
  assert.equal(B.envelopeStatus(b, c.id, '2026-10').hidden, false);
});

test('account register lists transactions oldest first with a running balance', () => {
  const b = B.create();
  const chk = B.addAccount(b, { name: 'Checking', balance: 10000, date: '2026-10-01' });
  const env = B.addEnvelope(b, { name: 'Food' });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 2500, envelopeId: env.id, accountId: chk.id });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-03', amount: 1000, envelopeId: env.id, accountId: chk.id });
  const reg = B.accountRegister(b, chk.id);
  assert.deepEqual(reg.map((r) => r.t.date), ['2026-10-01', '2026-10-03', '2026-10-05']);
  assert.deepEqual(reg.map((r) => r.balance), [10000, 9000, 6500]);
});
