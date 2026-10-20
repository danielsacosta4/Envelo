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
  assert.equal(a.name, 'Eating out');
  assert.equal(a.group, 'Fun');
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

test('net worth series splits on and off budget at each month end', () => {
  const b = B.create();
  B.addAccount(b, { name: 'Checking', balance: 100000, date: '2026-09-15' });
  const loan = B.addAccount(b, { name: 'Loan', balance: -500000, date: '2026-10-02', offBudget: true });
  B.addTransaction(b, { kind: 'income', date: '2026-10-20', amount: 5000, accountId: loan.id });
  const s = B.netWorthSeries(b, ['2026-09', '2026-10']);
  assert.deepEqual(s.map((x) => [x.onBudget, x.offBudget, x.total]), [[100000, 0, 100000], [100000, -495000, -395000]]);
});

test('group spending folds small groups into Other', () => {
  const b = B.create();
  const names = ['A', 'B', 'C'];
  names.forEach((g, i) => {
    const e = B.addEnvelope(b, { name: `E${g}`, group: g });
    B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 1000 * (i + 1), envelopeId: e.id });
  });
  const r = B.groupSpending(b, ['2026-10'], 2);
  assert.deepEqual(r.map((x) => [x.name, x.values[0]]), [['C', 3000], ['B', 2000], ['Other', 1000]]);
});

test('month forecast projects spending pace and flags envelopes at risk', () => {
  const b = B.create();
  const food = B.addEnvelope(b, { name: 'Food' });
  const fun = B.addEnvelope(b, { name: 'Fun' });
  B.setAssigned(b, '2026-10', food.id, 30000);
  B.setAssigned(b, '2026-10', fun.id, 30000);
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 15000, envelopeId: food.id });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 2000, envelopeId: fun.id });
  // Day 10 of 31: Food has spent 150, on pace for 465, with 150 left -> short 165.
  const f = B.monthForecast(b, '2026-10', '2026-10-10');
  assert.equal(f.spent, 17000);
  assert.equal(f.atRisk.length, 1);
  assert.equal(f.atRisk[0].name, 'Food');
  assert.equal(f.atRisk[0].short, 16500);
  assert.equal(B.monthForecast(b, '2026-09', '2026-10-10'), null);
});

test('target forecasts estimate when savings targets are reached', () => {
  const b = B.create();
  const fund = B.addEnvelope(b, { name: 'Emergency', target: { type: 'byDate', amount: 120000, date: '2027-03' } });
  for (const m of ['2026-08', '2026-09', '2026-10']) B.setAssigned(b, m, fund.id, 10000);
  const [f] = B.targetForecasts(b, '2026-10');
  assert.equal(f.rate, 10000);
  assert.equal(f.remaining, 90000);
  assert.equal(f.eta, '2027-07');
  assert.equal(f.onTrack, false);
});

test('a brand-new budget has every list the app reads', () => {
  const b = B.create();
  for (const key of ['accounts', 'envelopes', 'transactions', 'recurring', 'hiddenGroups']) assert.ok(Array.isArray(b[key]), key);
  assert.deepEqual(B.monthView(b, '2026-10').groups, []);
});

test('goals track accounts, envelopes or net worth', () => {
  const b = B.create();
  const checking = B.addAccount(b, { name: 'Checking', balance: 100000, date: '2026-08-01' });
  const savings = B.addAccount(b, { name: 'Savings', balance: 200000, date: '2026-08-01', offBudget: true });
  const fund = B.addEnvelope(b, { name: 'Emergency', group: 'Savings' });
  B.setAssigned(b, '2026-08', fund.id, 30000);
  B.setAssigned(b, '2026-09', fund.id, 30000);
  B.setAssigned(b, '2026-10', fund.id, 30000);
  const g1 = B.addGoal(b, { name: 'Cushion', amount: 400000, source: 'accounts', ids: [savings.id] });
  const g2 = B.addGoal(b, { name: 'Emergency', amount: 180000, source: 'envelopes', ids: [fund.id], by: '2027-01' });
  const g3 = B.addGoal(b, { name: 'Worth', amount: 600000, source: 'networth' });
  const s1 = B.goalStatus(b, g1, '2026-10');
  assert.equal(s1.value, 200000);
  assert.equal(s1.milestone, 50);
  const s2 = B.goalStatus(b, g2, '2026-10');
  assert.equal(s2.value, 90000);
  assert.equal(s2.rate, 30000);
  assert.equal(s2.eta, '2027-01');
  assert.equal(s2.neededPerMonth, 30000);
  assert.equal(s2.onTrack, true);
  assert.equal(s2.milestones.find((m) => m.percent === 25).month, '2026-09');
  assert.equal(B.goalStatus(b, g3, '2026-10').value, 300000);
  assert.ok(checking);
});

test('goals are validated and survive a reload', () => {
  const b = B.create();
  assert.throws(() => B.addGoal(b, { name: '', amount: 100, source: 'networth' }), /name/);
  assert.throws(() => B.addGoal(b, { name: 'X', amount: 100, source: 'accounts', ids: [] }), /account/);
  B.addGoal(b, { name: 'House', amount: 5000000, source: 'networth', by: '2030-01' });
  const copy = B.fromJSON(JSON.parse(JSON.stringify(b)));
  assert.equal(copy.goals.length, 1);
  assert.equal(copy.goals[0].by, '2030-01');
});

test('groups get distinct colours, neighbours never match, and choices are kept', () => {
  const b = B.create();
  for (let i = 0; i < 20; i++) B.addEnvelope(b, { name: `E${i}`, group: `G${i}` });
  assert.equal(B.ensureGroupColors(b), true);
  const names = B.groupNames(b);
  const colors = names.map((n) => b.groupColors[n]);
  assert.equal(new Set(colors.slice(0, 16)).size, 16);
  for (let i = 1; i < colors.length; i++) assert.notEqual(colors[i], colors[i - 1]);
  B.setGroupColor(b, 'G3', 7);
  assert.equal(B.ensureGroupColors(b), false);
  assert.equal(b.groupColors.G3, 7);
  assert.throws(() => B.setGroupColor(b, 'G3', 16), /colour/);
  const copy = B.fromJSON(JSON.parse(JSON.stringify(b)));
  assert.equal(copy.groupColors.G3, 7);
});

test('split transactions spread one purchase over envelopes and delete together', () => {
  const { b, rent, food } = sample();
  B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 100000 });
  const first = B.addSplit(b, { date: '2026-10-05', payee: 'Hipermercado', lines: [{ envelopeId: food.id, amount: 3000 }, { envelopeId: rent.id, amount: 1500 }] });
  assert.equal(B.envelopeStatus(b, food.id, '2026-10').activity, -3000);
  assert.equal(B.envelopeStatus(b, rent.id, '2026-10').activity, -1500);
  assert.equal(B.splitLegs(b, first.id).length, 2);
  assert.throws(() => B.addSplit(b, { date: '2026-10-05', lines: [{ envelopeId: food.id, amount: 100 }] }), /two lines/);
  B.removeTransaction(b, first.id);
  assert.equal(b.transactions.length, 1);
});

test('moving money between envelopes and to Ready to Assign', () => {
  const { b, rent, food } = sample();
  B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 100000 });
  B.setAssigned(b, '2026-10', rent.id, 50000);
  B.moveMoney(b, '2026-10', rent.id, food.id, 20000);
  assert.equal(B.assignedIn(b, '2026-10', rent.id), 30000);
  assert.equal(B.assignedIn(b, '2026-10', food.id), 20000);
  B.moveMoney(b, '2026-10', null, food.id, 10000);
  assert.equal(B.readyToAssign(b, '2026-10'), 40000);
  B.moveMoney(b, '2026-10', food.id, null, 30000);
  assert.equal(B.assignedIn(b, '2026-10', food.id), 0);
  assert.throws(() => B.moveMoney(b, '2026-10', food.id, food.id, 1), /different/);
});

test('payee memory suggests the last envelope and search finds transactions', () => {
  const { b, food, rent } = sample();
  B.addTransaction(b, { kind: 'spend', date: '2026-09-01', amount: 1000, payee: 'Lidl', envelopeId: rent.id });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-01', amount: 2340, payee: 'Lidl', envelopeId: food.id, note: 'weekly shop' });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-02', amount: 500, payee: 'Galp', envelopeId: rent.id });
  assert.deepEqual(B.payees(b).slice(0, 2), ['Lidl', 'Galp']);
  assert.equal(B.payeeMemory(b, ' lidl ').envelopeId, food.id);
  assert.equal(B.payeeMemory(b, 'nobody'), null);
  assert.equal(B.searchTransactions(b, { q: 'weekly' }).length, 1);
  assert.equal(B.searchTransactions(b, { q: '23,4' }).length, 1);
  assert.equal(B.searchTransactions(b, { envelopeId: rent.id }).length, 2);
  assert.equal(B.searchTransactions(b, { from: '2026-10-01' }).length, 2);
});

test('recap and streaks describe a month, including overspending', () => {
  const { b, food, rent } = sample();
  for (const m of ['07', '08', '09', '10']) {
    B.addTransaction(b, { kind: 'income', date: `2026-${m}-01`, amount: 100000 });
    B.setAssigned(b, `2026-${m}`, food.id, 20000);
    B.setAssigned(b, `2026-${m}`, rent.id, 80000);
    B.addTransaction(b, { kind: 'spend', date: `2026-${m}-10`, amount: 26000, envelopeId: food.id, payee: 'Shop' });
  }
  const r = B.recap(b, '2026-10');
  assert.equal(r.income, 100000);
  assert.equal(r.spending, 26000);
  assert.equal(r.overspent[0].name, 'Groceries');
  assert.equal(r.overspent[0].amount, 6000);
  assert.equal(r.hints[0].name, 'Groceries');
  assert.equal(r.hints[0].suggest, 26000);
  const s = B.streaks(b, '2026-10');
  assert.equal(s.noOverspending, 0);
  assert.equal(s.saving, 4);
});

test('groups and envelopes can be reordered', () => {
  const { b, rent, food } = sample();
  const water = B.addEnvelope(b, { name: 'Water', group: 'Bills' });
  const names = () => b.envelopes.map((e) => e.name).join(',');
  assert.equal(names(), 'Rent,Groceries,Emergency,Water');
  assert.deepEqual(B.monthView(b, '2026-10').groups.map((g) => g.name), ['Bills', 'Daily', 'Savings']);
  assert.ok(B.moveGroup(b, 'Savings', -1));
  assert.deepEqual(B.monthView(b, '2026-10').groups.map((g) => g.name), ['Bills', 'Savings', 'Daily']);
  assert.equal(B.moveGroup(b, 'Bills', -1), false);
  assert.ok(B.moveEnvelope(b, water.id, -1));
  assert.deepEqual(B.monthView(b, '2026-10').groups[0].envelopes.map((e) => e.name), ['Water', 'Rent']);
  assert.equal(B.moveEnvelope(b, water.id, -1), false);
  assert.equal(B.moveEnvelope(b, food.id, 1), false);
  // Moving to another group puts it at the end of that group.
  B.updateEnvelope(b, rent.id, { name: 'Rent', group: 'Daily' });
  assert.deepEqual(B.monthView(b, '2026-10').groups.map((g) => [g.name, g.envelopes.map((e) => e.name).join('+')]),
    [['Bills', 'Water'], ['Savings', 'Emergency'], ['Daily', 'Groceries+Rent']]);
});

test('sub-envelopes live in their parent group and move with it', () => {
  const { b, rent, food, fund } = sample();
  const veg = B.addEnvelope(b, { name: 'Vegetables', group: 'Ignored', parentId: food.id });
  const meat = B.addEnvelope(b, { name: 'Meat', parentId: food.id });
  assert.equal(veg.group, 'Daily');
  assert.equal(B.envelopeStatus(b, meat.id, '2026-10').parentId, food.id);
  assert.equal(b.envelopes.map((e) => e.name).join(','), 'Rent,Groceries,Vegetables,Meat,Emergency');
  assert.throws(() => B.addEnvelope(b, { name: 'X', parentId: veg.id }), /own sub-envelopes/);
  assert.throws(() => B.updateEnvelope(b, food.id, { name: 'Groceries', group: 'Daily', parentId: rent.id }), /has sub-envelopes/);
  B.moveEnvelope(b, meat.id, -1);
  assert.equal(b.envelopes.map((e) => e.name).join(','), 'Rent,Groceries,Meat,Vegetables,Emergency');
  // The parent changes group: the family moves together.
  B.updateEnvelope(b, food.id, { name: 'Groceries', group: 'Savings' });
  assert.equal(b.envelopes.map((e) => `${e.name}:${e.group}`).join(','), 'Rent:Bills,Emergency:Savings,Groceries:Savings,Meat:Savings,Vegetables:Savings');
  // Hiding the parent hides its sub-envelopes.
  B.updateEnvelope(b, food.id, { name: 'Groceries', group: 'Savings', hidden: true });
  assert.equal(B.envelopeStatus(b, veg.id, '2026-10').hidden, true);
  // Out of the parent, then deleting the parent frees the rest.
  B.updateEnvelope(b, veg.id, { name: 'Vegetables', group: 'Bills', parentId: null });
  assert.equal(veg.parentId, undefined);
  assert.equal(veg.group, 'Bills');
  B.deleteEnvelope(b, food.id, null);
  assert.equal(meat.parentId, undefined);
  assert.ok(fund);
});

test('future transactions wait for their date and count nowhere until then', () => {
  const { b, food } = sample();
  B.addAccount(b, { name: 'Bank', balance: 0 });
  B.addRecurring(b, { kind: 'income', freq: 'once', amount: 200000, payee: 'Bonus', next: '2026-11-05' });
  B.addRecurring(b, { kind: 'spend', freq: 'once', amount: 3000, payee: 'Concert', envelopeId: food.id, next: '2026-10-20', receiptId: 'r1', receiptType: 'pdf', receiptName: 'ticket.pdf' });
  B.addRecurring(b, { kind: 'spend', freq: 'monthly', amount: 1000, payee: 'Phone', envelopeId: food.id, next: '2026-10-25' });
  assert.equal(B.applyRecurring(b, '2026-10-18'), 0);
  assert.equal(B.readyToAssign(b, '2026-11'), 0);
  const up = B.upcoming(b, '2026-10-18', '2026-11-30');
  assert.deepEqual(up.map((u) => [u.date, u.payee, u.amount]), [
    ['2026-10-20', 'Concert', -3000], ['2026-10-25', 'Phone', -1000], ['2026-11-05', 'Bonus', 200000], ['2026-11-25', 'Phone', -1000],
  ]);
  assert.equal(B.applyRecurring(b, '2026-10-21'), 1);
  const concert = b.transactions.find((t) => t.payee === 'Concert');
  assert.equal(concert.receiptType, 'pdf');
  assert.equal(concert.recurringId, undefined);
  assert.equal(b.recurring.length, 2);
  const bonus = b.recurring.find((r) => r.payee === 'Bonus');
  B.updateRecurring(b, bonus.id, { ...bonus, amount: 250000 });
  B.applyRecurring(b, '2026-11-06');
  // October went 4,000 overspent, which comes out of November.
  assert.equal(B.readyToAssign(b, "2026-11"), 246000);
  assert.equal(b.recurring.length, 1);
  assert.throws(() => B.addRecurring(b, { kind: 'transfer', freq: 'monthly', amount: 1, next: '2026-12-01' }), /cannot repeat/);
});

test('transfers imported from two bank files are found and linked', () => {
  const { b, food } = sample();
  const main = B.addAccount(b, { name: 'Main', balance: 0 });
  const save = B.addAccount(b, { name: 'Savings', balance: 0 });
  const t = (accountId, date, amount, envelopeId = null) => {
    const tx = { id: `${accountId}-${date}-${amount}`, date, payee: 'x', note: '', amount, envelopeId, accountId, importKey: 'bank:k' };
    b.transactions.push(tx);
    return tx;
  };
  t(main.id, '2026-10-01', 300000);
  const out = t(main.id, '2026-10-03', -50000, food.id);
  const inn = t(save.id, '2026-10-05', 50000);
  t(save.id, '2026-10-30', 2000); // too far from anything
  assert.equal(B.readyToAssign(b, '2026-10'), 350000 + 2000);
  const pairs = B.findTransferPairs(b);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].outId, pairs[0].inId], [out.id, inn.id]);
  B.linkTransfer(b, out.id, inn.id);
  assert.equal(B.readyToAssign(b, '2026-10'), 302000);
  assert.equal(B.envelopeStatus(b, food.id, '2026-10').activity, 0);
  assert.equal(B.findTransferPairs(b).length, 0);
});

test('history imported before a starting balance is not counted twice', () => {
  const b = B.create();
  const acct = B.addAccount(b, { name: 'Bank', balance: 100000, date: '2026-10-20' });
  const rows = [
    { date: '2026-10-01', amount: 250000, payee: 'Salary' },
    { date: '2026-10-10', amount: -40000, payee: 'Shop' },
    { date: '2026-10-21', amount: -1000, payee: 'Cafe' },
  ];
  const o = B.startingBalanceOverlap(b, acct.id, rows);
  assert.equal(o.count, 2);
  assert.equal(o.overlap, 210000);
  assert.equal(o.newAmount, -110000);
  assert.equal(o.newDate, '2026-09-30');
  for (const r of rows) b.transactions.push({ id: r.payee, ...r, note: '', envelopeId: null, accountId: acct.id, importKey: `bank:${r.payee}` });
  assert.equal(B.accountBalance(b, acct.id), 309000);
  B.fixStartingBalance(b, acct.id);
  // Back to the bank's balance on the 20th, minus the coffee after it.
  assert.equal(B.accountBalance(b, acct.id), 99000);
  assert.equal(B.startingBalanceOverlap(b, acct.id), null);
});

test('all or only imported transactions of an account can be deleted at once', () => {
  const { b, food } = sample();
  const main = B.addAccount(b, { name: 'Main', balance: 10000, date: '2026-09-01' });
  const save = B.addAccount(b, { name: 'Savings', balance: 0 });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-02', amount: 500, envelopeId: food.id, accountId: main.id });
  b.transactions.push({ id: 'imp', date: '2026-10-05', payee: 'Shop', note: '', amount: -700, envelopeId: food.id, accountId: main.id, importKey: 'bank:x' });
  B.addTransaction(b, { kind: 'transfer', date: '2026-10-06', amount: 1000, accountId: main.id, toAccountId: save.id });
  B.addSplit(b, { date: '2026-10-07', payee: 'Mixed', accountId: main.id, lines: [{ envelopeId: food.id, amount: 100 }, { envelopeId: food.id, amount: 200 }] });
  assert.equal(B.accountTransactionsToDelete(b, main.id, { only: 'imported' }).length, 1);
  assert.equal(B.deleteAccountTransactions(b, main.id, { only: 'imported' }), 1);
  assert.equal(B.accountTransactionsToDelete(b, main.id, { from: '2026-10-06' }).length, 3);
  // Everything but the starting balance; the transfer's other half goes too.
  assert.equal(B.deleteAccountTransactions(b, main.id), 5);
  assert.deepEqual(b.transactions.map((t) => t.payee), ['Starting balance']);
  assert.equal(B.deleteAccountTransactions(b, main.id, { keepStart: false }), 1);
  assert.equal(b.transactions.length, 0);
});

test('uncategorised imported spending comes off Ready to Assign at once', () => {
  const b = B.create();
  const acct = B.addAccount(b, { name: 'Bank', balance: 0 });
  const inbox = B.addEnvelope(b, { name: '📥 To categorise', group: 'Imported' });
  const food = B.addEnvelope(b, { name: 'Food', group: 'Daily' });
  B.addTransaction(b, { kind: 'income', date: '2026-10-01', amount: 100000, accountId: acct.id });
  B.addTransaction(b, { kind: 'spend', date: '2026-10-05', amount: 30000, envelopeId: inbox.id, accountId: acct.id });
  // The money is gone: 700 left, not 1000.
  assert.equal(B.readyToAssign(b, '2026-10'), 70000);
  const st = B.envelopeStatus(b, inbox.id, '2026-10');
  assert.equal(st.inbox, true);
  assert.equal(st.available, 0);
  assert.equal(st.activity, -30000);
  assert.equal(B.readyToAssign(b, '2026-11'), 70000);
  // Normal envelopes keep the usual rule: overspending comes off next month.
  B.addTransaction(b, { kind: 'spend', date: '2026-10-06', amount: 5000, envelopeId: food.id, accountId: acct.id });
  assert.equal(B.readyToAssign(b, '2026-10'), 70000);
  assert.equal(B.readyToAssign(b, '2026-11'), 65000);
});
