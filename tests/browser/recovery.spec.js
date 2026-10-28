import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Application review F2/F3 and F6 at the page: what a saved wallet operation and a failed preference save look like.
const wallet = `0x${'12'.repeat(20)}`, pool = `0x${'34'.repeat(20)}`, intentId = '0b0e6a1c-1111-4c1d-9d1e-123456789abc';

async function financePage(page, language) {
  await page.addInitScript(({ language, wallet, pool, intentId }) => {
    localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
    localStorage.setItem(`agentbl.controlled-intent:${pool}:${wallet}`, JSON.stringify({ intent_id: intentId, operation: 'SUBSCRIBE', status: 'broadcast_prepared' }));
    window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [wallet];
      if (method === 'eth_chainId') return '0x59f';
      throw new Error('No transaction is authorized by this browser fixture');
    } };
  }, { language, wallet, pool, intentId });
  const config = { chainIdDecimal: 1439, protocolVersion: 5, controlVersion: 3, contracts: { RWAOfferingPool: pool }, abis: { RWAOfferingPool: [] } };
  await page.route('**/api/demo/mode', (route) => route.fulfill({ json: { mode: 'live', demoMode: false, liveAvailable: true, generation: 3 } }));
  await page.route('**/api/controlled/status', (route) => route.fulfill({ json: { active: true, config, controller: `0x${'90'.repeat(20)}` } }));
  await page.route('**/api/controlled/offerings**', (route) => route.fulfill({ json: { config, snapshot: { block_number: 700, block_hash: `0x${'ab'.repeat(32)}`, block_timestamp: Math.floor(Date.now() / 1000) - 180 },
    total_pools: 1, complete: true, failures: [], next_cursor: null, offerings: [{ pool_id: 7, state: 'Open', shares: '10', subscribed: '0', issue_price_atomic: '800000', redemption_per_share_atomic: '1000000',
      raised_atomic: '0', disbursed_atomic: '0', recovered_atomic: '0', maturity: '1900000000', subscription_deadline: '1890000000', disbursement_deadline: '1895000000', subscription_open: false }] } }));
  await page.route('**/api/controlled/positions?**', (route) => route.fulfill({ json: { positions: [], complete: true, next_cursor: null } }));
}

for (const language of ['zh', 'en']) {
  const zh = language === 'zh';
  test(`F2 ${language}: an operation the wallet never sent is released only when the server agrees`, async ({ page }) => {
    await financePage(page, language);
    let pendingOnChain = true, releases = 0;
    await page.route(`**/api/controlled/intents/${intentId}/release`, (route) => {
      releases += 1;
      return route.fulfill(pendingOnChain ? { status: 409, json: { error: 'pending', code: 'transaction_pending' } }
        : { json: { intent: { intent_id: intentId, operation: 'SUBSCRIBE', status: 'released' } } });
    });
    await page.goto('/#/finance');
    const panel = page.locator('.controlled-panel'), saved = panel.locator('.controlled-pending');
    await expect(saved).toContainText(zh ? '已准备发送，等待钱包' : 'Prepared, waiting for the wallet');
    // The identity line says what every action needs before anything fails on it.
    await expect(panel.getByRole('group', { name: zh ? '身份状态' : 'Identity status' })).toContainText(zh ? '未验证或已过期' : 'Not verified or expired');
    await expect(panel.locator('.finance-overview')).toContainText(zh ? '区块 #700 · 3 分钟前' : 'Block #700 · 3 min ago');

    const release = saved.getByRole('button', { name: zh ? '钱包没有发送，释放记录' : 'The wallet did not send it: release', exact: true });
    await release.click();
    await expect(panel.locator('.finance-alert')).toContainText(zh ? '原交易仍在等待打包' : 'still pending');
    await expect(panel.locator('.finance-alert-funds')).toContainText(zh ? '可能已有交易发出' : 'a transaction may be out');
    await expect(saved).toHaveCount(1);

    pendingOnChain = false; await release.click();
    await expect(saved).toHaveCount(0);
    await expect(panel.locator('.controlled-notice')).toContainText(zh ? '下一次发送会沿用同一个 nonce' : 'The next send reuses its nonce');
    expect(await page.evaluate(({ pool, wallet }) => localStorage.getItem(`agentbl.controlled-intent:${pool}:${wallet}`), { pool, wallet })).toBeNull();
    expect(releases).toBe(2);

    // A pool detail has its own address and survives a reload.
    await panel.getByRole('button', { name: `${zh ? '查看详情' : 'View details'} #7`, exact: true }).click();
    await expect(page).toHaveURL(/#\/finance\/pool\/7$/u);
    await page.reload();
    await expect(page.locator('.controlled-panel').getByRole('region', { name: zh ? '融资详情' : 'Financing details', exact: true })).toContainText('#7');
    expect((await new AxeBuilder({ page }).include('.controlled-panel').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  });

  test(`F6 ${language}: a failed preference save stays marked, changes no quote and can be retried`, async ({ page }) => {
    await page.addInitScript((lang) => localStorage.setItem('ts_lang', lang), language);
    let failing = true;
    const writes = [];
    await page.route('**/api/agent/cases/*/preferences', (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      writes.push(new URL(route.request().url()).pathname);
      return failing ? route.fulfill({ status: 503, json: { error: 'Synthetic persistence failure' } }) : route.continue();
    });
    await page.goto('/#/mint'); await expect(page.locator('#mint-btn')).toBeVisible();
    await page.locator('#case-dropdown').selectOption('CASE-EBL-CU-SIN-SHA'); await expect(page.locator('#mint-btn')).toBeEnabled();
    const quotes = [];
    page.on('request', (request) => { if (request.method() === 'POST' && /\/api\/(pricing|quote|compare)/u.test(request.url())) quotes.push(request.url()); });
    const floor = page.locator('#pref-min-price');
    await floor.fill('0.99'); await floor.press('Enter');
    const banner = page.locator('.pref-unsaved');
    await expect(banner).toContainText(zh ? '偏好未保存' : 'Preferences not saved');
    await expect(banner).toContainText('Synthetic persistence failure');
    expect(quotes).toEqual([]);
    expect(writes.at(-1)).toMatch(/^\/api\/agent\/cases\/WS-[0-9A-F]{10}-CASE-EBL-CU-SIN-SHA\/preferences$/u);
    await expect(floor).toHaveValue('0.99');

    await banner.getByRole('button', { name: zh ? '撤销修改' : 'Undo changes', exact: true }).click();
    await expect(banner).toHaveCount(0); await expect(floor).toHaveValue('');

    await floor.fill('0.99'); await floor.press('Enter'); await expect(banner).toBeVisible();
    failing = false;
    await banner.getByRole('button', { name: zh ? '重试保存' : 'Retry saving', exact: true }).click();
    await expect(banner).toHaveCount(0); await expect(floor).toHaveValue('0.99');
    // Only the saved value reprices.
    await expect.poll(() => quotes.length).toBeGreaterThan(0);
    await expect(page.locator('.documents')).toContainText(zh ? '工作副本' : 'working copy');
  });
}
