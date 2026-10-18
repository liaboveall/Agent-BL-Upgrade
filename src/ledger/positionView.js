const balanceKey = (pi, poolId) => `${pi.chain_id}:${pi.pool_address.toLowerCase()}:${pi.protocol_version ?? 5}:${poolId}`;
export { balanceKey };

export function buildPositionView({ wallet, demoInvestments = [], ledgerPositions = [], chainBalances = new Map(), chainPositions = new Map() }) {
  const normalized = String(wallet).toLowerCase();
  const result = [];
  for (const inv of demoInvestments.filter((item) => String(item.walletAddress).toLowerCase() === normalized)) {
    result.push({ mode: 'demo', reference: inv.reference, pool_id: inv.poolId, asset: null,
      shares: String(inv.tokenCount), cost_usd: inv.amountUsd, claimable_usd: 0, claimed_usd: 0, status: 'active' });
  }
  const known = new Set();
  for (const pos of ledgerPositions.filter((item) => item.investor.toLowerCase() === normalized)) {
    const key = balanceKey(pos.protocol_instance, pos.chain_pool_id);
    const legacyKey = `${pos.protocol_instance.chain_id}:${pos.protocol_instance.pool_address}:${pos.chain_pool_id}`;
    const snapshot = chainPositions.get(key);
    const balance = snapshot?.shares ?? chainBalances.get(key) ?? chainBalances.get(legacyKey);
    const reconciled = balance != null && BigInt(balance) === BigInt(pos.shares) && snapshot?.canonical !== false;
    known.add(key);
    result.push({ ...pos, mode: 'live', shares: String(balance ?? pos.shares), ledger_shares: pos.shares,
      claimable_atomic: reconciled && snapshot?.claimable_atomic != null ? String(snapshot.claimable_atomic) : null,
      chain_state: snapshot?.state ?? null, confirmed_block: snapshot?.block_number ?? null,
      reconciled, status: !reconciled ? 'reconciling' : BigInt(snapshot?.claimable_atomic ?? 0) > 0n && BigInt(balance) === 0n ? 'recovery_claimable' : pos.status });
  }
  for (const [key, snapshot] of chainPositions) {
    if (known.has(key) || (BigInt(snapshot.shares ?? 0) === 0n && BigInt(snapshot.claimable_atomic ?? 0) === 0n)) continue;
    result.push({ ...snapshot, mode: 'live', investor: normalized, shares: String(snapshot.shares),
      cost_atomic: null, claimed_atomic: null, claimable_atomic: null, reconciled: false, status: 'reconciling' });
  }
  return result;
}
