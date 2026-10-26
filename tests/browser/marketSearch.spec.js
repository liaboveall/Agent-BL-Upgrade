import { test, expect } from '@playwright/test';

for (const language of ['en', 'zh']) for (const width of [390, 1440]) {
  test(`market search: ${language} ${width} language switches refresh results, selection and category counts`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript((lang) => localStorage.setItem('ts_lang', lang), language);
    await page.goto('/#/market');
    const cards = page.locator('.deal-card');
    const counts = page.locator('.chip-count');
    await expect(cards.first()).toBeVisible();
    const query = language === 'en' ? '矿石与精矿' : 'Ores & Concentrates';
    await page.locator('#search-input').fill(query);
    // Waiting for the count also waits for the input debounce to reach the app store.
    await expect(counts.first()).toHaveText('0');
    await expect(cards).toHaveCount(0);
    await expect(page.locator('#market-subscribe-btn')).toHaveCount(0);
    await page.locator('.lang-btn').click();
    await expect(cards).toHaveCount(2);
    await expect(counts.first()).toHaveText('2');
    await expect(page.getByRole('button', { name: `${query}2`, exact: true })).toBeVisible();
    const selected = page.locator('.deal-card[aria-pressed="true"]');
    await expect(selected).toHaveCount(1);
    await expect(page.locator('#market-detail .detail-title')).toHaveText(await selected.locator('.deal-name').innerText());
    await expect(page.locator('#search-input')).toHaveValue(query);
    await page.screenshot({ path: info.outputPath('translated-search.png'), fullPage: true });
    await page.locator('.lang-btn').click();
    await expect(cards).toHaveCount(0);
    await expect(counts.first()).toHaveText('0');
    await expect(page.locator('#market-subscribe-btn')).toHaveCount(0);
  });
}

test('market search: Copilot asset navigation clears filters that hide the requested project', async ({ page }) => {
  await page.goto('/#/market');
  const cards = page.locator('.deal-card');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  await page.locator('#search-input').fill('iron pilbara');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute('data-case', 'CASE-EBL-IRONORE-PHE-TSN');
  // This is the same public event emitted by the Copilot's Open asset button.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('agentbl:selectcase', { detail: { case_id: 'CASE-EBL-CU-SIN-SHA' } })));
  await expect(page.locator('#search-input')).toHaveValue('');
  await expect(cards).toHaveCount(count);
  const selected = page.locator('.deal-card[aria-pressed="true"]');
  await expect(selected).toHaveAttribute('data-case', 'CASE-EBL-CU-SIN-SHA');
  await expect(page.locator('#market-detail .detail-title')).toHaveText(await selected.locator('.deal-name').innerText());
});
