import { Contract, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';
import fs from 'node:fs/promises';
import chainConfigLib from './chain-config.cjs';
import { stableStringify } from '../../src/agent/decisionLogger.js';

const equal = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
export function validateAgentLogPlan(plan) {
  if (plan?.schema !== 'agentbl-anchor-deployment-plan-v1' || plan.chain_id !== 1439 || !Array.isArray(plan.versions) || !plan.versions.length || plan.versions.length > 64) throw new Error('Invalid deployment plan');
  for (const { version_id, ...version } of plan.versions) {
    if (!/^0x[0-9a-f]{64}$/u.test(version.policy_hash) || !/^0x[0-9a-f]{64}$/u.test(version.code_commit)
      || typeof version.model_id !== 'string' || !version.model_id.length || toUtf8Bytes(version.model_id).length > 128
      || keccak256(toUtf8Bytes(stableStringify(version))) !== version_id) throw new Error('Invalid agent version commitment');
  }
  return plan;
}

export async function deployAgentLog({ confirmed = false, plan, owner, anchorer, provider, artifact, journal, configPath, expectedChainId = 1439 }) {
  validateAgentLogPlan(plan);
  if (!confirmed) return { dry_run: true, plan, broadcasts: 0 };
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== expectedChainId || !/^0x[0-9a-fA-F]{40}$/u.test(anchorer ?? '')) throw new Error('Deployment network or anchorer is invalid');
  const original = JSON.parse(await fs.readFile(configPath, 'utf8'));
  chainConfigLib.assertRegistry(original);
  const from = await owner.getAddress();
  let sent = 0;
  return journal.withLock('agent-log-deploy', async () => {
    const send = async (index, request) => {
      let saved = await journal.read('agent-log-deploy', index);
      const expected = { from, to: request.to ?? null, data: request.data, value: '0', chain_id: expectedChainId };
      if (saved && stableStringify(saved.expected) !== stableStringify(expected)) throw new Error('Deployment journal differs from the reviewed plan');
      if (!saved) {
        const nonce = await provider.getTransactionCount(from, 'pending');
        saved = { status: 'BROADCASTING', expected, nonce, ...(request.to ? {} : { address: getCreateAddress({ from, nonce }) }) };
        await journal.write('agent-log-deploy', index, saved);
        const tx = await owner.sendTransaction({ ...request, nonce, value: 0n });
        sent++;
        saved = { ...saved, status: 'SUBMITTED', tx_hash: tx.hash };
        await journal.write('agent-log-deploy', index, saved);
      }
      if (!saved.tx_hash) throw new Error('Uncertain deployment broadcast requires operator reconciliation; it will not be resent');
      const receipt = await provider.getTransactionReceipt(saved.tx_hash) ?? await provider.waitForTransaction(saved.tx_hash, 1, 30_000);
      if (!receipt) throw new Error('Deployment receipt is pending; rerun to reconcile the same hash');
      const tx = await provider.getTransaction(saved.tx_hash), block = await provider.getBlock(receipt.blockNumber);
      if (receipt.status !== 1 || !block || !equal(block.hash, receipt.blockHash) || !tx || !equal(tx.from, from)
        || !equal(tx.to, expected.to) || !equal(tx.data, expected.data) || Number(tx.chainId) !== expectedChainId
        || tx.nonce !== saved.nonce || tx.value !== 0n) throw new Error('Deployment transaction verification failed');
      await journal.write('agent-log-deploy', index, { ...saved, status: 'CONFIRMED', block_number: receipt.blockNumber, block_hash: receipt.blockHash });
      return { ...saved, receipt };
    };
    const existing = original.networks['injective-testnet'].contracts.AgentDecisionLog;
    if (existing && !(await journal.read('agent-log-deploy', 0))) throw new Error('AgentDecisionLog is already configured; refusing to deploy a replacement');
    const deployment = await send(0, { data: artifact.bytecode });
    const address = deployment.address;
    if (!equal(deployment.receipt.contractAddress, address) || await provider.getCode(address) === '0x' || existing && !equal(existing, address)) throw new Error('Deployed address does not match the plan');
    const log = new Contract(address, artifact.abi, owner);
    if (!equal(await log.owner(), from)) throw new Error('Unexpected decision-log owner');
    const initializations = [];
    for (const [i, version] of plan.versions.entries()) {
      const args = [version.version_id, version.policy_hash, version.code_commit, version.model_id];
      const prior = await log.versions(version.version_id);
      const checkpoint = await journal.read('agent-log-deploy', i + 1);
      if (!prior.registeredAt || checkpoint) {
        const request = await log.registerAgentVersion.populateTransaction(...args);
        const result = await send(i + 1, request); initializations.push(result.tx_hash);
      }
      const registered = await log.versions(version.version_id);
      if (!equal(registered.policyHash, version.policy_hash) || !equal(registered.codeCommit, version.code_commit) || registered.modelId !== version.model_id) throw new Error('Registered version does not match the plan');
    }
    const roleIndex = plan.versions.length + 1;
    if (!await log.anchorers(anchorer) || await journal.read('agent-log-deploy', roleIndex)) {
      const result = await send(roleIndex, await log.setAnchorer.populateTransaction(anchorer, true)); initializations.push(result.tx_hash);
    }
    if (!await log.anchorers(anchorer)) throw new Error('Anchorer initialization failed');
    // Merge only after every confirmed initialization; preserve all six existing contracts verbatim.
    const current = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (stableStringify(current) !== stableStringify(original)) throw new Error('Chain registry changed during deployment; reconcile before merging');
    const registry = chainConfigLib.mergeNetworkConfig(current, 'injective-testnet', {
      contracts: { AgentDecisionLog: address }, abis: { AgentDecisionLog: artifact.abi },
      deployments: { AgentDecisionLog: { address, deployTx: deployment.tx_hash, deployedAt: new Date().toISOString(),
        blockNumber: deployment.receipt.blockNumber, initializations, versions: plan.versions } }
    });
    chainConfigLib.atomicWriteRegistry(configPath, registry);
    return { dry_run: false, address, deploy_tx: deployment.tx_hash, initializations, broadcasts: sent };
  });
}
