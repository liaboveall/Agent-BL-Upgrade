import { useApp } from '../../state/hooks.js';
import { selectedQuote } from '../../state/app-store.js';
import { t, tData } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import {
  PAUSED_ACTIONS, annualYieldText, defaultMarketSubscription, marketDataSource, marketView, marketVoyageNote,
  marketVoyageProgress, potentialYieldText, routeText, shortCargoName
} from '../../lib/market.js';
import { evidenceFor, openDeal, setSubscriptionAmount, setView, subscribeSelected } from '../../state/controller.js';
import { Badge, Button, Field, KV, Progress } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { References } from '../../features/evidence/References.jsx';
import { statusMeta } from './ProjectCard.jsx';

export function DetailPanel({ now }) {
  const state = useApp((s) => s);
  const entry = state.cases.find((c) => c.case_id === state.caseId);
  const view = entry ? marketView(state, entry) : null;
  const quote = view?.pool?.quote ?? selectedQuote(state);
  if (!entry || !quote) {
    return <div className="detail-panel card is-loading"><p className="muted">{t('market_detail_loading')}</p></div>;
  }
  const bl = state.caseData?.bill_of_lading ?? entry.case?.bill_of_lading ?? {};
  const paused = entry.historical === true || (view.pool ? view.paused : PAUSED_ACTIONS.has(quote.pricing_action));
  const status = statusMeta(entry, view);
  const progress = marketVoyageProgress(entry.case, now);
  const source = marketDataSource(entry);
  const amount = state.marketSubscriptionUsd ?? defaultMarketSubscription(quote);
  const tokens = quote.final_issue_price_usd > 0 ? Math.floor((Number(amount) || 0) / quote.final_issue_price_usd) : 0;
  const result = state.marketSubscriptionResult;
  const decision = evidenceFor(state, entry.case_id);
  const cargo = tData(bl.cargo || entry.cargo || 'Trade cargo');
  const buttonLabel = entry.historical ? t('market_historical_btn') : paused ? t('market_paused_btn')
    : state.marketSubscribing ? t('market_subscribing') : t('market_subscribe_btn');
  return (
    <div className="detail-panel card" id="market-detail">
      <header className="detail-head">
        <p className="eyebrow">{t('market_detail_label')}</p>
        <h2 className="detail-title">{shortCargoName(cargo)}</h2>
        <p className="muted">{routeText(bl)}</p>
      </header>

      <div className="detail-price">
        <div>
          <span className="stat-label">{t('market_issue_price')}</span>
          <strong className="price-xl">${f.price(quote.final_issue_price_usd)}</strong>
        </div>
        <div className="detail-badges">
          <Badge tone={f.riskTone(quote.risk_level)}>{t('market_risk_badge', { level: f.riskLabel(quote.risk_level) })}</Badge>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>

      <div className="kv-grid">
        <KV label={t('market_detail_annual')} tone={paused ? undefined : 'gain'}>{paused ? '--' : annualYieldText(quote)}</KV>
        <KV label={t('market_detail_upside')}>{paused ? '--' : `${potentialYieldText(quote)}${quote.tenor_days ? ` · ${t('market_tenor_days', { days: quote.tenor_days })}` : ''}`}</KV>
        <KV label={t('live_riskbps_label')}>{`${f.int(quote.risk_score_bps)} bps`}</KV>
        <KV label={t('market_detail_collateral')}>{f.usdCompact(quote.ai_verified_collateral_value_usd)}</KV>
        <KV label={t('market_fact_target')}>{f.usdCompact(quote.expected_cash_to_exporter_usd ?? quote.requested_cash_usd)}</KV>
        <KV label={t('market_detail_eta')}>{f.fmtDate(bl.eta)}</KV>
      </div>

      <div className="detail-voyage">
        <Progress value={progress ?? 0} tone="info" label={t('a11y_voyage_progress')} />
        <p className="muted small">{marketVoyageNote(bl, progress)}</p>
      </div>

      <div className="detail-subscribe">
        <Field label={t('market_subscription_label')} htmlFor="market-subscription">
          <div className="input-row">
            <input
              id="market-subscription"
              className="input"
              type="number"
              min="0"
              step="10000"
              inputMode="numeric"
              value={String(amount)}
              disabled={paused}
              onChange={(event) => setSubscriptionAmount(event.target.value)}
            />
            <Button id="market-subscribe-btn" variant="primary" disabled={paused || !state.demoMode || state.marketSubscribing} onClick={subscribeSelected}>
              {buttonLabel}
            </Button>
          </div>
        </Field>
        {!state.demoMode && !paused ? <p className="field-hint">{t('market_live_subscribe_hint')}</p> : null}
        <div className="readout" aria-live="polite">
          <div className="kv-stack">
            <KV label={t('market_readout_receive')}>{`${f.int(tokens)} RWA`}</KV>
            <KV label={t('mr_redeem')} tone="gain">{f.usd(tokens)}</KV>
            <KV label={t('mr_upside')} tone="gain">{f.usd(Math.max(0, tokens - (Number(amount) || 0)))}</KV>
          </div>
          {result ? (
            <p className="result-line">
              <Badge tone={f.stateTone(result.final_state)}>{result.final_state}</Badge>
              {t('cp_subscription_recorded', { price: result.price, shares: f.int(result.tokenCount) })}
            </p>
          ) : <p className="muted small">{t('market_readout_foot')}</p>}
        </div>
      </div>

      <p className={`source-line tone-text-${source.tone}`}><Icon name="info" size={14} />{source.text}</p>

      <div className="detail-actions">
        <Button variant="secondary" onClick={() => openDeal(state.caseId)}><Icon name="ship" size={15} />{t('market_open_voyage')}</Button>
        <Button variant="ghost" onClick={() => setView('mint')}>{t('market_open_pricing')}<Icon name="arrowRight" size={14} /></Button>
      </div>
      {decision ? <References references={decision.references} /> : null}
    </div>
  );
}
