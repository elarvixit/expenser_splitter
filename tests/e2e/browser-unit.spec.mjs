// The in-browser test page (tests/index.html) runs the balance and category suites in real Chrome.
import { test, expect } from './fixtures.mjs';

test('B01 unit suites pass in the browser too (tests/index.html)', async ({ page }) => {
  await page.goto('/tests/');
  await expect(page.locator('#summary')).toContainText('all green');
  const text = await page.locator('#summary').innerText();
  const [, passed, total] = /(\d+) \/ (\d+) passed/.exec(text);
  expect(Number(passed)).toBe(Number(total));
  expect(Number(total)).toBeGreaterThanOrEqual(55);
  await expect(page).toHaveTitle('✓ Splitter Tests');
});
