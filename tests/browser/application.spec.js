import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';

const copper = 'CASE-EBL-CU-SIN-SHA', diesel = 'CASE-EBL-GASOIL-SIN-JKT';
for (const language of ['zh', 'en']) {
  test(`W3 ${language}: research rights state and unavailable controls are explicit on desktop`, async ({ page }, testInfo) => {
    await page.addInitScript((lang) => localStorage.setItem('ts_lang', lang), language);
    await page.goto('/');
    await page.locator('.research-tools > summary').click();
    const panel = page.locator('.rights-panel'); await panel.locator('summary').click();
    await panel.locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(panel.locator('details')).not.toHaveAttribute('open');
    await page.keyboard.press('Enter'); await expect(panel.locator('details')).toHaveAttribute('open', '');
    await expect(panel).toContainText(language === 'zh' ? '尚未配置受控融资实例' : 'No controlled financing instance is configured');
    await expect(panel).toContainText(language === 'zh' ? '尚未启用' : 'Disabled');
    await expect(panel).toContainText(language === 'zh' ? '退款和领取权' : 'refund and claim rights');
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await panel.screenshot({ path: testInfo.outputPath(`rights-${language}.png`) });
    await page.route('**/api/rights/status', (route) => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
    await page.reload(); await page.locator('.research-tools > summary').click(); await page.locator('.rights-panel summary').click();
    await expect(page.locator('.rights-panel')).toContainText(language === 'zh' ? '暂不可核对' : 'unavailable');
  });
}
test.beforeEach(async ({ request }) => { await request.post('/api/demo/reset'); });
const ready = async (page) => {
  await page.goto('/#/mint'); await expect(page.locator('#mint-btn')).toBeVisible();
  await page.locator('#case-dropdown').selectOption(copper); await expect(page.locator('#mint-btn')).toBeEnabled();
};

// The glass and its dark appearance follow the system setting, so both schemes carry the same bar. The scan
// covers the default finance page too and every WCAG 2.0–2.2 A/AA rule, plus label-content-name-mismatch
// (axe ships it as experimental): voice-control users say the visible text, so it must be in the name.
// Reduced motion keeps axe from sampling a control halfway through a fade.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const fullScan = (page) => new AxeBuilder({ page }).withTags(WCAG_TAGS).options({ rules: { 'label-content-name-mismatch': { enabled: true } } }).analyze();
const violations = (result) => JSON.stringify(result.violations.map((v) => [v.id, v.nodes.map((n) => n.target)]));
for (const language of ['zh', 'en']) for (const scheme of ['light', 'dark']) {
  test(`${language}${scheme === 'dark' ? ' dark' : ''}: five pages have no overflow, page errors or WCAG A/AA violations`, async ({ page }, testInfo) => {
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.addInitScript((lang) => localStorage.setItem('ts_lang', lang), language);
    await ready(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['finance', 'market', 'mint', 'agent', 'discover']) {
        await page.goto(`/#/${view}`); await expect(page.locator(`#view-${view}`)).toBeVisible();
        await expect(page.locator(`#view-${view} .page-loading`)).toHaveCount(0); // views are code-split
        if (view === 'market') await expect(page.locator('.deal-card').first()).toBeVisible();
        if (view === 'finance') await expect(page.locator('#controlled-finance .finance-loading')).toHaveCount(0);
        const result = await fullScan(page);
        expect(result.violations, violations(result)).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 1440) await page.screenshot({ path: testInfo.outputPath(`${view}-${language}-${scheme}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('F06: Demo mint never connects or sends through a configured wallet', async ({ page }) => {
  await page.addInitScript(() => {
    window.walletCalls = [];
    window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method }) => {
      window.walletCalls.push(method);
      if (method === 'eth_accounts') return [];
      if (method === 'eth_chainId') return '0x59f';
      throw new Error('Test wallet refuses signing');
    } };
  });
  await ready(page); await page.locator('#mint-btn').click();
  await expect(page.locator('.mint-result')).toBeVisible();
  expect(await page.evaluate(() => window.walletCalls.filter((method) => /sendTransaction|requestAccounts|sign/iu.test(method)))).toEqual([]);
});

test('F07/F08: switching with a delayed preference response removes old terms immediately and isolates preferences', async ({ page }) => {
  await ready(page);
  const floor = page.locator('#pref-min-price');
  await expect(floor).toBeVisible(); await floor.fill('0.999'); await floor.blur();
  await expect(page.locator('#mint-btn')).toBeDisabled();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(`**/api/agent/cases/${diesel}/preferences`, async (route) => { if (route.request().method() === 'GET') await gate; await route.continue(); });
  await page.locator('#case-dropdown').selectOption(diesel);
  await expect(page.locator('#case-dropdown')).toHaveValue(diesel);
  await expect(page.locator('#mint-btn')).toHaveCount(0);
  await expect(page.locator('.deal-strip')).not.toContainText('Shanghai');
  release(); await expect(page.locator('#mint-btn')).toBeEnabled();
  await expect(page.locator('#pref-min-price')).toHaveValue('');
  await page.locator('#case-dropdown').selectOption(copper);
  await expect(page.locator('#pref-min-price')).toHaveValue('0.999');
});

test('F05: uploaded working documents are absent from public listings and inaccessible to another browser', async ({ page, browser }) => {
  await ready(page);
  const documents = await Promise.all(['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'].map(async (name) => ({ name, mime_type: 'text/markdown',
    text: (await fs.readFile(new URL(`../../data/uploads/copper-sg-shanghai/${name}`, import.meta.url), 'utf8')).replaceAll('Merlion Metals', 'PrivateTestExporter') })));
  const uploaded = await page.request.post('/api/agent/ingest?wait=1', { data: { case_id: 'BROWSER-PRIVATE-TEST', documents } });
  expect(uploaded.status()).toBe(202);
  const result = await uploaded.json();
  expect((await page.request.get(`/api/agent/jobs/${result.job.job_id}`)).status()).toBe(200);
  const other = await browser.newContext(); const stranger = await other.newPage(); await stranger.goto('/');
  expect((await stranger.request.get(`/api/agent/jobs/${result.job.job_id}`)).status()).toBe(404);
  const cases = await stranger.request.get('/api/cases'); expect(await cases.text()).not.toContain('PrivateTestExporter');
  const refs = await stranger.request.get('/api/agent/references'); expect(await refs.text()).not.toContain('BROWSER-PRIVATE-TEST');
  await other.close();
});

test('F09: a funded or in-transit pool cannot show an enabled subscription or OPEN status', async ({ page }) => {
  await page.route('**/api/agent/references', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    const pool = data.pools.find((item) => item.case_id === copper);
    if (pool) Object.assign(pool, { status: 'Funded', can_subscribe: false, remaining_usd: 0, subscribed_usd: pool.target_usd });
    await route.fulfill({ json: data });
  });
  await ready(page); await page.goto('/#/market');
  await expect(page.locator('#market-subscribe-btn')).toBeDisabled();
  await expect(page.locator('#market-detail .detail-badges')).not.toContainText('OPEN');
});

test('retirement: Live issuance requires controlled financing and exposes no old mint action', async ({ page }) => {
  await page.route('**/api/demo/mode', (route) => route.fulfill({ json: { demoMode: false, liveAvailable: true, generation: 1 } }));
  await page.addInitScript(() => { delete window.ethereum; });
  await page.goto('/#/mint');
  await page.locator('#case-dropdown').selectOption(copper);
  await expect(page.locator('#mint-btn')).toBeDisabled();
  await expect(page.locator('.mint-result')).toHaveCount(0);
  await expect(page.locator('#controlled-finance')).toBeVisible();
});

test('F07/F08: a late B preference response cannot overwrite a newer A selection', async ({ page }) => {
  await ready(page);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(`**/api/agent/cases/${diesel}/preferences`, async (route) => { await gate; await route.continue(); });
  await page.locator('#case-dropdown').selectOption(diesel);
  await page.locator('#case-dropdown').selectOption(copper);
  await expect(page.locator('#mint-btn')).toBeEnabled();
  release(); await page.waitForResponse((response) => response.url().includes(`${diesel}/preferences`));
  await expect(page.locator('#case-dropdown')).toHaveValue(copper);
  await expect(page.locator('.deal-strip')).toContainText('Shanghai');
  await expect(page.locator('#pref-min-price')).toHaveValue('');
});

for (const language of ['zh', 'en']) {
  test(`W2 ${language}: confirmed and reconciling Live positions fit a 390px wallet portfolio`, async ({ page }, testInfo) => {
    const wallet = `0x${'2'.repeat(40)}`, pool = `0x${'1'.repeat(40)}`, asset = `0x${'3'.repeat(40)}`;
    await page.addInitScript(({ language, wallet }) => {
      localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
      window.walletHandlers = {};
      window.ethereum = { isMetaMask: true, on(name, handler) { window.walletHandlers[name] = handler; }, removeListener() {}, request: async ({ method }) => {
        if (method === 'eth_chainId') return '0x59f';
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [wallet];
        throw new Error('Browser regression does not authorize transactions');
      } };
    }, { language, wallet });
    await page.route('**/api/investors/portfolio?**', (route) => route.fulfill({ json: { ok: true, investments: [], summary: { totalInvestedUsd: 0, avgYieldBps: 0 } } }));
    await page.route('**/api/positions?**', (route) => route.fulfill({ json: { wallet, positions: [
      { position_id: 'confirmed', mode: 'live', protocol_instance: { chain_id: 1439, pool_address: pool, protocol_version: 5 }, chain_pool_id: 1,
        investor: wallet, asset, shares: '10', cost_atomic: '8000000', claimed_atomic: '0', claimable_atomic: '9500000', status: 'active', reconciled: true, chain_state: 'Repaid' },
      { position_id: 'unknown', mode: 'live', protocol_instance: { chain_id: 1439, pool_address: pool, protocol_version: 5 }, chain_pool_id: 2,
        investor: wallet, asset, shares: '7', cost_atomic: null, claimed_atomic: null, claimable_atomic: null, status: 'reconciling', reconciled: false }
    ] } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/market');
    await expect(page.locator('.portfolio-btn')).toBeVisible();
    await page.locator('.portfolio-btn').click();
    const positions = page.locator('.live-positions');
    await expect(positions).toBeVisible();
    await expect(positions).toContainText('8.000000'); await expect(positions).toContainText('9.500000');
    await expect(positions).toContainText(language === 'zh' ? '对账中' : 'Reconciling');
    // Demo mode keeps wallet withdrawal disabled until the user changes the runtime explicitly.
    await expect(positions.locator('button')).toHaveCount(1);
    await expect(positions.locator('button')).toBeDisabled();
    expect(await positions.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // The side sheet slides in from 28px to the right; measure where it settles, not a frame of the animation.
    await page.locator('#portfolio-dialog').evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    const bounds = await page.locator('#portfolio-dialog').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.locator('#portfolio-dialog').screenshot({ path: testInfo.outputPath(`positions-${language}-390.png`) });
    let release;
    const delayedPortfolio = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/investors/portfolio?**', async (route) => { await delayedPortfolio; await route.fulfill({ json: { ok: true, investments: [], summary: null } }); });
    await page.evaluate(() => window.walletHandlers.accountsChanged([]));
    await expect(page.locator('.live-positions')).toHaveCount(0);
    release();
  });
}
