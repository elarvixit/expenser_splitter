// Unit tests for src/ui.js (avatars, icons, motion helpers) and the pure parts of src/charts.js.
const test = require('node:test');
const assert = require('node:assert/strict');

let reduce = false;
global.self = global;
global.matchMedia = (q) => ({ matches: /reduced-motion/.test(q) ? reduce : false });
global.document = { hidden: false };
let frames = [];
global.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
global.cancelAnimationFrame = () => {};
global.performance = global.performance || { now: () => Date.now() };
require('../../src/ui.js');
require('../../src/charts.js');
const UI = global.SplitUI;
const Charts = global.SplitCharts;

test('avatarKind accepts emoji and small raster photos only', () => {
  assert.equal(UI.avatarKind('🦁'), 'emoji');
  assert.equal(UI.avatarKind('🧑‍💻'), 'emoji', 'ZWJ sequence');
  assert.equal(UI.avatarKind('data:image/jpeg;base64,/9j/4AAQSkZJRg=='), 'photo');
  assert.equal(UI.avatarKind('data:image/png;base64,iVBORw0KGgo='), 'photo');
  for (const bad of ['', null, 42, 'AB', 'hello', '<img>', '🦁<', 'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/jpeg;base64,' + 'A'.repeat(17000), 'javascript:alert(1)', 'data:image/jpeg;base64,abc"onerror=x']) {
    assert.equal(UI.avatarKind(bad), null, String(bad).slice(0, 30));
  }
});

test('every built-in emoji is a valid avatar', () => {
  assert.equal(UI.EMOJIS.length, 24);
  for (const e of UI.EMOJIS) assert.equal(UI.avatarKind(e), 'emoji', e);
});

test('categoryIcon: a tinted SVG per preset, a tag for anything else', () => {
  const food = UI.categoryIcon('Food', 'var(--viz-1)');
  assert.match(food, /^<svg class="cat-icon"[^>]*style="color:var\(--viz-1\)"/);
  assert.notEqual(UI.categoryIcon('Travel', 'red'), UI.categoryIcon('Stay', 'red'));
  assert.equal(UI.categoryIcon('Office', 'x'), UI.categoryIcon('custom', 'x'));
});

test('countTo animates with frames and lands exactly on the target', () => {
  reduce = false; frames = [];
  const el = { textContent: '' };
  UI.countTo(el, 0, 1000, (n) => `#${n}`, 100);
  assert.equal(el.textContent, '#0', 'starts at the old value');
  const t0 = performance.now();
  while (frames.length) { const f = frames.shift(); f(t0 + 1000); }
  assert.equal(el.textContent, '#1000');
});

test('countTo jumps straight to the value with reduced motion, hidden tabs, or no change', () => {
  const el = { textContent: '' };
  reduce = true; frames = [];
  UI.countTo(el, 0, 500, String); assert.equal(el.textContent, '500'); assert.equal(frames.length, 0);
  reduce = false; global.document.hidden = true;
  UI.countTo(el, 0, 700, String); assert.equal(el.textContent, '700'); assert.equal(frames.length, 0);
  global.document.hidden = false;
  UI.countTo(el, 9, 9, String); assert.equal(el.textContent, '9'); assert.equal(frames.length, 0);
  UI.countTo(null, 0, 1, String); // no element: no crash
});

test('confetti and animateOut do nothing when motion is reduced', async () => {
  reduce = true;
  assert.equal(UI.confetti(), undefined);
  const el = { classList: { add() { throw new Error('should not animate'); } } };
  await UI.animateOut(el);
  await UI.animateOut(null);
  reduce = false;
});

test('shortRupees: axis labels in Indian units', () => {
  assert.equal(Charts.shortRupees(0), '₹0');
  assert.equal(Charts.shortRupees(95000), '₹950');
  assert.equal(Charts.shortRupees(1200000), '₹12k');
  assert.equal(Charts.shortRupees(1250000), '₹12.5k');
  assert.equal(Charts.shortRupees(15000000), '₹1.5L');
});

test('niceScale: a round axis top covering the max, 4–5 gridlines', () => {
  for (const max of [1, 99, 1234, 40436, 4043649, 99999999]) {
    const { top, step } = Charts.niceScale(max);
    assert.ok(top >= max, `top ${top} ≥ ${max}`);
    const lines = top / step;
    assert.ok(lines >= 2 && lines <= 5, `${lines} gridlines for ${max}`);
  }
  assert.deepEqual(Charts.niceScale(0), { top: 100, step: 25 });
});

test('cssColor maps palette colours to theme variables, leaves others alone', () => {
  assert.equal(Charts.cssColor('#2a78d6'), 'var(--viz-1, #2a78d6)');
  assert.equal(Charts.cssColor('#E34948'), 'var(--viz-8, #E34948)');
  assert.equal(Charts.cssColor('#123456'), '#123456');
});
