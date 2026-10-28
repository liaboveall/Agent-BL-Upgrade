import { useApp } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import * as web3 from '../../lib/web3.js';
import { PAUSED_ACTIONS, potentialYieldText } from '../../lib/market.js';
import { mint, requote, selectSpeed, setFinancing, setView } from '../../state/controller.js';
import { quoteCurrent } from '../../state/app-store.js';
import { Badge, Button, Card, Field, KV, cx, useRovingKeys } from '../../components/ui.jsx';
import { RichT } from '../../components/RichText.jsx';

const SPEEDS = ['FAST', 'BALANCED', 'LOW_COST'];

/** Pick a payout speed, enter the financing amount, mint. The one action this page is for. */
export function MintPanel({ quote }) {
  const comparison = useApp((s) => s.comparison);
  const pool = useApp((s) => s.evidencePools.get(s.caseId) ?? null);
  const speed = useApp((s) => s.speed);
  const financingUsd = useApp((s) => s.financingUsd);
  const minting = useApp((s) => s.minting);
  const busy = useApp((s) => s.busy);
  const demoMode = useApp((s) => s.demoMode);
  const result = useApp((s) => s.mint);
  // A comparison computed before the constraints now saved stays on screen for reference, but cannot be issued.
  const current = useApp((s) => quoteCurrent(s));
  const quoteError = useApp((s) => s.quoteError);
  const quotes = comparison?.quotes ?? [];
  const recommended = comparison?.recommended_payout_speed;
  const available = SPEEDS.filter((name) => quotes.some((q) => q.payout_speed === name));
  const { onKeyDown, choiceProps } = useRovingKeys(available, speed, selectSpeed);
  const paused = PAUSED_ACTIONS.has(quote.pricing_action);
  const act = f.actionMeta(quote.pricing_action);
  const financing = financingUsd ?? Math.round(quote.requested_cash_usd || 0);
  const tokens = web3.mintedTokensFor(quote, financing);

  return (
    <Card className="mint-panel" id="mint-panel" aria-labelledby="mint-panel-h">
      <header className="mint-panel-head">
        <h2 id="mint-panel-h" className="card-title">{t('p3_h')}</h2>
        <div className="hero-price" id="hero-price">
          <span className="stat-label">{t('hp_label')}</span>
          <strong className="price-xxl">${f.price(quote.final_issue_price_usd)}</strong>
          <div className="badge-row">
            <Badge tone={act.tone}>{`${act.icon} ${act.label}`}</Badge>
            <span className="small"><strong className="text-gain">{potentialYieldText(quote)}</strong> {t('hp_upside')}</span>
          </div>
          <p className="muted small"><RichT k="hp_redeem" vars={{ speed: f.SPEED_META[quote.payout_speed]?.label ?? quote.payout_speed }} /></p>
          {pool?.quote && (pool.quote.payout_speed !== quote.payout_speed || Math.abs(pool.quote.final_issue_price_usd - quote.final_issue_price_usd) > 1e-6)
            ? <p className="muted small">{t('live_pool_terms', { speed: f.SPEED_META[pool.quote.payout_speed]?.label ?? pool.quote.payout_speed, price: f.price(pool.quote.final_issue_price_usd) })}</p> : null}
        </div>
      </header>

      {current ? null : (
        <div className="callout tone-warn" id="quote-stale" role="status">
          <p>{quoteError ? t('quote_stale', { msg: quoteError }) : t('quote_stale_pending')}</p>
          {quoteError ? <Button variant="secondary" size="sm" disabled={busy} onClick={requote}>{t('quote_retry')}</Button> : null}
        </div>
      )}

      <div className="speed-group">
        <span className="field-label" id="speed-label">{t('payout_speed_label')}</span>
        <div id="speed-select" className="speed-options" role="radiogroup" aria-labelledby="speed-label" onKeyDown={onKeyDown}>
          {SPEEDS.map((name) => {
            const q = quotes.find((item) => item.payout_speed === name);
            if (!q) return null;
            const index = available.indexOf(name);
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={speed === name}
                className={cx('speed-option', speed === name && 'is-active')}
                onClick={() => selectSpeed(name)}
                {...choiceProps(name, index)}
              >
                <span className="speed-option-head">
                  <strong>{f.SPEED_META[name].label}</strong>
                  {name === recommended ? <Badge tone="accent">{t('ec_aipick')}</Badge> : null}
                </span>
                <span className="muted small">{t(`speed_${name}_sub`)}</span>
                <span className="speed-option-price">${f.price(q.final_issue_price_usd)}<small>{t('unit_per_token')}</small></span>
              </button>
            );
          })}
        </div>
        <div className="kv-stack speed-economics" aria-live="polite">
          <KV label={t('ec_cash')}>{f.usd(quote.expected_cash_to_exporter_usd)}</KV>
          <KV label={t('ec_cost')} tone="cost">{f.usd(quote.financing_cost_usd)}</KV>
          <KV label={t('ec_share')} tone={quote.exporter_profit_share_bps / 100 > 65 ? 'cost' : quote.exporter_profit_share_bps / 100 > 50 ? 'warn' : undefined}>{f.bpsToPct(quote.exporter_profit_share_bps)}</KV>
          <KV label={t('ec_net')} tone="gain">{f.usd(quote.exporter_net_profit_usd)}</KV>
        </div>
      </div>

      <Field label={t('financing_label')} htmlFor="mint-financing">
        <div className="input-row">
          <input id="mint-financing" className="input" type="number" min="0" step="100000" inputMode="numeric" value={String(financing)} disabled={paused}
            onChange={(event) => setFinancing(event.target.value)} />
          <Button id="mint-btn" variant="primary" disabled={paused || minting || busy || !demoMode || !current} onClick={mint}>{minting ? t('minting') : t(demoMode ? 'mint_demo_btn' : 'mint_lab_btn')}</Button>
        </div>
      </Field>
      {paused ? (
        <p className="callout tone-crit">{t('mr_paused', { action: act.label })}</p>
      ) : (
        <div className="readout" id="mint-readout">
          <p>{t('mr_receive_pre')} <strong>{f.int(tokens)}</strong> {t('mr_receive_post', { price: f.price(quote.final_issue_price_usd) })}</p>
          <div className="readout-grid">
            <KV label={t('mr_invest')}>{f.usd(tokens * quote.final_issue_price_usd)}</KV>
            <KV label={t('mr_redeem')} tone="gain">{f.usd(tokens)}</KV>
            <KV label={t('mr_upside')} tone="gain">{f.bpsToPct(quote.implied_gross_yield_bps)}</KV>
          </div>
          <p className="muted small">{t('mr_foot')}</p>
        </div>
      )}
      <p className="compliance small" id="compliance-note"><RichT k="compliance" /></p>
      <p className="callout tone-warn">{t(demoMode ? 'mint_demo_scope' : 'mint_lab_scope')}</p>
      {demoMode ? null : <button type="button" className="link-btn" onClick={() => setView('finance')}>{t('go_finance')}</button>}
      <MintResult result={result} quote={quote} />
    </Card>
  );
}

function MintResult({ result, quote }) {
  if (!result) return <p className="muted small mint-hint" id="mint-result">{t('mint_hint')}</p>;
  return <div className="mint-result" id="mint-result" aria-live="polite">
    <Badge tone="warn">{t('res_sim')}</Badge>
    <p>{t('res_minted_pre')} <strong>{f.int(result.mintedAmount)}</strong> {t('res_unit_rwa')}</p>
    <KV label={t('res_price')}>{'$' + f.price(quote.final_issue_price_usd)}</KV>
    <p className="muted small">{t('res_sim_foot')}</p>
  </div>;
}
