import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPool, resetStore, storeState } from '../src/app/store.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { RiskTracker } from '../src/agent/runtime/sources/riskTracker.js';
import { insuranceEvents, createVoyageMonitor } from '../src/agent/runtime/sources/voyageMonitor.js';
import { createWorldRiskMonitor, riskEventId } from '../src/agent/runtime/sources/worldRiskMonitor.js';

const readCase = async (name) => JSON.parse(await fs.readFile(new URL(`../data/cases/${name}.case.json`, import.meta.url), 'utf8'));
const copper = await readCase('copper-sg-shanghai');

const storm = (severity, region = 'East China Sea') => ({ type: 'severe_weather', region, severity, description: 'storm', date: '2026-06-11' });
const war = (severity) => ({ type: 'war_risk', region: 'Strait of Hormuz', severity, description: 'war', date: '2026-06-11' });

// ---------------------------------------------------------------- risk tracker

test('risk tracker: the first look is a baseline, and an unchanged picture is never an event', async () => {
  const tracker = new RiskTracker({ clearTicks: 2 });
  assert.equal(await tracker.observe('C1', [storm('warning'), war('critical')]), null, 'whatever was already there is the baseline');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await tracker.observe('C1', [storm('warning'), war('critical')]), null, 'the same picture again is silence, not a repeat alert');
  }
  assert.equal(await tracker.observe('C2', []), null);
  assert.equal(await tracker.observe('C2', [storm('info')]), null, 'info is not an alert');
});

test('risk tracker: a new or worse alert is reported with the alerts that are active now', async () => {
  const tracker = new RiskTracker({ clearTicks: 2 });
  await tracker.observe('C1', []);
  const first = await tracker.observe('C1', [storm('warning')]);
  assert.equal(first.type, 'WORLD_RISK_UPDATED');
  assert.equal(first.data.max_severity, 'warning');
  assert.deepEqual(first.data.events.map((e) => e.severity), ['warning']);

  assert.equal(await tracker.observe('C1', [storm('warning')]), null);
  const worse = await tracker.observe('C1', [storm('critical')]);
  assert.equal(worse.data.max_severity, 'critical');
  assert.notEqual(worse.sequence, first.sequence, 'each change is its own occurrence');

  const another = await tracker.observe('C1', [storm('critical'), war('warning')]);
  assert.deepEqual(another.data.events.map((e) => e.type).sort(), ['severe_weather', 'war_risk']);

  // easing off without clearing is not reported: the pool was priced for the worse picture
  assert.equal(await tracker.observe('C1', [storm('warning'), war('warning')]), null);
  // but it can get worse again from there
  assert.equal((await tracker.observe('C1', [storm('critical'), war('warning')])).type, 'WORLD_RISK_UPDATED');
});

test('risk tracker: risk counts as cleared only after the configured number of quiet looks in a row', async () => {
  for (const clearTicks of [1, 2, 3]) {
    const tracker = new RiskTracker({ clearTicks });
    await tracker.observe('C1', []);
    await tracker.observe('C1', [storm('critical')]);
    for (let quiet = 1; quiet < clearTicks; quiet += 1) {
      assert.equal(await tracker.observe('C1', []), null, `quiet look ${quiet} of ${clearTicks}`);
    }
    const cleared = await tracker.observe('C1', []);
    assert.equal(cleared.type, 'RISK_CLEARED', `after ${clearTicks} quiet look(s)`);
    assert.equal(cleared.data.quiet_ticks, clearTicks);
    assert.equal(await tracker.observe('C1', []), null, 'a cleared case stays quiet');
  }
});

test('risk tracker: one alert in the middle of the quiet restarts the count (no flapping)', async () => {
  const tracker = new RiskTracker({ clearTicks: 2 });
  await tracker.observe('C1', []);
  await tracker.observe('C1', [storm('critical')]);
  assert.equal(await tracker.observe('C1', []), null);
  assert.equal(await tracker.observe('C1', [storm('critical')]), null, 'the same alert is back: no new event, and the quiet streak is gone');
  assert.equal(await tracker.observe('C1', []), null);
  assert.equal((await tracker.observe('C1', [])).type, 'RISK_CLEARED');
});

test('risk tracker: state survives a restart, so a restart does not re-announce or forget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-risk-'));
  try {
    const file = path.join(dir, 'snapshots.json');
    const first = new RiskTracker({ clearTicks: 2, file });
    await first.observe('C1', []);
    assert.equal((await first.observe('C1', [storm('warning')])).type, 'WORLD_RISK_UPDATED');
    await first.observe('C1', []);

    const second = new RiskTracker({ clearTicks: 2, file });
    assert.equal((await second.observe('C1', [])).type, 'RISK_CLEARED', 'the quiet look before the restart still counts');
    const third = new RiskTracker({ clearTicks: 2, file });
    assert.equal(await third.observe('C1', []), null);
    await third.clear();
    assert.equal(third.state('C1'), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- insurance deadlines

test('insurance: warns inside the window, pauses after expiry, and ignores cases that are not active', () => {
  const pool = (overrides = {}) => ({ poolId: 'P1', status: 'Open', subscribedUsd: 0, caseData: { case_id: 'C1', insurance: { expires_at: '2026-07-20' } }, ...overrides });
  const at = (iso, p = pool(), options) => insuranceEvents(p, Date.parse(iso), options);

  assert.deepEqual(at('2026-07-01T00:00:00Z'), [], 'far from expiry');
  assert.deepEqual(at('2026-07-12T12:00:00Z'), [], 'eight days is outside a seven-day window');
  const expiring = at('2026-07-14T00:00:00Z');
  assert.equal(expiring.length, 1);
  assert.equal(expiring[0].type, 'INSURANCE_EXPIRING');
  assert.equal(expiring[0].data.days_left, 7);
  assert.equal(expiring[0].event_id, 'insurance-expiring:C1:2026-07-20', 'one warning per policy, however often it is checked');
  assert.equal(at('2026-07-20T23:00:00Z')[0].data.days_left, 1, 'the whole expiry day still counts as covered');

  const expired = at('2026-07-21T00:00:01Z');
  assert.equal(expired[0].type, 'INSURANCE_EXPIRED');
  assert.equal(expired[0].event_id, 'insurance-expired:C1:2026-07-20');
  assert.equal(expired[0].pool_id, 'P1');

  assert.deepEqual(at('2026-07-21T00:00:01Z', pool({ status: 'Repaid' })), [], 'a finished pool does not care');
  assert.deepEqual(at('2026-07-21T00:00:01Z', pool({ status: 'Created' })), [], 'a pool that never opened does not care');
  assert.equal(at('2026-07-21T00:00:01Z', pool({ status: 'Paused' })).length, 0, 'already paused');
  assert.equal(at('2026-07-21T00:00:01Z', pool({ status: 'Open', subscribedUsd: 10 })).length, 1);
  assert.deepEqual(at('2026-07-14T00:00:00Z', pool(), { warnDays: 3 }), []);
  assert.equal(at('2026-07-18T00:00:00Z', pool(), { warnDays: 3 }).length, 1);

  assert.deepEqual(insuranceEvents({ poolId: 'P', status: 'Open', caseData: { case_id: 'C' } }, Date.now()), [], 'no policy on file');
  assert.deepEqual(insuranceEvents({ poolId: 'P', status: 'Open', caseData: { case_id: 'C', insurance: { expires_at: 'soon' } } }, Date.now()), []);
});

test('insurance monitor: Demo stays silent on the real clock; a scenario clock or Live checks the policy', async () => {
  const pool = { poolId: 'P1', status: 'Open', subscribedUsd: 0, caseData: { case_id: 'C1', insurance: { expires_at: '2026-07-05' } } };
  const service = (mode, chainLinked) => ({
    getMode: () => mode,
    now: () => new Date('2026-10-13T00:00:00Z'),
    config: { insuranceWarnDays: 7 },
    ensurePools: async () => {},
    store: { pools: new Map([['P1', pool]]) },
    registry: { get: () => (chainLinked ? { chain: { pool_id: 2 } } : null) }
  });

  assert.deepEqual(await createVoyageMonitor()({ service: service('demo') }), [], 'every Demo policy would look expired against today');
  const scripted = await createVoyageMonitor({ getClock: () => Date.parse('2026-07-01T00:00:00Z') })({ service: service('demo') });
  assert.deepEqual(scripted.map((e) => [e.type, e.source, e.source_mode]), [['INSURANCE_EXPIRING', 'voyage-monitor', 'demo']]);
  const live = await createVoyageMonitor()({ service: service('live', true) });
  assert.deepEqual(live.map((e) => [e.type, e.source_mode]), [['INSURANCE_EXPIRED', 'live']]);
  assert.deepEqual(await createVoyageMonitor()({ service: service('live', false) }), [], 'Live only watches pools mapped to a chain pool');
});

// ---------------------------------------------------------------- world-risk monitor source

function stubService(mode, pools, linked = new Set()) {
  return {
    getMode: () => mode,
    ensurePools: async () => {},
    store: { pools: new Map(pools.map((pool) => [pool.poolId, pool])) },
    registry: { get: (caseId) => (linked.has(caseId) ? { chain: { pool_id: 2 } } : null) }
  };
}

test('world-risk monitor: baseline, change, repeat, escalation and clearing, with deterministic event ids', async () => {
  const feed = [];
  const tracker = new RiskTracker({ clearTicks: 2 });
  const monitor = createWorldRiskMonitor({ tracker, assess: async () => ({ events: feed.at(-1) ?? [], live: false, evidence_hash: `0x${'ab'.repeat(32)}` }) });
  const service = stubService('demo', [{ poolId: 'P1', status: 'Open', caseData: { case_id: 'C1' } }]);
  const poll = async (events) => { feed.push(events); return monitor({ service }); };

  assert.deepEqual(await poll([war('critical')]), [], 'the fixture that was already there is the baseline');
  assert.deepEqual(await poll([war('critical')]), [], 'a static fixture never repeats itself');
  const [raised] = await poll([war('critical'), storm('warning')]);
  assert.equal(raised.type, 'WORLD_RISK_UPDATED');
  assert.equal(raised.case_id, 'C1');
  assert.equal(raised.pool_id, 'P1');
  assert.equal(raised.source, 'world-risk-monitor');
  assert.equal(raised.source_mode, 'fixture');
  assert.equal(raised.evidence_hash, `0x${'ab'.repeat(32)}`);
  assert.match(raised.event_id, /^risk:C1:1:[0-9a-f]{12}$/u);
  assert.deepEqual(await poll([war('critical'), storm('warning')]), []);
  assert.deepEqual(await poll([]), []);
  const [cleared] = await poll([]);
  assert.equal(cleared.type, 'RISK_CLEARED');
  assert.equal(cleared.event_id, riskEventId('C1', { type: 'RISK_CLEARED', sequence: 2 }));
  assert.notEqual(cleared.event_id, raised.event_id);
});

test('world-risk monitor: live evidence is labelled live, finished pools and unmapped Live pools are skipped, a failing feed is not fatal', async () => {
  const tracker = new RiskTracker({ clearTicks: 2 });
  let live = true;
  let broken = false;
  let calls = 0;
  const monitor = createWorldRiskMonitor({
    tracker,
    assess: async () => {
      calls += 1;
      if (broken) throw new Error('feed down');
      return { events: calls > 2 ? [war('critical')] : [], live };
    }
  });
  const pools = [
    { poolId: 'P1', status: 'Open', caseData: { case_id: 'C1' } },
    { poolId: 'P2', status: 'Repaid', caseData: { case_id: 'C2' } },
    { poolId: 'P3', status: 'Open', caseData: { case_id: 'C3' } }
  ];
  const service = stubService('live', pools, new Set(['C1']));
  await monitor({ service });
  assert.equal(calls, 1, 'only the mapped, unfinished pool was looked at');
  const [event] = await monitor({ service });
  assert.equal(event, undefined);
  const [raised] = await monitor({ service });
  assert.equal(raised.source_mode, 'live');
  broken = true;
  assert.deepEqual(await monitor({ service }), [], 'a feed error produces no event and no exception');
  live = false;
});

// ---------------------------------------------------------------- the runtime tick

test('runtime: a monitor source feeds the tick; the same fixture does not trigger the same decision twice', async () => {
  resetStore();
  storeState.agentActivities = [];
  createPool(copper.case_id, copper, quoteFromCase(copper, { payout_speed: 'FAST' }));
  let picture = [];
  const tracker = new RiskTracker({ clearTicks: 2 });
  const service = createAgentService({
    config: loadAgentConfig({ AGENT_COOLDOWN_SEC: '0' }),
    env: {},
    store: storeState,
    getMode: () => 'demo',
    chainConfig: null,
    sleep: async () => {},
    sources: [createWorldRiskMonitor({ tracker, assess: async () => ({ events: picture, live: false }) })]
  });
  await service.start();
  const tick = async () => { await service.tick(); await service.bus.idle(); };
  const decisions = async () => (await service.listDecisions()).decisions.reverse().map((d) => d.action);

  await tick();
  assert.deepEqual(await decisions(), [], 'a calm baseline decides nothing');
  picture = [storm('warning')];
  await tick();
  await tick();
  await tick();
  assert.deepEqual(await decisions(), ['REPRICE'], 'three polls of the same storm are one decision');
  picture = [storm('critical')];
  await tick();
  assert.deepEqual(await decisions(), ['REPRICE', 'PAUSE']);
  assert.equal(storeState.pools.get(copper.case_id).status, 'Paused');
  picture = [];
  await tick();
  assert.deepEqual(await decisions(), ['REPRICE', 'PAUSE'], 'one quiet poll is not enough to resume');
  await tick();
  assert.deepEqual(await decisions(), ['REPRICE', 'PAUSE', 'RESUME']);
  assert.equal(storeState.pools.get(copper.case_id).status, 'Repriced');

  const records = service.activity.list({ limit: 1000 });
  for (const record of records) assert.equal(record.tx_hash, undefined);
  await service.stop();
});

test('runtime: a throwing source does not stop the other sources or the tick', async () => {
  resetStore();
  storeState.agentActivities = [];
  createPool(copper.case_id, copper, quoteFromCase(copper, { payout_speed: 'FAST' }));
  const seen = [];
  const service = createAgentService({
    config: loadAgentConfig({}),
    env: {},
    store: storeState,
    getMode: () => 'demo',
    chainConfig: null,
    sources: [
      async () => { throw new Error('source one exploded'); },
      async () => { seen.push('second'); return []; }
    ]
  });
  await service.start();
  await service.tick();
  assert.deepEqual(seen, ['second']);
  assert.match((await service.status()).last_error.message, /source one exploded/u);
  await service.stop();
});
