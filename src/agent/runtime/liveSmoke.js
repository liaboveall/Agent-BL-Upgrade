import { proposeFromEvent } from '../pipelines/monitorPipeline.js';
import { normalizeEvent } from './events.js';
import { SimExecutor } from './executors/simExecutor.js';

export const SMOKE_ACTIONS = Object.freeze(['REPRICE', 'PAUSE', 'RESUME']);

export function smokeEvent({ action, runId, caseId, now }) {
  if (!SMOKE_ACTIONS.includes(action) || !/^[A-Za-z0-9_-]{8,80}$/u.test(runId)) throw new Error('Invalid smoke action or run id');
  return normalizeEvent({ event_id: `live-smoke:${runId}:${action}`, type: action === 'RESUME' ? 'RISK_CLEARED' : 'WORLD_RISK_UPDATED',
    case_id: caseId, source: 'agent', source_mode: 'live', data: { events: action === 'RESUME' ? []
      : [{ type: 'severe_weather', region: 'East China Sea', severity: action === 'PAUSE' ? 'critical' : 'warning',
        description: 'Explicit operator-triggered testnet smoke input', date: now.toISOString().slice(0, 10) }] }
  }, { now: () => now, defaultMode: 'live' });
}

/** Read-only forecast using the same state/price effects as the contract-aligned simulator. */
export async function previewSmokePlan(pool, { now = new Date(), runId = 'phase5-readonly-plan' } = {}) {
  const view = structuredClone(pool);
  const sim = new SimExecutor({ store: { pools: new Map([[view.poolId, view]]) } });
  const steps = [];
  for (const action of SMOKE_ACTIONS) {
    const event = smokeEvent({ action, runId, caseId: view.caseData.case_id, now });
    const proposal = proposeFromEvent(event, { pool: view, mode: 'live' }).proposals[0];
    if (proposal?.action !== action) throw new Error(`Current evidence cannot propose ${action}`);
    const effects = (await sim.execute({ action, params: proposal.params, pool_id: view.poolId,
      decision_id: `readonly-${action}`, idempotency_key: `readonly-${action}` })).effects;
    steps.push({ action, proposal, effects });
  }
  return steps;
}

export async function proposeLiveSmoke(service, { action, run_id: runId }) {
  if (service.env.AGENT_LIVE_SMOKE_ENABLED !== 'true' || service.getMode() !== 'live') throw Object.assign(new Error('Live smoke must be explicitly enabled on a Live server'), { status: 403, code: 'live_smoke_disabled', expose: true });
  if (!service.running) throw Object.assign(new Error('Start the Agent runtime before smoke'), { status: 409, code: 'agent_stopped', expose: true });
  await service.ensurePools();
  await service.chainWatcher?.poll(service);
  const entry = service.registry.list().find((pool) => Number(pool.chain?.pool_id) === 2);
  if (!entry || !service.registry.isProtected(entry.case_id)) throw new Error('Smoke requires the verified protected pool #2');
  const pool = service.store.pools.get(entry.pool_id) ?? [...service.store.pools.values()].find((item) => item.caseData?.case_id === entry.case_id);
  if (!pool?.quote || !pool.caseData) throw new Error('Pool #2 has no structured quote snapshot');
  const event = smokeEvent({ action, runId, caseId: entry.case_id, now: service.now() });
  const prior = (await service.logger.list({ case_id: entry.case_id })).filter((decision) => decision.event_id?.startsWith(`live-smoke:${runId}:`));
  const existing = prior.find((decision) => decision.proposed_action === action);
  if (existing) return { decision: await service.getDecision(existing.decision_id), reused: true };
  const index = SMOKE_ACTIONS.indexOf(action);
  if (index > 0 && !prior.some((decision) => decision.proposed_action === SMOKE_ACTIONS[index - 1] && decision.status === 'COMPLETED')) throw new Error('Complete the preceding smoke action before proposing the next one');
  const proposed = proposeFromEvent(event, { pool, mode: 'live', now: () => service.now().getTime() });
  if (proposed.proposals[0]?.action !== action) throw new Error(`Current pool evidence cannot safely propose ${action}; refresh the mirror and quote`);
  const accepted = await service.submitEvent(event, { origin: 'internal' });
  const processing = await service.waitFor(accepted.idempotency_key);
  const id = processing.result?.decisions?.[0];
  if (!id) throw new Error('Smoke proposal did not produce a decision');
  return { decision: await service.getDecision(id), reused: false };
}
