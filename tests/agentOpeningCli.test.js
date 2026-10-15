import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../scripts/lib/agent-approve.mjs';
import { createOwnerJournal } from '../scripts/lib/owner-journal.mjs';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { resolveOwnerStep, validateOpeningStep } from '../src/agent/runtime/openingPlan.js';
import { chainConfig, oil, openingChain, uploadedDocuments, OWNER } from './helpers/opening.js';

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-cli-open-'));
  const chain = openingChain(), state = { mode: 'live', generation: 1, attachFailure: false, uncertainSend: false, signerCalls: 0 };
  const service = createAgentService({ env: { AGENT_VALUATION_LLM: 'false', AGENT_COOLDOWN_SEC: '0', AGENT_MONITOR_INTERVAL_SEC: '3600' },
    getMode: () => state.mode, getGeneration: () => state.generation, now: () => new Date('2099-10-14T00:00:00Z'),
    getChainContext: async () => chain.context, chainConfig, store: { pools: new Map() }, monitors: false });
  await service.start(); t.after(async () => { await service.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const intake = await service.submitDocuments({ case_id: oil.case_id, documents: await uploadedDocuments() }); await service.waitFor(intake.idempotency_key, 20000);
  const approval = service.approvals.list()[0]; await service.approve(approval.approval_id);
  const lines = [], staticCalls = [], requests = [], journal = createOwnerJournal(dir);
  const fetchFn = async (url, init) => {
    const pathname = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null; requests.push({ pathname, body });
    let reply, status = 200;
    try {
      if (pathname === '/api/agent/status') reply = await service.status();
      else if (pathname.endsWith('/attach-tx')) {
        if (state.attachFailure) return new Response(JSON.stringify({ error: 'offline after broadcast' }), { status: 503 });
        reply = await service.attachTx(approval.approval_id, body);
      } else reply = { approval: service.approvals.get(approval.approval_id), decision: await service.getDecision(approval.decision_id) };
    } catch (error) { status = error.status ?? 500; reply = { code: error.code, error: error.message }; }
    return new Response(JSON.stringify(reply), { status });
  };
  const createSigner = async ({ plan }) => {
    state.signerCalls++;
    return { address: OWNER,
      validateStep: (step) => validateOpeningStep({ plan, step, registry: chain.context.registry, pool: chain.context.pool, poolAddress: chainConfig.contracts.RWAOfferingPool }),
      contractFor: (step) => ({ owner: async () => OWNER,
        [step.method]: Object.assign(async () => {
          const tx = chain.send(step);
          if (state.uncertainSend) throw new Error('connection lost after sending');
          return tx;
        }, { staticCall: async (...args) => {
          staticCalls.push({ method: step.method, args });
          if (step.index > 0 && !chain.bills.has(Number(args[0]))) throw new Error('dependent eBL missing');
        } })
      }) };
  };
  const invoke = (argv, extra = {}) => run({ argv: ['--id', approval.approval_id, ...argv], env: { AGENTBL_URL: 'http://local.test' },
    fetchFn, createSigner, journal, log: (line) => lines.push(line), ...extra });
  return { service, chain, state, approval, invoke, lines, staticCalls, requests, journal, dir };
}

test('opening CLI: dry run preflights only the ready step and never simulates a future dependency', async (t) => {
  const h = await harness(t); assert.equal(await h.invoke([]), 0);
  assert.deepEqual(h.staticCalls.map((call) => call.method), ['mintEBLV2']); assert.equal(h.chain.state.sent.length, 0);
  assert.ok(h.lines.some((line) => line.includes('<verified ebl_id>'))); assert.ok(!h.lines.some((line) => line.includes('[object Object]')));
  assert.equal(await h.journal.read(h.approval.approval_id, 0), null);
});

test('opening CLI: each explicit --step --confirm sends exactly one transaction and uses verified IDs', async (t) => {
  const h = await harness(t);
  assert.equal(await h.invoke(['--confirm']), 1); assert.equal(h.chain.state.sent.length, 0);
  assert.equal(await h.invoke(['--step', '2', '--confirm']), 1); assert.equal(h.chain.state.sent.length, 0);
  for (let index = 0; index < 3; index++) {
    assert.equal(await h.invoke(['--step', String(index), '--confirm']), 0);
    assert.equal(h.chain.state.sent.length, index + 1);
    assert.equal((await h.journal.read(h.approval.approval_id, index)).status, 'ATTACHED');
  }
  assert.equal(h.chain.state.sent[1].step.args[0], '7'); assert.equal(h.service.registry.get(oil.case_id).chain.pool_id, 11);
  assert.equal(await h.invoke(['--step', '2', '--confirm']), 1); assert.equal(h.chain.state.sent.length, 3);
});

test('opening CLI: a broadcast with failed attachment recovers from the journal without a signer or resend', async (t) => {
  const h = await harness(t); h.state.attachFailure = true;
  assert.equal(await h.invoke(['--step', '0', '--confirm']), 1); assert.equal(h.chain.state.sent.length, 1);
  const checkpoint = await h.journal.read(h.approval.approval_id, 0); assert.equal(checkpoint.status, 'SUBMITTED');
  h.state.attachFailure = false; const signerCalls = h.state.signerCalls;
  assert.equal(await h.invoke(['--step', '0', '--confirm']), 0);
  assert.equal(h.chain.state.sent.length, 1); assert.equal(h.state.signerCalls, signerCalls);
  assert.equal(h.service.approvals.get(h.approval.approval_id).plan.bindings.ebl_id, '7');
});

test('opening CLI: an uncertain broadcast blocks retry until explicit hash reconciliation', async (t) => {
  const h = await harness(t); h.state.uncertainSend = true;
  assert.equal(await h.invoke(['--step', '0', '--confirm']), 1); assert.equal(h.chain.state.sent.length, 1);
  assert.equal((await h.journal.read(h.approval.approval_id, 0)).status, 'SENDING');
  h.state.uncertainSend = false;
  assert.equal(await h.invoke(['--step', '0', '--confirm']), 1); assert.equal(h.chain.state.sent.length, 1);
  const before = h.state.signerCalls;
  assert.equal(await h.invoke(['--step', '0', '--attach-tx', h.chain.state.sent[0].tx_hash]), 0);
  assert.equal(h.state.signerCalls, before); assert.equal(h.service.approvals.get(h.approval.approval_id).steps_done.length, 1);
});

test('opening CLI: stale chain state, runtime mode and local emergency stop prevent sending', async (t) => {
  const h = await harness(t); h.chain.seed(oil); // Parsed source identity differs, so use the approved identity exactly.
  h.chain.bills.get(2).cargoHash = h.approval.plan.cargo_hash;
  assert.equal(await h.invoke(['--step', '0', '--confirm']), 1); assert.equal(h.chain.state.sent.length, 0);
  h.chain.bills.clear(); h.chain.pools.clear(); h.state.mode = 'demo'; h.state.generation++;
  assert.equal(await h.invoke(['--step', '0', '--confirm']), 1); assert.equal(h.chain.state.sent.length, 0);
  h.state.mode = 'live'; h.state.generation = 1; h.service.emergencyStopped = true;
  assert.equal(await h.invoke(['--step', '0', '--confirm']), 1); assert.equal(h.chain.state.sent.length, 0);
});

test('owner journal: a concurrent or abandoned process lock blocks signing and keeps evidence', async (t) => {
  const h = await harness(t);
  await fs.mkdir(path.join(h.dir, 'owner-cli'), { recursive: true });
  const lock = path.join(h.dir, 'owner-cli', `${h.approval.approval_id}-0.lock`); await fs.writeFile(lock, '');
  assert.equal(await h.invoke(['--step', '0', '--confirm']), 1); assert.equal(h.chain.state.sent.length, 0);
  assert.equal(h.state.signerCalls, 0); await fs.access(lock);
});

test('opening CLI: a dry run after a previous broadcast reports reconciliation without sending', async (t) => {
  const h = await harness(t); const step = resolveOwnerStep(h.approval.plan, h.approval.plan.steps[0]); const tx = h.chain.send(step);
  await h.journal.write(h.approval.approval_id, 0, { status: 'SUBMITTED', tx_hash: tx.hash });
  assert.equal(await h.invoke([]), 0); assert.equal(h.state.signerCalls, 0); assert.equal(h.chain.state.sent.length, 1);
});
