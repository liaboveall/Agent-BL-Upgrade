// Risk intelligence for the selected case: live world-risk signals (and the before/after price they
// imply), the sourced risk feed, and a search over the intel knowledge base.
import { useEffect, useState } from 'react';
import { useApp, useStore } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import * as api from '../../lib/api.js';
import { Badge, Button, Card, CardHead, Disclosure, Empty } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { applyWorldRisk, fetchWorldRisk, getRiskSweep, simStore } from './simulation.js';

const sevTone = (severity) => ({ critical: 'crit', warning: 'warn', info: 'info' }[String(severity).toLowerCase()] ?? 'info');

export function IntelTab() {
  return (
    <div className="intel-tab">
      <WorldRisk />
      <div className="intel-grid">
        <RiskFeed />
        <RagSearch />
      </div>
    </div>
  );
}

function SignalGroup({ titleKey, items }) {
  if (!items.length) return null;
  return (
    <div className="signal-group">
      <div className="signal-group-head"><span>{t(titleKey)}</span><span className="count-pill">{items.length}</span></div>
      {items.map((item, index) => (
        <div key={index} className="signal">
          <p>{item.text}</p>
          {item.source ? <span className="muted small">{t('feed_source')}{item.source}</span> : null}
        </div>
      ))}
    </div>
  );
}

function WorldRisk() {
  const caseId = useApp((s) => s.caseId);
  const sim = useStore(simStore, (s) => s);
  const res = sim.worldRisk[caseId];
  useEffect(() => { fetchWorldRisk(false); }, [caseId]);
  const captured = res?.snapshot_captured_at ? f.fmtDate(res.snapshot_captured_at.slice(0, 10)) : null;
  const modeText = !res ? '' : res.provider === 'public-live' ? t('wr_public_live')
    : res.provider === 'public-snapshot' ? t(captured ? 'wr_public_snapshot' : 'wr_public_snapshot_undated', { date: captured })
      : res.live ? t('wr_live') : t('wr_offline');
  const hasEvents = Array.isArray(res?.events) && res.events.length > 0;
  const s = res?.signals ?? {};
  const pctChange = (ratio) => (Number.isFinite(ratio) ? `${ratio >= 1 ? '+' : ''}${Math.round((ratio - 1) * 100)}%` : '—');
  const groups = [
    ['wr_sig_chokepoints', (s.chokepoints ?? []).map((x) => ({
      text: t('wr_chokepoint_item', { name: x.name, avg: x.avg7 ?? '—', base: x.baseline7 ?? '—', pct: pctChange(x.ratio) }) + (x.adjacent ? t('wr_chokepoint_adjacent') : ''),
      source: ['IMF PortWatch', x.latest_date].filter(Boolean).join(' · ')
    }))],
    ['wr_sig_markets', (s.prediction_markets ?? []).slice(0, 3).map((x) => ({ text: `${Math.round((x.implied_prob ?? 0) * 100)}% — ${x.market ?? x.question ?? ''}`, source: x.platform ?? 'prediction market' }))],
    ['wr_sig_sea', (s.sea_state ?? []).map((x) => ({ text: t('wr_sea_item', { name: x.name, h: x.max_wave_height_m }), source: ['Open-Meteo Marine', x.on].filter(Boolean).join(' · ') }))],
    ['wr_sig_tweets', (s.tweets ?? []).slice(0, 3).map((x) => ({ text: `@${x.author ?? '?'}: ${x.text ?? ''}`, source: x.author ? `x.com/${x.author}` : null }))],
    ['wr_sig_officials', (s.officials ?? []).slice(0, 2).map((x) => ({ text: `@${x.author ?? '?'}: ${x.text ?? ''}`, source: x.author ? `x.com/${x.author}` : null }))],
    ['wr_sig_news', (s.news ?? []).slice(0, 3).map((x) => ({ text: x.title ?? '', source: [x.source, x.date].filter(Boolean).join(' · ') }))]
  ].filter(([, items]) => items.length);
  const before = res?.before_quote, after = res?.after_quote;
  return (
    <Card aria-labelledby="wr-h" id="worldrisk-panel">
      <CardHead id="wr-h" title={t('wp_h')} level={3}>
        {res ? <Badge tone={res.live ? 'ok' : 'muted'}>{modeText}</Badge> : null}
        <Button variant="ghost" size="sm" onClick={() => fetchWorldRisk(true)} disabled={sim.worldRiskLoading}><Icon name="refresh" size={14} />{t('wr_refresh')}</Button>
        {hasEvents ? (
          <Button variant="primary" size="sm" onClick={applyWorldRisk} disabled={sim.worldRiskApplied || sim.pending}>
            {sim.worldRiskApplied ? t('wr_applied') : t('wr_apply')}
          </Button>
        ) : null}
      </CardHead>
      <p className="muted small">{t('wp_sub')}</p>
      {sim.worldRiskLoading && !res ? <p className="muted">{t('wr_loading')}</p> : null}
      {sim.worldRiskError ? <p className="text-crit">{t('wr_fetch_fail', { msg: sim.worldRiskError })}</p> : null}
      {res ? (
        <div className="wr-body">
          {before && after ? (
            <div className="impact">
              <span className="stat-label">{t('wr_impact_head')}</span>
              <div className="impact-row">
                <QuoteSide label={t('wr_before')} quote={before} />
                <Icon name="arrowRight" size={18} className="impact-arrow" />
                <QuoteSide label={t('wr_after')} quote={after} strong />
              </div>
            </div>
          ) : null}
          {res.summary ? <p className="wr-summary">{res.summary}</p> : null}
          <h4 className="sub-title">{t('wr_events_head')}</h4>
          {hasEvents ? (
            <ul className="event-list">
              {res.events.map((event, index) => (
                <li key={index}>
                  <Badge tone={sevTone(event.severity)}>{(event.severity || 'info').toUpperCase()}</Badge>
                  <span>{(event.type || '').replace(/_/g, ' ')}</span>
                  {event.region ? <span className="muted">{event.region}</span> : null}
                  {event.evidence?.[0] ? <span className="muted small">{event.evidence[0]}</span> : null}
                </li>
              ))}
            </ul>
          ) : <p className="muted">{t('wr_none')}</p>}
          {groups.length ? (
            <Disclosure summary={t('wr_signals_head')}>
              <div className="signals">{groups.map(([key, items]) => <SignalGroup key={key} titleKey={key} items={items} />)}</div>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function QuoteSide({ label, quote, strong }) {
  const meta = f.actionMeta(quote.pricing_action);
  return (
    <div className="quote-side">
      <span className="muted small">{label}</span>
      <strong className={strong ? 'price-lg' : 'price-md'}>${f.price(quote.final_issue_price_usd)}</strong>
      <span className="badge-row">
        <Badge tone={f.riskTone(quote.risk_level)}>{`${f.int(quote.risk_score_bps)} bps`}</Badge>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </span>
    </div>
  );
}

function RiskFeed() {
  const caseId = useApp((s) => s.caseId);
  const caseData = useApp((s) => s.caseData);
  const voyageEvents = useApp((s) => s.voyageEvents);
  const [sweep, setSweep] = useState([]);
  useEffect(() => {
    let current = true;
    getRiskSweep().then((items) => { if (current) setSweep(items); });
    return () => { current = false; };
  }, [caseId]);
  const items = [];
  for (const e of voyageEvents) items.push({ injected: true, severity: e.severity, category: e.type, region: e.region, title: e.description, source: e.source || 'in-transit simulation', date: t('feed_injected_date') });
  for (const e of caseData?.macro_risk_events ?? []) items.push({ severity: e.severity, category: e.type, region: e.region, title: e.description, date: e.date, source: caseData.market?.source || 'case macro feed' });
  const seen = new Set();
  for (const m of sweep) {
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    items.push({ severity: m.severity, category: m.category, region: m.region, title: m.title || m.summary, source: m.source, date: m.date });
  }
  const order = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => (a.injected ? -1 : 0) - (b.injected ? -1 : 0) || (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  return (
    <Card aria-labelledby="feed-h" id="intel-panel">
      <CardHead id="feed-h" title={t('vp4_h')} level={3} />
      <p className="muted small">{t('vp4_sub')}</p>
      {!items.length ? <p className="muted">{t('feed_none')}</p> : (
        <ul className="feed">
          {items.slice(0, 12).map((item, index) => (
            <li key={index} className={`feed-item${item.injected ? ' is-injected' : ''}`}>
              <div className="feed-head">
                <Badge tone={sevTone(item.severity)}>{(item.severity || 'info').toUpperCase()}</Badge>
                <span className="feed-cat">{(item.category || '').replace(/_/g, ' ')}</span>
                {item.region ? <span className="muted small">{item.region}</span> : null}
                {item.injected ? <Badge tone="accent">{t('feed_new')}</Badge> : null}
              </div>
              <p>{item.title || ''}</p>
              <div className="feed-foot muted small"><span>{t('feed_source')}{item.source || '—'}</span>{item.date ? <span>{item.date}</span> : null}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RagSearch() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState({ status: 'idle', data: null, error: null, query: '' });
  const run = async (event) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setState({ status: 'loading', data: null, error: null, query: q });
    try { setState({ status: 'done', data: await api.ragSearch(q), error: null, query: q }); }
    catch (error) { setState({ status: 'error', data: null, error: error.message, query: q }); }
  };
  return (
    <Card aria-labelledby="rag-h">
      <CardHead id="rag-h" title={t('rag_title')} level={3} />
      <form className="input-row" onSubmit={run}>
        <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('rag_ph')} aria-label={t('rag_ph')} />
        <Button type="submit" variant="secondary">{t('rag_btn')}</Button>
      </form>
      {state.status === 'loading' ? <p className="muted">{t('rag_searching')}</p> : null}
      {state.status === 'error' ? <p className="text-crit">{state.error}</p> : null}
      {state.status === 'done' && !state.data.matches?.length ? <Empty>{t('rag_none', { q: state.query })}</Empty> : null}
      {state.status === 'done' && state.data.matches?.length ? (
        <>
          <p className="muted small">{t('rag_hits', { n: state.data.match_count })}</p>
          <ul className="feed">
            {state.data.matches.map((m, index) => (
              <li key={m.id ?? index} className="feed-item">
                <div className="feed-head">
                  <Badge tone={sevTone(m.severity)}>{(m.severity || 'info').toUpperCase()}</Badge>
                  <span className="feed-cat">{m.category || ''}</span>
                  {m._score ? <span className="muted small">score {m._score}</span> : null}
                </div>
                <strong>{m.title || m.id || 'intel'}</strong>
                <p>{m.summary || ''}</p>
                <p className="muted small">{[m.source, m.region, m.date].filter(Boolean).join(' · ')}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
