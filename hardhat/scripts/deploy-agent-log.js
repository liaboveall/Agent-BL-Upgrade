// Default is a plan. Actual deployment requires the operator's separately approved confirmation.
import fs from 'node:fs/promises';
import path from 'node:path';
import hre from 'hardhat';
import { Wallet } from 'ethers';
import { createAgentVersion } from '../../src/agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../../src/agent/runtime/config.js';
import { deployAgentLog, validateAgentLogPlan } from '../../scripts/lib/deploy-agent-log.mjs';
import { createOwnerJournal } from '../../scripts/lib/owner-journal.mjs';
import { runtimeDir } from '../../src/runtimePaths.js';

async function main() {
  const version = createAgentVersion(loadAgentConfig(process.env), process.env);
  const file = process.env.AGENT_ANCHOR_DEPLOY_PLAN;
  const plan = file ? JSON.parse(await fs.readFile(file, 'utf8')) : { schema: 'agentbl-anchor-deployment-plan-v1', chain_id: 1439, versions: [version] };
  validateAgentLogPlan(plan);
  if (!plan.versions.some((candidate) => candidate.code_commit === version.code_commit)) throw new Error('Deployment plan does not contain the current runtime source commitment');
  if (process.env.AGENT_ANCHOR_DEPLOY_CONFIRM !== 'true') {
    console.log(JSON.stringify({ dry_run: true, network: 'injective-testnet', plan, expected_transactions: plan.versions.length + 2, broadcasts: 0 }, null, 2)); return;
  }
  const connection = await hre.network.create();
  if (connection.networkName !== 'injective_testnet') throw new Error('Only the approved Injective testnet is supported');
  if (!process.env.PRICING_UPDATER_PRIVATE_KEY) throw new Error('A dedicated PRICING_UPDATER key is required; there is no owner-key fallback');
  const anchorer = new Wallet(process.env.PRICING_UPDATER_PRIVATE_KEY).address;
  const [owner] = await connection.ethers.getSigners();
  const result = await deployAgentLog({ confirmed: true, plan, owner, anchorer, provider: connection.ethers.provider,
    artifact: await hre.artifacts.readArtifact('AgentDecisionLog'), journal: createOwnerJournal(runtimeDir()),
    configPath: path.resolve(import.meta.dirname, '../../public/chain-config.json') });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(() => { console.error('AgentDecisionLog deployment stopped; inspect its local transaction journal and reconcile before retrying.'); process.exitCode = 1; });
