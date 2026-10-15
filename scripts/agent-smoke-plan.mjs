// Standalone read-only preparation for the separately authorized testnet run.
import fs from 'node:fs/promises';
import { loadChainConfig } from '../src/agent/runtime/factory.js';
import { createChainContext, oracleDecisionId, PRICING_ACTION_FOR } from '../src/agent/runtime/executors/chainExecutor.js';
import { toChainPricingArgs } from '../src/core/oracle.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { chainStateName } from '../src/agent/runtime/poolRules.js';
import { previewSmokePlan } from '../src/agent/runtime/liveSmoke.js';

const attempt = Date.now();
const file = `docs/evidence/phase5-smoke-plan-${attempt}.json`;
const report = { checked_at: new Date().toISOString(), real_transactions: 0, private_keys_read: false, mode: 'read-only', pool_id: 2, ready: false, steps: [] };
let context, timer;
try {
  const config = loadChainConfig(); context = await createChainContext({ chainConfig: config, env: {}, readOnly: true });
  const [chain, state, offering, stopped, block] = await Promise.race([
    Promise.all([context.provider.send('eth_chainId', []), context.pool.stateOf(2), context.pool.offerings(2), context.pool.emergencyStopped(), context.provider.getBlockNumber()]),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read-only RPC timed out')), 20000); })
  ]);
  if (Number(chain) !== Number(config.chainIdDecimal) || !offering.exists || stopped) throw new Error('Wrong chain, missing pool or emergency stop');
  const caseData = JSON.parse(await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8'));
  const quote = quoteFromCase(caseData); // Canonical financing.payout_speed is FAST for this pool.
  if (Math.round(quote.final_issue_price_usd * 1e6) !== Number(offering.issuePrice)) throw new Error('A structured quote matching the current chain price is required; never fabricate a repeat REPRICE');
  const pool = { poolId: caseData.case_id, status: chainStateName(state), caseData, quote, subscribedUsd: Number(offering.subscribed) / 1e6 };
  Object.assign(report, { chain_id: Number(chain), block_number: block, initial_state: pool.status, initial_issue_price_e6: String(offering.issuePrice), payout_speed: quote.payout_speed });
  for (const { action, proposal, effects } of await previewSmokePlan(pool)) {
    const args = toChainPricingArgs({ ...proposal.params.quote, pricing_action: PRICING_ACTION_FOR[action] }, { pool_id: 2 });
    if (await context.oracle.isDecisionProcessed(await oracleDecisionId(args))) throw new Error(`${action} commitment was already processed; do not replay it`);
    report.steps.push({ action, quote_issue_price_usd: proposal.params.quote.final_issue_price_usd,
      expected_pool_issue_price_usd: effects.issue_price_after_usd, expected_pool_state: effects.state_after,
      evidence_hash: proposal.evidence_hash, quote_hash: proposal.quote_hash, from_state: effects.state_before });
  }
  report.ready = true; report.status = 'READ_ONLY_PLAN';
} catch (error) { report.status = 'NOT_READY'; report.error = String(error.message).slice(0, 200); process.exitCode = 1; }
finally { clearTimeout(timer); context?.provider?.destroy?.(); }
await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ ...report, file }));
