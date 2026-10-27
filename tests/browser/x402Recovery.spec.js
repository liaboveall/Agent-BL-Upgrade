import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// F01: the tab that paid closed after the debit but before the report arrived. A new tab still lists the
// payment, recovers it with one wallet signature that moves no funds, and never signs or sends a payment.
for (const language of ['zh', 'en']) test(`F01 ${language} Live: a new tab recovers an unresolved payment without paying again`, async ({ page }) => {
  const zh = language === 'zh', payer = `0x${'34'.repeat(20)}`, nonce = `0x${'5a'.repeat(32)}`, reportId = `rpt_${'7'.repeat(64)}`;
  const paymentId = `pay_${'1'.repeat(64)}`, endpoint = '/api/x402/intel/premium-risk', paidRequest = { case_id: 'CASE-EBL-CU-SIN-SHA', note: 'original request' };
  await page.addInitScript(({ language, payer, nonce, endpoint, paidRequest }) => {
    localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
    if (!localStorage.getItem('agentbl-x402-journal-v2')) {
      const at = new Date(Date.now() - 60_000).toISOString();
      localStorage.setItem('agentbl-x402-journal-v2', JSON.stringify({ version: 2, entries: { closed: { key: 'closed', endpoint, from: payer, status: 'pending',
        network: 'eip155:1439', asset: `0x${'11'.repeat(20)}`, amount: '1000', pay_to: `0x${'22'.repeat(20)}`, nonce,
        valid_before: String(Math.floor(Date.now() / 1000) + 30), request: paidRequest, created_at: at, updated_at: at } } }));
    }
    window.walletCalls = [];
    window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method, params }) => {
      window.walletCalls.push({ method, primaryType: method === 'eth_signTypedData_v4' ? JSON.parse(params[1]).primaryType : null });
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [payer];
      if (method === 'eth_chainId') return '0x59f';
      if (method === 'eth_signTypedData_v4') return `0x${'11'.repeat(65)}`;
      throw new Error(`No ${method} in this fixture`);
    } };
  }, { language, payer, nonce, endpoint, paidRequest });
  const paidCalls = [], recoveries = [];
  const report = { kind: 'risk-intelligence', service: 'premium-risk', case_id: paidRequest.case_id, events: [], deepIntel: [],
    report_envelope: { report_id: reportId, kind: 'premium-risk', case_id: paidRequest.case_id, expires_at: new Date(Date.now() + 3_600_000).toISOString() } };
  await page.emulateMedia({ reducedMotion: 'reduce' }); // axe must not sample the report's pop-in halfway
  await page.route('**/api/demo/mode', (route) => route.fulfill({ json: { mode: 'live', demoMode: false, liveAvailable: true, generation: 4 } }));
  await page.route('**/api/x402/config', (route) => route.fulfill({ json: { ok: true, configured: true, network: 'eip155:1439', services: [{ serviceId: 'premium-risk', endpoint,
    priceUSDC: 0.001, title: 'Premium Risk Intelligence', description: 'Research risk report', status: 'available' }] } }));
  await page.route(`**${endpoint}`, (route) => { paidCalls.push(route.request().method()); return route.fulfill({ status: 500, json: { error: 'must not pay again' } }); });
  await page.route('**/api/x402/recovery/**', (route) => {
    const url = new URL(route.request().url()), token = route.request().headers()['x-x402-recovery'];
    if (url.pathname.endsWith('/challenges')) return route.fulfill({ json: { ok: true, challenge_id: '11111111-1111-4111-8111-111111111111',
      domain: { name: 'AgentBL Paid Report Recovery', version: '1' }, types: { PaidReportRecovery: [{ name: 'payer', type: 'address' }, { name: 'purpose', type: 'string' }, { name: 'nonce', type: 'bytes32' }, { name: 'validUntil', type: 'uint256' }] },
      message: { payer, purpose: 'This signature moves no funds and authorizes no payment.', nonce: `0x${'00'.repeat(32)}`, validUntil: 2_000_000_000 } } });
    if (url.pathname.endsWith('/sessions')) return route.fulfill({ json: { ok: true, token: 'ab'.repeat(32), payer, expires_at: Date.now() + 900_000 } });
    if (token !== 'ab'.repeat(32)) return route.fulfill({ status: 401, json: { code: 'x402_recovery_session_required' } });
    if (url.pathname.endsWith('/payments')) return route.fulfill({ json: { ok: true, payments: [{ payment_id: paymentId, state: 'SETTLED', nonce, report_id: null, amount: '1000' }] } });
    recoveries.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, status: 'delivered', payment: { payment_id: paymentId, state: 'UNLOCKED', report_id: reportId }, report } });
  });
  await page.route('**/api/x402/report/**', (route) => route.request().headers()['x-x402-recovery'] === 'ab'.repeat(32)
    ? route.fulfill({ json: { ...report, cached: true } }) : route.fulfill({ status: 401, json: { code: 'payment_authorization_required' } }));

  await page.goto('/#/market'); await expect(page.locator('.deal-card').first()).toBeVisible();
  await page.locator('.market-aside button').filter({ hasText: zh ? '航程与风险' : 'Voyage and risk' }).first().click();
  await page.locator('#deal-tab-reports').click();
  const records = page.locator('.x402-records');
  await expect(records).toContainText('0.001000 USDC');
  await records.getByRole('button', { name: zh ? '用付款钱包找回（不扣款）' : 'Recover with the paying wallet (no charge)' }).click();
  await expect(page.locator('.x402-log')).toContainText(zh ? '1 份报告已恢复' : '1 report(s) restored');
  await expect(records).toContainText(zh ? '没有待核对的付款。' : 'No payments need reconciliation.');
  expect(recoveries).toEqual([{ request: paidRequest }]);
  await page.getByRole('button', { name: zh ? '↻ 重新打开（已支付）' : '↻ Re-open (already paid)' }).click();
  await expect(page.locator('.report-detail[data-state="unlocked"]')).toHaveCSS('opacity', '1');

  expect(await page.evaluate(() => window.walletCalls.filter((call) => call.method === 'eth_signTypedData_v4').map((call) => call.primaryType))).toEqual(['PaidReportRecovery']);
  expect(paidCalls).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('agentbl-x402-journal-v2').includes('signature'))).toBe(false);
  const scan = await new AxeBuilder({ page }).include('#deal-panel-reports').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(scan.violations, JSON.stringify(scan.violations.map((v) => [v.id, v.nodes.map((n) => n.target)]))).toEqual([]);
});
