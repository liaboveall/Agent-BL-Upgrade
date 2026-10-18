import fs from 'node:fs/promises';
import path from 'node:path';
import { Contract, ContractFactory, id, keccak256 } from 'ethers';
import { readJson, writeJsonAtomic } from '../../src/lib/jsonStore.js';
import { DecisionLogger, hashSnapshot } from '../../src/agent/decisionLogger.js';
import { createAgentVersion } from '../../src/agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../../src/agent/runtime/config.js';
import { DecisionAnchoring } from '../../src/agent/runtime/anchoring.js';
import { PRIVATE_ANCHOR_SCHEMA } from '../../src/agent/runtime/anchorProof.js';
import { createAnchorChainAdapter } from '../../src/agent/runtime/anchorChain.js';
import { DecisionEvidenceArchive } from '../../src/evidence/archive.js';
import { releaseRoot, releaseSourceSnapshot } from './release-source.mjs';

const ensure = (condition, message) => { if (!condition) throw new Error(message); };
export async function anchorTestnetAcceptance({ state, save, txSend, signers, provider, evidence, directory, keyDirectory }) {
  const artifact = await readJson(path.join(releaseRoot, 'hardhat/artifacts/contracts/AgentDecisionLog.sol/AgentDecisionLog.json'));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode);
  const deployed = await txSend('anchor:deploy', signers.governorA, await factory.getDeployTransaction());
  const address = deployed.contract_address;
  ensure(keccak256(await provider.getCode(address)) === keccak256(artifact.deployedBytecode), 'DecisionLog runtime does not match the final artifact');
  const log = new Contract(address, artifact.abi, provider), source = await releaseSourceSnapshot();
  const config = loadAgentConfig({ AGENT_ANCHOR_ENABLED: 'true', AGENT_ANCHOR_MIN_BATCH: '1', AGENT_ANCHOR_INTERVAL_SEC: '1' });
  const version = createAgentVersion(config, { LLM_MODEL: 'deterministic-research-acceptance-v1' }, `0x${source.source_sha256}`);
  const call = (label, method, args) => txSend(`anchor:${label}:${version.version_id.slice(2, 18)}`, signers.governorA, { to: address, data: log.interface.encodeFunctionData(method, args) });
  await call('register-version', 'registerAgentVersion', [version.version_id, version.policy_hash, version.code_commit, version.model_id]);
  await call('authorize-research-anchorer', 'setAnchorer', [signers.operator.address, true]);
  const appDirectory = path.resolve(directory, '../w5-app'), anchorDirectory = path.join(appDirectory, 'w5-audit');
  const env = { AGENTBL_RIGHTS_KEY: (await fs.readFile(path.join(keyDirectory, 'rights-key.hex'), 'utf8')).trim() };
  const archive = new DecisionEvidenceArchive({ directory: path.join(anchorDirectory, 'evidence-archive'), env });
  const logger = new DecisionLogger({ filePath: path.join(anchorDirectory, 'decisions.json'), agentVersion: version });
  const decisionId = `w5-acceptance-${version.version_id.slice(2, 26)}`;
  let decision = await logger.get(decisionId);
  if (!decision) decision = await logger.record({ decision_id: decisionId, case_id: 'W5_SYNTHETIC_RESEARCH_FINANCING', event_id: id('W5_FINANCING_ACCEPTANCE'),
    action: 'VERIFY_TESTNET_DELIVERY', mode: 'live', status: 'COMPLETED', reasoning_summary: 'Actual testnet financing, failed-raise refund and direct ERC-3009 payment were reconciled; business inputs remain synthetic.',
    evidence_hash: hashSnapshot(state.scenario), input_snapshot: state.scenario, policy: { verdict: 'RESEARCH_TEST_ASSETS_ONLY' },
    execution: { mode: 'chain', tx_hash: state.scenario.normal.claim_tx } });
  const chainConfig = { chainIdDecimal: 1439, rpcUrls: ['https://k8s.testnet.json-rpc.injective.network'], explorerBase: 'https://testnet.blockscout.injective.network',
    contracts: { AgentDecisionLog: address }, deployments: { AgentDecisionLog: { deployTx: deployed.tx_hash, blockNumber: deployed.block_number } } };
  const adapter = createAnchorChainAdapter({ chainConfig, confirmations: 3,
    getContext: async () => ({ provider, log, decisionLog: log, signers: { ANCHORER: signers.operator.address } }) });
  // Production sequence, proof and confirmation logic, with the same durable signed-hash
  // sender used by the deployment CLI. No hash can be lost between signing and broadcast.
  adapter.send = async (batch, assertCurrent, onSubmitted) => {
    assertCurrent();
    const sent = await txSend(`anchor:batch:${batch.version_id}:${batch.batch_id}`, signers.operator,
      { to: address, data: log.interface.encodeFunctionData('anchorBatch', [batch.merkle_root, batch.from_seq, batch.to_seq, batch.count, batch.version_id]) });
    await onSubmitted({ hash: sent.tx_hash }); return { hash: sent.tx_hash };
  };
  const anchoring = new DecisionAnchoring({ file: path.join(anchorDirectory, 'anchors.json'), version, config,
    getMode: () => 'live', logger, adapter, schema: PRIVATE_ANCHOR_SCHEMA, archive });
  try {
    await anchoring.tick();
    const result = await anchoring.get(decisionId, decision);
    ensure(result.state === 'ANCHORED' && result.verification.passed && await adapter.verify(result), 'Actual anchor inclusion or canonical confirmation failed');
    const pack = await archive.get(decisionId, { admin: true }); ensure(pack.verification.passed, 'Private full evidence package unavailable');
    const output = { schema: 'agentbl-w5-testnet-anchor-v1', generated_at: new Date().toISOString(), source_sha256: source.source_sha256,
      code_commit_basis: 'SHA256 of the exact final technical source manifest, independently bound by subsequent git commit and CI',
      scope: 'Research acceptance decision; synthetic business materials, actual testnet receipts; no model-quality or real-world title claim',
      contract: address, deployment: { tx_hash: deployed.tx_hash, block_number: deployed.block_number }, version, proof: result,
      evidence_package_hash: pack.package_hash, evidence_verified: true, coverage: anchoring.status().coverage, passed: true };
    await writeJsonAtomic(path.join(evidence, 'anchor-acceptance.json'), output, { durable: true });
    state.audit_contract = { address, deploy_tx: deployed.tx_hash }; state.anchor = { passed: true, version_id: version.version_id, source_sha256: source.source_sha256, tx_hash: result.batch.tx_hash }; await save();
    console.log(`Actual private-evidence anchor and canonical inclusion: PASS ${result.batch.tx_hash}`);
  } finally { await anchoring.stop(); }
}
