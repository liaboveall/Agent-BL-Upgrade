import { expect } from 'chai';
import hre from 'hardhat';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ethers, send } from './helpers/protocol.js';
import { anchorLeaf, merkleTree } from '../../src/agent/runtime/anchorProof.js';
import { createAgentVersion } from '../../src/agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../../src/agent/runtime/config.js';
import { hashSnapshot } from '../../src/agent/decisionLogger.js';
import { deployAgentLog } from '../../scripts/lib/deploy-agent-log.mjs';
import { createOwnerJournal } from '../../scripts/lib/owner-journal.mjs';
import chainConfig from '../../scripts/lib/chain-config.cjs';
import { verifyDeployment } from '../../scripts/verify-bytecode.mjs';

const version = createAgentVersion(loadAgentConfig({}), {}, hashSnapshot('test-source'));
const args = [version.version_id, version.policy_hash, version.code_commit, version.model_id];
const root = ethers.id('root');
async function fixture() {
  const [owner, anchorer, stranger] = await ethers.getSigners();
  const factory = await ethers.getContractFactory('AgentDecisionLog');
  const log = await factory.deploy(); await log.waitForDeployment();
  return { owner, anchorer, stranger, log };
}
async function initialized() {
  const ctx = await fixture();
  await send(ctx.log.registerAgentVersion(...args)); await send(ctx.log.setAnchorer(ctx.anchorer.address, true));
  return { ...ctx, signed: ctx.log.connect(ctx.anchorer) };
}

describe('AgentDecisionLog append-only decision commitments', () => {
  it('only the owner registers immutable versions and role permissions', async () => {
    const { log, stranger, anchorer } = await fixture();
    await expect(log.connect(stranger).registerAgentVersion(...args)).to.be.revertedWith('not owner');
    await expect(log.connect(stranger).setAnchorer(anchorer.address, true)).to.be.revertedWith('not owner');
    await expect(log.registerAgentVersion(...args)).to.emit(log, 'AgentVersionRegistered').withArgs(...args);
    await expect(log.registerAgentVersion(...args)).to.be.revertedWith('version exists');
    const registered = await log.versions(version.version_id);
    expect(registered.policyHash).to.equal(version.policy_hash); expect(registered.modelId).to.equal(version.model_id);
  });

  it('rejects empty version metadata, zero role addresses and unknown versions', async () => {
    const { log, anchorer } = await fixture();
    await expect(log.registerAgentVersion(ethers.ZeroHash, ...args.slice(1))).to.be.revertedWith('empty commitment');
    await expect(log.registerAgentVersion(args[0], ethers.ZeroHash, args[2], args[3])).to.be.revertedWith('empty commitment');
    await expect(log.registerAgentVersion(args[0], args[1], args[2], '')).to.be.revertedWith('invalid model');
    await expect(log.registerAgentVersion(args[0], args[1], args[2], 'x'.repeat(129))).to.be.revertedWith('invalid model');
    await expect(log.setAnchorer(ethers.ZeroAddress, true)).to.be.revertedWith('anchorer=0');
    await send(log.setAnchorer(anchorer.address, true));
    await expect(log.connect(anchorer).anchorBatch(root, 1, 1, 1, args[0])).to.be.revertedWith('unknown version');
  });

  it('requires the explicit anchorer role, including for the owner, and permits revocation', async () => {
    const { log, anchorer, signed, stranger } = await initialized();
    for (const caller of [log, log.connect(stranger)]) await expect(caller.anchorBatch(root, 1, 1, 1, args[0])).to.be.revertedWith('not anchorer');
    await expect(log.setAnchorer(anchorer.address, false)).to.emit(log, 'AnchorerSet').withArgs(anchorer.address, false);
    await expect(signed.anchorBatch(root, 1, 1, 1, args[0])).to.be.revertedWith('not anchorer');
  });

  it('commits exact continuous ranges and events without duplicate or skipped sequences', async () => {
    const { log, anchorer, signed } = await initialized();
    await expect(signed.anchorBatch(root, 1, 3, 3, args[0])).to.emit(log, 'DecisionBatchAnchored').withArgs(1, root, 1, 3, 3, args[0], anchorer.address);
    expect(await log.lastSeq()).to.equal(3); expect(await log.batchCount()).to.equal(1);
    const batch = await log.batches(1); expect(batch.count).to.equal(3); expect(batch.anchorer).to.equal(anchorer.address);
    for (const from of [1, 3, 5]) await expect(signed.anchorBatch(root, from, from, 1, args[0])).to.be.revertedWith('sequence gap');
    await send(signed.anchorBatch(ethers.id('second-root'), 4, 4, 1, args[0])); expect(await log.lastSeq()).to.equal(4);
  });

  it('rejects empty roots, mismatched counts, reversed ranges and batches over 256', async () => {
    const { signed } = await initialized();
    await expect(signed.anchorBatch(ethers.ZeroHash, 1, 1, 1, args[0])).to.be.revertedWith('empty root');
    for (const [to, count] of [[0, 0], [1, 0], [2, 1], [257, 257]]) await expect(signed.anchorBatch(root, 1, to, count, args[0])).to.be.revertedWith('invalid range');
  });

  for (const count of [1, 3, 256]) it(`verifies JavaScript-generated proofs on the real local contract (${count} leaves)`, async () => {
    const { log, signed } = await initialized();
    const leaves = Array.from({ length: count }, (_, i) => anchorLeaf({ schema: 'contract-interoperability', seq: i + 1 }));
    const tree = merkleTree(leaves); await send(signed.anchorBatch(tree.root, 1, count, count, args[0]));
    for (const i of [...new Set([0, Math.floor(count / 2), count - 1])]) expect(await log.verifyInclusion(1, leaves[i], tree.proofs[i])).to.equal(true);
    expect(await log.verifyInclusion(1, ethers.id('tamper'), tree.proofs[0])).to.equal(false);
    expect(await log.verifyInclusion(0, leaves[0], tree.proofs[0])).to.equal(false);
    expect(await log.verifyInclusion(2, leaves[0], tree.proofs[0])).to.equal(false);
    expect(await log.verifyInclusion(1, leaves[0], Array(9).fill(ethers.ZeroHash))).to.equal(false);
  });

  it('ownership transfer preserves batch history and does not implicitly grant the new owner an anchorer role', async () => {
    const { owner, stranger, log, signed } = await initialized();
    await send(signed.anchorBatch(root, 1, 1, 1, args[0]));
    await send(log.transferOwnership(stranger.address)); await send(log.connect(stranger).acceptOwnership());
    expect(await log.owner()).to.equal(stranger.address); expect((await log.batches(1)).merkleRoot).to.equal(root);
    await expect(log.connect(owner).setAnchorer(owner.address, true)).to.be.revertedWith('not owner');
    await expect(log.connect(stranger).anchorBatch(root, 2, 2, 1, args[0])).to.be.revertedWith('not anchorer');
  });

  it('deployment defaults to zero broadcasts and needs no signer, network, keys or filesystem', async () => {
    const plan = { schema: 'agentbl-anchor-deployment-plan-v1', chain_id: 1439, versions: [version] };
    const result = await deployAgentLog({ plan });
    expect(result.dry_run).to.equal(true); expect(result.broadcasts).to.equal(0);
  });

  it('deploys and initializes locally, merges only the new contract, verifies bytecode and resumes without retransmission', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-log-deploy-'));
    try {
      const [owner, anchorer] = await ethers.getSigners();
      const artifact = await hre.artifacts.readArtifact('AgentDecisionLog');
      const configPath = path.join(dir, 'chain-config.json');
      const original = chainConfig.migrateLegacy({}); original.networks['injective-testnet'].contracts.Legacy = owner.address;
      original.networks['injective-testnet'].abis.Legacy = []; original.networks['injective-testnet'].deployments.Legacy = { retained: true };
      await fs.writeFile(configPath, JSON.stringify(original));
      const options = { confirmed: true, plan: { schema: 'agentbl-anchor-deployment-plan-v1', chain_id: 1439, versions: [version] },
        owner, anchorer: anchorer.address, provider: ethers.provider, artifact, journal: createOwnerJournal(dir), configPath, expectedChainId: 31337 };
      const first = await deployAgentLog(options); expect(first.broadcasts).to.equal(3);
      const merged = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(merged.networks['injective-testnet'].contracts.Legacy).to.equal(owner.address);
      expect(merged.networks['injective-testnet'].deployments.Legacy).to.deep.equal({ retained: true });
      expect(merged.networks['injective-mainnet']).to.deep.equal(original.networks['injective-mainnet']);
      const report = await verifyDeployment({ configPath, getCode: async (_urls, _method, [address]) => ethers.provider.getCode(address) });
      expect(report.results.find((entry) => entry.name === 'AgentDecisionLog').status).to.equal('MATCH');
      const second = await deployAgentLog(options); expect(second.broadcasts).to.equal(0); expect(second.address).to.equal(first.address);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
