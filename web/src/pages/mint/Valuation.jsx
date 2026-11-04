import { useApp } from '../../state/hooks.js';
import { t, tData } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import { Badge, Card, CardHead, Disclosure, KV } from '../../components/ui.jsx';

/**
 * The four values a reader can confuse, kept apart: what the documents declare, the market benchmark (with its unit,
 * date, grade, region and source status), the rule estimate this page prices from, and the independent disposal value
 * the research prototype does not have.
 */
function ValueBases({ quote, caseData }) {
  const bl = caseData.bill_of_lading ?? {}, market = caseData.market ?? null, status = quote.field_sources?.market?.status ?? '—';
  const usdPer = (value) => value == null ? '—' : f.usd(value);
  return (
    <Disclosure summary={t('vb_summary')} className="value-bases">
      <dl>
        <div><dt>{t('vb_declared')}</dt><dd>{bl.declared_value_usd ? f.usd(bl.declared_value_usd) : '—'}<small>{t('vb_declared_note')}</small></dd></div>
        <div><dt>{t('vb_benchmark')}</dt><dd>{market ? <>{usdPer(market.landed_price_usd_per_mt ?? market.reference_price_usd_per_mt)} / {(market.price_unit ?? 'USD/MT').replace(/^USD\//u, '')}<small>{t('vb_benchmark_note', {
          benchmark: market.benchmark ?? market.commodity ?? '—', price: usdPer(market.reference_price_usd_per_mt), unit: (market.price_unit ?? 'USD/MT').replace(/^USD\//u, ''),
          premium: usdPer(market.regional_premium_usd_per_mt), asof: market.as_of ?? '—', source: market.source ?? '—', status })}</small>
          <small>{t('vb_quality', { grade: caseData.cargo?.grade ?? bl.cargo ?? '—', route: bl.port_of_loading && bl.port_of_discharge ? `${tData(bl.port_of_loading)} → ${tData(bl.port_of_discharge)}` : '—' })}</small></>
          : <small>{t('vb_benchmark_none')}</small>}</dd></div>
        <div><dt>{t('vb_rule')}</dt><dd>{f.usd(quote.ai_verified_collateral_value_usd)}<small>{t('vb_rule_note')}</small></dd></div>
        <div><dt>{t('vb_disposal')}</dt><dd>—<small>{t('vb_disposal_note')}</small></dd></div>
      </dl>
    </Disclosure>
  );
}

/** AI-verified collateral value, the route-risk dimensions behind the discount, and where the data came from. */
export function Valuation({ quote }) {
  const caseData = useApp((s) => s.caseData) ?? {};
  const bl = caseData.bill_of_lading ?? {};
  const ins = caseData.insurance ?? {};
  const dims = f.rollupRiskDimensions(quote.risk_components ?? quote.risk_factors);
  const cites = f.intelCitations(quote);
  const sources = f.riskSources(quote, caseData, t);
  return (
    <Card id="valuation-panel" aria-labelledby="valuation-h">
      <CardHead id="valuation-h" title={t('p1_h')}>
        <Badge tone={f.riskTone(quote.risk_level)}>{t('risk_premium_badge', { level: f.riskLabel(quote.risk_level), bps: f.int(quote.risk_score_bps) })}</Badge>
      </CardHead>
      <div className="valuation-grid">
        <div className="collateral">
          <span className="stat-label">{t('collateral_label')}</span>
          <strong className="price-xl" id="mint-collateral">{f.usd(quote.ai_verified_collateral_value_usd)}</strong>
          <div className="kv-stack">
            <KV label={t('val_declared')}>{bl.declared_value_usd ? f.usd(bl.declared_value_usd) : '—'}</KV>
            <KV label={t('val_insured')}>{ins.insured_value_usd ? f.usd(ins.insured_value_usd) : '—'}</KV>
            <KV label={t('val_safe_exposure')}>{f.usd(quote.max_safe_redemption_exposure_usd)}</KV>
            <KV label={t('val_supply')}>{f.int(quote.recommended_token_supply)}</KV>
          </div>
        </div>
        <div className="risk-dims" aria-label={t('riskdims_h')}>
          <span className="stat-label">{t('riskdims_h')}</span>
          <ul>
            {dims.map((dim) => {
              const tone = dim.active ? f.bpsTone(dim.bps) : 'muted';
              return (
                <li key={dim.id} className={`risk-dim tone-${tone}${dim.active ? ' is-active' : ''}`} title={dim.factors.join('\n') || undefined}>
                  <span className="risk-dim-label">{dim.label}</span>
                  <span className="risk-dim-bps">{!dim.active ? t('risk_clear') : dim.bps > 0 ? `+${dim.bps} bps` : t('risk_flagged')}</span>
                  {dim.active && dim.factors.length ? <span className="risk-dim-factors">{dim.factors.join(' · ')}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <ValueBases quote={quote} caseData={caseData} />
      <Disclosure summary={t('sources_head_count', { n: sources.length + cites.length })}>
        {cites.length ? (
          <div className="cites">
            <span className="muted small">{t('risk_cite_head')}</span>
            {cites.map((cite) => <code key={cite} className="cite">{cite}</code>)}
          </div>
        ) : null}
        <ul className="source-list">
          {sources.map((source, index) => (
            <li key={index}><Badge tone="accent">{source.tag}</Badge><span>{source.detail}</span></li>
          ))}
        </ul>
      </Disclosure>
    </Card>
  );
}
