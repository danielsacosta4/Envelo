'use strict';

// Import a full Actual Budget export (the .zip from Settings > Export).
// The zip holds db.sqlite and metadata.json. We read the zip with zlib,
// query the database with node:sqlite when available (Node 22.5+) or the
// sqlite3 command line tool otherwise, and map it to an Envelo budget.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const newId = () => crypto.randomUUID();

// Return the bytes of one file in a zip, or null if it is not there.
function readZipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a zip archive.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip archive is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted && !name.endsWith(`/${wanted}`)) continue;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('The zip archive is damaged.');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(start, start + compressedSize);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error('The zip uses a compression method Envelo cannot read.');
  }
  return null;
}

// Run queries against a SQLite file. Missing tables return no rows, so older
// and newer Actual versions both work.
function openDatabase(file, engine) {
  let sqlite = null;
  if (engine !== 'cli') {
    try {
      // node:sqlite exists from Node 22.5. Older Node falls back to the CLI.
      sqlite = require('node:sqlite');
    } catch {
      sqlite = null;
    }
  }
  if (sqlite && engine !== 'cli') {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    return {
      all(sql) {
        try {
          return db.prepare(sql).all();
        } catch (err) {
          if (/no such table/i.test(err.message)) return [];
          throw err;
        }
      },
      close: () => db.close(),
    };
  }
  return {
    all(sql) {
      try {
        const out = execFileSync('sqlite3', ['-readonly', '-json', file, sql], {
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return out.trim() ? JSON.parse(out) : [];
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error('The server needs SQLite to read Actual files. Run `update` in the container to install it.');
        }
        if (/no such table/i.test(String(err.stderr || err.message))) return [];
        throw new Error('Could not read the Actual database.');
      }
    },
    close() {},
  };
}

const live = (r) => !Number(r.tombstone);
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';

function intDate(n) {
  const s = String(n);
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function intMonth(n) {
  const s = String(n);
  if (!/^\d{6}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
}

// Map rows read from Actual's tables to an Envelo budget.
function actualToEnvelo(rows, { currency = 'EUR' } = {}) {
  const budget = {
    version: 1, currency, accounts: [], envelopes: [], transactions: [], assignments: {}, recurring: [],
  };
  const summary = {
    accounts: 0, offBudgetAccounts: 0, envelopes: 0, transactions: 0, transfers: 0, months: 0,
    negativeBudgetsSkipped: 0, uncategorized: 0,
  };

  // Accounts, on and off budget. Off-budget accounts (mortgage, investments)
  // keep their balance but never touch Ready to Assign or envelopes.
  const accountIds = new Map();
  const offBudget = new Set();
  for (const a of rows.accounts.filter(live)) {
    const id = newId();
    accountIds.set(a.id, id);
    const off = flag(a.offbudget);
    if (off) offBudget.add(a.id);
    budget.accounts.push({ id, name: String(a.name || 'Account'), offBudget: off, reconciledAt: null, reconciledBalance: null });
  }
  summary.accounts = budget.accounts.length;
  summary.offBudgetAccounts = offBudget.size;

  // Categories: expense categories become envelopes; income ones feed Ready to Assign.
  const groups = new Map(rows.groups.map((g) => [g.id, g]));
  const categoryMap = new Map(rows.categoryMapping.map((m) => [m.id, m.transferId]));
  const resolveCategory = (id) => (id && categoryMap.has(id) ? categoryMap.get(id) : id);
  const envelopeIds = new Map();
  const incomeCategories = new Set();
  for (const c of rows.categories.filter(live)) {
    const group = groups.get(c.cat_group);
    if (flag(c.is_income) || (group && flag(group.is_income))) {
      incomeCategories.add(c.id);
      continue;
    }
    const id = newId();
    envelopeIds.set(c.id, id);
    budget.envelopes.push({ id, name: String(c.name || 'Envelope'), group: group ? String(group.name) : 'General', target: null });
  }
  let uncategorizedId = null;
  const uncategorized = () => {
    if (!uncategorizedId) {
      uncategorizedId = newId();
      budget.envelopes.push({ id: uncategorizedId, name: 'Uncategorized', group: 'Imported', target: null });
    }
    return uncategorizedId;
  };

  // Payees
  const payeeMap = new Map(rows.payeeMapping.map((m) => [m.id, m.targetId]));
  const payees = new Map(rows.payees.map((p) => [p.id, p]));
  const payeeName = (id) => {
    const p = payees.get(payeeMap.get(id) || id);
    return p && p.name ? String(p.name) : '';
  };

  // Transactions. Split parents are skipped; their children carry the amounts.
  const all = rows.transactions.filter(live);
  const byId = new Map(all.map((t) => [t.id, t]));
  for (const t of all) {
    if (flag(t.isParent) || flag(t.is_parent)) continue;
    const accountId = accountIds.get(t.acct);
    if (!accountId) continue; // account was deleted in Actual
    const date = intDate(t.date);
    const amount = Number(t.amount);
    if (!date || !Number.isInteger(amount) || amount === 0) continue;
    const parent = t.parent_id ? byId.get(t.parent_id) : null;
    const tx = {
      id: newId(),
      date,
      payee: flag(t.starting_balance_flag) ? 'Starting balance' : payeeName(t.description || (parent && parent.description)),
      note: String(t.notes || ''),
      amount,
      envelopeId: null,
      accountId,
      importKey: `actual:${t.id}`,
    };
    if (flag(t.reconciled)) tx.reconciled = true;

    const other = t.transferred_id ? byId.get(t.transferred_id) : null;
    const isTransfer = !!(other && accountIds.has(other.acct));
    if (isTransfer) {
      // Both legs share an id.
      tx.transferId = `actual:${[t.id, other.id].sort().join(':')}`;
      tx.toAccountId = accountIds.get(other.acct);
      summary.transfers++;
    }
    if (offBudget.has(t.acct)) {
      tx.envelopeId = null; // off-budget: no envelopes
    } else if (isTransfer && !offBudget.has(other.acct)) {
      tx.envelopeId = null; // between two on-budget accounts: budget-neutral
    } else {
      // On-budget spending or income, including transfers to or from an
      // off-budget account (Actual categorizes those on the budget side).
      const cat = resolveCategory(t.category);
      if (cat && envelopeIds.has(cat)) {
        tx.envelopeId = envelopeIds.get(cat);
      } else if ((cat && incomeCategories.has(cat)) || (!cat && amount > 0)) {
        tx.envelopeId = null; // income
      } else {
        tx.envelopeId = uncategorized();
        summary.uncategorized++;
      }
    }
    budget.transactions.push(tx);
  }
  summary.transactions = budget.transactions.length;
  summary.transfers = Math.round(summary.transfers / 2);

  // Budgeted amounts per month (envelope budgeting is stored in zero_budgets).
  const months = new Set();
  for (const z of rows.budgets) {
    const month = intMonth(z.month);
    const envId = envelopeIds.get(resolveCategory(z.category));
    const amount = Number(z.amount);
    if (!month || !envId || !Number.isInteger(amount) || amount === 0) continue;
    if (amount < 0) {
      summary.negativeBudgetsSkipped++;
      continue;
    }
    budget.assignments[month] = budget.assignments[month] || {};
    budget.assignments[month][envId] = (budget.assignments[month][envId] || 0) + amount;
    months.add(month);
  }
  summary.months = months.size;
  summary.envelopes = budget.envelopes.length;
  return { budget, summary };
}

function importActualZip(zipBuffer, { currency, engine, tmpDir } = {}) {
  const dbBytes = readZipEntry(zipBuffer, 'db.sqlite');
  if (!dbBytes) {
    throw new Error('This zip has no db.sqlite. In Actual, use Settings > Export data and import that file.');
  }
  let name = '';
  const meta = readZipEntry(zipBuffer, 'metadata.json');
  if (meta) {
    try { name = JSON.parse(meta.toString('utf8')).budgetName || ''; } catch { /* name is optional */ }
  }

  // tmpDir lets the server use a folder it can write to; under systemd's
  // ProtectSystem=strict the system /tmp may be read-only.
  const base = tmpDir || os.tmpdir();
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(base, 'envelo-actual-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    fs.writeFileSync(file, dbBytes, { mode: 0o600 });
    const db = openDatabase(file, engine);
    try {
      const rows = {
        accounts: db.all('SELECT * FROM accounts'),
        groups: db.all('SELECT * FROM category_groups'),
        categories: db.all('SELECT * FROM categories'),
        categoryMapping: db.all('SELECT * FROM category_mapping'),
        payees: db.all('SELECT * FROM payees'),
        payeeMapping: db.all('SELECT * FROM payee_mapping'),
        transactions: db.all('SELECT * FROM transactions'),
        budgets: db.all('SELECT * FROM zero_budgets'),
      };
      const result = actualToEnvelo(rows, { currency });
      result.summary.name = name;
      return result;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { readZipEntry, actualToEnvelo, importActualZip };
