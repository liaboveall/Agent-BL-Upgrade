import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Ledger } from '../src/ledger/ledger.js';

const args = process.argv.slice(2), outputIndex = args.indexOf('--output');
const output = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : `artifacts/load/${new Date().toISOString().replaceAll(/[:.]/gu, '-')}.json`);
const soakSeconds = Number(args.includes('--soak-seconds') ? args[args.indexOf('--soak-seconds') + 1] : 600);
if (!Number.isInteger(soakSeconds) || soakSeconds < 1 || soakSeconds > 3600) throw new Error('Invalid soak duration');
const root = path.resolve(import.meta.dirname, '..'), runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-w5-load-'));
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
const env = { ...process.env, NODE_TEST_CONTEXT: 'w5-load-offline', DEMO_MODE: 'true', X402_MODE: 'demo', REAL_DATA: 'off',
  AGENTBL_RUNTIME_DIR: runtime, AGENTBL_OPS_INTERVAL_MS: '1000', AGENTBL_RATE_LIMIT_PER_MIN: '0', AGENTBL_WRITE_RATE_LIMIT_PER_MIN: '0',
  AGENT_ANCHOR_ENABLED: 'false', AGENT_DOCUMENT_LLM: 'false', AGENT_VALUATION_LLM: 'false', PORT: String(port), HOST: '127.0.0.1', AGENTBL_ADMIN_TOKEN: 'w5-isolated-capacity-test-operator' };
for (const key of Object.keys(env)) if (/PRIVATE_KEY|API_KEY|AGENTBL_RIGHTS|ALERT_WEBHOOK/u.test(key)) delete env[key];
const child = spawn(process.execPath, ['src/app/server.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = ''; child.stdout.on('data', (chunk) => { serverOutput += chunk; }); child.stderr.on('data', (chunk) => { serverOutput += chunk; });
const origin = `http://127.0.0.1:${port}`, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = { schema: 'agentbl-w5-capacity-v1', started_at: new Date().toISOString(), scope: 'isolated offline Demo HTTP and durable ledger, no provider or chain writes',
  machine: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length },
  rate_limits_disabled_for_capacity_measurement: true,
  targets: { concurrency: 20, requests: 2000, max_error_ratio: 0.01, p95_ms: 1000, soak_seconds: soakSeconds, recovery_rto_seconds: 300 }, live_transactions: false };
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error('Isolated capacity process exited before readiness');
    try { if ((await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await delay(200);
  }
  if (!ready) throw new Error('Capacity process did not become ready');
  const routes = ['/api/ready', '/api/health', '/api/cases', '/api/market/listings', '/api/agent/status', '/'];
  const latencies = []; let failures = 0, index = 0; const started = performance.now();
  await Promise.all(Array.from({ length: 20 }, async () => {
    while (index < 2000) {
      const n = index++, before = performance.now();
      try { const response = await fetch(origin + routes[n % routes.length], { signal: AbortSignal.timeout(5000) }); await response.arrayBuffer(); if (!response.ok) failures++; }
      catch { failures++; } latencies.push(performance.now() - before);
    }
  }));
  latencies.sort((a, b) => a - b);
  result.http = { requests: latencies.length, failures, duration_ms: performance.now() - started,
    p50_ms: latencies[Math.floor(latencies.length * .5)], p95_ms: latencies[Math.floor(latencies.length * .95)], max_ms: latencies.at(-1) };
  console.log(`W5 capacity: ${result.http.requests} requests, ${failures} failures, p95=${result.http.p95_ms.toFixed(1)}ms`);
  const ledger = new Ledger({ baseDir: path.join(runtime, 'capacity-ledger') });
  const events = Array.from({ length: 1000 }, (_, n) => ({ kind: 'INVESTOR_DEPOSIT', protocol_instance: { chain_id: 31337, pool_address: `0x${'12'.repeat(20)}`, protocol_version: 5 },
    chain_pool_id: 1, investor: `0x${'34'.repeat(20)}`, asset: `0x${'56'.repeat(20)}`, amount_atomic: '800000', shares: '1',
    source: { tx_hash: `0x${BigInt(n + 1).toString(16).padStart(64, '0')}`, log_index: 0 } }));
  const ledgerStart = performance.now(); await ledger.applyEvents(events); await ledger.applyEvents(events);
  const [position] = await ledger.listPositions();
  result.ledger = { source: 'synthetic committed events; live EVM accounting verified separately', events: 1000, repeated_events: 1000,
    resulting_entries: (await ledger.writer.readCashEntries()).length, shares: position.shares, cost_atomic: position.cost_atomic, duration_ms: performance.now() - ledgerStart };
  const soakStarted = performance.now(), deadline = Date.now() + soakSeconds * 1000;
  const soak = { observations: 0, failures: 0, failure_observations: [], max_rss_bytes: 0, max_request_ms: 0 };
  const noteFailure = (details) => { soak.failures++; if (soak.failure_observations.length < 20) soak.failure_observations.push({ at: new Date().toISOString(), ...details }); };
  let nextProgress = Date.now() + 45000;
  while (Date.now() < deadline || soak.observations < soakSeconds && Date.now() < deadline + 30000) {
    const before = performance.now();
    try {
      const response = await fetch(`${origin}/api/ops/status`, { headers: { authorization: `Bearer ${env.AGENTBL_ADMIN_TOKEN}` }, signal: AbortSignal.timeout(3000) });
      const status = await response.json();
      if (!response.ok || !status.readiness?.ok) noteFailure({ kind: 'readiness', http_status: response.status, readiness: status.readiness,
        failed_checks: status.checks?.filter((check) => !check.ok).map(({ name, code }) => ({ name, code })) });
      soak.max_rss_bytes = Math.max(soak.max_rss_bytes, status.memory_rss_bytes ?? 0);
      const business = await fetch(origin + routes[soak.observations % routes.length], { signal: AbortSignal.timeout(3000) }); await business.arrayBuffer();
      if (!business.ok) noteFailure({ kind: 'business_read', http_status: business.status });
    } catch (error) { noteFailure({ kind: 'request_error', code: error.code ?? error.name }); }
    soak.observations++; soak.max_request_ms = Math.max(soak.max_request_ms, performance.now() - before);
    if (Date.now() >= nextProgress) { console.log(`W5 soak: ${soak.observations} observations, ${soak.failures} failures`); nextProgress = Date.now() + 45000; }
    await delay(Math.max(0, 1000 - (performance.now() - before)));
  }
  result.soak = { ...soak, duration_ms: performance.now() - soakStarted };
  result.passed = failures / 2000 <= .01 && result.http.p95_ms <= 1000 && result.ledger.resulting_entries === 1000
    && position.shares === '1000' && position.cost_atomic === '800000000' && soak.failures === 0 && soak.observations >= soakSeconds;
} catch (error) { result.passed = false; result.error = error.message; }
finally {
  // Capacity fixture owns this process only; forced termination also exercises stale runtime lease handling elsewhere.
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  result.completed_at = new Date().toISOString(); await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`); await fs.writeFile(`${output}.server.log`, serverOutput);
  await fs.copyFile(path.join(runtime, 'ops-alerts.jsonl'), `${output}.alerts.jsonl`).catch(() => {});
  await fs.rm(runtime, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: result.passed, output })); process.exitCode = result.passed ? 0 : 1;
