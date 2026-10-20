import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const language of ['zh', 'en']) {
  test(`W4 ${language}: source boundaries, session failure and mobile download form are accessible`, async ({ page }, testInfo) => {
    await page.addInitScript((lang) => localStorage.setItem('ts_lang', lang), language);
    await page.goto('/');
    await page.locator('.research-tools > summary').click();
    const panel = page.locator('.evidence-panel'); await panel.locator('summary').first().click();
    await expect(panel).toContainText(language === 'zh' ? '独立业务验收' : 'Independent business acceptance');
    await expect(panel).toContainText(language === 'zh' ? '先对账' : 'Reconcile');
    await panel.locator('input[type=password]').fill('synthetic-invalid-session-for-ui-test');
    await panel.locator('#evidence-download-id').fill('00000000-0000-4000-8000-000000000000');
    await panel.locator('button[type=submit]').click();
    await expect(panel.getByRole('alert')).toContainText(language === 'zh' ? '无法核验' : 'failed');
    for (const width of [1440, 1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect((await panel.boundingBox()).width).toBeLessThanOrEqual(width);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const contrast = await new AxeBuilder({ page }).include('.evidence-panel').withRules(['color-contrast']).analyze();
      expect(contrast.violations).toEqual([]);
      await panel.screenshot({ path: testInfo.outputPath(`evidence-${language}-${width}.png`) });
    }
    await panel.locator('.evidence-review-form summary').click();
    await expect(panel.locator('textarea')).toBeVisible();
    expect((await panel.boundingBox()).width).toBeLessThanOrEqual(390);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath(`handover-${language}-390.png`) });
    await expect(panel.locator('.evidence-review-actions button').first()).toBeDisabled();
    await panel.locator('summary').first().focus(); await page.keyboard.press('Enter');
    await expect(panel.locator('details').first()).not.toHaveAttribute('open');
  });
}
