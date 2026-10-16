// HTTP orchestration only. The server holds the dedicated pricing key; this CLI never resolves keys.
import { SMOKE_ACTIONS } from '../../src/agent/runtime/liveSmoke.js';

export async function runLiveSmoke({ base, token, confirm = false, runId, lifecycle = false, fetchFn = fetch, readChain }) {
  const url = new URL(base);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)
    || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS or a loopback server URL');
  const request = async (path, body) => {
    const response = await fetchFn(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(30000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Smoke request failed (${response.status}, ${result.code ?? 'unknown'})`);
    return result;
  };
  const status = await request('/api/agent/status');
  if (status.mode !== 'live' || status.autonomy.effective !== 'propose' || !status.protected_chain_pools.includes(2)) throw new Error('A Live propose-only server with protected pool #2 is required');
  const before = await readChain();
  const report = { schema: 'agent-live-smoke-v1', run_id: runId, checked_at: new Date().toISOString(),
    status: confirm ? 'RUNNING' : 'DRY_RUN', live_acceptance: false, real_transactions: 0, pool_id: 2, before, steps: [],
    actions: [...SMOKE_ACTIONS] };
  if (lifecycle) return { ...report, status: 'OWNER_ACTION_REQUIRED', pool_id: null, actions: [],
    lifecycle: { case_id: 'CASE-EBL-CU-SIN-SHA', next: 'Upload the copper fixture bundle (data/uploads/copper-sg-shanghai) through /api/agent/ingest; approve the opening plan, then authorize each owner CLI step separately.',
      sequence: ['OPEN (mintEBLV2, pledge, createOffering)', 'SUBSCRIBE (wallet confirmation)', 'MARK_IN_TRANSIT (owner CLI)',
        'RECORD_PAYMENT (verified USDC receipt + owner CLI)', 'RECORD_ARRIVAL (owner CLI)', 'SETTLE (separate approval + owner CLI)'],
      automatic_owner_transactions: 0, terminal_pool: true } };
  if (!confirm) return report;
  if (!token || !runId) throw new Error('Explicit confirmation, admin token and stable --run-id are required');
  let uncertainApproval = false;
  try {
  for (const action of SMOKE_ACTIONS) {
    const { decision } = await request('/api/agent/smoke/propose', { action, run_id: runId });
    if (decision.proposed_action !== action || Number(decision.chain_pool_id) !== 2 || decision.mode !== 'live') throw new Error('Server proposed an unexpected command');
    if (decision.status === 'EXECUTING' || decision.status === 'FAILED') throw new Error('Unconfirmed/failed smoke command requires reconciliation; no resubmission');
    let current = decision;
    if (decision.status !== 'COMPLETED') {
      if (decision.status !== 'PENDING_APPROVAL' || !decision.approval?.approval_id) throw new Error('Smoke command is not awaiting approval');
      uncertainApproval = true;
      ({ decision: current } = await request(`/api/agent/approvals/${encodeURIComponent(decision.approval.approval_id)}/approve`, {}));
    }
    if (current.status !== 'COMPLETED' || current.execution?.mode !== 'chain' || !/^0x[0-9a-fA-F]{64}$/u.test(current.execution.tx_hash ?? '')) throw new Error('Smoke transaction is unconfirmed; reconcile the saved decision before continuing');
    const step = { action, decision_id: current.decision_id, tx_hash: current.execution.tx_hash, observed: null };
    report.steps.push(step);
    // Once the server reports a confirmed hash, a verification failure cannot mean zero broadcasts.
    if (decision.status !== 'COMPLETED') report.real_transactions++;
    uncertainApproval = false;
    // Cached earlier commands are checked at their receipt block, since later steps changed the pool.
    const observed = await readChain(current, { historical: decision.status === 'COMPLETED' });
    step.observed = observed;
    if (!observed.verified) throw new Error('PricingUpdated event or pool state did not match the exact command');
  }
  } catch (error) {
    error.report = { ...report, status: 'FAIL', live_acceptance: false, real_transactions: uncertainApproval ? null : report.real_transactions,
      confirmed_steps: report.steps.filter((step) => step.observed?.verified).length };
    throw error;
  }
  return { ...report, status: 'PASS', live_acceptance: true, confirmed_transactions: report.steps.length,
    reused_transactions: report.steps.length - report.real_transactions, after: await readChain() };
}
