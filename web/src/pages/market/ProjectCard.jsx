import { t, tData } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import {
  annualYieldText, cargoImage, marketClock, marketFunding, marketView, marketVoyageProgress, potentialYieldText, registryTag, routeText, shortCargoName, shortRoute
} from '../../lib/market.js';
import { selectCase } from '../../state/controller.js';
import { Badge, Progress, cx } from '../../components/ui.jsx';
import { poolStateLabel } from '../../features/copilot/Recommendations.jsx';
import { scrollBehavior } from '../../lib/accessibility.js';

// Below 960px the detail card follows the whole shelf, so a tap would otherwise change nothing in view.
const SINGLE_COLUMN = '(max-width: 959px)';
function revealSelectedDetail() {
  if (!window.matchMedia?.(SINGLE_COLUMN).matches) return;
  requestAnimationFrame(() => document.querySelector('.market-aside')?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }));
}

/** The status chip next to the risk level: historical, an inactive pool, or the quote's pricing action. */
export function statusMeta(entry, view) {
  if (entry.historical) return { tone: 'muted', label: t('market_historical_badge') };
  if (view.pool && view.paused) return { tone: f.stateTone(view.pool.status) === 'crit' ? 'crit' : 'muted', label: poolStateLabel(view.pool.status) };
  if (!view.quote) return { tone: 'muted', label: t('market_loading') };
  const meta = f.actionMeta(view.quote.pricing_action);
  return { tone: meta.tone, label: meta.label };
}

export function ProjectCard({ entry, state, now, tagged = false }) {
  const view = marketView(state, entry);
  const { quote, paused, pool } = view;
  const bl = entry.case?.bill_of_lading ?? {};
  const active = entry.case_id === state.caseId;
  const funding = marketFunding(pool);
  const progress = marketVoyageProgress(entry.case, marketClock(entry, state.demoMode, now));
  const status = statusMeta(entry, view);
  const cargo = tData(bl.cargo || entry.cargo || entry.case_id);
  const highlighted = state.evidenceSelected?.case_id === entry.case_id;
  return (
    <button
      type="button"
      className={cx('deal-card', active && 'is-active', paused && 'is-paused', highlighted && 'is-highlighted')}
      data-case={entry.case_id}
      aria-pressed={active}
      onClick={() => { selectCase(entry.case_id); revealSelectedDetail(); }}
    >
      <span className="deal-card-head">
        <img className="deal-thumb" src={cargoImage(bl.cargo || entry.cargo || entry.case_id, entry.case_id)} alt="" width="44" height="44" loading="lazy" />
        <span className="deal-title">
          <span className="deal-name" title={cargo}>{shortCargoName(cargo)}</span>
          <span className="deal-route" title={routeText(bl)}>{tagged ? `${shortRoute(bl)} · #${registryTag(entry)}` : shortRoute(bl)}</span>
        </span>
      </span>
      <span className="deal-badges">
        <Badge tone={f.riskTone(quote?.risk_level)}>{quote ? t('market_risk_badge', { level: f.riskLabel(quote.risk_level) }) : '—'}</Badge>
        {status.tone !== 'ok' ? <Badge tone={status.tone}>{status.label}</Badge> : null}
      </span>
      {/* Label, value and note are one line each in both columns, so prices line up across a row of cards.
          The period return leads; the annualized figure of a short tenor is context, not the headline. */}
      <span className="deal-kpis">
        <span className="deal-kpi">
          <span className="deal-kpi-label">{t('market_issue_price')}</span>
          <span className="deal-kpi-value">{quote ? `$${f.price(quote.final_issue_price_usd)}` : '—'}</span>
          <span className="deal-kpi-note">{quote?.payout_speed ? t('market_card_speed', { speed: f.SPEED_META[quote.payout_speed]?.label ?? quote.payout_speed }) : '\u00a0'}</span>
        </span>
        <span className="deal-kpi">
          <span className="deal-kpi-label">{quote?.tenor_days ? t('market_card_upside', { days: quote.tenor_days }) : t('market_card_upside_plain')}</span>
          <span className={cx('deal-kpi-value', !paused && quote && 'text-gain')}>{paused ? '—' : potentialYieldText(quote, '—')}</span>
          <span className="deal-kpi-note">{paused || !quote ? '\u00a0' : t('market_card_annual', { pct: annualYieldText(quote, '—') })}</span>
        </span>
      </span>
      <span className="deal-funding">
        <Progress value={funding?.fill ?? 0} paused={paused} label={t('market_funding')} />
        <span className="deal-foot">
          <span>{funding ? t('market_funding_short', { pct: Math.round(funding.fill * 100), target: f.usdCompact(funding.target) }) : quote ? t('market_funding_target', { target: f.usdCompact(quote.expected_cash_to_exporter_usd ?? quote.requested_cash_usd) }) : t('market_funding_none')}</span>
          <span>{progress === null ? '—' : progress >= 1 ? t('market_arrived_short') : t('market_eta_short', { eta: f.fmtDate(bl.eta).slice(5) })}</span>
        </span>
      </span>
    </button>
  );
}
