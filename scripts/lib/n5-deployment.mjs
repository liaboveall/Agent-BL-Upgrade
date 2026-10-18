import fs from 'node:fs/promises';
import path from 'node:path';
import { Contract, getCreateAddress, id, keccak256, parseEther } from 'ethers';
import { readJson, writeJsonAtomic } from '../../src/lib/jsonStore.js';
import { maskImmutableBytecode } from '../../src/rights/chain.js';
import { createOwnerJournal } from './owner-journal.mjs';
import { digest } from './release-source.mjs';

const ensure = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const safe = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));

// Persist the original hash before RPC submission. A lost response is reconciled,
// never signed or sent a second time. This journal is separate from every v1 run.
export function candidateSender({ directory, state, save, provider, chainId, confirmations = 3, timeout = 55000 }) {
  const journal = createOwnerJournal(directory);
  return async (label, signer, request) => journal.withLock('n5-signers', async () => {
    ensure(Number((await provider.getNetwork()).chainId) === chainId && [1439, 31337].includes(chainId), 'Unexpected test chain');
    const expected = { from: signer.address, to: request.to ?? null, data: request.data ?? '0x', value: String(request.value ?? 0) };
    let index = state.transactions.findIndex((tx) => tx.label === label);
    if (index < 0) { index = state.transactions.length; state.transactions.push({ label }); await save(); }
    const durable = await journal.read('n5', index), entry = state.transactions[index];
    ensure(!durable?.tx_hash || !entry.tx_hash || same(durable.tx_hash, entry.tx_hash), 'Transaction checkpoints disagree');
    let tx = durable ?? entry;
    if (tx.tx_hash) {
      ensure(JSON.stringify(tx.expected) === JSON.stringify(expected), 'Saved transaction payload differs');
      ensure(request.nonce == null || request.nonce === tx.nonce, 'Saved nonce differs');
    } else {
      const [latest, pending, price] = await Promise.all([provider.getTransactionCount(signer.address, 'latest'), provider.getTransactionCount(signer.address, 'pending'), provider.send('eth_gasPrice', [])]);
      ensure(latest === pending && (request.nonce == null || latest === request.nonce), 'Nonce changed or has an unresolved transaction');
      const gasPrice = BigInt(price); ensure(gasPrice <= (chainId === 31337 ? 2_000_000_000n : 1_000_000_000n), 'Test gas price ceiling exceeded');
      const gasLimit = (await provider.estimateGas({ ...request, from: signer.address })) * 13n / 10n + 20000n;
      ensure(gasLimit <= 30000000n, 'Test transaction gas ceiling exceeded');
      const spent = state.transactions.reduce((sum, item) => sum + BigInt(item.maximum_fee_wei ?? 0), 0n);
      ensure(spent + gasLimit * gasPrice <= BigInt(state.max_total_transaction_fees_wei ?? parseEther('0.05')), 'Candidate gas budget exceeded');
      const signed = await signer.signTransaction({ ...request, chainId, nonce: latest, type: 0, gasPrice, gasLimit });
      tx = { label, expected, nonce: latest, tx_hash: keccak256(signed), status: 'BROADCASTING', maximum_fee_wei: String(gasLimit * gasPrice) };
      if (!request.to) tx.contract_address = getCreateAddress({ from: signer.address, nonce: latest });
      await journal.write('n5', index, tx); state.transactions[index] = tx; await save();
      const sent = await provider.broadcastTransaction(signed);
      ensure(same(sent.hash, tx.tx_hash), 'Unexpected RPC transaction hash');
      tx.status = 'SUBMITTED'; await journal.write('n5', index, tx); state.transactions[index] = tx; await save();
    }
    let receipt = await provider.getTransactionReceipt(tx.tx_hash);
    if (!receipt || await receipt.confirmations() < confirmations) receipt = await provider.waitForTransaction(tx.tx_hash, confirmations, timeout);
    ensure(receipt, `Original transaction unresolved: ${label} ${tx.tx_hash}`);
    const [original, block] = await Promise.all([provider.getTransaction(tx.tx_hash), provider.getBlock(receipt.blockNumber)]);
    ensure(receipt.status === 1 && block?.hash === receipt.blockHash && original && same(original.from, expected.from)
      && same(original.to, expected.to) && original.data === expected.data && original.value === BigInt(expected.value)
      && original.nonce === tx.nonce && Number(original.chainId) === chainId, `Canonical transaction mismatch: ${label}`);
    if (tx.block_hash && tx.block_hash !== receipt.blockHash) tx.receipt_history = [...(tx.receipt_history ?? []), { block_hash: tx.block_hash, block_number: tx.block_number }];
    Object.assign(tx, { status: 'CONFIRMED', block_hash: receipt.blockHash, block_number: receipt.blockNumber, gas_used: String(receipt.gasUsed), fee_wei: String(receipt.gasUsed * receipt.gasPrice) });
    await journal.write('n5', index, tx); state.transactions[index] = tx; await save();
    console.log(`${label}: ${tx.tx_hash}`);
    return { ...tx, receipt };
  });
}

export async function candidateRuntime(provider, candidate, state) {
  const observations = {};
  for (const [name, address] of Object.entries(state.contracts)) {
    const artifact = candidate.artifacts[name];
    if (!artifact) continue;
    const code = await provider.getCode(address);
    ensure(maskImmutableBytecode(code, artifact) === maskImmutableBytecode(artifact.deployedBytecode, artifact), `Runtime differs: ${name}`);
    observations[name] = { address, bytes: (code.length - 2) / 2, sha256: digest(code) };
  }
  const pool = new Contract(state.contracts.RWAOfferingPoolV5, candidate.artifacts.RWAOfferingPoolV5.abi, provider);
  const address = await pool.recoveryRights(), artifact = candidate.artifacts.RecoveryEntitlements, code = await provider.getCode(address);
  ensure(maskImmutableBytecode(code, artifact) === maskImmutableBytecode(artifact.deployedBytecode, artifact), 'Recovery runtime differs');
  ensure(same(await new Contract(address, artifact.abi, provider).pool(), pool.target), 'Recovery rights bound to another pool');
  observations.RecoveryEntitlements = { address, bytes: (code.length - 2) / 2, sha256: digest(code) };
  state.runtime = observations;
  return observations;
}

export async function executeCandidate({ directory, candidate, provider, signers, action, confirmations = 3 }) {
  ensure(['prepare', 'activate', 'status'].includes(action), 'Unknown candidate action');
  const chainId = candidate.chain_id;
  ensure([1439, 31337].includes(chainId) && Number((await provider.getNetwork()).chainId) === chainId, 'Unexpected test chain');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'deployment-state.json');
  let state = await readJson(file);
  const identity = digest(JSON.stringify(candidate));
  if (!state) {
    ensure(action === 'prepare', 'Prepare candidate first');
    state = { schema: 'agentbl-n5-deployment-v2', candidate_sha256: identity, source: candidate.source, chain_id: chainId,
      instance_id: candidate.instance_id, contracts: { ...candidate.contracts }, actors: Object.fromEntries(Object.entries(signers).map(([key, value]) => [key, value.address])),
      transactions: [], operations: [], max_total_transaction_fees_wei: String(parseEther('0.05')), created_at: new Date().toISOString(), active: false };
  }
  ensure(state.candidate_sha256 === identity, 'Saved candidate changed; retain the original candidate and journal');
  ensure(Object.entries(state.actors).every(([name, address]) => same(signers[name]?.address, address)), 'Candidate signer custody changed');
  const save = () => writeJsonAtomic(file, safe(state), { durable: true });
  await save();
  const txSend = candidateSender({ directory, state, save, provider, chainId, confirmations });
  const contract = (name) => new Contract(state.contracts[name], candidate.artifacts[name].abi, provider);
  const call = (label, target, method, args, actor = 'governorA') => txSend(label, signers[actor], { to: target.target, data: target.interface.encodeFunctionData(method, args) });
  const governance = contract('RightsGovernance');
  ensure(await governance.member(signers.governorA.address) && await governance.member(signers.governorB.address)
    && await governance.memberCount() >= 3n && await governance.delay() >= 3600n, 'Shared governance changed');
  const hub = contract('AssetIdentityHub');
  ensure(same(await hub.governance(), governance.target), 'Shared hub governance changed');
  if (action === 'prepare') {
    for (const tx of candidate.transactions) {
      const { label, expected_address, from: _from, chainId: _chainId, ...request } = tx;
      const sent = await txSend(label, signers.governorA, { ...request, value: BigInt(request.value) });
      if (expected_address) ensure(same(sent.receipt.contractAddress, expected_address), 'Deployment address changed');
    }
    const controller = contract('RightsController'), registry = contract('CommittedEBLRegistry');
    await candidateRuntime(provider, candidate, state);
    // Reuse the predecessor's explicitly labelled research token. No old pool is changed.
    ensure(state.contracts.MockAuthorizationUSDC && await provider.getCode(state.contracts.MockAuthorizationUSDC) !== '0x', 'Research settlement token missing');
    const operations = [
      [hub, 'setRegistry', [registry.target, true]], [registry, 'bindController', [controller.target]],
      [registry, 'setIssuer', [id('AGENTBL_N5_SYNTHETIC_ISSUER'), signers.issuer.address]],
      ...Object.entries({ ISSUER: 'issuer', VALUER: 'valuer', OPERATOR: 'operator', ATTESTOR: 'attestor', COMPLIANCE: 'compliance', DISPOSER: 'disposer', REVIEWER: 'reviewer', GUARDIAN: 'guardian' })
        .map(([role, actor]) => [controller, 'setRole', [id(role), signers[actor].address, true]]),
      [controller, 'setTestAsset', [state.contracts.MockAuthorizationUSDC, true]],
      [controller, 'setIntakeStopped', [false, id(`N5_AUTHORIZED_RESEARCH:${candidate.instance_id}`)]]
    ];
    for (const [index, [target, method, args]] of operations.entries()) {
      const data = target.interface.encodeFunctionData(method, args), salt = id(`n5:${candidate.instance_id}:${index}`);
      const sent = await call(`governance:propose:${index}`, governance, 'propose', [target.target, data, salt]);
      const proposed = sent.receipt.logs.map((log) => { try { return governance.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'Proposed');
      ensure(proposed, 'Governance proposal receipt missing');
      await call(`governance:approve:${index}`, governance, 'approve', [proposed.args.id], 'governorB');
      const op = await governance.operations(proposed.args.id);
      state.operations[index] = { id: proposed.args.id, target: target.target, method, data, eta: String(op.eta), epoch: String(op.epoch) }; await save();
    }
    state.prepared_at ??= new Date().toISOString();
    state.ready_after = new Date(Math.max(...state.operations.map((op) => Number(op.eta))) * 1000).toISOString(); await save();
  }
  if (action === 'activate') {
    ensure(state.operations.length === 13, 'Governance preparation incomplete');
    const now = (await provider.getBlock('latest')).timestamp;
    ensure(state.operations.every((op) => Number(op.eta) <= now), `Governance delay applies until ${state.ready_after}`);
    for (const [index, op] of state.operations.entries()) {
      const actual = await governance.operations(op.id);
      ensure(actual.epoch === await governance.epoch() && actual.approvals === 2n && same(actual.target, op.target) && actual.dataHash === keccak256(op.data), 'Governance approval changed');
      await call(`governance:execute:${index}`, governance, 'execute', [op.id, op.data]);
    }
    await candidateRuntime(provider, candidate, state);
    state.active = true; state.activated_at ??= new Date().toISOString(); await save();
  }
  const manifest = { schema: 'agentbl-rights-instance-v1', scope: 'research_test_assets_only', control_version: 2, instance_id: candidate.instance_id,
    chain_id: chainId, rpc_url: candidate.rpc_url ?? candidate.predecessor.manifest.rpc_url, contracts: state.contracts, actors: state.actors,
    deployment_block: state.transactions.find((tx) => tx.label === 'deploy:RightsController')?.block_number };
  await writeJsonAtomic(path.join(directory, 'rights-instance.json'), manifest, { durable: true });
  return { state, manifest, txSend, save };
}
