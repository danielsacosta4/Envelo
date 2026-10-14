const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/loans.js');

test('monthly payment matches the standard annuity formula', () => {
  // €200,000 over 30 years at 3%: €843.21 a month.
  assert.equal(L.monthlyPayment(20000000, 3, 360), 84321);
  assert.equal(L.monthlyPayment(1200000, 0, 12), 100000);
});

test('a term-based schedule pays off in exactly that many months', () => {
  const s = L.schedule({ principal: 20000000, annualRate: 3, months: 360, startMonth: '2026-11' });
  assert.equal(s.months, 360);
  assert.equal(s.rows[0].interest, 50000);
  assert.equal(s.rows[0].month, '2026-11');
  assert.equal(s.rows.at(-1).balance, 0);
  assert.equal(s.payoffMonth, '2056-10');
  assert.ok(Math.abs(s.totalInterest - 10355600) < 2000); // about €103,556
});

test('extra payments finish sooner and save interest', () => {
  const base = L.schedule({ principal: 20000000, annualRate: 3, months: 360 });
  const fast = L.schedule({ principal: 20000000, annualRate: 3, months: 360, extra: 20000 });
  assert.ok(fast.months < base.months);
  assert.ok(fast.totalInterest < base.totalInterest);
});

test('a variable rate recalculates the payment over the remaining term', () => {
  const s = L.schedule({ principal: 10000000, annualRate: 2, months: 240, rateChanges: [{ after: 12, rate: 4 }] });
  assert.equal(s.months, 240);
  assert.ok(s.rows[12].payment > s.rows[11].payment);
  assert.equal(s.rows[12].rate, 4);
});

test('a payment below the interest never pays off', () => {
  const s = L.schedule({ principal: 10000000, annualRate: 6, payment: 40000 });
  assert.equal(s.neverPaysOff, true);
});

test('loan status from an account: owed, interest paid and payoff', () => {
  const txs = [
    { amount: -15000000, date: '2020-01-01' }, // starting balance
    { amount: 80000, date: '2020-02-01' },
    { amount: 80000, date: '2020-03-01' },
  ];
  const st = L.loanStatus({ rate: 3, payment: 80000, original: 15000000 }, txs, { today: '2026-10-14', extra: 10000 });
  assert.equal(st.owed, 14840000);
  assert.equal(st.principalRepaid, 160000);
  assert.equal(st.interestPaid, 0);
  assert.equal(st.monthlyInterest, 37100);
  assert.equal(st.plan.rows[0].month, '2026-11');
  assert.ok(st.interestSaved > 0 && st.monthsSaved > 0);
});

test('loan details are validated', () => {
  assert.throws(() => L.normalizeLoan({ rate: -1, payment: 100 }), /rate/);
  assert.throws(() => L.normalizeLoan({ rate: 3, payment: 0 }), /payment/);
  assert.deepEqual(L.normalizeLoan({ rate: '3.5', payment: 50000, original: 1000000, startDate: '2024-01-15' }),
    { rate: 3.5, payment: 50000, original: 1000000, startDate: '2024-01-15' });
});
