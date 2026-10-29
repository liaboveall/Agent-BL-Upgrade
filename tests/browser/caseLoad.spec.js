import { test, expect } from '@playwright/test';

// Application audit 2026-10-29 B06 at the page: a first quote that fails is said, kept on screen and retried in place,
// while the documents and the constraints stay usable; the entry bar reaches the upload without scrolling.
test('B06: a failed first quote keeps uploads and constraints usable and recovers in place', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ts_lang', 'zh'));
  let failing = true;
  await page.route('**/api/pricing/quote', (route) => failing
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Synthetic pricing outage' }) })
    : route.continue());
  await page.goto('/#/mint');
  const alert = page.locator('#case-load-error');
  await expect(alert).toContainText('没能取得这个项目的报价');
  await expect(alert).toContainText('Synthetic pricing outage');
  await expect(page.locator('#ebl-browse-btn')).toBeEnabled();
  await expect(page.locator('#mint-start-upload')).toBeEnabled();
  await expect(page.locator('#pref-min-price')).toBeEnabled();
  await expect(page.locator('#mint-btn')).toHaveCount(0);

  failing = false;
  await page.locator('#case-load-retry').click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator('#mint-btn')).toBeEnabled();
  await expect(page.locator('#case-dropdown')).toHaveValue('CASE-EBL-CU-SIN-SHA');
});

test('the entry bar opens a fresh upload from the first screen', async ({ page }) => {
  await page.goto('/#/mint');
  const upload = page.locator('#mint-start-upload');
  await expect(upload).toBeEnabled();
  const box = await upload.boundingBox();
  expect(box.y + box.height).toBeLessThan(1000);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), upload.click()]);
  expect(chooser.isMultiple()).toBe(true);
  // The upload card itself now starts in the first half of the page instead of below the valuation.
  expect((await page.locator('#ebl-upload-zone').boundingBox()).y).toBeLessThan(700);
});
