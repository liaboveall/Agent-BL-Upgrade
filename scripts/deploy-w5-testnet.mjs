// Explicitly authorized research deployment. No mainnet, real assets or legacy mutations.
import '../src/env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider, Wallet, getCreateAddress, id, keccak256, parseEther } from 'ethers';
import { readJson, writeJsonAtomic } from '../src/lib/jsonStore.js';
import { seal, unseal } from '../src/rights/vault.js';
import { createOwnerJournal } from './lib/owner-journal.mjs';
import { maskImmutableBytecode, loadRightsChain } from '../src/rights/chain.js';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'data/runtime/w5-deployment');
const evidence = path.join(root, 'docs/evidence/w5-2026-10-18/testnet');
const names = ['RightsGovernance', 'AssetIdentityHub', 'CommittedEBLRegistry', 'RightsController', 'ControlledRWAToken', 'RWAOfferingPoolV5', 'MockAuthorizationUSDC'];
const roleNames = ['governorB', 'governorC', 'issuer', 'holder', 'valuer', 'operator', 'attestor', 'compliance', 'disposer', 'reviewer', 'guardian', 'investor'];
const AAD = 'agentbl-w5-research-signers-v1';
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const safe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? String(x) : x));
const sha = (v) => createHash('sha256').update(v).digest('hex');
export function deploymentCheckpoint(journalEntry, stateEntry) {
  if (journalEntry?.tx_hash && stateEntry?.tx_hash && journalEntry.tx_hash !== stateEntry.tx_hash) throw new Error('Deployment checkpoints disagree; reconcile without signing again');
  const saved = journalEntry ?? (stateEntry?.tx_hash ? stateEntry : null);
  if (saved && !/^0x[a-fA-F0-9]{64}$/u.test(saved.tx_hash ?? '')) throw new Error('Deployment broadcast checkpoint is incomplete; reconcile without signing again');
  return saved;
}
export async function runDeployment(action) {
  ensure(['prepare', 'activate', 'status', 'smoke', 'anchor'].includes(action), 'Use --prepare, --activate, --status, --smoke or --anchor');
  await fs.mkdir(dir, { recursive: true }); await fs.mkdir(evidence, { recursive: true });
  const keyDirectory = process.env.AGENTBL_W5_KEY_DIR || path.join(os.homedir(), '.agentbl', 'w5-2026-10-18');
  await fs.mkdir(keyDirectory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(keyDirectory, 'backup-key.hex');
  let key;
  try { key = Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'hex'); }
  catch (error) {
    if (error.code !== 'ENOENT' || await readJson(path.join(dir, 'signers.json'))) throw error;
    key = randomBytes(32); await fs.writeFile(keyFile, key.toString('hex'), { flag: 'wx', mode: 0o600 });
  }
  ensure(key.length === 32, 'Invalid external backup key');
  const request = new FetchRequest(process.env.INJECTIVE_RPC_URL || 'https://k8s.testnet.json-rpc.injective.network'); request.timeout = 20000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 1000;
  const owner = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const journal = createOwnerJournal(dir);
  try {
    ensure(Number((await provider.getNetwork()).chainId) === 1439, 'Only Injective testnet 1439 is authorized');
    let stored = await readJson(path.join(dir, 'signers.json'));
    if (!stored) {
      ensure(!await readJson(path.join(evidence, 'deployment.json')), 'Deployment signer history is missing; restore the original encrypted research keys');
      ensure(action === 'prepare', 'Prepare deployment first');
      const values = Object.fromEntries(roleNames.map((name) => [name, Wallet.createRandom().privateKey]));
      values.governorA = owner.privateKey;
      stored = seal(key, values, AAD); await writeJsonAtomic(path.join(dir, 'signers.json'), stored, { durable: true });
      const rightsKeyFile = path.join(keyDirectory, 'rights-key.hex');
      try { await fs.writeFile(rightsKeyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const signers = Object.fromEntries(Object.entries(unseal(key, stored, AAD)).map(([name, value]) => [name, new Wallet(value, provider)]));
    ensure(same(signers.governorA.address, owner.address), 'Deployer changed; use the saved authorized signer');
    const actors = Object.fromEntries(Object.entries(signers).map(([name, signer]) => [name, signer.address]));
    const artifacts = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readJson(path.join(root, 'hardhat/artifacts/contracts', `${name}.sol`, `${name}.json`))])));
    ensure(names.every((name) => artifacts[name]?.bytecode), 'Compile contracts first');
    const artifactHashes = Object.fromEntries(names.map((name) => [name, sha(JSON.stringify(artifacts[name]))]));
    const stableHashes = Object.fromEntries(names.map((name) => { const a = artifacts[name]; return [name, sha(JSON.stringify({ abi: a.abi, bytecode: a.bytecode,
      deployedBytecode: a.deployedBytecode, immutableRanges: Object.values(a.immutableReferences ?? {}).flat().sort((x, y) => x.start - y.start).map(({ start, length }) => ({ start, length })) }))]; }));
    let state = await readJson(path.join(evidence, 'deployment.json'));
    const initializedFile = path.join(dir, 'deployment-initialized.json');
    if (!state && await readJson(initializedFile)) throw new Error('Initialized deployment history is missing; restore it before another transaction');
    if (!state) {
      ensure(action === 'prepare', 'Deployment has not been prepared');
      state = { schema: 'agentbl-w5-testnet-deployment-v1', chain_id: 1439, scope: 'research_test_assets_only', business_enabled: false,
        authorization: '2026-10-18 direct user authorization for deployments, transactions, tests, commit and push',
        governance_custody: 'Distinct generated research keys held by one operator; no independent organizations claimed',
        created_at: new Date().toISOString(), actors, artifact_hashes: artifactHashes, contracts: {}, operations: [],
        max_total_transaction_fees_wei: String(parseEther('0.05')), max_test_gas_funding_wei: String(parseEther('0.04')), transactions: [] };
      await writeJsonAtomic(path.join(evidence, 'deployment.json'), state, { durable: true });
    }
    await writeJsonAtomic(initializedFile, { schema: 'agentbl-w5-deployment-initialized-v1' }, { durable: true });
    ensure(JSON.stringify(state.stable_artifact_hashes ?? state.artifact_hashes) === JSON.stringify(state.stable_artifact_hashes ? stableHashes : artifactHashes), 'Contract artifacts changed; do not resume against different code');
    state.stable_artifact_hashes ??= stableHashes;
    ensure(Object.entries(state.actors).every(([role, address]) => same(actors[role], address)), 'Research signer custody differs from the deployed role inventory');
    const save = () => writeJsonAtomic(path.join(evidence, 'deployment.json'), safe(state), { durable: true });
    const txSend = async (label, signer, txRequest) => {
      return journal.withLock('w5-signers', async () => {
        let index = state.transactions.findIndex((tx) => tx.label === label);
        if (index < 0) { index = state.transactions.length; state.transactions.push({ label, signer: signer.address }); await save(); }
        let saved = deploymentCheckpoint(await journal.read('w5', index), state.transactions[index]);
        const expected = { to: txRequest.to ?? null, data: txRequest.data ?? '0x', value: String(txRequest.value ?? 0n), from: signer.address };
        if (saved) ensure(JSON.stringify(saved.expected) === JSON.stringify(expected), `Transaction plan differs: ${label}`);
        if (!saved) {
          const [latest, pending, rawGasPrice] = await Promise.all([provider.getTransactionCount(signer.address, 'latest'), provider.getTransactionCount(signer.address, 'pending'), provider.send('eth_gasPrice', [])]);
          ensure(latest === pending, `Pending signer nonce: ${label}`);
          const gasPrice = BigInt(rawGasPrice); ensure(gasPrice <= 1_000_000_000n, 'Gas price exceeds test ceiling');
          const estimated = await provider.estimateGas({ ...txRequest, from: signer.address });
          const gasLimit = estimated * 13n / 10n + 20000n; ensure(gasLimit <= 30_000_000n, 'Gas exceeds per-transaction ceiling');
          const maximum = state.transactions.reduce((sum, tx) => sum + BigInt(tx.maximum_fee_wei ?? 0), 0n) + gasLimit * gasPrice;
          ensure(maximum <= BigInt(state.max_total_transaction_fees_wei), 'Total gas fee ceiling reached');
          const signed = await signer.signTransaction({ ...txRequest, chainId: 1439, nonce: latest, value: BigInt(expected.value), type: 0, gasPrice, gasLimit });
          saved = { label, expected, nonce: latest, tx_hash: keccak256(signed), status: 'BROADCASTING', maximum_fee_wei: String(gasLimit * gasPrice),
            ...(!txRequest.to ? { contract_address: getCreateAddress({ from: signer.address, nonce: latest }) } : {}) };
          await journal.write('w5', index, saved); state.transactions[index] = saved; await save();
          const sent = await provider.broadcastTransaction(signed);
          ensure(same(sent.hash, saved.tx_hash), 'RPC returned different transaction hash');
          saved.status = 'SUBMITTED'; await journal.write('w5', index, saved); state.transactions[index] = saved; await save();
        }
        let receipt = await provider.getTransactionReceipt(saved.tx_hash) ?? await provider.waitForTransaction(saved.tx_hash, 3, 55000);
        ensure(receipt, `Receipt pending; reconcile ${label} ${saved.tx_hash} without rebroadcast`);
        if (await provider.getBlockNumber() < receipt.blockNumber + 2) receipt = await provider.waitForTransaction(saved.tx_hash, 3, 55000);
        ensure(receipt, `Confirmations pending; reconcile ${label}`);
        const [tx, block] = await Promise.all([provider.getTransaction(saved.tx_hash), provider.getBlock(receipt.blockNumber)]);
        ensure(receipt.status === 1 && block?.hash === receipt.blockHash && tx && same(tx.from, expected.from) && same(tx.to, expected.to)
          && tx.data === expected.data && tx.value === BigInt(expected.value) && tx.nonce === saved.nonce && Number(tx.chainId) === 1439, `Canonical transaction mismatch: ${label}`);
        if (saved.block_hash && saved.block_hash !== receipt.blockHash) saved.receipt_history = [...(saved.receipt_history ?? []),
          { status: saved.status, block_number: saved.block_number, block_hash: saved.block_hash, superseded_at: new Date().toISOString() }];
        Object.assign(saved, { status: 'CONFIRMED', block_number: receipt.blockNumber, block_hash: receipt.blockHash, gas_used: String(receipt.gasUsed), fee_wei: String(receipt.gasUsed * receipt.gasPrice) });
        await journal.write('w5', index, saved); state.transactions[index] = saved; await save();
        console.log(`${label}: ${saved.tx_hash}`);
        return { ...saved, receipt };
      });
    };
    const deploy = async (name, args) => {
      const factory = new ContractFactory(artifacts[name].abi, artifacts[name].bytecode);
      const sent = await txSend(`deploy:${name}`, owner, await factory.getDeployTransaction(...args));
      ensure(same(sent.receipt.contractAddress, sent.contract_address), 'Creation address mismatch');
      state.contracts[name] = sent.contract_address; await save();
      return new Contract(sent.contract_address, artifacts[name].abi, owner);
    };
    const call = (label, contract, method, args, signer = owner) => txSend(label, signer, { to: contract.target, data: contract.interface.encodeFunctionData(method, args) });
    if (action === 'prepare') {
      const funded = BigInt(roleNames.length) * parseEther('0.003'); ensure(funded <= BigInt(state.max_test_gas_funding_wei), 'Funding exceeds ceiling');
      for (const name of roleNames) await txSend(`fund:${name}`, owner, { to: actors[name], value: parseEther('0.003') });
      const governance = await deploy('RightsGovernance', [[owner.address, actors.governorB, actors.governorC], 3600]);
      const hub = await deploy('AssetIdentityHub', [governance.target]);
      const registry = await deploy('CommittedEBLRegistry', [governance.target, hub.target]);
      const controller = await deploy('RightsController', [governance.target, registry.target]);
      const testAsset = await deploy('MockAuthorizationUSDC', []);
      state.contracts.RWAOfferingPoolV5 = await controller.capitalPool(); state.contracts.ControlledRWAToken = await controller.token(); await save();
      await call('activate:controller', controller, 'activate', []);
      const operations = [
        [hub, 'setRegistry', [registry.target, true]], [registry, 'bindController', [controller.target]],
        [registry, 'setIssuer', [id('AGENTBL_W5_SYNTHETIC_ISSUER'), actors.issuer]],
        ...Object.entries({ ISSUER: 'issuer', VALUER: 'valuer', OPERATOR: 'operator', ATTESTOR: 'attestor', COMPLIANCE: 'compliance', DISPOSER: 'disposer', REVIEWER: 'reviewer', GUARDIAN: 'guardian' })
          .map(([role, actor]) => [controller, 'setRole', [id(role), actors[actor], true]]),
        [controller, 'setTestAsset', [testAsset.target, true]], [controller, 'setIntakeStopped', [false, id('W5_AUTHORIZED_RESEARCH_INTAKE')]]
      ];
      for (const [i, [contract, method, args]] of operations.entries()) {
        const data = contract.interface.encodeFunctionData(method, args), salt = id(`agentbl-w5:${governance.target}:${i}`);
        const sent = await call(`governance:propose:${i}`, governance, 'propose', [contract.target, data, salt]);
        const proposed = sent.receipt.logs.map((log) => { try { return governance.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'Proposed');
        ensure(proposed, 'Proposal event missing');
        await call(`governance:approve:${i}`, governance, 'approve', [proposed.args.id], signers.governorB);
        const op = await governance.operations(proposed.args.id);
        state.operations[i] = { id: proposed.args.id, target: contract.target, method, data, eta: String(op.eta) }; await save();
      }
      state.prepared_at ??= new Date().toISOString(); state.ready_after = new Date(Math.max(...state.operations.map((op) => Number(op.eta))) * 1000).toISOString(); await save();
    }
    if (action === 'activate') {
      const governance = new Contract(state.contracts.RightsGovernance, artifacts.RightsGovernance.abi, owner);
      const block = await provider.getBlock('latest');
      ensure(state.operations.length === 13 && state.operations.every((op) => Number(op.eta) <= block.timestamp), `Governance delay still applies until ${state.ready_after}`);
      for (const [i, op] of state.operations.entries()) await call(`governance:execute:${i}`, governance, 'execute', [op.id, op.data]);
      const cfg = { schema: 'agentbl-rights-instance-v1', scope: 'research_test_assets_only', chain_id: 1439,
        rpc_url: 'https://k8s.testnet.json-rpc.injective.network', contracts: state.contracts, actors,
        deployment_block: state.transactions.find((tx) => tx.label === 'deploy:RightsController').block_number };
      const cfgFile = path.join(root, 'public/rights-instance.json'); await writeJsonAtomic(cfgFile, cfg, { durable: true });
      const service = await loadRightsChain(cfgFile);
      try {
        state.verified_binding = await service.verify();
        state.role_readback = Object.fromEntries(await Promise.all(Object.entries({ ISSUER: 'issuer', VALUER: 'valuer', OPERATOR: 'operator', ATTESTOR: 'attestor', COMPLIANCE: 'compliance', DISPOSER: 'disposer', REVIEWER: 'reviewer', GUARDIAN: 'guardian' })
          .map(async ([role, actor]) => [role, { address: actors[actor], enabled: await service.controller.roles(id(role), actors[actor]) }])));
        state.asset_readback = { address: state.contracts.MockAuthorizationUSDC, enabled: await service.controller.testAsset(state.contracts.MockAuthorizationUSDC), intake_stopped: await service.controller.intakeStopped() };
        state.source_readback = await service.registry.issuerForOrg(id('AGENTBL_W5_SYNTHETIC_ISSUER'));
        ensure(Object.values(state.role_readback).every((role) => role.enabled) && state.asset_readback.enabled && !state.asset_readback.intake_stopped
          && same(state.source_readback, actors.issuer), 'Initialized roles, source or test asset differ from the approved plan');
      } finally { await service.provider.destroy(); }
      state.activated_at ??= new Date().toISOString(); await save();
    }
    if (action === 'smoke') {
      ensure(state.activated_at, 'Activate the verified governance configuration first');
      const { runTestnetLifecycle } = await import('./lib/w5-testnet-lifecycle.mjs');
      await runTestnetLifecycle({ state, save, txSend, signers, provider, artifacts, directory: dir, evidence, backupKey: key, keyDirectory });
    }
    if (action === 'anchor') {
      ensure(state.scenario?.passed, 'Finish and reconcile the actual financing scenario before anchoring');
      const { anchorTestnetAcceptance } = await import('./lib/w5-testnet-anchor.mjs');
      await anchorTestnetAcceptance({ state, save, txSend, signers, provider, evidence, directory: dir, keyDirectory });
    }
    if (Object.keys(state.contracts).length) {
      state.bytecode = {};
      for (const [name, address] of Object.entries(state.contracts)) {
        const actual = await provider.getCode(address), artifact = artifacts[name];
        ensure(artifact && maskImmutableBytecode(actual, artifact) === maskImmutableBytecode(artifact.deployedBytecode, artifact), `${name} runtime mismatch`);
        state.bytecode[name] = { address, runtime_keccak256: keccak256(actual), matches_artifact: true };
      }
      await save();
    }
    console.log(JSON.stringify({ action, prepared: Boolean(state.prepared_at), ready_after: state.ready_after, activated: Boolean(state.activated_at), contracts: state.contracts, transactions: state.transactions.length }));
    return state;
  } finally { await provider.destroy(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runDeployment(process.argv[2]?.replace(/^--/u, '')); }
  catch (error) { console.error(error.shortMessage ?? error.message); process.exitCode = 1; }
}
