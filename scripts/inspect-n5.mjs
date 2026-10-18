// Public RPC reads and unsigned candidate preparation only. No env loader, wallet, journal or config writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadRightsChain } from '../src/rights/chain.js';
import { readOfferings } from '../src/rights/offerings.js';
import { prepareRightsCandidate } from './prepare-rights-candidate.mjs';
import { releaseRoot, releaseSourceSnapshot, digest } from './lib/release-source.mjs';

const at = new Date().toISOString(), directory = path.resolve(process.argv[2] ?? path.join(releaseRoot, 'artifacts/n5-readonly', at.replaceAll(/[:.]/gu, '-')));
await fs.mkdir(directory, { recursive: true });
const source = await releaseSourceSnapshot(), manifestPath = path.join(releaseRoot, 'public/rights-instance.json');
const raw = await fs.readFile(manifestPath), instance = JSON.parse(raw);
const appPath = path.join(releaseRoot, 'public/application-config.json'), appHash = digest(await fs.readFile(appPath));
const report = { schema: 'agentbl-n5-public-readonly-v1', started_at: at, source_sha256: source.source_sha256, chain_id: instance.chain_id,
  controller: instance.contracts.RightsController, new_candidate_deployed: false, public_broadcasts: 0, private_keys_accessed: false, observations: [] };
let chain, rpcRequests = 0;
try {
  chain = await loadRightsChain(manifestPath);
  chain.provider.on('debug', (event) => { if (event.action === 'sendRpcPayload') rpcRequests += Array.isArray(event.payload) ? event.payload.length : 1; });
  report.bindings = await chain.verify();
  report.control_version = Number(await chain.controller.controlVersion());
  report.predecessor_application_exit_only = report.control_version === 1;
  for (let trial = 0; trial < 5; trial++) {
    const start = performance.now(), before = rpcRequests;
    try {
      const pages = [], ids = [], failures = []; let query = { from: 1, limit: 20 }, page;
      do {
        page = await readOfferings(chain, { controlVersion: report.control_version }, chain.readPool, query);
        ids.push(...page.offerings.map((p) => p.pool_id)); failures.push(...page.failures);
        pages.push({ from: page.from, next_cursor: page.next_cursor, snapshot: page.snapshot, read_metrics: page.read_metrics });
        query = { from: page.next_cursor, limit: 20, block_number: page.snapshot.block_number, block_hash: page.snapshot.block_hash };
      } while (page.next_cursor != null && ids.length < 100);
      report.observations.push({ trial, elapsed_ms: performance.now() - start, actual_json_rpc_requests: rpcRequests - before,
        total_pools: page.total_pools, pool_ids: ids, failures, complete: failures.length === 0 && ids.length === page.total_pools && new Set(ids).size === ids.length, pages });
    } catch (error) { report.observations.push({ trial, elapsed_ms: performance.now() - start, actual_json_rpc_requests: rpcRequests - before, complete: false, code: error.code ?? 'public_read_failed' }); }
  }
  const times = report.observations.map((r) => r.elapsed_ms).sort((a, b) => a - b);
  report.capacity = { trials: times.length, p95_ms: times[Math.ceil(times.length * .95) - 1], error_ratio: report.observations.filter((r) => !r.complete).length / times.length,
    actual_json_rpc_requests: rpcRequests, public_25_pool_capacity_verified: report.observations.every((r) => r.complete && r.total_pools >= 25),
    scope: 'Current predecessor only; five observations are a small read smoke, not a sustained capacity test or new-v2 acceptance' };
  const deployer = instance.actors.governorA;
  const [latest, pending] = await Promise.all([chain.provider.getTransactionCount(deployer, 'latest'), chain.provider.getTransactionCount(deployer, 'pending')]);
  report.candidate_nonce_observation = { deployer, latest, pending, observed_at: new Date().toISOString(), recheck_before_execution: true };
  if (latest === pending) {
    const candidate = await prepareRightsCandidate({ instance_id: `n5-${at.replace(/[^0-9]/gu, '')}`, chain_id: instance.chain_id,
      governance: instance.contracts.RightsGovernance, hub: instance.contracts.AssetIdentityHub, deployer, nonce: latest });
    await fs.writeFile(path.join(directory, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
    report.unsigned_candidate = { file: 'candidate.json', transactions: candidate.transactions.length, contracts: candidate.contracts, broadcast: false, nonce_is_reservation: false };
  }
  report.readonly_verified = report.observations.every((r) => r.complete);
} catch (error) { report.readonly_verified = false; report.error = { code: error.code ?? 'inspection_failed' }; }
finally {
  await chain?.provider.destroy();
  report.source_unchanged = (await releaseSourceSnapshot()).source_sha256 === source.source_sha256;
  report.public_configs_unchanged = digest(await fs.readFile(manifestPath)) === digest(raw) && digest(await fs.readFile(appPath)) === appHash;
  report.completed_at = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ directory, readonly_verified: report.readonly_verified, capacity: report.capacity, candidate: report.unsigned_candidate?.file, error: report.error }));
  process.exitCode = report.readonly_verified && report.source_unchanged && report.public_configs_unchanged ? 0 : 1;
}
