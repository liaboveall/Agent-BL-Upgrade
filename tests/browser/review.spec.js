import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';

const copper = 'CASE-EBL-CU-SIN-SHA', diesel = 'CASE-EBL-GASOIL-SIN-JKT';
test.beforeEach(async ({ request }) => { await request.post('/api/demo/reset'); });
const ready = async (page) => {
  await page.goto('/#/mint'); await expect(page.locator('#mint-btn')).toBeVisible();
  await page.locator('#case-dropdown').selectOption(copper); await expect(page.locator('#mint-btn')).toBeEnabled();
};

for (const language of ['zh', 'en']) {
  test(`${language}: four desktop pages have no overflow, page errors or contrast violations`, async ({ page }, testInfo) => {
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((lang) => localStorage.setItem('ts_lang', lang), language);
    await ready(page);
    for (const view of ['market', 'mint', 'agent', 'discover']) {
      await page.goto(`/#/${view}`); await expect(page.locator(`#view-${view}`)).toBeVisible();
      if (view === 'market') await expect(page.locator('.deal-card').first()).toBeVisible();
      const result = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
      expect(result.violations, JSON.stringify(result.violations.map((v) => v.nodes.map((n) => n.target)))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${view}-${language}.png`), fullPage: true });
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

test('F06: a Live wallet failure remains a failure and never becomes simulated issuance', async ({ page }) => {
  await page.route('**/api/demo/mode', (route) => route.fulfill({ json: { demoMode: false, liveAvailable: true, generation: 1 } }));
  await page.addInitScript(() => { delete window.ethereum; });
  await ready(page); await page.locator('#mint-btn').click();
  await expect(page.locator('.toast')).toBeVisible();
  await expect(page.locator('.mint-result')).toHaveCount(0);
  await expect(page.locator('#mint-btn')).toBeEnabled();
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
