// Unit tests for src/statement.js — the PDF statement, built with the real jsPDF in Node.
const test = require('node:test');
const assert = require('node:assert/strict');

global.self = global;
global.jspdf = require('jspdf');
require('jspdf-autotable');
const Core = require('../../src/balances.js');
const Cat = require('../../src/categories.js');
require('../../src/statement.js');
const S = global.SplitStatement;

const deps = { calculateBalances: Core.calculateBalances, suggestSettlements: Core.suggestSettlements,
  formatPaise: Core.formatPaise, categoryOf: Cat.categoryOf, monthlySpend: Cat.monthlySpend };

// Text drawn in the (uncompressed) PDF: "(…) Tj" operators.
const textOf = (doc) => [...doc.output().matchAll(/\((.*?)\) Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1'));

const members = [{ id: 'a', name: 'Akhil' }, { id: 'b', name: 'Babji' }, { id: 'c', name: 'Chen' }];
const trip = {
  groupName: 'Goa: Trip ✈️ 2026',
  members,
  expenses: [
    { id: 'e1', description: 'Hotel booking', paidBy: 'a', amount: 300000, splitMode: 'equal', createdAt: '2026-08-10T06:00:00Z', splits: Core.splitEqually(300000, ['a', 'b', 'c']) },
    { id: 'e2', description: 'Dinner “seafood”', paidBy: 'b', amount: 100100, splitMode: 'exact', createdAt: '2026-09-02T15:00:00Z',
      splits: [{ memberId: 'a', amount: 50050 }, { memberId: 'b', amount: 50050 }] },
    { id: 'e3', description: 'Ink', category: 'Office', paidBy: 'c', amount: 500, splitMode: 'equal', createdAt: '2026-09-03T15:00:00Z', splits: [{ memberId: 'c', amount: 500 }] },
    { id: 'e4', description: 'Treats', category: 'Pets', paidBy: 'c', amount: 700, splitMode: 'equal', createdAt: '2026-09-04T15:00:00Z', splits: [{ memberId: 'c', amount: 700 }] },
  ],
  settlements: [{ id: 's1', from: 'c', to: 'a', amount: 50000, note: 'UPI', createdAt: '2026-09-05T10:00:00Z' }],
};

test('pdfText turns characters the PDF fonts lack into safe ones', () => {
  assert.equal(S.pdfText('₹1,000'), 'Rs. 1,000');
  assert.equal(S.pdfText('−₹5 – “ok” ‘x’ … →'), '-Rs. 5 - "ok" \'x\' ... ->');
  assert.equal(S.pdfText('Trip ✈️'), 'Trip ??');
  assert.equal(S.pdfText(null), '');
});

test('file name is safe and dated', () => {
  const name = S.fileName(trip);
  assert.match(name, /^Goa-Trip-2026-statement-\d{4}-\d{2}-\d{2}\.pdf$/);
  assert.match(S.fileName({ groupName: '✈️✈️' }), /^group-statement-/);
});

test('a full statement: all sections, balances, settle-up, category + month tables', () => {
  const doc = S.build(trip, deps);
  const text = textOf(doc);
  const has = (t) => text.some((x) => x.includes(t));
  for (const h of ['Balances', 'Settle up', 'Spending by category', 'Spending by month', 'Expenses', 'Payments']) assert.ok(text.includes(h), h);
  assert.ok(has('Rs. 4,013.00'), 'total spent (300000 + 100100 + 500 + 700 paise)');
  assert.ok(has('Hotel booking') && has('Dinner "seafood"'), 'expense rows, quotes made safe');
  assert.ok(has('Equally: Akhil, Babji, Chen'), 'equal split described');
  assert.ok(has('Akhil 500.50') , 'exact split lists each share');
  assert.ok(has('(incl. Pets)'), 'folded custom categories named');
  assert.ok(has('gets back') && has('owes'), 'balance wording');
  assert.ok(has('Page 1 of'), 'page footer');
  assert.ok(!text.some((x) => /[₹−]/.test(x)), 'no unsupported glyphs');
  assert.ok(doc.output().startsWith('%PDF-'), 'a real PDF');
});

test('an empty group still produces a statement with friendly messages', () => {
  const doc = S.build({ groupName: 'Empty', members, expenses: [], settlements: [] }, deps);
  const text = textOf(doc);
  assert.ok(text.includes('No expenses recorded.'));
  assert.ok(text.includes('Everyone is settled up. No payments needed.'));
  assert.ok(text.includes('No expenses yet  ·  Generated ' + text.find((t) => t.startsWith('No expenses yet')).split('Generated ')[1]));
  assert.ok(!text.includes('Payments'), 'no payments table without payments');
});

test('long groups flow onto more pages, each with a footer', () => {
  const many = [];
  for (let i = 0; i < 80; i++) many.push({ id: 'x' + i, description: `Expense ${i}`, paidBy: 'a', amount: 1000 + i, splitMode: 'equal',
    createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), splits: Core.splitEqually(1000 + i, ['a', 'b']) });
  const doc = S.build({ groupName: 'Long', members, expenses: many, settlements: [] }, deps);
  const pages = doc.internal.getNumberOfPages();
  assert.ok(pages >= 3, `pages: ${pages}`);
  assert.ok(textOf(doc).includes(`Page ${pages} of ${pages}`));
});
