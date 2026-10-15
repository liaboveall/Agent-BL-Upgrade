import { z } from 'zod';
import { describeError, HttpError } from '../app/http.js';
import { normalizeEvent } from '../agent/runtime/events.js';
import { LIVE_ADMIN_EVENT_TYPES } from '../agent/runtime/agentService.js';
import { AGENT_ACTIONS, POLICY_RULES, IRREVERSIBLE_ACTIONS } from '../agent/runtime/policy.js';
import { sanitizeAudit } from '../agent/security/privacy.js';
import { withReferences } from '../agent/runtime/references.js';
import { delegatePricingSchema, delegatePricingJsonSchema } from '../interop/delegation.js';
import { checkedInterop } from '../interop/validation.js';
import { assertHumanApproval, McpWritePolicyError } from './security.js';
import { callAgentBackend } from './agentClient.js';

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u);
const schemas = {
  get_agent_status: z.object({}).strict(),
  list_agent_decisions: z.object({ case_id: id.optional(), pool_id: id.optional(), status: id.optional(),
    action: z.enum(AGENT_ACTIONS).optional(), limit: z.number().int().min(1).max(200).optional(), cursor: id.optional() }).strict(),
  explain_decision: z.object({ decision_id: id }).strict(),
  submit_agent_event: z.object({ event: z.record(z.string(), z.unknown()), dry_run: z.boolean().optional(),
    approved: z.boolean().optional(), approval_token: z.string().max(4096).optional() }).strict(),
  recommend_trade_assets: z.object({ message: z.string().trim().min(1).max(2000), locale: z.enum(['zh', 'en']).optional(),
    limit: z.number().int().min(1).max(10).optional(), pool_ids: z.array(id).max(5).optional() }).strict(),
  delegate_pricing: delegatePricingSchema
};
const descriptions = {
  get_agent_status: 'Read the current application runtime status. Does not start the agent or create a second runtime.',
  list_agent_decisions: 'Read filtered, paginated and redacted agent decisions, newest first.',
  explain_decision: 'Read a recorded decision, its policy reasons, evidence references and available trace. Does not rerun models or execute actions.',
  submit_agent_event: 'Validate an operator event. Defaults to dry-run with no queue writes. Actual submission requires approved=true and the out-of-band host approval token; Live restrictions and normal policy/approval gates still apply.',
  recommend_trade_assets: 'Query the existing Copilot without persisting a session. Applies current pools, hard filters and explainable ranking. Never purchases or subscribes.',
  delegate_pricing: 'Delegate a stateless, indicative quotation using a case id or supplied case data. Optionally attach unexpired reports already delivered by this server via paid_report_ids. Never buys a report, changes risk because of payment, or submits a transaction.'
};

export const AGENT_MCP_TOOLS = Object.freeze(Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name], inputSchema: name === 'delegate_pricing' ? delegatePricingJsonSchema : z.toJSONSchema(schema, { target: 'draft-7' })
})));

export function externalDecision(decision) {
  const { replay: _privateReplay, ...record } = decision;
  return withReferences(record);
}

export async function publicAgentPolicy(service) {
  const status = await service.status();
  const config = service.config;
  return {
    version: 'agentbl-policy-v1', mode: status.mode, autonomy: status.autonomy, emergency_stop: status.emergency_stop,
    actions: AGENT_ACTIONS, rules: POLICY_RULES, irreversible_actions: IRREVERSIBLE_ACTIONS,
    protected_chain_pools: config.protectedChainPools,
    thresholds: { max_price_move_bps: config.maxPriceMoveBps, cooldown_sec: config.cooldownSec,
      max_actions_per_pool_per_day: config.maxActionsPerPoolPerDay, allow_unattended_irreversible: config.allowUnattendedIrreversible },
    external_events: { default_dry_run: true, approval_required: true, live_allowed_types: LIVE_ADMIN_EVENT_TYPES },
    boundaries: { live_always_requires_approval: true, quotation_executes_transactions: false,
      payment_changes_risk_or_price: false, target_redemption_guaranteed: false }
  };
}

async function execute(name, body, context) {
  if (name === 'delegate_pricing') return context.delegate(body);
  const service = context.getService();
  if (name === 'get_agent_status') return sanitizeAudit(await service.status());
  if (name === 'list_agent_decisions') {
    const result = await service.listDecisions(body);
    return { ...result, decisions: result.decisions.map(externalDecision) };
  }
  if (name === 'explain_decision') {
    const decision = await service.getDecision(body.decision_id);
    if (!decision) throw new HttpError(404, 'decision_not_found', 'Unknown agent decision');
    return { decision: externalDecision(decision), trace: sanitizeAudit(await service.getTrace(body.decision_id) ?? null),
      explanation_source: 'recorded-decision', recomputed: false };
  }
  if (name === 'submit_agent_event') {
    const mode = service.getMode();
    const event = normalizeEvent({ ...body.event, source: 'admin', source_mode: mode }, { now: service.now, defaultMode: mode });
    if (mode === 'live' && !LIVE_ADMIN_EVENT_TYPES.includes(event.type)) throw new HttpError(403, 'event_not_allowed_in_live', 'This event cannot be injected by an external operator in Live mode');
    if (body.dry_run !== false) return { dry_run: true, submitted: false, event: sanitizeAudit(event),
      authorization: { required: true, chain_execution_authorized: false } };
    assertHumanApproval(body, context.env ?? process.env);
    const result = await service.submitEvent(event, { origin: 'api' });
    return { ...result, dry_run: false, submitted: true, chain_execution_authorized: false };
  }
  if (name === 'recommend_trade_assets') {
    const result = await context.recommend(body);
    // The ephemeral context supports the calculation but is never a persistent bearer session.
    const { context: ephemeral, ...recommendation } = result;
    return { ...recommendation, stateless: true, constraints: ephemeral.constraints, action_executed: false };
  }
  return context.delegate(body);
}

export const AGENT_MCP_HANDLERS = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, async (params, context) => {
  try {
    const body = checkedInterop(schema, params);
    if (!context) return await callAgentBackend(name, body);
    return { tool: name, result: await execute(name, body, context) };
  } catch (error) {
    if (error instanceof McpWritePolicyError) throw new HttpError(403, error.code, error.message);
    const mapped = describeError(error);
    throw new HttpError(mapped.status, mapped.code, mapped.message, mapped.details);
  }
}]));
