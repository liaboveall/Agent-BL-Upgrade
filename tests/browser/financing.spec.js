import { keccak256, toUtf8Bytes } from 'ethers';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { disclosureFixture } from '../helpers/disclosure.js';

for (const language of ['zh', 'en']) for (const width of [1280, 390, 768, 1440]) test(`N3 ${language} ${width}: pages, partial failures, role preview and wallet invalidation`, async ({ page }, info) => {
  const zh = language === 'zh', wallet = `0x${'12'.repeat(20)}`, pack = disclosureFixture(), materialId = '11111111-1111-4111-8111-111111111111';
  const snapshot = { block_number: 500, block_hash: `0x${'ab'.repeat(32)}` }, config = { chainIdDecimal: 1439, protocolVersion: 5, controlVersion: 4,
    contracts: { RWAOfferingPool: pack.document.instance.pool }, abis: { RWAOfferingPool: [] } };
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(({ language, wallet }) => {
    localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
    window.n3Handlers = {}; window.n3Calls = []; window.n3Reject = true;
    window.ethereum = { isMetaMask: true, on(event, handler) { window.n3Handlers[event] = handler; }, removeListener() {}, request: async ({ method }) => {
      window.n3Calls.push(method);
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [wallet];
      if (method === 'eth_chainId') return '0x59f';
      if (method === 'eth_signTypedData_v4') { if (window.n3Reject) throw Object.assign(new Error('Wallet declined this signature'), { code: 4001 }); return `0x${'11'.repeat(65)}`; }
      throw new Error('No chain transaction is authorized by this browser fixture');
    } };
  }, { language, wallet });
  await page.route('**/api/demo/mode', (route) => route.fulfill({ json: { mode: 'live', demoMode: false, liveAvailable: true, generation: 4 } }));
  await page.route('**/api/controlled/status', (route) => route.fulfill({ json: { active: true, config, controller: pack.document.instance.controller } }));
  let partial = false;
  const offer = (id) => ({ pool_id: id, state: 'Open', shares: '10', subscribed: '0', issue_price_atomic: '800000', redemption_per_share_atomic: '1000000',
    raised_atomic: '0', disbursed_atomic: '0', recovered_atomic: '0', maturity: pack.terms.maturity, subscription_open: false });
  await page.route('**/api/controlled/offerings**', (route) => {
    const url = new URL(route.request().url()), id = /^\/api\/controlled\/offerings\/(\d+)$/u.exec(url.pathname)?.[1], from = Number(url.searchParams.get('from') ?? 1);
    const ids = id ? [Number(id)] : Array.from({ length: Math.min(10, 26 - from) }, (_, i) => from + i);
    return route.fulfill({ json: { config, snapshot, total_pools: 25, complete: !partial, failures: partial ? [{ pool_id: 12, code: 'pool_read_unavailable' }] : [],
      next_cursor: !id && from + 10 < 26 ? from + 10 : null, offerings: ids.filter((value) => !partial || value !== 12).map(offer) } });
  });
  await page.route('**/api/controlled/positions?**', (route) => route.fulfill({ json: { positions: [], complete: true, next_cursor: null } }));
  const routes = []; let exitLogin = false;
  await page.route('**/api/rights/**', (route) => {
    const url = new URL(route.request().url()), name = url.pathname.slice('/api/rights/'.length); routes.push({ name, token: route.request().headers()['x-rights-session'] });
    let json;
    if (name === 'wallet-challenges') { exitLogin = route.request().postDataJSON().exit_only === true; json = { challenge_id: materialId, domain: { name: 'AgentBL Business Session', version: '1' }, types: { BusinessSession: [{ name: 'wallet', type: 'address' }] }, message: { wallet } }; }
    else if (name === 'sessions') json = { token: 'ab'.repeat(32), expires_at: Date.now() + 3600000, exit_only: exitLogin };
    else if (name === 'me') json = { organization: 'research-carrier', wallet, roles: exitLogin ? [] : ['operator'], exit_only: exitLogin };
    else if (name === 'materials') json = { materials: [{ material_id: materialId, revision: 2 }] };
    else if (name.endsWith('/workflow')) json = { material_id: materialId, revision: 2, pool_id: 25, terms_hash: pack.terms_hash, document_hash: pack.terms.documentHash, disclosure: pack, snapshot,
      steps: [{ id: 'draw', roles: ['operator'], status: 'pending', assigned_to_you: true }] };
    else if (name === 'transaction-plans') json = { plan_id: materialId, scope: 'research_test_assets_only', execution: 'unsigned_dry_run', status: 'draft',
      preview: { operation: 'disburse', pool_id: 25, wallet, destination: config.contracts.RWAOfferingPool, amount_atomic: '8000000', chain_id: '1439' } };
    else json = { error: 'Unexpected fixture request' };
    return route.fulfill({ json });
  });
  const walletPositions = page.waitForResponse((response) => response.url().includes('/api/controlled/positions?wallet='));
  await page.goto('/#/finance'); const panel = page.locator('.controlled-panel');
  await walletPositions; await expect(panel.getByRole('button', { name: /0x121212.*1212/u })).toBeVisible();
  await panel.getByRole('button', { name: zh ? '打开工作台：身份验证与角色待办' : 'Open workspace: identity and role responsibilities', exact: true }).click();
  const next = panel.getByRole('button', { name: zh ? '下一页' : 'Next page', exact: true });
  await expect(panel.locator('tbody tr').first()).toContainText('#1'); await next.click(); await expect(panel.locator('tbody tr').first()).toContainText('#11');
  partial = true; await next.click(); await expect(panel).toContainText(zh ? '尚未读到的池' : 'Unread pools'); await expect(panel.locator('tbody tr').last()).toContainText('#25');
  await expect(next).toBeDisabled(); partial = false;
  await panel.getByLabel(zh ? '指定池编号' : 'Pool ID', { exact: true }).fill('25'); await panel.getByRole('button', { name: zh ? '查找' : 'Find pool', exact: true }).click();
  await expect(panel.locator('tbody tr')).toHaveCount(1); await expect(panel.locator('tbody tr')).toContainText('#25');
  const workspace = panel.getByRole('region', { name: zh ? '融资角色工作台' : 'Financing role workspace' });
  await workspace.getByLabel(zh ? '管理员发放的业务身份编号' : 'Enrolled business identity ID').fill(materialId);
  const login = workspace.getByRole('button', { name: zh ? '用当前钱包验证角色' : 'Verify role with this wallet' }); await login.click();
  await expect(workspace.getByRole('alert')).toBeVisible(); await page.evaluate(() => { window.n3Reject = false; }); await login.click();
  await expect(workspace).toContainText('research-carrier');
  await workspace.getByLabel(zh ? '本组织材料' : 'Organization materials').selectOption(materialId);
  await expect(workspace).toContainText(zh ? '你的职责' : 'Your responsibility');
  await workspace.getByLabel(zh ? '本次操作' : 'Next action').selectOption('disburse');
  await workspace.getByLabel(zh ? '金额（TEST_USDC，最多 6 位小数）' : 'Amount (TEST_USDC, up to 6 decimals)').fill('8');
  await expect(workspace.locator('#role-amount-exact')).toContainText('8000000');
  // A commitment can come from a local file: its keccak256 is computed in the browser and the file is not uploaded.
  await workspace.getByLabel(zh ? '或从本地文件生成' : 'Or compute it from a local file').setInputFiles({ name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('agentbl evidence') });
  await expect(workspace.getByLabel(zh ? '审查材料承诺' : 'Evidence commitment')).toHaveValue(keccak256(toUtf8Bytes('agentbl evidence')));
  await expect(workspace.locator('#role-evidence-help')).toContainText('evidence.txt');
  await workspace.getByLabel(zh ? '审查材料承诺' : 'Evidence commitment').fill(`0x${'bc'.repeat(32)}`);
  const prepare = workspace.getByRole('button', { name: zh ? '准备可读预览' : 'Prepare readable preview' }); await prepare.focus(); await page.keyboard.press('Enter');
  const preview = workspace.getByRole('region', { name: zh ? '角色操作预览' : 'Role action preview' }); await expect(preview).toContainText('8.000000 TEST_USDC');
  const confirm = preview.getByRole('button', { name: zh ? '确认本次操作' : 'Confirm this action' }); await expect(confirm).toBeDisabled();
  await preview.getByRole('checkbox').focus(); await page.keyboard.press('Space'); await expect(confirm).toBeEnabled();
  await workspace.screenshot({ path: info.outputPath(`role-${language}-${width}.png`) }); await page.screenshot({ path: info.outputPath(`whole-${language}-${width}.png`), fullPage: true });
  await info.attach('viewport', { body: JSON.stringify(await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }))), contentType: 'application/json' });
  const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > innerWidth + 1 && !node.closest('.controlled-table-wrap, .research-constraints'))
    .map((node) => [node.tagName, node.className, Math.round(node.getBoundingClientRect().right)]));
  expect(overflow).toEqual([]);
  expect((await new AxeBuilder({ page }).include('.role-workspace').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  // The display language is not part of the identity: switching keeps the session, material, action and preview
  // without another wallet challenge or chain re-read; only the confirmation given in the other language is reset.
  const challenges = routes.filter((row) => row.name === 'wallet-challenges').length, reads = routes.length;
  await page.locator('.lang-btn').click();
  const relabelled = panel.getByRole('region', { name: zh ? 'Financing role workspace' : '融资角色工作台' });
  await expect(relabelled).toContainText('research-carrier');
  await expect(relabelled.getByLabel(zh ? 'Organization materials' : '本组织材料')).toHaveValue(materialId);
  await expect(relabelled.getByLabel(zh ? 'Next action' : '本次操作')).toHaveValue('disburse');
  const relabelledPreview = relabelled.getByRole('region', { name: zh ? 'Role action preview' : '角色操作预览' });
  await expect(relabelledPreview).toContainText('8.000000 TEST_USDC'); await expect(relabelledPreview.getByRole('checkbox')).not.toBeChecked();
  await expect(relabelled.getByRole('button', { name: zh ? 'Verify role with this wallet' : '用当前钱包验证角色' })).toHaveCount(0);
  await expect(panel.locator('tbody tr')).toHaveCount(1);
  expect(routes.filter((row) => row.name === 'wallet-challenges').length).toBe(challenges); expect(routes.length).toBe(reads);
  await page.locator('.lang-btn').click(); await expect(preview.getByRole('checkbox')).not.toBeChecked(); await expect(workspace).toContainText('research-carrier');
  await page.evaluate(() => window.n3Handlers.accountsChanged([])); await expect(preview).toHaveCount(0); await expect(workspace.getByText('research-carrier')).toHaveCount(0);
  await expect(panel.locator('tbody tr').first()).toContainText('#1 ·');
  const privateReadsBefore = routes.filter((row) => row.name === 'materials').length;
  await panel.getByRole('button', { name: zh ? '连接 EVM 钱包' : 'Connect EVM wallet', exact: true }).click();
  await workspace.getByRole('button', { name: zh ? '仅验证既有退款与领取' : 'Verify existing refunds and claims only' }).click();
  await expect(workspace).toContainText(zh ? '仅退出会话' : 'Exit-only session');
  expect(routes.filter((row) => row.name === 'materials').length).toBe(privateReadsBefore);
  expect(await page.evaluate(() => window.n3Calls.filter((name) => /sendTransaction/iu.test(name)))).toEqual([]);
  expect(routes.find((row) => row.name === 'transaction-plans').token).toBe('ab'.repeat(32));
});
