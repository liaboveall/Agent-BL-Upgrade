import { test, expect } from '@playwright/test';
import { disclosureFixture } from '../helpers/disclosure.js';

for (const language of ['zh', 'en']) test(`role recovery ${language}: private-material-free pool actions and fresh-browser recovery`, async ({ page }) => {
  const zh = language === 'zh', wallet = `0x${'12'.repeat(20)}`, id = '11111111-1111-4111-8111-111111111111', pack = disclosureFixture();
  const config = { chainIdDecimal: 1439, protocolVersion: 5, controlVersion: 4, contracts: { RWAOfferingPool: pack.document.instance.pool }, abis: { RWAOfferingPool: [] } };
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(({ language, wallet }) => {
    localStorage.clear(); localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
    window.roleCalls = []; window.roleHandlers = {};
    window.ethereum = { isMetaMask: true, on(event, fn) { window.roleHandlers[event] = fn; }, removeListener() {}, request: async ({ method }) => {
      window.roleCalls.push(method);
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [wallet];
      if (method === 'eth_chainId') return '0x59f';
      if (method === 'eth_signTypedData_v4') return `0x${'11'.repeat(65)}`;
      throw Error('No transaction authorized by UI fixture');
    } };
  }, { language, wallet });
  await page.route('**/api/demo/mode', r => r.fulfill({ json: { mode: 'live', demoMode: false, liveAvailable: true, generation: 4 } }));
  await page.route('**/api/controlled/status', r => r.fulfill({ json: { active: true, config } }));
  await page.route('**/api/controlled/positions?**', r => r.fulfill({ json: { positions: [], complete: true } }));
  await page.route('**/api/controlled/offerings**', r => r.fulfill({ json: r.request().url().endsWith('/terms') ? { ...pack, pool_id: 1 } : { offerings: [], total_pools: 1, complete: true } }));
  let pending = true; const inputs = [];
  await page.route('**/api/rights/**', r => {
    const name = new URL(r.request().url()).pathname.slice('/api/rights/'.length); let json;
    if (name === 'wallet-challenges') json = { challenge_id: id, domain: { name: 'AgentBL Business Session', version: '1' }, types: { BusinessSession: [{ name: 'wallet', type: 'address' }] }, message: { wallet } };
    else if (name === 'sessions') json = { token: 'ab'.repeat(32), expires_at: Date.now() + 3600000 };
    else if (name === 'me') json = { organization: 'investor-only', wallet, roles: ['investor'] };
    else if (name === 'materials') json = { materials: [] };
    else if (name === 'transaction-plans' && r.request().method() === 'GET') json = { plans: pending ? [{ plan_id: id, operation: 'start_exit', status: 'broadcast_prepared' }] : [] };
    else if (name.endsWith('/release')) { pending = false; json = { plan_id: id, status: 'released' }; }
    else if (name === 'transaction-plans') { const input = r.request().postDataJSON(); inputs.push(input); json = { plan_id: id, status: 'draft', preview: { operation: input.operation, pool_id: input.pool_id, wallet, chain_id: '1439' } }; }
    else json = {};
    return r.fulfill({ json });
  });
  await page.goto('/#/finance');
  await page.getByRole('button', { name: zh ? '打开工作台：身份验证与角色待办' : 'Open workspace: identity and role responsibilities', exact: true }).click();
  const ws = page.getByRole('region', { name: zh ? '融资角色工作台' : 'Financing role workspace' });
  await ws.getByLabel(zh ? '管理员发放的业务身份编号' : 'Enrolled business identity ID').fill(id);
  await ws.getByRole('button', { name: zh ? '用当前钱包验证角色' : 'Verify role with this wallet' }).click();
  await expect(ws.locator('.role-pending')).toContainText(id);
  await ws.getByRole('button', { name: zh ? '钱包没有发出，释放记录' : 'The wallet sent nothing: release' }).click();
  const prepare = ws.getByRole('button', { name: zh ? '准备可读预览' : 'Prepare readable preview' });
  for (const operation of ['start_exit', 'finalize_funding', 'finalize_resolution', 'dispute_resolution']) {
    await ws.getByLabel(zh ? '本次操作' : 'Next action').selectOption(operation);
    await ws.getByLabel(zh ? '操作的资金池编号' : 'Action pool ID').fill('1');
    await expect(prepare).toBeEnabled();
  }
  await ws.getByLabel(zh ? '本次操作' : 'Next action').selectOption('start_exit'); await prepare.click();
  await expect(ws.getByRole('region', { name: zh ? '角色操作预览' : 'Role action preview' })).toBeVisible();
  expect(inputs[0]).toMatchObject({ operation: 'start_exit', pool_id: '1' }); expect(inputs[0].material_id).toBeUndefined();
  await page.screenshot({ path: `artifacts/remediation-20261104/investor-${language}.png`, fullPage: true });
  await ws.getByLabel(zh ? '操作的资金池编号' : 'Action pool ID').fill('2');
  await expect(ws.getByRole('region', { name: zh ? '角色操作预览' : 'Role action preview' })).toHaveCount(0);
  expect(await page.evaluate(() => window.roleCalls.some(name => /sendTransaction/u.test(name)))).toBe(false);
});
