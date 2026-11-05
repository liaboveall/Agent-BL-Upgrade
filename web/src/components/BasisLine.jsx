import { t } from '../lib/i18n.js';

// How each market-data status reads next to a headline number: plain bold text in the colour the theme provides for readable
// text on a tinted surface (a filled badge on the quote's own tinted block fell below WCAG AA contrast in the dark theme).
const KIND = { live: 'live', fixture: 'fixture', stale: 'warn', unavailable: 'warn' };

/**
 * The basis of a headline number, always visible beside it instead of folded away: what kind of figure it is (a rule estimate,
 * never a realizable disposal value), whether the market benchmark behind it is live, a research fixture, stale or missing, and
 * the day it was observed. The reader meets the price and the risk level first, so this is where they learn what they stand on.
 */
export function BasisLine({ quote, kind = 'collateral' }) {
  const market = quote?.field_sources?.market ?? null;
  const status = KIND[market?.status] ? market.status : 'unavailable';
  const observed = typeof market?.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(market.observed_at) ? market.observed_at.slice(0, 10) : null;
  return (
    <p className="basis-line muted small" data-basis={kind}>
      <span>{t(`basis_${kind}`)}</span>
      <strong className={`basis-status basis-status-${KIND[status]}`} title={market?.source ?? undefined}>{t('basis_market', { status: t(`basis_status_${status}`) })}</strong>
      {observed ? <span>{t('basis_observed', { date: observed })}</span> : null}
      <span>{t('basis_scope')}</span>
    </p>
  );
}
