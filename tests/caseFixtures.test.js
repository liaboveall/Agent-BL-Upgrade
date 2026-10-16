// Fixture health: every curated case must survive the whole pricing / risk / intel
// chain. One case with a legacy payout_speed ("SAFE") used to make
// POST /api/intel/world-risk answer 500 for that case only, and no test noticed
// because nothing iterated over the catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateRisk } from '../src/core/riskEngine.js';
import { assertRiskReport, assertTradeCase } from '../src/core/schema.js';
import { compareSpeeds, quoteFromCase } from '../src/core/pricingEngine.js';
import { assertPricingQuote, PAYOUT_SPEEDS } from '../src/core/pricingSchema.js';
import { simulatePricingWorkflow } from '../src/core/pricingWorkflow.js';
import { assessWorldRisk } from '../src/agent/worldRiskAgent.js';
import { repriceWithWorldRisk } from '../src/core/worldRiskPricing.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const fixtures = [
  ['demo-case.json', path.join(dataDir, 'demo-case.json')],
  ...fs.readdirSync(path.join(dataDir, 'cases'))
    .filter((name) => name.endsWith('.case.json'))
    .sort()
    .map((name) => [`cases/${name}`, path.join(dataDir, 'cases', name)])
];

delete process.env.XAPI_KEY; // deterministic offline intel fixtures

test('there are curated cases to check', () => {
  assert.ok(fixtures.length >= 11, `expected the full catalog, found ${fixtures.length}`);
});

for (const [label, file] of fixtures) {
  test(`fixture ${label} prices, scores and re-prices end to end`, async () => {
    const caseData = JSON.parse(fs.readFileSync(file, 'utf8'));

    const speed = caseData.financing?.payout_speed;
    assert.ok(speed === undefined || PAYOUT_SPEEDS.includes(speed), `payout_speed "${speed}" is not a valid speed`);

    // The legacy RiskReport pipeline (and its schema) only describes the demo case;
    // data/cases/* are new-model cases that are priced by the PricingQuote engine.
    if (label === 'demo-case.json') {
      assertTradeCase(caseData);
      assertRiskReport(calculateRisk(caseData), caseData);
    }

    assertPricingQuote(quoteFromCase(caseData), caseData);
    const comparison = compareSpeeds(caseData);
    assert.equal(comparison.quotes.length, PAYOUT_SPEEDS.length);

    const workflow = simulatePricingWorkflow(caseData, {});
    assert.ok(workflow);

    const assessment = await assessWorldRisk(caseData, {});
    const repriced = repriceWithWorldRisk(caseData, assessment.events);
    assert.ok(Number.isFinite(repriced.after.final_issue_price_usd));
    assert.ok(Number.isFinite(repriced.before.final_issue_price_usd));
  });
}
