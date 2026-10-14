// Loan maths: payments, amortization schedules and the state of a tracked
// loan. Pure functions over integer cents, like budget.js, so they can be
// tested without a browser.
//
// Rates are yearly percentages (3.5 means 3.5%), compounded monthly, which is
// how mortgages and personal loans in the eurozone are quoted.

(function (root) {
  const MAX_MONTHS = 1200; // 100 years: anything longer never pays off

  const shiftMonth = (month, delta) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  // Fixed monthly payment that pays `principal` off in `months`.
  function monthlyPayment(principal, annualRate, months) {
    if (!(principal > 0) || !(months > 0)) return 0;
    const r = annualRate / 1200;
    if (r === 0) return Math.ceil(principal / months);
    return Math.ceil((principal * r) / (1 - (1 + r) ** -months));
  }

  // Month by month schedule.
  //   principal    amount owed, cents
  //   annualRate   yearly % at the start
  //   months       term; when set (and payment is not), the payment is worked
  //                out from it and recalculated whenever the rate changes, as
  //                a variable-rate loan does
  //   payment      fixed monthly payment instead of a term
  //   extra        extra paid every month on top of the payment
  //   rateChanges  [{ after: n, rate }]: from month n + 1 on, the rate is `rate`
  //   startMonth   YYYY-MM of the first payment
  function schedule({ principal, annualRate = 0, months = 0, payment = 0, extra = 0, rateChanges = [], startMonth }) {
    const changes = [...rateChanges]
      .filter((c) => Number.isInteger(c.after) && c.after >= 0 && Number.isFinite(c.rate))
      .sort((a, b) => a.after - b.after);
    const termBased = !(payment > 0) && months > 0;
    let pay = termBased ? monthlyPayment(principal, annualRate, months) : Math.round(payment);
    let rate = annualRate;
    let balance = principal;
    const rows = [];
    let totalInterest = 0;
    let totalPaid = 0;
    for (let n = 1; balance > 0 && n <= MAX_MONTHS; n++) {
      const change = changes.filter((c) => c.after === n - 1).pop();
      if (change) {
        rate = change.rate;
        if (termBased) pay = monthlyPayment(balance, rate, Math.max(1, months - (n - 1)));
      }
      const interest = Math.round((balance * rate) / 1200);
      const due = balance + interest;
      const paid = Math.min(due, pay + Math.max(0, extra));
      if (paid <= interest) {
        return { rows, neverPaysOff: true, payment: pay, totalInterest, totalPaid, months: Infinity, payoffMonth: null };
      }
      balance = due - paid;
      totalInterest += interest;
      totalPaid += paid;
      rows.push({
        n,
        month: startMonth ? shiftMonth(startMonth, n - 1) : null,
        rate,
        payment: paid,
        interest,
        principal: paid - interest,
        balance,
      });
    }
    if (balance > 0) {
      return { rows, neverPaysOff: true, payment: pay, totalInterest, totalPaid, months: Infinity, payoffMonth: null };
    }
    const last = rows[rows.length - 1];
    return {
      rows,
      neverPaysOff: false,
      payment: termBased ? monthlyPayment(principal, annualRate, months) : pay,
      totalInterest,
      totalPaid,
      months: rows.length,
      payoffMonth: last ? last.month : startMonth || null,
    };
  }

  // Sum a schedule by year, for a shorter table.
  function byYear(rows) {
    const out = [];
    for (const r of rows) {
      const key = r.month ? r.month.slice(0, 4) : String(Math.ceil(r.n / 12));
      let y = out[out.length - 1];
      if (!y || y.year !== key) {
        y = { year: key, payment: 0, interest: 0, principal: 0, balance: 0 };
        out.push(y);
      }
      y.payment += r.payment;
      y.interest += r.interest;
      y.principal += r.principal;
      y.balance = r.balance;
    }
    return out;
  }

  // Check and clean the loan details stored on an account.
  function normalizeLoan(loan) {
    if (!loan) return null;
    const rate = Number(loan.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Interest rate must be between 0 and 100%.');
    const payment = Number(loan.payment);
    if (!Number.isInteger(payment) || payment <= 0) throw new Error('Monthly payment must be more than zero.');
    const original = loan.original == null || loan.original === '' ? null : Number(loan.original);
    if (original !== null && (!Number.isInteger(original) || original <= 0)) throw new Error('Original amount must be more than zero.');
    const startDate = loan.startDate || null;
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('Start date must be YYYY-MM-DD.');
    return { rate, payment, original, startDate };
  }

  // Where a tracked loan stands. `transactions` are the loan account's own
  // transactions; a loan account's balance is negative while money is owed.
  //   extra: what-if extra payment per month, cents
  function loanStatus(loan, transactions, { today, extra = 0 } = {}) {
    const owed = -transactions.reduce((s, t) => s + t.amount, 0);
    const month = (today || new Date().toISOString().slice(0, 10)).slice(0, 7);
    // Money in (payments) excluding the opening balance.
    const paidIn = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const original = loan.original || null;
    const principalRepaid = original ? Math.max(0, original - owed) : null;
    // Payments that did not reduce the debt went to interest.
    const interestPaid = original ? Math.max(0, paidIn - principalRepaid) : null;
    if (owed <= 0) {
      return { owed: 0, paidOff: true, paidIn, principalRepaid: original, interestPaid, progress: 1 };
    }
    const nextMonth = shiftMonth(month, 1);
    const plan = schedule({ principal: owed, annualRate: loan.rate, payment: loan.payment, startMonth: nextMonth });
    const faster = extra > 0
      ? schedule({ principal: owed, annualRate: loan.rate, payment: loan.payment, extra, startMonth: nextMonth })
      : null;
    return {
      owed,
      paidOff: false,
      paidIn,
      principalRepaid,
      interestPaid,
      progress: original ? Math.min(1, Math.max(0, principalRepaid / original)) : null,
      monthlyInterest: Math.round((owed * loan.rate) / 1200),
      plan,
      faster,
      interestSaved: faster && !plan.neverPaysOff && !faster.neverPaysOff ? plan.totalInterest - faster.totalInterest : null,
      monthsSaved: faster && !plan.neverPaysOff && !faster.neverPaysOff ? plan.months - faster.months : null,
    };
  }

  const api = { monthlyPayment, schedule, byYear, normalizeLoan, loanStatus, shiftMonth };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Loans = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
