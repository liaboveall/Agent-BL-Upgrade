// Assessment 2026-11-05 §4: on a single column the pricing page reads in the order its numbered steps name (documents, value
// and risk, quote) instead of showing the quote before the risk; a wide screen keeps the quote beside the documents. The
// headline numbers carry what they stand on beside them (kind of figure, benchmark status and day, scope), and the four
// kinds of "verified" are explained in one place. Public sample case, offline Demo server.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const place = (page, selector) => page.locator(selector).evaluate((node) => { const b = node.getBoundingClientRect(); return { top: b.top + window.scrollY, left: b.left + window.scrollX }; });

for (const language of ['zh', 'en']) for (const [width, single] of [[390, true], [768, true], [1440, false]]) test(`pricing page ${language} ${width}: reading order, basis lines and assurance levels`, async ({ page }) => {
  const zh = language === 'zh';
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript((value) => { localStorage.clear(); localStorage.setItem('ts_lang', value); }, language);
  await page.goto('/#/mint');
  await expect(page.locator('#mint-collateral')).toBeVisible();
  await expect(page.locator('#mint-panel')).toBeVisible();
  const [documents, valuation, quote] = await Promise.all(['#ebl-documents', '#valuation-panel', '#mint-panel'].map((selector) => place(page, selector)));
  if (single) {
    expect(documents.top, 'documents come first').toBeLessThan(valuation.top);
    expect(valuation.top, 'value and risk (step 2) come before the quote (step 3)').toBeLessThan(quote.top);
    expect(Math.abs(valuation.left - quote.left)).toBeLessThan(2);
  } else {
    expect(quote.left, 'on a wide screen the quote sits beside the documents').toBeGreaterThan(documents.left + 400);
    expect(Math.abs(quote.top - documents.top)).toBeLessThan(40);
  }
  // The basis is beside each headline number, not folded away.
  const basis = page.locator('.basis-line');
  await expect(basis).toHaveCount(2);
  for (const line of await basis.all()) {
    await expect(line).toBeVisible();
    await expect(line).toContainText(zh ? '基准价：' : 'Benchmark:');
    await expect(line).toContainText(zh ? '仅用于研究与测试资产' : 'research and test assets only');
  }
  await expect(page.locator('#valuation-panel .basis-line')).toContainText(zh ? '不是可变现的处置价' : 'not a realizable disposal value');
  await expect(page.locator('#mint-panel .basis-line')).toContainText(zh ? '研究定价' : 'Research price');
  // What "verified" means is one disclosure away, with its four kinds named.
  // (On a phone the commitments sit in the page's "more" fold, which is closed until opened.)
  if (width < 768) await page.locator('#mint-more > summary').click();
  const levels = page.locator('.assurance-levels').first();
  await levels.locator('summary').click();
  await expect(levels.locator('[data-assurance]')).toHaveCount(4);
  await expect(levels).toContainText(zh ? '未验证的外部事实' : 'Unverified external facts');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// The first version of the basis line used a muted badge, which measured 4.13:1 on the quote's tinted block in the dark theme.
// Both themes are checked for the new elements themselves, with the assurance disclosure open.
for (const scheme of ['light', 'dark']) test.describe(`${scheme} theme`, () => {
  test.use({ colorScheme: scheme });
  test(`pricing page ${scheme}: basis lines and the open assurance levels meet WCAG AA contrast`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('ts_lang', 'zh'); });
    await page.goto('/#/mint');
    await expect(page.locator('#mint-collateral')).toBeVisible();
    await page.locator('.assurance-levels').first().locator('summary').click();
    const results = await new AxeBuilder({ page }).include('#valuation-panel').include('#mint-panel').include('.assurance-levels').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.map((violation) => [violation.id, violation.nodes.map((node) => node.target.join(' '))])).toEqual([]);
  });
});
