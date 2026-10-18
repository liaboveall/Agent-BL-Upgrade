import path from 'node:path';
import { Contract, Interface, JsonRpcProvider, FetchRequest, id } from 'ethers';
import { readJson } from '../lib/jsonStore.js';
import { HttpError } from '../app/http.js';

export const RIGHTS_CONTROLLER_ABI = [
  'function governance() view returns (address)', 'function registry() view returns (address)', 'function token() view returns (address)',
  'function capitalPool() view returns (address)', 'function controlVersion() view returns (uint256)', 'function scope() view returns (bytes32)',
  'function termsHash(uint256) view returns (bytes32)', 'function intakeStopped() view returns (bool)',
  'function acknowledgeTerms(uint256,bytes32,uint256,uint64)', 'function disburse(uint256,uint256,bytes32)',
  'function executeLifecycle(bytes)', 'function notifyResolution(uint256,bytes32,bytes32,uint256)',
  'function reviewResolution(uint256,bytes32)', 'function finalizeResolution(uint256)'
];
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const requireThat = (condition, code) => { if (!condition) throw new HttpError(409, code, 'W3 protocol binding or transaction precondition failed'); };
const uint = (value) => { requireThat(typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) && BigInt(value) < 2n ** 256n, 'rights_integer_invalid'); return value; };
const ARTIFACTS = path.resolve(import.meta.dirname, '../../hardhat/artifacts/contracts');
const CONTRACTS = ['RightsGovernance', 'AssetIdentityHub', 'CommittedEBLRegistry', 'RightsController', 'ControlledRWAToken', 'RWAOfferingPoolV5'];
export function maskImmutableBytecode(bytecode, artifact) {
  let code = String(bytecode).toLowerCase();
  for (const ranges of Object.values(artifact.immutableReferences ?? {})) for (const { start, length } of ranges) {
    const offset = 2 + start * 2;
    requireThat(offset + length * 2 <= code.length, 'rights_bytecode_invalid');
    code = code.slice(0, offset) + '0'.repeat(length * 2) + code.slice(offset + length * 2);
  }
  return code;
}

/** Read-only planner. Caller signs in their wallet; the server has no private key. */
export class RightsChainService {
  constructor({ provider, controller, registry, pool, token, chainId, governance, artifacts }) {
    Object.assign(this, { provider, controller, registry, pool, token, chainId, governance, artifacts });
  }
  async verify() {
    const [network, owner, actualPool, actualRegistry, actualToken, gov, version, gate, mode, minter, boundController, count, delay, scope, capitalVersion, registryGovernance, hubAddress,
      oracle, capitalRegistry, capitalToken, controllerDomain, registryDomain] = await Promise.all([
      this.provider.getNetwork(), this.pool.owner(), this.controller.capitalPool(), this.controller.registry(), this.controller.token(),
      this.controller.governance(), this.controller.controlVersion(), this.pool.complianceGate(), this.pool.accessMode(), this.token.pool(), this.registry.controller(),
      this.governance.memberCount(), this.governance.delay(), this.controller.scope(), this.pool.protocolVersion(), this.registry.governance(), this.registry.hub(),
      this.pool.oracle(), this.pool.eblRegistry(), this.pool.rwaToken(), this.controller.eip712Domain(), this.registry.eip712Domain()
    ]);
    requireThat(BigInt(network.chainId) === BigInt(this.chainId) && BigInt(version) === 1n && BigInt(capitalVersion) === 5n
      && [1439n, 31337n].includes(BigInt(network.chainId)) && scope === id('RESEARCH_TEST_ASSETS_ONLY'), 'rights_network_mismatch');
    requireThat(equal(owner, await this.controller.getAddress()) && equal(actualPool, await this.pool.getAddress())
      && equal(actualRegistry, await this.registry.getAddress()) && equal(actualToken, await this.token.getAddress())
      && equal(gate, owner) && equal(boundController, owner) && equal(minter, actualPool)
      && equal(oracle, owner) && equal(capitalRegistry, actualRegistry) && equal(capitalToken, actualToken)
      && equal(gov, await this.governance.getAddress()) && equal(registryGovernance, gov)
      && BigInt(mode) === 1n && BigInt(count) >= 3n && BigInt(delay) >= 3600n, 'rights_controls_mismatch');
    requireThat(controllerDomain.name === 'AgentBL Rights' && registryDomain.name === 'AgentBL Title'
      && controllerDomain.version === '1' && registryDomain.version === '1'
      && equal(controllerDomain.verifyingContract, owner) && equal(registryDomain.verifyingContract, actualRegistry)
      && BigInt(controllerDomain.chainId) === BigInt(this.chainId) && BigInt(registryDomain.chainId) === BigInt(this.chainId), 'rights_signature_domain_mismatch');
    const hub = new Contract(hubAddress, ['function registry(address) view returns (bool)', 'function governance() view returns (address)'], this.provider);
    requireThat(await hub.registry(actualRegistry) && equal(await hub.governance(), gov), 'rights_registry_not_enrolled');
    const addresses = { RightsGovernance: gov, AssetIdentityHub: hubAddress, CommittedEBLRegistry: actualRegistry,
      RightsController: owner, ControlledRWAToken: actualToken, RWAOfferingPoolV5: actualPool };
    for (const name of CONTRACTS) {
      const a = this.artifacts?.[name] ?? await readJson(path.join(ARTIFACTS, `${name}.sol`, `${name}.json`));
      requireThat(a?.deployedBytecode, 'rights_artifact_missing');
      const code = await this.provider.getCode(addresses[name]);
      requireThat(maskImmutableBytecode(code, a) === maskImmutableBytecode(a.deployedBytecode, a), 'rights_bytecode_mismatch');
    }
    return { chain_id: String(network.chainId), controller: owner, pool: actualPool, governance: gov, control_version: 1 };
  }
  async prepare(principal, input) {
    const binding = await this.verify();
    requireThat(input && Object.keys(input).every((key) => ['operation', 'pool_id', 'terms_hash', 'quote_version', 'valid_until', 'amount_atomic', 'evidence_hash', 'distribution_hash', 'payload', 'material_id'].includes(key)), 'rights_plan_invalid');
    const operations = {
      register_title: { roles: ['issuer'], contract: this.registry, method: 'registerTitle', args: () => [input.payload?.issuance, input.payload?.signature] },
      pledge: { roles: ['holder'], contract: this.registry, method: 'pledge', args: () => [uint(input.payload?.ebl_id), binding.pool, input.terms_hash, uint(input.valid_until), input.payload?.signature ?? '0x'] },
      create_offering: { roles: ['issuer'], method: 'createControlledOffering', args: () => [input.payload?.terms, input.payload?.valuation, input.payload?.valuer, input.payload?.signature] },
      acknowledge_terms: { roles: ['investor'], method: 'acknowledgeTerms', args: () => [uint(input.pool_id), input.terms_hash, uint(input.quote_version), uint(input.valid_until)] },
      disburse: { roles: ['issuer', 'custodian'], method: 'disburse', args: () => [uint(input.pool_id), uint(input.amount_atomic), input.evidence_hash] },
      notify_resolution: { roles: ['custodian'], method: 'notifyResolution', args: () => [uint(input.pool_id), input.evidence_hash, input.distribution_hash, uint(input.amount_atomic)] },
      review_resolution: { roles: ['reviewer'], method: 'reviewResolution', args: () => [uint(input.pool_id), input.evidence_hash] },
      finalize_resolution: { roles: ['custodian'], method: 'finalizeResolution', args: () => [uint(input.pool_id)] }
    };
    const operation = operations[input.operation];
    if (!operation) throw new HttpError(400, 'rights_plan_operation_unknown', 'Unsupported rights transaction plan');
    if (!principal.roles.some((role) => operation.roles.includes(role))) throw new HttpError(403, 'rights_role_required', 'Business role does not allow this transaction');
    const target = operation.contract ?? this.controller;
    let data;
    try { data = target.interface.encodeFunctionData(operation.method, operation.args()); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'rights_plan_invalid', 'Transaction arguments are invalid'); }
    const transaction = { from: principal.wallet, to: await target.getAddress(), data };
    try { await this.provider.call(transaction); }
    catch { throw new HttpError(409, 'rights_preflight_failed', 'Current chain state or on-chain permissions reject this plan'); }
    const block = await this.provider.getBlockNumber();
    const nonce = await this.provider.getTransactionCount(principal.wallet, 'pending');
    return { ...binding, operation: input.operation, from: principal.wallet, to: transaction.to, calldata: data, value: '0',
      nonce, prepared_block: block, scope: 'research_test_assets_only', ...(input.operation === 'create_offering'
        ? { material_id: input.material_id, terms_hash: await this.controller.hashTerms(input.payload.terms), document_hash: input.payload.terms.documentHash } : {}) };
  }
  async verifyTransaction(plan, txHash) {
    await this.verify();
    const tx = await this.provider.getTransaction(txHash);
    if (!tx && plan.tx_hash && equal(plan.tx_hash, txHash)) return { tx_hash: txHash, status: 'reconciling', block_number: null, block_hash: null };
    requireThat(tx && equal(tx.from, plan.from) && equal(tx.to, plan.to) && equal(tx.data, plan.calldata)
      && tx.value === 0n && Number(tx.nonce) === plan.nonce && BigInt(tx.chainId) === BigInt(plan.chain_id), 'rights_transaction_mismatch');
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) return { tx_hash: txHash, status: plan.block_hash ? 'reconciling' : 'pending', block_number: null, block_hash: null };
    const block = await this.provider.getBlock(receipt.blockNumber);
    if (block?.hash !== receipt.blockHash) return { tx_hash: txHash, status: 'reconciling', block_number: null, block_hash: null };
    const latest = await this.provider.getBlockNumber();
    // Local chains confirm immediately; controlled testnet candidates require two successors.
    const depth = BigInt(plan.chain_id) === 31337n ? 0 : 2;
    return { tx_hash: txHash, status: receipt.status === 0 ? 'reverted' : latest - receipt.blockNumber < depth ? 'confirming' : 'confirmed',
      block_number: receipt.blockNumber, block_hash: receipt.blockHash };
  }
  async recoverTransaction(plan) {
    const latest = await this.provider.getBlockNumber();
    if (latest - plan.prepared_block > 500) throw new HttpError(409, 'rights_manual_reconciliation_required', 'Saved broadcast is outside the bounded scan; reconcile its wallet hash explicitly');
    for (let number = plan.prepared_block; number <= latest; number++) {
      const block = await this.provider.getBlock(number, true);
      requireThat(block, 'rights_recovery_block_missing');
      // Some providers ignore prefetch; fetch each transaction without guessing a hash.
      for (const hash of block.transactions) {
        const tx = await this.provider.getTransaction(hash);
        requireThat(tx, 'rights_recovery_transaction_missing');
        if (equal(tx.from, plan.from) && Number(tx.nonce) === plan.nonce) {
          if (!equal(tx.to, plan.to) || !equal(tx.data, plan.calldata) || tx.value !== 0n) {
            return { status: 'nonce_consumed_by_other_transaction', observed_tx_hash: hash };
          }
          return this.verifyTransaction(plan, hash);
        }
      }
    }
    return null;
  }
}

/** Optional explicit candidate manifest; never repoints the existing public chain config. */
export async function loadRightsChain(file) {
  const cfg = await readJson(file);
  requireThat(cfg?.schema === 'agentbl-rights-instance-v1' && cfg.scope === 'research_test_assets_only'
    && cfg.rpc_url && cfg.chain_id && cfg.contracts, 'rights_config_invalid');
  const artifacts = Object.fromEntries(await Promise.all(CONTRACTS.map(async (name) => [name, await readJson(path.join(ARTIFACTS, `${name}.sol`, `${name}.json`))])));
  requireThat(CONTRACTS.every((name) => artifacts[name]?.abi), 'rights_artifact_missing');
  const rpc = new FetchRequest(cfg.rpc_url); rpc.timeout = 10000;
  const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const contract = (name) => new Contract(cfg.contracts[name], new Interface(artifacts[name].abi), provider);
  const service = new RightsChainService({ provider, chainId: cfg.chain_id, controller: contract('RightsController'), registry: contract('CommittedEBLRegistry'),
    token: contract('ControlledRWAToken'), pool: contract('RWAOfferingPoolV5'), governance: contract('RightsGovernance'), artifacts });
  try { await service.verify(); return service; } catch (error) { await provider.destroy(); throw error; }
}
