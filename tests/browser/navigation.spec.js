import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const language of ['zh', 'en']) for (const width of [390, 768, 1280, 1440]) test(`N4 ${language} ${width}: whole application, snapshot navigation and recovery`, async ({ page }, info) => {
  const zh = language === 'zh', wallet = `0x${'12'.repeat(20)}`, pool = `0x${'34'.repeat(20)}`;
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(({ language, wallet }) => {
    localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
    window.n4Handlers = {}; window.n4Calls = [];
    window.ethereum = { isMetaMask: true, on(name, fn) { window.n4Handlers[name] = fn; }, removeListener() {}, request: async ({ method }) => {
      window.n4Calls.push(method);
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [wallet];
      if (method === 'eth_chainId') return '0x59f';
      throw new Error('No signature or chain send in this browser fixture');
    } };
  }, { language, wallet });
  let total = 25, snapshot = 500, partial = false, outage = false, positionsOutage = false, delay = false;
  const requests = [];
  const config = { chainIdDecimal: 1439, controlVersion: 2, contracts: { RWAOfferingPool: pool } };
  await page.route('**/api/demo/mode', (route) => route.fulfill({ json: { demoMode: false, liveAvailable: true, generation: 4 } }));
  await page.route('**/api/controlled/status', (route) => route.fulfill({ json: { active: true, config } }));
  await page.route('**/api/controlled/positions?**', (route) => route.fulfill(positionsOutage ? { status: 503, json: { error: 'Position unavailable' } } : { json: { complete: true, positions: [], next_cursor: null } }));
  await page.route('**/api/controlled/offerings**', async (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    if (delay) await new Promise((resolve) => setTimeout(resolve, 300));
    if (outage) return route.fulfill({ status: 503, json: { error: 'RPC unavailable' } });
    const from = Number(url.searchParams.get('from') ?? 1), id = /offerings\/(\d+)$/u.exec(url.pathname)?.[1];
    const block = Number(url.searchParams.get('block_number') ?? snapshot), count = block === 500 ? 25 : total;
    const ids = id ? [Number(id)] : Array.from({ length: Math.max(0, Math.min(10, count - from + 1)) }, (_, i) => from + i);
    return route.fulfill({ json: { snapshot: { block_number: block, block_hash: `0x${'ab'.repeat(32)}` }, total_pools: count,
      complete: !partial, failures: partial ? [{ pool_id: from + 1 }] : [], next_cursor: !id && from + 10 <= count ? from + 10 : null,
      offerings: ids.filter((value) => !partial || value !== from + 1).map((value) => ({ pool_id: value, state: 'Open', shares: '10', subscribed: '0',
        maturity: '1900000000', subscription_deadline: '1890000000', disbursement_deadline: '1895000000', subscription_open: false,
        issue_price_atomic: '800000', redemption_per_share_atomic: '1000000', raised_atomic: '0', disbursed_atomic: '0', recovered_atomic: '0' })) } });
  });
  const positionsLoaded = page.waitForResponse((r) => r.url().includes('/api/controlled/positions?wallet='));
  await page.goto('/'); await positionsLoaded;
  const panel = page.locator('.controlled-panel'), rows = panel.locator('tbody tr');
  await expect(page.getByRole('tab', { name: zh ? '融资与退出' : 'Finance & exits' })).toHaveAttribute('aria-selected', 'true');
  await expect(rows).toHaveCount(10);
  const next = panel.getByRole('button', { name: zh ? '下一页' : 'Next page', exact: true });
  await next.focus(); await page.keyboard.press('Enter'); await expect(rows.first()).toContainText('#11 ·');
  await expect(next).toBeFocused();
  await next.click(); await expect(rows.first()).toContainText('#21 ·'); await expect(rows.last()).toContainText('#25 ·'); await expect(next).toBeDisabled();
  expect(requests.find((url) => url.searchParams.get('from') === '21').searchParams.get('block_number')).toBe('500');
  total = 26; snapshot = 501;
  await panel.getByRole('button', { name: zh ? '首页' : 'First page', exact: true }).click(); await expect(rows.first()).toContainText('#1 ·');
  await panel.getByRole('button', { name: zh ? '末页' : 'Last page', exact: true }).click(); await expect(rows.last()).toContainText('#25 ·');
  await panel.getByRole('button', { name: zh ? '刷新与对账' : 'Refresh and reconcile' }).click(); await expect(rows.first()).toContainText('#1 ·');
  await panel.getByRole('button', { name: zh ? '末页' : 'Last page', exact: true }).click(); await expect(rows.last()).toContainText('#26 ·');
  await panel.getByLabel(zh ? '指定池编号' : 'Pool ID', { exact: true }).fill('25');
  await panel.getByRole('button', { name: zh ? '查找资金池' : 'Find funding pool' }).click(); await expect(rows).toHaveCount(1);
  await panel.getByRole('button', { name: `${zh ? '融资详情' : 'Financing details'} #25`, exact: true }).click();
  await expect(panel.getByRole('region', { name: zh ? '融资详情' : 'Financing details', exact: true })).toContainText(zh ? '当前不接受新认购' : 'New subscriptions are closed');
  positionsOutage = true;
  const retry = panel.getByRole('button', { name: zh ? '重试当前查询' : 'Retry current query' });
  await retry.click(); await expect(panel).toContainText(zh ? '余额未知' : 'Balances are unknown'); await expect(rows).toHaveCount(1);
  await expect(panel.getByText(zh ? '此钱包在当前实例没有已发现的持仓。' : 'No positions were found for this wallet in this instance.', { exact: true })).toHaveCount(0);
  positionsOutage = false; outage = true; await retry.click(); await expect(panel.getByRole('alert')).toContainText('RPC unavailable');
  await expect(panel.getByText(zh ? '此实例尚无发行。' : 'This instance has no offerings.', { exact: true })).toHaveCount(0);
  outage = false; delay = true; await retry.click(); await expect(panel.getByRole('status').filter({ hasText: zh ? '正在读取' : 'Reading chain' })).toBeVisible();
  await expect(rows).toHaveCount(1); delay = false;
  await panel.getByRole('button', { name: zh ? '首页' : 'First page', exact: true }).click(); await expect(rows).toHaveCount(10);
  partial = true; await next.click(); await expect(rows.first()).toContainText('#11 ·'); await expect(panel).toContainText(zh ? '尚未读到的池' : 'Unread pools');
  partial = false; await retry.click(); await expect(rows).toHaveCount(10); await expect(rows.nth(1)).toContainText('#12 ·');
  await page.evaluate(() => window.n4Handlers.accountsChanged([])); await expect(rows.first()).toContainText('#1 ·');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`finance-${language}-${width}.png`), fullPage: true });
  expect((await new AxeBuilder({ page }).include('#main-content').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  for (const view of ['market', 'mint', 'agent', 'discover']) {
    await page.locator(`#tab-${view}`).click(); await expect(page.locator(`#view-${view}`)).toBeVisible();
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > innerWidth + 1 && !node.closest('.controlled-table-wrap, .research-constraints, .ac-table'))
      .map((node) => [node.tagName, node.className, Math.round(node.getBoundingClientRect().right)]));
    expect(overflow, view).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), view).toBe(true);
    await page.screenshot({ path: info.outputPath(`${view}-${language}-${width}.png`), fullPage: true });
  }
  // Real native modal, Escape, focus return and language redraw in the regular catalog.
  await page.locator('#tab-market').click();
  const opener = page.locator('.market-aside button').filter({ hasText: zh ? '航程与风险' : 'Voyage and risk' }).first();
  await expect(opener).toBeVisible(); await opener.focus(); await page.keyboard.press('Enter');
  const dialog = page.locator('#deal-detail-modal'); await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
  const controls = dialog.locator('button:visible:not([disabled]), a:visible[href], input:visible:not([disabled]), select:visible:not([disabled]), textarea:visible:not([disabled]), summary:visible, [tabindex="0"]:visible');
  await controls.first().focus(); await page.keyboard.press('Shift+Tab'); await expect(controls.last()).toBeFocused();
  await page.keyboard.press('Tab'); await expect(controls.first()).toBeFocused();
  await page.screenshot({ path: info.outputPath(`dialog-${language}-${width}.png`), fullPage: true });
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(opener).toBeFocused();
  await page.locator('.lang-btn').click(); await expect(page.locator('#tab-finance')).toHaveText(zh ? 'Finance & exits' : '融资与退出');
  expect(await page.evaluate(() => window.n4Calls.filter((method) => /sendTransaction|sign/iu.test(method)))).toEqual([]);
});
