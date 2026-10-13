// Envelope budgeting core. Pure functions over a plain data object so the
// math can be tested without a browser. All money is integer cents.
//
// Model:
//   - Income transactions (no envelope) fill "Ready to Assign".
//   - Assignments move Ready to Assign into an envelope for a given month.
//   - Spending transactions draw an envelope down (stored as negative cents).
//   - An envelope's available balance is everything assigned to it plus all
//     of its activity, up to and including the month being viewed. Unspent
//     money rolls over automatically; nothing ever resets.

(function (root) {
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  const newId = () =>
    (globalThis.crypto && globalThis.crypto.randomUUID)
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);

  const monthOf = (date) => date.slice(0, 7);

  function create() {
    return { version: 1, currency: 'EUR', envelopes: [], transactions: [], assignments: {} };
  }

  function addEnvelope(b, { name, group, goal }) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Envelope needs a name.');
    const target = goal == null || goal === '' ? null : Number(goal);
    if (target !== null && (!Number.isInteger(target) || target <= 0)) {
      throw new Error('Goal must be a positive amount.');
    }
    const env = {
      id: newId(),
      name: clean,
      group: String(group || '').trim() || 'General',
      goal: target,
    };
    b.envelopes.push(env);
    return env;
  }

  function removeEnvelope(b, id) {
    if (b.transactions.some((t) => t.envelopeId === id)) {
      throw new Error("Delete this envelope's transactions first.");
    }
    b.envelopes = b.envelopes.filter((e) => e.id !== id);
    for (const m of Object.keys(b.assignments)) {
      delete b.assignments[m][id];
      if (!Object.keys(b.assignments[m]).length) delete b.assignments[m];
    }
  }

  // kind: 'spend' draws from an envelope; 'income' adds to Ready to Assign.
  // amount: positive integer cents.
  function addTransaction(b, { kind, date, payee, amount, envelopeId, note }) {
    if (!DATE_RE.test(date || '')) throw new Error('Date must be YYYY-MM-DD.');
    const cents = Number(amount);
    if (!Number.isInteger(cents) || cents <= 0) throw new Error('Amount must be greater than zero.');

    let signed;
    let envId = null;
    if (kind === 'income') {
      signed = cents;
    } else if (kind === 'spend') {
      if (!b.envelopes.some((e) => e.id === envelopeId)) throw new Error('Pick an envelope.');
      signed = -cents;
      envId = envelopeId;
    } else {
      throw new Error('Unknown transaction type.');
    }

    const t = {
      id: newId(),
      date,
      payee: String(payee || '').trim(),
      note: String(note || '').trim(),
      amount: signed,
      envelopeId: envId,
    };
    b.transactions.push(t);
    return t;
  }

  function removeTransaction(b, id) {
    b.transactions = b.transactions.filter((t) => t.id !== id);
  }

  function assignedIn(b, month, envId) {
    return (b.assignments[month] || {})[envId] || 0;
  }

  function setAssigned(b, month, envId, cents) {
    if (!MONTH_RE.test(month)) throw new Error('Bad month.');
    if (!b.envelopes.some((e) => e.id === envId)) throw new Error('Unknown envelope.');
    if (!Number.isInteger(cents) || cents < 0) throw new Error('Assignment cannot be negative.');
    const row = (b.assignments[month] ||= {});
    if (cents === 0) {
      delete row[envId];
      if (!Object.keys(row).length) delete b.assignments[month];
    } else {
      row[envId] = cents;
    }
  }

  // Money income through the end of `month`, minus everything assigned through `month`.
  // Negative means you have assigned more than you have.
  function readyToAssign(b, month) {
    const income = b.transactions
      .filter((t) => !t.envelopeId && monthOf(t.date) <= month)
      .reduce((sum, t) => sum + t.amount, 0);
    let assigned = 0;
    for (const m of Object.keys(b.assignments)) {
      if (m <= month) for (const v of Object.values(b.assignments[m])) assigned += v;
    }
    return income - assigned;
  }

  function envelopeStatus(b, envId, month) {
    const env = b.envelopes.find((e) => e.id === envId);
    if (!env) throw new Error('Unknown envelope.');

    let assignedToDate = 0;
    for (const m of Object.keys(b.assignments)) {
      if (m <= month) assignedToDate += b.assignments[m][envId] || 0;
    }

    let activityToDate = 0;
    let activityThisMonth = 0;
    for (const t of b.transactions) {
      if (t.envelopeId !== envId) continue;
      const m = monthOf(t.date);
      if (m <= month) activityToDate += t.amount;
      if (m === month) activityThisMonth += t.amount;
    }

    const available = assignedToDate + activityToDate;
    const assigned = assignedIn(b, month, envId);
    return {
      id: env.id,
      name: env.name,
      group: env.group,
      goal: env.goal,
      carryover: available - assigned - activityThisMonth,
      assigned,
      activity: activityThisMonth,
      available,
      overspent: available < 0,
      // How much more is needed to reach the target balance (null if no goal).
      needed: env.goal == null ? null : Math.max(0, env.goal - available),
    };
  }

  function monthView(b, month) {
    const groups = new Map();
    for (const env of b.envelopes) {
      const status = envelopeStatus(b, env.id, month);
      if (!groups.has(status.group)) groups.set(status.group, []);
      groups.get(status.group).push(status);
    }
    return {
      month,
      readyToAssign: readyToAssign(b, month),
      groups: [...groups].map(([name, envelopes]) => ({ name, envelopes })),
    };
  }

  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  // Accepts "1234.56", "1,234.56", "1.234,56", "12,5", "-40". Returns cents or NaN.
  function parseMoney(text) {
    const s = String(text ?? '').trim().replace(/\s/g, '');
    const m = s.match(/^(-?[\d.,]*?)(?:[.,](\d{1,2}))?$/);
    if (!m || !/\d/.test(m[1])) return NaN;
    const neg = m[1].startsWith('-');
    const digits = m[1].replace(/[-.,]/g, '');
    const frac = Number((m[2] || '').padEnd(2, '0'));
    const cents = Number(digits) * 100 + frac;
    return neg ? -cents : cents;
  }

  function formatMoney(cents, currency = 'EUR') {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  }

  function toInput(cents) {
    return (cents / 100).toFixed(2);
  }

  function fromJSON(obj) {
    if (!obj || !Array.isArray(obj.envelopes) || !Array.isArray(obj.transactions)
        || !obj.assignments || typeof obj.assignments !== 'object') {
      throw new Error('This file is not an Envelo backup.');
    }
    return {
      version: 1,
      currency: obj.currency || 'EUR',
      envelopes: obj.envelopes,
      transactions: obj.transactions,
      assignments: obj.assignments,
    };
  }

  const api = {
    create, addEnvelope, removeEnvelope, addTransaction, removeTransaction,
    setAssigned, assignedIn, readyToAssign, envelopeStatus, monthView,
    shiftMonth, parseMoney, formatMoney, toInput, fromJSON,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Budget = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
