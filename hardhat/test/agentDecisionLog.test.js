import { expect } from 'chai';
import { ethers, send } from './helpers/protocol.js';
import { anchorLeaf, merkleTree } from '../../src/agent/runtime/anchorProof.js';
import { createAgentVersion } from '../../src/agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../../src/agent/runtime/config.js';
import { hashSnapshot } from '../../src/agent/decisionLogger.js';

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




});
