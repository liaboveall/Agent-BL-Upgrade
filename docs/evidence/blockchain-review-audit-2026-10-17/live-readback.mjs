// Provider-only fixed-block readback; no environment file, wallet, signer or transaction creation.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { Contract, FetchRequest, JsonRpcProvider, keccak256 } from 'ethers';

const root = new URL('../../../', import.meta.url);
const configBytes = await fs.readFile(new URL('public/chain-config.json', root));
const registry = JSON.parse(configBytes);
const config = registry.networks[registry.defaultNetwork];
const request = new FetchRequest(config.rpcUrls[0]);
request.timeout = 15000;
const provider = new JsonRpcProvider(request, config.chainIdDecimal, { staticNetwork: true });
const rpcMethods = new Set();
const send = provider.send.bind(provider);
provider.send = async (method, params) => {
  if (!['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode'].includes(method)) {
    throw new Error(`Disallowed RPC method: ${method}`);
  }
  rpcMethods.add(method);
  return send(method, params);
};
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const stringify = (data) => JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
try {
  const actualChain = Number(await provider.send('eth_chainId', []));
  if (actualChain !== 1439 || actualChain !== config.chainIdDecimal) throw new Error('Unexpected chain');
  const head = await provider.getBlockNumber();
  const block = await provider.getBlock(head - 2);
  const opts = { blockTag: block.number };
  const contracts = Object.fromEntries(Object.entries(config.contracts).map(([name, address]) =>
    [name, new Contract(address, config.abis[name], provider)]));
  const bytecode = await Promise.all(Object.entries(config.contracts).map(async ([name, address]) => {
    const artifact = JSON.parse(await fs.readFile(new URL(`hardhat/artifacts/contracts/${name}.sol/${name}.json`, root), 'utf8'));
    const deployed = await provider.getCode(address, block.number);
    return { name, address, bytes: (deployed.length - 2) / 2, onchain_keccak256: keccak256(deployed),
      artifact_keccak256: keccak256(artifact.deployedBytecode), exact_match: deployed.toLowerCase() === artifact.deployedBytecode.toLowerCase(),
      source_sha256: sha256(await fs.readFile(new URL(`hardhat/contracts/${name}.sol`, root))) };
  }));
  const owners = Object.fromEntries(await Promise.all(['EBLRegistry', 'RWAToken', 'RWAOfferingPool', 'RiskPricingOracle', 'PaymentOracle', 'AgentDecisionLog']
    .map(async (name) => [name, await contracts[name].owner(opts)])));
  const pool = contracts.RWAOfferingPool;
  const [version, accessMode, nextPoolId, nextEblId, emergencyStopped, complianceGate, batchCount, lastSeq, attestationCount, oracle, tokenPool, oraclePool] = await Promise.all([
    pool.protocolVersion(opts), pool.accessMode(opts), pool.nextPoolId(opts), contracts.EBLRegistry.nextEblId(opts), pool.emergencyStopped(opts),
    pool.complianceGate(opts), contracts.AgentDecisionLog.batchCount(opts), contracts.AgentDecisionLog.lastSeq(opts),
    contracts.PaymentOracle.attestationCount(opts), pool.oracle(opts), contracts.RWAToken.pool(opts), contracts.RiskPricingOracle.pool(opts)
  ]);
  const ownerCode = await provider.getCode(owners.RWAOfferingPool, block.number);
  const after = await provider.getBlock(block.number);
  if (after.hash !== block.hash) throw new Error('Canonical block changed during readback');
  const report = { schema: 'agentbl-review-fixed-block-readback-v1', checked_at: new Date().toISOString(),
    chain_id: actualChain, rpc_url: config.rpcUrls[0], block_number: block.number, block_hash: block.hash,
    block_time_utc: new Date(block.timestamp * 1000).toISOString(), chain_config_sha256: sha256(configBytes),
    values: { version, accessMode, nextPoolId, nextEblId, emergencyStopped, complianceGate, batchCount, lastSeq, attestationCount },
    owners, pool_owner_has_no_code: ownerCode === '0x', wiring: { pool_oracle: oracle, token_pool: tokenPool, oracle_pool: oraclePool },
    bytecode, rpc_methods_used: [...rpcMethods].sort(), chain_writes: 0,
    limits: ['Single RPC trust; not an independently verified light client.', 'Artifact/runtime exact matching is recorded; reproducible clean compilation and compiler audit were not repeated.'] };
  console.log(stringify(report));
} finally {
  provider.destroy();
}
