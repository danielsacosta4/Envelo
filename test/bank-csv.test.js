const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/bank-csv.js');

test('amounts in European and English formats', () => {
  assert.equal(C.parseAmount('-1.234,56', ','), -123456);
  assert.equal(C.parseAmount('1,234.56', '.'), 123456);
  assert.equal(C.parseAmount('12,50 €', ','), 1250);
  assert.equal(C.parseAmount('(45.00)', '.'), -4500);
  assert.equal(C.parseAmount('45.00-', '.'), -4500);
  assert.ok(Number.isNaN(C.parseAmount('abc', '.')));
  assert.equal(C.detectDecimal(['-12,50', '1.200,00', '3,99']), ',');
  assert.equal(C.detectDecimal(['-12.50', '1,200.00']), '.');
});

test('dates: ISO, day first, month first and compact', () => {
  assert.equal(C.parseDate('2026-10-14 13:45:00', 'YYYY-MM-DD'), '2026-10-14');
  assert.equal(C.parseDate('14/10/2026', 'DD-MM-YYYY'), '2026-10-14');
  assert.equal(C.parseDate('31.02.2026', 'DD-MM-YYYY'), null);
  assert.equal(C.detectDateFormat(['01/02/2026', '14/10/2026']), 'DD-MM-YYYY');
  assert.equal(C.detectDateFormat(['10/14/2026', '01/02/2026']), 'MM-DD-YYYY');
  assert.equal(C.detectDateFormat(['20261014']), 'YYYYMMDD');
});

test('a Portuguese bank export with a title, semicolons and debit/credit columns', () => {
  const csv = [
    'Consulta de movimentos;;;;',
    'Conta: 0000 1234;;;;',
    'Data Movimento;Data Valor;Descrição;Débito;Crédito;Saldo',
    '14-10-2026;14-10-2026;COMPRA LIDL LISBOA;23,40;;1.234,56',
    '13-10-2026;13-10-2026;TRF SALARIO;;1.450,00;1.257,96',
  ].join('\n');
  const layout = C.analyze(csv);
  assert.equal(layout.delimiter, ';');
  assert.equal(layout.decimal, ',');
  assert.equal(layout.dateFormat, 'DD-MM-YYYY');
  assert.equal(layout.header[layout.columns.payee], 'Descrição');
  const { transactions, errors } = C.toTransactions(layout);
  assert.equal(errors.length, 0);
  assert.deepEqual(transactions.map((t) => [t.date, t.payee, t.amount]), [
    ['2026-10-14', 'COMPRA LIDL LISBOA', -2340],
    ['2026-10-13', 'TRF SALARIO', 145000],
  ]);
});

test('Revolut preset skips pending rows and includes the fee', () => {
  const csv = [
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
    'CARD_PAYMENT,Current,2026-10-01 10:00:00,2026-10-02 09:00:00,Lidl,-23.40,0.00,EUR,COMPLETED,100.00',
    'TRANSFER,Current,2026-10-03 10:00:00,,To Ana,-50.00,0.50,EUR,PENDING,50.00',
    'EXCHANGE,Current,2026-10-04 10:00:00,2026-10-04 10:00:00,Exchanged to USD,-10.00,0.20,EUR,COMPLETED,39.80',
  ].join('\n');
  const layout = C.analyze(csv);
  assert.equal(layout.preset, 'revolut');
  const { transactions } = C.toTransactions(layout);
  assert.deepEqual(transactions.map((t) => [t.date, t.payee, t.amount]), [
    ['2026-10-02', 'Lidl', -2340],
    ['2026-10-04', 'Exchanged to USD', -1020],
  ]);
});

test('N26 preset and a remembered layout', () => {
  const csv = [
    '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"',
    '2026-10-05,2026-10-05,"Pingo Doce",,Presentment,"",Main,-12.3,,,',
  ].join('\n');
  const layout = C.analyze(csv);
  assert.equal(layout.preset, 'n26');
  const saved = C.layoutToSave(layout);
  const again = C.analyze(csv, saved);
  assert.deepEqual(again.columns, layout.columns);
  assert.deepEqual(C.toTransactions(again).transactions[0], { line: 1, date: '2026-10-05', payee: 'Pingo Doce', note: '', amount: -1230, balance: null });
});

test('duplicates already in the account are marked, extra identical rows are not', () => {
  const existing = [{ date: '2026-10-01', amount: -250, payee: 'Café' }];
  const incoming = [
    { date: '2026-10-01', amount: -250, payee: 'café' },
    { date: '2026-10-01', amount: -250, payee: 'Café' },
    { date: '2026-10-02', amount: -900, payee: 'Galp' },
  ];
  assert.deepEqual(C.markDuplicates(incoming, existing).map((t) => t.duplicate), [true, false, false]);
});

test('a headerless file is read from its values', () => {
  const csv = '2026-10-01,Lidl,-23.40\n2026-10-02,Salary,1450.00\n';
  const layout = C.analyze(csv);
  assert.equal(layout.hasHeader, false);
  const { transactions } = C.toTransactions(layout);
  assert.deepEqual(transactions.map((t) => t.amount), [-2340, 145000]);
  assert.equal(transactions[0].payee, 'Lidl');
});

test('a balance column is found and gives the bank balance after the newest row', () => {
  const text = 'Date;Description;Amount;Balance\n03-10-2026;Shop;-10,00;90,00\n01-10-2026;Salary;100,00;100,00\n';
  const L = C.analyze(text);
  assert.equal(L.columns.amount, 2);
  assert.equal(L.columns.balance, 3);
  const { transactions } = C.toTransactions(L);
  assert.deepEqual(C.endBalance(transactions), { date: '2026-10-03', balance: 9000 });
  assert.equal(C.endBalance([{ date: '2026-10-01', balance: null }]), null);
});
