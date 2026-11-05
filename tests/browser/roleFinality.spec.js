// Assessment 2026-11-05 F01/F02/F03 in the browser. A saved operation whose receipt failed but is not yet deep still blocks the
// wallet and says so (it is not shown as final), and the page looks again by itself until the server settles it. The task list
// names a draw that this wallet cannot send for want of the on-chain role, and a partly drawn pool still lists the rest of its
// principal as a task. Server responses are fixtures; no wallet sends anything.
import { test, expect } from '@playwright/test';
import { disclosureFixture } from '../helpers/disclosure.js';

const wallet = `0x${'12'.repeat(20)}`, subjectId = '11111111-1111-4111-8111-111111111111', planId = '66666666-6666-4666-8666-666666666666', materialId = '55555555-5555-4555-8555-555555555555';

for (const language of ['zh', 'en']) test(`role finality ${language}: a shallow failed receipt keeps blocking until it is final; wallet role and partial draw are named`, async ({ page }) => {
  test.setTimeout(60000);
  const zh = language === 'zh', pack = disclosureFixture();
  const config = { chainIdDecimal: 1439, protocolVersion: 5, controlVersion: 4, contracts: { RWAOfferingPool: pack.document.instance.pool }, abis: { RWAOfferingPool: [] } };
  await page.addInitScript(({ language, wallet }) => {
    localStorage.clear(); localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
    window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method }) => {
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [wallet];
      if (method === 'eth_chainId') return '0x59f';
      if (method === 'eth_signTypedData_v4') return `0x${'11'.repeat(65)}`;
      throw Error('No transaction authorized by UI fixture');
    } };
  }, { language, wallet });
  await page.route('**/api/demo/mode', (r) => r.fulfill({ json: { mode: 'live', demoMode: false, liveAvailable: true, generation: 4 } }));
  await page.route('**/api/controlled/status', (r) => r.fulfill({ json: { active: true, config, controller: pack.document.instance.controller } }));
  await page.route('**/api/controlled/positions?**', (r) => r.fulfill({ json: { positions: [], complete: true } }));
  await page.route('**/api/controlled/offerings**', (r) => r.fulfill({ json: { offerings: [], total_pools: 0, complete: true } }));
  const plan = { plan_id: planId, operation: 'disburse', chain_id: '1439', pool: pack.document.instance.pool, controller: pack.document.instance.controller, nonce: 7, current_instance: true, tx_hash: `0x${'ab'.repeat(32)}` };
  const looks = []; let settled = false;
  await page.route('**/api/rights/**', (r) => {
    const name = new URL(r.request().url()).pathname.slice('/api/rights/'.length), method = r.request().method(); let json;
    if (name === 'wallet-challenges') json = { challenge_id: subjectId, domain: { name: 'AgentBL Business Session', version: '1' }, types: { BusinessSession: [{ name: 'wallet', type: 'address' }] }, message: { wallet } };
    else if (name === 'sessions') json = { token: 'ab'.repeat(32), expires_at: Date.now() + 3600000, exit_only: false };
    else if (name.startsWith('me')) json = { organization: 'carrier', wallet, roles: ['operator'] };
    else if (name === 'materials') json = { materials: [{ material_id: materialId, revision: 1 }] };
    // Listed as confirming with a failed receipt until the server settles it; the page's own look settles it.
    else if (name === 'transaction-plans' && method === 'GET') json = { chain_id: '1439', plans: settled ? [] : [{ ...plan, status: 'confirming', receipt_status: 0 }], other_identities: [] };
    else if (name === `transaction-plans/${planId}` && method === 'GET') { looks.push(Date.now()); settled = true; json = { ...plan, status: 'reverted', receipt_status: 0 }; }
    else if (name.endsWith('/workflow')) json = { material_id: materialId, revision: 1, pool_id: 3, terms_hash: pack.terms_hash, document_hash: pack.terms.documentHash, disclosure: pack, approvals: 2, published: true,
      state: 'InTransit', snapshot: { block_number: 9, block_hash: `0x${'ab'.repeat(32)}` }, amounts: { raised_atomic: '8000000', disbursed_atomic: '1000000', undrawn_atomic: '7000000' }, steps: [
        { id: 'document', roles: ['issuer'], status: 'complete', phase: 'complete', assigned_to_you: false },
        { id: 'eligibility', roles: ['compliance'], status: 'not_applicable', phase: 'not_applicable', assigned_to_you: false },
        { id: 'draw', roles: ['operator'], status: 'partial', phase: 'actionable', next: 'disburse', assigned_to_you: true, caller_blocker: 'caller_role_missing', caller_role: 'operator', drawn_atomic: '1000000', remaining_atomic: '7000000' },
        { id: 'repay', roles: ['holder', 'operator'], status: 'pending', phase: 'actionable', next: 'repay', assigned_to_you: true },
        { id: 'exit', roles: ['investor'], status: 'check_refund_or_wait', phase: 'waiting', assigned_to_you: false }] };
    else json = { error: 'Unexpected fixture request' };
    return r.fulfill({ json });
  });
  await page.goto('/#/finance');
  const panel = page.locator('.controlled-panel');
  await panel.getByRole('button', { name: zh ? '打开工作台：身份验证与角色待办' : 'Open workspace: identity and role responsibilities', exact: true }).click();
  const ws = panel.getByRole('region', { name: zh ? '融资角色工作台' : 'Financing role workspace' });
  await ws.getByLabel(zh ? '管理员发放的业务身份编号' : 'Enrolled business identity ID').fill(subjectId);
  await ws.getByRole('button', { name: zh ? '用当前钱包验证角色' : 'Verify role with this wallet' }).click();

  // F01: found on login, and honest about what it is: failed so far, not yet final, still holding the wallet.
  const pending = ws.locator('.role-pending');
  await expect(pending).toContainText(planId);
  await expect(pending).toContainText(zh ? '回执显示失败' : 'failed receipt');
  await expect(pending).not.toContainText(zh ? '链上执行失败，状态未改变' : 'Reverted on chain');
  await expect(ws.getByRole('button', { name: zh ? '准备可读预览' : 'Prepare readable preview' })).toBeDisabled();

  // F02/F03 while it is open: the workflow names the wallet's missing role instead of offering the draw, and keeps the partial draw's remainder visible.
  await ws.getByLabel(zh ? '本组织材料' : 'Organization materials').selectOption(materialId);
  await expect(ws.locator('.role-next')).toContainText(zh ? '回款或有界处置' : 'Repayment or bounded resolution');
  await expect(ws.locator('.role-next')).not.toContainText(zh ? '固定收款人放款' : 'Disburse to fixed borrower');
  await expect(ws.locator('.role-blocked')).toContainText(zh ? '你登记了此角色，但当前钱包没有链上权限' : 'You are enrolled for this role, but this wallet does not hold the on-chain permission');
  await expect(ws.locator('.role-blocked')).toContainText(zh ? '剩余 7.000000 TEST_USDC' : '7.000000 TEST_USDC left');
  await expect(ws.locator('.role-step-list')).toContainText(zh ? '已部分放款，剩余本金仍可放款' : 'Partly drawn; the rest of the principal can still be drawn');

  // The page looks again without being asked; once the server says it is final the operation stops blocking.
  await expect(pending).toHaveCount(0, { timeout: 20000 });
  expect(looks.length).toBeGreaterThanOrEqual(1);
  await expect(ws.getByText(zh ? '链上执行失败，状态未改变' : 'Reverted on chain; nothing changed')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
