import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { runHardhatNode, stopHardhatNode } from './helpers/ledgerTestHarness.js';
import { deployRightsRpc } from './helpers/rightsHarness.js';
import { listen, requestJson } from './helpers/http.js';
import { RightsService } from '../src/rights/service.js';
import { createRightsRoutes } from '../src/app/rightsRoutes.js';
import { sendError } from '../src/app/http.js';
import { sendRightsPlan } from '../web/src/lib/rights.js';
import { loadRightsChain } from '../src/rights/chain.js';

async function backend(c, t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'w3-cross-')), env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex'), AGENTBL_ADMIN_TOKEN: 'synthetic-cross-layer-admin-w3' };
  const service = new RightsService({ directory, env, chain: c.chain });
  const route = createRightsRoutes({ service, env });
  const app = await listen(http.createServer((req, res) => route(req, res, new URL(req.url, 'http://local')).catch((error) => sendError(res, error, { logger: { warn() {}, error() {} } }))));
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const post = async (url, body, token, admin = false) => {
    const result = await requestJson(app.base, 'POST', `/api/rights/${url}`, body, { ...(token ? { 'x-rights-session': token } : {}), ...(admin ? { Authorization: `Bearer ${env.AGENTBL_ADMIN_TOKEN}` } : {}) });
    if (result.status !== 200) throw Object.assign(new Error(result.data?.error), { status: result.status, code: result.data?.code });
    return result.data;
  };
  const login = async (wallet, roles, organization = 'w3-demo-carrier') => {
    const subject = await post('subjects', { organization, wallet: wallet.address, roles }, null, true);
    const challenge = await post('session-challenges', { subject_id: subject.subject_id }, null, true);
    const session = await post('sessions', { challenge_id: challenge.challenge_id, signature: await wallet.signTypedData(challenge.domain, challenge.types, challenge.message) });
    return { ...session, wallet };
  };
  const plan = (session, body) => post('transaction-plans', body, session.token);
  const execute = (session, prepared) => sendRightsPlan(prepared, { session: { signer: session.wallet, address: session.wallet.address },
    attachTransaction: (planId, txHash) => post(`transaction-plans/${planId}/transaction`, { tx_hash: txHash }, session.token) });
  return { directory, env, service, app, post, login, plan, execute };
}

describe('W3 actual EVM + business-session HTTP + wallet plans', { skip: process.env.AGENTBL_W3_INTEGRATION !== '1' }, () => {
  let node;
  before(async () => { node = await runHardhatNode(); });
  after(async () => { await stopHardhatNode(node); });
  it('walks trusted issuance, private disclosure approval, holder pledge, investor terms, cash flow and claim', async (t) => {
    const c = await deployRightsRpc(node, t), app = await backend(c, t);
    const issuer = await app.login(c.issuer, ['issuer']), holder = await app.login(c.holder, ['holder']), investor = await app.login(c.investor, ['investor']);
    const reviewerA = await app.login(c.reviewer, ['reviewer']), reviewerB = await app.login(c.memberC, ['reviewer']), operator = await app.login(c.operator, ['custodian']);
    // The private document commitment is fixed before the on-chain issuance.
    const provisional = await c.issuance();
    const eblId = await c.registry.nextEblId(), proposed = await c.offering(eblId, provisional.issuance);
    const material = await app.post('materials', { material: { exporter: 'private simulated exporter', document: 'W3 confidential bill' },
      public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 3, terms_hash: proposed.hash, risk_flags: ['simulated_title', 'test_asset'] } }, issuer.token);
    // Rebind the full terms and issuance to the actual salted material commitment.
    const issue = await c.issuance(material.document_hash), offer = await c.offering(eblId, issue.issuance);
    const recordId = material.material_id;
    const registerPlan = await app.plan(issuer, { operation: 'register_title', payload: issue });
    const receipt = await app.execute(issuer, registerPlan); assert.equal(receipt.status, 'confirmed');
    assert.equal(await c.registry.holderOf(eblId), c.holder.address);
    const pledgePlan = await app.plan(holder, { operation: 'pledge', payload: { ebl_id: String(eblId) }, terms_hash: offer.hash, valid_until: offer.terms.subscribeUntil });
    await app.execute(holder, pledgePlan);
    await assert.rejects(app.plan(issuer, { operation: 'create_offering', material_id: recordId, payload: offer }), { code: 'rights_approved_disclosure_required' });
    // The source record can bind final terms through an audited, approval-resetting amendment.
    await app.post(`materials/${recordId}/terms`, { terms_hash: offer.hash }, issuer.token);
    for (const reviewer of [reviewerA, reviewerB]) await app.post(`materials/${recordId}/review`, { document_hash: material.document_hash, terms_hash: offer.hash }, reviewer.token);
    const publication = await app.post(`materials/${recordId}/publish`, {}, issuer.token);
    assert.equal(JSON.stringify(publication).includes('confidential'), false);
    const creation = await app.plan(issuer, { operation: 'create_offering', material_id: recordId, payload: offer });
    await app.execute(issuer, creation);
    const poolId = String(await c.pool.nextPoolId() - 1n);
    await assert.rejects(c.pool.connect(c.investor).subscribe(poolId, 10));
    const time = await c.now();
    await c.send(c.controller.connect(c.compliance).setEligibility(c.investor.address, c.fresh(), c.fresh(), time + 100000n));
    await c.send(c.controller.connect(c.compliance).refreshScreening(time + 80000n, c.fresh()));
    const acceptance = await app.plan(investor, { operation: 'acknowledge_terms', pool_id: poolId, terms_hash: offer.hash, quote_version: '1', valid_until: offer.terms.subscribeUntil });
    await app.execute(investor, acceptance);
    await c.send(c.usdc.mint(c.investor.address, 8000000n)); await c.send(c.usdc.connect(c.investor).approve(await c.pool.getAddress(), 8000000n));
    await c.send(c.pool.connect(c.investor).subscribeWithTerms(poolId, 10, 800000, 1, offer.terms.subscribeUntil));
    const draw = await app.plan(operator, { operation: 'disburse', pool_id: poolId, amount_atomic: '8000000', evidence_hash: c.fresh() });
    await app.execute(operator, draw); assert.equal(await c.usdc.balanceOf(c.holder.address), 8000000n);
    await c.send(c.usdc.mint(c.holder.address, 2000000n)); await c.send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), 10000000n));
    await c.send(c.pool.connect(c.holder).repay(poolId, 10000000n));
    await c.lifecycle('recordImporterPayment', [poolId, c.fresh(), 10000000n]); await c.lifecycle('recordCargoArrival', [poolId, c.fresh()]); await c.lifecycle('settle', [poolId, 10000000n]);
    await c.send(c.controller.connect(c.guardian).setIntakeStopped(true, c.fresh()));
    await c.send(c.pool.connect(c.investor).claim(poolId));
    assert.equal(await c.usdc.balanceOf(c.investor.address), 10000000n);
    const chainTx = await c.provider.getTransaction(receipt.tx_hash);
    for (const secret of ['W3 confidential bill', 'private simulated exporter']) assert.equal(chainTx.data.includes(Buffer.from(secret).toString('hex')), false);
  });
  it('rejects wrong-wallet and wrong-calldata receipts and reconciles saved broadcast without sending again', async (t) => {
    const c = await deployRightsRpc(node, t), app = await backend(c, t), issuer = await app.login(c.issuer, ['issuer']);
    const issue = await c.issuance(), plan = await app.plan(issuer, { operation: 'register_title', payload: issue });
    await assert.rejects(sendRightsPlan(plan, { session: { signer: c.outsider, address: c.outsider.address } }), { code: 'RIGHTS_PLAN_MISMATCH' });
    const count = await c.provider.getTransactionCount(c.issuer.address);
    // Crash after broadcast is simulated by omitting attach; recover read-only using the saved exact plan.
    const tx = await c.issuer.sendTransaction({ to: plan.to, data: plan.calldata, nonce: plan.nonce }); await tx.wait();
    const unrelated = await c.send(c.outsider.sendTransaction({ to: c.holder.address, value: 0n }));
    await assert.rejects(app.post(`transaction-plans/${plan.plan_id}/transaction`, { tx_hash: unrelated.hash }, issuer.token), { code: 'rights_transaction_mismatch' });
    const restored = new RightsService({ directory: app.directory, env: app.env, chain: c.chain });
    const result = await restored.getPlan(issuer.token, plan.plan_id);
    assert.equal(result.status, 'confirmed'); assert.equal((await restored.getPlan(issuer.token, plan.plan_id)).tx_hash, tx.hash);
    assert.equal(await c.provider.getTransactionCount(c.issuer.address), count + 1);
    await assert.rejects(app.execute(issuer, result), { code: 'RIGHTS_PLAN_MISMATCH' });
  });
  it('verifies manifest artifacts, refuses code/network tampering, and preserves receipt reorg failures', async (t) => {
    const c = await deployRightsRpc(node, t), app = await backend(c, t), issuer = await app.login(c.issuer, ['issuer']);
    const contracts = Object.fromEntries(await Promise.all(['RightsGovernance', 'CommittedEBLRegistry', 'RightsController', 'ControlledRWAToken', 'RWAOfferingPoolV5'].map(async (name) => [name,
      await ({ RightsGovernance: c.governance, CommittedEBLRegistry: c.registry, RightsController: c.controller, ControlledRWAToken: c.token, RWAOfferingPoolV5: c.pool })[name].getAddress()])));
    const file = path.join(app.directory, 'instance.json');
    await fs.writeFile(file, JSON.stringify({ schema: 'agentbl-rights-instance-v1', scope: 'research_test_assets_only', rpc_url: node.url, chain_id: String(c.chainId), contracts }));
    const loaded = await loadRightsChain(file); t.after(() => loaded.provider.destroy());
    assert.equal((await loaded.verify()).control_version, 1);
    const expected = c.chain.chainId; c.chain.chainId = 1;
    await assert.rejects(c.chain.verify(), { code: 'rights_network_mismatch' }); c.chain.chainId = expected;
    const issue = await c.issuance(), plan = await app.plan(issuer, { operation: 'register_title', payload: issue });
    const snapshot = await c.provider.send('evm_snapshot', []);
    const sent = await app.execute(issuer, plan); assert.equal(sent.status, 'confirmed');
    await c.provider.send('evm_revert', [snapshot]); await c.provider.send('evm_mine', []);
    const afterReorg = await app.service.getPlan(issuer.token, plan.plan_id);
    assert.equal(afterReorg.status, 'reconciling'); assert.equal(afterReorg.tx_hash, sent.tx_hash);
    assert.equal(afterReorg.receipt_history[0].block_hash, sent.block_hash);
    // A getter-compatible configuration is insufficient: every runtime must match this build.
    const governanceCode = await c.provider.getCode(await c.governance.getAddress());
    const altered = governanceCode.slice(0, -2) + (governanceCode.endsWith('00') ? '01' : '00');
    await c.provider.send('hardhat_setCode', [await c.governance.getAddress(), altered]);
    await assert.rejects(loaded.verify(), { code: 'rights_bytecode_mismatch' });
  });
});
