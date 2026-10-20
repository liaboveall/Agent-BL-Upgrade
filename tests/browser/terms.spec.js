import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { disclosureFixture } from '../helpers/disclosure.js';

for (const language of ['zh', 'en']) for (const width of [1280, 390, 768, 1440]) {
  test(`N2 ${language} ${width}: complete terms, keyboard consent, changed/missing/corrupt material block signatures`, async ({ page }, info) => {
    const pack = { ...disclosureFixture(), pool_id: 1, quote_version: '3' }, wallet = `0x${'12'.repeat(20)}`;
    const config = { chainIdDecimal: 1439, protocolVersion: 5, controlVersion: 2, contracts: { RWAOfferingPool: pack.document.instance.pool }, abis: { RWAOfferingPool: [] } };
    const offer = { pool_id: 1, state: 'Open', shares: '10', subscribed: '0', issue_price_atomic: pack.terms.issuePrice, redemption_per_share_atomic: pack.terms.target,
      settlement_asset: pack.terms.settlementAsset, raised_atomic: '0', disbursed_atomic: '0', recovered_atomic: '0', maturity: pack.terms.maturity,
      subscription_deadline: pack.terms.subscribeUntil, disbursement_deadline: pack.terms.disburseUntil, quote_version: '3', terms_hash: pack.terms_hash,
      disclosure_hash: pack.disclosure_hash, policy_hash: pack.policy_hash, subscription_open: true };
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ language, wallet }) => {
      localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
      window.n2WalletCalls = [];
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method }) => {
        window.n2WalletCalls.push(method);
        if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [wallet];
        if (method === 'eth_chainId') return '0x59f';
        throw new Error('This test does not sign');
      } };
    }, { language, wallet });
    await page.route('**/api/demo/mode', (route) => route.fulfill({ json: { mode: 'live', demoMode: false, liveAvailable: true, generation: 3 } }));
    await page.route('**/api/controlled/status', (route) => route.fulfill({ json: { active: true, config, controller: pack.document.instance.controller } }));
    await page.route('**/api/controlled/offerings', (route) => route.fulfill({ json: { config, offerings: [offer] } }));
    await page.route('**/api/controlled/positions?**', (route) => route.fulfill({ json: { positions: [] } }));
    let variant = 'valid';
    await page.route('**/api/controlled/offerings/1/terms*', (route) => {
      if (variant === 'missing') return route.fulfill({ status: 409, json: { error: 'Readable financing terms are unavailable; do not sign' } });
      const result = structuredClone(pack);
      if (variant === 'changed') result.quote_version = '4';
      if (variant === 'corrupt') result.document.parties.operator = wallet;
      return route.fulfill({ json: result });
    });
    const walletReady = page.waitForResponse((response) => response.url().includes('/api/controlled/positions?wallet='));
    await page.goto('/#/market'); await walletReady; const panel = page.locator('.controlled-panel'); await panel.locator('summary').click();
    await panel.getByRole('button', { name: `${language === 'zh' ? '融资详情' : 'Financing details'} #1`, exact: true }).click();
    await panel.getByRole('button', { name: language === 'zh' ? '只读查看完整条款' : 'Read full terms without signing' }).click();
    await expect(panel.locator('.funding-detail .readable-terms')).toContainText(pack.terms.exporter);
    const review = panel.getByRole('button', { name: language === 'zh' ? '审阅认购' : 'Review subscription', exact: true });
    await expect(review).toBeEnabled(); await review.focus(); await page.keyboard.press('Enter');
    const card = panel.locator('.controlled-confirm'), terms = card.locator('.readable-terms');
    await expect(terms).toContainText(language === 'zh' ? '完整融资条款' : 'Complete financing terms');
    await expect(terms).toContainText(pack.terms.exporter); await expect(terms).toContainText('0 TEST_USDC');
    await expect(terms).toContainText(language === 'zh' ? '烧毁份额后仍保留' : 'Burning shares preserves');
    await expect(terms.getByRole('link')).toHaveAttribute('href', '/api/controlled/offerings/1/terms?download=1');
    const confirm = card.getByRole('button', { name: language === 'zh' ? '确认并前往钱包' : 'Confirm and continue to wallet', exact: true });
    await expect(confirm).toBeDisabled(); await card.getByRole('checkbox').focus(); await page.keyboard.press('Space'); await expect(confirm).toBeEnabled();
    const box = await terms.boundingBox(); expect(box.width).toBeLessThanOrEqual((await panel.boundingBox()).width);
    expect(await terms.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await terms.screenshot({ path: info.outputPath(`readable-${language}-${width}.png`) });
    await page.screenshot({ path: info.outputPath(`full-page-${language}-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await info.attach('viewport', { body: JSON.stringify(await page.evaluate(() => ({ innerWidth, documentWidth: document.documentElement.scrollWidth }))), contentType: 'application/json' });
    expect((await new AxeBuilder({ page }).include('.readable-terms').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    variant = 'changed'; await confirm.click(); await expect(card).toHaveCount(0); await expect(panel.getByRole('alert')).toBeVisible();
    for (const failure of ['missing', 'corrupt']) {
      variant = failure; await review.click(); await expect(card).toHaveCount(0); await expect(panel.getByRole('alert')).toBeVisible();
    }
    variant = 'valid'; await review.click(); await expect(card).toBeVisible(); await card.getByRole('button', { name: language === 'zh' ? '取消' : 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => window.n2WalletCalls.filter(method => /sendTransaction|signTypedData|personal_sign/iu.test(method)))).toEqual([]);
  });
}

for (const language of ['zh', 'en']) test(`N2 ${language}: pricing interval and sensitivity disclose research sources and limits`, async ({ page }, info) => {
  await page.addInitScript((lang) => localStorage.setItem('ts_lang', lang), language);
  await page.goto('/#/mint'); await page.locator('#case-dropdown').selectOption('CASE-EBL-CU-SIN-SHA');
  const panel = page.locator('.research-constraints');
  await expect(panel).toContainText(language === 'zh' ? '资方补偿下限' : 'Investor compensation floor');
  await expect(panel).toContainText(language === 'zh' ? '不是概率预测' : 'not probability forecasts');
  await expect(panel).toContainText('fixture'); await expect(panel.locator('tbody tr')).toHaveCount(4);
  await panel.screenshot({ path: info.outputPath(`research-pricing-${language}.png`) });
});
