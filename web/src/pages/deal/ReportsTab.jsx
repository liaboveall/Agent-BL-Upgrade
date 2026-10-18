// The paid AI report market (x402): choose a report, unlock it (Demo simulation, Demo wallet
// signature or Live USDC payment), then read it with its payment evidence and pricing impact.
import { useEffect } from 'react';
import { useApp, useStore, useLang } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { evidenceFor } from '../../state/controller.js';
import { shortLabel } from '../../lib/market.js';
import { Badge, Button, Card, CardHead, Disclosure, KV, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { References } from '../../features/evidence/References.jsx';
import {
  STEPS, currentService, loadX402Config, purchase, reopenReport, reportCountSummary, resetFlow, restorePurchases, runSmoke, selectService, x402Store
} from './x402.js';

const STEP_KEYS = { challenge: 'x402_step1_title', pay: 'x402_step2_title', settle: 'x402_step3_title', unlock: 'x402_step4_title' };
const STEP_DESC = { challenge: 'x402_step1_desc', pay: 'x402_step2_desc', settle: 'x402_step3_desc', unlock: 'x402_step4_desc' };
const BULLETS = {
  'premium-valuation': ['x402_bullet_val_1', 'x402_bullet_val_2', 'x402_bullet_val_3'],
  'fraud-review': ['x402_bullet_fraud_1', 'x402_bullet_fraud_2', 'x402_bullet_fraud_3'],
  default: ['x402_bullet_risk_1', 'x402_bullet_risk_2', 'x402_bullet_risk_3']
};

const formatUsd = (value, digits = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n) : '—';
};
const shortHash = (value, chars = 14) => {
  if (!value) return '—';
  const s = String(value);
  return s.length > chars * 2 ? `${s.slice(0, chars)}…${s.slice(-8)}` : s;
};
const badgeTone = (value) => {
  const v = String(value || '').toUpperCase();
  if (['LOW', 'PASS', 'OPEN', 'APPROVE', 'APPROVED'].includes(v)) return 'ok';
  if (['MEDIUM', 'WARNING', 'REVIEW', 'REPRICE'].includes(v)) return 'warn';
  if (['HIGH', 'CRITICAL', 'BLOCK', 'PAUSE_OFFERING', 'FREEZE_POOL'].includes(v)) return 'crit';
  return 'accent';
};

export function ReportsTab() {
  const demoMode = useApp((s) => s.demoMode);
  const generation = useApp((s) => s.modeGeneration);
  const caseId = useApp((s) => s.caseId);
  const x = useStore(x402Store, (s) => s);
  useEffect(() => { loadX402Config(); restorePurchases(); }, []);
  // A new runtime (mode switch, demo reset) or another case starts a clean flow.
  useEffect(() => { resetFlow(); x402Store.set({ report: null }); }, [generation, caseId]);
  const service = currentService(x);
  return (
    <div className="reports-tab">
      <div className="reports-layout">
        <aside className="report-catalog" aria-labelledby="x402-catalog-h">
          <h3 id="x402-catalog-h" className="section-title">{t('x402_catalog_heading')}</h3>
          <div className="kv-stack">
            <KV label={t('x402_network_label', { network: x.network })}>
              <Badge tone={x.configured ? 'ok' : 'muted'}>{x.configured ? t('x402_ready') : t('x402_demo_mode')}</Badge>
            </KV>
          </div>
          {!x.loaded ? <p className="muted">{t('x402_loading')}</p> : (
            <div className="service-list" role="listbox" aria-label={t('x402_catalog_heading')}>
              {x.services.map((item) => (
                <button
                  key={item.serviceId}
                  type="button"
                  role="option"
                  aria-selected={item.serviceId === service.serviceId}
                  className={cx('service-item', item.serviceId === service.serviceId && 'is-active')}
                  onClick={() => selectService(item.serviceId)}
                >
                  <span className="service-head"><strong>{item.title}</strong><Badge tone="accent">{`${item.priceUSDC} USDC`}</Badge></span>
                  <span className="muted small">{item.description}</span>
                </button>
              ))}
            </div>
          )}
          <p className="muted small">{t('x402_market_note')}</p>
        </aside>

        <section className="report-main" aria-labelledby="x402-flow-h">
          <Card>
            <CardHead id="x402-flow-h" title={t('x402_pipeline_heading')} level={3}>
              {demoMode ? (
                <Button id="x402-smoke-btn" variant="secondary" size="sm" disabled={x.running} onClick={runSmoke}>
                  <Icon name="play" size={14} />{t('x402_smoke_short')}
                </Button>
              ) : null}
              <Button id="x402-purchase-btn" variant="primary" size="sm" disabled={x.running} onClick={purchase}>
                {t(demoMode ? 'x402_buy_demo' : 'x402_buy_live', { price: service.priceUSDC })}
              </Button>
            </CardHead>
            <ol id="x402-flow" className={cx('x402-flow', x.running && 'x402-flow-active')}>
              {STEPS.map((name, index) => (
                <li key={name} className={`x402-step is-${x.steps[name].status}`} title={t(STEP_DESC[name])}>
                  <span className="x402-step-num">{x.steps[name].status === 'done' ? <Icon name="check" size={14} /> : index + 1}</span>
                  <span className="x402-step-body">
                    <strong>{t(STEP_KEYS[name])}</strong>
                    <span className="sr-only">{t(STEP_DESC[name])}</span>
                  </span>
                  <span className="x402-step-status">{x.steps[name].text}</span>
                </li>
              ))}
            </ol>
            <p className="muted small">{demoMode ? t('x402_demo_boundary') : t('x402_live_boundary')}</p>
            {x.log.length ? (
              <ul className="x402-log" aria-live="polite">
                {x.log.map((line, index) => (
                  <li key={index} className={`tone-text-${line.tone}`}>
                    {line.href ? <a href={line.href} target="_blank" rel="noopener noreferrer">{line.text}</a> : line.text}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          {x.payment || x.impact ? (
            <div className="x402-evidence-grid">
              {x.payment ? (
                <Card className="x402-payment" aria-labelledby="x402-pay-h">
                  <CardHead id="x402-pay-h" title={t('x402_evidence_heading')} level={4}>
                    <Badge tone={x.payment.simulated ? 'warn' : 'ok'}>{x.payment.simulated ? 'DEMO' : t('x402_evidence_contract')}</Badge>
                  </CardHead>
                  <div className="kv-stack">
                    <KV label={t('x402_tx_hash')} mono>{x.payment.tx}</KV>
                    <KV label={t('x402_service_label')}>{x.payment.service}</KV>
                    <KV label={t('x402_amount_label')}>{x.payment.amount}</KV>
                    <KV label={t('x402_response_hash')} mono>{x.payment.reportHash}</KV>
                  </div>
                </Card>
              ) : null}
              {x.impact ? <PricingImpact impact={x.impact} /> : null}
            </div>
          ) : null}

          <DecisionReferences />
          {x.report ? <UnlockedReport report={x.report} services={x.services} /> : <ReportPreview service={service} />}

          {x.purchased.length ? (
            <Card aria-labelledby="x402-purchased-h">
              <CardHead id="x402-purchased-h" title={t('x402_purchased_heading')} level={4} />
              <p className="muted small">{t('x402_purchased_sub')}</p>
              <ul className="purchased-list">
                {x.purchased.map(({ entry, report }) => (
                  <li key={entry.report_id}>
                    <div>
                      <strong>{entry.kind}</strong>
                      <p className="muted small">{`${entry.case_id || ''} · ${t('x402_purchased_expires', { time: new Date(entry.expires_at).toLocaleTimeString() })}`}</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => reopenReport(report)}>{t('x402_purchased_reread')}</Button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function DecisionReferences() {
  const decision = useApp((s) => evidenceFor(s, s.caseId));
  return decision ? <div id="x402-decision-reference"><References references={decision.references} open /></div> : null;
}

function PricingImpact({ impact }) {
  const { before, after, delta } = impact;
  const dir = delta < 0 ? t('x402_price_drop') : delta > 0 ? t('x402_price_rise') : t('x402_price_nochange');
  return (
    <Card className="x402-impact x402-impact-pop" aria-labelledby="x402-impact-h">
      <CardHead id="x402-impact-h" title={t('x402_pricing_impact')} level={4} />
      <div className="impact-row">
        <div className="quote-side"><span className="muted small">{t('x402_before_label')}</span><strong className="price-md">{before !== undefined ? `$${before.toFixed(3)}` : '—'}</strong>{impact.beforeRisk ? <Badge tone={badgeTone(impact.beforeRisk)}>{impact.beforeRisk}</Badge> : null}</div>
        <Icon name="arrowRight" size={18} className="impact-arrow" />
        <div className="quote-side"><span className="muted small">{t('x402_after_label')}</span><strong className={cx('price-md', delta ? 'price-flash' : '')}>{after !== undefined ? `$${after.toFixed(3)}` : '—'}</strong>{impact.afterRisk ? <Badge tone={badgeTone(impact.afterRisk)}>{impact.afterRisk}</Badge> : null}</div>
      </div>
      {delta !== undefined ? (
        <p><Badge tone={delta ? 'crit' : 'muted'} className={delta > 0 ? 'risk-pulse' : undefined}>{`${dir} — ${t('x402_delta', { delta: (delta >= 0 ? '+' : '') + '$' + delta.toFixed(3) })}`}</Badge></p>
      ) : null}
    </Card>
  );
}

function ReportPreview({ service }) {
  const caseEntry = useApp((s) => s.cases.find((entry) => entry.case_id === s.caseId));
  return (
    <Card className="report-detail" data-state="preview" aria-labelledby="x402-preview-h">
      <CardHead id="x402-preview-h" title={service.title} level={4}><Badge tone="accent">{`${service.priceUSDC} USDC`}</Badge></CardHead>
      <p className="muted">{service.description}</p>
      <div className="kv-grid">
        <KV label={t('x402_r_case')}>{caseEntry ? shortLabel(caseEntry) : '—'}</KV>
        <KV label={t('x402_r_service_id')} mono>{service.serviceId}</KV>
        <KV label={t('x402_r_status')}>{service.status || 'available'}</KV>
      </div>
      <h5 className="sub-title">{t('x402_r_unlock_contents')}</h5>
      <ul className="bullets">{(BULLETS[service.serviceId] ?? BULLETS.default).map((key) => <li key={key}>{t(key)}</li>)}</ul>
    </Card>
  );
}

function ReportSection({ title, children }) {
  if (!children) return null;
  return <section className="report-section"><h5 className="sub-title">{title}</h5>{children}</section>;
}

function ObjectSummary({ value }) {
  if (!value) return null;
  if (typeof value === 'string') return <p>{value}</p>;
  if (Array.isArray(value)) return <ul className="bullets">{value.map((item, index) => <li key={index}>{String(item)}</li>)}</ul>;
  if (typeof value === 'object') {
    return (
      <div className="kv-grid">
        {Object.entries(value).map(([key, val]) => <KV key={key} label={key.replace(/_/g, ' ')}>{Array.isArray(val) ? val.join(', ') : String(val)}</KV>)}
      </div>
    );
  }
  return <p>{String(value)}</p>;
}

function EventCards({ events, empty }) {
  if (!events?.length) return <p className="muted">{empty}</p>;
  return (
    <div className="report-cards">
      {events.map((event, index) => {
        const severity = event.severity || event.level || event.status || 'signal';
        const meta = [event.region, event.source, event.as_of].filter(Boolean).join(' · ');
        return (
          <article key={index} className="report-card">
            <header><strong>{event.title || event.type || event.category || 'risk event'}</strong><Badge tone={badgeTone(severity)}>{severity}</Badge></header>
            {meta ? <p className="muted small">{meta}</p> : null}
            <p>{event.description || event.text || event.snippet || event.detail || t('x402_r_signal_default')}</p>
          </article>
        );
      })}
    </div>
  );
}

function IntelCards({ entries }) {
  if (!entries?.length) return <p className="muted">{t('x402_r_no_rag')}</p>;
  return (
    <div className="report-cards">
      {entries.map((entry, index) => (
        <article key={index} className="report-card">
          <header><strong>{entry.type || entry.id || 'evidence'}</strong><Badge tone="muted">{Number.isFinite(Number(entry.score)) ? Number(entry.score).toFixed(2) : '—'}</Badge></header>
          <p className="muted small">{[entry.region, entry.source, entry.severity].filter(Boolean).join(' · ')}</p>
          <p>{entry.snippet || entry.detail || entry.text || ''}</p>
        </article>
      ))}
    </div>
  );
}

function ToolTrace({ trace = [] }) {
  if (!trace.length) return <p className="muted">{t('x402_r_no_tools')}</p>;
  return (
    <div className="report-cards">
      {trace.map((item, index) => {
        const status = item.status || item.provider || item.source || 'called';
        const fields = Object.entries(item).filter(([key]) => !['tool', 'name', 'status'].includes(key));
        return (
          <article key={index} className="report-card">
            <header><strong>{item.tool || item.name || `tool call #${index + 1}`}</strong><Badge tone={badgeTone(status)}>{status}</Badge></header>
            {fields.length ? (
              <div className="trace-grid">
                {fields.map(([key, value]) => (
                  <div key={key}><span className="muted small">{key.replace(/_/g, ' ')}</span><code className="trace-value">{value == null ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}</code></div>
                ))}
              </div>
            ) : <p className="muted">{t('x402_r_tool_done')}</p>}
          </article>
        );
      })}
    </div>
  );
}

function RiskIntelReport({ data }) {
  const before = data.before_quote || {}, after = data.after_quote || {}, delta = data.delta || {};
  return (
    <>
      <div className="kv-grid">
        <KV label={t('x402_r_before_price')}>{formatUsd(before.final_issue_price_usd, 3)}</KV>
        <KV label={t('x402_r_after_price')}>{formatUsd(after.final_issue_price_usd, 3)}</KV>
        <KV label={t('x402_r_price_delta')}>{formatUsd(delta.issue_price_delta_usd ?? delta.issue_price_usd, 3)}</KV>
        <KV label={t('x402_r_risk_level')}><Badge tone={badgeTone(after.risk_level || before.risk_level)}>{after.risk_level || before.risk_level || '—'}</Badge></KV>
        <KV label={t('x402_r_evidence_hash')} mono>{shortHash(data.evidence_hash || data.report_envelope?.evidence_hash)}</KV>
      </div>
      <ReportSection title={t('x402_r_summary')}>{data.summary ? <ObjectSummary value={data.summary} /> : null}</ReportSection>
      {before.final_issue_price_usd || after.final_issue_price_usd ? (
        <ReportSection title={t('x402_r_before_after')}>
          <div className="impact-row">
            <div className="quote-side"><span className="muted small">{t('x402_before_label')}</span><strong className="price-md">{formatUsd(before.final_issue_price_usd, 3)}</strong><span className="muted small">{`${before.risk_level || '—'} · ${before.pricing_action || '—'}`}</span></div>
            <Icon name="arrowRight" size={18} className="impact-arrow" />
            <div className="quote-side"><span className="muted small">{t('x402_after_label')}</span><strong className="price-md">{formatUsd(after.final_issue_price_usd, 3)}</strong><span className="muted small">{`${after.risk_level || '—'} · ${after.pricing_action || '—'}`}</span></div>
          </div>
        </ReportSection>
      ) : null}
      <ReportSection title={t('x402_r_world_events')}><EventCards events={data.events} empty={t('x402_r_no_events')} /></ReportSection>
      <ReportSection title={t('x402_r_rag')}><IntelCards entries={data.deepIntel} /></ReportSection>
      {data.sources?.length ? <ReportSection title={t('x402_r_sources')}><ul className="bullets">{data.sources.map((source, index) => <li key={index}>{source.label || source.url || String(source)}</li>)}</ul></ReportSection> : null}
    </>
  );
}

function ValuationReport({ data }) {
  const zh = useLang() === 'zh';
  return (
    <>
      {data.human_takeover?.required && <p role="status" className="callout tone-warn">{zh ? '待人工接管：当前为研究参考，来源或模型尚未通过验收；请勿据此直接开放融资。' : 'Human takeover pending: this is a research reference. Sources or models have not passed acceptance; review before opening financing.'}</p>}
      <div className="kv-grid">
        <KV label={t('x402_r_collateral')}>{formatUsd(data.cargo_value, 0)}</KV>
        <KV label={t('x402_r_max_exposure')}>{formatUsd(data.max_safe_redemption_exposure_usd, 0)}</KV>
        <KV label={t('x402_r_unit_price')}>{`${formatUsd(data.unit_price, 2)} / MT`}</KV>
        <KV label={t('x402_r_haircut')}>{data.volatility_haircut_pct == null ? '—' : `${data.volatility_haircut_pct}%`}</KV>
      </div>
      <ReportSection title={t('x402_r_valuation_expl')}><p>{data.explanation || t('x402_r_no_expl')}</p></ReportSection>
      {data.live_market ? <ReportSection title={t('x402_r_live_market')}><ObjectSummary value={data.live_market} /></ReportSection> : null}
      <ReportSection title={t('x402_r_comparables')}>
        <EventCards empty={t('x402_r_no_events')} events={(data.historical_comparables || []).map((item) => ({
          title: item.basis || item.source || item.commodity || 'Comparable transaction',
          severity: item.confidence || 'comparable',
          description: Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(' · ')
        }))} />
      </ReportSection>
      <ReportSection title={t('x402_r_risk_comparables')}><IntelCards entries={data.risk_comparables} /></ReportSection>
      <ReportSection title={t('x402_r_tool_trace')}><ToolTrace trace={data.tool_trace || []} /></ReportSection>
      {data.data_sources?.length ? <ReportSection title={t('x402_r_data_sources')}><ul className="bullets">{data.data_sources.map((source, index) => <li key={index}>{String(source)}</li>)}</ul></ReportSection> : null}
    </>
  );
}

function FraudReport({ data }) {
  const pricing = data.pricing_result || {};
  return (
    <>
      <div className="kv-grid">
        <KV label={t('x402_r_verdict')}><Badge tone={badgeTone(data.verdict)}>{data.verdict || '—'}</Badge></KV>
        <KV label={t('x402_r_doc_penalty')}>{`${data.document_penalty_bps ?? 0} bps`}</KV>
        <KV label={t('x402_r_issue_price')}>{formatUsd(pricing.issue_price_usd, 3)}</KV>
        <KV label={t('x402_r_risk_score')}>{`${pricing.risk_score_bps ?? '—'} bps`}</KV>
        <KV label={t('x402_r_quote_hash')} mono>{shortHash(pricing.quote_hash)}</KV>
      </div>
      <ReportSection title={t('x402_r_doc_issues')}>
        {data.issues?.length ? <ul className="bullets">{data.issues.map((issue, index) => <li key={index}>{typeof issue === 'string' ? issue : JSON.stringify(issue)}</li>)}</ul> : <p className="muted">{t('x402_r_no_issues')}</p>}
      </ReportSection>
      <ReportSection title={t('x402_r_checks')}>
        <EventCards empty={t('x402_r_no_events')} events={(data.checks || []).map((check) => ({
          title: check.id || check.name || 'document check',
          severity: check.status || (check.ok ? 'PASS' : 'REVIEW'),
          description: check.message || check.description || JSON.stringify(check)
        }))} />
      </ReportSection>
      {data.five_dimension_summary ? <ReportSection title={t('x402_r_five_dim')}><ObjectSummary value={data.five_dimension_summary} /></ReportSection> : null}
      {data.scenario ? <ReportSection title={t('x402_r_scenario')}><ObjectSummary value={data.scenario} /></ReportSection> : null}
    </>
  );
}

function UnlockedReport({ report, services }) {
  const caseId = useApp((s) => s.caseId);
  const { data, source } = report;
  const service = services.find((entry) => entry.serviceId === data.service) ?? {};
  const envelope = data.report_envelope || {};
  const Body = data.service === 'premium-valuation' ? ValuationReport : data.service === 'fraud-review' ? FraudReport : RiskIntelReport;
  return (
    <Card className="report-detail x402-impact-pop" data-state="unlocked" aria-labelledby="x402-report-h">
      <CardHead id="x402-report-h" title={service.title || data.service || t('x402_r_default_title')} level={4}>
        <Badge tone="ok">{source === 'cache' ? t('x402_r_unlocked_cached') : t('x402_r_unlocked')}</Badge>
      </CardHead>
      <p className="muted small">{`${data.case_id || caseId || '—'} · ${reportCountSummary(data)}`}</p>
      <Body data={data} />
      <Disclosure summary={t('x402_r_onchain')}>
        <div className="kv-grid">
          <KV label={t('x402_r_report_id')} mono>{shortHash(envelope.report_id)}</KV>
          <KV label={t('x402_r_report_hash')} mono>{shortHash(envelope.report_hash)}</KV>
          <KV label={t('x402_r_payment_tx')} mono>{shortHash(envelope.payment_tx || data.payment?.txHash)}</KV>
          <KV label={t('x402_r_expires')}>{envelope.expires_at || data.expires_at || '—'}</KV>
        </div>
      </Disclosure>
    </Card>
  );
}
