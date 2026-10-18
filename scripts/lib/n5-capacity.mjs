import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadRightsChain } from '../../src/rights/chain.js';
import { readOfferings } from '../../src/rights/offerings.js';
import { releaseSourceSnapshot } from './release-source.mjs';

export async function measureCandidateCapacity({ manifest, directory, seconds = 600 }) {
  const source = await releaseSourceSnapshot(), chain = await loadRightsChain(manifest), observations = [];
  const chainId = Number(chain.chainId), startedAt = new Date().toISOString();
  let requests = 0;
  chain.provider.on('debug', (event) => { if (event.action === 'sendRpcPayload') requests += Array.isArray(event.payload) ? event.payload.length : 1; });
  const start = performance.now();
  try {
    while (performance.now() - start < seconds * 1000 || observations.length < 5) {
      const begin = performance.now(), before = requests, ids = [], snapshots = [], pages = [];
      try {
        let query = { from: 1, limit: 10 }, result;
        do {
          result = await readOfferings(chain, { controlVersion: 2 }, chain.readPool, query);
          ensure(result.complete, 'Page incomplete');
          ids.push(...result.offerings.map((row) => row.pool_id)); snapshots.push(result.snapshot.block_hash);
          pages.push({ from: result.from, calls: result.read_metrics.calls, failures: result.failures });
          query = { from: result.next_cursor, limit: 10, block_number: result.snapshot.block_number, block_hash: result.snapshot.block_hash };
        } while (result.next_cursor != null);
        ensure(ids.length === result.total_pools && ids.length >= 25 && new Set(ids).size === ids.length && new Set(snapshots).size === 1, 'Pool list incomplete or inconsistent');
        observations.push({ elapsed_ms: performance.now() - begin, requests: requests - before, pools: ids.length, complete: true, pages, snapshot_hash: snapshots[0] });
      } catch (error) { observations.push({ elapsed_ms: performance.now() - begin, requests: requests - before, complete: false, code: error.code ?? 'read_failed' }); }
      console.log(`N5 chain ${chainId} read ${observations.length}: ${observations.at(-1).complete ? 'PASS' : 'FAIL'}`);
    }
  } finally { await chain.provider.destroy(); }
  const elapsed = performance.now() - start, times = observations.map((row) => row.elapsed_ms).sort((a, b) => a - b);
  const report = { schema: 'agentbl-n5-chain-capacity-v1', chain_id: chainId, public_testnet: chainId === 1439, started_at: startedAt,
    base_head: source.base_head, source_sha256: source.source_sha256, elapsed_ms: elapsed, target_seconds: seconds,
    observations, actual_json_rpc_requests: requests, p95_ms: times[Math.ceil(times.length * .95) - 1],
    error_ratio: observations.filter((row) => !row.complete).length / observations.length, real_business: false, public_broadcasts: 0,
    rpc_count_scope: 'Measurement queries only; manifest and runtime bootstrap excluded',
    scope: 'Sequential full 25+ pool reads against the configured chain RPC; no concurrency, independent organizations or commercial SLA claimed' };
  report.passed = elapsed >= seconds * 1000 && observations.length >= 5 && report.error_ratio === 0;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'capacity.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}
function ensure(value, message) { if (!value) throw new Error(message); }
