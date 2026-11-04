// Assessment 2026-11-04 F02/F03/F05 in the browser: the role workspace lists only what a role can do now, says why a
// step waits or is blocked (a frozen pool is not a draw task), and recovers saved operations that block this wallet from
// an earlier instance or from another identity of the same wallet. Server responses are fixtures; no wallet sends.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { disclosureFixture } from '../helpers/disclosure.js';

const wallet = `0x${'12'.repeat(20)}`, current = '11111111-1111-4111-8111-111111111111', revoked = '22222222-2222-4222-8222-222222222222';
const oldPlan = '33333333-3333-4333-8333-333333333333', heldPlan = '44444444-4444-4444-8444-444444444444', materialId = '55555555-5555-4555-8555-555555555555';
const OLD_POOL = `0x${'77'.repeat(20)}`;

for (const language of ['zh', 'en']) for (const width of [1440, 390]) test(`role tasks ${language} ${width}: blocked reasons, earlier-instance and other-identity recovery`, async ({ page }) => {
  const zh = language === 'zh', pack = disclosureFixture();
  const config = { chainIdDecimal: 1439, protocolVersion: 5, controlVersion: 4, contracts: { RWAOfferingPool: pack.document.instance.pool }, abis: { RWAOfferingPool: [] } };
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ language, wallet }) => {
    localStorage.clear(); localStorage.setItem('ts_lang', language); localStorage.setItem('agentbl.walletType', 'metamask');
    window.roleCalls = [];
    window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method }) => {
      window.roleCalls.push(method);
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
  const challenges = [], released = new Set(); let session = null;
  await page.route('**/api/rights/**', (r) => {
    const name = new URL(r.request().url()).pathname.slice('/api/rights/'.length), method = r.request().method(); let json;
    if (name === 'wallet-challenges') { const body = r.request().postDataJSON(); challenges.push(body); session = body;
      json = { challenge_id: body.subject_id, domain: { name: 'AgentBL Business Session', version: '1' }, types: { BusinessSession: [{ name: 'wallet', type: 'address' }] }, message: { wallet } }; }
    else if (name === 'sessions') json = { token: (session.subject_id === revoked ? 'cd' : 'ab').repeat(32), expires_at: Date.now() + 3600000, exit_only: session.exit_only === true };
    else if (name.startsWith('me')) json = session.subject_id === revoked
      ? { organization: 'old-carrier', wallet, roles: [], exit_only: true } : { organization: 'new-carrier', wallet, roles: ['operator'] };
    else if (name === 'materials') json = { materials: [{ material_id: materialId, revision: 1 }] };
    else if (name === 'transaction-plans' && method === 'GET') json = session.subject_id === revoked
      ? { chain_id: '1439', plans: released.has(heldPlan) ? [] : [{ plan_id: heldPlan, status: 'broadcast_prepared', operation: 'refresh_screening', chain_id: '1439', pool: pack.document.instance.pool, nonce: 7, current_instance: true }], other_identities: [] }
      : { chain_id: '1439', plans: released.has(oldPlan) ? [] : [{ plan_id: oldPlan, status: 'broadcast_prepared', operation: 'cancel_offering', chain_id: '1439', pool: OLD_POOL, controller: `0x${'78'.repeat(20)}`, nonce: 6, current_instance: false }],
        other_identities: released.has(heldPlan) ? [] : [{ subject_id: revoked, organization: 'old-carrier', revoked: true, plans: [{ plan_id: heldPlan, status: 'broadcast_prepared', operation: 'refresh_screening', nonce: 7, current_instance: true }] }] };
    else if (name.endsWith('/release')) { const id = name.split('/')[1]; released.add(id); json = { plan_id: id, status: 'released' }; }
    else if (name.endsWith('/workflow')) json = { material_id: materialId, revision: 1, pool_id: 3, terms_hash: pack.terms_hash, document_hash: pack.terms.documentHash, disclosure: pack, approvals: 2, published: true,
      state: 'Frozen', state_notice: 'state_frozen', snapshot: { block_number: 9, block_hash: `0x${'ab'.repeat(32)}` }, steps: [
        { id: 'document', roles: ['issuer'], status: 'complete', phase: 'complete', assigned_to_you: false },
        { id: 'fund', roles: ['investor'], status: 'complete', phase: 'complete', assigned_to_you: false },
        { id: 'draw', roles: ['operator'], status: 'pending', phase: 'blocked', blocker: 'state_frozen', assigned_to_you: true },
        { id: 'repay', roles: ['holder', 'attestor', 'operator'], status: 'pending', phase: 'waiting', blocker: 'not_disbursed', assigned_to_you: true },
        { id: 'exit', roles: ['investor'], status: 'check_refund_or_wait', phase: 'waiting', assigned_to_you: false }] };
    else json = { error: 'Unexpected fixture request' };
    return r.fulfill({ json });
  });
  await page.goto('/#/finance');
  const panel = page.locator('.controlled-panel');
  await panel.getByRole('button', { name: zh ? '打开工作台：身份验证与角色待办' : 'Open workspace: identity and role responsibilities', exact: true }).click();
  const ws = panel.getByRole('region', { name: zh ? '融资角色工作台' : 'Financing role workspace' });
  await ws.getByLabel(zh ? '管理员发放的业务身份编号' : 'Enrolled business identity ID').fill(current);
  await ws.getByRole('button', { name: zh ? '用当前钱包验证角色' : 'Verify role with this wallet' }).click();
  // F03: the saved operation of an earlier instance is found without any local record, labelled, and recoverable here.
  const pending = ws.locator('.role-pending');
  await expect(pending).toContainText(oldPlan);
  await expect(pending).toContainText(zh ? '来自原协议实例' : 'From an earlier protocol instance');
  await expect(pending).toContainText(OLD_POOL);
  // F02: an operation saved by another identity of this wallet is named with that identity and a way in.
  const others = ws.locator('.role-other-identities');
  await expect(others).toContainText('old-carrier');
  await expect(others).toContainText(zh ? '已撤销' : 'revoked');
  // Nothing new can be prepared while any saved operation still holds this wallet's nonce.
  const prepare = ws.getByRole('button', { name: zh ? '准备可读预览' : 'Prepare readable preview' });
  await ws.getByLabel(zh ? '本次操作' : 'Next action').selectOption('cancel_offering');
  await ws.getByLabel(zh ? '操作的资金池编号' : 'Action pool ID').fill('3');
  await expect(prepare).toBeDisabled();
  await ws.getByRole('button', { name: zh ? '钱包没有发出，释放记录' : 'The wallet sent nothing: release' }).click();
  await expect(pending).toHaveCount(0);
  await expect(prepare).toBeDisabled();
  // F05: a frozen pool's draw is a blocked step with its reason, never "your next step".
  await ws.getByLabel(zh ? '本组织材料' : 'Organization materials').selectOption(materialId);
  await expect(ws.locator('.role-state-notice')).toContainText(zh ? '资金池已冻结' : 'The pool is frozen');
  await expect(ws.locator('.role-next')).toContainText(zh ? '当前没有你现在可做的步骤' : 'Nothing is yours to do right now');
  await expect(ws.locator('.role-blocked')).toContainText(zh ? '固定收款人放款：资金池已冻结' : 'Disburse to fixed borrower: The pool is frozen');
  await expect(ws.locator('.role-waiting')).toContainText(zh ? '尚未放款' : 'Nothing has been drawn');
  if (width === 1440) expect((await new AxeBuilder({ page }).include('.role-workspace').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Switching to the revoked identity opens an exit-only session, which finds and releases its own operation.
  await others.getByRole('button', { name: zh ? '以该身份仅验证退出并核对' : 'Sign in as that identity (exits only) to reconcile' }).click();
  await expect(ws).toContainText(zh ? '仅退出会话' : 'Exit-only session');
  expect(challenges.at(-1)).toMatchObject({ subject_id: revoked, exit_only: true });
  await expect(ws.locator('.role-pending')).toContainText(heldPlan);
  await ws.getByRole('button', { name: zh ? '钱包没有发出，释放记录' : 'The wallet sent nothing: release' }).click();
  await expect(ws.locator('.role-pending')).toHaveCount(0);
  expect(await page.evaluate(() => window.roleCalls.some((name) => /sendTransaction/u.test(name)))).toBe(false);
});
