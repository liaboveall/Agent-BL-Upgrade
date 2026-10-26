import { test, expect } from '@playwright/test';

for (const language of ['en', 'zh']) {
  test(`Copilot ${language}: follow-up introductions preserve filters and greeted resets clear them`, async ({ page }, info) => {
    await page.addInitScript((lang) => localStorage.setItem('ts_lang', lang), language);
    await page.goto('/#/market');
    await expect(page.locator('.deal-card').first()).toBeVisible();
    await page.locator('.cp-launcher').click();
    const entries = page.locator('.cp-entry');
    const input = page.locator('.cp-form input');
    const send = async (message) => {
      const count = await entries.count();
      await input.fill(message);
      await input.press('Enter');
      await expect(entries).toHaveCount(count + 1);
      await expect(page.locator('.cp-form button')).toBeEnabled();
      return entries.last();
    };
    const first = await send('low risk copper, budget USD 1000');
    const filters = await first.locator('.cp-constraints .chip').allTextContents();
    expect(filters).toHaveLength(3);
    for (const message of ['who are you', '你好']) {
      const intro = await send(message);
      await expect(intro.locator('.cp-narrative')).toContainText('AgentBL');
      await expect(intro.locator('.cp-card')).toHaveCount(0);
      await expect(intro.locator('.cp-action-card')).toHaveCount(0);
      await expect(intro.locator('.cp-constraints .chip')).toHaveText(filters);
    }
    const reset = await send('hello, start over');
    await expect(reset.locator('.cp-narrative')).toContainText(language === 'en' ? 'Preferences cleared' : '偏好已清空');
    await expect(reset.locator('.cp-constraints .chip')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('copilot-conversation.png'), fullPage: true });
  });
}
