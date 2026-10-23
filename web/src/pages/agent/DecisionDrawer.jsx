// One decision in full: summary, the policy's reasons, approval controls when it is waiting, the
// execution record, pipeline steps with timings and the trace waterfall, model usage, findings,
// evidence with freshness and a read-only replay, decision anchoring, and links to the market and
// pricing views. A simulated execution is shown as DEMO with its demo: reference and never gets a link.
import { useEffect, useRef, useState } from 'react';
import { useLang, useStore } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { agent, safeExplorerUrl } from '../../lib/agent-api.js';
import { actionLabel, eventLabel, formatDateTime, shortId, usd } from '../../lib/agent-format.js';
import { Badge, Button, CopyButton, Dialog, DialogHeader, Disclosure, KV } from '../../components/ui.jsx';
import { References } from '../../features/evidence/References.jsx';
import { agentStore } from './agent-store.js';
import { ApprovalControls } from './Approvals.jsx';
import { ModeBadge, SimulatedBadge, StatusBadge, VerdictBadge } from './badges.jsx';
import { reasoningLang, settlementPolicyReason, settlementReasoning } from './settlement.js';

function Section({ title, children }) {
  return <section className="drawer-section"><h3>{title}</h3>{children}</section>;
}

export function Execution({ execution }) {
  if (!execution) return <p className="muted">{t('ac_no_execution')}</p>;
  const link = safeExplorerUrl(execution.explorer_url);
  return (
    <div className="kv-stack">
      <KV label={t('ac_exec_mode')}>{execution.mode === 'chain' ? t('ac_exec_chain') : execution.mode === 'demo' ? t('ac_exec_demo') : String(execution.mode)}</KV>
      {execution.signer_role ? <KV label={t('ac_exec_signer')}>{execution.signer_role}</KV> : null}
      {execution.tx_hash ? (
        <KV label={t('ac_exec_tx')}>
          {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="mono">{`${shortId(execution.tx_hash, 12, 8)} ↗`}</a> : <code>{shortId(execution.tx_hash, 12, 8)}</code>}
          <CopyButton value={execution.tx_hash} />
        </KV>
      ) : execution.reference ? (
        <KV label={t('ac_exec_ref')}><code>{execution.reference}</code> <SimulatedBadge /></KV>
      ) : null}
      {execution.block_number !== undefined && execution.block_number !== null ? <KV label={t('ac_exec_block')}>{`#${execution.block_number}`}</KV> : null}
      {execution.effects ? <KV label={t('ac_exec_state')}>{`${execution.effects.state_before} → ${execution.effects.state_after}`}</KV> : null}
      {execution.effects && execution.effects.issue_price_before_usd !== execution.effects.issue_price_after_usd
        ? <KV label={t('ac_exec_price')}>{`${usd(execution.effects.issue_price_before_usd)} → ${usd(execution.effects.issue_price_after_usd)}`}</KV> : null}
      {execution.confirmed_events?.length ? <KV label={t('ac_exec_events')}>{execution.confirmed_events.join(', ')}</KV> : null}
      {execution.pending ? <KV label={t('ac_exec_pending')}>{t('ac_exec_pending_hint')}</KV> : null}
      {execution.note ? <KV label={t('ac_exec_note')}>{execution.note}</KV> : null}
    </div>
  );
}

function Trace({ trace, pipeline }) {
  const spans = trace?.spans ?? [];
  const start = Date.parse(trace?.started_at);
  const total = spans.length ? Math.max(1, trace.duration_ms ?? Math.max(...spans.map((s) => (Date.parse(s.started_at) - start) + (s.duration_ms ?? 0)))) : 1;
  const ordered = [...spans].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  return (
    <div className="trace">
      {ordered.length ? (
        <>
          {ordered.map((span, index) => {
            const offset = Math.max(0, Math.min(100, ((Date.parse(span.started_at) - start) / total) * 100));
            const width = Math.max(1.5, Math.min(100 - offset, ((span.duration_ms ?? 0) / total) * 100));
            return (
              <div key={index} className={`span-row${span.status === 'error' ? ' is-error' : ''}`}>
                <span className="span-name">{span.name}</span>
                <span className="span-track" role="img" aria-label={`${span.name} ${span.duration_ms} ms`}><span className="span-bar" style={{ marginLeft: `${offset}%`, width: `${width}%` }} /></span>
                <span className="span-ms mono">{`${span.duration_ms ?? 0} ms`}</span>
              </div>
            );
          })}
          <p className="muted small">{t('ac_trace_total', { ms: trace.duration_ms ?? total, id: shortId(trace.trace_id, 8, 0) })}</p>
        </>
      ) : <p className="muted">{t('ac_trace_none')}</p>}
      {pipeline?.length ? (
        <ol className="steps">
          {pipeline.map((step, index) => (
            <li key={index}>
              <Badge tone={step.status === 'PASS' ? 'ok' : step.status === 'FAIL' ? 'crit' : 'warn'}>{step.status}</Badge>{` ${step.step} `}<span className="muted">{`${step.duration_ms ?? 0} ms`}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ModelUsage({ trace, decision }) {
  const calls = (trace?.spans ?? []).filter((span) => span.attributes?.['llm.provider'] || span.attributes?.['llm.model']);
  for (const call of (decision.pipeline ?? []).flatMap((step) => step.model_usage ?? [])) {
    calls.push({ attributes: { 'llm.provider': call.provider, 'llm.model': call.model, 'llm.latency_ms': call.latency_ms, ...(call.tokens ? { 'llm.tokens': JSON.stringify(call.tokens) } : {}) } });
  }
  if (!calls.length) return <p className="muted">{t('ac_model_unrecorded')}</p>;
  return (
    <ul className="steps">
      {calls.map(({ attributes, duration_ms: duration }, index) => (
        <li key={index}>
          <code>{[attributes['llm.provider'], attributes['llm.model']].filter(Boolean).join(' / ')}</code>
          {` · ${attributes['llm.latency_ms'] ?? duration ?? '—'} ms`}
          {attributes['llm.tokens'] ? <p>{`${t('ac_model_tokens')}: ${attributes['llm.tokens']}`}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function Findings({ findings }) {
  if (!findings?.length) return <p className="muted">{t('ac_no_findings')}</p>;
  return (
    <ul className="bullets plain">
      {findings.map((finding, index) => (
        <li key={index}>
          <Badge tone={finding.severity === 'critical' || finding.severity === 'high' ? 'crit' : finding.severity === 'warning' ? 'warn' : 'muted'}>{finding.severity ?? 'info'}</Badge>
          {` ${finding.kind}: ${finding.detail ?? ''}`}
        </li>
      ))}
    </ul>
  );
}

function Freshness({ freshness, currentStatus }) {
  if (!freshness) return <p className="muted">{t('ac_freshness_missing')}</p>;
  const status = currentStatus ?? freshness.source_status;
  return (
    <div className="kv-stack" data-evidence-status={status}>
      <Badge tone={status === 'stale' ? 'crit' : status === 'live' ? 'ok' : 'warn'}>{t(`ac_source_${status}`)}</Badge>
      <KV label={t('ac_observed_at')}>{formatDateTime(freshness.observed_at)}</KV>
      <KV label={t('ac_expires_at')}>{formatDateTime(freshness.expires_at)}</KV>
    </div>
  );
}

function Replay({ decision }) {
  const lang = useLang();
  const [state, setState] = useState({ pending: false, replay: null, error: null, evidence: decision.evidence_hash });
  // A result belongs to the evidence it checked; new evidence (or language) starts over.
  useEffect(() => { setState((current) => (current.pending ? current : { pending: false, replay: null, error: null, evidence: decision.evidence_hash })); }, [decision.decision_id, decision.evidence_hash, lang]);
  const run = async () => {
    if (state.pending) return;
    setState((current) => ({ ...current, pending: true, replay: null, error: null }));
    try {
      const { replay } = await agent.replay(decision.decision_id);
      setState((current) => ({ ...current, pending: false, replay }));
    } catch (error) {
      setState((current) => ({ ...current, pending: false, error: error.message }));
    }
  };
  const replay = state.replay;
  return (
    <div data-decision-replay={decision.decision_id} data-replay-evidence={state.evidence}>
      <Button size="sm" data-focus-key="decision:replay" aria-disabled={state.pending || undefined} onClick={run}>{t('ac_replay_button')}</Button>
      <div role="status" aria-live="polite" className="replay-result" data-replay-status={replay?.status}>
        {state.pending ? t('ac_replay_running') : state.error ? state.error : replay ? (
          <>
            {t(replay.passed ? 'ac_replay_pass' : 'ac_replay_fail')}
            {replay.code === 'snapshot_unavailable' ? ` ${t('ac_replay_missing')}` : ''}
            {replay.checks?.length ? <ul className="bullets plain">{replay.checks.map((check) => <li key={check.name}>{`${check.passed ? '✓' : '✗'} ${check.name}`}</li>)}</ul> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Anchoring({ initial, decision }) {
  const [anchor, setAnchor] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setAnchor(initial); setFailed(false); }, [initial]);
  const stateName = anchor?.state ?? 'UNAVAILABLE';
  const verification = anchor?.verification;
  const link = anchor?.mode === 'live' && anchor?.state === 'ANCHORED' && verification?.status === 'PASS_CHAIN' && anchor.batch?.tx_hash && safeExplorerUrl(anchor.batch.explorer_url);
  const verify = async () => {
    if (checking) return;
    setChecking(true); setFailed(false);
    try { setAnchor((await agent.anchor(decision.decision_id)).anchor); }
    catch { setFailed(true); }
    finally { setChecking(false); }
  };
  return (
    <div className="anchor" data-anchor-state={stateName}>
      <Badge tone={verification?.passed ? 'ok' : 'warn'}>{t(`ac_anchor_state_${stateName}`)}</Badge>
      {anchor?.available ? (
        <>
          <p className="muted small">{t(anchor.mode === 'demo' ? 'ac_anchor_demo_hint' : 'ac_anchor_live_hint')}</p>
          <div className="kv-stack">
            <KV label={t('ac_anchor_seq')}>{String(anchor.seq)}</KV>
            <KV label={t('ac_anchor_finalized')}>{formatDateTime(anchor.payload.finalized_at)}</KV>
            {anchor.batch ? <KV label={t('ac_anchor_batch')}>{`#${anchor.batch.batch_id}`}</KV> : null}
            {anchor.batch ? <KV label={t('ac_anchor_root')}><code>{shortId(anchor.batch.merkle_root, 12, 8)}</code><CopyButton value={anchor.batch.merkle_root} /></KV> : null}
            {link ? <KV label={t('ac_anchor_tx')}><a href={link} target="_blank" rel="noopener noreferrer" className="mono">{`${shortId(anchor.batch.tx_hash, 12, 8)} ↗`}</a></KV> : null}
          </div>
          <Button size="sm" data-focus-key="decision:anchor-verify" aria-busy={checking} onClick={verify}>{t('ac_anchor_verify')}</Button>
          <p role="status" aria-live="polite" className={verification?.passed && !failed ? 'muted small' : 'text-crit small'} data-anchor-verification={verification?.status ?? 'UNAVAILABLE'}>
            {checking ? t('ac_anchor_checking') : failed ? t('ac_anchor_fail')
              : t(verification?.status === 'PASS_CHAIN' ? 'ac_anchor_pass_chain' : verification?.passed ? 'ac_anchor_pass_local' : anchor.state === 'PENDING_BATCH' ? 'ac_anchor_wait' : 'ac_anchor_fail')}
          </p>
          <Disclosure summary={t('ac_anchor_proof')}>
            <pre className="json-block" tabIndex={0}>{JSON.stringify({ payload: anchor.payload, leaf: anchor.leaf, version: anchor.version, proof: anchor.proof, batch: anchor.batch }, null, 2)}</pre>
          </Disclosure>
        </>
      ) : null}
    </div>
  );
}

function Detail({ detail, trace, anchor }) {
  const { decision, approvals, activity } = detail;
  const proposal = decision.proposal ?? {};
  const hasQuote = Boolean(decision.quote_snapshot ?? decision.proposal?.params?.quote);
  const navigate = (target) => window.dispatchEvent(new CustomEvent('agentbl:decisionnavigate', { detail: { decision, target } }));
  return (
    <>
      <div className="drawer-meta">
        <p className="muted small">{`${decision.case_id} · ${formatDateTime(decision.created_at)} · ${eventLabel(decision.event_type)}`}</p>
        <span className="badge-row"><StatusBadge status={decision.status} /><ModeBadge mode={decision.mode} /></span>
      </div>
      <Section title={t('ac_summary')}>
        <p lang={reasoningLang(decision)}>{settlementReasoning(decision)}</p>
        {proposal.new_issue_price_usd !== null && proposal.new_issue_price_usd !== undefined ? <p className="muted">{t('ac_price_move', { price: usd(proposal.new_issue_price_usd), bps: proposal.price_move_bps ?? 0 })}</p> : null}
        {decision.note ? <p className="muted">{decision.note}</p> : null}
        {decision.error ? <p className="text-crit">{`${decision.error.code ?? ''} ${decision.error.message ?? ''}`}</p> : null}
      </Section>
      <Section title={t('ac_policy')}>
        {decision.policy ? (
          <>
            <p className="badge-row"><VerdictBadge verdict={decision.policy.verdict} />{`${t('ac_autonomy')}: ${decision.policy.autonomy}`}</p>
            <ul className="bullets plain">{(decision.policy.reasons ?? []).map((reason, index) => <li key={index}><code>{reason.rule}</code>{` — ${settlementPolicyReason(decision, reason)}`}</li>)}</ul>
          </>
        ) : <p className="muted">—</p>}
      </Section>
      {approvals?.length ? <Section title={t('ac_approval')}>{approvals.map((approval) => <ApprovalControls key={approval.approval_id} approval={approval} decision={decision} />)}</Section> : null}
      <Section title={t('ac_execution')}><Execution execution={decision.execution} /></Section>
      <Section title={t('ac_linked_views')}>
        <div className="button-row">
          <Button size="sm" data-focus-key="decision-view:market" onClick={() => navigate('market')}>{t('ac_view_market')}</Button>
          <Button size="sm" data-focus-key="decision-view:mint" disabled={!hasQuote} onClick={() => navigate('mint')}>{t('ac_view_quote')}</Button>
        </div>
        <References references={decision.references} open />
      </Section>
      <Disclosure summary={t('ac_pipeline')}><Trace trace={trace} pipeline={decision.pipeline} /></Disclosure>
      <Disclosure summary={t('ac_model_usage')}><ModelUsage trace={trace} decision={decision} /></Disclosure>
      <Disclosure summary={t('ac_findings')}><Findings findings={decision.findings} /></Disclosure>
      <Disclosure summary={t('ac_evidence')}>
        <div className="kv-stack">
          {decision.evidence_hash ? <KV label={t('ac_evidence_hash')}><code>{shortId(decision.evidence_hash, 12, 8)}</code><CopyButton value={decision.evidence_hash} /></KV> : null}
          {decision.quote_hash ? <KV label={t('ac_quote_hash')}><code>{shortId(decision.quote_hash, 12, 8)}</code><CopyButton value={decision.quote_hash} /></KV> : null}
          <KV label={t('ac_decision_id')}><code>{shortId(decision.decision_id, 18, 6)}</code><CopyButton value={decision.decision_id} /></KV>
          {decision.trace_id ? <KV label={t('ac_trace_id')}><code>{decision.trace_id}</code></KV> : null}
        </div>
        <Freshness freshness={decision.freshness} currentStatus={decision.freshness_status} />
        <Replay decision={decision} />
      </Disclosure>
      <Disclosure summary={t('ac_anchor_title')}><Anchoring initial={anchor} decision={decision} /></Disclosure>
      <Disclosure summary={t('ac_activity')}>
        <ol className="steps">{(activity ?? []).map((record) => <li key={record.seq}><code>{`#${record.seq}`}</code>{` ${record.action} `}<span className="muted">{formatDateTime(record.timestamp)}</span></li>)}</ol>
      </Disclosure>
    </>
  );
}

export function DecisionDrawer({ id, onClose }) {
  const refreshSeq = useStore(agentStore, (s) => s.refreshSeq);
  const [data, setData] = useState({ id: null, detail: null, trace: null, anchor: null, error: null });
  const snapshot = useRef(null);
  useEffect(() => {
    if (!id) { snapshot.current = null; return undefined; }
    let current = true;
    (async () => {
      try {
        const [detail, traceResult, anchorResult] = await Promise.all([
          agent.decision(id),
          agent.trace(id).catch(() => ({ trace: null })),
          agent.anchor(id).catch(() => ({ anchor: { available: false, state: 'UNAVAILABLE' } }))
        ]);
        if (!current) return;
        const next = JSON.stringify([detail, traceResult, anchorResult]);
        if (snapshot.current === next) return;
        snapshot.current = next;
        setData({ id, detail, trace: traceResult.trace, anchor: anchorResult.anchor, error: null });
        window.dispatchEvent(new CustomEvent('agentbl:decisionselected', { detail: { decision: detail.decision } }));
      } catch (error) {
        if (current) setData({ id, detail: null, trace: null, anchor: null, error: error.message });
      }
    })();
    return () => { current = false; };
  }, [id, refreshSeq]);
  const shown = data.id === id ? data : null;
  return (
    <Dialog id="ac-drawer" open={Boolean(id)} onClose={onClose} labelledBy="ac-drawer-title" variant="side" className="decision-drawer">
      <DialogHeader id="ac-drawer-title" title={shown?.detail ? actionLabel(shown.detail.decision.action) : t('a11y_decision_detail')} onClose={onClose} />
      <div className="dialog-body">
        {!shown ? <p className="muted">{t('ac_loading')}</p> : shown.error ? <p className="text-crit">{shown.error}</p> : <Detail detail={shown.detail} trace={shown.trace} anchor={shown.anchor} />}
      </div>
    </Dialog>
  );
}
