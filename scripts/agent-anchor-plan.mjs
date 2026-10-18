// No .env, signer resolution or RPC: printable deployment/registration inputs only.
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createAgentVersion } from '../src/agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { readAnchorState } from '../src/agent/runtime/anchoring.js';
import { runtimePath } from '../src/runtimePaths.js';

const { values } = parseArgs({ options: { file: { type: 'string' }, out: { type: 'string' }, 'version-file': { type: 'string' } } });
const state = await readAnchorState(values.file ?? runtimePath('agent-anchors.json'));
const version = values['version-file'] ? JSON.parse(await fs.readFile(values['version-file'], 'utf8')) : createAgentVersion(loadAgentConfig(process.env), process.env);
const versions = [...new Map([...state.live.records.map((record) => record.version), version].map((value) => [value.version_id, value])).values()];
const result = { schema: 'agentbl-anchor-deployment-plan-v1', network: 'injective-testnet', chain_id: 1439,
  deploy_new_contract: 'AgentDecisionLog', existing_contract_mutations: 0,
  confirmation_required: true, versions, transactions: [{ method: 'deploy AgentDecisionLog', signer: 'owner' },
    ...versions.map((version) => ({ method: 'registerAgentVersion', signer: 'owner', version })),
    { method: 'setAnchorer', signer: 'owner', role: 'existing dedicated ANCHORER', allowed: true }],
  live_finalized_decisions: state.live.records.length, broadcasts: 0 };
if (values.out) await fs.writeFile(values.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
