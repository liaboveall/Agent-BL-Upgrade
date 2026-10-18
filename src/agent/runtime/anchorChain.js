import { Contract, JsonRpcProvider } from 'ethers';

export const AGENT_LOG_ABI = [
  'function anchorers(address) view returns (bool)',
  'function batchCount() view returns (uint256)',
  'function lastSeq() view returns (uint256)',
  'function versions(bytes32) view returns (bytes32 policyHash, bytes32 codeCommit, string modelId, uint256 registeredAt)',
  'function batches(uint256) view returns (bytes32 merkleRoot, uint256 fromSeq, uint256 toSeq, uint256 count, bytes32 versionId, address anchorer, uint256 anchoredAt)',
  'function anchorBatch(bytes32,uint256,uint256,uint256,bytes32)',
  'function verifyInclusion(uint256,bytes32,bytes32[]) view returns (bool)',
  'event DecisionBatchAnchored(uint256 indexed batchId, bytes32 indexed merkleRoot, uint256 fromSeq, uint256 toSeq, uint256 count, bytes32 indexed versionId, address anchorer)'
];
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const matches = (chain, batch) => equal(chain.merkleRoot, batch.merkle_root) && Number(chain.fromSeq) === batch.from_seq
  && Number(chain.toSeq) === batch.to_seq && Number(chain.count) === batch.count && equal(chain.versionId, batch.version_id);

export function createAnchorChainAdapter({ chainConfig, getContext, runExclusive = (task) => task(), confirmations = 1, allowedChainIds = [1439] }) {
  const address = chainConfig?.contracts?.AgentDecisionLog;
  const context = async (batch = null) => {
    if (!/^0x[0-9a-fA-F]{40}$/u.test(address ?? '') || !chainConfig?.deployments?.AgentDecisionLog?.deployTx) throw new Error('AgentDecisionLog has no deployment record');
    const ctx = await getContext();
    const chainId = Number(await ctx.provider.send('eth_chainId', []));
    if (!allowedChainIds.includes(chainId) || chainId !== Number(chainConfig.chainIdDecimal)) throw new Error('Anchor network mismatch');
    if (batch && (batch.chain_id !== chainId || !equal(batch.contract_address, address))) throw new Error('Anchor deployment binding changed');
    if (await ctx.provider.getCode(address) === '0x') throw new Error('Anchor contract is not deployed');
    return { ...ctx, log: ctx.decisionLog ?? new Contract(address, AGENT_LOG_ABI, ctx.provider), chainId };
  };
  const adapter = {
    async prepare(batch, version) {
      const ctx = await context();
      if (!ctx.signers?.ANCHORER || !await ctx.log.anchorers(ctx.signers.ANCHORER)) throw new Error('Dedicated ANCHORER is not an anchorer');
      const registered = await ctx.log.versions(batch.version_id);
      if (!registered.registeredAt || !equal(registered.policyHash, version.policy_hash) || !equal(registered.codeCommit, version.code_commit)
        || registered.modelId !== version.model_id) throw new Error('Agent version is not registered with matching metadata');
      const lastSeq = Number(await ctx.log.lastSeq()), batchCount = Number(await ctx.log.batchCount());
      if (lastSeq + 1 !== batch.from_seq || batchCount + 1 !== batch.batch_id) throw new Error('Anchor sequence conflicts with chain state');
      return { chain_id: ctx.chainId, contract_address: address, from_block: await ctx.provider.getBlockNumber(), anchorer: ctx.signers.ANCHORER };
    },
    async send(batch, assertCurrent, onSubmitted) {
      return runExclusive(async () => {
        const ctx = await context(batch);
        if (!equal(ctx.signers?.ANCHORER, batch.anchorer)) throw new Error('Anchor signer changed');
        const args = [batch.merkle_root, batch.from_seq, batch.to_seq, batch.count, batch.version_id];
        await ctx.log.anchorBatch.staticCall(...args);
        assertCurrent();
        const tx = await ctx.log.anchorBatch(...args);
        await onSubmitted?.(tx);
        // Keep nonce ownership through the first receipt attempt; later polling is read-only.
        await tx.wait(confirmations, 30_000).catch(() => {});
        return { hash: tx.hash };
      });
    },
    async locate(batch) {
      const ctx = await context(batch);
      const latest = await ctx.provider.getBlockNumber();
      if (latest - batch.from_block > 50_000) throw new Error('Anchor recovery exceeds the bounded scan; operator reconciliation required');
      const events = await ctx.log.queryFilter(ctx.log.filters.DecisionBatchAnchored(batch.batch_id), batch.from_block, latest);
      const found = events.filter((event) => matches(event.args, batch) && equal(event.args.anchorer, batch.anchorer));
      return found.length === 1 ? found[0].transactionHash : null;
    },
    async confirm(batch) {
      const ctx = await context(batch);
      const receipt = await ctx.provider.getTransactionReceipt(batch.tx_hash);
      if (!receipt) return null;
      const block = await ctx.provider.getBlock(receipt.blockNumber);
      if (receipt.status !== 1 || !equal(receipt.to, address) || !equal(receipt.from, batch.anchorer)
        || !block || !equal(block.hash, receipt.blockHash)) throw new Error('Invalid anchor receipt');
      if (await ctx.provider.getBlockNumber() - receipt.blockNumber + 1 < confirmations) return null;
      const tx = await ctx.provider.getTransaction(batch.tx_hash);
      const expectedData = ctx.log.interface.encodeFunctionData('anchorBatch', [batch.merkle_root, batch.from_seq, batch.to_seq, batch.count, batch.version_id]);
      if (!tx || !equal(tx.to, address) || !equal(tx.from, batch.anchorer) || !equal(tx.data, expectedData) || BigInt(tx.value ?? 0) !== 0n
        || Number(tx.chainId) !== ctx.chainId) throw new Error('Anchor transaction does not match the exact plan');
      const events = receipt.logs.filter((log) => equal(log.address, address)).flatMap((log) => {
        try { const parsed = ctx.log.interface.parseLog(log); return parsed?.name === 'DecisionBatchAnchored' ? [parsed] : []; } catch { return []; }
      });
      if (!events.some((event) => Number(event.args.batchId) === batch.batch_id && matches(event.args, batch) && equal(event.args.anchorer, batch.anchorer))) throw new Error('Expected anchor event missing');
      if (!matches(await ctx.log.batches(batch.batch_id), batch)) throw new Error('Chain batch differs from the journal');
      return { block_number: receipt.blockNumber, block_hash: receipt.blockHash,
        explorer_url: `${String(chainConfig.explorerBase).replace(/\/$/u, '')}/tx/${batch.tx_hash}` };
    },
    async verify(result) {
      const batch = result.batch;
      if (result.mode !== 'live' || batch.status !== 'ANCHORED') return false;
      const confirmed = await adapter.confirm(batch);
      if (!confirmed || !equal(confirmed.block_hash, batch.block_hash)) return false;
      const ctx = await context(batch);
      return await ctx.log.verifyInclusion(batch.batch_id, result.leaf, result.proof) === true;
    }
  };
  return adapter;
}

// CLI verification has a provider only: it never loads env files, wallets or signer keys.
export function createReadOnlyAnchorAdapter(chainConfig) {
  const provider = new JsonRpcProvider(chainConfig.rpcUrls[0], chainConfig.chainIdDecimal, { staticNetwork: true });
  provider._getConnection().timeout = 15_000;
  return { adapter: createAnchorChainAdapter({ chainConfig, getContext: async () => ({ provider }) }), close: () => provider.destroy() };
}
