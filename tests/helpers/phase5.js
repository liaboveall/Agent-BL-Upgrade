import fs from 'node:fs/promises';
import { createAgentService } from '../../src/agent/runtime/factory.js';
import { loadAgentConfig } from '../../src/agent/runtime/config.js';
import { quoteFromCase } from '../../src/core/pricingEngine.js';

export const copper = JSON.parse(await fs.readFile(new URL('../../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8'));
export const documents = await Promise.all(['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'].map(async (name) => ({
  name, kind: 'text', mime_type: 'text/markdown', text: await fs.readFile(new URL(`../../data/uploads/copper-sg-shanghai/${name}`, import.meta.url), 'utf8')
})));
export const storm = [{ type: 'severe_weather', severity: 'critical', region: 'East China Sea', description: 'Typhoon', date: '2026-10-15' }];

export async function phase5Runtime(t, options = {}) {
  let clock = Date.parse('2026-10-15T00:00:00Z');
  const quote = quoteFromCase(copper, { payout_speed: 'BALANCED' });
  const store = options.store ?? { pools: new Map([[copper.case_id, { poolId: copper.case_id, caseData: structuredClone(copper), quote,
    status: 'Open', targetUsd: quote.requested_cash_usd, subscribedUsd: 0 }]]), agentActivities: [] };
  const service = createAgentService({ env: {}, store, chainConfig: null, getChainContext: async () => null, monitors: false,
    now: () => new Date(clock), config: loadAgentConfig({ AGENT_COOLDOWN_SEC: '0', AGENT_VALUATION_LLM: 'false', ...options.config }),
    dir: options.dir, sleep: async () => {} });
  await service.start(); t.after(() => service.stop());
  return { service, store, advance: (ms) => { clock += ms; } };
}

export async function riskDecision(service, extra = {}) {
  const accepted = await service.submitEvent({ type: 'WORLD_RISK_UPDATED', case_id: copper.case_id, source: 'admin',
    event_id: 'phase5-risk', data: { events: storm }, ...extra });
  const settled = await service.waitFor(accepted.idempotency_key);
  return service.logger.get(settled.result.decisions[0]);
}
