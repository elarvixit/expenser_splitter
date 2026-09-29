/*
 * Unit tests for src/balances.js.
 * Run in a browser via tests/index.html, or with Node:  node tests/balances.test.js
 */
(function (root) {
  'use strict';

  const Core =
    typeof module === 'object' && module.exports ? require('../src/balances.js') : root.SplitCore;
  const {
    calculateBalances,
    suggestSettlements,
    splitEqually,
    splitByPercentage,
    splitExact,
    parseRupees,
    formatPaise,
    ValidationError,
  } = Core;

  // ---------- tiny harness ----------
  const results = [];
  let currentGroup = '';
  function group(name, fn) {
    currentGroup = name;
    fn();
  }
  function test(name, fn) {
    try {
      fn();
      results.push({ group: currentGroup, name, ok: true });
    } catch (err) {
      results.push({ group: currentGroup, name, ok: false, error: err && err.stack ? err.stack : String(err) });
    }
  }
  function show(v) {
    return JSON.stringify(v);
  }
  const assert = {
    equal(actual, expected, msg) {
      if (actual !== expected) throw new Error(`${msg || 'not equal'}: expected ${show(expected)}, got ${show(actual)}`);
    },
    deepEqual(actual, expected, msg) {
      if (show(actual) !== show(expected)) {
        throw new Error(`${msg || 'not deep-equal'}:\n  expected ${show(expected)}\n  got      ${show(actual)}`);
      }
    },
    throws(fn, pattern) {
      try {
        fn();
      } catch (err) {
        if (!(err instanceof ValidationError)) throw new Error(`expected ValidationError, got ${err}`);
        if (pattern && !pattern.test(err.message)) throw new Error(`error "${err.message}" does not match ${pattern}`);
        return;
      }
      throw new Error('expected function to throw');
    },
  };

  // ---------- fixtures ----------
  const A = 'asha';
  const B = 'bilal';
  const C = 'chen';
  const D = 'dev';
  const members = [A, B, C, D].map((id) => ({ id, name: id }));
  const three = members.slice(0, 3);

  function expense(id, paidBy, amount, splits) {
    return { id, paidBy, amount, splits };
  }
  function equal(id, paidBy, amount, ids) {
    return expense(id, paidBy, amount, splitEqually(amount, ids));
  }

  /** Invariants every result must satisfy; checked after every scenario. */
  function checkInvariants(input, result) {
    const { balances, debts } = result;
    const ids = input.members.map((m) => m.id);

    assert.deepEqual(Object.keys(balances).sort(), ids.slice().sort(), 'one balance per member');
    let sum = 0;
    for (const id of ids) {
      if (!Number.isSafeInteger(balances[id])) throw new Error(`balance for ${id} is not an integer`);
      sum += balances[id];
    }
    assert.equal(sum, 0, 'balances sum to zero');

    // Balances equal paid − owed + settlements sent − settlements received.
    const direct = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const e of input.expenses || []) {
      direct[e.paidBy] += e.amount;
      for (const s of e.splits) direct[s.memberId] -= s.amount;
    }
    for (const s of input.settlements || []) {
      direct[s.from] += s.amount;
      direct[s.to] -= s.amount;
    }
    assert.deepEqual(balances, direct, 'balances match the ledger formula');

    // Pairwise debts are positive, one per pair, never to self, and net to the balances.
    const seen = new Set();
    const fromDebts = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const d of debts) {
      if (!Number.isSafeInteger(d.amount) || d.amount <= 0) throw new Error(`bad debt amount ${show(d)}`);
      if (d.from === d.to) throw new Error('self debt');
      const key = [d.from, d.to].sort().join('|');
      if (seen.has(key)) throw new Error(`pair ${key} appears twice`);
      seen.add(key);
      fromDebts[d.to] += d.amount;
      fromDebts[d.from] -= d.amount;
    }
    assert.deepEqual(fromDebts, balances, 'pairwise debts net to balances');

    // Suggested settlements clear every balance.
    const after = Object.assign({}, balances);
    const transfers = suggestSettlements(balances);
    for (const t of transfers) {
      after[t.from] += t.amount;
      after[t.to] -= t.amount;
    }
    for (const id of ids) assert.equal(after[id], 0, `suggested transfers settle ${id}`);
    const nonZero = ids.filter((id) => balances[id] !== 0).length;
    if (transfers.length > Math.max(0, nonZero - 1)) throw new Error('too many suggested transfers');
  }

  function run(input) {
    const snapshot = JSON.stringify(input);
    const result = calculateBalances(input);
    assert.equal(JSON.stringify(input), snapshot, 'input was not mutated');
    checkInvariants(input, result);
    return result;
  }

  // ---------- scenarios ----------

  group('equal splits', () => {
    test('one person pays equally for three people', () => {
      const input = { members: three, expenses: [equal('e1', A, 90000, [A, B, C])] };
      const { balances, debts } = run(input);
      assert.deepEqual(balances, { asha: 60000, bilal: -30000, chen: -30000 });
      assert.deepEqual(debts, [
        { from: B, to: A, amount: 30000 },
        { from: C, to: A, amount: 30000 },
      ]);
    });

    test('payer included in split: own share creates no self-debt', () => {
      const input = { members: three, expenses: [equal('e1', A, 10000, [A, B])] };
      const { balances, debts } = run(input);
      assert.deepEqual(balances, { asha: 5000, bilal: -5000, chen: 0 });
      assert.deepEqual(debts, [{ from: B, to: A, amount: 5000 }]);
    });

    test('payer excluded from split: payer is owed the full amount', () => {
      const input = { members, expenses: [equal('e1', A, 30000, [B, C, D])] };
      const { balances, debts } = run(input);
      assert.deepEqual(balances, { asha: 30000, bilal: -10000, chen: -10000, dev: -10000 });
      assert.equal(debts.length, 3);
      assert.equal(debts.every((d) => d.to === A && d.amount === 10000), true);
    });

    test('member not in any expense stays at zero', () => {
      const { balances } = run({ members, expenses: [equal('e1', A, 2000, [A, B])] });
      assert.equal(balances.chen, 0);
      assert.equal(balances.dev, 0);
    });

    test('no transactions: everyone is settled', () => {
      const { balances, debts } = run({ members, expenses: [], settlements: [] });
      assert.deepEqual(balances, { asha: 0, bilal: 0, chen: 0, dev: 0 });
      assert.deepEqual(debts, []);
    });
  });

  group('unequal splits', () => {
    test('unequal exact splits', () => {
      const splits = splitExact(100000, [
        { memberId: A, amount: 20000 },
        { memberId: B, amount: 30000 },
        { memberId: C, amount: 50000 },
      ]);
      const { balances, debts } = run({ members: three, expenses: [expense('e1', A, 100000, splits)] });
      assert.deepEqual(balances, { asha: 80000, bilal: -30000, chen: -50000 });
      assert.deepEqual(debts, [
        { from: C, to: A, amount: 50000 },
        { from: B, to: A, amount: 30000 },
      ]);
    });

    test('exact split that does not add up is rejected', () => {
      assert.throws(
        () => splitExact(1000, [{ memberId: A, amount: 400 }, { memberId: B, amount: 500 }]),
        /add up/
      );
      assert.throws(
        () => run({ members: three, expenses: [expense('e1', A, 1000, [{ memberId: B, amount: 999 }])] }),
        /add up to 999 paise/
      );
    });

    test('percentage splits', () => {
      const splits = splitByPercentage(100000, [
        { memberId: A, percent: 50 },
        { memberId: B, percent: 30 },
        { memberId: C, percent: 20 },
      ]);
      assert.deepEqual(splits, [
        { memberId: A, amount: 50000 },
        { memberId: B, amount: 30000 },
        { memberId: C, amount: 20000 },
      ]);
      const { balances } = run({ members: three, expenses: [expense('e1', C, 100000, splits)] });
      assert.deepEqual(balances, { asha: -50000, bilal: -30000, chen: 80000 });
    });

    test('percentage split with decimals uses largest remainder', () => {
      // 1000 paise × 33.33% = 333.3 → 333, × 33.33% → 333, × 33.34% = 333.4 → 333; 1 paisa left.
      const splits = splitByPercentage(1000, [
        { memberId: A, percent: 33.33 },
        { memberId: B, percent: 33.33 },
        { memberId: C, percent: 33.34 },
      ]);
      assert.deepEqual(splits.map((s) => s.amount), [333, 333, 334]);
    });

    test('percentages must total 100 and have at most two decimals', () => {
      assert.throws(() => splitByPercentage(1000, [{ memberId: A, percent: 50 }, { memberId: B, percent: 40 }]), /90%/);
      assert.throws(() => splitByPercentage(1000, [{ memberId: A, percent: 99.999 }, { memberId: B, percent: 0.001 }]), /two decimals/);
      assert.throws(() => splitByPercentage(1000, [{ memberId: A, percent: 110 }, { memberId: B, percent: -10 }]), /negative/);
    });
  });

  group('multiple transactions', () => {
    test('multiple expenses accumulate and net pairwise', () => {
      const input = {
        members: three,
        expenses: [equal('e1', A, 30000, [A, B, C]), equal('e2', B, 60000, [A, B, C])],
      };
      const { balances, debts } = run(input);
      assert.deepEqual(balances, { asha: 0, bilal: 30000, chen: -30000 });
      // A owed B 200, B owed A 100 → A owes B 100 net. C owes both.
      assert.deepEqual(debts, [
        { from: C, to: B, amount: 20000 },
        { from: A, to: B, amount: 10000 },
        { from: C, to: A, amount: 10000 },
      ]);
      assert.deepEqual(suggestSettlements(balances), [{ from: C, to: B, amount: 30000 }]);
    });

    test('order of transactions does not matter', () => {
      const expenses = [
        equal('e1', A, 12345, [A, B, C, D]),
        equal('e2', B, 777, [B, C]),
        equal('e3', D, 50001, [A, D]),
      ];
      const settlements = [{ id: 's1', from: C, to: A, amount: 1000 }];
      const forward = run({ members, expenses, settlements });
      const backward = run({ members: members.slice().reverse(), expenses: expenses.slice().reverse(), settlements });
      assert.deepEqual(forward.debts, backward.debts);
      for (const m of members) assert.equal(forward.balances[m.id], backward.balances[m.id]);
    });
  });

  group('settlements', () => {
    const base = { members: three, expenses: [equal('e1', A, 90000, [A, B, C])] };

    test('full settlement clears that pair', () => {
      const { balances, debts } = run(Object.assign({}, base, { settlements: [{ id: 's1', from: B, to: A, amount: 30000 }] }));
      assert.deepEqual(balances, { asha: 30000, bilal: 0, chen: -30000 });
      assert.deepEqual(debts, [{ from: C, to: A, amount: 30000 }]);
    });

    test('partial settlement reduces the debt', () => {
      const { balances, debts } = run(Object.assign({}, base, { settlements: [{ id: 's1', from: C, to: A, amount: 12500 }] }));
      assert.equal(balances.chen, -17500);
      assert.deepEqual(debts.find((d) => d.from === C), { from: C, to: A, amount: 17500 });
    });

    test('overpaying flips the direction of the debt', () => {
      const { balances, debts } = run(Object.assign({}, base, { settlements: [{ id: 's1', from: B, to: A, amount: 40000 }] }));
      assert.equal(balances.bilal, 10000);
      assert.deepEqual(debts.find((d) => d.from === A || d.to === B), { from: A, to: B, amount: 10000 });
    });

    test('everyone settling up leaves all balances at zero', () => {
      const input = Object.assign({}, base, {
        settlements: [
          { id: 's1', from: B, to: A, amount: 30000 },
          { id: 's2', from: C, to: A, amount: 30000 },
        ],
      });
      const { balances, debts } = run(input);
      assert.deepEqual(balances, { asha: 0, bilal: 0, chen: 0 });
      assert.deepEqual(debts, []);
    });
  });

  group('editing history', () => {
    const e1 = equal('e1', A, 90000, [A, B, C]);
    const e2 = equal('e2', B, 4500, [B, C]);

    test('deleting an expense equals never having added it', () => {
      const before = run({ members: three, expenses: [e1, e2] });
      const after = run({ members: three, expenses: [e1, e2].filter((e) => e.id !== 'e2') });
      const fresh = run({ members: three, expenses: [e1] });
      assert.deepEqual(after, fresh);
      assert.equal(before.balances.bilal, -30000 + 2250);
      assert.equal(after.balances.bilal, -30000);
    });

    test('deleting the only expense returns everyone to zero', () => {
      const { balances, debts } = run({ members: three, expenses: [] });
      assert.deepEqual(balances, { asha: 0, bilal: 0, chen: 0 });
      assert.deepEqual(debts, []);
    });

    test('editing an expense equals entering the corrected one from scratch', () => {
      const corrected = equal('e1', C, 60000, [A, C]); // wrong payer, amount and people
      const edited = [e1, e2].map((e) => (e.id === 'e1' ? corrected : e));
      const result = run({ members: three, expenses: edited });
      const fresh = run({ members: three, expenses: [corrected, e2] });
      assert.deepEqual(result.balances, fresh.balances);
      assert.deepEqual(result.balances, { asha: -30000, bilal: 2250, chen: 27750 });
    });

    test('recalculating twice gives identical results (no hidden state)', () => {
      const input = { members: three, expenses: [e1, e2] };
      assert.deepEqual(run(input), run(input));
    });
  });

  group('invalid amounts', () => {
    const ok = (amount) => ({ members: three, expenses: [expense('e1', A, amount, [{ memberId: B, amount }])] });

    test('zero expense amount is rejected', () => {
      assert.throws(() => run(ok(0)), /greater than zero/);
    });
    test('negative expense amount is rejected', () => {
      assert.throws(() => run(ok(-500)), /negative/);
    });
    test('fractional paise are rejected', () => {
      assert.throws(() => run(ok(10.5)), /whole number/);
      assert.throws(() => run(ok('100')), /whole number/);
    });
    test('negative share is rejected even if the total matches', () => {
      const bad = expense('e1', A, 1000, [{ memberId: B, amount: 1500 }, { memberId: C, amount: -500 }]);
      assert.throws(() => run({ members: three, expenses: [bad] }), /negative/);
    });
    test('a zero share is allowed', () => {
      const e = expense('e1', A, 1000, [{ memberId: A, amount: 0 }, { memberId: B, amount: 1000 }]);
      assert.deepEqual(run({ members: three, expenses: [e] }).debts, [{ from: B, to: A, amount: 1000 }]);
    });
    test('zero, negative or self settlements are rejected', () => {
      assert.throws(() => run({ members: three, settlements: [{ from: A, to: B, amount: 0 }] }), /greater than zero/);
      assert.throws(() => run({ members: three, settlements: [{ from: A, to: B, amount: -1 }] }), /negative/);
      assert.throws(() => run({ members: three, settlements: [{ from: A, to: A, amount: 100 }] }), /oneself/);
    });
    test('unknown or duplicate members are rejected', () => {
      assert.throws(() => run({ members: three, expenses: [equal('e1', 'zoe', 100, [A])] }), /unknown member/);
      assert.throws(() => run({ members: three, expenses: [expense('e1', A, 100, [{ memberId: B, amount: 50 }, { memberId: B, amount: 50 }])] }), /twice/);
      assert.throws(() => run({ members: [{ id: A }, { id: A }] }), /duplicate/);
    });
    test('split builders reject zero or negative amounts', () => {
      assert.throws(() => splitEqually(0, [A, B]), /greater than zero/);
      assert.throws(() => splitEqually(-300, [A, B]), /negative/);
      assert.throws(() => splitEqually(300, []), /at least one/);
      assert.throws(() => splitByPercentage(0, [{ memberId: A, percent: 100 }]), /greater than zero/);
    });
  });

  group('rounding with odd paise', () => {
    test('₹1.00 among three → 34 / 33 / 33', () => {
      assert.deepEqual(splitEqually(100, [A, B, C]).map((s) => s.amount), [34, 33, 33]);
    });
    test('1 paisa among three → one person carries it', () => {
      assert.deepEqual(splitEqually(1, [A, B, C]).map((s) => s.amount), [1, 0, 0]);
    });
    test('odd amount between two', () => {
      assert.deepEqual(splitEqually(10001, [A, B]).map((s) => s.amount), [5001, 5000]);
      assert.deepEqual(
        splitByPercentage(1001, [{ memberId: A, percent: 50 }, { memberId: B, percent: 50 }]).map((s) => s.amount),
        [501, 500]
      );
    });
    test('shares never differ by more than one paisa and always sum exactly', () => {
      for (let amount = 1; amount <= 500; amount += 7) {
        for (let n = 1; n <= 4; n++) {
          const shares = splitEqually(amount, members.slice(0, n).map((m) => m.id)).map((s) => s.amount);
          assert.equal(shares.reduce((a, b) => a + b, 0), amount, `sum for ${amount}/${n}`);
          if (Math.max(...shares) - Math.min(...shares) > 1) throw new Error(`uneven split ${amount}/${n}`);
        }
      }
    });
    test('many odd-paise expenses still balance to zero', () => {
      const expenses = [];
      for (let i = 1; i <= 25; i++) {
        const payer = members[i % 4].id;
        expenses.push(equal(`e${i}`, payer, i * 101 + 1, members.slice(0, 1 + (i % 4)).map((m) => m.id)));
      }
      run({ members, expenses });
    });
  });

  group('randomised invariants', () => {
    test('500 random ledgers satisfy every invariant', () => {
      let seed = 42;
      const rand = (n) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };
      for (let round = 0; round < 500; round++) {
        const ids = members.map((m) => m.id);
        const expenses = [];
        const settlements = [];
        const count = rand(8);
        for (let i = 0; i < count; i++) {
          const amount = 1 + rand(200000);
          const who = ids.filter(() => rand(2)).concat(ids[rand(4)]);
          const people = Array.from(new Set(who));
          const kind = rand(3);
          let splits;
          if (kind === 0) splits = splitEqually(amount, people);
          else if (kind === 1) {
            const pcts = people.map(() => 1 + rand(100));
            const total = pcts.reduce((a, b) => a + b, 0);
            const bp = pcts.map((p) => Math.floor((p * 10000) / total));
            bp[0] += 10000 - bp.reduce((a, b) => a + b, 0);
            splits = splitByPercentage(amount, people.map((memberId, k) => ({ memberId, percent: bp[k] / 100 })));
          } else {
            splits = splitEqually(amount, people); // then skew it exactly
            if (splits.length > 1) {
              const move = rand(splits[0].amount + 1);
              splits[0].amount -= move;
              splits[1].amount += move;
            }
            splits = splitExact(amount, splits);
          }
          expenses.push(expense(`e${i}`, ids[rand(4)], amount, splits));
        }
        for (let i = rand(3); i > 0; i--) {
          const from = ids[rand(4)];
          const to = ids.filter((id) => id !== from)[rand(3)];
          settlements.push({ id: `s${i}`, from, to, amount: 1 + rand(50000) });
        }
        run({ members, expenses, settlements });
      }
    });
  });

  group('money helpers', () => {
    test('parseRupees converts text to integer paise without floats', () => {
      assert.equal(parseRupees('0.1'), 10);
      assert.equal(parseRupees('0.29'), 29);
      assert.equal(parseRupees('1,234.5'), 123450);
      assert.equal(parseRupees('₹ 99'), 9900);
      assert.equal(parseRupees('1.234'), null);
      assert.equal(parseRupees('-5'), null);
      assert.equal(parseRupees('abc'), null);
    });
    test('formatPaise renders Indian grouping', () => {
      assert.equal(formatPaise(12345678), '₹1,23,456.78');
      assert.equal(formatPaise(-5), '−₹0.05');
      assert.equal(formatPaise(100, { sign: true }), '+₹1.00');
    });
  });

  // ---------- report ----------
  const failed = results.filter((r) => !r.ok);
  if (typeof module === 'object' && module.exports) {
    for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.group} › ${r.name}${r.ok ? '' : '\n    ' + r.error}`);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exitCode = 1;
  } else {
    root.TEST_RESULTS = results;
  }
})(typeof self !== 'undefined' ? self : this);
