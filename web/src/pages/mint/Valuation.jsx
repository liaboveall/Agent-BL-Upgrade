import { useApp } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import { Badge, Card, CardHead, Disclosure, KV } from '../../components/ui.jsx';

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
