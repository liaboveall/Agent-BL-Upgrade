// Public configuration and read-only RPC verification. No wallet or signer is created.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Interface } from 'ethers';
import { loadRightsChain } from '../../../src/rights/chain.js';
const root = path.resolve(import.meta.dirname, '../../..');
const read = async (name) => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
const manifest = await read('docs/evidence/w5-2026-10-18/source-manifest.json');
const mismatches = [];
for (const item of manifest.files) {
  const actual = createHash('sha256').update(await fs.readFile(path.join(root, item.path))).digest('hex');
  if (actual !== item.sha256) mismatches.push(item.path);
}
const output = { source_revision: 'b8db411de044b1132f14419a432be6da6ff1501b', checked_at: new Date().toISOString(), source_manifest: { source_sha256: manifest.source_sha256, checked_files: manifest.files.length, mismatches }, external_broadcasts: 0 };
const chain = await loadRightsChain(path.join(root, 'public/rights-instance.json'));
try {
  output.bindings = await chain.verify();
  const config = await read('public/rights-instance.json');
  const block = await chain.provider.getBlock((await chain.provider.getBlockNumber()) - 3);
  const at = { blockTag: block.number };
  output.snapshot = { number: block.number, hash: block.hash, timestamp: block.timestamp, chain_id: Number((await chain.provider.getNetwork()).chainId), next_pool_id: String(await chain.pool.nextPoolId(at)), governance_members: String(await chain.governance.memberCount(at)), governance_delay: String(await chain.governance.delay(at)), intake_stopped: await chain.controller.intakeStopped(at), pools: [] };
  for (const poolId of [1, 2]) {
    const offer = await chain.pool.offerings(poolId, at);
    output.snapshot.pools.push({ pool_id: poolId, state: String(offer.state), subscribed: String(offer.subscribed), raised: String(offer.raisedAtomic), disbursed: String(await chain.pool.disbursedAtomic(poolId, at)), recovered: String(await chain.pool.recoveredAtomic(poolId, at)), claimed: String(await chain.pool.totalClaimed(poolId, at)), escrow: String(await chain.pool.escrowed(poolId, offer.settlementAsset, at)), investor_shares: String(await chain.token.balanceOf(poolId, config.actors.investor, at)) });
  }
  const finance = await read('docs/evidence/w5-2026-10-18/testnet/financing-acceptance.json');
  const gateway = await read('docs/evidence/w5-2026-10-18/testnet/public-gateway-acceptance.json');
  const hashes = { claim: finance.normal.claim_tx, refund: finance.failed_raise.refund_tx, public_x402: gateway.report.payment.txHash, payment_attestation: gateway.report.payment.attestationTxHash };
  const transfer = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  output.receipts = [];
  for (const [operation, hash] of Object.entries(hashes)) {
    const receipt = await chain.provider.getTransactionReceipt(hash);
    const canonical = await chain.provider.getBlock(receipt.blockNumber);
    output.receipts.push({ operation, hash, success: receipt.status === 1, block_number: receipt.blockNumber, canonical: canonical.hash === receipt.blockHash, confirmations_at_snapshot: block.number - receipt.blockNumber + 1, gas_used: String(receipt.gasUsed), logs: receipt.logs.flatMap((log) => { let parsed; try { parsed = chain.pool.interface.parseLog(log); } catch {} if (!parsed) { try { parsed = transfer.parseLog(log); } catch {} } return parsed ? [{ contract: log.address, event: parsed.name, values: Array.from(parsed.args, String) }] : []; }) });
  }
  output.snapshot.canonical_after_reads = (await chain.provider.getBlock(block.number)).hash === block.hash;
} finally { await chain.provider.destroy(); }
await fs.writeFile(new URL('./readonly-verification.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
