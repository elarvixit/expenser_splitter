// Shared fixtures and helpers for the browser tests.
import { test as base, expect } from '@playwright/test';
import MCR from 'monocart-coverage-reports';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageOptions } from '../coverage-options.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COVERAGE = !!process.env.SPLITTER_COVERAGE;

/** Serve the pinned PDF libraries locally (byte-identical to cdnjs, so the SRI check still passes). */
async function offlineLibraries(page) {
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', (r) =>
    r.fulfill({ path: path.join(ROOT, 'node_modules/jspdf/dist/jspdf.umd.min.js'), contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js', (r) =>
    r.fulfill({ path: path.join(ROOT, 'node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.min.js'), contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
}

async function startCoverage(page) {
  if (COVERAGE) await page.coverage.startJSCoverage({ resetOnNavigation: false });
}
async function stopCoverage(page) {
  if (!COVERAGE) return;
  const list = await page.coverage.stopJSCoverage();
  await MCR(coverageOptions).add(list);
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await offlineLibraries(page);
    await startCoverage(page);
    await use(page);
    await stopCoverage(page);
  },
  /** Extra "devices" (separate browser contexts = separate storage), for sync and privacy tests. */
  device: async ({ browser }, use) => {
    const opened = [];
    await use(async (opts = {}) => {
      const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1200, height: 900 }, ...opts });
      const page = await context.newPage();
      await offlineLibraries(page);
      await startCoverage(page);
      opened.push({ context, page });
      return page;
    });
    for (const { context, page } of opened) {
      await stopCoverage(page);
      await context.close();
    }
  },
});
export { expect };

// ---------- app helpers ----------

/** Open the site in local-only mode (no Supabase config), with empty storage. */
export async function openLocal(page) {
  await page.route('**/config.js', (r) => r.fulfill({ body: 'window.SPLITTER_CONFIG = {};', contentType: 'text/javascript' }));
  await page.goto('/');
  await expect(page.locator('#btn-account')).toBeHidden();
}

/** Open the site connected to the test Supabase. */
export async function openConnected(page, hash = '') {
  await page.goto('/' + hash);
  await expect(page.locator('#btn-account')).toBeVisible();
}

export async function addMembers(page, ...names) {
  for (const name of names) {
    await page.fill('#member-name', name);
    await page.press('#member-name', 'Enter');
    await expect(page.locator('#members .member-pick', { hasText: name })).toBeVisible();
  }
}

/**
 * Add an expense through the form.
 * split: undefined (equal, everyone) | { equal: [names] } | { exact: { name: '₹' } } | { percent: { name: '%' } }
 */
export async function addExpense(page, { desc, amount, payer, split, date, category, custom }) {
  await page.click('#btn-add');
  await expect(page.locator('#expense-dialog')).toBeVisible();
  await page.fill('#ex-amount', String(amount));
  if (desc) await page.fill('#ex-desc', desc);
  if (payer) await page.selectOption('#ex-payer', { label: payer });
  if (date) await page.fill('#ex-date', date);
  if (category) await page.click(`#ex-cats [data-cat="${category}"]`);
  if (custom) { await page.click('#ex-cats [data-cat-custom]'); await page.fill('#ex-cat-custom', custom); }
  if (split && split.equal) {
    const names = await page.locator('#split-rows li .name').allTextContents();
    for (const [i, n] of names.entries()) {
      const box = page.locator('#split-rows li').nth(i).locator('input[type=checkbox]');
      if (split.equal.includes(n.trim()) !== (await box.isChecked())) await box.click({ force: true });
    }
  } else if (split && split.exact) {
    await page.click('label:has(input[name=mode][value=exact])');
    for (const [n, v] of Object.entries(split.exact)) await rowInput(page, n).fill(String(v));
  } else if (split && split.percent) {
    await page.click('label:has(input[name=mode][value=percent])');
    for (const [n, v] of Object.entries(split.percent)) await rowInput(page, n).fill(String(v));
  }
  await page.click('#ex-save');
}

const rowInput = (page, name) => page.locator('#split-rows li', { has: page.locator('.name', { hasText: new RegExp(`^${name}`) }) }).locator('input');

/** "gets back ₹66.67" / "owes ₹33.33" / "settled up —" for a person in Balances. */
export async function balanceOf(page, name) {
  const row = page.locator('#balances li', { has: page.locator('.who strong', { hasText: new RegExp(`^${name}$`) }) });
  return (await row.locator('.amt').innerText()).replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function signUp(page, email, password = 'correct horse') {
  await page.click('#btn-account');
  await page.click('[data-auth-mode=signup]');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.fill('#auth-confirm', password);
  await page.click('#auth-submit');
  await expect(page.locator('#auth-dialog')).toBeHidden();
  await expect(page.locator('#sync-status')).toHaveText(/Synced to your account|Saves once you add someone/);
}

export async function signIn(page, email, password = 'correct horse') {
  await page.click('#btn-account');
  await page.click('[data-auth-mode=signin]');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit');
}

export const uniqueEmail = (tag) => `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@test.dev`;
