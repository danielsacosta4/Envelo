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

  function addEnvelope(b, { name, group, goal, target }) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Envelope needs a name.');
    let t = target ? normalizeTarget(target) : null;
    if (!t && goal != null && goal !== '') t = normalizeTarget({ type: 'balance', amount: Number(goal) });
    const env = {
      id: newId(),
      name: clean,
      group: String(group || '').trim() || 'General',
      target: t,
    };
    b.envelopes.push(env);
    return env;
  }

  // Targets
  //   monthly   { amount, until? }      set aside `amount` every month (until a month, optional)
  //   weekly    { amount, weekday }     set aside `amount` for each weekday 0-6 (0 = Sunday) in the month
  //   refill    { amount }              top the envelope up to `amount` every month
  //   balance   { amount }              have `amount` in the envelope, no deadline
  //   byDate    { amount, date }        have `amount` by `date` (YYYY-MM), spread over the months left
  //   repeating { amount, every, next } a bill of `amount` due every `every` months, next due `next`
  // Shortfalls from earlier months are spread over the months left, so a skipped
  // month raises what later months ask for.
  const TARGET_TYPES = ['monthly', 'weekly', 'refill', 'balance', 'byDate', 'repeating'];

  function normalizeTarget(t) {
    if (!t || !TARGET_TYPES.includes(t.type)) throw new Error('Pick a target type.');
    const amount = Number(t.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Target amount must be greater than zero.');
    const out = { type: t.type, amount };
    if (t.type === 'monthly' && t.until) {
      if (!MONTH_RE.test(t.until)) throw new Error('Until must be a month.');
      out.until = t.until;
    }
    if (t.type === 'weekly') {
      const wd = Number(t.weekday);
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new Error('Pick a day of the week.');
      out.weekday = wd;
    }
    if (t.type === 'byDate') {
      if (!MONTH_RE.test(t.date || '')) throw new Error('Pick the month you want to reach the target.');
      out.date = t.date;
    }
    if (t.type === 'repeating') {
      const every = Number(t.every);
      if (!Number.isInteger(every) || every < 1 || every > 120) throw new Error('Repeat every 1 to 120 months.');
      if (!MONTH_RE.test(t.next || '')) throw new Error('Pick the month the bill is next due.');
      out.every = every;
      out.next = t.next;
    }
    return out;
  }

  function setTarget(b, envId, target) {
    const env = b.envelopes.find((e) => e.id === envId);
    if (!env) throw new Error('Unknown envelope.');
    env.target = target ? normalizeTarget(target) : null;
    delete env.goal;
  }

  const monthsBetween = (a, b) => {
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return (by - ay) * 12 + (bm - am);
  };

  function weekdaysInMonth(month, weekday) {
    const [y, m] = month.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let n = 0;
    for (let d = 1; d <= days; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === weekday) n++;
    return n;
  }

  // Next due month on or after `month` for a repeating bill.
  function nextDue(t, month) {
    let due = t.next;
    while (due < month) due = shiftMonth(due, t.every);
    return due;
  }

  // What the target asks for this month, given the envelope's balance at the
  // start of the month (carryover) and what is assigned this month.
  function targetNeed(t, month, carryover, assigned) {
    const ceilDiv = (a, n) => Math.ceil(a / n);
    switch (t.type) {
      case 'monthly': {
        if (t.until && month > t.until) return { needed: 0, monthAmount: 0 };
        return { needed: Math.max(0, t.amount - assigned), monthAmount: t.amount };
      }
      case 'weekly': {
        const monthAmount = t.amount * weekdaysInMonth(month, t.weekday);
        return { needed: Math.max(0, monthAmount - assigned), monthAmount };
      }
      case 'refill':
      case 'balance':
        return { needed: Math.max(0, t.amount - carryover - assigned), monthAmount: null };
      case 'byDate':
      case 'repeating': {
        const due = t.type === 'byDate' ? t.date : nextDue(t, month);
        const monthsLeft = Math.max(1, monthsBetween(month, due) + 1);
        const missing = Math.max(0, t.amount - carryover);
        const perMonth = ceilDiv(missing, monthsLeft);
        return { needed: Math.max(0, perMonth - assigned), monthAmount: perMonth, due };
      }
      default:
        return { needed: 0, monthAmount: null };
    }
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
    const carryover = available - assigned - activityThisMonth;
    const target = envTarget(env);
    const need = target ? targetNeed(target, month, carryover, assigned) : null;
    let progress = null;
    if (target) {
      const goalAmount = ['monthly', 'weekly'].includes(target.type) ? need.monthAmount : target.amount;
      const have = ['monthly', 'weekly'].includes(target.type) ? assigned
        : target.type === 'refill' ? carryover + assigned
        : available;
      progress = goalAmount ? Math.max(0, Math.min(1, have / goalAmount)) : 1;
    }
    return {
      id: env.id,
      name: env.name,
      group: env.group,
      target,
      carryover,
      assigned,
      activity: activityThisMonth,
      available,
      overspent: available < 0,
      // What the target still asks for this month (null when there is no target).
      needed: need ? need.needed : null,
      underfunded: !!need && need.needed > 0,
      monthAmount: need ? need.monthAmount : null,
      due: need ? need.due || null : null,
      progress,
    };
  }

  // Older data stored a plain goal balance on the envelope.
  function envTarget(env) {
    if (env.target) return env.target;
    if (env.goal) return { type: 'balance', amount: env.goal };
    return null;
  }

  // Assign what each underfunded target needs, in order, while Ready to Assign
  // has money. Returns the total assigned.
  function fundAllTargets(b, month) {
    let left = readyToAssign(b, month);
    let total = 0;
    for (const env of b.envelopes) {
      if (left <= 0) break;
      const st = envelopeStatus(b, env.id, month);
      if (!st.underfunded) continue;
      const give = Math.min(st.needed, left);
      setAssigned(b, month, env.id, st.assigned + give);
      left -= give;
      total += give;
    }
    return total;
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
      underfunded: [...groups.values()].flat().reduce((sum, e) => sum + (e.needed || 0), 0),
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

  // Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const src = String(text).replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((f) => f !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
    return rows;
  }

  const INCOME_CATEGORIES = ['income', 'to budget', 'ready to assign', 'inflow: ready to assign', 'starting balances'];

  // Import transactions exported from Actual Budget (Account > Export) or any
  // CSV with Date, Payee, Category, Amount columns. Optional: Notes, Category
  // Group, Account, Inflow/Outflow (instead of Amount).
  // Budgeted amounts are not part of the export, so assign money afterwards.
  function importTransactionsCsv(b, text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('The file has no transactions.');
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
    const iDate = col('date');
    const iPayee = col('payee');
    const iNotes = col('notes', 'memo');
    const iCat = col('category');
    const iGroup = col('category group', 'category_group', 'group');
    const iAmount = col('amount');
    const iIn = col('inflow');
    const iOut = col('outflow');
    if (iDate < 0 || (iAmount < 0 && iIn < 0 && iOut < 0)) {
      throw new Error('The CSV needs at least Date and Amount columns.');
    }

    const seen = new Set(b.transactions.map((t) => t.importKey).filter(Boolean));
    const byName = new Map(b.envelopes.map((e) => [e.name.toLowerCase(), e]));
    const result = { imported: 0, income: 0, duplicates: 0, skipped: 0, envelopesCreated: 0 };

    for (const r of rows.slice(1)) {
      const get = (i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
      const date = normalizeDate(get(iDate));
      let cents;
      if (iAmount >= 0) cents = parseMoney(get(iAmount));
      else cents = (parseMoney(get(iIn) || '0') || 0) - (parseMoney(get(iOut) || '0') || 0);
      const payee = get(iPayee);
      if (!date || Number.isNaN(cents) || cents === 0 || /^transfer\b/i.test(payee)) {
        result.skipped++;
        continue;
      }
      let category = get(iCat);
      let group = get(iGroup);
      // "Group: Category" in one column
      if (!group && category.includes(':') && !INCOME_CATEGORIES.includes(category.toLowerCase())) {
        const idx = category.indexOf(':');
        group = category.slice(0, idx).trim();
        category = category.slice(idx + 1).trim();
      }
      const notes = get(iNotes);
      const key = [date, payee, cents, category, notes].join('|');
      if (seen.has(key)) { result.duplicates++; continue; }

      const isIncome = INCOME_CATEGORIES.includes(category.toLowerCase())
        || group.toLowerCase() === 'income'
        || (!category && cents > 0);
      let envelopeId = null;
      if (!isIncome) {
        if (!category) { result.skipped++; continue; }
        let env = byName.get(category.toLowerCase());
        if (!env) {
          env = addEnvelope(b, { name: category, group: group || 'Imported' });
          byName.set(category.toLowerCase(), env);
          result.envelopesCreated++;
        }
        envelopeId = env.id;
      }
      b.transactions.push({ id: newId(), date, payee, note: notes, amount: cents, envelopeId, importKey: key });
      seen.add(key);
      result.imported++;
      if (isIncome) result.income++;
    }
    return result;
  }

  // Accepts YYYY-MM-DD, YYYY/MM/DD and DD/MM/YYYY.
  function normalizeDate(text) {
    let m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
  }

  const api = {
    create, addEnvelope, removeEnvelope, addTransaction, removeTransaction,
    setAssigned, assignedIn, readyToAssign, envelopeStatus, monthView,
    shiftMonth, parseMoney, formatMoney, toInput, fromJSON,
    setTarget, normalizeTarget, fundAllTargets, weekdaysInMonth,
    parseCsv, importTransactionsCsv,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Budget = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
