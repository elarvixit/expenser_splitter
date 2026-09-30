/*
 * Splitter — expense categories and spending summaries.
 *
 * Pure functions, no DOM. An expense may carry an explicit `category` (a preset or a
 * custom name the user typed). Older expenses without one get a best guess from the
 * description, so charts work for existing data without rewriting it.
 *
 * Colors follow the validated reference categorical palette, in its fixed slot order.
 * Colour follows the category (never its rank): a preset always has the same colour.
 * Custom categories share slot 7 for the first one; any further custom categories fold
 * into "Other" in the chart (their real names stay on each expense).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SplitCategories = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PRESETS = [
    { name: 'Food', color: '#2a78d6' },
    { name: 'Travel', color: '#eb6834' },
    { name: 'Stay', color: '#1baf7a' },
    { name: 'Shopping', color: '#eda100' },
    { name: 'Entertainment', color: '#e87ba4' },
    { name: 'Bills', color: '#008300' },
    { name: 'Other', color: '#e34948' },
  ];
  const CUSTOM_COLOR = '#4a3aa7'; // slot 7: the first custom category in view
  const OTHER = 'Other';
  const PRESET_NAMES = PRESETS.map((p) => p.name);

  // First match wins, so the more specific groups come first ("Movie tickets" → Entertainment).
  const KEYWORDS = [
    ['Entertainment', /\b(movie|movies|cinema|film|concert|party|club|game|games|bowling|netflix|show|event|parasail\w*|trek\w*|adventure|amusement|museum|zoo)\b/i],
    ['Stay', /\b(hotel|hotels|villa|airbnb|hostel|resort|room|rooms|lodge|homestay|stay|accommodation)\b/i],
    ['Travel', /\b(cab|cabs|taxi|uber|ola|rapido|flight|flights|airport|train|bus|metro|petrol|fuel|diesel|toll|parking|scooter|scooters|bike|bikes|auto|travel|car|ferry|visa|rental|rentals)\b/i],
    ['Food', /\b(food|dinner|lunch|breakfast|brunch|biryani|pizza|burger|restaurant|cafe|coffee|chai|tea|snack|snacks|groceries|grocery|meal|meals|swiggy|zomato|ice ?cream|sweets|dessert|drinks|juice|seafood|bakery|vegetables|fruits)\b/i],
    ['Bills', /\b(bill|bills|electricity|wifi|internet|broadband|rent|recharge|subscription|maintenance|emi|insurance)\b/i],
    ['Shopping', /\b(shopping|clothes|clothing|amazon|flipkart|myntra|gift|gifts|mall|shoes|electronics|souvenir|souvenirs)\b/i],
  ];

  /** Best guess for an expense without an explicit category. */
  function guessCategory(description) {
    const text = String(description || '');
    for (const [name, re] of KEYWORDS) if (re.test(text)) return name;
    return OTHER;
  }

  /** Canonical spelling for a category name: presets match case-insensitively. */
  function normalizeCategory(name) {
    const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!clean) return '';
    const preset = PRESET_NAMES.find((p) => p.toLowerCase() === clean.toLowerCase());
    return preset || clean;
  }

  function categoryOf(expense) {
    return normalizeCategory(expense.category) || guessCategory(expense.description);
  }

  const isPreset = (name) => PRESET_NAMES.includes(name);

  function presetColor(name) {
    const p = PRESETS.find((x) => x.name === name);
    return p ? p.color : null;
  }

  /** Custom (non-preset) category names in order of first use (by expense date). */
  function customCategories(expenses) {
    const seen = [];
    const sorted = expenses.slice().sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
    for (const e of sorted) {
      const c = categoryOf(e);
      if (!isPreset(c) && !seen.includes(c)) seen.push(c);
    }
    return seen;
  }

  const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

  // Full year on purpose: "Sept 26" read as the 26th of September.
  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  }

  const dayKey = (date) => `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;

  function dayLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  /** Series (fixed palette order) for a set of buckets; customs after the first fold into Other. */
  function seriesFor(expenses, buckets, folded) {
    const firstCustom = customCategories(expenses)[0];
    const order = [...PRESET_NAMES.filter((n) => n !== OTHER), ...(firstCustom ? [firstCustom] : []), OTHER];
    return order
      .map((name) => ({
        name,
        color: name === firstCustom ? CUSTOM_COLOR : presetColor(name),
        total: buckets.reduce((a, b) => a + (b.byCategory[name] || 0), 0),
        includes: name === OTHER ? [...folded] : [],
      }))
      .filter((s) => s.total > 0);
  }

  /**
   * Daily spend by category within one month (same shape as monthlySpend; buckets are days).
   * Days run from the first to the last day with spend in that month, gaps filled with zero.
   */
  function dailySpend(expenses, month) {
    const customs = customCategories(expenses);
    const seriesName = (cat) => (isPreset(cat) || cat === customs[0] ? cat : OTHER);
    const byDay = new Map();
    const folded = new Set();
    for (const e of expenses) {
      const d = new Date(e.createdAt);
      if (isNaN(d) || monthKey(d) !== month) continue;
      const cat = categoryOf(e);
      const name = seriesName(cat);
      if (name === OTHER && cat !== OTHER) folded.add(cat);
      const key = dayKey(d);
      if (!byDay.has(key)) byDay.set(key, {});
      byDay.get(key)[name] = (byDay.get(key)[name] || 0) + e.amount;
    }
    const days = [];
    const keys = [...byDay.keys()].sort();
    if (keys.length) {
      const first = Number(keys[0].slice(-2));
      const last = Number(keys[keys.length - 1].slice(-2));
      for (let d = first; d <= last; d++) {
        const key = `${month}-${String(d).padStart(2, '0')}`;
        const byCategory = byDay.get(key) || {};
        days.push({ key, label: dayLabel(key), total: Object.values(byCategory).reduce((a, b) => a + b, 0), byCategory });
      }
    }
    return { months: days, series: seriesFor(expenses, days, folded), total: days.reduce((a, b) => a + b.total, 0) };
  }

  /**
   * Monthly spend by category.
   * @param {object[]} expenses  expenses (from one group or several), amounts in paise
   * @param {{ maxMonths?: number }} [opts]
   * @returns {{ months: {key,label,total,byCategory:Object<string,number>}[],
   *             series: {name,color,total,includes:string[]}[], total: number }}
   *   `series` is in fixed palette order and lists only categories that have spend.
   *   Months run from the first to the last month with spend (gaps filled with zero),
   *   limited to the most recent `maxMonths` (default 12).
   */
  function monthlySpend(expenses, opts) {
    const maxMonths = (opts && opts.maxMonths) || 12;
    const customs = customCategories(expenses);
    const firstCustom = customs[0];
    const seriesName = (cat) => (isPreset(cat) || cat === firstCustom ? cat : OTHER);

    const byMonth = new Map();
    const folded = new Set();
    for (const e of expenses) {
      const d = new Date(e.createdAt);
      if (isNaN(d)) continue;
      const key = monthKey(d);
      const cat = categoryOf(e);
      const name = seriesName(cat);
      if (name === OTHER && cat !== OTHER) folded.add(cat);
      if (!byMonth.has(key)) byMonth.set(key, {});
      const bucket = byMonth.get(key);
      bucket[name] = (bucket[name] || 0) + e.amount;
    }

    const keys = [...byMonth.keys()].sort();
    const months = [];
    if (keys.length) {
      const [y0, m0] = keys[0].split('-').map(Number);
      const [y1, m1] = keys[keys.length - 1].split('-').map(Number);
      for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, m = 1) : m++) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        const byCategory = byMonth.get(key) || {};
        const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
        months.push({ key, label: monthLabel(key), total, byCategory });
      }
    }
    const shown = months.slice(-maxMonths);
    return { months: shown, series: seriesFor(expenses, shown, folded), total: shown.reduce((a, mo) => a + mo.total, 0) };
  }

  // People take the reference categorical slots in the group's member order (colour follows the
  // person, not their rank). Past 8 people, the rest fold into one "Others" slice.
  const PERSON_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

  /**
   * How much each person spent in a group, in paise.
   *   mode 'paid'  – out of their own pocket (expenses they paid for)
   *   mode 'share' – their portion of the expenses
   * Payments between members are paybacks, not spending, so they are not counted.
   * @returns {{ items: {id,name,color,total}[], total: number }}  items in member order, zeros dropped
   */
  function spendByPerson(group, mode) {
    const totals = new Map(group.members.map((m) => [m.id, 0]));
    for (const e of group.expenses) {
      if (mode === 'share') {
        for (const s of e.splits) if (totals.has(s.memberId)) totals.set(s.memberId, totals.get(s.memberId) + s.amount);
      } else if (totals.has(e.paidBy)) {
        totals.set(e.paidBy, totals.get(e.paidBy) + e.amount);
      }
    }
    const people = group.members.map((m, i) => ({ id: m.id, name: m.name, index: i, total: totals.get(m.id) }));
    const items = people.slice(0, 7).map((p) => ({ id: p.id, name: p.name, color: PERSON_COLORS[p.index], total: p.total }));
    if (people.length === 8) {
      items.push({ id: people[7].id, name: people[7].name, color: PERSON_COLORS[7], total: people[7].total });
    } else if (people.length > 8) {
      const rest = people.slice(7);
      items.push({ id: '__others', name: `${rest.length} others`, color: PERSON_COLORS[7], total: rest.reduce((a, p) => a + p.total, 0),
        includes: rest.map((p) => p.name) });
    }
    const shown = items.filter((it) => it.total > 0);
    return { items: shown, total: shown.reduce((a, it) => a + it.total, 0) };
  }

  return {
    PRESETS, OTHER, CUSTOM_COLOR, PERSON_COLORS,
    guessCategory, normalizeCategory, categoryOf, isPreset, presetColor, customCategories,
    monthKey, monthLabel, dayLabel, monthlySpend, dailySpend, spendByPerson,
  };
});
