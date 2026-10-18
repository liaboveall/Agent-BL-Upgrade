import fs from 'node:fs/promises';
import { hashSnapshot } from '../src/agent/decisionLogger.js';
import { CALIBRATION } from '../src/provenance/market.js';

const data = JSON.parse(await fs.readFile('data/evaluation/w4/market-benchmark.json', 'utf8'));
const errors = data.observations.slice(1).map((item, index) => {
  const prediction = Number(data.observations[index].price), actual = Number(item.price);
  return { month: item.month, previous_month_baseline: prediction, actual, error_usd_per_mt: prediction - actual, absolute_percentage_error: Math.abs(prediction - actual) / actual };
});
const report = { schema: 'agentbl-market-evaluation-v1', executed_at: new Date().toISOString(), dataset_hash: hashSnapshot(data),
  source: data.source, scope: 'one_month_persistence_benchmark_only; not a cargo valuation model', samples: errors.length,
  mape: errors.reduce((sum, item) => sum + item.absolute_percentage_error, 0) / errors.length,
  rmse_usd_per_mt: Math.sqrt(errors.reduce((sum, item) => sum + item.error_usd_per_mt ** 2, 0) / errors.length),
  current_observation_rejection_rate: data.observations.filter((item) => Date.now() - Date.parse(`${item.month}-01T00:00:00Z`) >= CALIBRATION.max_observation_age_ms).length / data.observations.length,
  errors, cargo_valuation_error: null, business_accepted: false, approved_thresholds: null, human_review_required: true };
const file = `docs/evidence/w4-local-2026-10-17/provider-runs/${report.executed_at.replaceAll(/[:.]/gu, '-')}-market.json`;
await fs.mkdir('docs/evidence/w4-local-2026-10-17/provider-runs', { recursive: true });
await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ file, mape: report.mape, rmse_usd_per_mt: report.rmse_usd_per_mt, rejection_rate: report.current_observation_rejection_rate, business_accepted: false }));
