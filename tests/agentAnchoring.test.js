import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { anchorLeaf, terminalPayload, merkleTree, verifyMerkleProof, verifyAnchorRecord } from '../src/agent/runtime/anchorProof.js';
import { DecisionAnchoring, readAnchorState, decisionAnchorFromState } from '../src/agent/runtime/anchoring.js';
import { createAgentVersion, LEGACY_AGENT_VERSION } from '../src/agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { DecisionLogger, hashSnapshot } from '../src/agent/decisionLogger.js';
import { verifyDecisionAnchor } from '../scripts/agent-verify-anchor.mjs';
import { createAgentRoutes } from '../src/app/agentRoutes.js';
import { phase5Runtime, riskDecision } from './helpers/phase5.js';
import { listen, requestJson } from './helpers/http.js';
import { resolveProvider } from '../src/agent/llm/openaiCompatClient.js';
import { validateAgentLogPlan } from '../scripts/lib/deploy-agent-log.mjs';

const config = loadAgentConfig({ AGENT_ANCHOR_INTERVAL_SEC: '1' });
const version = createAgentVersion(config, {}, hashSnapshot('test source'));
const hash = (text) => hashSnapshot(text);
const decision = (id = 'one', mode = 'demo', patch = {}) => ({ decision_id: `decision_${id}`, event_id: `event_${id}`, case_id: 'case-test',
  pool_id: 'pool-test', mode, action: 'PAUSE', status: 'COMPLETED', policy: { verdict: 'AUTO' }, reasoning_summary: 'Test risk observed',
  evidence_hash: hash('evidence'), quote_hash: hash('quote'), updated_at: '2026-10-15T00:00:00Z',
  agent_version: version, execution: { mode: mode === 'demo' ? 'demo' : 'chain', reference: mode === 'demo' ? 'demo:one' : hash('tx') }, ...patch });
const payload = (d) => terminalPayload(d, { seq: 1, versionId: version.version_id });
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-anchor-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function journal(t, options = {}) {
  const logger = options.logger ?? new DecisionLogger({ filePath: null });
  let clock = Date.parse('2026-10-15T00:00:00Z');
  const anchor = new DecisionAnchoring({ logger, config, version, now: () => new Date(clock), ...options });
  t.after(() => anchor.stop()); await anchor.init();
  return { anchor, logger, advance: () => { clock += 1000; } };
}
function fakeChain() {
  const state = { sent: 0, confirmed: false, failSend: false, failPrepare: false, found: null, verified: true, beforeSend: () => {} };
  const adapter = {
    prepare: async () => {
      if (state.failPrepare) throw new Error('RPC unavailable');
      return { chain_id: 1439, contract_address: `0x${'12'.repeat(20)}`, anchorer: `0x${'34'.repeat(20)}`, from_block: 100 };
    },
    send: async (_batch, assertCurrent, submitted) => {
      state.beforeSend(); assertCurrent(); state.sent++;
      if (state.failSend) throw new Error('RPC disconnected during send');
      const tx = { hash: hash('anchor transaction') }; await submitted?.(tx); return tx;
    },
    locate: async () => state.found,
    confirm: async () => state.confirmed ? { block_number: 101, block_hash: hash('block'), explorer_url: `https://explorer.example/tx/${hash('anchor transaction')}` } : null,
    verify: async () => state.verified
  };
  return { adapter, state };
}

test('anchor leaves use canonical JSON, domain separation and explicit terminal fields', () => {
  const base = payload(decision());
  assert.equal(anchorLeaf(base), anchorLeaf(Object.fromEntries(Object.entries(base).reverse())));
  for (const [name, value] of Object.entries({ status: 'FAILED', action: 'REPRICE', event_id: 'changed', evidence_hash: hash('new'),
    quote_hash: hash('new quote'), version_id: hash('new version'), finalized_at: '2026-10-15T00:00:01Z', seq: 2 })) {
    assert.notEqual(anchorLeaf(base), anchorLeaf({ ...base, [name]: value }), name);
  }
  assert.throws(() => payload(decision('pending', 'demo', { status: 'PENDING_APPROVAL' })), /terminal/u);
});

test('approval identity, route, time, outcome and transaction are committed without source text or credentials', () => {
  const d = decision('approved', 'live', { approval: { approval_id: 'appr_one', status: 'EXECUTED', route: 'server', decided_by: 'operator', decided_at: '2026-10-15T00:00:00Z', note: 'sk-testsecret' },
    execution: { mode: 'chain', reference: 'tx', tx_hash: hash('tx') }, input_snapshot: { text: 'private commercial document', private_key: 'secret' } });
  const base = payload(d);
  for (const patch of [{ decided_by: 'another' }, { decided_at: '2026-10-16' }, { route: 'owner_cli' }, { status: 'REJECTED' }]) {
    assert.notEqual(anchorLeaf(base), anchorLeaf(payload({ ...d, approval: { ...d.approval, ...patch } })));
  }
  assert.notEqual(anchorLeaf(base), anchorLeaf(payload({ ...d, execution: { ...d.execution, tx_hash: hash('other tx') } })));
  assert.doesNotMatch(JSON.stringify(base), /commercial document|sk-testsecret|private_key/u);
  assert.equal(base.version_id, version.version_id);
});

for (const count of [1, 2, 3, 5, 16, 255, 256]) test(`Merkle tree proves every leaf in a ${count}-record batch and rejects alterations`, () => {
  const leaves = Array.from({ length: count }, (_, i) => anchorLeaf({ index: i })), tree = merkleTree(leaves);
  for (let i = 0; i < count; i++) assert.equal(verifyMerkleProof(leaves[i], tree.proofs[i], tree.root), true);
  assert.equal(verifyMerkleProof(hash('tamper'), tree.proofs[0], tree.root), false);
  assert.equal(verifyMerkleProof(leaves[0], [hash('sibling'), ...tree.proofs[0]], tree.root), false);
});

test('invalid or oversized tree/proof inputs fail closed', () => {
  for (const leaves of [[], ['bad'], Array(257).fill(hash('x'))]) assert.throws(() => merkleTree(leaves));
  assert.equal(verifyMerkleProof(hash('a'), ['bad'], hash('b')), false);
  assert.equal(verifyMerkleProof(hash('a'), Array(9).fill(hash('b')), hash('b')), false);
});

test('enabling anchoring does not change the agent version; policy, model and source changes do', () => {
  const create = (c = config, e = {}, source = hash('source')) => createAgentVersion(c, e, source);
  assert.deepEqual(create(), create({ ...config, anchorEnabled: true, anchorIntervalSec: 17, anchorMinBatch: 3 }));
  for (const next of [create({ ...config, maxPriceMoveBps: 2 }), create(config, { LLM_MODEL: 'other-model' }), create(config, {}, hash('new source'))]) {
    assert.notEqual(create().version_id, next.version_id);
  }
});

test('anchor model metadata matches provider normalization for absent, empty, whitespace and explicit model names', () => {
  for (const model of [undefined, '', '  ', ' x-test-2 ', ' custom-model ']) {
    const env = { LLM_MODEL: model, LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: 'fixture-only' };
    const normalized = createAgentVersion(config, env, hash('model-normalization'));
    assert.equal(normalized.model_id, resolveProvider(env).model);
    assert.equal(validateAgentLogPlan({ schema: 'agentbl-anchor-deployment-plan-v1', chain_id: 1439, versions: [normalized] }).versions[0].model_id, normalized.model_id);
  }
});

test('concurrent finalizations allocate a continuous durable sequence; duplicates and restart keep it', async (t) => {
  const dir = await temp(t), file = path.join(dir, 'agent-anchors.json');
  const { anchor } = await journal(t, { file });
  await Promise.all(Array.from({ length: 20 }, (_, i) => anchor.capture(decision(String(i)))));
  assert.equal(await anchor.capture(decision('4')), 5);
  await anchor.tick();
  assert.deepEqual(anchor.state.demo.records.map((record) => record.seq), Array.from({ length: 20 }, (_, i) => i + 1));
  const before = await anchor.get('decision_4', decision('4'));
  assert.equal(before.verification.passed, true); assert.equal(before.state, 'DEMO');
  assert.equal(before.batch.tx_hash, null); assert.equal(before.batch.explorer_url, undefined);
  await anchor.stop();
  const { anchor: restarted } = await journal(t, { file });
  assert.deepEqual(await restarted.get('decision_4', decision('4')), before);
  assert.equal(await restarted.capture(decision('after-restart')), 21);
});

test('a second OS process cannot take the active anchor sequence lock', async (t) => {
  const file = path.join(await temp(t), 'agent-anchors.json');
  await journal(t, { file });
  const module = new URL('../src/agent/runtime/anchorStore.js', import.meta.url).href;
  const script = `import { lockAnchorStore } from ${JSON.stringify(module)}; try { await lockAnchorStore(process.argv[1]); process.exitCode = 5; } catch { console.log('LOCKED'); }`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, file]);
  assert.equal(result.stdout.trim(), 'LOCKED');
});

test('a dead process lock is recovered without resetting sequence', async (t) => {
  const file = path.join(await temp(t), 'agent-anchors.json');
  const module = new URL('../src/agent/runtime/anchorStore.js', import.meta.url).href;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `import { lockAnchorStore } from ${JSON.stringify(module)}; await lockAnchorStore(process.argv[1]);`, file]);
  const { anchor } = await journal(t, { file });
  assert.equal(await anchor.capture(decision()), 1);
});

test('failed persistence consumes no finalization sequence and leaves the prior state intact', async (t) => {
  const file = path.join(await temp(t), 'agent-anchors.json');
  let fail = true;
  const { writeJsonAtomic } = await import('../src/lib/jsonStore.js');
  const { anchor } = await journal(t, { file, write: async (...args) => { if (fail) throw new Error('disk unavailable'); await writeJsonAtomic(...args); } });
  await anchor.captureSafe(decision());
  assert.equal(anchor.status().last_error, 'anchor_capture_failed'); assert.equal(anchor.state.demo.records.length, 0);
  fail = false; assert.equal(await anchor.capture(decision()), 1);
  assert.equal((await readAnchorState(file)).demo.records.length, 1);
});

test('tampered terminal data fails verification; finalized entries cannot be silently overwritten', async (t) => {
  const { anchor } = await journal(t);
  const d = decision(); await anchor.capture(d); await anchor.tick();
  const changed = { ...d, evidence_hash: hash('tampered') };
  await assert.rejects(anchor.capture(changed), /immutable/u);
  const result = await anchor.get(d.decision_id, changed);
  assert.equal(result.verification.passed, false);
  assert.equal(result.verification.checks.find((check) => check.name === 'current_decision').passed, false);
  assert.equal(verifyAnchorRecord({ ...result, payload: { ...result.payload, action: 'LIQUIDATE' } }).passed, false);
  assert.equal((await anchor.get(d.decision_id, { ...d, agent_version: { ...d.agent_version, model_id: 'altered' } })).verification.passed, false);
});

test('corrupted sequence, leaf, version and batch root are rejected on load', async (t) => {
  const { anchor } = await journal(t); await anchor.capture(decision()); await anchor.tick();
  const file = path.join(await temp(t), 'corrupt.json');
  for (const change of [(s) => { s.demo.records[0].seq = 3; }, (s) => { s.demo.records[0].leaf = hash('wrong'); },
    (s) => { s.demo.records[0].version.model_id = 'other'; }, (s) => { s.demo.batches[0].merkle_root = hash('wrong'); }]) {
    const state = structuredClone(anchor.state); change(state); await fs.writeFile(file, JSON.stringify(state));
    await assert.rejects(readAnchorState(file), /integrity/u);
  }
});

test('legacy journals are explicitly marked with an unrecorded version', async (t) => {
  const { anchor } = await journal(t); const old = decision(); delete old.agent_version;
  await anchor.capture(old);
  assert.deepEqual(anchor.state.demo.records[0].version, LEGACY_AGENT_VERSION);
});

test('Demo and disabled Live form local trees without contacting a chain adapter', async (t) => {
  let calls = 0, mode = 'demo';
  const { anchor } = await journal(t, { config: { ...config, anchorEnabled: true }, getMode: () => mode,
    adapter: { prepare: () => { calls++; throw new Error('must not call'); } } });
  await anchor.capture(decision()); await anchor.tick(); assert.equal(calls, 0);
  mode = 'live'; anchor.config = { ...config, anchorEnabled: false };
  await anchor.capture(decision('live', 'live')); await anchor.tick(); assert.equal(calls, 0);
  assert.equal((await anchor.get('decision_live')).state, 'LOCAL');
  await anchor.resetDemo(); assert.equal(anchor.state.demo.records.length, 0); assert.equal(anchor.state.live.records.length, 1);
});

test('minimum batch, interval and version boundaries keep each batch homogeneous and continuous', async (t) => {
  const { anchor, advance } = await journal(t, { config: { ...config, anchorMinBatch: 2 } });
  await anchor.capture(decision('a')); await anchor.tick(); assert.equal(anchor.state.demo.batches.length, 0);
  await anchor.capture(decision('b')); await anchor.tick(); assert.equal(anchor.state.demo.batches[0].count, 2);
  await anchor.capture(decision('c')); await anchor.capture(decision('d')); await anchor.tick(); assert.equal(anchor.state.demo.batches.length, 1);
  advance(); await anchor.tick(); assert.equal(anchor.state.demo.batches.length, 2);
  const v2 = createAgentVersion(config, { LLM_MODEL: 'version2' }, hash('new-code'));
  await anchor.capture(decision('e')); await anchor.capture(decision('f', 'demo', { agent_version: v2 }));
  advance(); await anchor.tick(); assert.equal(anchor.state.demo.batches[2].count, 1);
  anchor.config.anchorMinBatch = 1; advance(); await anchor.tick();
  assert.equal(anchor.state.demo.batches[3].from_seq, 6); assert.equal(anchor.state.demo.batches[3].version_id, v2.version_id);
});

test('Live batches persist intent and hash before confirmation; repeat ticks do not broadcast twice', async (t) => {
  const { adapter, state } = fakeChain();
  const { anchor } = await journal(t, { config: { ...config, anchorEnabled: true }, getMode: () => 'live', adapter });
  await anchor.capture(decision('live', 'live')); await anchor.tick();
  assert.equal(anchor.state.live.batches[0].status, 'SUBMITTED'); assert.equal(state.sent, 1);
  await anchor.tick(); assert.equal(state.sent, 1);
  state.confirmed = true; await anchor.tick();
  const result = await anchor.get('decision_live', decision('live', 'live'));
  assert.equal(result.state, 'ANCHORED'); assert.equal(result.verification.status, 'PASS_CHAIN');
  await anchor.tick(); assert.equal(state.sent, 1);
  state.verified = false; assert.equal((await anchor.get('decision_live')).verification.passed, false);
});

test('uncertain send survives restart and recovers by observed hash without a repeat broadcast', async (t) => {
  const file = path.join(await temp(t), 'agent-anchors.json'), { adapter, state } = fakeChain(); state.failSend = true;
  const options = { file, config: { ...config, anchorEnabled: true }, getMode: () => 'live', adapter };
  const { anchor } = await journal(t, options);
  await anchor.capture(decision('live', 'live')); await anchor.tick();
  assert.equal(anchor.state.live.batches[0].status, 'BROADCASTING'); await anchor.stop();
  const { anchor: resumed } = await journal(t, options);
  await resumed.tick(); assert.equal(state.sent, 1); assert.equal(resumed.status().last_error, 'anchor_reconciliation_required');
  state.found = hash('anchor transaction'); state.confirmed = true;
  await resumed.tick(); assert.equal(resumed.state.live.batches[0].status, 'ANCHORED'); assert.equal(state.sent, 1);
});

test('preflight failure is retryable but a mode change before send never broadcasts', async (t) => {
  const { adapter, state } = fakeChain(); state.failPrepare = true; let mode = 'live';
  const { anchor } = await journal(t, { config: { ...config, anchorEnabled: true }, getMode: () => mode, adapter });
  await anchor.capture(decision('live', 'live')); await anchor.tick();
  assert.equal(state.sent, 0); assert.equal(anchor.state.live.batches[0].status, 'LOCAL');
  state.failPrepare = false; state.beforeSend = () => { mode = 'demo'; };
  await anchor.tick(); assert.equal(state.sent, 0); assert.equal(anchor.state.live.batches[0].status, 'BROADCASTING');
});

test('a failed hash checkpoint after broadcast stays uncertain until read-only recovery and never re-sends', async (t) => {
  const file = path.join(await temp(t), 'agent-anchors.json'), { adapter, state } = fakeChain();
  const { writeJsonAtomic } = await import('../src/lib/jsonStore.js');
  let failHash = true;
  const { anchor } = await journal(t, { file, config: { ...config, anchorEnabled: true }, getMode: () => 'live', adapter,
    write: async (file, next) => {
      if (failHash && next.live.batches.at(-1)?.status === 'SUBMITTED') throw new Error('hash checkpoint failed');
      await writeJsonAtomic(file, next);
    } });
  await anchor.capture(decision('live', 'live')); await anchor.tick(); assert.equal(state.sent, 1);
  assert.equal((await readAnchorState(file)).live.batches[0].status, 'BROADCASTING');
  failHash = false; await anchor.tick(); assert.equal(state.sent, 1);
  state.found = hash('anchor transaction'); state.confirmed = true; await anchor.tick();
  assert.equal(anchor.state.live.batches[0].status, 'ANCHORED'); assert.equal(state.sent, 1);
});

test('runtime finalizes actual executed and observe-only decisions immediately, with proof after a tick', async (t) => {
  const { service } = await phase5Runtime(t);
  const completed = await riskDecision(service);
  assert.equal((await service.getDecisionAnchor(completed.decision_id)).state, 'PENDING_BATCH');
  await service.tick();
  const result = await service.getDecisionAnchor(completed.decision_id);
  assert.equal(result.state, 'DEMO'); assert.equal(result.verification.passed, true);
  const { service: observer } = await phase5Runtime(t, { config: { AGENT_AUTONOMY: 'observe' } });
  const observed = await riskDecision(observer, { event_id: 'observe-risk' });
  assert.equal(observed.status, 'SKIPPED'); assert.equal(observed.policy.verdict, 'OBSERVE_ONLY');
  assert.equal((await observer.getDecisionAnchor(observed.decision_id)).seq, 1);
});

test('approved, rejected and expired decisions bind operator/time/outcome, pending approval has no final seq', async (t) => {
  for (const outcome of ['EXECUTED', 'REJECTED', 'EXPIRED']) await t.test(outcome, async (t) => {
    const { service, advance } = await phase5Runtime(t, { config: { AGENT_AUTONOMY: 'propose', AGENT_ANCHOR_INTERVAL_SEC: '1' } });
    const pending = await riskDecision(service);
    assert.equal((await service.getDecisionAnchor(pending.decision_id)).available, false);
    if (outcome === 'EXECUTED') await service.approve(pending.approval.approval_id, { by: 'test-operator' });
    if (outcome === 'REJECTED') await service.reject(pending.approval.approval_id, { by: 'test-operator' });
    if (outcome === 'EXPIRED') { advance(86400001); await service.tick(); }
    const result = await service.getDecisionAnchor(pending.decision_id);
    assert.equal(result.payload.approval.status, outcome);
    if (outcome !== 'EXPIRED') { assert.equal(result.payload.approval.decided_by, hashSnapshot({ domain: 'agentbl-decision-anchor-v2:decided_by', value: 'test-operator' })); assert.ok(result.payload.approval.decided_at); }
    assert.equal(service.anchoring.state.demo.records.length, 1);
  });
});

test('failed approved execution preserves the operator and terminal failure in its commitment', async (t) => {
  const { service } = await phase5Runtime(t, { config: { AGENT_AUTONOMY: 'propose' } });
  const pending = await riskDecision(service);
  service.sim.execute = async () => { throw Object.assign(new Error('local executor failure'), { code: 'local_failure' }); };
  await service.approve(pending.approval.approval_id, { by: 'failure-reviewer' });
  const result = await service.getDecisionAnchor(pending.decision_id);
  assert.equal(result.payload.status, 'FAILED'); assert.equal(result.payload.approval.status, 'FAILED');
  assert.equal(result.payload.approval.decided_by, hashSnapshot({ domain: 'agentbl-decision-anchor-v2:decided_by', value: 'failure-reviewer' })); assert.ok(result.payload.approval.decided_at);
});

test('an autonomy override creates a new policy version without relabeling already created decisions', async (t) => {
  const { service } = await phase5Runtime(t);
  const first = await riskDecision(service), original = first.agent_version.version_id;
  await service.control({ action: 'set_autonomy', autonomy: 'observe' });
  assert.notEqual(service.anchoring.version.version_id, original);
  assert.equal((await service.logger.get(first.decision_id)).agent_version.version_id, original);
  assert.equal((await service.getDecisionAnchor(first.decision_id)).payload.version_id, original);
});

test('retention preserves independent proofs and live sequences; Demo reset discards only Demo proofs', async (t) => {
  const { service, advance } = await phase5Runtime(t, { config: { AGENT_RETENTION_DAYS: '1' } });
  const d = await riskDecision(service); await service.tick(); advance(2 * 86400000); await service.tick();
  assert.equal(await service.logger.get(d.decision_id), null);
  const archived = await service.getDecisionAnchor(d.decision_id); assert.equal(archived.archived, true); assert.equal(archived.verification.passed, true);
  await service.anchoring.capture(decision('live-record', 'live'));
  await service.resetDemo(); assert.equal(service.anchoring.state.demo.records.length, 0); assert.equal(service.anchoring.state.live.records.length, 1);
});

test('HTTP exposes public proofs and behavioral tamper failures, with missing IDs returning 404', async (t) => {
  const { service } = await phase5Runtime(t); const d = await riskDecision(service); await service.tick();
  const routes = createAgentRoutes({ getService: () => service, runtimeMode: () => ({ mode: 'live' }), activityLog: service.activity });
  const server = http.createServer(async (req, res) => {
    try { if (!await routes(req, res, new URL(req.url, 'http://test'))) { res.writeHead(404); res.end(); } }
    catch (error) { res.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.code })); }
  });
  const listening = await listen(server); t.after(listening.close);
  const endpoint = `/api/agent/decisions/${d.decision_id}/anchor`;
  const result = await requestJson(listening.base, 'GET', endpoint);
  assert.equal(result.status, 200); assert.equal(result.data.anchor.verification.passed, true);
  await service.logger.update(d.decision_id, { evidence_hash: hash('tampered') });
  assert.equal((await requestJson(listening.base, 'GET', endpoint)).data.anchor.verification.passed, false);
  assert.equal((await requestJson(listening.base, 'GET', '/api/agent/decisions/missing/anchor')).status, 404);
});

test('CLI rechecks a disk audit without reading keys or mutating journals and exits nonzero for tampering', async (t) => {
  const dir = await temp(t), file = path.join(dir, 'agent-anchors.json'), decisionFile = path.join(dir, 'agent-decisions.json');
  const { anchor } = await journal(t, { file }); const d = decision(); await anchor.capture(d); await anchor.tick();
  await fs.writeFile(decisionFile, JSON.stringify([d]));
  const before = await fs.readFile(file, 'utf8');
  const cli = new URL('../scripts/agent-verify-anchor.mjs', import.meta.url);
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(cli), '--decision', d.decision_id, '--file', file]);
  assert.equal(JSON.parse(result.stdout).verification.status, 'PASS_LOCAL'); assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.writeFile(decisionFile, JSON.stringify([{ ...d, action: 'LIQUIDATE' }]));
  assert.equal((await verifyDecisionAnchor({ decisionId: d.decision_id, file, decisionFile })).verification.passed, false);
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(cli), '--decision', d.decision_id, '--file', file]), (error) => error.code === 1);
  assert.equal(decisionAnchorFromState(await readAnchorState(file), 'missing').state, 'NOT_FINALIZED');
});
