// Accounts, privacy and sync — against the test server's real database (PGlite + schema.sql).
import { test, expect, openConnected, addMembers, addExpense, balanceOf, signUp, signIn, uniqueEmail } from './fixtures.mjs';

const refresh = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const synced = (page) => expect(page.locator('#sync-status')).toHaveText('Synced to your account', { timeout: 10000 });

test('A01 sign-up form: mismatch, weak password, bad email, then success', async ({ page }) => {
  await openConnected(page);
  await expect(page.locator('#sync-status')).toHaveText('Only on this device');
  await page.click('#btn-account');
  await page.click('[data-auth-mode=signup]');
  await expect(page.locator('#auth-title')).toHaveText('Create your account');
  await page.fill('#auth-email', uniqueEmail('a01'));
  await page.fill('#auth-password', 'correct horse');
  await page.fill('#auth-confirm', 'different');
  await page.click('#auth-submit');
  await expect(page.locator('#auth-error')).toContainText('do not match');
  await page.fill('#auth-password', 'short'); await page.fill('#auth-confirm', 'short');
  await page.click('#auth-submit');
  await expect(page.locator('#auth-error')).toContainText('at least 8 characters');
  await page.fill('#auth-email', 'not-an-email'); await page.fill('#auth-password', 'correct horse'); await page.fill('#auth-confirm', 'correct horse');
  await page.click('#auth-submit');
  await expect(page.locator('#auth-error')).toContainText('valid email');
  await page.fill('#auth-email', uniqueEmail('a01'));
  await page.click('#auth-submit');
  await expect(page.locator('#auth-dialog')).toBeHidden();
  await expect(page.locator('#btn-account')).toHaveClass(/signed-in/);
});

test('A02 groups made while signed out move into the new account', async ({ page }) => {
  await openConnected(page);
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'Tea', amount: 60, payer: 'Asha' });
  await signUp(page, uniqueEmail('a02'));
  await expect(page.locator('#toasts')).toContainText('moved into your account');
  await synced(page);
  expect(await page.evaluate(() => location.hash)).toMatch(/^#g=[0-9a-f-]{36}$/);
});

test('A03 sign out clears this device; signing back in restores everything', async ({ page }) => {
  const email = uniqueEmail('a03');
  await openConnected(page);
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'Pizza', amount: 500, payer: 'Asha' });
  await signUp(page, email);
  await synced(page);
  await page.click('#btn-account');
  await page.click('#btn-signout');
  await expect(page.locator('#toasts')).toContainText('safe in your account');
  await expect(page.locator('#members .member-pick')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('splitter:session'))).toBeNull();
  await signIn(page, email, 'wrong password');
  await expect(page.locator('#auth-error')).toContainText('Wrong email or password');
  await page.fill('#auth-password', 'correct horse');
  await page.click('#auth-submit');
  await expect(page.locator('#activity li', { hasText: 'Pizza' })).toBeVisible({ timeout: 10000 });
  expect(await balanceOf(page, 'Bilal')).toBe('owes ₹250.00');
});

test('A04 five wrong passwords lock the account for a while', async ({ page }) => {
  const email = uniqueEmail('a04');
  await openConnected(page);
  await signUp(page, email);
  await page.click('#btn-account');
  await page.click('#btn-signout');
  await signIn(page, email, 'nope-1');
  for (let i = 2; i <= 5; i++) { await page.fill('#auth-password', `nope-${i}`); await page.click('#auth-submit'); await expect(page.locator('#auth-error')).toContainText('Wrong'); }
  await page.fill('#auth-password', 'correct horse');
  await page.click('#auth-submit');
  await expect(page.locator('#auth-error')).toContainText('Too many wrong attempts');
});

test('A05 privacy: another account cannot open your group link; a signed-out visitor is asked to sign in', async ({ page, device }) => {
  await openConnected(page);
  await addMembers(page, 'Asha');
  await signUp(page, uniqueEmail('a05-owner'));
  await synced(page);
  const hash = await page.evaluate(() => location.hash);
  const stranger = await device();
  await openConnected(stranger, hash);
  await expect(stranger.locator('#auth-dialog')).toBeVisible();
  await expect(stranger.locator('#toasts')).toContainText('Sign in to open this group');
  await stranger.click('[data-auth-mode=signup]');
  await stranger.fill('#auth-email', uniqueEmail('a05-other'));
  await stranger.fill('#auth-password', 'correct horse');
  await stranger.fill('#auth-confirm', 'correct horse');
  await stranger.click('#auth-submit');
  await expect(stranger.locator('#toasts')).toContainText('belongs to another account', { timeout: 10000 });
  await expect(stranger.locator('#members .member-pick')).toHaveCount(0);
});

test('A06 two devices, one account: a change on one appears on the other', async ({ page, device }) => {
  const email = uniqueEmail('a06');
  await openConnected(page);
  await addMembers(page, 'Asha', 'Bilal');
  await signUp(page, email);
  await synced(page);
  const phone = await device();
  await openConnected(phone);
  await signIn(phone, email);
  await expect(phone.locator('#members .member-pick')).toHaveCount(2, { timeout: 10000 });
  await addExpense(page, { desc: 'Groceries', amount: 1000, payer: 'Asha' });
  await synced(page);
  await refresh(phone);
  await expect(phone.locator('#activity li', { hasText: 'Groceries' })).toBeVisible({ timeout: 10000 });
  expect(await balanceOf(phone, 'Bilal')).toBe('owes ₹500.00');
});

test('A07 simultaneous edits on two devices are both kept', async ({ page, device }) => {
  const email = uniqueEmail('a07');
  await openConnected(page);
  await addMembers(page, 'Asha', 'Bilal');
  await signUp(page, email);
  await synced(page);
  const phone = await device();
  await openConnected(phone);
  await signIn(phone, email);
  await expect(phone.locator('#members .member-pick')).toHaveCount(2, { timeout: 10000 });
  // neither device has seen the other's change
  await addExpense(page, { desc: 'From laptop', amount: 100, payer: 'Asha' });
  await addExpense(phone, { desc: 'From phone', amount: 300, payer: 'Bilal' });
  await synced(page); await synced(phone);
  await refresh(page);
  await expect(page.locator('#activity li', { hasText: 'From phone' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#activity li', { hasText: 'From laptop' })).toBeVisible();
  expect(await balanceOf(page, 'Bilal')).toBe('gets back ₹100.00'); // 150 owed to him − 50 he owes
});

test('A08 offline: edits wait on the device and sync when the connection returns', async ({ page, device }) => {
  const email = uniqueEmail('a08');
  await openConnected(page);
  await addMembers(page, 'Asha', 'Bilal');
  await signUp(page, email);
  await synced(page);
  await page.route('**/rest/v1/rpc/**', (r) => r.abort('internetdisconnected'));
  await addExpense(page, { desc: 'Offline chai', amount: 80, payer: 'Asha' });
  await expect(page.locator('#sync-status')).toHaveText('Offline — will retry');
  await page.unroute('**/rest/v1/rpc/**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await synced(page);
  const other = await device();
  await openConnected(other);
  await signIn(other, email);
  await expect(other.locator('#activity li', { hasText: 'Offline chai' })).toBeVisible({ timeout: 10000 });
});

test('A09 deleting a group removes it from the account after the Undo window', async ({ page, device }) => {
  test.setTimeout(60000);
  const email = uniqueEmail('a09');
  await openConnected(page);
  await addMembers(page, 'Asha');
  await signUp(page, email);
  await synced(page);
  await page.click('#btn-groups');
  await page.fill('#new-group-name', 'Throwaway');
  await page.click('#new-group-form button[type=submit]');
  await addMembers(page, 'Zed');
  await synced(page);
  await page.click('#btn-groups');
  await page.locator('.group-row', { hasText: 'Throwaway' }).locator('[data-delete-group]').click();
  await refresh(page);                       // a refresh during the Undo window must not bring it back
  await expect(page.locator('.group-row', { hasText: 'Throwaway' })).toHaveCount(0);
  await page.waitForTimeout(7500);           // Undo window is 6.5 s
  const other = await device();
  await openConnected(other);
  await signIn(other, email);
  await expect(other.locator('#members .member-pick', { hasText: 'Asha' })).toBeVisible({ timeout: 10000 });
  await other.click('#btn-groups');
  await expect(other.locator('.group-row')).toHaveCount(1);
});

test('A10 changing the password signs your other devices out', async ({ page, device }) => {
  const email = uniqueEmail('a10');
  await openConnected(page);
  await signUp(page, email);
  const phone = await device();
  await openConnected(phone);
  await signIn(phone, email);
  await expect(phone.locator('#btn-account')).toHaveClass(/signed-in/);
  await page.click('#btn-account');
  await page.click('#btn-change-pw');
  await page.fill('#pw-old', 'wrong one');
  await page.fill('#pw-new', 'brand new pass'); await page.fill('#pw-confirm', 'brand new pass');
  await page.click('#pw-form button[type=submit]');
  await expect(page.locator('#pw-error')).toContainText('current password is wrong');
  await page.fill('#pw-old', 'correct horse');
  await page.click('#pw-form button[type=submit]');
  await expect(page.locator('#toasts')).toContainText('Password changed');
  await refresh(phone);
  await expect(phone.locator('#auth-dialog')).toBeVisible({ timeout: 10000 });
  await expect(phone.locator('#toasts')).toContainText('session ended');
});

test('A11 avatars sync between devices', async ({ page, device }) => {
  const email = uniqueEmail('a11');
  await openConnected(page);
  await addMembers(page, 'Asha');
  await signUp(page, email);
  await synced(page);
  await page.click('[data-person] >> text=Asha');
  await page.click('#person-emojis [data-emoji="🦄"]');
  await page.click('#person-form button[type=submit]');
  await synced(page);
  const phone = await device();
  await openConnected(phone);
  await signIn(phone, email);
  await expect(phone.locator('#members .avatar.emoji')).toHaveText('🦄', { timeout: 10000 });
});
