export function buildPositionView({ wallet, demoInvestments = [], ledgerPositions = [], chainBalances = new Map() }) {
  const normalized = String(wallet).toLowerCase();
  const result = [];
  for (const inv of demoInvestments.filter((i) => i.walletAddress === normalized)) {
    result.push({
      mode: 'demo',
      reference: inv.reference,
      pool_id: inv.poolId,
      asset: null,
      shares: String(inv.tokenCount),
      cost_usd: inv.amountUsd,
      claimable_usd: 0,
      claimed_usd: 0,
      status: 'active'
    });
  }
  for (const pos of ledgerPositions.filter((p) => p.investor === normalized)) {
    const key = `${pos.protocol_instance.chain_id}:${pos.protocol_instance.pool_address}:${pos.chain_pool_id}`;
    const balance = chainBalances.get(key) ?? BigInt(pos.shares);
    result.push({
      mode: 'live',
      protocol_instance: pos.protocol_instance,
      chain_pool_id: pos.chain_pool_id,
      asset: pos.asset,
      shares: String(balance),
      cost_atomic: pos.cost_atomic,
      claimed_atomic: pos.claimed_atomic,
      status: pos.status
    });
  }
  return result;
}
