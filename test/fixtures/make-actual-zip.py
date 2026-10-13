# Builds a small Actual Budget export (zip with db.sqlite + metadata.json) for tests.
import json, sqlite3, sys, os, tempfile, zipfile

out = sys.argv[1]
tmp = tempfile.mkdtemp()
db_path = os.path.join(tmp, 'db.sqlite')
db = sqlite3.connect(db_path)
db.executescript('''
CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, offbudget INTEGER, closed INTEGER, tombstone INTEGER);
CREATE TABLE category_groups (id TEXT PRIMARY KEY, name TEXT, is_income INTEGER, tombstone INTEGER);
CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, cat_group TEXT, is_income INTEGER, tombstone INTEGER);
CREATE TABLE category_mapping (id TEXT PRIMARY KEY, transferId TEXT);
CREATE TABLE payees (id TEXT PRIMARY KEY, name TEXT, transfer_acct TEXT, tombstone INTEGER);
CREATE TABLE payee_mapping (id TEXT PRIMARY KEY, targetId TEXT);
CREATE TABLE transactions (id TEXT PRIMARY KEY, acct TEXT, category TEXT, amount INTEGER, description TEXT,
  notes TEXT, date INTEGER, isParent INTEGER, isChild INTEGER, parent_id TEXT, tombstone INTEGER,
  transferred_id TEXT, starting_balance_flag INTEGER, reconciled INTEGER);
CREATE TABLE zero_budgets (id TEXT PRIMARY KEY, month INTEGER, category TEXT, amount INTEGER, carryover INTEGER);
''')
db.executemany('INSERT INTO accounts VALUES (?,?,?,?,?)', [
  ('a1', 'Checking', 0, 0, 0), ('a2', 'Savings', 0, 0, 0), ('a3', 'Mortgage', 1, 0, 0)])
db.executemany('INSERT INTO category_groups VALUES (?,?,?,?)', [
  ('g1', 'Bills', 0, 0), ('g2', 'Daily', 0, 0), ('gi', 'Income', 1, 0)])
db.executemany('INSERT INTO categories VALUES (?,?,?,?,?)', [
  ('c1', 'Rent', 'g1', 0, 0), ('c2', 'Groceries', 'g2', 0, 0), ('c3', 'Old food', 'g2', 0, 1), ('ci', 'Salary', 'gi', 1, 0)])
db.executemany('INSERT INTO category_mapping VALUES (?,?)', [('c1', 'c1'), ('c2', 'c2'), ('c3', 'c2'), ('ci', 'ci')])
db.executemany('INSERT INTO payees VALUES (?,?,?,?)', [
  ('p1', 'Landlord', None, 0), ('p2', 'Market', None, 0), ('p3', 'Employer', None, 0)])
db.executemany('INSERT INTO payee_mapping VALUES (?,?)', [('p1', 'p1'), ('p2', 'p2'), ('p3', 'p3')])
T = 'INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
db.executemany(T, [
  ('t1', 'a1', 'ci', 250000, 'p3', '', 20261001, 0, 0, None, 0, None, 0, 0),
  ('t2', 'a1', 'c1', -90000, 'p1', 'October', 20261003, 0, 0, None, 0, None, 0, 1),
  ('t3', 'a1', 'c3', -4000, 'p2', '', 20261004, 0, 0, None, 0, None, 0, 0),
  ('t4', 'a1', None, -5000, 'p2', '', 20261005, 1, 0, None, 0, None, 0, 0),
  ('t5', 'a1', 'c2', -3000, None, '', 20261005, 0, 1, 't4', 0, None, 0, 0),
  ('t6', 'a1', 'c1', -2000, None, '', 20261005, 0, 1, 't4', 0, None, 0, 0),
  ('t7', 'a1', None, -20000, None, '', 20261006, 0, 0, None, 0, 't8', 0, 0),
  ('t8', 'a2', None, 20000, None, '', 20261006, 0, 0, None, 0, 't7', 0, 0),
  ('t9', 'a3', 'c1', -1000, None, '', 20261007, 0, 0, None, 0, None, 0, 0),
  ('t10', 'a1', 'c2', -500, 'p2', '', 20261008, 0, 0, None, 1, None, 0, 0),
  ('t11', 'a1', None, -700, None, '', 20261009, 0, 0, None, 0, None, 0, 0),
  ('t12', 'a1', 'ci', 100000, None, '', 20260930, 0, 0, None, 0, None, 1, 0),
  # Mortgage payment: on-budget leg categorized, off-budget leg not.
  ('t13', 'a1', 'c1', -50000, None, 'Mortgage', 20261010, 0, 0, None, 0, 't14', 0, 0),
  ('t14', 'a3', None, 50000, None, '', 20261010, 0, 0, None, 0, 't13', 0, 0),
  # Off-budget starting balance (a loan) must not reach Ready to Assign.
  ('t15', 'a3', None, -20000000, None, '', 20260930, 0, 0, None, 0, None, 1, 0),
])
db.executemany('INSERT INTO zero_budgets VALUES (?,?,?,?,?)', [
  ('202610-c1', 202610, 'c1', 90000, 0), ('202610-c3', 202610, 'c3', 30000, 0), ('202610-c2x', 202610, 'c2', -100, 0)])
db.commit(); db.close()
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.write(db_path, 'db.sqlite')
    z.writestr('metadata.json', json.dumps({'budgetName': 'Home budget'}))
