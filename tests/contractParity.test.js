// The Solidity sources are the source of truth for numeric codes. This keeps the JS
// harness, the deploy-script smoke check and the docs from silently drifting away from
// them (a stale action or state code only shows up on-chain, as a wrong transition).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PRICING_ACTION_TO_UINT8, RISK_LEVEL_TO_UINT8 } from '../src/core/contractHarness.js';
import { RWA_OFFERING_STATES } from '../src/core/pricingSchema.js';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
const contract = (name) => read('hardhat', 'contracts', `${name}.sol`);

function publicConstants(source) {
  return Object.fromEntries(
    [...source.matchAll(/uint\d*\s+public\s+constant\s+([A-Z_]+)\s*=\s*([\d_]+)\s*;/gu)]
      .map((match) => [match[1], Number(match[2].replaceAll('_', ''))])
  );
}

function enumMembers(source, name) {
  const body = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`, 'u').exec(source)?.[1];
  assert.ok(body, `enum ${name} not found`);
  return body.replace(/\/\/[^\n]*/gu, '').split(',').map((member) => member.trim()).filter(Boolean);
}

test('pool action codes match the JS harness and the AgentBLRWA action enum', () => {
  // The only public constants of the pool are its action codes, so a newly added action
  // that the harness does not know about fails this comparison.
  const pool = publicConstants(contract('RWAOfferingPool'));
  assert.deepEqual(pool, PRICING_ACTION_TO_UINT8);

  const demoActions = enumMembers(contract('AgentBLRWA'), 'Action');
  demoActions.forEach((name, index) => assert.equal(PRICING_ACTION_TO_UINT8[name], index, `AgentBLRWA.Action.${name}`));
});

test('risk levels: harness codes, oracle limit and demo-contract limit agree', () => {
  const highest = Math.max(...Object.values(RISK_LEVEL_TO_UINT8));
  assert.equal(publicConstants(contract('RiskPricingOracle')).MAX_RISK_LEVEL, highest);
  assert.equal(publicConstants(contract('AgentBLRWA')).MAX_RISK_LEVEL, highest);
});

test('every on-chain offering state is a known lifecycle state, and Repaid keeps its code', () => {
  const states = enumMembers(contract('RWAOfferingPool'), 'OfferingState');
  for (const state of states) {
    assert.ok(RWA_OFFERING_STATES.includes(state), `${state} is missing from RWA_OFFERING_STATES`);
  }
  // The deploy smoke test compares stateOf() with a literal; it must be the Repaid index.
  const deployScript = read('hardhat', 'scripts', 'deploy-protocol.js');
  assert.match(deployScript, /finalState !== 9\b/u);
  assert.equal(states.indexOf('Repaid'), 9);
  // Order is part of the ABI (stateOf returns the index): pin the values clients rely on.
  assert.deepEqual(states.slice(0, 6), ['Created', 'Priced', 'Open', 'Subscribed', 'Funded', 'InTransit']);
  assert.equal(states[12], 'Cancelled');
  assert.deepEqual(states.slice(13), ['Defaulted', 'LossSettled']);
});
