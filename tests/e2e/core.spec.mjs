// Core flows in local-only mode (no account): members, expenses, splits, payments, validation.
import { test, expect, openLocal, addMembers, addExpense, balanceOf } from './fixtures.mjs';

test.beforeEach(async ({ page }) => { await openLocal(page); });

test('C01 first visit: empty state, then "Load demo trip" fills a group', async ({ page }) => {
  await expect(page.locator('#balances')).toContainText('No one here yet');
  await expect(page.locator('#activity')).toContainText('Nothing yet');
  await expect(page.locator('#btn-add')).toBeDisabled();
  await page.click('[data-demo]');
  await expect(page.locator('#group-name')).toHaveValue('Goa, September');
  await expect(page.locator('#members .member-pick')).toHaveCount(4);
  await expect(page.locator('#activity li')).toHaveCount(6);
  expect(await balanceOf(page, 'Asha')).toBe('gets back ₹16,140.62');
  await expect(page.locator('#stats')).toContainText('₹39,537.49');
});

test('C02 members: add, duplicate refused, remove an unused one, blocked when in use', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal', 'Chen');
  await page.fill('#member-name', 'asha');
  await page.press('#member-name', 'Enter');
  await expect(page.locator('#toasts')).toContainText('already in the group');
  await expect(page.locator('#members .member-pick')).toHaveCount(3);
  await addExpense(page, { desc: 'Cab', amount: 300, split: { equal: ['Asha', 'Bilal'] } });
  await page.click('[aria-label="Remove Asha"]');
  await expect(page.locator('#toasts')).toContainText('part of existing transactions');
  await page.click('[aria-label="Remove Chen"]');
  await expect(page.locator('#members .member-pick')).toHaveCount(2);
});

test('C03 equal split rounds odd paise fairly (₹1.00 among 3 → 34/33/33)', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal', 'Chen');
  await addExpense(page, { desc: 'Toffee', amount: '1', payer: 'Asha' });
  expect(await balanceOf(page, 'Asha')).toBe('gets back ₹0.66');
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹0.33');
  expect(await balanceOf(page, 'Chen')).toBe('owes ₹0.33');
});

test('C04 payer excluded from an equal split is owed the whole amount', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal', 'Chen');
  await addExpense(page, { desc: 'Gift', amount: 600, payer: 'Asha', split: { equal: ['Bilal', 'Chen'] } });
  expect(await balanceOf(page, 'Asha')).toBe('gets back ₹600.00');
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹300.00');
});

test('C05 exact split: must add up; then balances follow the shares', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal', 'Chen');
  await addExpense(page, { desc: 'Dinner', amount: 1000, payer: 'Asha', split: { exact: { Asha: 200, Bilal: 300, Chen: 400 } } });
  await expect(page.locator('#ex-error')).toContainText('add up to ₹900.00');
  await expect(page.locator('#split-meter')).toContainText('₹100.00 left');
  await page.locator('#split-rows li').nth(2).locator('input').fill('500');
  await page.click('#ex-save');
  await expect(page.locator('#expense-dialog')).toBeHidden();
  expect(await balanceOf(page, 'Asha')).toBe('gets back ₹800.00');
  expect(await balanceOf(page, 'Chen')).toBe('owes ₹500.00');
});

test('C06 percentage split: must total 100%, largest remainder handles paise', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal', 'Chen');
  await addExpense(page, { desc: 'Rent', amount: 10, payer: 'Asha', split: { percent: { Asha: 50, Bilal: 30, Chen: 10 } } });
  await expect(page.locator('#ex-error')).toContainText('90%');
  await page.locator('#split-rows li').nth(2).locator('input').fill('20');
  await expect(page.locator('#split-meter')).toContainText('All assigned');
  await page.click('#ex-save');
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹3.00');
  expect(await balanceOf(page, 'Chen')).toBe('owes ₹2.00');
});

test('C07 invalid amounts and missing date are refused with a message', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  for (const [amount, msg] of [['', 'Enter an amount'], ['abc', 'Enter an amount'], ['-5', 'Enter an amount'], ['0', 'greater than zero'], ['1.234', 'Enter an amount']]) {
    if (!(await page.locator('#expense-dialog').isVisible())) await page.click('#btn-add');
    await page.fill('#ex-amount', amount);
    await page.click('#ex-save');
    await expect(page.locator('#ex-error'), `amount "${amount}"`).toContainText(msg);
  }
  await page.fill('#ex-amount', '100');
  await page.fill('#ex-date', '');
  await page.click('#ex-save');
  await expect(page.locator('#ex-error')).toContainText('Pick the date');
  await expect(page.locator('#activity li.empty')).toBeVisible();
});

test('C08 edit an expense: balances recalculate from the corrected amount', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'Snacks', amount: 100, payer: 'Asha' });
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹50.00');
  await page.locator('#activity li', { hasText: 'Snacks' }).hover();
  await page.click('[aria-label="Edit Snacks"]');
  await expect(page.locator('#expense-title')).toHaveText('Edit expense');
  await expect(page.locator('#ex-amount')).toHaveValue('100.00');
  await page.fill('#ex-amount', '300');
  await page.click('#ex-save');
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹150.00');
  await expect(page.locator('#activity li')).toHaveCount(1);
});

test('C09 delete an expense, then Undo brings it back', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'Petrol', amount: 800, payer: 'Asha' });
  await page.locator('#activity li', { hasText: 'Petrol' }).hover();
  await page.click('[aria-label="Delete Petrol"]');
  await expect(page.locator('#activity')).toContainText('Nothing yet');
  expect(await balanceOf(page, 'Bilal')).toBe('settled up —');
  await page.click('#toasts button:has-text("Undo")');
  await expect(page.locator('#activity li', { hasText: 'Petrol' })).toBeVisible();
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹400.00');
});

test('C10 settle up: record the suggested payments until everyone is square', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal', 'Chen');
  await addExpense(page, { desc: 'Villa', amount: 900, payer: 'Asha' });
  await expect(page.locator('#transfers [data-settle]')).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await page.click('#transfers [data-settle="0"]');
    await expect(page.locator('#pay-to')).toHaveValue(/.+/);
    await page.click('#pay-form button[value=save]');
  }
  await expect(page.locator('#transfers')).toContainText("Everyone's square");
  await expect(page.locator('#toasts')).toContainText('Everyone’s square! 🎉');
  await expect(page.locator('#stats')).toContainText('₹0.00');
});

test('C11 manual payment: amount and "to yourself" are validated', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  await page.click('#btn-pay');
  await page.selectOption('#pay-from', { label: 'Asha' });
  await page.selectOption('#pay-to', { label: 'Asha' });
  await page.fill('#pay-amount', '50');
  await page.click('#pay-form button[value=save]');
  await expect(page.locator('#pay-error')).toContainText('two different people');
  await page.selectOption('#pay-to', { label: 'Bilal' });
  await page.fill('#pay-amount', 'x');
  await page.click('#pay-form button[value=save]');
  await expect(page.locator('#pay-error')).toContainText('Enter an amount');
  await page.fill('#pay-amount', '50');
  await page.click('#pay-form button[value=save]');
  expect(await balanceOf(page, 'Asha')).toBe('gets back ₹50.00');
});

test('C12 "Who owes whom" lists direct debts before simplifying', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal', 'Chen');
  await addExpense(page, { desc: 'A pays', amount: 300, payer: 'Asha' });
  await addExpense(page, { desc: 'B pays', amount: 600, payer: 'Bilal' });
  await page.click('#debts-wrap summary');
  const rows = page.locator('#debts li');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#debts')).toContainText('Chen owes Bilal₹200.00');
  await expect(page.locator('#debts')).toContainText('Asha owes Bilal₹100.00');
});

test('C13 everything survives a reload (saved on this device)', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'Tea', amount: 40, payer: 'Asha' });
  await page.fill('#group-name', 'Office tea');
  await page.press('#group-name', 'Enter');
  await page.reload();
  await expect(page.locator('#group-name')).toHaveValue('Office tea');
  await expect(page.locator('#activity li', { hasText: 'Tea' })).toBeVisible();
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹20.00');
});
