// Assessment 2026-11-05 (docs/full-project-assessment-2026-11-05.md): the three boundary probes of that report, replayed on a
// real local EVM with the real RightsService and workflow reader, now asserting the fixed outcomes.
//   F01 a failed receipt that is not yet deep keeps the plan open and the wallet blocked; a reorganisation that lets the very
//       same signed transaction succeed cannot be followed by a second draw. The local chain applies the testnet's
//       two-successor rule (the chain id 31337 decides at once by design); the reorganisation is an artificial snapshot
//       revert, not a claim about Injective, which has instant finality.
//   F02 a revoked valuer, a disallowed settlement asset and a wallet without the on-chain operator role are named, and the
//       draw is not offered as "you can do this now" while the controller would refuse it.
//   F03 a first draw leaves the step open while principal remains.
// Synthetic accounts only; Hardhat's public development mnemonic signs the raw transactions so the same bytes can be replayed.
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
import { materialWorkflow } from '../src/rights/workflow.js';
import { sendRightsPlan } from '../web/src/lib/rights.js';

const DEV_MNEMONIC = 'test test test test test test test test test test test junk';

describe('assessment 2026-11-05 sequences on a real local EVM', () => {
  let node, c, directory, service, operatorToken, operatorKey;
  const cleanup = [], env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') };
  before(async () => {
    node = await runHardhatNode(); c = await deployRightsRpc(node, { after(fn) { cleanup.push(fn); } });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-finality-'));
    service = new RightsService({ directory, env, chain: c.chain, getMode: () => 'live', getGeneration: () => 1 });
    const subject = await service.createSubject({ organization: 'finality-operator', wallet: c.operator.address, roles: ['operator'] });
    const challenge = await service.createChallenge(subject.subject_id);
    operatorToken = (await service.openSession({ challenge_id: challenge.challenge_id, signature: await c.operator.signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
    // The operator is the development account at index 6; its key signs raw transactions whose bytes can be replayed.
    operatorKey = ethers.HDNodeWallet.fromPhrase(DEV_MNEMONIC, '', "m/44'/60'/0'/0/6");
    assert.equal(operatorKey.address.toLowerCase(), c.operator.address.toLowerCase(), 'development account layout changed');
  });
  after(async () => {
    for (const fn of cleanup.reverse()) await fn();
    await stopHardhatNode(node);
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  /** A fully subscribed 8 TEST_USDC pool, so the raise is final and the operator may draw. */
  async function funded() {
    const issued = await c.issuance(); await c.send(c.registry.registerTitle(issued.issuance, issued.signature));
    const eblId = await c.registry.nextEblId() - 1n, offer = await c.offering(eblId, issued.issuance);
    await c.send(c.registry.connect(c.holder).pledge(eblId, c.pool.target, offer.hash, offer.terms.subscribeUntil, '0x'));
    await c.send(c.controller.connect(c.issuer).createControlledOffering(offer.terms, offer.valuation, offer.valuer, offer.signature));
    const poolId = String(await c.pool.nextPoolId() - 1n), now = await c.now();
    await c.send(c.controller.connect(c.compliance).refreshScreening(now + 86400n, c.fresh()));
    await c.send(c.controller.connect(c.compliance).setEligibility(c.investor.address, c.fresh(), c.fresh(), now + 300000n));
    await c.send(c.controller.connect(c.investor).acknowledgeTerms(poolId, offer.hash, 1, offer.terms.subscribeUntil));
    await c.send(c.usdc.mint(c.investor.address, 8000000n)); await c.send(c.usdc.connect(c.investor).approve(c.pool.target, 8000000n));
    await c.send(c.pool.connect(c.investor).subscribe(poolId, 10));
    return { ...offer, poolId, eblId };
  }
  const workflow = (offer, roles = ['operator']) => materialWorkflow(c.chain, { wallet: c.operator.address, roles },
    { material_id: 'finality-material', revision: 1, document_hash: offer.terms.documentHash, public_summary: { terms_hash: offer.hash } }, offer.pack, true, 2);
  const draw = async (offer, roles) => { const view = await workflow(offer, roles); assert.equal(view.warning, undefined); return view.steps.find((step) => step.id === 'draw'); };
  const drawInput = (offer, amount = '1000000') => ({ operation: 'disburse', pool_id: offer.poolId, amount_atomic: amount, evidence_hash: c.fresh() });
  const principal = () => ({ wallet: c.operator.address, roles: ['operator'] });
  const mine = async (blocks) => { for (let index = 0; index < blocks; index++) await c.provider.send('evm_mine', []); };
  const role = async (name, wallet, granted) => c.govern(c.controller, 'setRole', [await c.controller[name](), wallet, granted]);
  /** Sign the plan's call with the operator's key; the bytes are the same wherever they are replayed. */
  const sign = (plan) => operatorKey.signTransaction({ chainId: c.chainId, nonce: plan.nonce, to: plan.to, data: plan.calldata, value: 0, type: 0, gasPrice: ethers.parseUnits('2', 'gwei'), gasLimit: 500000 });
  /** Broadcast signed bytes; Hardhat reports a mined revert as an RPC error, so the receipt is what counts. */
  async function broadcast(raw) {
    try { await c.provider.broadcastTransaction(raw); } catch { /* the receipt below says what happened */ }
    return { hash: ethers.keccak256(raw), receipt: await c.provider.getTransactionReceipt(ethers.keccak256(raw)) };
  }
  /** The production 1439 rule on this 31337 chain: a receipt needs two successor blocks before anything rests on it. */
  const withTestnetDepth = async (work) => { c.chain.confirmationDepth = () => 2; try { return await work(); } finally { delete c.chain.confirmationDepth; } };

  it('F03 a first draw leaves the step open, shows what is left, and the next draw really is possible', async () => {
    const offer = await funded();
    assert.deepEqual([(await draw(offer)).phase, (await draw(offer)).status], ['actionable', 'pending']);
    await c.send(c.controller.connect(c.operator).disburse(offer.poolId, 1000000n, c.fresh()));
    const part = await draw(offer);
    assert.deepEqual([part.status, part.phase, part.next, part.drawn_atomic, part.remaining_atomic], ['partial', 'actionable', 'disburse', '1000000', '7000000']);
    assert.ok((await c.chain.prepare(principal(), drawInput(offer))).calldata, 'the preflight of another draw passes, as the step says');
    assert.equal((await workflow(offer)).amounts.undrawn_atomic, '7000000');
    await c.send(c.controller.connect(c.operator).disburse(offer.poolId, 7000000n, c.fresh()));
    const whole = await draw(offer);
    assert.deepEqual([whole.status, whole.phase, whole.next, whole.remaining_atomic], ['complete', 'complete', null, '0']);
    await assert.rejects(c.chain.prepare(principal(), drawInput(offer)), { code: 'rights_preflight_failed' });
  });

  it('F02 every source disburse() reads is named, and the draw returns once it is restored', async () => {
    const offer = await funded();
    assert.deepEqual([(await draw(offer)).phase, (await draw(offer)).blocker], ['actionable', undefined]);
    // The valuer's role is revoked through governance: the controller refuses, and so must the task list.
    await role('VALUER', c.valuer.address, false);
    const revoked = await draw(offer);
    assert.deepEqual([revoked.phase, revoked.blocker, revoked.blockers], ['blocked', 'valuer_inactive', ['valuer_inactive']]);
    await assert.rejects(c.chain.prepare(principal(), drawInput(offer)), { code: 'rights_preflight_failed' });
    await role('VALUER', c.valuer.address, true);
    assert.equal((await draw(offer)).phase, 'actionable');
    assert.ok((await c.chain.prepare(principal(), drawInput(offer))).calldata);
    // The settlement asset leaves the approved list.
    await c.govern(c.controller, 'setTestAsset', [await c.usdc.getAddress(), false]);
    assert.deepEqual([(await draw(offer)).phase, (await draw(offer)).blocker], ['blocked', 'asset_not_allowed']);
    await assert.rejects(c.chain.prepare(principal(), drawInput(offer)), { code: 'rights_preflight_failed' });
    await c.govern(c.controller, 'setTestAsset', [await c.usdc.getAddress(), true]);
    assert.equal((await draw(offer)).phase, 'actionable');
  });

  it('F02 an operator whose wallet lost the on-chain role is told so instead of being offered the draw', async () => {
    const offer = await funded();
    await role('OPERATOR', c.operator.address, false);
    const step = await draw(offer);
    assert.deepEqual([step.phase, step.assigned_to_you, step.caller_blocker, step.caller_role], ['actionable', true, 'caller_role_missing', 'operator']);
    await assert.rejects(c.chain.prepare(principal(), drawInput(offer)), { code: 'rights_preflight_failed' });
    await role('OPERATOR', c.operator.address, true);
    assert.equal((await draw(offer)).caller_blocker, undefined);
    assert.ok((await c.chain.prepare(principal(), drawInput(offer))).calldata);
  });

  it('F01 a failed receipt stays open until it is two blocks deep; only then does the retry go through', async () => {
    await withTestnetDepth(async () => {
      const offer = await funded();
      const first = await service.prepareTransaction(operatorToken, drawInput(offer));
      await service.checkpointPlan(operatorToken, first.plan_id);
      // The screening lapses between preparing and mining: the signed draw is mined with a real failed receipt.
      const raw = await sign(first);
      await c.advance(await c.controller.screeningValidUntil() + 1n);
      const { hash, receipt } = await broadcast(raw);
      assert.equal(receipt.status, 0, 'a mined revert');
      const attached = await service.attachTransaction(operatorToken, first.plan_id, hash);
      assert.deepEqual([attached.status, attached.receipt_status], ['confirming', 0], 'failed, but not yet final');
      assert.deepEqual((await service.listPendingPlans(operatorToken)).plans.map((plan) => [plan.plan_id, plan.status, plan.receipt_status]), [[first.plan_id, 'confirming', 0]]);
      // Compliance refreshes the screening (one successor so far); the retry is prepared on the next nonce but may not leave.
      await c.send(c.controller.connect(c.compliance).refreshScreening(await c.now() + 86400n, c.fresh()));
      const retry = await service.prepareTransaction(operatorToken, drawInput(offer));
      assert.equal(retry.nonce, first.nonce + 1);
      await assert.rejects(service.checkpointPlan(operatorToken, retry.plan_id), { code: 'rights_plan_reconcile_required' });
      assert.equal((await service.getPlan(operatorToken, first.plan_id)).status, 'confirming');
      // The second successor makes the failure final: the plan leaves the list and the retry is sent through the wallet adapter.
      await mine(1);
      assert.equal((await service.getPlan(operatorToken, first.plan_id)).status, 'reverted');
      assert.deepEqual((await service.listPendingPlans(operatorToken)).plans, []);
      await service.checkpointPlan(operatorToken, retry.plan_id);
      const sent = await sendRightsPlan(retry, { session: { signer: c.operator, address: c.operator.address }, ethersFn: async () => ethers,
        attachTransaction: (id, txHash) => service.attachTransaction(operatorToken, id, txHash) });
      // Freshly mined, the retry itself waits for its own two successors, by the same rule.
      assert.equal(sent.status, 'confirming');
      await mine(2);
      assert.equal((await service.getPlan(operatorToken, retry.plan_id)).status, 'confirmed');
      assert.deepEqual((await service.listPendingPlans(operatorToken)).plans, []);
      assert.equal(await c.pool.disbursedAtomic(offer.poolId), 1000000n, 'exactly one draw');
    });
  });

  it('F01 a short reorganisation that lets the same signed draw succeed never ends with two draws', async () => {
    await withTestnetDepth(async () => {
      const offer = await funded();
      const first = await service.prepareTransaction(operatorToken, drawInput(offer));
      await service.checkpointPlan(operatorToken, first.plan_id);
      const raw = await sign(first), forkPoint = await c.provider.send('evm_snapshot', []);
      await c.advance(await c.controller.screeningValidUntil() + 1n);
      const { hash, receipt } = await broadcast(raw);
      assert.equal(receipt.status, 0);
      assert.equal((await service.attachTransaction(operatorToken, first.plan_id, hash)).status, 'confirming');
      await c.send(c.controller.connect(c.compliance).refreshScreening(await c.now() + 86400n, c.fresh()));
      const retry = await service.prepareTransaction(operatorToken, drawInput(offer));
      await assert.rejects(service.checkpointPlan(operatorToken, retry.plan_id), { code: 'rights_plan_reconcile_required' });
      // The failed block is replaced (an artificial reorganisation). Before the fix the failure was already final and the retry
      // had been sent; now the original is merely reconciled, the retry still cannot go, and the original succeeds on the new branch.
      await c.provider.send('evm_revert', [forkPoint]);
      const reconciling = await service.getPlan(operatorToken, first.plan_id);
      assert.deepEqual([reconciling.status, reconciling.receipt_status], ['reconciling', null]);
      assert.equal((await service.listPendingPlans(operatorToken)).plans.length, 1, 'still blocking and still discoverable');
      await assert.rejects(service.checkpointPlan(operatorToken, retry.plan_id), (error) => error.status === 409);
      const replay = await broadcast(raw);
      assert.equal(replay.receipt.status, 1, 'the very same signed bytes succeed on the new branch');
      assert.equal((await service.getPlan(operatorToken, first.plan_id)).status, 'confirming');
      await mine(2);
      const settled = await service.getPlan(operatorToken, first.plan_id);
      assert.deepEqual([settled.status, settled.receipt_status], ['confirmed', 1]);
      assert.equal(await c.pool.disbursedAtomic(offer.poolId), 1000000n, 'one draw, not two');
    });
  });
});
