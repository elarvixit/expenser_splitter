// Less common but real situations: reloads, cross-device deletes and clashes, old data and links.
import { test, expect, openLocal, openConnected, addMembers, addExpense, balanceOf, signUp, signIn, uniqueEmail } from './fixtures.mjs';

const refresh = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const synced = (page) => expect(page.locator('#sync-status')).toHaveText('Synced to your account', { timeout: 10000 });

test('E01 reloading while signed in keeps you signed in with your groups', async ({ page }) => {
  await openConnected(page);
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'Movie', amount: 700, payer: 'Asha' });
  await signUp(page, uniqueEmail('e01'));
  await synced(page);
  await page.reload();
  await expect(page.locator('#btn-account')).toHaveClass(/signed-in/);
  await synced(page);
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹350.00');
  expect(await page.evaluate(() => location.hash)).toMatch(/^#g=/);
});

test('E02 a group deleted on another device disappears here too', async ({ page, device }) => {
  test.setTimeout(60000);
  const email = uniqueEmail('e02');
  await openConnected(page);
  await addMembers(page, 'Asha');
  await signUp(page, email);
  await page.click('#btn-groups');
  await page.fill('#new-group-name', 'Short-lived');
  await page.click('#new-group-form button[type=submit]');
  await addMembers(page, 'Zed');
  await synced(page);
  const phone = await device();
  await openConnected(phone);
  await signIn(phone, email);
  await phone.click('#btn-groups');
  await expect(phone.locator('.group-row')).toHaveCount(2, { timeout: 10000 });
  await phone.locator('.group-row', { hasText: 'Short-lived' }).locator('[data-delete-group]').click();
  await phone.waitForTimeout(7500); // past the Undo window, so it's deleted from the account
  await refresh(page);
  await page.click('#btn-groups');
  await expect(page.locator('.group-row')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('.group-row')).not.toContainText('Short-lived');
});

test('E03 the same name added on two devices at once: the second is refused with a clear message', async ({ page, device }) => {
  const email = uniqueEmail('e03');
  await openConnected(page);
  await addMembers(page, 'Asha');
  await signUp(page, email);
  await synced(page);
  const phone = await device();
  await openConnected(phone);
  await signIn(phone, email);
  await expect(phone.locator('#members .member-pick')).toHaveCount(1, { timeout: 10000 });
  await addMembers(page, 'Zed');
  await synced(page);
  await phone.fill('#member-name', 'zed'); // phone hasn't seen "Zed" yet
  await phone.press('#member-name', 'Enter');
  await expect(phone.locator('#toasts')).toContainText('that name is already in the group', { timeout: 10000 });
  await expect(phone.locator('#members .member-pick')).toHaveCount(2);
  await expect(phone.locator('#members .member-pick', { hasText: 'Zed' })).toHaveCount(1);
});

test('E04 opening an old (pre-account) group link while signed in moves it into your account', async ({ page, request }) => {
  const created = await request.post('/__admin_sql', { data: `
    with g as (insert into tharun_expense_splitter_groups (name) values ('Old Goa trip') returning id, token)
    select token, splitter__save(id, 0, '{"groupName":"Old Goa trip","members":[{"id":"a","name":"Asha"},{"id":"b","name":"Bilal"}],"expenses":[{"id":"e","description":"Villa","paidBy":"a","amount":90000,"splitMode":"equal","createdAt":"2026-08-01T10:00:00Z","splits":[{"memberId":"a","amount":45000},{"memberId":"b","amount":45000}]}],"settlements":[]}'::jsonb) as v from g` });
  expect(created.ok()).toBe(true);
  const [{ token }] = await created.json();
  await openConnected(page);
  await signUp(page, uniqueEmail('e04'));
  await page.goto('/#g=' + token);
  await expect(page.locator('#group-name')).toHaveValue('Old Goa trip', { timeout: 10000 });
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹450.00');
  await synced(page);
});

test('E05 "accounts not set up" is explained if the database script hasn\'t been run', async ({ page }) => {
  await page.route('**/rest/v1/rpc/splitter_sign_in', (r) => r.fulfill({ status: 404, contentType: 'application/json',
    body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.splitter_sign_in' }) }));
  await openConnected(page);
  await signIn(page, 'someone@test.dev', 'whatever1');
  await expect(page.locator('#auth-error')).toContainText('not set up on the server yet');
});

test('E06 editing an exact-split expense brings back its shares', async ({ page }) => {
  await openLocal(page);
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'Dinner', amount: 1000, payer: 'Asha', split: { exact: { Asha: 400, Bilal: 600 } } });
  await page.locator('#activity li', { hasText: 'Dinner' }).hover();
  await page.click('[aria-label="Edit Dinner"]');
  await expect(page.locator('input[name=mode][value=exact]')).toBeChecked();
  await expect(page.locator('#split-rows li').nth(0).locator('input')).toHaveValue('400.00');
  await expect(page.locator('#split-rows li').nth(1).locator('input')).toHaveValue('600.00');
  await page.locator('#split-rows li').nth(1).locator('input').fill('500');
  await page.locator('#split-rows li').nth(0).locator('input').fill('500');
  await page.click('#ex-save');
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹500.00');
});

test('E07 group name: a blank name becomes "Untitled group"; Escape cancels a rename', async ({ page }) => {
  await openLocal(page);
  await page.fill('#group-name', '   ');
  await page.press('#group-name', 'Enter');
  await expect(page.locator('#group-name')).toHaveValue('Untitled group');
  await page.click('#btn-groups');
  await page.click('[data-rename]');
  await page.fill('[data-rename-input]', 'Should not stick');
  await page.press('[data-rename-input]', 'Escape');
  await expect(page.locator('#groups-dialog')).toBeVisible();
  await expect(page.locator('.group-row')).toContainText('Untitled group');
});

test('E08 data from the very first version (single group) is carried over', async ({ page }) => {
  await page.route('**/config.js', (r) => r.fulfill({ body: 'window.SPLITTER_CONFIG = {};', contentType: 'text/javascript' }));
  await page.goto('/tests/'); // any page on the same origin, to seed storage
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('halve:v1', JSON.stringify({ groupName: 'Old trip', members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      expenses: [{ id: 'e1', paidBy: 'a', amount: 300, splits: [{ memberId: 'a', amount: 150 }, { memberId: 'b', amount: 150 }], createdAt: '2026-09-01T00:00:00Z' }], settlements: [] }));
  });
  await page.goto('/');
  await expect(page.locator('#group-name')).toHaveValue('Old trip');
  expect(await balanceOf(page, 'B')).toBe('owes ₹1.50');
});

test('E09 corrupted saved data is ignored instead of breaking the page', async ({ page }) => {
  await page.route('**/config.js', (r) => r.fulfill({ body: 'window.SPLITTER_CONFIG = {};', contentType: 'text/javascript' }));
  await page.goto('/tests/');
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('splitter:v2', JSON.stringify({ groups: [{ id: 'g', groupName: 'Bad', members: [], expenses: [{ id: 'x', paidBy: 'nobody', amount: -5, splits: [] }], settlements: [] }] }));
    localStorage.setItem('splitter:session', '{not json');
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#group-name')).toHaveValue('My group');
  expect(errors).toEqual([]);
});
