import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveAutonomy, loadAgentConfig, parsePoolList } from '../src/agent/runtime/config.js';
import { AGENT_ACTIONS, evaluatePolicy } from '../src/agent/runtime/policy.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const demoAuto = { mode: 'demo', autonomy: 'auto', now: NOW };
const livePropose = { mode: 'live', autonomy: 'propose', now: NOW };

function run(action, ctx = demoAuto, extra = {}) {
  return evaluatePolicy({ action, pool_id: 'P1', ...extra }, ctx);
}
const rules = (result) => result.reasons.map((r) => r.rule);

// [name, action, ctx, proposal extras, expected verdict, rule that must be among the reasons, expected action_override]
const TABLE = [
  ['demo auto: a reversible action runs unattended', 'REPRICE', demoAuto, {}, 'AUTO', 'AUTONOMY_LEVEL', null],
  ['demo auto: PAUSE runs unattended', 'PAUSE', demoAuto, {}, 'AUTO', 'AUTONOMY_LEVEL', null],
  ['demo propose: needs approval', 'REPRICE', { ...demoAuto, autonomy: 'propose' }, {}, 'NEEDS_APPROVAL', 'AUTONOMY_LEVEL', null],
  ['autonomy off refuses everything', 'REPRICE', { ...demoAuto, autonomy: 'off' }, {}, 'REJECTED', 'AUTONOMY', null],
  ['observe only records', 'REPRICE', { ...demoAuto, autonomy: 'observe' }, {}, 'OBSERVE_ONLY', 'AUTONOMY', null],
  ['live: every action needs approval', 'REPRICE', livePropose, {}, 'NEEDS_APPROVAL', 'LIVE_REQUIRES_APPROVAL', null],
  ['live: even PAUSE needs approval', 'PAUSE', livePropose, {}, 'NEEDS_APPROVAL', 'LIVE_REQUIRES_APPROVAL', null],
  ['emergency stop refuses a reprice', 'REPRICE', { ...demoAuto, emergencyStopped: true }, {}, 'REJECTED', 'EMERGENCY_STOP', null],
  ['emergency stop still lets PAUSE through', 'PAUSE', { ...demoAuto, emergencyStopped: true }, {}, 'AUTO', 'AUTONOMY_LEVEL', null],
  ['protected pool: SETTLE refused', 'SETTLE', { ...demoAuto, protectedPool: true }, {}, 'REJECTED', 'PROTECTED_POOL', null],
  ['protected pool: FREEZE refused', 'FREEZE', { ...demoAuto, protectedPool: true }, {}, 'REJECTED', 'PROTECTED_POOL', null],
  ['protected pool: LIQUIDATE refused', 'LIQUIDATE', { ...demoAuto, protectedPool: true }, {}, 'REJECTED', 'PROTECTED_POOL', null],
  ['protected pool: CANCEL refused', 'CANCEL', { ...demoAuto, protectedPool: true }, {}, 'REJECTED', 'PROTECTED_POOL', null],
  ['protected pool: REPRICE is fine', 'REPRICE', { ...demoAuto, protectedPool: true }, {}, 'AUTO', 'AUTONOMY_LEVEL', null],
  ['protected pool: PAUSE and RESUME are fine', 'RESUME', { ...demoAuto, protectedPool: true }, {}, 'AUTO', 'AUTONOMY_LEVEL', null],
  ['prompt injection → hold for review', 'OPEN', demoAuto, { findings: [{ kind: 'PROMPT_INJECTION_SUSPECTED' }] }, 'NEEDS_APPROVAL', 'UNSAFE_FINDING', 'HOLD_FOR_REVIEW'],
  ['compliance REVIEW → hold for review', 'OPEN', demoAuto, { findings: [{ kind: 'COMPLIANCE_REVIEW' }] }, 'NEEDS_APPROVAL', 'UNSAFE_FINDING', 'HOLD_FOR_REVIEW'],
  ['compliance BLOCK → reject', 'OPEN', demoAuto, { findings: [{ kind: 'COMPLIANCE_BLOCK' }] }, 'REJECTED', 'UNSAFE_FINDING', 'REJECT'],
  ['an unrelated finding changes nothing', 'OPEN', demoAuto, { findings: [{ kind: 'INFO' }] }, 'AUTO', 'AUTONOMY_LEVEL', null],
  ['a model-only signal is only observed', 'PAUSE', demoAuto, { llm_only: true }, 'OBSERVE_ONLY', 'LLM_ONLY_SIGNAL', null],
  ['stale evidence needs approval', 'REPRICE', { ...demoAuto, evidenceStale: true }, {}, 'NEEDS_APPROVAL', 'STALE_EVIDENCE', null],
  ['SETTLE always needs approval', 'SETTLE', demoAuto, {}, 'NEEDS_APPROVAL', 'IRREVERSIBLE', null],
  ['FREEZE always needs approval', 'FREEZE', demoAuto, {}, 'NEEDS_APPROVAL', 'IRREVERSIBLE', null],
  ['RECORD_PAYMENT always needs approval', 'RECORD_PAYMENT', demoAuto, {}, 'NEEDS_APPROVAL', 'IRREVERSIBLE', null],
  ['RECORD_ARRIVAL is reversible enough to run', 'RECORD_ARRIVAL', demoAuto, {}, 'AUTO', 'AUTONOMY_LEVEL', null],
  ['MARK_IN_TRANSIT runs in demo auto', 'MARK_IN_TRANSIT', demoAuto, {}, 'AUTO', 'AUTONOMY_LEVEL', null],
  ['a price move above the cap needs approval', 'REPRICE', demoAuto, { price_move_bps: 1501 }, 'NEEDS_APPROVAL', 'PRICE_GUARD', null],
  ['a price move at the cap is fine', 'REPRICE', demoAuto, { price_move_bps: 1500 }, 'AUTO', 'AUTONOMY_LEVEL', null],
  ['a price below the exporter floor needs approval', 'REPRICE', { ...demoAuto, exporterPreferences: { min_acceptable_issue_price: 0.85 } }, { new_issue_price_usd: 0.8 }, 'NEEDS_APPROVAL', 'PRICE_GUARD', null],
  ['a price at the exporter floor is fine', 'REPRICE', { ...demoAuto, exporterPreferences: { min_acceptable_issue_price: 0.85 } }, { new_issue_price_usd: 0.85 }, 'AUTO', 'AUTONOMY_LEVEL', null]
];

for (const [name, action, ctx, extra, verdict, mustInclude, override] of TABLE) {
  test(`policy: ${name}`, () => {
    const result = run(action, ctx, extra);
    assert.equal(result.verdict, verdict);
    assert.ok(rules(result).includes(mustInclude), `expected ${mustInclude} among ${rules(result)}`);
    assert.equal(result.action_override, override);
    assert.equal(result.action, action);
  });
}

test('policy: the cooldown blocks the same action on the same pool but not a different one', () => {
  const ctx = { ...demoAuto, recentActions: [{ action: 'REPRICE', at: iso(60_000) }] };
  const repeat = run('REPRICE', ctx);
  assert.equal(repeat.verdict, 'OBSERVE_ONLY');
  assert.ok(rules(repeat).includes('COOLDOWN'));
  assert.match(repeat.reasons.find((r) => r.rule === 'COOLDOWN').message, /cooldown 600s/u);
  assert.equal(run('PAUSE', ctx).verdict, 'AUTO', 'a PAUSE after a REPRICE is a different move');
  assert.equal(run('REPRICE', { ...demoAuto, recentActions: [{ action: 'REPRICE', at: iso(601_000) }] }).verdict, 'AUTO');
});

test('policy: the cooldown is configurable and the daily limit debounces a flapping signal', () => {
  const past = Array.from({ length: 3 }, (_, i) => ({ action: i % 2 ? 'PAUSE' : 'RESUME', at: iso((i + 1) * 3_600_000) }));
  const ctx = { ...demoAuto, recentActions: past, thresholds: { maxActionsPerPoolPerDay: 3 } };
  const result = run('REPRICE', ctx);
  assert.equal(result.verdict, 'OBSERVE_ONLY');
  assert.match(result.reasons.find((r) => r.rule === 'COOLDOWN').message, /3 agent actions in 24h/u);
  // Actions older than 24h do not count.
  const old = [{ action: 'PAUSE', at: iso(25 * 3_600_000) }];
  assert.equal(run('REPRICE', { ...demoAuto, recentActions: old, thresholds: { maxActionsPerPoolPerDay: 1 } }).verdict, 'AUTO');
  assert.equal(run('REPRICE', { ...demoAuto, recentActions: [{ action: 'REPRICE', at: iso(5_000) }], thresholds: { cooldownSec: 1 } }).verdict, 'AUTO');
});

test('policy: the cooldown sits before the Live approval rule so a flapping signal never floods the queue', () => {
  const ctx = { ...livePropose, recentActions: [{ action: 'REPRICE', at: iso(1000) }] };
  const result = run('REPRICE', ctx);
  assert.equal(result.verdict, 'OBSERVE_ONLY');
  assert.ok(rules(result).includes('LIVE_REQUIRES_APPROVAL'), 'the later rule is still listed as a reason');
});

test('policy: the first matching rule decides the verdict, every matching rule is listed', () => {
  const result = run('SETTLE', { ...livePropose, protectedPool: true, evidenceStale: true }, { price_move_bps: 9999 });
  assert.equal(result.verdict, 'REJECTED', 'protected pool outranks everything after it');
  assert.deepEqual(rules(result), ['PROTECTED_POOL', 'LIVE_REQUIRES_APPROVAL', 'STALE_EVIDENCE', 'IRREVERSIBLE', 'PRICE_GUARD', 'AUTONOMY_LEVEL']);

  const emergency = run('REPRICE', { ...livePropose, emergencyStopped: true, autonomy: 'off' });
  assert.equal(emergency.verdict, 'REJECTED');
  assert.deepEqual(rules(emergency).slice(0, 2), ['EMERGENCY_STOP', 'AUTONOMY']);

  const live = run('REPRICE', livePropose, { price_move_bps: 5000 });
  assert.equal(live.verdict, 'NEEDS_APPROVAL');
  assert.deepEqual(rules(live), ['LIVE_REQUIRES_APPROVAL', 'PRICE_GUARD', 'AUTONOMY_LEVEL']);
});

test('policy: the unattended-irreversible exemption works in Demo only', () => {
  const thresholds = { allowUnattendedIrreversible: true };
  assert.equal(run('SETTLE', { ...demoAuto, thresholds }).verdict, 'AUTO');
  assert.equal(run('RECORD_PAYMENT', { ...demoAuto, thresholds }).verdict, 'AUTO');
  assert.equal(run('SETTLE', { ...livePropose, thresholds }).verdict, 'NEEDS_APPROVAL');
  // ...and never overrides the protected pool.
  assert.equal(run('SETTLE', { ...demoAuto, thresholds, protectedPool: true }).verdict, 'REJECTED');
});

test('policy: rejects unknown actions, modes and autonomy levels instead of guessing', () => {
  assert.throws(() => run('EXPLODE'), /Unknown agent action/u);
  assert.throws(() => evaluatePolicy({ action: 'REPRICE' }, { mode: 'staging', autonomy: 'auto' }), /ctx\.mode/u);
  assert.throws(() => evaluatePolicy({ action: 'REPRICE' }, { mode: 'demo', autonomy: 'yolo' }), /autonomy/u);
  for (const action of AGENT_ACTIONS) assert.ok(run(action).verdict, action);
});

test('config: Live never runs above propose, Demo defaults to auto (D1)', () => {
  assert.deepEqual(effectiveAutonomy('demo', undefined), { effective: 'auto', configured: null, downgraded: false });
  assert.deepEqual(effectiveAutonomy('live', undefined), { effective: 'propose', configured: null, downgraded: false });
  assert.deepEqual(effectiveAutonomy('live', 'auto'), { effective: 'propose', configured: 'auto', downgraded: true });
  assert.equal(effectiveAutonomy('live', 'observe').effective, 'observe');
  assert.equal(effectiveAutonomy('live', 'off').effective, 'off');
  assert.equal(effectiveAutonomy('demo', 'propose').effective, 'propose');
  assert.equal(effectiveAutonomy('demo', 'nonsense').effective, 'auto', 'an invalid value falls back to the default');
});

test('config: environment parsing, defaults and bounds', () => {
  const defaults = loadAgentConfig({});
  assert.equal(defaults.enabled, true);
  assert.deepEqual(defaults.protectedChainPools, [2]);
  assert.equal(defaults.monitorIntervalSec, 300);
  assert.equal(defaults.maxPriceMoveBps, 1500);
  assert.equal(defaults.allowUnattendedIrreversible, false);
  assert.equal(defaults.maxDecisions, 5000);

  const custom = loadAgentConfig({
    AGENT_ENABLED: 'false', AGENT_MONITOR_INTERVAL_SEC: '5', AGENT_PROTECTED_CHAIN_POOLS: '3, 2,x,2',
    AGENT_COOLDOWN_SEC: '0', AGENT_ALLOW_UNATTENDED_IRREVERSIBLE: 'true', AGENT_MAX_ACTIONS_PER_POOL_PER_DAY: 'abc'
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.monitorIntervalSec, 30, 'the monitor interval has a floor of 30s');
  assert.deepEqual(custom.protectedChainPools, [2, 3]);
  assert.equal(custom.cooldownSec, 0);
  assert.equal(custom.allowUnattendedIrreversible, true);
  assert.equal(custom.maxActionsPerPoolPerDay, 12, 'garbage falls back to the default');
  assert.deepEqual(loadAgentConfig({ AGENT_PROTECTED_CHAIN_POOLS: '' }).protectedChainPools, [], 'an explicit empty list clears protection');
  assert.deepEqual(parsePoolList('0,-1,1.5,7'), [7]);
});

test('policy: informational actions (WARNING, HOLD_FOR_REVIEW, REJECT) are records and never wait for approval', () => {
  for (const action of ['WARNING', 'HOLD_FOR_REVIEW', 'REJECT']) {
    const live = run(action, livePropose);
    assert.equal(live.verdict, 'AUTO', `${action} in Live`);
    assert.deepEqual(rules(live), ['INFORMATIONAL']);
    assert.equal(run(action, { ...demoAuto, emergencyStopped: true }).verdict, 'AUTO', 'an emergency stop does not hide a record');
    assert.equal(run(action, { ...demoAuto, evidenceStale: true }).verdict, 'AUTO');
  }
  assert.equal(run('WARNING', { ...demoAuto, autonomy: 'observe' }).verdict, 'OBSERVE_ONLY', 'observe mode still only observes');
  assert.equal(run('WARNING', { ...demoAuto, autonomy: 'off' }).verdict, 'REJECTED');
  assert.equal(run('WARNING', { ...livePropose, recentActions: [{ action: 'WARNING', at: iso(1000) }] }).verdict, 'OBSERVE_ONLY', 'repeated warnings are debounced');
});
