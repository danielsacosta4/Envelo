// Bank CSV import: works out the layout of any bank's CSV export (separator,
// date format, decimal comma or point, which column is what), so the user
// only confirms it. Pure functions, usable in the browser and in tests.

(function (root) {
  const DELIMS = [';', ',', '\t', '|'];

  // Split CSV text into rows, honouring quotes. Drops empty lines.
  function parseRows(text, delim) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const s = String(text).replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"') {
          if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell);
        if (row.some((x) => x.trim() !== '')) rows.push(row);
        row = [];
        cell = '';
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    return rows.map((r) => r.map((x) => x.trim()));
  }

  // The separator that gives the most consistent column count.
  function detectDelimiter(text) {
    const sample = String(text).split(/\r?\n/).filter((l) => l.trim()).slice(0, 20).join('\n');
    let best = ',';
    let bestScore = -1;
    for (const d of DELIMS) {
      const rows = parseRows(sample, d);
      if (!rows.length) continue;
      const freq = new Map();
      for (const r of rows) freq.set(r.length, (freq.get(r.length) || 0) + 1);
      let mode = 0;
      let hits = 0;
      for (const [len, n] of freq) if (len >= 2 && (n > hits || (n === hits && len > mode))) { mode = len; hits = n; }
      if (mode < 2) continue;
      const score = hits * 10 + mode;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  // Dates
  const DATE_FORMATS = ['YYYY-MM-DD', 'DD-MM-YYYY', 'MM-DD-YYYY', 'DD-MM-YY', 'YYYYMMDD'];
  function parseDate(value, format) {
    const v = String(value || '').trim().split(/[ T]/)[0];
    let y; let m; let d;
    if (format === 'YYYYMMDD') {
      const x = v.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (!x) return null;
      [, y, m, d] = x;
    } else {
      const parts = v.split(/[-/.]/);
      if (parts.length !== 3) return null;
      if (format === 'YYYY-MM-DD') [y, m, d] = parts;
      else if (format === 'DD-MM-YYYY' || format === 'DD-MM-YY') [d, m, y] = parts;
      else if (format === 'MM-DD-YYYY') [m, d, y] = parts;
      else return null;
      if (format === 'DD-MM-YY') {
        if (!/^\d{2}$/.test(y)) return null;
        y = `20${y}`;
      }
    }
    if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return null;
    const yy = Number(y); const mm = Number(m); const dd = Number(d);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const date = new Date(Date.UTC(yy, mm - 1, dd));
    if (date.getUTCMonth() !== mm - 1) return null;
    return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  // The format that reads every value. Day-first wins ties (European banks).
  function detectDateFormat(values) {
    const vals = values.filter((v) => String(v || '').trim());
    if (!vals.length) return null;
    for (const f of ['YYYY-MM-DD', 'DD-MM-YYYY', 'MM-DD-YYYY', 'DD-MM-YY', 'YYYYMMDD']) {
      if (vals.every((v) => parseDate(v, f))) return f;
    }
    return null;
  }

  // Amounts
  function detectDecimal(values) {
    let comma = 0;
    let point = 0;
    for (const raw of values) {
      const v = String(raw || '').replace(/[^\d,.-]/g, '');
      if (/,\d{1,2}$/.test(v)) comma++;
      else if (/\.\d{1,2}$/.test(v)) point++;
      else if (/\d\.\d{3},/.test(v)) comma++;
      else if (/\d,\d{3}\./.test(v)) point++;
    }
    return comma > point ? ',' : '.';
  }
  // Signed cents, or NaN.
  function parseAmount(value, decimal = '.') {
    let v = String(value ?? '').trim();
    if (!v) return NaN;
    let negative = false;
    if (/^\(.*\)$/.test(v)) { negative = true; v = v.slice(1, -1); }
    if (/-$/.test(v)) { negative = true; v = v.slice(0, -1); }
    v = v.replace(/[\s '€$£]|EUR|USD|GBP|BRL|CHF/gi, '');
    if (v.startsWith('+')) v = v.slice(1);
    if (v.startsWith('-')) { negative = !negative; v = v.slice(1); }
    if (decimal === ',') v = v.replace(/\./g, '').replace(',', '.');
    else v = v.replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(v)) return NaN;
    const cents = Math.round(Number(v) * 100);
    return negative ? -cents : cents;
  }

  // Column roles, recognised from header names in several languages.
  const ROLE_WORDS = {
    date: ['completed date', 'booking date', 'data movimento', 'data de movimento', 'data operação', 'data operacao', 'data do movimento', 'date', 'data', 'fecha', 'datum', 'buchungstag', 'started date', 'data valor', 'value date'],
    payee: ['partner name', 'payee', 'beneficiário', 'beneficiario', 'merchant', 'counterparty', 'description', 'descrição', 'descricao', 'descritivo', 'designação', 'designacao', 'movimento', 'concepto', 'empfänger', 'libellé', 'libelle', 'name', 'details'],
    amount: ['amount (eur)', 'amount', 'montante', 'valor', 'importe', 'betrag', 'montant', 'quantia'],
    debit: ['debit', 'débito', 'debito', 'saída', 'saida', 'withdrawal', 'cargo', 'paid out', 'money out', 'out'],
    credit: ['credit', 'crédito', 'credito', 'entrada', 'deposit', 'abono', 'paid in', 'money in', 'in'],
    note: ['payment reference', 'reference', 'referência', 'referencia', 'memo', 'note', 'notes', 'observações', 'observacoes', 'verwendungszweck'],
  };
  // A running balance is never the amount; a "value date" is never the amount.
  const BALANCE = /saldo|balance|kontostand|solde/;
  const DATEISH = /\b(data|date|fecha|datum)\b/;
  const norm = (h) => String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');

  function guessColumns(header, rows) {
    const cols = { date: -1, payee: -1, amount: -1, debit: -1, credit: -1, note: -1 };
    const taken = new Set();
    const names = header ? header.map(norm) : [];
    // Exact names first, then names that contain the word.
    for (const exact of [true, false]) {
      for (const role of Object.keys(ROLE_WORDS)) {
        if (cols[role] >= 0) continue;
        for (const word of ROLE_WORDS[role]) {
          const i = names.findIndex((n, k) => !taken.has(k) && !BALANCE.test(n) && (role === 'date' || !DATEISH.test(n))
            && (exact ? n === word : n.includes(word) && word.length > 3));
          if (i >= 0) { cols[role] = i; taken.add(i); break; }
        }
      }
    }
    // Without a usable header, look at the values.
    const width = Math.max(...rows.map((r) => r.length), 0);
    const column = (k) => rows.map((r) => r[k] || '');
    if (cols.date < 0) {
      for (let k = 0; k < width; k++) if (!taken.has(k) && detectDateFormat(column(k).slice(0, 30))) { cols.date = k; taken.add(k); break; }
    }
    if (cols.amount < 0 && cols.debit < 0) {
      for (let k = 0; k < width; k++) {
        if (taken.has(k)) continue;
        const vals = column(k).slice(0, 30).filter(Boolean);
        if (vals.length && vals.every((v) => !Number.isNaN(parseAmount(v, detectDecimal(vals))))) { cols.amount = k; taken.add(k); break; }
      }
    }
    if (cols.payee < 0) {
      let bestK = -1;
      let bestLen = 0;
      for (let k = 0; k < width; k++) {
        if (taken.has(k)) continue;
        const vals = column(k).slice(0, 30);
        const textual = vals.filter((v) => /[a-z]/i.test(v)).length;
        const len = vals.reduce((s, v) => s + v.length, 0);
        if (textual >= vals.length / 2 && len > bestLen) { bestLen = len; bestK = k; }
      }
      if (bestK >= 0) { cols.payee = bestK; taken.add(bestK); }
    }
    if (cols.amount >= 0) { cols.debit = -1; cols.credit = -1; }
    return cols;
  }

  // Known exports with extra rules.
  const PRESETS = [
    {
      id: 'revolut',
      name: 'Revolut',
      test: (h) => ['type', 'started date', 'completed date', 'description', 'amount', 'fee', 'state'].every((x) => h.includes(x)),
      columns: (h) => ({ date: h.indexOf('completed date'), payee: h.indexOf('description'), amount: h.indexOf('amount'), debit: -1, credit: -1, note: -1, fee: h.indexOf('fee'), state: h.indexOf('state') }),
      // Pending and reverted rows are skipped; the fee is part of what left the account.
      keep: (row, cols) => cols.state < 0 || /^completed$/i.test(row[cols.state] || ''),
    },
    {
      id: 'n26',
      name: 'N26',
      test: (h) => h.includes('amount (eur)') && (h.includes('partner name') || h.includes('payee')),
      columns: (h) => ({
        date: h.includes('booking date') ? h.indexOf('booking date') : h.indexOf('date'),
        payee: h.includes('partner name') ? h.indexOf('partner name') : h.indexOf('payee'),
        amount: h.indexOf('amount (eur)'), debit: -1, credit: -1,
        note: h.indexOf('payment reference'),
      }),
    },
  ];

  // Work out everything about a file.
  //   saved: a layout remembered for this account, used when it still fits
  function analyze(text, saved = null) {
    const delimiter = saved && saved.delimiter ? saved.delimiter : detectDelimiter(text);
    const all = parseRows(text, delimiter);
    if (!all.length) throw new Error('The file is empty.');
    // Some banks put a title or account details above the table: start at the
    // first row that looks like a header or like data with a date.
    let start = 0;
    for (let i = 0; i < Math.min(all.length, 15); i++) {
      const r = all[i];
      const lower = r.map(norm);
      const looksHeader = lower.some((x) => ROLE_WORDS.date.includes(x) || ROLE_WORDS.amount.includes(x));
      const looksData = r.some((x) => detectDateFormat([x]));
      if (looksHeader || looksData) { start = i; break; }
    }
    const first = all[start];
    const hasHeader = first.some((x) => /[a-z]/i.test(x)) && !first.some((x) => detectDateFormat([x]));
    const header = hasHeader ? first : first.map((_, i) => `Column ${i + 1}`);
    const rows = all.slice(start + (hasHeader ? 1 : 0)).filter((r) => r.length > 1);
    const signature = hasHeader ? header.map(norm).join('|') : `cols:${header.length}`;
    const lower = header.map(norm);
    const preset = hasHeader ? PRESETS.find((p) => p.test(lower)) || null : null;

    let columns;
    let dateFormat;
    let decimal;
    if (saved && saved.signature === signature && saved.columns) {
      ({ columns, dateFormat, decimal } = saved);
    } else {
      columns = preset ? preset.columns(lower) : guessColumns(hasHeader ? header : null, rows);
      dateFormat = columns.date >= 0 ? detectDateFormat(rows.slice(0, 200).map((r) => r[columns.date])) : null;
      const amountVals = [];
      for (const r of rows.slice(0, 200)) for (const k of [columns.amount, columns.debit, columns.credit]) if (k >= 0 && r[k]) amountVals.push(r[k]);
      decimal = detectDecimal(amountVals);
    }
    // A running balance column, when the bank gives one, lets the import check
    // that Envelo ends up with the same balance as the bank.
    if (columns.balance === undefined) {
      const used = new Set(Object.values(columns));
      columns = { ...columns, balance: hasHeader ? lower.findIndex((n, k) => !used.has(k) && BALANCE.test(n) && !DATEISH.test(n)) : -1 };
    }
    return { delimiter, header, rows, hasHeader, signature, preset: preset ? preset.id : null, presetName: preset ? preset.name : null, columns, dateFormat: dateFormat || 'DD-MM-YYYY', decimal };
  }

  // Turn rows into transactions: { date, payee, note, amount (signed cents) }.
  function toTransactions(layout) {
    const { rows, columns: c, dateFormat, decimal, preset } = layout;
    const p = PRESETS.find((x) => x.id === preset);
    const out = [];
    const errors = [];
    rows.forEach((r, i) => {
      if (p && p.keep && !p.keep(r, c)) return;
      const date = c.date >= 0 ? parseDate(r[c.date], dateFormat) : null;
      let amount = NaN;
      if (c.amount >= 0) {
        amount = parseAmount(r[c.amount], decimal);
        if (c.fee >= 0 && r[c.fee]) {
          const fee = parseAmount(r[c.fee], decimal);
          if (!Number.isNaN(fee)) amount -= Math.abs(fee);
        }
      } else if (c.debit >= 0 || c.credit >= 0) {
        const debit = c.debit >= 0 && r[c.debit] ? parseAmount(r[c.debit], decimal) : 0;
        const credit = c.credit >= 0 && r[c.credit] ? parseAmount(r[c.credit], decimal) : 0;
        if (!Number.isNaN(debit) && !Number.isNaN(credit)) amount = Math.abs(credit) - Math.abs(debit);
      }
      if (!date || Number.isNaN(amount)) {
        errors.push({ row: i + 1, reason: !date ? 'date' : 'amount' });
        return;
      }
      if (amount === 0) return;
      const balance = c.balance >= 0 && r[c.balance] ? parseAmount(r[c.balance], decimal) : NaN;
      out.push({
        line: i + 1,
        date,
        payee: c.payee >= 0 ? (r[c.payee] || '').slice(0, 80) : '',
        note: c.note >= 0 ? (r[c.note] || '').slice(0, 140) : '',
        amount,
        balance: Number.isNaN(balance) ? null : balance,
      });
    });
    return { transactions: out, errors };
  }

  // The balance the bank shows after the newest row: { date, balance } or null.
  // Files list newest first or oldest first; the order tells which row is last.
  function endBalance(transactions) {
    const withBal = transactions.filter((t) => t.balance !== null && t.balance !== undefined);
    if (!withBal.length) return null;
    const newestFirst = withBal[0].date > withBal[withBal.length - 1].date;
    const latest = withBal.reduce((d, t) => (t.date > d ? t.date : d), withBal[0].date);
    const onLatest = withBal.filter((t) => t.date === latest);
    const row = newestFirst ? onLatest[0] : onLatest[onLatest.length - 1];
    return { date: row.date, balance: row.balance };
  }

  // Key used to recognise a transaction already in the budget.
  const dupKey = (t) => `${t.date}|${t.amount}|${String(t.payee || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;

  // Mark rows already present. Identical rows on the same day are allowed as
  // many times as the file has them beyond what the account already holds.
  function markDuplicates(incoming, existing) {
    const have = new Map();
    for (const t of existing) {
      const k = dupKey(t);
      have.set(k, (have.get(k) || 0) + 1);
      if (t.importKey) have.set(t.importKey, (have.get(t.importKey) || 0) + 1);
    }
    return incoming.map((t) => {
      const k = dupKey(t);
      const n = have.get(k) || 0;
      if (n > 0) {
        have.set(k, n - 1);
        return { ...t, duplicate: true };
      }
      return { ...t, duplicate: false };
    });
  }

  // What to remember for this account.
  function layoutToSave(layout) {
    const { delimiter, signature, columns, dateFormat, decimal } = layout;
    return { delimiter, signature, columns, dateFormat, decimal };
  }

  const api = {
    parseRows, detectDelimiter, parseDate, detectDateFormat, detectDecimal, parseAmount, guessColumns,
    analyze, toTransactions, endBalance, markDuplicates, dupKey, layoutToSave, DATE_FORMATS, PRESETS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BankCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
