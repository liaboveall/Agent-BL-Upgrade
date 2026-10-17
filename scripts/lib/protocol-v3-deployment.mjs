// An explicit, nonce-bound testnet deployment. Signed bytes stay in memory; only public
// transaction commitments are journaled. A checkpoint is reconciled, never rebroadcast.
import { Contract, ContractFactory, getCreateAddress, keccak256, parseEther } from 'ethers';
import { createHash } from 'node:crypto';
import { stableStringify } from '../../src/agent/decisionLogger.js';

export const CORE_V3 = Object.freeze(['EBLRegistry', 'RWAToken', 'RWAOfferingPool', 'RiskPricingOracle']);
export const planDigest = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

export async function createProtocolV3Plan({ inventory, chainRegistry, artifacts, gasPrice, sourceCommit }) {
  const actor = inventory.actors.DEPLOYER_PRIVATE_KEY;
  const owner = actor.address, updater = inventory.actors.PRICING_UPDATER_PRIVATE_KEY.address;
  ensure(inventory.chain_id === 1439 && actor.nonce_latest === actor.nonce_pending, 'Wrong chain or pending owner transaction');
  ensure(owner && updater && !same(owner, updater) && Object.values(inventory.owners).every((value) => same(value, owner)), 'Owner or dedicated updater mismatch');
  ensure(inventory.pools.filter((p) => p.pool_id !== 1).every((p) => p.subscribed === '0'), 'Legacy live holdings require a separate migration');
  const nonce = actor.nonce_latest;
  const addresses = Object.fromEntries(CORE_V3.map((name, i) => [name, getCreateAddress({ from: owner, nonce: nonce + i })]));
  const gas = [3000000, 1000000, 5000000, 1500000, 100000, 100000, 100000];
  const args = { EBLRegistry: [], RWAToken: [], RWAOfferingPool: [addresses.EBLRegistry, addresses.RWAToken], RiskPricingOracle: [addresses.RWAOfferingPool] };
  const transactions = [];
  for (const name of CORE_V3) {
    const factory = new ContractFactory(artifacts[name].abi, artifacts[name].bytecode);
    const request = await factory.getDeployTransaction(...args[name]);
    transactions.push({ label: `deploy:${name}`, contract: name, address: addresses[name], data: request.data, to: null, args: args[name] });
  }
  for (const [name, method, values, event] of [
    ['RWAToken', 'setPool', [addresses.RWAOfferingPool], 'PoolSet'],
    ['RWAOfferingPool', 'setOracle', [addresses.RiskPricingOracle], 'OracleSet'],
    ['RiskPricingOracle', 'setUpdater', [updater, true], 'UpdaterSet']
  ]) {
    const contract = new Contract(addresses[name], artifacts[name].abi);
    transactions.push({ label: `${name}.${method}`, contract: name, method, args: values,
      to: addresses[name], data: contract.interface.encodeFunctionData(method, values), expected_event: event });
  }
  transactions.forEach((tx, i) => Object.assign(tx, { index: i, nonce: nonce + i, chainId: 1439,
    gasLimit: String(gas[i]), gasPrice: String(gasPrice), value: '0', type: 0 }));
  const maximum = transactions.reduce((sum, tx) => sum + BigInt(tx.gasLimit) * BigInt(tx.gasPrice), 0n);
  ensure(maximum <= parseEther('0.003') && maximum < parseEther(actor.balance_INJ), 'Deployment exceeds the fee ceiling or balance');
  return { schema: 'agentbl-protocol-v3-plan-v1', chain_id: 1439, owner, updater, source_commit: sourceCommit,
    chain_registry_sha256: planDigest(chainRegistry), legacy_inventory_sha256: planDigest(inventory),
    legacy_contracts: chainRegistry.networks['injective-testnet'].contracts,
    bytecode_hashes: Object.fromEntries(CORE_V3.map((name) => [name, { creation: keccak256(artifacts[name].bytecode), runtime: keccak256(artifacts[name].deployedBytecode) }])),
    addresses, transactions, maximum_fee_wei: String(maximum),
    authorization: 'Direct user request: 部署，并执行需要的交易; protocol v3 deployment and necessary initialization only',
    exclusions: ['legacy pool mutations', 'asset reminting or holding migration', 'USDC transfers', 'fabricated payment or arrival proofs', 'first anchor batch', 'background anchoring', 'mainnet'] };
}

export async function verifyPlannedTransaction({ provider, plan, step, checkpoint }) {
  ensure(checkpoint?.plan_sha256 === planDigest(plan) && checkpoint.nonce === step.nonce, 'Checkpoint does not match the plan');
  const receipt = await provider.getTransactionReceipt(checkpoint.tx_hash);
  if (!receipt) return null;
  const tx = await provider.getTransaction(checkpoint.tx_hash), block = await provider.getBlock(receipt.blockNumber);
  ensure(receipt.status === 1 && block && same(block.hash, receipt.blockHash) && tx
    && same(tx.from, plan.owner) && same(tx.to, step.to) && same(tx.data, step.data)
    && tx.nonce === step.nonce && Number(tx.chainId) === 1439 && tx.value === 0n
    && same(tx.hash, checkpoint.tx_hash) && same(receipt.hash, checkpoint.tx_hash)
    && tx.gasLimit === BigInt(step.gasLimit) && tx.gasPrice === BigInt(step.gasPrice), 'Transaction, receipt or canonical block differs from the plan');
  if (!step.to) ensure(same(receipt.contractAddress, step.address), 'Unexpected creation address');
  return receipt;
}

export async function executeProtocolV3Step({ plan, stepIndex, owner, provider, journal, artifacts, waitMs = 120000 }) {
  ensure(plan.schema === 'agentbl-protocol-v3-plan-v1' && plan.chain_id === 1439 && plan.transactions.length === 7, 'Invalid v3 plan');
  ensure(Number(await provider.send('eth_chainId', [])) === 1439 && same(await owner.getAddress(), plan.owner), 'Wrong signer or chain');
  const step = plan.transactions[stepIndex]; ensure(step && step.index === stepIndex, 'Invalid deployment step');
  ensure(CORE_V3.every((name) => keccak256(artifacts[name].bytecode) === plan.bytecode_hashes[name].creation
    && keccak256(artifacts[name].deployedBytecode) === plan.bytecode_hashes[name].runtime), 'Artifacts changed after planning');
  return journal.withLock('protocol-v3-deploy', async () => {
    for (let i = 0; i < stepIndex; i++) {
      const previous = await journal.read('protocol-v3-deploy', i);
      ensure(previous && await verifyPlannedTransaction({ provider, plan, step: plan.transactions[i], checkpoint: previous }), 'An earlier transaction is not confirmed');
    }
    let saved = await journal.read('protocol-v3-deploy', stepIndex);
    if (!saved) {
      const latest = Number(BigInt(await provider.send('eth_getTransactionCount', [plan.owner, 'latest'])));
      const pending = Number(BigInt(await provider.send('eth_getTransactionCount', [plan.owner, 'pending'])));
      ensure(latest === step.nonce && pending === step.nonce, 'Nonce changed or another transaction is pending');
      ensure(BigInt(await provider.send('eth_gasPrice', [])) <= BigInt(step.gasPrice), 'Gas price increased; reconcile the plan without broadcasting');
      const request = { to: step.to ?? undefined, data: step.data, nonce: step.nonce, chainId: 1439,
        value: 0n, type: 0, gasLimit: BigInt(step.gasLimit), gasPrice: BigInt(step.gasPrice) };
      const estimate = await provider.estimateGas({ ...request, from: plan.owner });
      ensure(estimate <= request.gasLimit, 'Estimate exceeds the reviewed gas limit');
      const signed = await owner.signTransaction(request);
      saved = { plan_sha256: planDigest(plan), label: step.label, nonce: step.nonce, tx_hash: keccak256(signed),
        address: step.address ?? step.to, estimated_gas: String(estimate), status: 'BROADCASTING' };
      await journal.write('protocol-v3-deploy', stepIndex, saved);
      // Even an RPC timeout after this point has a known hash and must never resend.
      const submitted = await provider.broadcastTransaction(signed);
      ensure(same(submitted.hash, saved.tx_hash), 'Broadcast returned another transaction hash');
      saved = { ...saved, status: 'SUBMITTED' }; await journal.write('protocol-v3-deploy', stepIndex, saved);
    }
    let receipt;
    const deadline = Date.now() + waitMs;
    do {
      receipt = await verifyPlannedTransaction({ provider, plan, step, checkpoint: saved });
      if (receipt) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    ensure(receipt, 'Receipt pending; reconcile this hash instead of broadcasting again');
    const contract = new Contract(step.address ?? step.to, artifacts[step.contract].abi, provider);
    if (!step.to) {
      const code = await provider.getCode(step.address);
      ensure(keccak256(code) === plan.bytecode_hashes[step.contract].runtime && same(await contract.owner(), plan.owner), 'Runtime bytecode or owner mismatch');
    } else {
      const logs = receipt.logs.filter((log) => same(log.address, step.to)).map((log) => {
        try { return contract.interface.parseLog(log); } catch { return null; }
      });
      ensure(logs.some((log) => log?.name === step.expected_event
        && step.args.every((arg, i) => typeof arg === 'boolean' ? log.args[i] === arg : same(log.args[i], arg))), 'Initialization event arguments do not match');
    }
    const confirmed = { ...saved, status: 'CONFIRMED', block_number: receipt.blockNumber, block_hash: receipt.blockHash,
      receipt_gas_used: String(receipt.gasUsed), receipt_effective_gas_price: String(receipt.gasPrice),
      receipt_gas_cost_wei: String(receipt.gasUsed * receipt.gasPrice), maximum_gas_fee_wei: String(BigInt(step.gasLimit) * BigInt(step.gasPrice)) };
    await journal.write('protocol-v3-deploy', stepIndex, confirmed);
    return confirmed;
  });
}
