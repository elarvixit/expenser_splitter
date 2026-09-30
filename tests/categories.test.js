/*
 * Unit tests for src/categories.js.
 * Run in a browser via tests/index.html, or with Node:  node tests/categories.test.js
 */
(function (root) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const C = isNode ? require('../src/categories.js') : root.SplitCategories;
  const { guessCategory, normalizeCategory, categoryOf, monthlySpend, customCategories, PRESETS } = C;

  const results = [];
  let currentGroup = '';
  const group = (name, fn) => { currentGroup = name; fn(); };
  function test(name, fn) {
    try { fn(); results.push({ group: currentGroup, name, ok: true }); }
    catch (err) { results.push({ group: currentGroup, name, ok: false, error: err && err.stack ? err.stack : String(err) }); }
  }
  const show = (v) => JSON.stringify(v);
  const assert = {
    equal(a, e, m) { if (a !== e) throw new Error(`${m || 'not equal'}: expected ${show(e)}, got ${show(a)}`); },
    deepEqual(a, e, m) { if (show(a) !== show(e)) throw new Error(`${m || 'not deep-equal'}:\n  expected ${show(e)}\n  got      ${show(a)}`); },
  };

  const exp = (description, amount, createdAt, category) => ({ description, amount, createdAt, category });

  group('guessing categories', () => {
    test('common descriptions land in the right preset', () => {
      const cases = {
        'Hotel booking (2 nights)': 'Stay', 'Villa in Assagao': 'Stay', 'Cab to the airport': 'Travel',
        'Petrol for the bike': 'Travel', 'Scooter rentals': 'Travel', 'Flight booking': 'Travel',
        'Biryani dinner at Paradise': 'Food', 'Groceries & snacks': 'Food', 'Seafood dinner': 'Food',
        'Movie tickets': 'Entertainment', 'Parasailing': 'Entertainment', 'Rent top-up': 'Bills',
        'Electricity bill': 'Bills', 'Birthday gift': 'Shopping', 'Water bottles': 'Other', 'Misc': 'Other',
      };
      for (const [text, want] of Object.entries(cases)) assert.equal(guessCategory(text), want, text);
    });
    test('an explicit category always wins over the guess', () => {
      assert.equal(categoryOf(exp('Biryani', 100, '2026-09-01', 'Bills')), 'Bills');
      assert.equal(categoryOf(exp('Biryani', 100, '2026-09-01', '')), 'Food');
      assert.equal(categoryOf(exp('Biryani', 100, '2026-09-01', null)), 'Food');
    });
    test('preset names match case-insensitively; custom names are trimmed and capped', () => {
      assert.equal(normalizeCategory('  food '), 'Food');
      assert.equal(normalizeCategory('ENTERTAINMENT'), 'Entertainment');
      assert.equal(normalizeCategory('  Office   supplies '), 'Office supplies');
      assert.equal(normalizeCategory('x'.repeat(40)).length, 24);
      assert.equal(normalizeCategory('   '), '');
    });
  });

  group('monthly spend', () => {
    const expenses = [
      exp('Hotel', 1250000, '2026-07-10T10:00:00+05:30'),
      exp('Dinner', 30000, '2026-07-20T21:00:00+05:30'),
      exp('Cab', 50000, '2026-09-02T09:00:00+05:30'),
      exp('Snacks', 1001, '2026-09-30T20:00:00+05:30'),
    ];
    const r = monthlySpend(expenses);

    test('months run first → last with empty months filled', () => {
      assert.deepEqual(r.months.map((m) => m.key), ['2026-07', '2026-08', '2026-09']);
      assert.deepEqual(r.months.map((m) => m.total), [1280000, 0, 51001]);
    });
    test('totals are exact integer paise and add up', () => {
      assert.equal(r.total, 1250000 + 30000 + 50000 + 1001);
      const seriesSum = r.series.reduce((a, s) => a + s.total, 0);
      assert.equal(seriesSum, r.total, 'series totals add up to the grand total');
      for (const m of r.months) {
        assert.equal(Object.values(m.byCategory).reduce((a, b) => a + b, 0), m.total, `month ${m.key} adds up`);
      }
    });
    test('series are in fixed palette order and only include categories with spend', () => {
      assert.deepEqual(r.series.map((s) => s.name), ['Food', 'Travel', 'Stay']);
      assert.equal(r.series.find((s) => s.name === 'Food').color, PRESETS.find((p) => p.name === 'Food').color);
    });
    test('a category keeps its colour whatever else is present', () => {
      const onlyStay = monthlySpend([exp('Hotel', 100, '2026-01-01T10:00:00Z')]);
      assert.equal(onlyStay.series[0].color, r.series.find((s) => s.name === 'Stay').color);
    });
    test('only the most recent 12 months are shown', () => {
      const many = [];
      for (let i = 0; i < 18; i++) many.push(exp('Dinner', 100, new Date(2025, i, 15).toISOString()));
      const m = monthlySpend(many);
      assert.equal(m.months.length, 12);
      assert.equal(m.months[m.months.length - 1].key, '2026-06');
      assert.equal(m.total, 1200, 'total covers only the shown months');
    });
    test('no expenses → no months, no series', () => {
      assert.deepEqual(monthlySpend([]), { months: [], series: [], total: 0 });
    });
  });

  group('custom categories', () => {
    const expenses = [
      exp('Printer ink', 500, '2026-09-01T10:00:00Z', 'Office'),
      exp('Dog food', 300, '2026-09-02T10:00:00Z', 'Pets'),
      exp('Stickers', 200, '2026-09-03T10:00:00Z', 'Office'),
      exp('Misc', 100, '2026-09-04T10:00:00Z', 'Other'),
    ];
    test('custom categories are listed in order of first use', () => {
      assert.deepEqual(customCategories(expenses), ['Office', 'Pets']);
    });
    test('the first custom gets its own colour; later customs fold into Other', () => {
      const r = monthlySpend(expenses);
      assert.deepEqual(r.series.map((s) => [s.name, s.total]), [['Office', 700], ['Other', 400]]);
      assert.equal(r.series[0].color, C.CUSTOM_COLOR);
      assert.deepEqual(r.series[1].includes, ['Pets']);
    });
  });

  const failed = results.filter((r) => !r.ok);
  if (isNode) {
    for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.group} › ${r.name}${r.ok ? '' : '\n    ' + r.error}`);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exitCode = 1;
  } else {
    root.TEST_RESULTS = (root.TEST_RESULTS || []).concat(results);
  }
})(typeof self !== 'undefined' ? self : this);
