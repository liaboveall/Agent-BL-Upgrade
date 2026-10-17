import { useApp } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import { potentialYieldText } from '../../lib/market.js';
import { clearEvidenceSelection } from '../../state/controller.js';
import { Button, Card, CardHead } from '../../components/ui.jsx';
import { References } from '../../features/evidence/References.jsx';

/**
 * How the issue price steps down from the $1.00 target redemption: base anchor, payout-speed
 * urgency and risk, then the collateral floor if it binds. A decision opened from the Agent console
 * shows the quote that decision used.
 */
export function Waterfall({ quote: current }) {
  const selected = useApp((s) => (s.evidenceSelected?.case_id === s.caseId ? s.evidenceSelected : null));
  const decision = selected && (selected.quote_snapshot ?? selected.proposal?.params?.quote) ? selected : null;
  const quote = decision ? decision.quote_snapshot ?? decision.proposal.params.quote : current;

  const base = quote.base_issue_price_usd;
  const urg = quote.urgency_discount_bps / 10000;
  const risk = quote.risk_discount_bps / 10000;
  const speedPrice = base - urg;
  const indicative = quote.indicative_issue_price_usd;
  const final = quote.final_issue_price_usd;
  const lifted = quote.binding_constraint === 'COLLATERAL' && final > indicative + 1e-6;
  const lo = Math.max(0.4, Math.floor((Math.min(indicative, final, base) - 0.06) * 20) / 20);
  const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (1 - lo)) * 100));
  const cols = [
    { kind: 'target', label: t('wf_target'), value: 1.0, top: 1.0, bottom: lo, note: t('wf_note_redemption') },
    { kind: 'base', label: t('wf_base'), value: base, top: base, bottom: lo, note: t('wf_note_anchor') },
    { kind: 'down', label: t('wf_urgency'), value: -urg, top: base, bottom: speedPrice, note: `${f.SPEED_META[quote.payout_speed]?.label ?? quote.payout_speed} · −${quote.urgency_discount_bps} bps` },
    { kind: 'down', label: t('wf_risk'), value: -risk, top: speedPrice, bottom: indicative, note: `${f.riskLabel(quote.risk_level)} · −${quote.risk_discount_bps} bps` },
    { kind: 'mid', label: t('wf_indicative'), value: indicative, top: indicative, bottom: lo, note: t('wf_note_profit') }
  ];
  if (lifted) cols.push({ kind: 'up', label: t('wf_floor'), value: final - indicative, top: final, bottom: indicative, note: t('wf_note_floor') });
  cols.push({ kind: 'final', label: t('wf_final'), value: final, top: final, bottom: lo, note: t('wf_final_note', { pct: potentialYieldText(quote) }) });

  return (
    <Card id="console-panel" aria-labelledby="waterfall-h">
      <CardHead id="waterfall-h" title={t('p2_h')} />
      <p className="muted small">{t('p2_sub')}</p>
      {selected && !decision ? <p className="callout tone-info" role="status">{t('ac_historical_quote_missing')}</p> : null}
      {decision ? (
        <div className="callout tone-info decision-quote" role="status">
          <span>{t('ac_historical_quote')}</span>
          <Button variant="ghost" size="sm" onClick={clearEvidenceSelection}>{t('ac_current_quote')}</Button>
        </div>
      ) : null}
      {decision ? <References references={decision.references} open /> : null}
      <div id="waterfall" className="waterfall" tabIndex={-1} data-quote-hash={quote.quote_hash ?? ''}>
        <div className="wf-chart" role="img" aria-label={t('wf_aria', { base: f.price(base), final: f.price(final) })}>
          <div className="wf-cols">
            <div className="wf-target-line" style={{ bottom: `calc((100% - 32px) * ${pos(1) / 100})` }}><span>{t('wf_axis_target')}</span></div>
            {cols.map((col, index) => {
              const delta = col.kind === 'down' || col.kind === 'up';
              const bottom = pos(Math.min(col.top, col.bottom));
              const height = Math.abs(pos(col.top) - pos(col.bottom));
              const text = delta ? `${col.kind === 'down' ? '−' : '+'}${f.price(Math.abs(col.value))}` : `$${f.price(col.value)}`;
              return (
                <div key={index} className={`wf-col wf-${col.kind}`}>
                  <div className="wf-track">
                    <span className="wf-bar" style={{ bottom: `${bottom}%`, height: `${Math.max(height, 0.6)}%` }} />
                    <span className="wf-val" style={{ bottom: `${pos(col.top)}%` }}>{text}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="wf-labels">
            {cols.map((col, index) => (
              <div key={index} className={`wf-col-label wf-${col.kind}`}>
                <span className="wf-col-name">{col.label}</span>
                <span className="wf-col-note">{col.note}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="muted small">{t('wf_axis_foot', { lo: f.price(lo), bc: t(`constraint_${quote.binding_constraint}`) })}</p>
      </div>
      <p className="explain">{t('pricing_exporter_summary', { cash: f.usd(quote.expected_cash_to_exporter_usd), cost: f.usd(quote.financing_cost_usd),
        share: f.bpsToPct(quote.exporter_profit_share_bps), net: f.usd(quote.exporter_net_profit_usd) })}</p>
      <p className="muted small">{t(`profit_basis_${quote.profit_basis ?? 'declared'}`)}</p>
    </Card>
  );
}
