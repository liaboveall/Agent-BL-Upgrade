import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HDNodeWallet, Contract, ContractFactory } from 'ethers';
import { runHardhatNode, stopHardhatNode } from './helpers/ledgerTestHarness.js';
import { deployRightsRpc } from './helpers/rightsHarness.js';
import { prepareRightsCandidate } from '../scripts/prepare-rights-candidate.mjs';
import { executeCandidate, candidateSender } from '../scripts/lib/n5-deployment.mjs';
import { loadRightsChain } from '../src/rights/chain.js';
import { RightsService } from '../src/rights/service.js';
import { financingReview } from '../src/rights/financingReview.js';
import { acquireRuntimeLease } from '../src/ops/lease.js';
import { runCandidateFunding } from '../scripts/lib/n5-funding.mjs';
import { acceptancePlan, runAcceptance } from '../scripts/lib/n5-acceptance.mjs';
import { measureCandidateCapacity } from '../scripts/lib/n5-capacity.mjs';

it('deploys a new instance against a shared hub, enforces delay, resumes canonically and never repeats an uncertain broadcast', async () => {
  const node = await runHardhatNode(); let c, directory;
  try {
    c = await deployRightsRpc(node, { after() {} });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-n5-deploy-'));
    const labels = ['governorA', 'governorB', 'governorC', 'issuer', 'holder', 'valuer', 'operator', 'attestor', 'compliance', 'disposer', 'reviewer', 'guardian', 'investor'];
    const wallet = (index) => HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${index}`).connect(c.provider);
    const signers = Object.fromEntries(labels.map((name, index) => [name, wallet(index)]));
    const asset = JSON.parse(await fs.readFile('hardhat/artifacts/contracts/MockAuthorizationUSDC.sol/MockAuthorizationUSDC.json'));
    const settlement = await new ContractFactory(asset.abi, asset.bytecode, signers.governorA).deploy(); await settlement.waitForDeployment();
    const nonce = await c.provider.getTransactionCount(signers.governorA.address);
    const candidate = await prepareRightsCandidate({ instance_id: 'n5-integration', chain_id: 31337, governance: c.governance.target,
      hub: c.hub.target, deployer: signers.governorA.address, nonce });
    candidate.contracts.MockAuthorizationUSDC = settlement.target; candidate.rpc_url = node.url; candidate.artifacts.MockAuthorizationUSDC = asset;
    const before = await c.hub.registry(c.registry.target);
    let run = await executeCandidate({ directory, candidate, provider: c.provider, signers, action: 'prepare', confirmations: 1 });
    assert.equal(run.state.transactions.length, 33);
    assert.equal(run.state.active, false);
    const afterPreparation = await c.provider.getTransactionCount(signers.governorA.address);
    run = await executeCandidate({ directory, candidate, provider: c.provider, signers, action: 'prepare', confirmations: 1 });
    assert.equal(await c.provider.getTransactionCount(signers.governorA.address), afterPreparation, 'Resume must not repeat confirmed transactions');
    await assert.rejects(executeCandidate({ directory, candidate, provider: c.provider, signers, action: 'activate', confirmations: 1 }), /Governance delay/);
    await c.advance(BigInt(Math.max(...run.state.operations.map((op) => Number(op.eta)))));
    run = await executeCandidate({ directory, candidate, provider: c.provider, signers, action: 'activate', confirmations: 1 });
    assert.equal(run.state.transactions.length, 46); assert.equal(run.state.active, true);
    assert.equal(await c.hub.registry(c.registry.target), before, 'Predecessor enrollment is retained');
    const chain = await loadRightsChain(path.join(directory, 'rights-instance.json'));
    assert.equal((await chain.verify()).control_version, 2); assert.equal(await chain.controller.intakeStopped(), false); await chain.provider.destroy();
    const nonceBefore = await c.provider.getTransactionCount(signers.governorA.address);
    await executeCandidate({ directory, candidate, provider: c.provider, signers, action: 'activate', confirmations: 1 });
    assert.equal(await c.provider.getTransactionCount(signers.governorA.address), nonceBefore);
    const options = { ...run, directory, candidate, provider: c.provider, signers, rightsKey: 'ab'.repeat(32), poolCount: 3, advance: c.advance };
    const funded = await runCandidateFunding(options); assert.equal(funded.passed, true);
    const afterFunding = await c.provider.getTransactionCount(signers.governorA.address);
    assert.equal((await runCandidateFunding(options)).passed, true);
    assert.equal(await c.provider.getTransactionCount(signers.governorA.address), afterFunding, 'A second funding run must only reconcile original transactions');
    // Human acceptance preparation: two outside wallets act exactly as the acceptor would.
    const acceptors = [14, 15].map(wallet), iso = (seconds) => new Date(seconds * 1000).toISOString();
    const start = (await c.provider.getBlock('latest')).timestamp;
    const input = { schema: 'agentbl-n5-acceptance-input-v1', run: 'local', investors: acceptors.map((acceptor, index) => ({ label: ['A', 'B'][index], wallet: acceptor.address })),
      pools: { normal: { subscribe_until: iso(start + 7 * 86400) }, refund: { subscribe_until: iso(start + 3600) } }, screening_until: iso(start + 7200) };
    const acceptance = { ...options, input }, contract = (name) => new Contract(run.state.contracts[name], candidate.artifacts[name].abi, c.provider);
    const [controller, pool, usdc] = ['RightsController', 'RWAOfferingPoolV5', 'MockAuthorizationUSDC'].map(contract);
    const nonces = () => Promise.all(['governorA', 'issuer', 'holder', 'compliance', 'operator', 'attestor'].map((name) => c.provider.getTransactionCount(signers[name].address)));
    const reconcileOnly = async (stage) => {
      const before = await nonces(); await runAcceptance({ ...acceptance, stage });
      assert.deepEqual(await nonces(), before, `${stage} must only reconcile original transactions`);
    };
    const plan = await acceptancePlan({ state: run.state, candidate, provider: c.provider, input });
    assert.deepEqual(plan.pools.map((p) => p.expected_pool_id), [4, 5]);
    assert.ok(Object.values(plan.stages).flat().every((tx) => tx.status === 'NOT_SENT'));
    await assert.rejects(runAcceptance({ ...acceptance, input: { ...input, investors: [input.investors[0], { label: 'B', wallet: signers.investor.address }] }, stage: 'prepare' }), /research signer/u);
    const unlock = await acquireRuntimeLease(path.join(directory, 'application'));
    await assert.rejects(runAcceptance({ ...acceptance, stage: 'prepare' }), /Runtime is in use/u, 'A running application stays the only rights vault writer');
    await unlock();
    const gasBefore = await Promise.all(acceptors.map((acceptor) => c.provider.getBalance(acceptor.address)));
    const prepared = await runAcceptance({ ...acceptance, stage: 'prepare' });
    const [normal, refund] = ['normal', 'refund'].map((tag) => prepared.scenarios[tag].pool_id);
    assert.deepEqual([normal, refund], ['4', '5']);
    const verifier = await loadRightsChain(path.join(directory, 'rights-instance.json'));
    const vault = new RightsService({ directory: path.join(directory, 'application/rights'), env: { AGENTBL_RIGHTS_KEY: options.rightsKey } });
    for (const poolId of [normal, refund]) assert.equal((await financingReview(verifier, vault, poolId)).verification, 'canonical_chain_and_public_document');
    await verifier.provider.destroy();
    for (const [index, acceptor] of acceptors.entries()) {
      assert.equal(await usdc.balanceOf(acceptor.address), 10000000n);
      assert.equal(await c.provider.getBalance(acceptor.address) - gasBefore[index], 20000000000000000n);
      assert.equal((await controller.eligibility(acceptor.address)).validUntil, BigInt(prepared.scenarios.normal.pack.terms.disburseUntil));
      assert.match(prepared.investors[['A', 'B'][index]].subject_id, /^[a-f0-9-]{36}$/u);
    }
    await reconcileOnly('prepare');
    await assert.rejects(runAcceptance({ ...acceptance, input: { ...input, screening_until: iso(start + 2 * 86400) }, stage: 'screening' }), /24 hours/u);
    await runAcceptance({ ...acceptance, stage: 'screening' });
    assert.equal(await controller.screeningValidUntil(), BigInt(start + 7200));
    await assert.rejects(runAcceptance({ ...acceptance, stage: 'repay' }), /not fully subscribed/u);
    const subscribe = async (acceptor, poolId, shares) => {
      const [hash, quote, deadline] = await Promise.all([controller.termsHash(poolId), pool.quoteVersion(poolId), pool.subscriptionDeadline(poolId)]);
      await (await controller.connect(acceptor).acknowledgeTerms(poolId, hash, quote, deadline)).wait();
      await (await usdc.connect(acceptor).approve(pool.target, BigInt(shares) * 800000n)).wait();
      await (await pool.connect(acceptor).subscribeWithTerms(poolId, shares, 800000n, quote, deadline)).wait();
    };
    await subscribe(acceptors[0], normal, 5); await subscribe(acceptors[1], normal, 5); await subscribe(acceptors[0], refund, 3);
    assert.equal((await runAcceptance({ ...acceptance, stage: 'repay' })).scenarios.normal.settled, true);
    for (const acceptor of acceptors) {
      const before = await usdc.balanceOf(acceptor.address);
      await (await pool.connect(acceptor).claim(normal)).wait();
      assert.equal(await usdc.balanceOf(acceptor.address) - before, 5000000n, 'Each acceptor wallet claims its own allocation');
    }
    assert.equal(await pool.escrowed(normal, usdc.target), 0n);
    await reconcileOnly('repay');
    await c.advance(BigInt(prepared.scenarios.refund.pack.terms.subscribeUntil) + 1n);
    const beforeRefund = await usdc.balanceOf(acceptors[0].address);
    await (await pool.connect(acceptors[0]).refundInvestor(refund, acceptors[0].address)).wait();
    assert.equal(await usdc.balanceOf(acceptors[0].address) - beforeRefund, 2400000n);
    assert.equal(await pool.escrowed(refund, usdc.target), 0n);
    const settled = await acceptancePlan({ state: run.state, candidate, provider: c.provider, input });
    assert.ok(Object.values(settled.stages).flat().every((tx) => tx.status === 'CONFIRMED'));
    await assert.rejects(runAcceptance({ ...acceptance, input: { ...input, investors: [{ label: 'A', wallet: wallet(16).address }, input.investors[1]] }, stage: 'prepare' }), /another wallet/u);
    const insufficient = await measureCandidateCapacity({ manifest: path.join(directory, 'rights-instance.json'), directory: path.join(directory, 'insufficient-pools'), seconds: 1 });
    assert.equal(insufficient.chain_id, 31337); assert.equal(insufficient.public_testnet, false);
    assert.equal(insufficient.passed, false, 'Three pools cannot qualify as 25-pool capacity');
    const unresolvedDir = path.join(directory, 'uncertain'), state = { transactions: [] }, save = async () => {};
    let broadcasts = 0;
    const provider = new Proxy(c.provider, { get(target, key) {
      if (key === 'broadcastTransaction') return async (raw) => { broadcasts++; await target.broadcastTransaction(raw); throw new Error('Lost RPC response after acceptance'); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const sender = candidateSender({ directory: unresolvedDir, state, save, provider, chainId: 31337, confirmations: 1 });
    const request = { to: signers.governorB.address, value: 1n };
    await assert.rejects(sender('uncertain', signers.governorA, request), /Lost RPC response/);
    const recovered = await sender('uncertain', signers.governorA, request);
    assert.equal(recovered.status, 'CONFIRMED'); assert.equal(broadcasts, 1);
    await assert.rejects(sender('uncertain', signers.governorA, { ...request, value: 2n }), /payload differs/);
    const altered = structuredClone(candidate); altered.transactions[0].data += '00';
    await assert.rejects(executeCandidate({ directory, candidate: altered, provider: c.provider, signers, action: 'prepare', confirmations: 1 }), /candidate changed/);
  } finally {
    await c?.provider.destroy(); await stopHardhatNode(node);
    if (directory && path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(directory, { recursive: true, force: true });
  }
});
