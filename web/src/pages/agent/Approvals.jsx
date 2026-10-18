// The human side of "the agent only proposes": each card is one proposal waiting for a decision.
// Demo actions run after approval; Live financing uses participant wallets. Historical records show the
// recorded plan, while the controlled flow verifies actual wallet transactions
// before anything is marked done.
import { useStore } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { agent } from '../../lib/agent-api.js';
import { formatDateTime, usd } from '../../lib/agent-format.js';
import { toast } from '../../lib/toast.js';
import { Badge, Button, Card, CardHead } from '../../components/ui.jsx';
import { agentStore, openDecision, refresh } from './agent-store.js';
import { StatusBadge } from './badges.jsx';
import { settlementPolicyReason, settlementReasoning } from './settlement.js';

const WAITING = ['PENDING_APPROVAL', 'AWAITING_OWNER_SIGNATURE'];




async function guarded(action, doneKey) {
  try {
    await action();
    toast(t(doneKey));
  } catch (error) {
    toast(error.message, true);
  }
  await refresh();
}

export function OpeningSummary({ decision }) {
  const opening = decision.opening;
  if (!opening || opening.kind === 'unavailable') return null;
  return (
    <div className="ac-note">
      <strong>{t(opening.kind === 'link' ? 'ac_open_existing' : 'ac_open_new')}</strong>
      <p className="muted small">{t(opening.kind === 'link' ? 'ac_open_link_hint' : 'ac_open_three_hint')}</p>
      {opening.kind === 'create' ? <p>{t('ac_open_progress', { count: opening.steps_verified ?? 0 })}</p> : null}
    </div>
  );
}

export function SettlementSummary({ decision }) {
  const verification = decision.proposal?.params?.payment_verification;
  if (decision.mode !== 'live' || verification?.source !== 'confirmed-usdc-transfer') return null;
  return (
    <div className="ac-note ac-set-evidence">
      <strong>{t('ac_set_verified')}</strong>
      <p>{t('ac_set_payment', { amount: verification.amount_usdc })}</p>
      <p className="muted small">{t('ac_set_recipient', { recipient: verification.recipient })}</p>
      <p className="muted small">{t('ac_set_finality', { block: verification.block_number, count: verification.required_confirmations })}</p>
      <p className="muted small">{t('ac_set_disclaimer')}</p>
    </div>
  );
}





/** The controls for one approval; shared by the panel and the decision drawer. */
export function ApprovalControls({ approval, decision }) {
  if (approval.route !== 'sim') return <p className="muted small">{t('controlled_issuance_required')}</p>;
  const stale = decision.freshness_status === 'stale' || decision.freshness?.fresh === false;
  if (approval.status === 'PENDING') {
    return (
      <div className="approval-controls">
        <div className="button-row">
          <Button variant="primary" disabled={stale} title={stale ? t('ac_evidence_expired') : undefined} data-focus-key={`approve:${approval.approval_id}`}
            onClick={() => guarded(() => agent.approve(approval.approval_id), 'ac_approved_toast')}>
            {t('ac_approve')}
          </Button>
          <Button variant="ghost" data-focus-key={`reject:${approval.approval_id}`} onClick={() => {
            const note = window.prompt(t('ac_reject_reason'));
            if (note === null) return;
            guarded(() => agent.reject(approval.approval_id, note.trim() || undefined), 'ac_rejected_toast');
          }}>{t('ac_reject')}</Button>
        </div>
        {stale ? <p className="text-crit small">{t('ac_evidence_expired')}</p> : null}
        <p className="muted small">{t('ac_route_sim')}</p>
      </div>
    );
  }

  return <div className="approval-controls"><StatusBadge status={approval.status} /></div>;
}

function ApprovalCard({ decision, protectedPools }) {
  const approval = decision.approval ?? {};
  const proposal = decision.proposal ?? {};
  const reasons = (decision.policy?.reasons ?? []).filter((reason) => reason.verdict === 'NEEDS_APPROVAL').map((reason) => settlementPolicyReason(decision, reason));
  return (
    <article className="approval-card">
      <header className="approval-head">
        <div className="badge-row">
          <Badge tone="info">{decision.action}</Badge>
          <strong>{decision.case_id}</strong>
          {protectedPools.has(decision.case_id) ? <Badge tone="warn" title={t('ac_protected_hint')}>{t('ac_protected')}</Badge> : null}
        </div>
        <span className="muted small">{formatDateTime(decision.created_at)}{approval.expires_at ? ` · ${t('ac_expires', { time: formatDateTime(approval.expires_at) })}` : ''}</span>
      </header>
      <p>{settlementReasoning(decision)}</p>
      <OpeningSummary decision={decision} />
      <SettlementSummary decision={decision} />
      {proposal.new_issue_price_usd !== null && proposal.new_issue_price_usd !== undefined
        ? <p className="ac-price">{t('ac_price_move', { price: usd(proposal.new_issue_price_usd), bps: proposal.price_move_bps ?? 0 })}</p> : null}
      {reasons.length ? <ul className="bullets">{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
      <ApprovalControls
        approval={{ approval_id: approval.approval_id, status: decision.status === 'AWAITING_OWNER_SIGNATURE' ? 'AWAITING_OWNER_SIGNATURE' : 'PENDING', route: approval.route }}
        decision={decision}
      />
      <button type="button" className="link-btn" data-focus-key={`details:${decision.decision_id}`} onClick={() => openDecision(decision.decision_id)}>{t('ac_details')}</button>
    </article>
  );
}

export function ApprovalsPanel() {
  const decisions = useStore(agentStore, (s) => s.decisions);
  const protectedPools = useStore(agentStore, (s) => s.protectedCases);
  const waiting = decisions.filter((decision) => WAITING.includes(decision.status) && decision.approval?.approval_id);
  return (
    <Card id="ac-approvals" className={`ac-approvals${waiting.length ? ' has-waiting' : ''}`} aria-labelledby="ac-approvals-h">
      <CardHead id="ac-approvals-h" title={t('ac_approvals_h')} level={2}>
        <Badge tone={waiting.length ? 'warn' : 'muted'}>{String(waiting.length)}</Badge>
      </CardHead>
      {!waiting.length ? <p className="muted">{t('ac_approvals_empty')}</p> : (
        <div className="approval-grid">
          {waiting.map((decision) => <ApprovalCard key={decision.decision_id} decision={decision} protectedPools={protectedPools} />)}
        </div>
      )}
    </Card>
  );
}
