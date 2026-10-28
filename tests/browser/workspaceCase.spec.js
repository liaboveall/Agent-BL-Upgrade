import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

// Application audit A07 and A08 at the page: an upload becomes this browser's own working case that the quote can be
// about, and a quote computed before the saved constraints can be shown but never issued.
const SAMPLE = 'CASE-EBL-CU-SIN-SHA';
const documents = ['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md']
  .map((name) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'uploads', 'copper-sg-shanghai', name));

test('A08: the parsed upload becomes a private working case to price, kept across a reload and invisible elsewhere', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem('ts_lang', 'zh'));
  await page.goto('/#/mint');
  await page.locator('#case-dropdown').selectOption(SAMPLE); await expect(page.locator('#mint-btn')).toBeEnabled();
  await expect(page.locator('#quote-source')).toContainText(`公开样例 ${SAMPLE}`);

  await page.locator('#ebl-file-input').setInputFiles(documents);
  const use = page.getByRole('button', { name: '用解析结果定价', exact: true });
  await expect(use).toBeVisible({ timeout: 60_000 });
  await use.click();

  const selector = page.locator('#case-dropdown');
  await expect(selector).toHaveValue(new RegExp(`^WS-[0-9A-F]{10}-${SAMPLE}$`, 'u'));
  const caseId = await selector.inputValue();
  await expect(selector.locator('optgroup[label="我的工作案例（仅本浏览器可见）"] option')).toHaveCount(1);
  await expect(page.locator('#quote-source')).toContainText(`我的工作案例 ${caseId}`);
  await expect(page.locator('#quote-source')).toContainText(`基于公开样例 ${SAMPLE}`);
  // The quote and the deal strip are about the uploaded bill, not the sample's.
  await expect(page.locator('.deal-strip')).toContainText('WAVE-EBL-3C81D2A9');
  await expect(page.locator('#mint-btn')).toBeEnabled();
  await expect(page.locator('.documents')).toContainText('主报价正在使用这份材料的解析结果');

  await page.reload();
  await expect(selector).toHaveValue(caseId);
  await expect(page.locator('.deal-strip')).toContainText('WAVE-EBL-3C81D2A9');

  // Another browser sees neither the case nor anything about it; the public catalog never lists it.
  const other = await browser.newContext();
  try {
    const stranger = await other.newPage();
    await stranger.goto('/#/mint');
    await expect(stranger.locator('#mint-btn')).toBeVisible();
    await expect(stranger.locator(`#case-dropdown option[value="${caseId}"]`)).toHaveCount(0);
    expect((await stranger.request.get(`/api/agent/cases/${caseId}/preferences`)).status()).toBe(404);
    expect((await (await stranger.request.get('/api/agent/workspace/cases')).json()).cases).toEqual([]);
  } finally { await other.close(); }
  expect((await (await page.request.get('/api/cases')).json()).cases.some((entry) => entry.case_id === caseId)).toBe(false);

  // The research shelf is public: it shows the sample the working case came from.
  await page.locator('#tab-market').click();
  await expect(page.locator('.market-aside')).toContainText('阴极铜');
});

test('A07: saved constraints whose reprice failed leave the old quote for reference only', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ts_lang', 'en'));
  let failing = false;
  await page.route('**/api/pricing/quote', (route) => failing
    ? route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic pricing outage' } }) : route.continue());
  await page.goto('/#/mint');
  await page.locator('#case-dropdown').selectOption(SAMPLE); await expect(page.locator('#mint-btn')).toBeEnabled();
  const price = await page.locator('#hero-price .price-xxl').textContent();

  failing = true;
  const floor = page.locator('#pref-min-price');
  await floor.fill('0.999'); await floor.press('Enter');
  const stale = page.locator('#quote-stale');
  await expect(stale).toContainText('The constraints were saved, but the quote has not been repriced');
  await expect(stale).toContainText('Synthetic pricing outage');
  await expect(page.locator('.pref-unsaved')).toHaveCount(0);
  await expect(page.locator('#hero-price .price-xxl')).toHaveText(price);
  await expect(page.locator('#mint-btn')).toBeDisabled();

  failing = false;
  await stale.getByRole('button', { name: 'Reprice', exact: true }).click();
  await expect(stale).toHaveCount(0);
  // A floor of 0.999 cannot be met: the repriced quote pauses the offering, so there is still nothing to issue.
  await expect(page.locator('.mint-panel p.callout.tone-crit')).toBeVisible();
  await expect(page.locator('#mint-btn')).toBeDisabled();
});
