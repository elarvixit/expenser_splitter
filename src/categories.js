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

  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
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

    const order = [...PRESET_NAMES.filter((n) => n !== OTHER), ...(firstCustom ? [firstCustom] : []), OTHER];
    const series = order
      .map((name) => ({
        name,
        color: name === firstCustom ? CUSTOM_COLOR : presetColor(name),
        total: shown.reduce((a, mo) => a + (mo.byCategory[name] || 0), 0),
        includes: name === OTHER ? [...folded] : [],
      }))
      .filter((s) => s.total > 0);

    return { months: shown, series, total: shown.reduce((a, mo) => a + mo.total, 0) };
  }

  return {
    PRESETS, OTHER, CUSTOM_COLOR,
    guessCategory, normalizeCategory, categoryOf, isPreset, presetColor, customCategories,
    monthKey, monthLabel, monthlySpend,
  };
});
