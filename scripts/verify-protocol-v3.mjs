// Provider-only readback. --activate updates local public configuration after all chain checks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Contract, FetchRequest, JsonRpcProvider, formatEther, keccak256, parseEther } from 'ethers';
import chainConfigLib from './lib/chain-config.cjs';
import { CORE_V3, planDigest, verifyPlannedTransaction } from './lib/protocol-v3-deployment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'docs/evidence/protocol-v3-deployment-2026-10-17');
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const encode = (value) => `${JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2)}\n`;
const { values } = parseArgs({ options: { activate: { type: 'boolean', default: false } } });
const plan = await read(path.join(base, 'plan.json'));
const before = await read(path.join(base, 'chain-config-before.json'));
const inventory = await read(path.join(base, 'legacy-inventory-before.json'));
const old = before.networks['injective-testnet'];
const request = new FetchRequest(old.rpcUrls[0]); request.timeout = 20000;
const provider = new JsonRpcProvider(request, 1439, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: 0 });
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
try {
  ensure(Number(await provider.send('eth_chainId', [])) === 1439 && planDigest(before) === plan.chain_registry_sha256
    && planDigest(inventory) === plan.legacy_inventory_sha256, 'Network or plan commitment mismatch');
  const transactions = [];
  for (const step of plan.transactions) {
    const checkpoint = await read(path.join(base, `transaction-${step.index}.json`));
    const receipt = await verifyPlannedTransaction({ provider, plan, step, checkpoint });
    ensure(receipt, 'A planned receipt is pending'); transactions.push(checkpoint);
  }
  const block = Number(BigInt(await provider.send('eth_blockNumber', []))), at = { blockTag: block };
  const artifacts = Object.fromEntries(await Promise.all(CORE_V3.map(async (name) => [name,
    await read(path.join(root, `hardhat/artifacts/contracts/${name}.sol/${name}.json`))])));
  const candidate = Object.fromEntries(CORE_V3.map((name) => [name, new Contract(plan.addresses[name], artifacts[name].abi, provider)]));
  const bytecode = [];
  for (const [name, address] of Object.entries({ ...old.contracts, ...plan.addresses })) {
    const artifact = await read(path.join(root, `hardhat/artifacts/contracts/${name}.sol/${name}.json`));
    const code = await provider.getCode(address, block);
    ensure(keccak256(code) === keccak256(artifact.deployedBytecode), `Bytecode mismatch for ${name}`);
    bytecode.push({ name, address, status: 'MATCH', runtime_keccak256: keccak256(code) });
  }
  const owners = {};
  for (const [name, contract] of Object.entries(candidate)) {
    owners[name] = await contract.owner(at); ensure(same(owners[name], plan.owner), 'Unexpected owner');
  }
  const wiring = {
    registry: await candidate.RWAOfferingPool.eblRegistry(at), token: await candidate.RWAOfferingPool.rwaToken(at),
    token_pool: await candidate.RWAToken.pool(at), oracle: await candidate.RWAOfferingPool.oracle(at), oracle_pool: await candidate.RiskPricingOracle.pool(at),
    protocol_version: Number(await candidate.RWAOfferingPool.protocolVersion(at)), updater_allowed: await candidate.RiskPricingOracle.isUpdater(plan.updater, at),
    emergency_stopped: await candidate.RWAOfferingPool.emergencyStopped(at), access_mode: Number(await candidate.RWAOfferingPool.accessMode(at)),
    next_ebl_id: Number(await candidate.EBLRegistry.nextEblId(at)), next_pool_id: Number(await candidate.RWAOfferingPool.nextPoolId(at))
  };
  ensure(same(wiring.registry, plan.addresses.EBLRegistry) && same(wiring.token, plan.addresses.RWAToken)
    && same(wiring.token_pool, plan.addresses.RWAOfferingPool) && same(wiring.oracle_pool, plan.addresses.RWAOfferingPool)
    && same(wiring.oracle, plan.addresses.RiskPricingOracle) && wiring.protocol_version === 3 && wiring.updater_allowed
    && wiring.next_ebl_id === 1 && wiring.next_pool_id === 1 && !wiring.emergency_stopped, 'V3 initialization readback mismatch');
  const legacy = Object.fromEntries(CORE_V3.map((name) => [name, new Contract(old.contracts[name], old.abis[name], provider)]));
  ensure(Number(await legacy.EBLRegistry.nextEblId(at)) === inventory.ebls.length + 1
    && Number(await legacy.RWAOfferingPool.nextPoolId(at)) === inventory.pools.length + 1, 'Legacy asset count changed');
  for (const ebl of inventory.ebls) {
    const r = legacy.EBLRegistry;
    ensure(same(await r.cargoHashOf(ebl.ebl_id, at), ebl.cargo_hash) && same(await r.metadataHashOf(ebl.ebl_id, at), ebl.metadata_hash)
      && same(await r.holderOf(ebl.ebl_id, at), ebl.holder) && same(await r.pledgedTo(ebl.ebl_id, at), ebl.pledged_to), 'Legacy collateral changed');
  }
  const fields = ['eblId', 'tokenSupply', 'issuePrice', 'targetRedemptionValue', 'subscribed', 'repaymentAmount', 'paymentProof', 'arrivalProof', 'state', 'exists'];
  for (const pool of inventory.pools) {
    const current = await legacy.RWAOfferingPool.offerings(pool.pool_id, at);
    ensure(fields.every((key, i) => String(current[i]) === String(pool[key]))
      && String(await legacy.RWAToken.totalSupply(pool.pool_id, at)) === pool.issued_shares
      && String(await legacy.RWAToken.balanceOf(pool.pool_id, plan.owner, at)) === pool.owner_shares
      && same(await legacy.RiskPricingOracle.latestQuoteHash(pool.pool_id, at), pool.latest_quote_hash)
      && same(await legacy.RiskPricingOracle.latestEvidenceHash(pool.pool_id, at), pool.latest_evidence_hash), 'Legacy offering or holding changed');
  }
  ensure(await legacy.RWAOfferingPool.emergencyStopped(at) === inventory.wiring.emergency_stopped, 'Legacy emergency state changed');
  const log = new Contract(old.contracts.AgentDecisionLog, old.abis.AgentDecisionLog, provider);
  const anchors = { batch_count: String(await log.batchCount(at)), last_seq: String(await log.lastSeq(at)) };
  ensure(anchors.batch_count === '0' && anchors.last_seq === '0', 'Unexpected anchor activity');
  const balanceAfter = await provider.getBalance(plan.owner, block), beforeBalance = parseEther(inventory.actors.DEPLOYER_PRIVATE_KEY.balance_INJ);
  const debit = beforeBalance - balanceAfter;
  const cap = transactions.reduce((sum, tx) => sum + BigInt(tx.maximum_gas_fee_wei), 0n);
  const gasCost = transactions.reduce((sum, tx) => sum + BigInt(tx.receipt_gas_cost_wei), 0n);
  const nonce = Number(BigInt(await provider.send('eth_getTransactionCount', [plan.owner, 'latest'])));
  const pending = Number(BigInt(await provider.send('eth_getTransactionCount', [plan.owner, 'pending'])));
  ensure(nonce === plan.transactions[6].nonce + 1 && nonce === pending && debit === cap && cap === BigInt(plan.maximum_fee_wei), 'Owner nonce, pending state or fee debit differs');
  const report = { schema: 'agentbl-protocol-v3-live-verification-v1', checked_at: new Date().toISOString(), status: 'PASS',
    chain_id: 1439, block_number: block, block_hash: (await provider.getBlock(block)).hash, plan_sha256: planDigest(plan),
    addresses: plan.addresses, owners, transactions, bytecode, wiring, legacy_assets_unchanged: true,
    legacy_pools: inventory.pools.map((p) => ({ pool_id: p.pool_id, state: p.state, subscribed: p.subscribed, owner_shares: p.owner_shares })),
    anchors, owner_nonce: nonce, owner_pending_nonce: pending, owner_balance_after_INJ: formatEther(balanceAfter),
    fees: { owner_balance_decrease_INJ: formatEther(debit), gas_limit_times_gas_price_INJ: formatEther(cap), receipt_gas_used_times_effective_price_INJ: formatEther(gasCost) },
    activated_local_config: values.activate, mainnet_writes: false, usdc_payments: false, synthetic_proofs: false };
  if (values.activate) {
    const file = path.join(root, 'public/chain-config.json'), current = await read(file);
    ensure(planDigest(current) === plan.chain_registry_sha256, 'Public registry changed before activation');
    const deployments = Object.fromEntries(CORE_V3.map((name, i) => [name, { address: plan.addresses[name], deployTx: transactions[i].tx_hash,
      blockNumber: transactions[i].block_number, deployedAt: report.checked_at, protocolVersion: 3 }]));
    const merged = chainConfigLib.mergeNetworkConfig(current, 'injective-testnet', {
      protocolVersion: 3, contracts: plan.addresses, abis: Object.fromEntries(CORE_V3.map((name) => [name, artifacts[name].abi])), deployments,
      knownLivePools: [], watcherStartBlock: transactions[0].block_number,
      legacyProtocols: [{ protocolVersion: 2, config: structuredClone(old), inventory: 'docs/evidence/protocol-v3-deployment-2026-10-17/legacy-inventory-before.json' }],
      protocol: { schema: 'agentbl-protocol-deployment-v3', chainId: 1439, deployer: plan.owner, deployedAt: report.checked_at,
        planSha256: report.plan_sha256, deploymentTransactions: transactions.slice(0, 4), wiring: transactions.slice(4),
        sourceCommit: plan.source_commit, lifecycleTransactions: 0, escrowAndPayouts: false }
    });
    chainConfigLib.atomicWriteRegistry(file, merged);
  }
  await fs.writeFile(path.join(base, values.activate ? 'live-verification-and-activation.json' : `live-readback-${block}.json`), encode(report), { flag: 'wx' });
  console.log(encode({ status: report.status, verified_transactions: transactions.length, bytecode: bytecode.map(({ name, status }) => ({ name, status })),
    wiring, legacy_assets_unchanged: true, fees: report.fees, activated_local_config: values.activate }));
} catch (error) {
  console.error(`Provider-only v3 verification stopped (${error.code ?? error.name}): ${error.message}. Configuration activates only after every chain check passes.`); process.exitCode = 1;
} finally { provider.destroy(); }
