// Look and feel: themes, avatars, motion, phone layout, accessibility basics (local-only mode).
import { test, expect, openLocal, addMembers, addExpense } from './fixtures.mjs';

test.beforeEach(async ({ page }) => { await openLocal(page); });

test('L01 theme: System → Dark → Light, remembered after reload, applied before paint', async ({ page }) => {
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await expect(page.locator('input[name=theme][value=system]')).toBeChecked();
  await page.click('label:has(input[name=theme][value=dark])');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await bg()).toBe('rgb(21, 16, 13)');
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.locator('input[name=theme][value=dark]')).toBeChecked();
  await page.click('#btn-theme'); // header toggle flips to light
  expect(await bg()).toBe('rgb(255, 251, 247)');
  await page.click('label:has(input[name=theme][value=system])');
  expect(await page.evaluate(() => document.documentElement.dataset.theme || 'none')).toBe('none');
});

test('L02 theme follows the system setting when on "System"', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(21, 16, 13)');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 251, 247)');
});

test('L03 person editor: emoji, rename (duplicates refused), photo upload, back to initials', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  await page.click('[data-person] >> text=Asha');
  await expect(page.locator('#person-dialog')).toBeVisible();
  await page.click('#person-emojis [data-emoji="🦁"]');
  await page.fill('#person-name', 'bilal');
  await page.click('#person-form button[type=submit]');
  await expect(page.locator('#person-error')).toContainText('already in the group');
  await page.fill('#person-name', 'Asha K');
  await page.click('#person-form button[type=submit]');
  await expect(page.locator('#members .member-pick', { hasText: 'Asha K' }).locator('.avatar.emoji')).toHaveText('🦁');

  // a real image file, shrunk in the browser
  const png = await page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 400, height: 300 });
    const x = c.getContext('2d'); x.fillStyle = '#EA580C'; x.fillRect(0, 0, 400, 300);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.click('[data-person] >> text=Bilal');
  await page.setInputFiles('#person-photo', { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#person-preview img')).toBeVisible();
  await page.click('#person-form button[type=submit]');
  const src = await page.locator('#members .member-pick', { hasText: 'Bilal' }).locator('img').getAttribute('src');
  expect(src).toMatch(/^data:image\/jpeg;base64,/);
  expect(src.length).toBeLessThan(16000);

  await page.setInputFiles('#person-photo', []); // no-op
  await page.click('[data-person] >> text=Bilal');
  await page.setInputFiles('#person-photo', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.locator('#person-error')).toContainText('Pick an image file');
  await page.click('#person-emojis [data-emoji=""]');
  await page.click('#person-form button[type=submit]');
  await expect(page.locator('#members .member-pick', { hasText: 'Bilal' }).locator('.avatar')).toHaveText('B');
});

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('L04 settling up plays confetti; numbers count up; new rows slide in', async ({ page }) => {
    await addMembers(page, 'Asha', 'Bilal');
    await addExpense(page, { desc: 'Chai', amount: 200, payer: 'Asha' });
    await expect(page.locator('#activity li.enter')).toHaveCount(1);
    await expect(page.locator('#stats [data-count=spent]')).toHaveText('₹200.00');
    await page.click('#transfers [data-settle="0"]');
    await page.click('#pay-form button[value=save]');
    await expect(page.locator('canvas.confetti')).toBeAttached();
    await expect(page.locator('#transfers .settled.pop')).toBeVisible();
    await expect(page.locator('canvas.confetti')).toHaveCount(0, { timeout: 5000 }); // cleans itself up
  });

  test('L05 undoing into a settled state does not celebrate again', async ({ page }) => {
    await addMembers(page, 'Asha', 'Bilal');
    await addExpense(page, { desc: 'Chai', amount: 200, payer: 'Asha' });
    await page.click('#transfers [data-settle="0"]');
    await page.click('#pay-form button[value=save]');
    await expect(page.locator('canvas.confetti')).toHaveCount(0, { timeout: 5000 });
    await page.locator('#activity li', { hasText: 'Bilal paid Asha' }).hover();
    await page.click('[aria-label="Delete payment"]');
    await page.click('#toasts button:has-text("Undo")');
    await expect(page.locator('#transfers')).toContainText("Everyone's square");
    await expect(page.locator('canvas.confetti')).toHaveCount(0);
    await expect(page.locator('#transfers .settled.pop')).toHaveCount(0);
  });
});

test('L06 with reduced motion there is no confetti at all', async ({ page }) => {
  await addMembers(page, 'Asha', 'Bilal');
  await addExpense(page, { desc: 'Chai', amount: 200, payer: 'Asha' });
  await page.click('#transfers [data-settle="0"]');
  await page.click('#pay-form button[value=save]');
  await expect(page.locator('#toasts')).toContainText('Everyone’s square');
  await expect(page.locator('canvas.confetti')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('L07 phone layout: nothing scrolls sideways, header fits, dialogs fit', async ({ page }) => {
    await page.click('[data-demo]');
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    const fits = await page.evaluate(() => {
      const inner = document.querySelector('.topbar-inner');
      const limit = inner.getBoundingClientRect().right - parseFloat(getComputedStyle(inner).paddingRight);
      return document.querySelector('#btn-add').getBoundingClientRect().right <= limit + 0.5;
    });
    expect(fits).toBe(true);
    await expect(page.locator('#btn-theme')).toBeHidden();
    await page.click('#btn-add');
    const box = await page.locator('#expense-dialog').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  });
});

test('L08 keyboard and labels: dialogs close on Escape, controls are named', async ({ page }) => {
  await addMembers(page, 'Asha');
  await page.click('#btn-add');
  await page.keyboard.press('Escape');
  await expect(page.locator('#expense-dialog')).toBeHidden();
  for (const sel of ['#btn-groups', '#btn-theme', '#btn-add', '#btn-pay', '#btn-export', '#member-name', '#group-name']) {
    const name = await page.locator(sel).evaluate((el) => el.getAttribute('aria-label') || el.textContent.trim() || el.getAttribute('placeholder'));
    expect(name, sel).toBeTruthy();
  }
  await page.click('#btn-demo'); // header button (the in-card one only shows in an empty group)
  await expect(page.locator('#group-name')).toHaveValue('Goa, September');
  const hit = page.locator('.chart-hit.selectable').first();
  await hit.focus();
  await expect(page.locator('.chart-tooltip').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#spend-sub')).toContainText('by day');
});
