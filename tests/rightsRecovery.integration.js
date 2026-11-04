// Assessment 2026-11-04 (artifacts/comprehensive-review-20261104): the failing sequences of its cross-layer probes,
// replayed on a real local EVM with the real RightsService and the browser's wallet adapter, now asserting the fixed
// outcomes. F01 pool-targeted operations reach the wallet; F02 a revoked identity settles its own saved operation and
// the wallet then sends under its new identity; F03 a move to another instance on the same chain keeps the old
// operation discoverable and recoverable; F05 a frozen raise is not listed as a draw task. Synthetic accounts only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as ethers from 'ethers';
import { runHardhatNode, stopHardhatNode } from './helpers/ledgerTestHarness.js';
import { deployRightsRpc } from './helpers/rightsHarness.js';
import { RightsService } from '../src/rights/service.js';
import { createDisclosure } from '../src/rights/disclosure.js';
import { hashOfferingTerms, VALUATION_TYPES } from '../src/rights/typedData.js';
import { materialWorkflow } from '../src/rights/workflow.js';
import { sendRightsPlan } from '../web/src/lib/rights.js';
import { fundsBreakdown } from '../web/src/lib/pool-funds.js';

describe('assessment 2026-11-04 sequences on a real local EVM', () => {
  let node, c, directory, service, investorToken, partialPool;
  const cleanup = [], env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') };
  before(async () => {
    node = await runHardhatNode(); c = await deployRightsRpc(node, { after(fn) { cleanup.push(fn); } });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-recovery-'));
    service = new RightsService({ directory, env, chain: c.chain, getMode: () => 'live', getGeneration: () => 1 });
    investorToken = await login(service, await service.createSubject({ organization: 'recovery-original', wallet: c.investor.address, roles: ['investor'] }), c.investor);
  });
  after(async () => {
    for (const fn of cleanup.reverse()) await fn();
    await stopHardhatNode(node);
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  async function login(rights, subject, wallet, exitOnly = false) {
    const challenge = await rights.createChallenge(subject.subject_id, { exitOnly });
    return (await rights.openSession({ challenge_id: challenge.challenge_id, signature: await wallet.signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
  }
  /** A controlled offering on instance `k` (default: the first), optionally with a lower minimum raise. */
  async function create(k = c, minRaise = '8000000') {
    const issued = await k.issuance(); await k.send(k.registry.registerTitle(issued.issuance, issued.signature));
    const eblId = await k.registry.nextEblId() - 1n, offer = await k.offering(eblId, issued.issuance);
    const { schema: _schema, policy: _policy, ...input } = offer.pack.document;
    const pack = createDisclosure({ ...input, terms: { ...input.terms, minRaise } });
    const terms = pack.terms, hash = hashOfferingTerms(k.chainId, k.controller.target, terms);
    const valuation = { ...offer.valuation, termsHash: hash };
    const signature = await k.valuer.signTypedData(k.domain, VALUATION_TYPES, valuation);
    await k.send(k.registry.connect(k.holder).pledge(eblId, k.pool.target, hash, terms.subscribeUntil, '0x'));
    await k.send(k.controller.connect(k.issuer).createControlledOffering(terms, valuation, k.valuer.address, signature));
    return { poolId: String(await k.pool.nextPoolId() - 1n), pack, terms, hash };
  }
  /** The browser's adapter with the server checkpoint and receipt binding in between, as the workspace calls it. */
  const send = (rights, token, signer, plan, checkpoint = (saved) => rights.checkpointPlan(token, saved.plan_id)) => sendRightsPlan(plan, {
    session: { signer, address: signer.address }, ethersFn: async () => ethers, beforeBroadcast: checkpoint,
    attachTransaction: (id, hash) => rights.attachTransaction(token, id, hash) });

  it('F01 closes a partial raise and retries a title release through the wallet adapter; a plan aimed elsewhere never reaches the wallet', async () => {
    const partial = await create(c, '4000000'), time = await c.now();
    await c.send(c.controller.connect(c.compliance).refreshScreening(time + 86400n, c.fresh()));
    await c.send(c.controller.connect(c.compliance).setEligibility(c.investor.address, c.fresh(), c.fresh(), time + 300000n));
    await c.send(c.controller.connect(c.investor).acknowledgeTerms(partial.poolId, partial.hash, 1, partial.terms.subscribeUntil));
    await c.send(c.usdc.mint(c.investor.address, 4000000n)); await c.send(c.usdc.connect(c.investor).approve(c.pool.target, 4000000n));
    await c.send(c.pool.connect(c.investor).subscribe(partial.poolId, 5));
    await c.advance(BigInt(partial.terms.subscribeUntil) + 1n);
    const plan = await service.prepareTransaction(investorToken, { operation: 'finalize_funding', pool_id: partial.poolId });
    assert.equal(plan.to.toLowerCase(), c.pool.target.toLowerCase());
    // The same plan sent to the controller, or calling another pool function, is refused before any checkpoint.
    let checkpoints = 0;
    const counting = (saved) => { checkpoints++; return service.checkpointPlan(investorToken, saved.plan_id); };
    await assert.rejects(send(service, investorToken, c.investor, { ...plan, to: c.controller.target }, counting), { code: 'RIGHTS_PROTOCOL_CHANGED' });
    await assert.rejects(send(service, investorToken, c.investor, { ...plan, calldata: c.pool.interface.encodeFunctionData('retryCollateralRelease', [partial.poolId]) }, counting),
      { code: 'RIGHTS_PROTOCOL_CHANGED' });
    await assert.rejects(sendRightsPlan(plan, { session: { signer: c.investor, address: c.investor.address }, ethersFn: async () => ethers,
      instance: { chainId: plan.chain_id, controller: c.outsider.address } }), { code: 'RIGHTS_INSTANCE_CHANGED' });
    assert.equal(checkpoints, 0);
    const closed = await send(service, investorToken, c.investor, plan, counting);
    assert.equal(closed.status, 'confirmed'); assert.equal(checkpoints, 1);
    assert.equal(await c.pool.fundingFinalized(partial.poolId), true);
    // A cancelled pool's release retry is a pool call too; on an already released title it is a confirmed no-op.
    const cancelled = await create();
    await c.lifecycle('cancelOffering', [cancelled.poolId, c.fresh()]);
    const retry = await service.prepareTransaction(investorToken, { operation: 'retry_collateral_release', pool_id: cancelled.poolId });
    assert.equal((await send(service, investorToken, c.investor, retry)).status, 'confirmed');
    partialPool = partial;
  });

  it('F05 a frozen raise shows the freeze as the reason nothing can be drawn, and after the draw deadline the principal exit as the task', async () => {
    const p = partialPool;
    await c.send(c.controller.connect(c.operator).applyPricingAction(p.poolId, 0, 4, c.fresh(), c.fresh()));
    const record = { material_id: 'synthetic-material', revision: 1, document_hash: p.terms.documentHash, public_summary: { terms_hash: p.hash } };
    const flow = async (roles, wallet) => materialWorkflow(c.chain, { wallet, roles }, record, p.pack, true, 2);
    const step = (result, id) => result.steps.find((item) => item.id === id);
    const frozen = await flow(['operator'], c.operator.address);
    assert.equal(frozen.state, 'Frozen'); assert.equal(frozen.state_notice, 'state_frozen'); assert.equal(frozen.warning, undefined);
    assert.deepEqual([step(frozen, 'fund').phase, step(frozen, 'draw').phase, step(frozen, 'draw').blocker], ['complete', 'blocked', 'state_frozen']);
    assert.deepEqual([step(frozen, 'repay').phase, step(frozen, 'repay').blocker], ['waiting', 'not_disbursed']);
    assert.deepEqual(frozen.steps.filter((item) => item.assigned_to_you && item.phase === 'actionable').map((item) => item.id), [], 'nothing is the operator\'s to do');
    await c.advance(BigInt(p.terms.disburseUntil) + 1n);
    const late = await flow(['investor'], c.investor.address);
    assert.deepEqual([step(late, 'draw').phase, step(late, 'draw').blocker, step(late, 'repay').phase], ['blocked', 'draw_deadline_passed', 'not_applicable']);
    assert.deepEqual([step(late, 'exit').phase, step(late, 'exit').next, step(late, 'exit').assigned_to_you], ['actionable', 'start_exit', true]);
    // The task is real: the investor's own start_exit closes the frozen, undrawn pool as repaid.
    const exit = await service.prepareTransaction(investorToken, { operation: 'start_exit', pool_id: p.poolId });
    assert.equal((await send(service, investorToken, c.investor, exit)).status, 'confirmed');
    assert.equal((await flow(['investor'], c.investor.address)).state, 'Repaid');
  });

  it('F02 a revoked identity settles its saved operation in an exit-only session; the same wallet then sends under its new identity', async () => {
    const compliance = await service.createSubject({ organization: 'recovery-original', wallet: c.compliance.address, roles: ['compliance'] });
    const token = await login(service, compliance, c.compliance);
    const screening = async () => ({ operation: 'refresh_screening', valid_until: String(await c.now() + 3600n), evidence_hash: c.fresh() });
    const old = await service.prepareTransaction(token, await screening());
    await service.checkpointPlan(token, old.plan_id);
    await service.revokeSubject(compliance.subject_id);
    const exit = await login(service, compliance, c.compliance, true);
    assert.deepEqual((await service.listPendingPlans(exit)).plans.map((plan) => plan.plan_id), [old.plan_id]);
    const replacement = await service.createSubject({ organization: 'recovery-new-organization', wallet: c.compliance.address, roles: ['compliance'] });
    const fresh = await login(service, replacement, c.compliance);
    assert.deepEqual((await service.listPendingPlans(fresh)).other_identities.map((identity) => [identity.organization, identity.revoked, identity.plans.length]),
      [['recovery-original', true, 1]]);
    const waiting = await service.prepareTransaction(fresh, await screening());
    const blocked = await service.checkpointPlan(fresh, waiting.plan_id).catch((error) => error);
    assert.equal(blocked.code, 'rights_plan_reconcile_required');
    assert.deepEqual(blocked.details.other_identities.map((identity) => identity.plan_ids), [[old.plan_id]]);
    assert.equal((await service.getPlan(exit, old.plan_id)).status, 'broadcast_prepared');
    assert.equal((await service.releasePlan(exit, old.plan_id)).status, 'released');
    const sent = await send(service, fresh, c.compliance, await service.prepareTransaction(fresh, await screening()));
    assert.equal(sent.status, 'confirmed');
    // The released operation reserved the same nonce; the confirmed send used it, so the old one can never be mined.
    assert.equal(sent.nonce, old.nonce);
    assert.equal((await service.getPlan(exit, old.plan_id)).status, 'superseded');
  });

  it('F03 after a move to another instance on the same chain the old operation is listed, released and superseded by the new send', async () => {
    const operator = await service.createSubject({ organization: 'recovery-operator', wallet: c.operator.address, roles: ['operator'] });
    const token = await login(service, operator, c.operator);
    const old = await service.prepareTransaction(token, { operation: 'cancel_offering', pool_id: (await create()).poolId, evidence_hash: c.fresh() });
    await service.checkpointPlan(token, old.plan_id);
    const c2 = await deployRightsRpc(node, { after(fn) { cleanup.push(fn); } });
    const moved = new RightsService({ directory, env, chain: c2.chain, getMode: () => 'live', getGeneration: () => 1 });
    const target = await create(c2);
    const listed = await moved.listPendingPlans(token);
    assert.deepEqual(listed.plans.map((plan) => [plan.plan_id, plan.current_instance, plan.pool.toLowerCase()]), [[old.plan_id, false, c.pool.target.toLowerCase()]]);
    const next = await moved.prepareTransaction(token, { operation: 'cancel_offering', pool_id: target.poolId, evidence_hash: c2.fresh() });
    const blocked = await moved.checkpointPlan(token, next.plan_id).catch((error) => error);
    assert.deepEqual([blocked.code, blocked.details.plan_ids], ['rights_plan_reconcile_required', [old.plan_id]]);
    assert.equal((await moved.getPlan(token, old.plan_id)).status, 'broadcast_prepared');
    assert.equal((await moved.releasePlan(token, old.plan_id)).status, 'released');
    const sent = await send(moved, token, c2.operator, await moved.prepareTransaction(token, { operation: 'cancel_offering', pool_id: target.poolId, evidence_hash: c2.fresh() }));
    assert.equal(sent.status, 'confirmed');
    assert.equal((await moved.getPlan(token, old.plan_id)).status, 'superseded');
    assert.deepEqual((await moved.listPendingPlans(token)).plans, []);
  });

  it('the funds breakdown of the pool detail matches the contract after a partial draw (P = 8, G = 10, L = 4)', async () => {
    const p = await create(), time = await c.now();
    await c.send(c.controller.connect(c.compliance).refreshScreening(time + 86400n, c.fresh()));
    await c.send(c.controller.connect(c.compliance).setEligibility(c.investor.address, c.fresh(), c.fresh(), time + 300000n));
    await c.send(c.controller.connect(c.investor).acknowledgeTerms(p.poolId, p.hash, 1, p.terms.subscribeUntil));
    await c.send(c.usdc.mint(c.investor.address, 8000000n)); await c.send(c.usdc.connect(c.investor).approve(c.pool.target, 8000000n));
    await c.send(c.pool.connect(c.investor).subscribe(p.poolId, 10));
    await c.send(c.controller.connect(c.operator).disburse(p.poolId, 4000000n, c.fresh()));
    const offer = await c.pool.offerings(p.poolId);
    const funds = fundsBreakdown({ state: 'Funded', raised_atomic: String(offer.raisedAtomic), disbursed_atomic: String(await c.pool.disbursedAtomic(p.poolId)),
      recovered_atomic: String(await c.pool.recoveredAtomic(p.poolId)), subscribed: String(offer.subscribed), redemption_per_share_atomic: String(offer.targetRedemptionValue),
      escrow_atomic: String(await c.pool.escrowed(p.poolId, c.usdc.target)) });
    assert.equal(funds.target, await c.pool.targetDistribution(p.poolId));
    assert.equal(funds.target, 9000000n);
    assert.equal(funds.outstanding, await c.pool.outstandingDebt(p.poolId));
    assert.deepEqual([funds.undrawn, funds.claimed], [4000000n, 0n]);
  });
});
