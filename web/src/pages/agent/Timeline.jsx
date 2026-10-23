import { useStore } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { safeExplorerUrl } from '../../lib/agent-api.js';
import { actionLabel, eventLabel, formatTime, shortId, sourceLabel } from '../../lib/agent-format.js';
import { Badge, Card, CardHead, CopyButton, Empty } from '../../components/ui.jsx';
import { agentStore, openDecision, setFilter } from './agent-store.js';
import { ModeBadge, SimulatedBadge, StatusBadge, VerdictBadge } from './badges.jsx';

/** A transaction link only from an https explorer_url; a simulated execution shows its demo: reference. */
function TxCell({ execution }) {
  if (!execution) return <span className="muted">—</span>;
  const link = safeExplorerUrl(execution.explorer_url);
  if (execution.tx_hash) {
    return link
      ? <a href={link} target="_blank" rel="noopener noreferrer" className="mono" onClick={(event) => event.stopPropagation()}>{`${shortId(execution.tx_hash, 8, 6)} ↗`}</a>
      : <code>{shortId(execution.tx_hash, 8, 6)}</code>;
  }
  if (execution.reference) return <span className="badge-row"><SimulatedBadge /><code className="muted">{shortId(execution.reference, 14, 0)}</code></span>;
  return <span className="muted">—</span>;
}

function Row({ decision, open, protectedCase }) {
  return (
    <div className={`ac-row${open ? ' is-open' : ''}`} role="listitem">
      <span className="ac-row-time mono">{formatTime(decision.created_at)}</span>
      <span className="ac-row-trigger">
        <span title={decision.event_type}>{eventLabel(decision.event_type)}</span>
        <span className="muted small">{t('ac_trigger_source', { source: sourceLabel(decision.input_snapshot?.source ?? (decision.event_type === 'DOCUMENTS_INGESTED' ? 'ingest' : '—')) })}</span>
        <span className="muted small">{decision.case_id}</span>
        <span className="badge-row">
          <ModeBadge mode={decision.input_snapshot?.source_mode ?? decision.mode} />
          {protectedCase ? <Badge tone="warn" title={t('ac_protected_hint')}>{t('ac_protected')}</Badge> : null}
        </span>
      </span>
      <span className="ac-row-action">
        <button type="button" className="ac-row-open" data-focus-key={`decision:${decision.decision_id}`}
          aria-label={t('ac_open_decision', { action: actionLabel(decision.action), case: decision.case_id })} onClick={() => openDecision(decision.decision_id)}>
          <strong>{actionLabel(decision.action)}</strong>
        </button>
        <code className="ac-row-code">{decision.action}</code>
        {decision.proposed_action && decision.proposed_action !== decision.action ? <span className="muted small">{`(${actionLabel(decision.proposed_action)})`}</span> : null}
      </span>
      <span className="ac-row-state badge-row"><VerdictBadge verdict={decision.policy?.verdict} /><StatusBadge status={decision.status} /></span>
      <span className="ac-row-tx"><TxCell execution={decision.execution} /></span>
      <span className="ac-row-id">
        <code>{shortId(decision.decision_id, 11, 4)}</code><CopyButton value={decision.decision_id} />
      </span>
    </div>
  );
}

export function Timeline() {
  const decisions = useStore(agentStore, (s) => s.decisions);
  const filters = useStore(agentStore, (s) => s.filters);
  const openId = useStore(agentStore, (s) => s.openDecisionId);
  const protectedCases = useStore(agentStore, (s) => s.protectedCases);
  const actions = [...new Set(decisions.map((decision) => decision.action))].sort();
  const statuses = [...new Set(decisions.map((decision) => decision.status))].sort();
  const filtered = decisions.filter((decision) => (!filters.status || decision.status === filters.status) && (!filters.action || decision.action === filters.action));
  return (
    <Card id="ac-timeline" className="ac-timeline" aria-labelledby="ac-timeline-h">
      <CardHead id="ac-timeline-h" title={t('ac_timeline_h')} level={2}>
        <select className="select select-sm" aria-label={t('ac_filter_status')} data-focus-key="filter:status" value={filters.status} onChange={(event) => setFilter('status', event.target.value)}>
          <option value="">{t('ac_filter_status')}</option>
          {statuses.map((value) => <option key={value} value={value}>{t(`ac_status_${value}`)}</option>)}
        </select>
        <select className="select select-sm" aria-label={t('ac_filter_action')} data-focus-key="filter:action" value={filters.action} onChange={(event) => setFilter('action', event.target.value)}>
          <option value="">{t('ac_filter_action')}</option>
          {actions.map((value) => <option key={value} value={value}>{actionLabel(value)}</option>)}
        </select>
      </CardHead>
      {filtered.length ? (
        <div className="ac-rows" role="list" aria-label={t('ac_timeline_h')}>
          <div className="ac-row ac-row-head" aria-hidden="true">
            <span>{t('ac_col_time')}</span><span>{t('ac_col_trigger')}</span><span>{t('ac_col_action')}</span><span>{t('ac_col_state')}</span><span>{t('ac_col_tx')}</span><span>{t('ac_col_id')}</span>
          </div>
          {filtered.map((decision) => (
            <Row key={decision.decision_id} decision={decision} open={decision.decision_id === openId} protectedCase={protectedCases.has(decision.case_id)} />
          ))}
        </div>
      ) : <Empty>{decisions.length ? t('ac_timeline_filtered_empty') : t('ac_timeline_empty')}</Empty>}
    </Card>
  );
}
