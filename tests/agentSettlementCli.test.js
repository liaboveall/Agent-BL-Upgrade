import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../scripts/lib/agent-approve.mjs';
import { createOwnerJournal } from '../scripts/lib/owner-journal.mjs';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { createChainReader } from '../src/agent/runtime/poolRegistry.js';
import { validateSettlementStep } from '../src/agent/pipelines/settlementPipeline.js';
import { settlementChain, chainConfig, oil, RECIPIENT, OWNER, paymentHash, blockHash } from './helpers/settlement.js';
import { createPool, storeState } from '../src/app/store.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-settlement-cli-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const chain = settlementChain(), state = { mode: 'live', generation: 1, signerCalls: 0, attachFailure: false, uncertain: false, afterPreflight: null };
  const store = { ...storeState, pools: new Map(), agentActivities: [] }; createPool(oil.case_id, oil, quoteFromCase(oil), { store });
  const service = createAgentService({ env: { AGENT_SETTLEMENT_RECIPIENT: RECIPIENT, AGENT_VALUATION_LLM: 'false', AGENT_COOLDOWN_SEC: '0' },
    store, chainConfig, dir, monitors: false, getChainContext: async () => chain.context, getMode: () => state.mode,
    getGeneration: () => state.generation, now: () => new Date('2099-10-14T00:00:00Z') });
  await service.init(); await service.registry.linkChain({ case_id: oil.case_id, chain_pool_id: 11, ebl_id: 7 }, createChainReader(chain.context));
  await service.start(); t.after(() => service.stop()); chain.payment();
  await service.submitEvent({ type: 'PAYMENT_RECEIVED', case_id: oil.case_id, source: 'admin', data: {
    payment_proof: paymentHash, repayment_amount: '1.234567', proof_source: 'usdc-transfer' } }, { origin: 'api' });
  await service.bus.idle(); const [approval] = service.approvals.list({ status: 'PENDING' }); await service.approve(approval.approval_id);
  const lines = [], journal = createOwnerJournal(path.join(dir, 'owner-cli'));
  const fetchFn = async (url, init) => {
    try {
      const pathname = new URL(url).pathname;
      let value;
      if (pathname === '/api/agent/status') value = await service.status();
      else if (pathname.endsWith('/attach-tx')) {
        if (state.attachFailure) return new Response(JSON.stringify({ error: 'fixture attachment failure' }), { status: 503 });
        value = await service.attachTx(approval.approval_id, JSON.parse(init.body));
      } else value = { approval: service.approvals.get(approval.approval_id), decision: await service.getDecision(approval.decision_id) };
      return new Response(JSON.stringify(value), { status: 200 });
    } catch (error) { return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: error.status ?? 500 }); }
  };
  const createSigner = async () => {
    state.signerCalls++;
    return { address: OWNER,
      validateStep: async (_step, plan) => {
        await validateSettlementStep({ plan, context: chain.context, chainConfig, recipient: RECIPIENT });
        await state.afterPreflight?.();
      },
      contractFor: (step) => ({ owner: async () => OWNER,
        [step.method]: Object.assign(async () => { if (state.uncertain) throw new Error('broadcast outcome unknown'); return chain.send(step); }, { staticCall: async () => {} }) }) };
  };
  const invoke = (extra = []) => run({ argv: ['--id', approval.approval_id, ...extra], env: { AGENT_SETTLEMENT_RECIPIENT: RECIPIENT },
    fetchFn, createSigner, journal, log: (line) => lines.push(line) });
  return { service, chain, state, approval, journal, invoke, lines };
}

test('settlement CLI defaults to dry run and sends exactly one approved evidence transaction on confirmation', async (t) => {
  const h = await harness(t); assert.equal(await h.invoke(), 0); assert.equal(h.chain.state.sent.length, 0);
  assert.equal(await h.invoke(['--confirm']), 0); assert.equal(h.chain.state.sent.length, 1);
  assert.equal(h.chain.state.sent[0].step.args[2], '1234567'); assert.equal(h.service.approvals.get(h.approval.approval_id).status, 'EXECUTED');
});

for (const [name, mutate] of [
  ['generation', (h) => { h.state.generation++; }], ['mode', (h) => { h.state.mode = 'demo'; }],
  ['emergency stop', (h) => { h.service.emergencyStopped = true; }],
  ['receipt reorg', (h) => { h.chain.state.blocks.set(100, blockHash(99)); }]
]) test(`settlement CLI refuses ${name} changes after preflight and sends nothing`, async (t) => {
  const h = await harness(t); let once = true; h.state.afterPreflight = () => { if (once) { once = false; mutate(h); } };
  assert.equal(await h.invoke(['--confirm']), 1); assert.equal(h.chain.state.sent.length, 0);
});

test('settlement CLI refuses an expired approval before asking for any signer', async (t) => {
  const h = await harness(t); h.service.approvals.records.get(h.approval.approval_id).expires_at = '2000-01-01T00:00:00Z';
  assert.equal(await h.invoke(['--confirm']), 1); assert.equal(h.state.signerCalls, 0); assert.equal(h.chain.state.sent.length, 0);
});

test('settlement CLI recovers an attached broadcast without another signer or transaction', async (t) => {
  const h = await harness(t); h.state.attachFailure = true;
  assert.equal(await h.invoke(['--confirm']), 1); const calls = h.state.signerCalls; assert.equal(h.chain.state.sent.length, 1);
  h.state.attachFailure = false;
  assert.equal(await h.invoke(['--confirm']), 0); assert.equal(h.state.signerCalls, calls); assert.equal(h.chain.state.sent.length, 1);
  assert.equal((await h.journal.read(h.approval.approval_id, 0)).status, 'ATTACHED');
});

test('settlement CLI retains an uncertain broadcast and refuses an automatic retry', async (t) => {
  const h = await harness(t); h.state.uncertain = true;
  assert.equal(await h.invoke(['--confirm']), 1); assert.equal((await h.journal.read(h.approval.approval_id, 0)).status, 'SENDING');
  const calls = h.state.signerCalls; h.state.uncertain = false;
  assert.equal(await h.invoke(['--confirm']), 1); assert.equal(h.state.signerCalls, calls); assert.equal(h.chain.state.sent.length, 0);
});
