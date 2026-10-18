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
import { unseal } from '../src/rights/vault.js';
import { readJson, writeJsonAtomic } from '../src/lib/jsonStore.js';
import { loadRightsChain } from '../src/rights/chain.js';

const [action, instanceId, confirmation] = process.argv.slice(2);
if (!['prepare', 'activate', 'funding', 'capacity', 'status'].includes(action) || !/^[a-z][a-z0-9-]{2,63}$/u.test(instanceId ?? '')
  || (!['status', 'capacity'].includes(action) && confirmation !== '--execute')) throw new Error('Use deploy-n5-testnet.mjs <prepare|activate|funding|capacity|status> <instance-id> --execute');
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
      candidate.authorization = '2026-10-19 direct user authorization: commits, pushes, deployments and test broadcasts';
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(candidateFile, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
      await fs.writeFile(path.join(directory, 'predecessor-rights.json'), JSON.stringify(predecessor, null, 2) + '\n', { flag: 'wx' });
      await fs.copyFile(path.join(releaseRoot, 'public/application-config.json'), path.join(directory, 'predecessor-application.json'), fs.constants.COPYFILE_EXCL);
    }
    const run = await executeCandidate({ directory, candidate, provider, signers, action: action === 'funding' ? 'status' : action });
    const { state } = run;
    if (action === 'funding') {
      const rightsKey = (await fs.readFile(path.join(keyDirectory, 'rights-key.hex'), 'utf8')).trim();
      await runCandidateFunding({ ...run, directory, candidate, provider, signers, rightsKey });
    }
    const evidence = path.join(releaseRoot, 'artifacts/n5-deployment', instanceId, new Date().toISOString().replaceAll(/[:.]/gu, '-'));
    await fs.mkdir(evidence, { recursive: true });
    await writeJsonAtomic(path.join(evidence, 'deployment.json'), state);
    if (state.active) {
      const chain = await loadRightsChain(path.join(directory, 'rights-instance.json'));
      const bindings = await chain.verify(); await chain.provider.destroy();
      await writeJsonAtomic(path.join(evidence, 'bindings.json'), bindings);
    }
    console.log(JSON.stringify({ directory, evidence, active: state.active, ready_after: state.ready_after, transactions: state.transactions.length }));
  }
} catch (error) {
  // Do not serialize provider request objects or configuration containing credentials.
  console.error(`N5 deployment stopped: ${error.shortMessage ?? error.message}`); process.exitCode = 1;
} finally { await provider.destroy(); }
