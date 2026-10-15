import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createPool, resetStore, storeState } from '../src/app/store.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { ScenarioError } from '../src/agent/runtime/sources/scenarioPlayer.js';

const readCase = async (file) => JSON.parse(await fs.readFile(new URL(`../data/${file}`, import.meta.url), 'utf8'));
const copper = await readCase('cases/copper-sg-shanghai.case.json');
const warcrisis = await readCase('cases/copper-sg-shanghai-warcrisis.case.json');
const crude = await readCase('cases/crude-sg-ulsan.case.json');
const demoCase = await readCase('demo-case.json');

async function runtime({ mode = 'demo', env = {} } = {}) {
  resetStore();
  storeState.agentActivities = [];
  const seed = () => {
    for (const data of [copper, warcrisis, crude, demoCase]) {
      createPool(data.case_id, data, quoteFromCase(data, { payout_speed: data.financing.payout_speed === 'FAST' ? 'FAST' : 'BALANCED' }));
    }
  };
  seed();
  const state = { mode };
  const service = createAgentService({
    config: loadAgentConfig(env),
    env: {},
    store: storeState,
    getMode: () => state.mode,
    chainConfig: null,
    getChainContext: async () => null,
    ensurePools: async () => {},
    sleep: async () => {}
  });
  await service.start();
  return { service, state, seed };
}

const chronological = async (service) => (await service.listDecisions({ limit: 200 })).decisions.reverse();
const noChainTraces = (service) => {
  for (const record of service.activity.list({ limit: 1000 })) {
    assert.equal(record.tx_hash, undefined, `${record.action} must not carry a transaction hash`);
    assert.equal(record.explorer_url, undefined, `${record.action} must not carry an explorer link`);
  }
};

test('scenarios: the catalog lists every shipped scenario with a bilingual title', async () => {
  const { service } = await runtime();
  const list = await service.scenarios.list();
  assert.deepEqual(list.map((s) => s.name), ['copper-lifecycle', 'copper-typhoon', 'insurance-gap', 'warcrisis-hormuz']);
  for (const scenario of list) {
    assert.ok(scenario.title.en && scenario.title.zh, scenario.name);
    assert.ok(scenario.steps >= 3);
    assert.ok(storeState.pools.has(scenario.case_id), `${scenario.name} runs on a case that is in the market`);
  }
});

test('copper-typhoon: the whole cargo story runs through the real policy and the simulated executor', async () => {
  const { service } = await runtime();
  const started = await service.scenarios.start('copper-typhoon');
  assert.equal(started.loaded, true);
  assert.equal(started.next_step, 0);
  assert.equal((await service.status()).scenario.name, 'copper-typhoon');

  const result = await service.scenarios.run();
  assert.equal(result.finished, true);
  assert.equal(result.entries.length, 9);

  const decisions = await chronological(service);
  assert.deepEqual(decisions.map((d) => [d.action, d.status]), [
    ['MARK_IN_TRANSIT', 'COMPLETED'],
    ['REPRICE', 'COMPLETED'],
    ['PAUSE', 'COMPLETED'],
    ['RESUME', 'COMPLETED'],
    ['RECORD_ARRIVAL', 'COMPLETED'],
    ['RECORD_PAYMENT', 'PENDING_APPROVAL']
  ]);
  assert.ok(decisions.every((d) => d.mode === 'demo' && d.case_id === copper.case_id));
  assert.deepEqual(result.entries.map((e) => e.change ?? null).filter(Boolean), ['WORLD_RISK_UPDATED', 'WORLD_RISK_UPDATED', 'RISK_CLEARED']);
  assert.equal(result.entries[0].change, null, 'the calm baseline is not an event');
  assert.equal(result.entries[5].change, null, 'one quiet check is not enough');
  assert.ok(result.entries[1].subscribed_usd > 0);

  const pool = storeState.pools.get(copper.case_id);
  assert.equal(pool.status, 'Repriced', 'paused by the storm, resumed to where it was');
  assert.ok(pool.subscribedUsd > 0 && pool.subscribedUsd < pool.targetUsd);
  assert.match(pool.settlement.arrival_proof, /^demo:/u);
  assert.equal(pool.settlement.payment_proof, undefined, 'the payment proof waits for a human');

  // money-sensitive: recorded only after a person approves
  const [approval] = service.approvals.list({ status: 'PENDING' });
  assert.equal(approval.action, 'RECORD_PAYMENT');
  assert.equal(approval.route, 'sim');
  assert.equal(service.approvals.list().length, 1);

  for (const d of decisions.filter((x) => x.status === 'COMPLETED')) {
    assert.equal(d.execution.mode, 'demo');
    assert.match(d.execution.reference, /^demo:/u);
  }
  noChainTraces(service);
});

test('copper-typhoon: approving the payment makes the agent propose settlement, and settlement needs its own approval', async () => {
  const { service } = await runtime();
  await service.scenarios.start('copper-typhoon');
  await service.scenarios.run();

  const [payment] = service.approvals.list({ status: 'PENDING' });
  await service.approve(payment.approval_id, { by: 'admin' });
  await service.bus.idle();

  const pool = storeState.pools.get(copper.case_id);
  assert.match(pool.settlement.payment_proof, /^demo:/u);
  assert.equal(pool.settlement.repayment_amount, 1_380_000);

  const decisions = await chronological(service);
  const settle = decisions.at(-1);
  assert.equal(settle.action, 'SETTLE');
  assert.equal(settle.status, 'PENDING_APPROVAL', 'settlement is irreversible: never automatic');
  assert.ok(settle.policy.reasons.some((r) => r.rule === 'IRREVERSIBLE'));
  assert.equal(settle.proposal.params.repayment_amount, 1_380_000);
  assert.match(settle.reasoning_summary, /does not distribute funds/u, 'the contract only records the repayment');
  assert.notEqual(pool.status, 'Repaid');

  const [settleApproval] = service.approvals.list({ status: 'PENDING' });
  assert.equal(settleApproval.action, 'SETTLE');
  await service.approve(settleApproval.approval_id, { by: 'admin' });
  assert.equal(pool.status, 'Repaid');
  assert.ok(pool.settlement.settled_at);
  assert.equal((await service.getDecision(settle.decision_id)).status, 'COMPLETED');
  noChainTraces(service);

  // the settlement proposal is made exactly once
  await service.bus.idle();
  assert.equal((await chronological(service)).filter((d) => d.action === 'SETTLE').length, 1);
});

test('copper-typhoon: rejecting the payment leaves the pool unsettled and proposes nothing further', async () => {
  const { service } = await runtime();
  await service.scenarios.start('copper-typhoon');
  await service.scenarios.run();
  const [payment] = service.approvals.list({ status: 'PENDING' });
  await service.reject(payment.approval_id, { by: 'admin', note: 'amount does not match the invoice' });
  await service.bus.idle();
  const decisions = await chronological(service);
  assert.equal(decisions.at(-1).action, 'RECORD_PAYMENT');
  assert.equal(decisions.at(-1).status, 'REJECTED');
  assert.equal(decisions.filter((d) => d.action === 'SETTLE').length, 0);
  assert.equal(storeState.pools.get(copper.case_id).settlement.payment_proof, undefined);
});

test('copper-typhoon: playing it twice does not duplicate anything; reset gives a clean run', async () => {
  const { service, seed } = await runtime();
  await service.scenarios.start('copper-typhoon');
  await service.scenarios.run();
  const count = (await chronological(service)).length;

  await service.scenarios.start('copper-typhoon');
  const again = await service.scenarios.run();
  assert.equal((await chronological(service)).length, count, 'the same events are recognised, not decided again');
  assert.ok(again.entries.some((e) => e.events.some((x) => x.duplicate)));
  assert.ok(again.entries.some((e) => e.skipped), 'the subscription step skips a pool that is no longer open');

  resetStore();
  seed();
  await service.scenarios.start('copper-typhoon', { reset: true });
  assert.equal((await chronological(service)).length, 0, 'reset cleared what the agent had recorded');
  await service.scenarios.run();
  assert.equal((await chronological(service)).length, count);
});

test('copper-typhoon: can be played one step at a time, and says when it is over', async () => {
  const { service } = await runtime();
  await service.scenarios.start('copper-typhoon');
  const first = await service.scenarios.step();
  assert.equal(first.done, false);
  assert.equal(first.entry.index, 0);
  assert.equal(service.scenarios.status().next_step, 1);
  assert.ok(Date.parse(first.entry.virtual_time) < Date.parse((await service.scenarios.step()).entry.virtual_time));
  for (let i = 2; i < 9; i += 1) await service.scenarios.step();
  assert.equal(service.scenarios.status().finished, true);
  const after = await service.scenarios.step();
  assert.equal(after.done, true);
  assert.equal(after.entry, undefined);
  await service.scenarios.stop();
  assert.equal(service.scenarios.status().loaded, false);
  await assert.rejects(service.scenarios.step(), (error) => error instanceof ScenarioError && error.code === 'no_scenario');
});

test('warcrisis-hormuz: a crude cargo is warned first (no price room left), paused when the strait closes, and stays paused', async () => {
  const { service } = await runtime();
  await service.scenarios.start('warcrisis-hormuz');
  const result = await service.scenarios.run();
  const decisions = await chronological(service);
  assert.deepEqual(decisions.map((d) => [d.action, d.status]), [['WARNING', 'COMPLETED'], ['PAUSE', 'COMPLETED']]);
  assert.equal(decisions[0].findings[0].kind, 'WORLD_RISK');
  assert.equal(storeState.pools.get(crude.case_id).status, 'Paused');
  assert.equal(result.entries.at(-1).events[0].decisions[0].action, 'PAUSE');
  noChainTraces(service);
});

test('scenarios: a case whose pool is already paused ignores a pause, with the reason on record', async () => {
  const { service } = await runtime();
  assert.equal(storeState.pools.get(warcrisis.case_id).status, 'Paused', 'the curated war-crisis case is seeded paused');
  const accepted = await service.submitEvent({
    type: 'WORLD_RISK_UPDATED', case_id: warcrisis.case_id, source: 'admin', event_id: 'already-paused',
    data: { events: [{ type: 'war_risk', region: 'Strait of Hormuz', severity: 'critical', description: 'closure', date: '2026-06-21' }] }
  });
  await service.bus.idle();
  assert.equal((await chronological(service)).length, 0);
  assert.equal(service.bus.get(accepted.idempotency_key).result.ignored, 'The pool is already paused');
});

test('insurance-gap: a warning a week ahead, then a pause once cover has lapsed', async () => {
  const { service } = await runtime();
  await service.scenarios.start('insurance-gap');
  const result = await service.scenarios.run();
  assert.deepEqual(result.entries.map((e) => e.change), [null, null, 'INSURANCE_EXPIRING', 'INSURANCE_EXPIRED']);
  const decisions = await chronological(service);
  assert.deepEqual(decisions.map((d) => [d.action, d.status]), [['WARNING', 'COMPLETED'], ['PAUSE', 'COMPLETED']]);
  assert.equal(decisions[0].findings[0].kind, 'INSURANCE_EXPIRING');
  assert.equal(decisions[1].findings[0].kind, 'INSURANCE_EXPIRED');
  assert.equal(storeState.pools.get(demoCase.case_id).status, 'Paused');
  assert.equal(storeState.pools.get(demoCase.case_id).warnings.length, 1);
  noChainTraces(service);
});

test('scenarios: Demo only, only known names, and the case must be in the market', async () => {
  const live = await runtime({ mode: 'live' });
  await assert.rejects(live.service.scenarios.start('copper-typhoon'), (error) => error.code === 'demo_only' && error.status === 409);

  const { service, state } = await runtime();
  await assert.rejects(service.scenarios.start('does-not-exist'), (error) => error.code === 'scenario_not_found' && error.status === 404);
  await assert.rejects(service.scenarios.start('../../package'), (error) => error.code === 'invalid_scenario_name');
  await assert.rejects(service.scenarios.start('Copper_Typhoon'), (error) => error.code === 'invalid_scenario_name');

  storeState.pools.delete(copper.case_id);
  await assert.rejects(service.scenarios.start('copper-typhoon'), (error) => error.code === 'case_not_in_market' && error.status === 409);

  // switching to Live while a scenario is loaded stops it from running
  createPool(copper.case_id, copper, quoteFromCase(copper, { payout_speed: 'FAST' }));
  await service.scenarios.start('copper-typhoon');
  state.mode = 'live';
  await assert.rejects(service.scenarios.step(), (error) => error.code === 'demo_only');
});
