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
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function create() {
    return { version: 1, currency: 'EUR', accounts: [], envelopes: [], transactions: [], assignments: {}, recurring: [], hiddenGroups: [], goals: [], groupColors: {}, payeeRules: [] };
  }

  // Older budgets have no accounts. Put their transactions in one "Main account".
  function ensureAccounts(b) {
    if (!Array.isArray(b.accounts)) b.accounts = [];
    if (!Array.isArray(b.recurring)) b.recurring = [];
    if (!Array.isArray(b.hiddenGroups)) b.hiddenGroups = [];
    if (!Array.isArray(b.goals)) b.goals = [];
    if (!b.groupColors || typeof b.groupColors !== 'object' || Array.isArray(b.groupColors)) b.groupColors = {};
    if (!Array.isArray(b.payeeRules)) b.payeeRules = [];
    if (b.transactions.some((t) => !t.accountId)) {
      const main = b.accounts[0] || addAccount(b, { name: 'Main account' });
      for (const t of b.transactions) if (!t.accountId) t.accountId = main.id;
    }
    return b;
  }

  function addEnvelope(b, { name, group, goal, target, parentId }) {
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
    if (parentId) {
      const parent = checkParent(b, env, parentId);
      env.parentId = parent.id;
      env.group = parent.group;
      // Right after the parent's last sub-envelope.
      let at = b.envelopes.indexOf(parent);
      b.envelopes.forEach((e, i) => { if (e.parentId === parent.id) at = i; });
      b.envelopes.splice(at + 1, 0, env);
      return env;
    }
    b.envelopes.push(env);
    return env;
  }

  // Sub-envelopes: one level deep. A sub-envelope lives in its parent's group.
  function checkParent(b, env, parentId) {
    const parent = b.envelopes.find((e) => e.id === parentId);
    if (!parent) throw new Error('Unknown parent envelope.');
    if (parent.id === env.id) throw new Error('An envelope cannot be inside itself.');
    if (parent.parentId) throw new Error('Sub-envelopes cannot have their own sub-envelopes.');
    if (b.envelopes.some((e) => e.parentId === env.id)) throw new Error('This envelope has sub-envelopes, so it cannot go inside another.');
    return parent;
  }

  function childrenOf(b, id) {
    return b.envelopes.filter((e) => e.parentId === id);
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
      throw new Error("Move or delete this envelope's transactions first.");
    }
    deleteEnvelope(b, id, null);
  }

  //   parentId: undefined keeps it, null or '' makes it a top-level envelope
  function updateEnvelope(b, id, { name, group, carryOverspending, hidden, parentId }) {
    const env = b.envelopes.find((e) => e.id === id);
    if (!env) throw new Error('Unknown envelope.');
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Envelope needs a name.');
    const newGroup = String(group || '').trim() || 'General';
    if (parentId !== undefined) {
      if (parentId) {
        const parent = checkParent(b, env, parentId);
        if (env.parentId !== parent.id) {
          env.parentId = parent.id;
          env.group = parent.group;
          placeAfterFamily(b, env, parent);
        }
      } else if (env.parentId) {
        delete env.parentId;
        env.group = newGroup;
        placeLastInGroup(b, env);
      } else if (env.group !== newGroup) {
        env.group = newGroup;
        placeLastInGroup(b, env);
      }
    } else if (!env.parentId && env.group !== newGroup) {
      env.group = newGroup;
      placeLastInGroup(b, env);
    }
    env.name = clean;
    // Sub-envelopes follow their parent's group.
    if (!env.parentId) for (const c of childrenOf(b, env.id)) c.group = env.group;
    if (carryOverspending !== undefined) env.carryOverspending = !!carryOverspending;
    if (hidden !== undefined) env.hidden = !!hidden;
  }

  function placeAfterFamily(b, env, parent) {
    b.envelopes.splice(b.envelopes.indexOf(env), 1);
    let at = b.envelopes.indexOf(parent);
    b.envelopes.forEach((e, i) => { if (e.parentId === parent.id) at = i; });
    b.envelopes.splice(at + 1, 0, env);
  }

  // Moving an envelope to another group puts it (and its sub-envelopes) at the
  // end of that group, so groups stay together.
  function placeLastInGroup(b, env) {
    const family = [env, ...childrenOf(b, env.id)];
    b.envelopes = b.envelopes.filter((e) => !family.includes(e));
    let at = -1;
    b.envelopes.forEach((e, i) => { if (e.group === env.group) at = i; });
    if (at === -1) b.envelopes.push(...family);
    else b.envelopes.splice(at + 1, 0, ...family);
  }

  // Reordering. Groups show in the order their envelopes first appear, so a
  // group moves as a block. dir: -1 up, 1 down.
  function moveGroup(b, group, dir) {
    const names = groupNames(b);
    const i = names.indexOf(group);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= names.length) return false;
    [names[i], names[j]] = [names[j], names[i]];
    b.envelopes = names.flatMap((n) => b.envelopes.filter((e) => e.group === n));
    return true;
  }

  // Move an envelope up or down among its siblings (same group, same parent).
  // A top-level envelope takes its sub-envelopes with it.
  function moveEnvelope(b, id, dir) {
    const env = b.envelopes.find((e) => e.id === id);
    if (!env) throw new Error('Unknown envelope.');
    const siblings = b.envelopes.filter((e) => e.group === env.group && (e.parentId || null) === (env.parentId || null));
    const i = siblings.indexOf(env);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return false;
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    const others = b.envelopes.filter((e) => e.group !== env.group);
    let ordered;
    if (env.parentId) {
      const groupEnvs = b.envelopes.filter((e) => e.group === env.group);
      let k = 0;
      ordered = groupEnvs.map((e) => (e.parentId === env.parentId ? siblings[k++] : e));
    } else {
      ordered = siblings.flatMap((e) => [e, ...childrenOf(b, e.id)]);
      // Orphans (parent missing) keep their place at the end.
      for (const e of b.envelopes) if (e.group === env.group && !ordered.includes(e)) ordered.push(e);
    }
    // Put the group back where it was.
    const names = groupNames(b);
    b.envelopes = names.flatMap((n) => (n === env.group ? ordered : others.filter((e) => e.group === n)));
    return true;
  }

  // Delete an envelope. Its transactions and recurring rules move to `moveToId`.
  // Money assigned to it goes back to Ready to Assign.
  function deleteEnvelope(b, id, moveToId) {
    if (!b.envelopes.some((e) => e.id === id)) throw new Error('Unknown envelope.');
    const used = b.transactions.some((t) => t.envelopeId === id)
      || (b.recurring || []).some((r) => r.envelopeId === id);
    if (used) {
      if (!moveToId || moveToId === id || !b.envelopes.some((e) => e.id === moveToId)) {
        throw new Error('Pick an envelope to move its transactions to.');
      }
      for (const t of b.transactions) if (t.envelopeId === id) t.envelopeId = moveToId;
      for (const r of b.recurring || []) if (r.envelopeId === id) r.envelopeId = moveToId;
    }
    b.envelopes = b.envelopes.filter((e) => e.id !== id);
    for (const e of b.envelopes) if (e.parentId === id) delete e.parentId;
    for (const m of Object.keys(b.assignments)) {
      delete b.assignments[m][id];
      if (!Object.keys(b.assignments[m]).length) delete b.assignments[m];
    }
  }

  // kind: 'spend' draws from an envelope; 'income' adds to Ready to Assign.
  // amount: positive integer cents.
  // Accounts

  // offBudget accounts (mortgage, investments, pension) track a balance but
  // never touch Ready to Assign or envelopes.
  function addAccount(b, { name, balance = 0, date, offBudget = false }) {
    if (!Array.isArray(b.accounts)) b.accounts = [];
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Account needs a name.');
    const acct = { id: newId(), name: clean, offBudget: !!offBudget, reconciledAt: null, reconciledBalance: null };
    b.accounts.push(acct);
    const start = Number(balance) || 0;
    if (start !== 0) {
      if (!Number.isInteger(start)) throw new Error('Starting balance must be an amount.');
      b.transactions.push({
        id: newId(), date: date || todayISO(), payee: 'Starting balance', note: '',
        amount: start, envelopeId: null, accountId: acct.id,
      });
    }
    return acct;
  }

  function updateAccount(b, id, { name }) {
    const acct = (b.accounts || []).find((a) => a.id === id);
    if (!acct) throw new Error('Unknown account.');
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Account needs a name.');
    acct.name = clean;
  }

  function deleteAccount(b, id) {
    if (b.transactions.some((t) => t.accountId === id || t.toAccountId === id)) {
      throw new Error('This account has transactions. Delete or move them first.');
    }
    if ((b.recurring || []).some((r) => r.accountId === id)) {
      throw new Error('A recurring transaction uses this account. Remove it first.');
    }
    b.accounts = b.accounts.filter((a) => a.id !== id);
  }

  function isOnBudget(b, accountId) {
    const acct = (b.accounts || []).find((a) => a.id === accountId);
    return !acct || !acct.offBudget;
  }

  // Does this transaction add to (or take from) Ready to Assign? Income in an
  // on-budget account does, as does money coming in from an off-budget
  // account. Transfers between two on-budget accounts and anything in an
  // off-budget account do not.
  function countsAsIncome(b, t) {
    if (t.envelopeId || !isOnBudget(b, t.accountId)) return false;
    if (t.transferId && isOnBudget(b, t.toAccountId)) return false;
    return true;
  }

  // Envelope a transfer's on-budget leg needs: only when money leaves the
  // budget for an off-budget account.
  function transferNeedsEnvelope(b, fromId, toId) {
    return isOnBudget(b, fromId) && !isOnBudget(b, toId);
  }

  function accountBalance(b, id, upToDate) {
    return b.transactions
      .filter((t) => t.accountId === id && (!upToDate || t.date <= upToDate))
      .reduce((sum, t) => sum + t.amount, 0);
  }

  // Import checks.
  //
  // A transfer between two of your accounts, imported from two bank files,
  // arrives as money out of one account and money into the other. Unlinked,
  // the money in counts as income (Ready to Assign goes up) while the money
  // out is spending. These find such pairs so they can become one transfer.
  const dayDiff = (a, c) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${c}T00:00:00Z`)) / 86400000;
  const isPlain = (b, t) => !t.transferId && !t.splitId && !t.recurringId && t.payee !== 'Starting balance'
    && t.payee !== 'Reconciliation adjustment' && isOnBudget(b, t.accountId);

  // Candidate pairs among `incoming` and `outgoing` (transactions or rows with
  // accountId, date, amount). Each one is used at most once, closest dates first.
  function matchTransfers(b, incoming, outgoing, days = 4) {
    const pairs = [];
    for (const inT of incoming) {
      for (const outT of outgoing) {
        if (inT.amount <= 0 || outT.amount !== -inT.amount || inT.accountId === outT.accountId) continue;
        const d = dayDiff(inT.date, outT.date);
        if (d <= days) pairs.push({ inT, outT, d });
      }
    }
    pairs.sort((x, y) => x.d - y.d);
    const used = new Set();
    return pairs.filter((p) => {
      if (used.has(p.inT) || used.has(p.outT)) return false;
      used.add(p.inT); used.add(p.outT);
      return true;
    });
  }

  // Pairs already in the budget: [{ outId, inId, amount, outAccountId, inAccountId, outDate, inDate }].
  function findTransferPairs(b, days = 4) {
    const plain = b.transactions.filter((t) => isPlain(b, t));
    return matchTransfers(b, plain.filter((t) => t.amount > 0), plain.filter((t) => t.amount < 0), days)
      .map(({ inT, outT }) => ({ outId: outT.id, inId: inT.id, amount: inT.amount, outAccountId: outT.accountId, inAccountId: inT.accountId, outDate: outT.date, inDate: inT.date }));
  }

  // Turn two existing transactions into the two legs of a transfer.
  function linkTransfer(b, outId, inId) {
    const out = b.transactions.find((t) => t.id === outId);
    const inn = b.transactions.find((t) => t.id === inId);
    if (!out || !inn || out.amount !== -inn.amount || out.accountId === inn.accountId) throw new Error('These do not make a transfer.');
    if (!isOnBudget(b, out.accountId) || !isOnBudget(b, inn.accountId)) throw new Error('Only transfers between budget accounts can be linked.');
    const transferId = newId();
    Object.assign(out, { transferId, toAccountId: inn.accountId, envelopeId: null });
    Object.assign(inn, { transferId, toAccountId: out.accountId, envelopeId: null });
  }

  // An account created with today's balance, then given its history from a
  // bank file, counts that history twice: the starting balance already holds
  // it. The fix moves the starting balance to before the first imported row
  // and lowers it by what those rows add up to, so today's balance stays put.
  //   extra: rows about to be imported (not yet in the budget)
  // Returns null when nothing overlaps.
  function startingBalanceOverlap(b, accountId, extra = []) {
    const start = b.transactions
      .filter((t) => t.accountId === accountId && t.payee === 'Starting balance' && !t.transferId)
      .sort((x, y) => (x.date < y.date ? -1 : 1))[0];
    if (!start) return null;
    const imported = b.transactions.filter((t) => t.accountId === accountId && t.id !== start.id
      && String(t.importKey || '').startsWith('bank:') && t.date <= start.date);
    const rows = [...imported, ...extra.filter((t) => t.date <= start.date)];
    if (!rows.length) return null;
    const overlap = rows.reduce((sum, t) => sum + t.amount, 0);
    const first = rows.reduce((d, t) => (t.date < d ? t.date : d), rows[0].date);
    const before = new Date(`${first}T00:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    return {
      startId: start.id, startDate: start.date, startAmount: start.amount,
      count: rows.length, overlap, newAmount: start.amount - overlap, newDate: before.toISOString().slice(0, 10),
    };
  }

  function fixStartingBalance(b, accountId, extra = []) {
    const o = startingBalanceOverlap(b, accountId, extra);
    if (!o) return null;
    const start = b.transactions.find((t) => t.id === o.startId);
    start.amount = o.newAmount;
    start.date = o.newDate;
    return o;
  }

  // Every transaction in an account, oldest first, with the balance after it.
  function accountRegister(b, id) {
    const rows = b.transactions
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.accountId === id)
      .sort((x, y) => (x.t.date < y.t.date ? -1 : x.t.date > y.t.date ? 1 : x.i - y.i));
    let balance = 0;
    return rows.map(({ t }) => {
      balance += t.amount;
      return { t, balance };
    });
  }

  function defaultAccountId(b) {
    if (!Array.isArray(b.accounts)) b.accounts = [];
    return (b.accounts[0] || addAccount(b, { name: 'Main account' })).id;
  }

  // Bring an account in line with the bank. Any difference becomes an
  // adjustment that goes to Ready to Assign, and everything up to `date` is
  // marked reconciled. Returns the adjustment in cents (0 if it matched).
  function reconcileAccount(b, id, bankBalance, date) {
    const acct = (b.accounts || []).find((a) => a.id === id);
    if (!acct) throw new Error('Unknown account.');
    if (!Number.isInteger(bankBalance)) throw new Error('Enter the balance your bank shows.');
    const day = date || todayISO();
    if (!DATE_RE.test(day)) throw new Error('Date must be YYYY-MM-DD.');
    const diff = bankBalance - accountBalance(b, id, day);
    if (diff !== 0) {
      b.transactions.push({
        id: newId(), date: day, payee: 'Reconciliation adjustment', note: '',
        amount: diff, envelopeId: null, accountId: id, adjustment: true,
      });
    }
    for (const t of b.transactions) if (t.accountId === id && t.date <= day) t.reconciled = true;
    acct.reconciledAt = day;
    acct.reconciledBalance = bankBalance;
    return diff;
  }

  // Transactions

  // kind: 'spend' draws from an envelope; 'income' adds to Ready to Assign;
  // 'transfer' moves money between two accounts and does not touch the budget.
  // amount: positive integer cents.
  function buildTransaction(b, { kind, date, payee, amount, envelopeId, note, accountId, toAccountId }) {
    if (!DATE_RE.test(date || '')) throw new Error('Date must be YYYY-MM-DD.');
    const cents = Number(amount);
    if (!Number.isInteger(cents) || cents <= 0) throw new Error('Amount must be greater than zero.');
    const acctId = accountId || defaultAccountId(b);
    if (!b.accounts.some((a) => a.id === acctId)) throw new Error('Pick an account.');
    const base = {
      date,
      payee: String(payee || '').trim(),
      note: String(note || '').trim(),
      accountId: acctId,
    };
    const onBudget = isOnBudget(b, acctId);
    if (kind === 'income') return [{ ...base, amount: cents, envelopeId: null }];
    if (kind === 'spend') {
      // Off-budget accounts have no envelopes.
      if (!onBudget) return [{ ...base, amount: -cents, envelopeId: null }];
      if (!b.envelopes.some((e) => e.id === envelopeId)) throw new Error('Pick an envelope.');
      return [{ ...base, amount: -cents, envelopeId }];
    }
    if (kind === 'transfer') {
      if (!toAccountId || toAccountId === acctId || !b.accounts.some((a) => a.id === toAccountId)) {
        throw new Error('Pick a different account to transfer to.');
      }
      const transferId = newId();
      const toName = b.accounts.find((a) => a.id === toAccountId).name;
      const fromName = b.accounts.find((a) => a.id === acctId).name;
      // Money leaving the budget (to an off-budget account) is spending from an envelope.
      let outEnvelope = null;
      if (transferNeedsEnvelope(b, acctId, toAccountId)) {
        if (!b.envelopes.some((e) => e.id === envelopeId)) {
          throw new Error('Money moving to an off-budget account is spending: pick an envelope.');
        }
        outEnvelope = envelopeId;
      }
      return [
        { ...base, payee: base.payee || `Transfer to ${toName}`, amount: -cents, envelopeId: outEnvelope, transferId, toAccountId },
        { ...base, payee: base.payee || `Transfer from ${fromName}`, amount: cents, envelopeId: null, transferId, accountId: toAccountId, toAccountId: acctId },
      ];
    }
    throw new Error('Unknown transaction type.');
  }

  function addTransaction(b, fields) {
    const legs = buildTransaction(b, fields).map((t) => ({ id: newId(), ...t }));
    b.transactions.push(...legs);
    return legs[0];
  }

  // What kind of transaction this is, for the edit form.
  function transactionKind(t) {
    if (t.transferId) return 'transfer';
    return t.envelopeId ? 'spend' : 'income';
  }

  function updateTransaction(b, id, fields) {
    const old = b.transactions.find((t) => t.id === id);
    if (!old) throw new Error('Unknown transaction.');
    const legs = buildTransaction(b, fields);
    removeTransaction(b, id);
    legs[0].id = old.id;
    for (let i = 1; i < legs.length; i++) legs[i].id = newId();
    if (old.recurringId) legs[0].recurringId = old.recurringId;
    b.transactions.push(...legs);
    return legs[0];
  }

  function removeTransaction(b, id) {
    const t = b.transactions.find((x) => x.id === id);
    if (!t) return;
    b.transactions = b.transactions.filter((x) => x.id !== id
      && !(t.transferId && x.transferId === t.transferId)
      && !(t.splitId && x.splitId === t.splitId));
  }

  // Delete many transactions of one account at once.
  //   only: 'all' | 'imported' (from bank files or Actual)
  //   from, to: optional YYYY-MM-DD limits (inclusive)
  //   keepStart: keep the "Starting balance" transaction
  // A transfer goes with its other half in the other account, and a split
  // with all its lines, as when deleting one by one.
  function accountTransactionsToDelete(b, accountId, { only = 'all', from = null, to = null, keepStart = true } = {}) {
    return b.transactions.filter((t) => t.accountId === accountId
      && (only !== 'imported' || !!t.importKey)
      && (!from || t.date >= from) && (!to || t.date <= to)
      && !(keepStart && t.payee === 'Starting balance' && !t.transferId));
  }
  function deleteAccountTransactions(b, accountId, opts = {}) {
    const picked = accountTransactionsToDelete(b, accountId, opts);
    const ids = new Set(picked.map((t) => t.id));
    const transfers = new Set(picked.filter((t) => t.transferId).map((t) => t.transferId));
    const splits = new Set(picked.filter((t) => t.splitId).map((t) => t.splitId));
    const before = b.transactions.length;
    b.transactions = b.transactions.filter((t) => !ids.has(t.id) && !(t.transferId && transfers.has(t.transferId)) && !(t.splitId && splits.has(t.splitId)));
    return before - b.transactions.length;
  }

  // Split transactions: one purchase spread over several envelopes. Each line
  // is stored as its own spending transaction sharing a splitId, so every
  // total and report works without knowing about splits.
  //   lines: [{ envelopeId, amount }] with positive cents
  function addSplit(b, { date, payee, note, accountId, lines, splitId, keepId, receiptId }) {
    if (!Array.isArray(lines) || lines.length < 2) throw new Error('A split needs at least two lines.');
    const acctId = accountId || defaultAccountId(b);
    if (!isOnBudget(b, acctId)) throw new Error('Splits are for on-budget accounts.');
    const legs = lines.map((l, i) => {
      if (!Number.isInteger(l.amount) || l.amount <= 0) throw new Error(`Line ${i + 1} needs an amount.`);
      return buildTransaction(b, { kind: 'spend', date, payee, note, amount: l.amount, envelopeId: l.envelopeId, accountId: acctId })[0];
    });
    const sid = splitId || newId();
    legs.forEach((leg, i) => {
      leg.id = i === 0 && keepId ? keepId : newId();
      leg.splitId = sid;
      if (i === 0 && receiptId) leg.receiptId = receiptId;
    });
    b.transactions.push(...legs);
    return legs[0];
  }
  function splitLegs(b, id) {
    const t = b.transactions.find((x) => x.id === id);
    if (!t || !t.splitId) return t ? [t] : [];
    return b.transactions.filter((x) => x.splitId === t.splitId);
  }

  // Move money between envelopes this month. null means Ready to Assign.
  function moveMoney(b, month, fromId, toId, cents) {
    if (!Number.isInteger(cents) || cents <= 0) throw new Error('Enter an amount to move.');
    if (fromId === toId) throw new Error('Pick two different places.');
    if (fromId) setAssigned(b, month, fromId, assignedIn(b, month, fromId) - cents);
    if (toId) setAssigned(b, month, toId, assignedIn(b, month, toId) + cents);
  }

  // Payees: names used before, most used first, and what they were last used for.
  function payees(b) {
    const count = new Map();
    for (const t of b.transactions) {
      const name = (t.payee || '').trim();
      if (!name || t.transferId || name === 'Starting balance' || t.adjustment) continue;
      count.set(name, (count.get(name) || 0) + 1);
    }
    return [...count].sort((x, y) => y[1] - x[1]).map(([name]) => name);
  }
  function payeeMemory(b, payee) {
    const key = String(payee || '').trim().toLowerCase();
    if (!key) return null;
    // A payee rule with an envelope wins over what was used last time.
    const rule = matchPayeeRule(b, payee);
    if (rule && rule.envelopeId && b.envelopes.some((e) => e.id === rule.envelopeId)) {
      return { kind: 'spend', envelopeId: rule.envelopeId, accountId: null, amount: null, rule: true };
    }
    let best = null;
    for (const t of b.transactions) {
      if ((t.payee || '').trim().toLowerCase() !== key || t.transferId) continue;
      if (!best || t.date > best.date) best = t;
    }
    if (!best) return null;
    return {
      kind: best.envelopeId ? 'spend' : 'income',
      envelopeId: best.envelopeId && b.envelopes.some((e) => e.id === best.envelopeId) ? best.envelopeId : null,
      accountId: best.accountId,
      amount: Math.abs(best.amount),
    };
  }

  // Payees
  //
  // Payees are the names on transactions. Managing them means renaming or
  // merging names everywhere, and rules:
  //   { id, match: 'is'|'contains', text, rename, envelopeId }
  // A rule renames payees that match (bank text like "COMPRA 4532 PINGO DOCE
  // LISBOA" becomes "Pingo Doce") and/or gives them an envelope. Rules run on
  // bank imports and can be applied to what is already there.
  const payeeKey = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

  // Every payee with how often it is used, the total, the last date and its
  // usual envelope. Names differing only in case or spaces are one payee.
  function payeeList(b) {
    const map = new Map();
    for (const t of b.transactions) {
      const name = (t.payee || '').trim();
      if (!name || t.transferId || name === 'Starting balance' || name === 'Reconciliation adjustment') continue;
      const k = payeeKey(name);
      let p = map.get(k);
      if (!p) { p = { name, count: 0, total: 0, last: '', envelopes: new Map() }; map.set(k, p); }
      p.count++;
      p.total += t.amount;
      if (t.date > p.last) { p.last = t.date; p.name = name; }
      if (t.envelopeId) p.envelopes.set(t.envelopeId, (p.envelopes.get(t.envelopeId) || 0) + 1);
    }
    return [...map.values()].map((p) => {
      const top = [...p.envelopes].sort((x, y) => y[1] - x[1])[0];
      const rule = matchPayeeRule(b, p.name);
      return { name: p.name, count: p.count, total: p.total, last: p.last, envelopeId: top ? top[0] : null, rule: rule ? rule.id : null };
    }).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));
  }

  // Rename every transaction (and recurring rule) whose payee is one of `from`
  // to `to`. Merging is renaming several names to one. Returns how many changed.
  function renamePayees(b, from, to) {
    const name = String(to || '').trim().slice(0, 80);
    if (!name) throw new Error('Give the payee a name.');
    const keys = new Set((Array.isArray(from) ? from : [from]).map(payeeKey));
    let n = 0;
    for (const t of b.transactions) {
      if (t.transferId || !keys.has(payeeKey(t.payee)) || t.payee === name) continue;
      t.payee = name;
      n++;
    }
    for (const r of b.recurring || []) if (keys.has(payeeKey(r.payee))) r.payee = name;
    return n;
  }

  function normalizePayeeRule(b, r) {
    const text = String(r.text || '').trim();
    if (!text) throw new Error('Say what the payee contains or is.');
    if (!['is', 'contains'].includes(r.match)) throw new Error('Pick how the rule matches.');
    const rename = String(r.rename || '').trim().slice(0, 80) || null;
    const envelopeId = r.envelopeId && b.envelopes.some((e) => e.id === r.envelopeId) ? r.envelopeId : null;
    if (!rename && !envelopeId) throw new Error('A rule needs a new name, an envelope or both.');
    return { id: r.id || newId(), match: r.match, text, rename, envelopeId };
  }
  function savePayeeRule(b, r) {
    if (!Array.isArray(b.payeeRules)) b.payeeRules = [];
    const rule = normalizePayeeRule(b, r);
    const i = b.payeeRules.findIndex((x) => x.id === rule.id);
    if (i === -1) b.payeeRules.push(rule); else b.payeeRules[i] = rule;
    return rule;
  }
  function removePayeeRule(b, id) {
    b.payeeRules = (b.payeeRules || []).filter((r) => r.id !== id);
  }
  // The first rule that matches a payee name.
  function matchPayeeRule(b, payee) {
    const k = payeeKey(payee);
    if (!k) return null;
    return (b.payeeRules || []).find((r) => (r.match === 'is' ? payeeKey(r.text) === k : k.includes(payeeKey(r.text)))) || null;
  }
  // What a rule makes of a bank row or transaction: { payee, envelopeId }.
  function applyPayeeRule(b, payee) {
    const rule = matchPayeeRule(b, payee);
    if (!rule) return { payee, envelopeId: null, rule: null };
    const envelopeId = rule.envelopeId && b.envelopes.some((e) => e.id === rule.envelopeId) ? rule.envelopeId : null;
    return { payee: rule.rename || payee, envelopeId, rule };
  }
  // Run the rules over existing transactions: rename matches, and give an
  // envelope to spending that has none yet (in "To categorise"). Spending
  // already in an envelope keeps it unless `recategorise` is set.
  function applyPayeeRules(b, { recategorise = false } = {}) {
    let renamed = 0;
    let categorised = 0;
    for (const t of b.transactions) {
      if (t.transferId || !t.payee) continue;
      const r = applyPayeeRule(b, t.payee);
      if (!r.rule) continue;
      if (r.payee !== t.payee) { t.payee = r.payee; renamed++; }
      const env = b.envelopes.find((e) => e.id === t.envelopeId);
      if (r.envelopeId && t.amount < 0 && isOnBudget(b, t.accountId) && t.envelopeId !== r.envelopeId
        && (!env || isInbox(env) || recategorise)) {
        t.envelopeId = r.envelopeId;
        categorised++;
      }
    }
    return { renamed, categorised };
  }

  // Find transactions. q matches payee, note, envelope, account or amount.
  function searchTransactions(b, { q = '', accountId = '', envelopeId = '', from = '', to = '' } = {}) {
    const envName = new Map(b.envelopes.map((e) => [e.id, e.name]));
    const acctName = new Map((b.accounts || []).map((a) => [a.id, a.name]));
    const needle = String(q).trim().toLowerCase();
    const amountNeedle = needle.replace(',', '.').replace(/[^\d.]/g, '');
    return b.transactions.filter((t) => {
      if (accountId && t.accountId !== accountId) return false;
      if (envelopeId && t.envelopeId !== envelopeId) return false;
      if (from && t.date < from) return false;
      if (to && t.date > to) return false;
      if (!needle) return true;
      const text = `${t.payee} ${t.note} ${envName.get(t.envelopeId) || ''} ${acctName.get(t.accountId) || ''}`.toLowerCase();
      if (text.includes(needle)) return true;
      return !!amountNeedle && /^\d+(\.\d+)?$/.test(amountNeedle) && (Math.abs(t.amount) / 100).toFixed(2).startsWith(amountNeedle);
    }).sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  }

  // Recurring and scheduled transactions
  //   { id, kind: 'spend'|'income'|'transfer', amount, payee, note, envelopeId,
  //     accountId, toAccountId, freq: 'once'|'weekly'|'monthly'|'yearly',
  //     every, next: 'YYYY-MM-DD', day, receiptId?, receiptType?, receiptName? }
  // 'once' is a future transaction: it is added on its date and then removed,
  // and until then it counts nowhere (not in balances, envelopes or Ready to
  // Assign). Only 'once' rules can be transfers.

  function normalizeRecurring(b, r) {
    const freq = r.freq;
    if (!['once', 'weekly', 'monthly', 'yearly'].includes(freq)) throw new Error('Pick how often it repeats.');
    if (r.kind === 'transfer' && freq !== 'once') throw new Error('Transfers cannot repeat yet.');
    const every = Number(r.every || 1);
    if (!Number.isInteger(every) || every < 1 || every > 52) throw new Error('Repeat every 1 to 52 periods.');
    if (!DATE_RE.test(r.next || '')) throw new Error('Pick the next date.');
    // Validate amount, envelope and account the same way as a real transaction.
    buildTransaction(b, { ...r, date: r.next });
    const rule = {
      id: r.id || newId(),
      kind: r.kind,
      amount: Number(r.amount),
      payee: String(r.payee || '').trim(),
      note: String(r.note || '').trim(),
      envelopeId: r.kind === 'income' ? null : r.envelopeId || null,
      accountId: r.accountId || defaultAccountId(b),
      freq,
      every,
      next: r.next,
      day: Number(r.next.slice(8, 10)),
    };
    if (r.kind === 'transfer') rule.toAccountId = r.toAccountId;
    if (r.receiptId) {
      rule.receiptId = r.receiptId;
      if (r.receiptType) rule.receiptType = r.receiptType;
      if (r.receiptName) rule.receiptName = r.receiptName;
    }
    return rule;
  }

  function addRecurring(b, r) {
    if (!['spend', 'income', 'transfer'].includes(r.kind)) throw new Error('Pick spending, income or a transfer.');
    const rule = normalizeRecurring(b, r);
    b.recurring.push(rule);
    return rule;
  }

  function updateRecurring(b, id, r) {
    const i = (b.recurring || []).findIndex((x) => x.id === id);
    if (i === -1) throw new Error('Unknown scheduled transaction.');
    if (!['spend', 'income', 'transfer'].includes(r.kind)) throw new Error('Pick spending, income or a transfer.');
    b.recurring[i] = normalizeRecurring(b, { ...r, id });
    return b.recurring[i];
  }

  // Every scheduled occurrence from `from` to `to` (inclusive), soonest first.
  // amount is signed like a transaction: spending negative, income positive.
  function upcoming(b, from, to) {
    const out = [];
    for (const rule of b.recurring || []) {
      let date = rule.next;
      let guard = 0;
      while (date && date <= to && guard++ < 400) {
        if (date >= from) {
          out.push({
            ruleId: rule.id, date, kind: rule.kind, payee: rule.payee, note: rule.note,
            envelopeId: rule.envelopeId, accountId: rule.accountId, toAccountId: rule.toAccountId || null,
            amount: rule.kind === 'income' ? rule.amount : -rule.amount,
            once: rule.freq === 'once', first: date === rule.next,
          });
        }
        date = rule.freq === 'once' ? null : nextRecurringDate(rule, date);
      }
    }
    return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  }

  function removeRecurring(b, id) {
    b.recurring = (b.recurring || []).filter((r) => r.id !== id);
  }

  function nextRecurringDate(rule, date) {
    const [y, m] = date.split('-').map(Number);
    if (rule.freq === 'weekly') {
      const d = new Date(`${date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 7 * rule.every);
      return d.toISOString().slice(0, 10);
    }
    const months = rule.freq === 'yearly' ? 12 * rule.every : rule.every;
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    const ty = target.getUTCFullYear();
    const tm = target.getUTCMonth();
    const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    const day = Math.min(rule.day, lastDay);
    return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // Create every recurring transaction due on or before `today`. Returns how many.
  function applyRecurring(b, today) {
    let created = 0;
    for (const rule of b.recurring || []) {
      let guard = 0;
      while (rule.next && rule.next <= today && guard++ < 500) {
        const t = addTransaction(b, { ...rule, date: rule.next });
        // An attachment goes on the first transaction the rule creates.
        if (rule.receiptId) {
          t.receiptId = rule.receiptId;
          if (rule.receiptType) t.receiptType = rule.receiptType;
          if (rule.receiptName) t.receiptName = rule.receiptName;
          delete rule.receiptId; delete rule.receiptType; delete rule.receiptName;
        }
        if (rule.freq === 'once') {
          rule.next = null;
        } else {
          t.recurringId = rule.id;
          rule.next = nextRecurringDate(rule, rule.next);
        }
        created++;
      }
    }
    b.recurring = (b.recurring || []).filter((r) => r.next);
    return created;
  }

  // Reports: spending per envelope and income per month for the `count`
  // months ending with `endMonth`. Transfers are left out.
  function report(b, endMonth, count = 6) {
    const months = [];
    for (let i = count - 1; i >= 0; i--) months.push(shiftMonth(endMonth, -i));
    const index = new Map(months.map((m, i) => [m, i]));
    const income = months.map(() => 0);
    const spending = months.map(() => 0);
    const byEnv = new Map();
    for (const t of b.transactions) {
      const i = index.get(monthOf(t.date));
      if (i === undefined) continue;
      if (!t.envelopeId) {
        if (!countsAsIncome(b, t)) continue;
        income[i] += t.amount;
        continue;
      }
      if (!byEnv.has(t.envelopeId)) byEnv.set(t.envelopeId, months.map(() => 0));
      byEnv.get(t.envelopeId)[i] -= t.amount;
      spending[i] -= t.amount;
    }
    const rows = [];
    for (const [id, perMonth] of byEnv) {
      const env = b.envelopes.find((e) => e.id === id);
      const total = perMonth.reduce((a, v) => a + v, 0);
      if (total === 0) continue;
      rows.push({ id, name: env ? env.name : 'Deleted envelope', group: env ? env.group : '', perMonth, total, average: Math.round(total / count) });
    }
    rows.sort((a, c) => c.total - a.total);
    return { months, income, spending, rows };
  }

  function assignedIn(b, month, envId) {
    return (b.assignments[month] || {})[envId] || 0;
  }

  function setAssigned(b, month, envId, cents) {
    if (!MONTH_RE.test(month)) throw new Error('Bad month.');
    if (!b.envelopes.some((e) => e.id === envId)) throw new Error('Unknown envelope.');
    // Negative amounts are allowed (as in YNAB and Actual): they move money
    // back to Ready to Assign.
    if (!Number.isInteger(cents)) throw new Error('Assigned amount must be a number.');
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
      .filter((t) => monthOf(t.date) <= month && countsAsIncome(b, t))
      .reduce((sum, t) => sum + t.amount, 0);
    let assigned = 0;
    for (const m of Object.keys(b.assignments)) {
      if (m <= month) for (const v of Object.values(b.assignments[m])) assigned += v;
    }
    // Overspending from earlier months is taken from Ready to Assign.
    let overspent = 0;
    for (const env of b.envelopes) overspent += envelopeLedger(b, env, month).absorbed;
    return income - assigned - overspent;
  }

  function firstMonth(b) {
    let first = null;
    for (const t of b.transactions) {
      const m = monthOf(t.date);
      if (!first || m < first) first = m;
    }
    for (const m of Object.keys(b.assignments)) if (!first || m < first) first = m;
    return first;
  }

  // Walk an envelope month by month up to `month`. Like YNAB and Actual, an
  // envelope overspent at the end of a month starts the next month at zero,
  // and the overspent amount comes out of the next month's Ready to Assign
  // (counted in `absorbed`). Envelopes with carryOverspending keep the
  // negative balance instead.
  // The "To categorise" envelope holds imported spending that has no envelope
  // yet. No money is ever assigned to it, so what it spends comes straight off
  // Ready to Assign in the same month instead of next month like normal
  // overspending: spent money is never shown as money left to assign.
  const INBOX_NAME = /^(📥\s*)?To categorise$/;
  function isInbox(env) {
    return !!env && (!!env.inbox || INBOX_NAME.test(env.name));
  }

  function envelopeLedger(b, env, month) {
    const activity = new Map();
    for (const t of b.transactions) {
      if (t.envelopeId !== env.id) continue;
      const m = monthOf(t.date);
      if (m <= month) activity.set(m, (activity.get(m) || 0) + t.amount);
    }
    const first = firstMonth(b);
    const inbox = isInbox(env);
    let end = 0;
    let absorbed = 0;
    let start = 0;
    let assigned = 0;
    let act = 0;
    for (let m = first && first < month ? first : month; m <= month; m = shiftMonth(m, 1)) {
      start = end;
      if (start < 0 && !env.carryOverspending) {
        absorbed += -start;
        start = 0;
      }
      assigned = assignedIn(b, m, env.id);
      act = activity.get(m) || 0;
      end = start + assigned + act;
      if (inbox && end < 0) {
        absorbed += -end;
        end = 0;
      }
    }
    return { carryover: start, assigned, activity: act, available: end, absorbed };
  }

  function envelopeStatus(b, envId, month) {
    const env = b.envelopes.find((e) => e.id === envId);
    if (!env) throw new Error('Unknown envelope.');

    const { carryover, assigned, activity: activityThisMonth, available } = envelopeLedger(b, env, month);
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
      parentId: env.parentId || null,
      inbox: isInbox(env),
      hidden: isHidden(b, env),
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

  // Hidden envelopes (or envelopes in a hidden group) stay in every total but
  // are tucked away on screen and left out of "Fund all targets".
  function isHidden(b, env) {
    if (env.hidden || (b.hiddenGroups || []).includes(env.group)) return true;
    const parent = env.parentId && b.envelopes.find((e) => e.id === env.parentId);
    return !!(parent && parent.hidden);
  }

  function setGroupHidden(b, group, hidden) {
    const list = new Set(b.hiddenGroups || []);
    if (hidden) list.add(group); else list.delete(group);
    b.hiddenGroups = [...list];
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
      if (!st.underfunded || st.hidden) continue;
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
      underfunded: [...groups.values()].flat().reduce((sum, e) => sum + (e.hidden ? 0 : e.needed || 0), 0),
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
    return ensureAccounts({
      version: 1,
      currency: obj.currency || 'EUR',
      envelopes: obj.envelopes,
      transactions: obj.transactions,
      assignments: obj.assignments,
      accounts: Array.isArray(obj.accounts) ? obj.accounts : [],
      recurring: Array.isArray(obj.recurring) ? obj.recurring : [],
      hiddenGroups: Array.isArray(obj.hiddenGroups) ? obj.hiddenGroups : [],
      goals: Array.isArray(obj.goals) ? obj.goals : [],
      groupColors: obj.groupColors && typeof obj.groupColors === 'object' && !Array.isArray(obj.groupColors) ? obj.groupColors : {},
      payeeRules: Array.isArray(obj.payeeRules) ? obj.payeeRules : [],
    });
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
    const iAccount = col('account');
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
      const accountName = get(iAccount);
      let accountId;
      if (accountName) {
        if (!Array.isArray(b.accounts)) b.accounts = [];
        const acct = b.accounts.find((a) => a.name.toLowerCase() === accountName.toLowerCase())
          || addAccount(b, { name: accountName });
        accountId = acct.id;
      } else {
        accountId = defaultAccountId(b);
      }
      b.transactions.push({ id: newId(), date, payee, note: notes, amount: cents, envelopeId, accountId, importKey: key });
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

  // ---- Insights for the Reports page ----

  const monthEnd = (m) => {
    const [y, mo] = m.split('-').map(Number);
    return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
  };

  // Balance of on-budget and off-budget accounts at the end of each month.
  function netWorthSeries(b, months) {
    return months.map((m) => {
      const end = monthEnd(m);
      let onBudget = 0;
      let offBudget = 0;
      for (const t of b.transactions) {
        if (t.date > end) continue;
        if (isOnBudget(b, t.accountId)) onBudget += t.amount; else offBudget += t.amount;
      }
      return { month: m, onBudget, offBudget, total: onBudget + offBudget };
    });
  }

  // Spending per envelope group per month. Groups beyond `maxGroups` (by total)
  // fold into "Other" so a chart never needs more colours than it can show.
  function groupSpending(b, months, maxGroups = 6) {
    const index = new Map(months.map((m, i) => [m, i]));
    const groupOf = new Map(b.envelopes.map((e) => [e.id, e.group]));
    const totals = new Map();
    for (const t of b.transactions) {
      const i = index.get(monthOf(t.date));
      if (i === undefined || !t.envelopeId) continue;
      const g = groupOf.get(t.envelopeId) || 'Other';
      if (!totals.has(g)) totals.set(g, months.map(() => 0));
      totals.get(g)[i] -= t.amount;
    }
    const sum = (arr) => arr.reduce((a, v) => a + v, 0);
    const ranked = [...totals].filter(([, v]) => sum(v) > 0).sort((x, y) => sum(y[1]) - sum(x[1]));
    const keep = ranked.slice(0, maxGroups).map(([name, values]) => ({ name, values: values.map((v) => Math.max(0, v)) }));
    const rest = ranked.slice(maxGroups);
    if (rest.length) {
      keep.push({ name: 'Other', values: months.map((_, i) => Math.max(0, rest.reduce((a, [, v]) => a + v[i], 0))) });
    }
    return keep;
  }

  // Month-end forecast at the current spending pace. Only meaningful for the
  // month that contains `today`; returns null otherwise.
  function monthForecast(b, month, today) {
    if (monthOf(today) !== month) return null;
    const day = Number(today.slice(8, 10));
    const days = Number(monthEnd(month).slice(8, 10));
    const pace = days / Math.max(1, day);
    let spent = 0;
    const atRisk = [];
    for (const env of b.envelopes) {
      if (isHidden(b, env)) continue;
      const st = envelopeStatus(b, env.id, month);
      const out = Math.max(0, -st.activity);
      spent += out;
      if (out === 0) continue;
      const projected = Math.round(out * pace);
      const short = projected - out - st.available;
      if (short > 0) atRisk.push({ id: env.id, name: env.name, projected, short });
    }
    atRisk.sort((x, y) => y.short - x.short);
    return { day, days, spent, projected: Math.round(spent * pace), atRisk };
  }

  // When will each savings target be reached at the recent saving rate?
  // Uses the average assigned over the last 3 months.
  function targetForecasts(b, month) {
    const out = [];
    for (const env of b.envelopes) {
      const t = envTarget(env);
      if (!t || !['balance', 'byDate'].includes(t.type) || isHidden(b, env)) continue;
      const st = envelopeStatus(b, env.id, month);
      const remaining = t.amount - st.available;
      let assigned = 0;
      for (let k = 0; k < 3; k++) assigned += assignedIn(b, shiftMonth(month, -k), env.id);
      const rate = Math.round(assigned / 3);
      let eta = null;
      if (remaining <= 0) eta = month;
      else if (rate > 0) eta = shiftMonth(month, Math.ceil(remaining / rate));
      const onTrack = t.type === 'byDate' ? !!eta && eta <= t.date : null;
      out.push({ id: env.id, name: env.name, amount: t.amount, available: st.available, remaining: Math.max(0, remaining), rate, eta, due: t.date || null, onTrack });
    }
    return out;
  }

  // Goals sit above envelopes: an amount to reach across some accounts, some
  // envelopes, or your whole net worth, optionally by a month.
  //   { id, name, amount, by: 'YYYY-MM' | null, source: 'accounts' | 'envelopes' | 'networth', ids: [], celebrated: 0 }
  const GOAL_SOURCES = ['accounts', 'envelopes', 'networth'];
  const MILESTONES = [25, 50, 75, 100];

  function normalizeGoal(b, g) {
    const name = String(g.name || '').trim();
    if (!name) throw new Error('Give the goal a name.');
    const amount = Number(g.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('The goal amount must be more than zero.');
    const by = g.by || null;
    if (by && !MONTH_RE.test(by)) throw new Error('The goal date must be a month.');
    if (!GOAL_SOURCES.includes(g.source)) throw new Error('Choose what the goal tracks.');
    const known = g.source === 'accounts' ? (b.accounts || []).map((a) => a.id)
      : g.source === 'envelopes' ? b.envelopes.map((e) => e.id) : [];
    const ids = g.source === 'networth' ? [] : [...new Set(g.ids || [])].filter((id) => known.includes(id));
    if (g.source !== 'networth' && !ids.length) {
      throw new Error(g.source === 'accounts' ? 'Pick at least one account.' : 'Pick at least one envelope.');
    }
    return { name, amount, by, source: g.source, ids };
  }

  function addGoal(b, g) {
    if (!Array.isArray(b.goals)) b.goals = [];
    const goal = { id: newId(), ...normalizeGoal(b, g), celebrated: 0, createdAt: todayISO() };
    b.goals.push(goal);
    return goal;
  }

  function updateGoal(b, id, g) {
    const goal = (b.goals || []).find((x) => x.id === id);
    if (!goal) throw new Error('Unknown goal.');
    Object.assign(goal, normalizeGoal(b, g));
    // A higher amount can un-reach milestones; let them be celebrated again.
    goal.celebrated = Math.min(goal.celebrated || 0, goalStatus(b, goal, monthOf(todayISO())).milestone);
    return goal;
  }

  function removeGoal(b, id) {
    b.goals = (b.goals || []).filter((g) => g.id !== id);
  }

  // Savings targets set on envelopes ("Have a balance", "Have a balance by a
  // date") as goals, so the Goals page shows them too. Built fresh each time;
  // the celebrated milestone lives on the envelope.
  function envelopeGoals(b) {
    const tracked = new Set((b.goals || []).filter((g) => g.source === 'envelopes' && g.ids.length === 1).map((g) => g.ids[0]));
    return b.envelopes
      .filter((env) => env.target && ['balance', 'byDate'].includes(env.target.type) && env.target.amount > 0
        && !isHidden(b, env) && !tracked.has(env.id))
      .map((env) => ({
        id: `env:${env.id}`, envelopeId: env.id, name: env.name, amount: env.target.amount,
        by: env.target.type === 'byDate' ? env.target.date || null : null,
        source: 'envelopes', ids: [env.id], fromEnvelope: true, celebrated: env.goalCelebrated || 0,
      }));
  }

  // What the goal's money adds up to at the end of `month`.
  function goalValue(b, goal, month) {
    const end = monthEnd(month);
    if (goal.source === 'envelopes') {
      return goal.ids.reduce((sum, id) => (b.envelopes.some((e) => e.id === id) ? sum + envelopeStatus(b, id, month).available : sum), 0);
    }
    const ids = goal.source === 'accounts' ? new Set(goal.ids) : null;
    let sum = 0;
    for (const t of b.transactions) if (t.date <= end && (!ids || ids.has(t.accountId))) sum += t.amount;
    return sum;
  }

  // Progress, history and a forecast for one goal, as of `month`.
  function goalStatus(b, goal, month, historyMonths = 12) {
    const months = [];
    for (let k = historyMonths - 1; k >= 0; k--) months.push(shiftMonth(month, -k));
    const history = months.map((m) => ({ month: m, value: goalValue(b, goal, m) }));
    const value = history[history.length - 1].value;
    const progress = Math.max(0, Math.min(1, value / goal.amount));
    const remaining = Math.max(0, goal.amount - value);
    // Average change over the last three months.
    const back = history[Math.max(0, history.length - 4)].value;
    const rate = Math.round((value - back) / Math.min(3, history.length - 1 || 1));
    let eta = null;
    if (remaining === 0) eta = month;
    else if (rate > 0) eta = shiftMonth(month, Math.ceil(remaining / rate));
    let monthsLeft = null;
    let neededPerMonth = null;
    let onTrack = null;
    if (goal.by) {
      const [y1, m1] = month.split('-').map(Number);
      const [y2, m2] = goal.by.split('-').map(Number);
      monthsLeft = (y2 - y1) * 12 + (m2 - m1);
      neededPerMonth = remaining === 0 ? 0 : monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining;
      onTrack = remaining === 0 || (!!eta && eta <= goal.by);
    }
    const pct = progress * 100;
    const milestone = MILESTONES.filter((m) => pct >= m).pop() || 0;
    // First month in the history each milestone was reached.
    const reached = MILESTONES.map((m) => {
      const hit = history.find((h) => h.value >= (goal.amount * m) / 100);
      return { percent: m, month: pct >= m ? (hit ? hit.month : month) : null };
    });
    return { value, progress, remaining, rate, eta, monthsLeft, neededPerMonth, onTrack, milestone, milestones: reached, history };
  }

  // Group colours: one of GROUP_COLORS poster colours per group, kept in
  // b.groupColors by group name. New groups get the least used colour that
  // differs from the group above them, so neighbours never match.
  const GROUP_COLORS = 16;
  function groupNames(b) {
    return [...new Set(b.envelopes.map((e) => e.group))];
  }
  function ensureGroupColors(b) {
    if (!b.groupColors || typeof b.groupColors !== 'object') b.groupColors = {};
    const names = groupNames(b);
    let changed = false;
    names.forEach((name, i) => {
      const c = b.groupColors[name];
      if (Number.isInteger(c) && c >= 0 && c < GROUP_COLORS) return;
      const used = new Array(GROUP_COLORS).fill(0);
      for (const n of names) {
        const v = b.groupColors[n];
        if (Number.isInteger(v) && v >= 0 && v < GROUP_COLORS) used[v]++;
      }
      const above = i > 0 ? b.groupColors[names[i - 1]] : -1;
      let best = -1;
      for (let k = 0; k < GROUP_COLORS; k++) {
        if (k === above) continue;
        if (best < 0 || used[k] < used[best]) best = k;
      }
      b.groupColors[name] = best;
      changed = true;
    });
    // Forget colours of groups that no longer exist.
    for (const n of Object.keys(b.groupColors)) {
      if (!names.includes(n)) { delete b.groupColors[n]; changed = true; }
    }
    return changed;
  }
  function setGroupColor(b, group, color) {
    if (!Number.isInteger(color) || color < 0 || color >= GROUP_COLORS) throw new Error('Unknown colour.');
    if (!groupNames(b).includes(group)) throw new Error('Unknown group.');
    b.groupColors[group] = color;
  }

  // Monthly recap: what happened in `month`, including overspending and
  // envelopes that keep running short.
  function recap(b, month) {
    const prev = shiftMonth(month, -1);
    const r = report(b, month, 2);
    const income = r.income[1];
    const spending = r.spending[1];
    const view = monthView(b, month);
    const envs = view.groups.flatMap((g) => g.envelopes);
    const assigned = envs.reduce((s, e) => s + e.assigned, 0);
    const overspent = envs.filter((e) => e.available < 0).map((e) => {
      const env = b.envelopes.find((x) => x.id === e.id);
      return { id: e.id, name: e.name, amount: -e.available, carried: !!(env && env.carryOverspending) };
    }).sort((x, y) => y.amount - x.amount);
    // Envelopes overspent in at least 3 of the last 4 months.
    const hints = [];
    for (const env of b.envelopes) {
      let count = 0;
      let spent = 0;
      for (let k = 0; k < 4; k++) {
        const m = shiftMonth(month, -k);
        const st = envelopeStatus(b, env.id, m);
        if (st.available < 0) count++;
        if (k < 3) spent -= st.activity;
      }
      if (count >= 3) {
        const avg = Math.round(spent / 3);
        const suggest = Math.ceil(avg / 500) * 500; // round up to 5
        hints.push({ id: env.id, name: env.name, months: count, suggest });
      }
    }
    const top = r.rows.map((row) => ({ id: row.id, name: row.name, amount: row.perMonth[1], before: row.perMonth[0] }))
      .filter((x) => x.amount > 0).sort((x, y) => y.amount - x.amount).slice(0, 5);
    const txs = b.transactions.filter((t) => monthOf(t.date) === month && t.envelopeId && t.amount < 0);
    const biggest = txs.sort((x, y) => x.amount - y.amount)[0] || null;
    const goals = [...(b.goals || []), ...envelopeGoals(b)].map((g) => {
      const now = goalValue(b, g, month);
      const before = goalValue(b, g, prev);
      return { id: g.id, name: g.name, now, change: now - before, amount: g.amount, progress: Math.max(0, Math.min(1, now / g.amount)) };
    });
    const worth = netWorthSeries(b, [prev, month]);
    return {
      month,
      income,
      spending,
      saved: income - spending,
      savedBefore: r.income[0] - r.spending[0],
      spendingBefore: r.spending[0],
      assigned,
      readyToAssign: readyToAssign(b, month),
      overspent,
      hints,
      top,
      biggest: biggest ? { payee: biggest.payee, amount: -biggest.amount, date: biggest.date, envelopeId: biggest.envelopeId } : null,
      transactions: b.transactions.filter((t) => monthOf(t.date) === month).length,
      goals,
      netWorth: worth[1].total,
      netWorthChange: worth[1].total - worth[0].total,
    };
  }

  // Streaks, counted back from `month` (inclusive) while the condition holds.
  function streaks(b, month) {
    const first = firstMonth(b);
    if (!first) return { noOverspending: 0, allAssigned: 0, saving: 0 };
    const count = (test) => {
      let n = 0;
      for (let m = month; m >= first && n < 240; m = shiftMonth(m, -1)) {
        if (!test(m)) break;
        n++;
      }
      return n;
    };
    const hasActivity = (m) => b.transactions.some((t) => monthOf(t.date) === m) || !!b.assignments[m];
    return {
      noOverspending: count((m) => hasActivity(m) && b.envelopes.every((e) => envelopeStatus(b, e.id, m).available >= 0)),
      allAssigned: count((m) => hasActivity(m) && readyToAssign(b, m) === 0),
      saving: count((m) => {
        const r = report(b, m, 1);
        return hasActivity(m) && r.income[0] > 0 && r.income[0] > r.spending[0];
      }),
    };
  }

  const api = {
    create, addEnvelope, removeEnvelope, addTransaction, removeTransaction,
    setAssigned, assignedIn, readyToAssign, envelopeStatus, monthView,
    shiftMonth, parseMoney, formatMoney, toInput, fromJSON,
    setTarget, normalizeTarget, fundAllTargets, weekdaysInMonth,
    updateEnvelope, deleteEnvelope, updateTransaction, transactionKind,
    moveGroup, moveEnvelope, childrenOf, updateRecurring, upcoming,
    accountTransactionsToDelete, deleteAccountTransactions, isInbox,
    envelopeGoals,
    payeeList, renamePayees, savePayeeRule, removePayeeRule, matchPayeeRule, applyPayeeRule, applyPayeeRules,
    matchTransfers, findTransferPairs, linkTransfer, startingBalanceOverlap, fixStartingBalance,
    addAccount, updateAccount, deleteAccount, accountBalance, reconcileAccount, ensureAccounts,
    isOnBudget, transferNeedsEnvelope, countsAsIncome, isHidden, setGroupHidden, accountRegister,
    addRecurring, removeRecurring, applyRecurring, nextRecurringDate, report,
    netWorthSeries, groupSpending, monthForecast, targetForecasts,
    parseCsv, importTransactionsCsv,
    addGoal, updateGoal, removeGoal, goalValue, goalStatus,
    GROUP_COLORS, ensureGroupColors, setGroupColor, groupNames,
    addSplit, splitLegs, moveMoney, payees, payeeMemory, searchTransactions, recap, streaks, monthEnd,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Budget = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
