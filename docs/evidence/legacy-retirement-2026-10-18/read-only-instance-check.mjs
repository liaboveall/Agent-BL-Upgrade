// Public RPC and public configuration only. No environment file, signer or transaction is created.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Contract, keccak256 } from 'ethers';
import { loadRightsChain, maskImmutableBytecode } from '../../../src/rights/chain.js';
import { loadApplicationConfig } from '../../../src/chain/loadApplicationConfig.js';
import { releaseSourceSnapshot, releaseRoot } from '../../../scripts/lib/release-source.mjs';

const directory = import.meta.dirname;
const snapshot = await releaseSourceSnapshot();
await fs.writeFile(path.join(directory, 'source-manifest.json'), JSON.stringify(snapshot, null, 2) + '\n');
const config = loadApplicationConfig();
const historicalInventory = JSON.parse(await fs.readFile(path.join(releaseRoot,
  'docs/evidence/w5-2026-10-18/testnet/legacy-readonly-inventory.json'), 'utf8'));
const pinnedPaymentRuntime = historicalInventory.instances[0].contracts.PaymentOracle.runtime_hash;
const executable = (code) => {
  const metadataBytes = Number.parseInt(code.slice(-4), 16);
  if (!Number.isSafeInteger(metadataBytes) || metadataBytes < 1 || (metadataBytes + 2) * 2 >= code.length - 2) throw new Error('Invalid Solidity metadata trailer');
  return code.slice(0, -(metadataBytes + 2) * 2);
};
const chain = await loadRightsChain(path.join(releaseRoot, 'public/rights-instance.json'));
const result = { schema: 'agentbl-retirement-instance-check-v1', checked_at: new Date().toISOString(),
  base_revision: snapshot.base_head, source_sha256: snapshot.source_sha256, external_broadcasts: 0, checks: [] };
try {
  result.controls = await chain.verify();
  const block = await chain.provider.getBlock(await chain.provider.getBlockNumber() - 3);
  result.block = { number: block.number, hash: block.hash };
  for (const name of ['PaymentOracle', 'AgentDecisionLog']) {
    const artifact = JSON.parse(await fs.readFile(path.join(releaseRoot, 'hardhat/artifacts/contracts', `${name}.sol`, `${name}.json`), 'utf8'));
    const address = config.contracts[name];
    const code = await chain.provider.getCode(address, block.number);
    const matches = maskImmutableBytecode(code, artifact) === maskImmutableBytecode(artifact.deployedBytecode, artifact);
    const executableMatches = executable(code) === executable(artifact.deployedBytecode);
    const pinnedPaymentMatches = name === 'PaymentOracle' && keccak256(code) === pinnedPaymentRuntime;
    result.checks.push({ name, address, full_runtime_matches: matches, executable_code_matches: executableMatches,
      runtime_keccak256: keccak256(code), ...(name === 'PaymentOracle' ? { original_runtime_pin_matches: pinnedPaymentMatches } : {}) });
    // The existing shared PaymentOracle has different CBOR metadata. Accept only its exact
    // frozen runtime pin AND identical executable bytes; do not report full-byte equality.
    if (!matches && !(name === 'PaymentOracle' && pinnedPaymentMatches && executableMatches)) throw new Error(`${name} no longer matches the current artifact`);
  }
  const pool = await chain.pool.getAddress();
  result.public_config_matches_controlled_instance = config.contracts.RWAOfferingPool.toLowerCase() === pool.toLowerCase();
  if (!result.public_config_matches_controlled_instance) throw new Error('Wallet and controlled capital instances differ');
  const anchor = new Contract(config.contracts.AgentDecisionLog, ['function batchCount() view returns (uint256)'], chain.provider);
  result.current_anchor_batches = String(await anchor.batchCount({ blockTag: block.number }));
  result.canonical_after_reads = (await chain.provider.getBlock(block.number)).hash === block.hash;
  if (!result.canonical_after_reads) throw new Error('Read snapshot reorganized');
  result.passed = true;
} finally {
  await chain.provider.destroy();
  await fs.writeFile(path.join(directory, 'read-only-instance-check.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
