// Copilot results: the constraints it understood, ranked pools with their score breakdown, notable
// exclusions and, when the user asked for one, an action card. The server ranks; nothing is
// re-scored here. Shared by the market's AI search and the floating assistant.
import { useRef, useState } from 'react';
import { t, tData, tTradeText } from '../../lib/i18n.js';
import { riskLabel } from '../../lib/format.js';
import { getAppState } from '../../state/app-store.js';
import { useApp } from '../../state/hooks.js';
import { copilotQuery, watchPool } from '../../lib/copilot-api.js';
import { executeAction, postAction } from '../../lib/copilot-actions.js';
import { Badge, Button, Disclosure } from '../../components/ui.jsx';
import { DecisionButton } from '../evidence/References.jsx';

export function poolStateLabel(status) {
  const key = `cp_state_${status === 'Liquidation' ? 'Liquidated' : status}`;
  return t(key) === key ? status : t(key);
}

export function Constraints({ context }) {
  const chips = [];
  for (const [key, value] of Object.entries(context?.constraints ?? {})) {
    if (Array.isArray(value) && !value.length) continue;
    const formatted = key === 'yield_min_bps' ? `${value / 100}%` : key === 'risk_max' ? riskLabel(value)
      : Array.isArray(value) ? value.map((item) => key.startsWith('commodities_') ? t(`cp_commodity_${item}`) : item).join(', ') : String(value);
    chips.push(<span key={key} className="chip">{`${t(`cp_filter_${key}`)}: ${formatted}`}</span>);
  }
  return (
    <div className="cp-constraints" aria-label={t('cp_filters')}>
      {chips.length ? chips : <span className="muted small">{t('cp_no_filters')}</span>}
    </div>
  );
}

function RerankBanner({ update }) {
  const change = update.changes.find((item) => item.pool_id === update.pool_id);
  const rank = (value) => value === null || value === undefined ? t('cp_rank_out') : t('cp_rank_number', { n: value });
  return (
    <div className="cp-update" role="status" aria-live="polite">
      <p>{t(!change || change.previous_rank === change.rank ? 'cp_rerank_same' : 'cp_rerank', {
        label: tData(update.label), route: update.route.split(' → ').map(tData).join(' → '), action: t(`cp_action_${update.action}`),
        before: rank(change?.previous_rank), after: rank(change?.rank)
      })}</p>
      <p className="muted">{t(update.phase === 'EXECUTION_CONFIRMED' ? 'cp_update_applied' : 'cp_update_proposed')}</p>
      {update.reasoning_summary ? <p>{t('cp_update_reason', { reason: tTradeText(update.reasoning_summary) })}</p> : null}
      <DecisionButton id={update.decision_id} />
    </div>
  );
}

function WatchButton({ result, item, onContext }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const watched = result.context.watchlist?.includes(item.pool_id);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={Boolean(watched)}
        data-focus-key={`cp-watch-${item.pool_id}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true); setError('');
          try { onContext(await watchPool(result.context, item.pool_id)); } catch (failure) { setError(t('cp_error', { message: failure.message })); }
          finally { setBusy(false); }
        }}
      >
        {t(watched ? 'cp_unwatch' : 'cp_watch')}
      </Button>
      {error ? <p role="status" className="text-crit small">{error}</p> : null}
    </>
  );
}

function RecommendationCard({ item, result, onSelect, onContext }) {
  return (
    <article className="cp-card">
      <header className="cp-card-head">
        <span className="cp-rank">{item.rank}</span>
        <div>
          <strong>{tData(item.label)}</strong>
          <p className="muted small">{tData(item.route)}</p>
        </div>
        <Badge tone={item.risk_level === 'LOW' ? 'ok' : item.risk_level === 'CRITICAL' ? 'crit' : item.risk_level === 'WARNING' ? 'warn' : 'info'}>{riskLabel(item.risk_level)}</Badge>
      </header>
      <p className="cp-metrics">{t('cp_metrics', {
        price: item.price_usd.toFixed(4), yield: (item.yield_bps / 100).toFixed(2),
        apr: ((item.annualized_yield_bps ?? item.yield_bps) / 100).toFixed(1), risk: riskLabel(item.risk_level)
      })}</p>
      <p className="muted small">{t('cp_mirror_note')}</p>
      {(item.warnings ?? []).map((warning) => <p key={warning} className="cp-warning">{t(`cp_warning_${warning}`)}</p>)}
      <div className="cp-card-actions">
        <Button size="sm" data-focus-key={`cp-open-${item.pool_id}`} onClick={() => onSelect(item.case_id)}>{t('cp_open_asset')}</Button>
        {result.context?.session_id ? <WatchButton result={result} item={item} onContext={onContext} /> : null}
      </div>
      <Disclosure summary={t('cp_explanation')}>
        {Object.entries(item.breakdown).map(([key, score]) => <p key={key}>{`${t(`cp_score_${key}`)}: ${score.toFixed(4)}`}</p>)}
        <p>{t('cp_gross_note')}</p>
        {(item.evidence ?? []).filter((evidence) => evidence.kind === 'risk_intel').map((evidence, index) => (
          <p key={index} className="muted">{`${t('cp_fixture_intel')}: ${evidence.text}`}</p>
        ))}
        {item.quote_hash ? <code className="cp-hash" title={item.quote_hash}>{item.quote_hash}</code> : null}
        {item.decision_id ? <DecisionButton id={item.decision_id} /> : null}
      </Disclosure>
    </article>
  );
}

export function Recommendations({ result, onSelect = () => {}, scope = 'assistant', onRefresh }) {
  const [, setContextVersion] = useState(0);
  const onContext = (context) => { result.context = context; setContextVersion((value) => value + 1); };
  return (
    <div className="cp-results">
      <Constraints context={result.context} />
      {result.rerank ? <RerankBanner update={result.rerank} /> : null}
      {result.clarifying_question ? <p className="cp-question" role="status">{result.clarifying_question}</p> : null}
      <div className="cp-cards">
        {(result.recommendations ?? []).map((item) => (
          <RecommendationCard key={item.pool_id} item={item} result={result} onSelect={onSelect} onContext={onContext} />
        ))}
      </div>
      {result.excluded_notable?.length ? (
        <Disclosure summary={t('cp_excluded')}>
          {result.excluded_notable.map((item) => (
            <p key={item.label}>{`${tData(item.label)}: ${item.reasons.map((reason) => t(`cp_exclude_${reason}`)).join(' · ')}`}</p>
          ))}
        </Disclosure>
      ) : null}
      {result.action_required ? <ActionCard result={result} scope={scope} onRefresh={onRefresh} /> : null}
    </div>
  );
}

function ActionForm({ result, scope, onRefresh }) {
  const action = result.action_proposal, context = result.context;
  const isReport = result.intent === 'ACTION_BUY_REPORT';
  const [pool, setPool] = useState(result.recommendations?.[0]?.pool_id ?? '');
  const [amount, setAmount] = useState(context.constraints.ticket_usd ?? '');
  const [service, setService] = useState('premium-risk');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const disabled = busy || !result.recommendations?.length;
  return (
    <>
      <p>{t(`cp_block_${action?.blocked ?? 'select_pool'}`)}</p>
      <form className="cp-action-form" onSubmit={async (event) => {
        event.preventDefault(); if (disabled) return; setBusy(true);
        try {
          if (!isReport && !(Number(amount) > 0)) throw new Error(t('cp_block_amount_required'));
          const message = isReport ? 'buy report' : `subscribe USD ${amount}`;
          onRefresh(await copilotQuery(message, { scope, pool_ids: [pool], service_id: isReport ? service : undefined }));
        } catch (error) { setStatus(t('cp_error', { message: error.message })); }
        finally { setBusy(false); }
      }}>
        <select className="select" aria-label={t('cp_action_pool')} data-focus-key="cp-action-pool" value={pool} onChange={(event) => setPool(event.target.value)}>
          {(result.recommendations ?? []).map((item) => <option key={item.pool_id} value={item.pool_id}>{`${tData(item.label)} · ${tData(item.route)}`}</option>)}
        </select>
        {isReport ? (
          <select className="select" aria-label={t('cp_action_report')} value={service} onChange={(event) => setService(event.target.value)}>
            {['premium-risk', 'premium-valuation', 'fraud-review'].map((id) => <option key={id} value={id}>{t(`cp_report_${id}`)}</option>)}
          </select>
        ) : (
          <input className="input" type="number" min="0.000001" step="any" value={amount} aria-label={t('cp_action_amount')} data-focus-key="cp-action-amount"
            onChange={(event) => setAmount(event.target.value)} />
        )}
        <Button type="submit" variant="primary" disabled={disabled}>{t('cp_action_prepare')}</Button>
      </form>
      <p role="status" aria-live="polite" className="cp-action-status">{status}</p>
    </>
  );
}

function ActionProposal({ result }) {
  const action = result.action_proposal, context = result.context;
  const isReport = action.type === 'ACTION_BUY_REPORT';
  const wallet = useApp((state) => state.wallet);
  // The card belongs to the runtime and wallet it was proposed in; a change makes it refuse to run.
  const snapshot = useRef(null);
  if (!snapshot.current) {
    const state = getAppState();
    snapshot.current = { mode: state.demoMode ? 'demo' : 'live', generation: state.modeGeneration, wallet: state.wallet?.address ?? '0xDemoWallet' };
  }
  const [, rerender] = useState(0);
  const update = () => rerender((value) => value + 1);
  const assertCurrent = () => {
    const state = getAppState(), snap = snapshot.current;
    if (snap.mode !== action.mode || snap.generation !== action.generation || state.demoMode !== (action.mode === 'demo')
      || state.modeGeneration !== action.generation || snap.wallet !== (state.wallet?.address ?? '0xDemoWallet')) throw new Error(t('cp_wallet_changed'));
  };
  const started = action.status !== 'PENDING';
  const statusText = action.outcome
    ? (action.outcome.report ? t('cp_report_done', { id: action.outcome.reference ?? '—' })
      : t(action.mode === 'demo' ? 'cp_subscription_done_demo' : 'cp_subscription_done_live', { id: action.outcome.reference ?? action.outcome.txHash, shares: action.shares }))
    : action.failure ? t('cp_action_failed', { message: action.failure })
      : action.cancelError ? t('cp_error', { message: action.cancelError })
        : action.status === 'CANCELLED' ? t('cp_action_cancelled')
          : action.status === 'CONFIRMING' ? t('cp_action_working') : '';
  const confirm = async () => {
    if (action.status !== 'PENDING') return;
    action.status = 'CONFIRMING'; update();
    try {
      const executed = await executeAction(context, action, { assertCurrent, wallet: snapshot.current.wallet });
      action.status = 'COMPLETED';
      action.outcome = executed;
      assertCurrent();
      window.dispatchEvent(new CustomEvent('agentbl:copilotaction', { detail: { result: executed, pool_id: action.pool_id } }));
    } catch (error) { action.failure = error.message; }
    update();
  };
  const cancel = async () => {
    if (action.status !== 'PENDING') return;
    action.status = 'CANCELLED'; update();
    try { await postAction(`/api/copilot/sessions/${context.session_id}/actions/${action.id}/cancel`, {}); }
    catch (error) { action.cancelError = error.message; }
    update();
  };
  return (
    <div data-action-id={action.id} data-wallet={wallet?.address ?? ''}>
      <p>{`${tData(action.label)} · ${tData(action.route)}`}</p>
      <p>{t('cp_action_cost', { amount: action.amount_usd.toFixed(6), price: action.price_usd.toFixed(6) })}</p>
      <p>{isReport ? t(`cp_report_${action.service_id}`) : t('cp_action_shares', { shares: action.shares })}</p>
      <p className="muted">{action.mode === 'live' && !isReport && action.chain?.protocol_version === 5
        ? t('cp_action_live_capital', { amount: action.amount_usd.toFixed(6), asset: action.chain.settlement_asset })
        : t(action.mode === 'demo' ? 'cp_action_demo' : isReport ? 'cp_action_live_report' : 'cp_action_live_shares')}</p>
      <p className="muted">{t('cp_action_expiry')}</p>
      <div className="cp-action-buttons">
        <Button variant="primary" className="cp-action-confirm" data-focus-key={`cp-confirm-${action.id}`} disabled={started} onClick={confirm}>
          {action.outcome ? t('cp_action_completed') : t('cp_action_confirm')}
        </Button>
        <Button variant="ghost" className="cp-action-cancel" disabled={started} onClick={cancel}>{t('cp_action_cancel')}</Button>
      </div>
      <p role="status" aria-live="polite" className="cp-action-status">{statusText}</p>
      {action.outcome?.report ? (
        <Disclosure summary={t('cp_report_view')}>
          <pre className="cp-report-body">{JSON.stringify(action.outcome.report, null, 2)}</pre>
        </Disclosure>
      ) : null}
    </div>
  );
}

function ActionCard({ result, scope, onRefresh }) {
  return (
    <section className="cp-action-card" aria-label={t('cp_action_card')}>
      <h4>{t('cp_action_card')}</h4>
      <p className="cp-warning">{t('cp_action_disclosure')}</p>
      {result.action_proposal?.id
        ? <ActionProposal key={result.action_proposal.id} result={result} />
        : <ActionForm result={result} scope={scope} onRefresh={onRefresh} />}
    </section>
  );
}
