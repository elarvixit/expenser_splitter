// Groups, categories, charts and the PDF statement (local-only mode).
import fs from 'node:fs';
import { test, expect, openLocal, addMembers, addExpense, balanceOf } from './fixtures.mjs';

test.beforeEach(async ({ page }) => { await openLocal(page); });

test('G01 groups: create, switch, rename, and data stays separate', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'Villa', amount: 1000, payer: 'Asha' });
  await page.click('#btn-groups');
  await page.fill('#new-group-name', 'Flatmates');
  await page.click('#new-group-form button[type=submit]');
  await expect(page.locator('#group-name')).toHaveValue('Flatmates');
  await expect(page.locator('#hero-eyebrow')).toHaveText('Group 2 of 2');
  await expect(page.locator('#members .member-pick')).toHaveCount(0);
  await expect(page.locator('#activity')).toContainText('Nothing yet');
  await page.click('#btn-groups');
  await page.locator('.group-row').first().locator('[data-rename]').click();
  await page.fill('[data-rename-input]', 'Goa trip');
  await page.press('[data-rename-input]', 'Enter');
  await expect(page.locator('.group-row').first()).toContainText('Goa trip');
  await page.click('[data-pick] >> text=Goa trip');
  await expect(page.locator('#group-name')).toHaveValue('Goa trip');
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹500.00');
  await expect(page.locator('#btn-groups')).toContainText('2');
});

test('G02 delete a group, then Undo; deleting the last group leaves a fresh one', async ({ page }) => {
  await addMembers(page, 'Asha');
  await page.click('#btn-groups');
  await page.click('[data-delete-group]');
  await expect(page.locator('#toasts')).toContainText('deleted');
  await expect(page.locator('.group-row')).toHaveCount(1);
  await expect(page.locator('.group-row')).toContainText('My group');
  await page.click('#toasts button:has-text("Undo")');
  await expect(page.locator('#members .member-pick', { hasText: 'Asha' })).toBeVisible();
});

test('G03 categories: guessed from the description, overridable, custom names allowed', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  await page.click('#btn-add');
  await page.fill('#ex-desc', 'Uber to the airport');
  await expect(page.locator('#ex-cats [aria-checked=true]')).toHaveText('Travel');
  await page.fill('#ex-desc', 'Biryani dinner');
  await expect(page.locator('#ex-cats [aria-checked=true]')).toHaveText('Food');
  await page.click('#ex-cats [data-cat="Shopping"]');
  await page.fill('#ex-desc', 'Hotel');                                   // picked by hand: no more guessing
  await expect(page.locator('#ex-cats [aria-checked=true]')).toHaveText('Shopping');
  await page.click('#ex-cats [data-cat-custom]');
  await page.fill('#ex-amount', '120');
  await page.click('#ex-save');
  await expect(page.locator('#ex-error')).toContainText('Type a name for your category');
  await page.fill('#ex-cat-custom', '  Office   supplies ');
  await page.click('#ex-save');
  await expect(page.locator('#activity small').first()).toContainText('Office supplies');
  await expect(page.locator('#activity .cat-icon')).toHaveCount(1);
});

test('G04 spending chart: monthly totals by category, then drill into a month by day', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'July rent', amount: 20000, payer: 'Asha', date: '2026-07-01' });
  await addExpense(page, { desc: 'Dinner', amount: 1500, payer: 'Bilal', date: '2026-09-26' });
  await addExpense(page, { desc: 'Cab', amount: 500, payer: 'Asha', date: '2026-09-28' });
  await expect(page.locator('#spend-chart .chart-col')).toHaveCount(3); // Jul, Aug (empty), Sept
  await expect(page.locator('#spend-sub')).toContainText('Jul 2026 – Sept 2026');
  await expect(page.locator('.chart-legend')).toContainText('Bills₹20,000.00');
  await expect(page.locator('.chart-legend')).toContainText('Food₹1,500.00');
  await page.click('.chart-table summary');
  await expect(page.locator('.chart-table tfoot')).toContainText('₹22,000.00');
  await page.locator('.chart-hit.selectable').last().click();
  await expect(page.locator('#spend-sub')).toContainText('Sept 2026 by day');
  const days = await page.locator('#spend-chart .chart-axis').allTextContents();
  expect(days.filter((d) => !d.startsWith('₹'))).toEqual(['26 Sept', '27 Sept', '28 Sept']);
  await page.click('#spend-back');
  await expect(page.locator('#spend-sub')).toContainText('tap a month');
});

test('G05 spending chart: "All groups" adds up every group', async ({ page }) => {
  await addMembers(page, 'Asha');
  await addExpense(page, { desc: 'Tea', amount: 100 });
  await page.click('#btn-groups');
  await page.fill('#new-group-name', 'Second');
  await page.click('#new-group-form button[type=submit]');
  await addMembers(page, 'Bilal');
  await addExpense(page, { desc: 'Coffee', amount: 250 });
  await expect(page.locator('#spend-sub')).toContainText('This group');
  await expect(page.locator('#spend-sub')).toContainText('₹250.00');
  await page.click('label:has(input[name=spend-scope][value=all])');
  await expect(page.locator('#spend-sub')).toContainText('All 2 groups');
  await expect(page.locator('#spend-sub')).toContainText('₹350.00');
});

test('G06 who spent what: Paid vs Share, both totalling what was spent', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal', 'Chen');
  await addExpense(page, { desc: 'Hotel', amount: 900, payer: 'Asha' });
  await addExpense(page, { desc: 'Food', amount: 101, payer: 'Bilal', split: { equal: ['Asha', 'Bilal'] } });
  await expect(page.locator('.donut-total')).toHaveText('₹1,001.00');
  await expect(page.locator('.donut-legend')).toContainText('Asha₹900.00');
  await expect(page.locator('.donut-slice')).toHaveCount(2);
  await page.click('label:has(input[name=people-mode][value=share])');
  await expect(page.locator('.donut-total')).toHaveText('₹1,001.00');
  await expect(page.locator('.donut-legend')).toContainText('Asha₹350.50'); // ₹300 of the hotel + ₹50.50 of the food
  await expect(page.locator('.donut-slice')).toHaveCount(3);
  await page.locator('.donut-slice').first().focus();
  await expect(page.locator('.donut-tooltip')).toContainText('Asha');
});

test('G07 PDF statement downloads from the banner and from the Groups list', async ({ page }) => {
  await page.click('#btn-export');
  await expect(page.locator('#toasts')).toContainText('Add people and expenses');
  await page.click('[data-demo]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  expect(download.suggestedFilename()).toMatch(/^Goa-September-statement-\d{4}-\d{2}-\d{2}\.pdf$/);
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.toString('latin1')).toContain('Villa in Assagao');
  await page.click('#btn-groups');
  const [second] = await Promise.all([page.waitForEvent('download'), page.click('[data-export-group]')]);
  expect(second.suggestedFilename()).toContain('statement');
});
