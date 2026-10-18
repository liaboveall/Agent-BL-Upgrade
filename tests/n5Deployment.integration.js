import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HDNodeWallet, ContractFactory } from 'ethers';
import { runHardhatNode, stopHardhatNode } from './helpers/ledgerTestHarness.js';
import { deployRightsRpc } from './helpers/rightsHarness.js';
import { prepareRightsCandidate } from '../scripts/prepare-rights-candidate.mjs';
import { executeCandidate, candidateSender } from '../scripts/lib/n5-deployment.mjs';
import { loadRightsChain } from '../src/rights/chain.js';
import { runCandidateFunding } from '../scripts/lib/n5-funding.mjs';

it('deploys a new instance against a shared hub, enforces delay, resumes canonically and never repeats an uncertain broadcast', async () => {
  const node = await runHardhatNode(); let c, directory;
  try {
    c = await deployRightsRpc(node, { after() {} });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-n5-deploy-'));
    const labels = ['governorA', 'governorB', 'governorC', 'issuer', 'holder', 'valuer', 'operator', 'attestor', 'compliance', 'disposer', 'reviewer', 'guardian', 'investor'];
    const signers = Object.fromEntries(labels.map((name, index) => [name, HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${index}`).connect(c.provider)]));
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
