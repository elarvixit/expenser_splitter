/*
 * Splitter — balance calculation core.
 *
 * Everything here is pure: no I/O, no stored state, inputs are never mutated.
 * All money is integer paise (₹1 = 100 paise). Balances are never persisted;
 * they are recomputed from the full list of transactions every time.
 *
 * Sign convention:
 *   balance > 0  → the member should RECEIVE money
 *   balance < 0  → the member OWES money
 *
 * Works as a browser global (window.SplitCore) and as a CommonJS module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SplitCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ValidationError';
    }
  }

  function fail(message) {
    throw new ValidationError(message);
  }

  function assertPaise(value, label, { allowZero = false } = {}) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      fail(`${label} must be a whole number of paise`);
    }
    if (value < 0) fail(`${label} cannot be negative`);
    if (value === 0 && !allowZero) fail(`${label} must be greater than zero`);
  }

  function memberIndex(members) {
    if (!Array.isArray(members)) fail('members must be an array');
    const ids = new Set();
    for (const m of members) {
      if (!m || typeof m.id !== 'string' || m.id === '') fail('every member needs a string id');
      if (ids.has(m.id)) fail(`duplicate member id "${m.id}"`);
      ids.add(m.id);
    }
    return ids;
  }

  function validateExpense(expense, ids) {
    const label = `expense ${expense && expense.id ? `"${expense.id}"` : ''}`.trim();
    if (!expense || typeof expense !== 'object') fail('expense must be an object');
    assertPaise(expense.amount, `${label} amount`);
    if (!ids.has(expense.paidBy)) fail(`${label} is paid by unknown member "${expense.paidBy}"`);
    if (!Array.isArray(expense.splits) || expense.splits.length === 0) {
      fail(`${label} needs at least one split`);
    }
    const seen = new Set();
    let total = 0;
    for (const s of expense.splits) {
      if (!ids.has(s.memberId)) fail(`${label} splits to unknown member "${s.memberId}"`);
      if (seen.has(s.memberId)) fail(`${label} lists member "${s.memberId}" twice`);
      seen.add(s.memberId);
      assertPaise(s.amount, `${label} share for "${s.memberId}"`, { allowZero: true });
      total += s.amount;
    }
    if (total !== expense.amount) {
      fail(`${label} splits add up to ${total} paise but the amount is ${expense.amount} paise`);
    }
  }

  function validateSettlement(settlement, ids) {
    const label = `settlement ${settlement && settlement.id ? `"${settlement.id}"` : ''}`.trim();
    if (!settlement || typeof settlement !== 'object') fail('settlement must be an object');
    assertPaise(settlement.amount, `${label} amount`);
    if (!ids.has(settlement.from)) fail(`${label} is from unknown member "${settlement.from}"`);
    if (!ids.has(settlement.to)) fail(`${label} is to unknown member "${settlement.to}"`);
    if (settlement.from === settlement.to) fail(`${label} cannot be paid to oneself`);
  }

  /**
   * Recalculate every balance from scratch.
   *
   * @param {{members: {id:string}[], expenses?: Expense[], settlements?: Settlement[]}} input
   *   Expense:    { id, paidBy, amount, splits: [{ memberId, amount }] }   (paise)
   *   Settlement: { id, from, to, amount }  — `from` paid `to` in real money (paise)
   * @returns {{ balances: Object<string, number>, debts: {from, to, amount}[] }}
   *   balances: net position per member.
   *   debts: pairwise debts before any simplification — for each pair of members,
   *          at most one entry saying who owes whom and how much.
   */
  function calculateBalances({ members, expenses = [], settlements = [] }) {
    const ids = memberIndex(members);
    if (!Array.isArray(expenses)) fail('expenses must be an array');
    if (!Array.isArray(settlements)) fail('settlements must be an array');

    const balances = {};
    for (const m of members) balances[m.id] = 0;

    // pair key "a\u0000b" (a < b) → signed paise that a owes b (negative: b owes a)
    const pairs = new Map();
    function addDebt(debtor, creditor, amount) {
      if (debtor === creditor || amount === 0) return;
      const [a, b] = debtor < creditor ? [debtor, creditor] : [creditor, debtor];
      const key = a + '\u0000' + b;
      pairs.set(key, (pairs.get(key) || 0) + (debtor === a ? amount : -amount));
    }

    for (const e of expenses) {
      validateExpense(e, ids);
      balances[e.paidBy] += e.amount;
      for (const s of e.splits) {
        balances[s.memberId] -= s.amount;
        addDebt(s.memberId, e.paidBy, s.amount);
      }
    }

    for (const s of settlements) {
      validateSettlement(s, ids);
      // `from` handed cash to `to`: from's position improves, to's shrinks.
      balances[s.from] += s.amount;
      balances[s.to] -= s.amount;
      addDebt(s.to, s.from, s.amount);
    }

    const debts = [];
    for (const [key, value] of pairs) {
      if (value === 0) continue;
      const [a, b] = key.split('\u0000');
      debts.push(value > 0 ? { from: a, to: b, amount: value } : { from: b, to: a, amount: -value });
    }
    debts.sort(
      (x, y) => y.amount - x.amount || cmp(x.from, y.from) || cmp(x.to, y.to)
    );

    return { balances, debts };
  }

  function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /**
   * Turn net balances into a short list of transfers that settles everyone
   * (greedy: largest debtor pays largest creditor). At most n − 1 transfers.
   */
  function suggestSettlements(balances) {
    const creditors = [];
    const debtors = [];
    for (const id of Object.keys(balances)) {
      const v = balances[id];
      if (!Number.isSafeInteger(v)) fail(`balance for "${id}" must be whole paise`);
      if (v > 0) creditors.push({ id, left: v });
      else if (v < 0) debtors.push({ id, left: -v });
    }
    const order = (x, y) => y.left - x.left || cmp(x.id, y.id);
    creditors.sort(order);
    debtors.sort(order);

    const transfers = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const amount = Math.min(debtors[i].left, creditors[j].left);
      transfers.push({ from: debtors[i].id, to: creditors[j].id, amount });
      debtors[i].left -= amount;
      creditors[j].left -= amount;
      if (debtors[i].left === 0) i++;
      if (creditors[j].left === 0) j++;
    }
    return transfers;
  }

  // ---------- split builders (produce explicit paise splits) ----------

  function assertMemberList(memberIds) {
    if (!Array.isArray(memberIds) || memberIds.length === 0) fail('choose at least one person');
    if (new Set(memberIds).size !== memberIds.length) fail('a person is listed twice');
  }

  /**
   * Equal split. Leftover paise go one each to the first members in the list,
   * so shares differ by at most 1 paisa and always sum to `amount`.
   */
  function splitEqually(amount, memberIds) {
    assertPaise(amount, 'amount');
    assertMemberList(memberIds);
    const n = memberIds.length;
    const base = Math.floor(amount / n);
    const extra = amount % n;
    return memberIds.map((memberId, i) => ({ memberId, amount: base + (i < extra ? 1 : 0) }));
  }

  /**
   * Percentage split. Percentages may have up to two decimals and must total 100.
   * Uses the largest-remainder method on integer basis points, so the shares
   * always sum exactly to `amount`. Ties go to the earlier member in the list.
   */
  function splitByPercentage(amount, entries) {
    assertPaise(amount, 'amount');
    if (!Number.isSafeInteger(amount * 10000)) fail('amount is too large');
    assertMemberList((entries || []).map((e) => e.memberId));

    const bps = entries.map((e) => {
      if (typeof e.percent !== 'number' || !Number.isFinite(e.percent)) {
        fail(`percentage for "${e.memberId}" must be a number`);
      }
      if (e.percent < 0) fail(`percentage for "${e.memberId}" cannot be negative`);
      const bp = Math.round(e.percent * 100);
      if (Math.abs(e.percent * 100 - bp) > 1e-6) {
        fail(`percentage for "${e.memberId}" can have at most two decimals`);
      }
      return bp;
    });
    const totalBp = bps.reduce((a, b) => a + b, 0);
    if (totalBp !== 10000) fail(`percentages add up to ${totalBp / 100}%, not 100%`);

    const rows = entries.map((e, i) => {
      const raw = amount * bps[i];
      return { i, memberId: e.memberId, amount: Math.floor(raw / 10000), rem: raw % 10000 };
    });
    let leftover = amount - rows.reduce((a, r) => a + r.amount, 0);
    const byRemainder = rows.slice().sort((x, y) => y.rem - x.rem || x.i - y.i);
    for (let k = 0; leftover > 0; k++, leftover--) byRemainder[k].amount += 1;

    return rows.map(({ memberId, amount }) => ({ memberId, amount }));
  }

  /** Exact split: shares are given in paise and must sum to `amount`. */
  function splitExact(amount, entries) {
    assertPaise(amount, 'amount');
    assertMemberList((entries || []).map((e) => e.memberId));
    let total = 0;
    const splits = entries.map((e) => {
      assertPaise(e.amount, `share for "${e.memberId}"`, { allowZero: true });
      total += e.amount;
      return { memberId: e.memberId, amount: e.amount };
    });
    if (total !== amount) {
      fail(`shares add up to ${formatPaise(total)} but the expense is ${formatPaise(amount)}`);
    }
    return splits;
  }

  // ---------- money parsing / formatting (string-based, no floats) ----------

  /** "1,234.5" → 123450. Returns null for anything that is not a valid amount. */
  function parseRupees(text) {
    const s = String(text == null ? '' : text).trim().replace(/[,\s₹]/g, '');
    const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
    if (!m) return null;
    const paise = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(paise) ? paise : null;
  }

  /** 123450 → "₹1,234.50" */
  function formatPaise(paise, { sign = false } = {}) {
    const neg = paise < 0;
    const abs = Math.abs(paise);
    const rupees = Math.floor(abs / 100).toLocaleString('en-IN');
    const cents = String(abs % 100).padStart(2, '0');
    const prefix = neg ? '−' : sign && paise > 0 ? '+' : '';
    return `${prefix}₹${rupees}.${cents}`;
  }

  return {
    ValidationError,
    calculateBalances,
    suggestSettlements,
    splitEqually,
    splitByPercentage,
    splitExact,
    validateExpense: (expense, members) => validateExpense(expense, memberIndex(members)),
    parseRupees,
    formatPaise,
  };
});
