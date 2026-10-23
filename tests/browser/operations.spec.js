import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { disclosureFixture } from '../helpers/disclosure.js';

for (const language of ['zh', 'en']) {
  test(`W5 ${language}: readiness, fund rights and recovery remain explicit and keyboard accessible at 1280 and 1440`, async ({ page }, info) => {
    await page.addInitScript((lang) => localStorage.setItem('ts_lang', lang), language);
    await page.route('**/api/ready', (route) => route.fulfill({ json: { ok: true, status: 'ready', scope: 'research_test_assets_only', business_enabled: false, revision: '1234567890abcdef' } }));
    await page.goto('/#/market'); await page.locator('.research-tools > summary').click();
    const panel = page.locator('.operations-panel'), summary = panel.locator('summary');
    await summary.focus(); await page.keyboard.press('Enter');
    await expect(panel.locator('details')).toHaveAttribute('open', '');
    await expect(panel).toContainText(language === 'zh' ? '运行检查正常' : 'Operating checks are healthy');
    await expect(panel).toContainText(language === 'zh' ? '不代表投资者已领取' : 'does not mean the investor has claimed');
    await expect(panel).toContainText('1234567890ab');
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await panel.screenshot({ path: info.outputPath(`operations-${language}-${width}.png`) });
    }
    expect((await new AxeBuilder({ page }).include('.operations-panel').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.route('**/api/ready', (route) => route.fulfill({ status: 503, json: { ok: false, status: 'degraded' } }));
    await page.reload(); await page.locator('.research-tools > summary').click(); await page.locator('.operations-panel summary').click();
    await expect(panel).toContainText(language === 'zh' ? '运行状态尚未确认' : 'Operational readiness is unconfirmed');
    await page.route('**/api/ready', (route) => route.abort()); await page.reload(); await page.locator('.research-tools > summary').click(); await page.locator('.operations-panel summary').click();
    await expect(panel).toContainText(language === 'zh' ? '运行状态尚未确认' : 'Operational readiness is unconfirmed');
  });
  test(`W5 ${language}: controlled funding binds reviewed terms, and a wallet change cancels confirmation`, async ({ page }, info) => {
    const wallet = `0x${'12'.repeat(20)}`, pool = `0x${'34'.repeat(20)}`, asset = `0x${'56'.repeat(20)}`;
    await page.addInitScript(({ language, wallet }) => {
      localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
      window.controlledWalletCalls = []; window.controlledWalletHandlers = {};
      window.ethereum = { isMetaMask: true, on(event, handler) { window.controlledWalletHandlers[event] = handler; }, removeListener() {}, request: async ({ method }) => {
        window.controlledWalletCalls.push(method);
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [wallet];
        if (method === 'eth_chainId') return '0x59f';
        throw new Error('Browser acceptance does not authorize a transaction');
      } };
    }, { language, wallet });
    await page.route('**/api/demo/mode', (route) => route.fulfill({ json: { mode: 'live', demoMode: false, liveAvailable: true, generation: 3 } }));
    const config = { chainIdDecimal: 1439, protocolVersion: 5, confirmations: 3, contracts: { RWAOfferingPool: pool, RWAToken: `0x${'78'.repeat(20)}` }, abis: { RWAOfferingPool: [] } };
    const pack = { ...disclosureFixture(), pool_id: 1, quote_version: '3' };
    await page.route('**/api/controlled/offerings/1/terms*', (route) => route.fulfill({ json: pack }));
    await page.route('**/api/controlled/status', (route) => route.fulfill({ json: { active: true, config, controller: `0x${'90'.repeat(20)}` } }));
    await page.route('**/api/controlled/offerings', (route) => route.fulfill({ json: { config, offerings: [{ pool_id: 1, state: 'Open', shares: '10', subscribed: '0', issue_price_atomic: '800000', redemption_per_share_atomic: '1000000', settlement_asset: asset,
      raised_atomic: '0', disbursed_atomic: '0', recovered_atomic: '0', maturity: '1900000000', subscription_deadline: pack.terms.subscribeUntil, disbursement_deadline: pack.terms.disburseUntil,
      quote_version: '3', terms_hash: pack.terms_hash, disclosure_hash: pack.disclosure_hash, policy_hash: pack.policy_hash, subscription_open: true }] } }));
    await page.route('**/api/controlled/positions?**', (route) => route.fulfill({ json: { positions: [] } }));
    await page.goto('/#/market'); const panel = page.locator('.controlled-panel'); await panel.locator('summary').click();
    await panel.getByRole('button', { name: `${language === 'zh' ? '融资详情' : 'Financing details'} #1`, exact: true }).click();
    const review = panel.getByRole('button', { name: language === 'zh' ? '审阅认购' : 'Review subscription', exact: true }); await expect(review).toBeEnabled();
    await panel.locator('.controlled-shares input').fill('2'); await review.click();
    const card = panel.locator('.controlled-confirm'); await expect(card).toContainText('1.600000'); await expect(card).toContainText(pack.terms_hash);
    for (const width of [1280, 1440]) { await page.setViewportSize({ width, height: 1000 }); expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true); await panel.screenshot({ path: info.outputPath(`controlled-${language}-${width}.png`) }); }
    expect((await new AxeBuilder({ page }).include('.controlled-panel').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.evaluate(() => window.controlledWalletHandlers.accountsChanged([])); await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => window.controlledWalletCalls.filter((method) => /sendTransaction|signTypedData|personal_sign/iu.test(method)))).toEqual([]);
    await page.route('**/api/controlled/positions?**', (route) => route.fulfill({ json: { positions: [{ position_id: 'late-recovery-1',
      protocol_instance: { chain_id: 1439, protocol_version: 5, pool_address: pool }, chain_pool_id: 1, investor: wallet, asset,
      shares: '0', claimed_atomic: '2000000', claimable_atomic: '1', cost_atomic: '4000000', refunded_atomic: '0',
      chain_state: 'LossSettled', reconciled: true, recovery_rights_retained: true }] } }));
    await page.reload(); await page.locator('.controlled-panel summary').click();
    const late = panel.getByRole('button', { name: language === 'zh' ? '审阅领取' : 'Review claim', exact: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(late).toBeEnabled(); await late.focus(); await page.keyboard.press('Enter');
      await expect(panel.locator('.controlled-confirm')).toContainText(language === 'zh' ? '领取' : 'Claim');
      await expect(panel).toContainText(language === 'zh' ? '份额销毁后仍保留' : 'Recovery rights survive');
      await page.screenshot({ path: info.outputPath(`late-recovery-${language}-${width}.png`), fullPage: true });
      await panel.locator('.controlled-confirm').getByRole('button', { name: language === 'zh' ? '取消' : 'Cancel', exact: true }).click();
    }
  });
}
