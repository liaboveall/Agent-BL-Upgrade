// Offline unsigned deployment preparation. No env loader, RPC, signer or key.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFactory, Interface, getCreateAddress, isAddress, ZeroAddress } from 'ethers';
import { releaseRoot, releaseSourceSnapshot, digest } from './lib/release-source.mjs';
import { CONTROL_VERSION } from '../src/rights/typedData.js';

const names = ['RightsGovernance', 'AssetIdentityHub', 'CommittedEBLRegistry', 'ControlledRWAToken', 'RWAOfferingPoolV5', 'RecoveryEntitlements', 'RightsController'];
/**
 * From control version 4 every instance deploys its own RightsGovernance (two members to approve and two to cancel).
 * The shared identity hub, and with it the title reservations of every earlier instance, stays under the governance
 * that created it: `governance` names that hub governance, which enrolls the new registry.
 */
export async function prepareRightsCandidate(input) {
  const members = input?.members ?? [];
  if (!input || Object.keys(input).some((key) => !['instance_id', 'chain_id', 'governance', 'hub', 'deployer', 'nonce', 'rpc_url', 'members', 'delay'].includes(key))
    || !/^[a-z][a-z0-9-]{2,63}$/u.test(input.instance_id ?? '') || ![1439, 31337].includes(input.chain_id)
    || !Number.isSafeInteger(input.nonce) || input.nonce < 0 || input.nonce > Number.MAX_SAFE_INTEGER - 8
    || ![input.governance, input.hub, input.deployer].every((address) => isAddress(address ?? '') && address !== ZeroAddress)
    || !Array.isArray(members) || members.length < 3 || !members.every((address) => isAddress(address) && address !== ZeroAddress)
    || new Set(members.map((address) => address.toLowerCase())).size !== members.length
    || !Number.isSafeInteger(input.delay) || input.delay < 3600) {
    throw new Error('A new instance ID, test chain, the shared hub and its governance, three distinct governance members, a delay of at least an hour, deployer and unused nonce are required');
  }
  const legacy = JSON.parse(await fs.readFile(path.join(releaseRoot, 'public/rights-instance.json'), 'utf8'));
  if (input.chain_id === 1439 && input.hub.toLowerCase() !== legacy.contracts.AssetIdentityHub.toLowerCase()) {
    throw new Error('Use the existing enrolled identity hub; a new hub would lose cross-instance reservations');
  }
  const artifacts = Object.fromEntries(await Promise.all(names.map(async (name) => [name,
    JSON.parse(await fs.readFile(path.join(releaseRoot, 'hardhat/artifacts/contracts', `${name}.sol`, `${name}.json`), 'utf8'))])));
  const source = await releaseSourceSnapshot();
  const contracts = { AssetIdentityHub: input.hub };
  const transactions = [];
  let nonce = input.nonce;
  for (const [name, args] of [
    ['RightsGovernance', () => [members, input.delay]],
    ['CommittedEBLRegistry', () => [contracts.RightsGovernance, input.hub]],
    ['ControlledRWAToken', () => []],
    ['RWAOfferingPoolV5', () => [contracts.CommittedEBLRegistry, contracts.ControlledRWAToken]],
    ['RightsController', () => [contracts.RightsGovernance, contracts.CommittedEBLRegistry, contracts.ControlledRWAToken, contracts.RWAOfferingPoolV5]]
  ]) {
    const artifact = artifacts[name], data = (await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args())).data;
    if ((data.length - 2) / 2 > 49152 || (artifact.deployedBytecode.length - 2) / 2 > 24576) throw new Error(`${name} exceeds standard EVM limits`);
    const address = getCreateAddress({ from: input.deployer, nonce }); contracts[name] = address;
    transactions.push({ label: `deploy:${name}`, from: input.deployer, nonce: nonce++, chainId: input.chain_id, data, value: '0', expected_address: address });
  }
  for (const [name, method, args] of [
    ['ControlledRWAToken', 'bindPool', [contracts.RWAOfferingPoolV5]],
    ['RWAOfferingPoolV5', 'transferOwnership', [contracts.RightsController]],
    ['RightsController', 'activate', []]
  ]) transactions.push({ label: `${name}:${method}`, from: input.deployer, to: contracts[name], nonce: nonce++, chainId: input.chain_id,
    data: new Interface(artifacts[name].abi).encodeFunctionData(method, args), value: '0' });
  const governanceCalls = [
    { governance: input.governance, target: input.hub, data: new Interface(artifacts.AssetIdentityHub.abi).encodeFunctionData('setRegistry', [contracts.CommittedEBLRegistry, true]) },
    { governance: contracts.RightsGovernance, target: contracts.CommittedEBLRegistry, data: new Interface(artifacts.CommittedEBLRegistry.abi).encodeFunctionData('bindController', [contracts.RightsController]) }
  ];
  return { schema: 'agentbl-rights-candidate-v2', instance_id: input.instance_id, scope: 'research_test_assets_only',
    control_version: CONTROL_VERSION, chain_id: input.chain_id, signature_domain: { name: 'AgentBL Rights', version: String(CONTROL_VERSION) },
    execution: 'unsigned_only', broadcast: false, active: false, source, contracts, transactions, governance_calls: governanceCalls,
    hub_governance: input.governance, governance_members: members, governance_delay_seconds: input.delay,
    artifacts, artifact_sha256: Object.fromEntries(names.map((name) => [name, digest(JSON.stringify(artifacts[name]))])),
    predecessor: { manifest: legacy, new_risk_enabled: false,
      artifact_inventory: legacy.control_version < CONTROL_VERSION ? `scripts/config/rights-v${legacy.control_version}-artifacts.json` : 'hardhat/artifacts/contracts',
      exit_policy: 'Retain original configuration, ABI, ledger and wallet exits; do not reuse deployment checkpoints or pending intents' },
    runtime_namespace: `controlled-capital-${contracts.RWAOfferingPoolV5.toLowerCase()}`,
    activation_requirements: ['Confirm canonical chain, unused deployer nonce and the shared hub and its governance before each deployment',
      'Deploy this instance\'s own governance: three distinct members, two to approve and two to cancel, with the stated delay',
      'Reconcile each original nonce/hash; never resend unknown transactions', 'Verify every runtime including pool-created RecoveryEntitlements and its immutable pool',
      'Two hub governors enroll the new registry, and two instance governors bind its controller, after delay; retain all existing hub reservations',
      'Approve issuer, distinct operational roles and standard test asset; default intake stays stopped until independently verified',
      `Record actual deployment block and create a new agentbl-rights-instance-v1 manifest with control_version=${CONTROL_VERSION}`,
      'Complete N5.2 acceptance, then switch both public configs together; archive predecessor configs without changing its funds'] };
}

export async function writeRightsCandidate(input, parent = path.join(releaseRoot, 'artifacts/candidates')) {
  const candidate = await prepareRightsCandidate(input);
  await fs.mkdir(parent, { recursive: true });
  const directory = path.join(parent, candidate.instance_id);
  await fs.mkdir(directory); // Refuse overwrite, even for the same source or nonce.
  await fs.writeFile(path.join(directory, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  return { directory, source_sha256: candidate.source.source_sha256, unsigned_transactions: candidate.transactions.length, broadcast: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Use npm run rights:candidate -- <public-input.json>');
  console.log(JSON.stringify(await writeRightsCandidate(JSON.parse(await fs.readFile(process.argv[2], 'utf8')))));
}
