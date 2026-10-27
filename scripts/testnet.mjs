// Explicit execution only, against the existing research governance and identity hub.
import '../src/env.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JsonRpcProvider, FetchRequest, Wallet } from 'ethers';
import { prepareRightsCandidate } from './prepare-rights-candidate.mjs';
import { releaseRoot, releaseSourceSnapshot } from './lib/release-source.mjs';
import { executeCandidate } from './lib/n5-deployment.mjs';
import { runCandidateFunding } from './lib/n5-funding.mjs';
import { measureCandidateCapacity } from './lib/n5-capacity.mjs';
import { ACCEPTANCE_STAGES, acceptancePlan, runAcceptance } from './lib/n5-acceptance.mjs';
import { unseal } from '../src/rights/vault.js';
import { readJson, writeJsonAtomic } from '../src/lib/jsonStore.js';
import { loadRightsChain } from '../src/rights/chain.js';

const [action, instanceId, ...rest] = process.argv.slice(2);
// acceptance takes a stage: plan is a keyless dry run, the other stages sign like funding.
const stage = action === 'acceptance' ? rest.shift() : null, [confirmation] = rest;
if (!['prepare', 'activate', 'funding', 'capacity', 'status', 'acceptance'].includes(action) || !/^[a-z][a-z0-9-]{2,63}$/u.test(instanceId ?? '')
  || (action === 'acceptance' && !ACCEPTANCE_STAGES.includes(stage))
  || (!['status', 'capacity'].includes(action) && stage !== 'plan' && confirmation !== '--execute')) {
  throw new Error('Use testnet.mjs <prepare|activate|funding|capacity|status> <instance-id> --execute, or testnet.mjs acceptance <instance-id> <plan|prepare|screening|repay> [--execute]');
}
const directory = path.join(releaseRoot, 'data/runtime/n5-deployment', instanceId);
const candidateFile = path.join(directory, 'candidate.json');
const predecessor = await readJson(path.join(releaseRoot, 'public/rights-instance.json'));
const rpc = new FetchRequest(process.env.INJECTIVE_RPC_URL || predecessor.rpc_url); rpc.timeout = 20000;
const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 1000;
try {
  if (Number((await provider.getNetwork()).chainId) !== 1439) throw new Error('Only Injective research testnet 1439 is authorized');
  if (action === 'capacity') {
    const result = await measureCandidateCapacity({ manifest: path.join(directory, 'rights-instance.json'),
      directory: path.join(releaseRoot, 'artifacts/n5-capacity', instanceId, new Date().toISOString().replaceAll(/[:.]/gu, '-')) });
    console.log(JSON.stringify({ passed: result.passed, p95_ms: result.p95_ms, error_ratio: result.error_ratio, trials: result.observations.length }));
    process.exitCode = result.passed ? 0 : 1;
  } else if (action === 'status') {
    const state = await readJson(path.join(directory, 'deployment-state.json'));
    if (!state) throw new Error('Candidate state missing');
    console.log(JSON.stringify({ instance_id: instanceId, active: state.active, ready_after: state.ready_after,
      confirmed_transactions: state.transactions.filter((tx) => tx.status === 'CONFIRMED').length, contracts: state.contracts }));
  } else if (stage === 'plan') {
    const [state, candidate, input] = await Promise.all(['deployment-state.json', 'candidate.json', 'acceptance-input.json'].map((name) => readJson(path.join(directory, name))));
    if (!state || !candidate || !input) throw new Error('Deployment state, candidate and acceptance-input.json are required');
    console.log(JSON.stringify(await acceptancePlan({ state, candidate, provider, input }), null, 2));
  } else {
    if (execFileSync('git', ['status', '--porcelain'], { cwd: releaseRoot }).toString().trim()) throw new Error('Commit and verify the release before external signing');
    const source = await releaseSourceSnapshot();
    const ciFile = path.join(releaseRoot, 'artifacts/n5-publish', source.base_head, 'ci.json');
    const ci = await readJson(ciFile);
    if (!ci || ci.headSha !== source.base_head || ci.conclusion !== 'success'
      || ci.jobs.filter((job) => job.conclusion === 'success').length !== 15
      || ci.jobs.some((job) => !['success', 'skipped'].includes(job.conclusion))) throw new Error('Require the 15-job same-commit CI receipt before external signing');
    const previousChain = await loadRightsChain(path.join(releaseRoot, 'public/rights-instance.json'));
    await previousChain.provider.destroy();
    const keyDirectory = process.env.AGENTBL_W5_KEY_DIR || path.join(os.homedir(), '.agentbl/w5-2026-10-18');
    const backupKey = Buffer.from((await fs.readFile(path.join(keyDirectory, 'backup-key.hex'), 'utf8')).trim(), 'hex');
    const encrypted = await readJson(path.join(releaseRoot, 'data/runtime/w5-deployment/signers.json'));
    const keys = unseal(backupKey, encrypted, 'agentbl-w5-research-signers-v1');
    const signers = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, new Wallet(key, provider)]));
    if (signers.governorA.address.toLowerCase() !== predecessor.actors.governorA.toLowerCase()) throw new Error('Saved research deployer changed');
    let candidate = await readJson(candidateFile);
    if (!candidate) {
      if (action !== 'prepare') throw new Error('Prepare candidate first');
      const [latest, pending] = await Promise.all([provider.getTransactionCount(signers.governorA.address, 'latest'), provider.getTransactionCount(signers.governorA.address, 'pending')]);
      if (latest !== pending) throw new Error('Deployer nonce unresolved');
      candidate = await prepareRightsCandidate({ instance_id: instanceId, chain_id: 1439, governance: predecessor.contracts.RightsGovernance,
        hub: predecessor.contracts.AssetIdentityHub, deployer: signers.governorA.address, nonce: latest });
      candidate.contracts.MockAuthorizationUSDC = predecessor.contracts.MockAuthorizationUSDC;
      candidate.artifacts.MockAuthorizationUSDC = await readJson(path.join(releaseRoot, 'hardhat/artifacts/contracts/MockAuthorizationUSDC.sol/MockAuthorizationUSDC.json'));
      candidate.authorization = `${new Date().toISOString().slice(0, 10)} direct user authorization: control version ${candidate.control_version} commits, pushes, deployment and activation`;
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(candidateFile, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
      await fs.writeFile(path.join(directory, 'predecessor-rights.json'), JSON.stringify(predecessor, null, 2) + '\n', { flag: 'wx' });
      await fs.copyFile(path.join(releaseRoot, 'public/application-config.json'), path.join(directory, 'predecessor-application.json'), fs.constants.COPYFILE_EXCL);
    }
    const run = await executeCandidate({ directory, candidate, provider, signers, action: ['funding', 'acceptance'].includes(action) ? 'status' : action });
    const { state } = run;
    if (action === 'funding') {
      const rightsKey = (await fs.readFile(path.join(keyDirectory, 'rights-key.hex'), 'utf8')).trim();
      await runCandidateFunding({ ...run, directory, candidate, provider, signers, rightsKey });
    }
    if (action === 'acceptance') {
      const input = await readJson(path.join(directory, 'acceptance-input.json'));
      if (!input) throw new Error('Write acceptance-input.json in the instance directory first');
      // Only prepare writes the rights vault, so only prepare reads its key.
      const rightsKey = stage === 'prepare' ? (await fs.readFile(path.join(keyDirectory, 'rights-key.hex'), 'utf8')).trim() : null;
      await runAcceptance({ ...run, directory, candidate, provider, signers, rightsKey, input, stage });
    }
    const evidence = path.join(releaseRoot, 'artifacts/n5-deployment', instanceId, new Date().toISOString().replaceAll(/[:.]/gu, '-'));
    await fs.mkdir(evidence, { recursive: true });
    await writeJsonAtomic(path.join(evidence, 'deployment.json'), state);
    if (state.active) {
      const chain = await loadRightsChain(path.join(directory, 'rights-instance.json'));
      const bindings = await chain.verify(); await chain.provider.destroy();
      await writeJsonAtomic(path.join(evidence, 'bindings.json'), bindings);
    }
    const scenarios = state.funding?.scenarios;
    const funding = scenarios ? { passed: state.funding.passed === true, normal: scenarios.normal?.passed === true,
      refund: scenarios.refund?.passed === true, loss: scenarios.loss?.passed === true,
      pending: [['refund', scenarios.refund?.wait_until], ['loss', scenarios.loss?.notice_until ?? scenarios.loss?.maturity_wait_until]]
        .filter(([name, until]) => !scenarios[name]?.passed && until).map(([path, not_before]) => ({ path, not_before })) } : undefined;
    const acceptance = action === 'acceptance' ? Object.fromEntries(Object.entries(state.acceptance.runs).map(([key, value]) => [key, {
      pools: Object.fromEntries(Object.entries(value.scenarios).map(([tag, p]) => [tag, p.pool_id ?? null])),
      subjects: Object.fromEntries(Object.entries(value.investors).map(([label, investor]) => [label, investor.subject_id])), normal_settled: value.scenarios.normal?.settled === true }])) : null;
    console.log(JSON.stringify({ directory, evidence, active: state.active, ready_after: state.ready_after, transactions: state.transactions.length,
      ...(funding ? { funding, funding_status: funding.passed ? 'VERIFIED' : funding.pending.length ? 'WAITING_FOR_CHAIN_TIME' : 'IN_PROGRESS' } : {}),
      ...(acceptance ? { acceptance } : {}) }));
  }
} catch (error) {
  // Do not serialize provider request objects or configuration containing credentials.
  console.error(`N5 deployment stopped: ${error.shortMessage ?? error.message}`); process.exitCode = 1;
} finally { await provider.destroy(); }
