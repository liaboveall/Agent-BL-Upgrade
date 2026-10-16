import { useEffect } from 'react';
import { useApp } from '../../state/hooks.js';
import { t, tData } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import { evidenceFor, refreshPortfolio } from '../../state/controller.js';
import { Dialog, DialogHeader, Empty, Stat } from '../../components/ui.jsx';
import { DecisionButton, References } from '../../features/evidence/References.jsx';
import { poolStateLabel } from '../../features/copilot/Recommendations.jsx';

/** The Demo subscriptions the server holds for this wallet (or the demo wallet). */
export function PortfolioDialog({ open, onClose }) {
  const state = useApp((s) => s);
  const { investments, summary, error } = state.portfolio;
  useEffect(() => { if (open) refreshPortfolio(); }, [open]);
  return (
    <Dialog id="portfolio-dialog" open={open} onClose={onClose} labelledBy="portfolio-title" variant="side" className="portfolio-dialog">
      <DialogHeader id="portfolio-title" title={t('portfolio_h')} subtitle={t('portfolio_sub')} onClose={onClose} />
      <div className="dialog-body">
        <div className="stat-row">
          <Stat label={t('portfolio_total_label')} value={`$${(summary?.totalInvestedUsd ?? 0).toLocaleString()}`} />
          <Stat label={t('portfolio_yield_label')} value={`${((summary?.avgYieldBps ?? 0) / 100).toFixed(2)}%`} />
        </div>
        {error ? <p className="text-crit">{t('cp_error', { message: error })}</p> : null}
        {!investments?.length ? <Empty title={t('portfolio_empty')}>{t('portfolio_empty_hint')}</Empty> : (
          <ul className="holding-list">
            {investments.map((item) => {
              const linked = evidenceFor(state, item.poolId)?.references ?? item.references;
              return (
                <li key={`${item.reference}-${item.timestamp}`} className="holding">
                  <div className="holding-head">
                    <strong>{tData(item.label)}</strong>
                    <span className="mono">${item.amountUsd.toLocaleString()}</span>
                  </div>
                  <p className="muted small">{t(`cp_source_${item.source_label}`)}</p>
                  <p>{t('cp_position_current', { status: poolStateLabel(item.current_status), price: item.current_price_usd ?? '—', risk: f.riskLabel(item.current_risk_level) })}</p>
                  <p className="muted small">{t('cp_position_demo')}</p>
                  <div className="holding-actions">
                    {(item.decisions ?? []).map((decision) => <DecisionButton key={decision.decision_id} id={decision.decision_id} />)}
                  </div>
                  {linked ? <References references={linked} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
