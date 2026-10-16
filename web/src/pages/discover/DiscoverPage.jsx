import { useApp, useStore } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { buildPassportShareCard, shortPassportDigest } from '../../lib/passport.js';
import { Badge, Button, Card, Empty } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import {
  createPreview, formatPct, hiddenPassportIds, loadPassportCollection, mysteryState, mysteryStore, openPassportShare,
  passportShareOrigin, passportStampIcon, passportStampLabel, setShowHidden, setTier, tierMeta, togglePassportHidden
} from './mystery.js';
import { MysteryDialog } from './MysteryDialog.jsx';
import { SubscribeDialog } from './SubscribeDialog.jsx';
import { ShareDialog } from './ShareDialog.jsx';

const TIERS = [
  { value: 'CONSERVATIVE', label: 'mystery_tier_conservative', hint: 'mystery_tier_conservative_hint' },
  { value: 'BALANCED', label: 'mystery_tier_balanced', hint: 'mystery_tier_balanced_hint' },
  { value: 'ADVENTUROUS', label: 'mystery_tier_adventurous', hint: 'mystery_tier_adventurous_hint' }
];

export function DiscoverPage() {
  useStore(mysteryStore, (s) => s.version);
  const demoMode = useApp((s) => s.demoMode);
  const meta = tierMeta();
  return (
    <div className="discover">
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">{t('mystery_eyebrow')}</p>
          <h1>{t('discover_h1')}</h1>
          <p className="page-sub">{t('discover_subtitle')}</p>
        </div>
      </header>

      <Card id="mystery-entry" className="mystery-entry" aria-labelledby="mystery-entry-title">
        <div className="mystery-entry-copy">
          <span className="mystery-entry-box" aria-hidden="true">
            <span className="mystery-entry-box-lid" />
            <span className="mystery-entry-box-body"><span>?</span></span>
            <span className="mystery-entry-box-spark spark-a" />
            <span className="mystery-entry-box-spark spark-b" />
          </span>
          <div>
            <h2 id="mystery-entry-title" className="card-title">{t('mystery_title')}</h2>
            <p className="muted">{t('mystery_subtitle')}</p>
          </div>
        </div>
        <fieldset id="mystery-tier-selector" className="tier-options">
          <legend className="field-label">{t('mystery_tier_legend')}</legend>
          {TIERS.map((tier) => (
            <label key={tier.value} className="tier-option">
              <input type="radio" name="mystery-tier" value={tier.value} checked={mysteryState.tier === tier.value} onChange={() => setTier(tier.value)} />
              <span><strong>{t(tier.label)}</strong><small>{t(tier.hint)}</small></span>
            </label>
          ))}
        </fieldset>
        <div className="mystery-entry-action">
          <div className="kv-grid kv-grid-3" aria-live="polite">
            <div className="kv"><span className="kv-label">{t('mystery_yield_range')}</span><span className="kv-value" id="mystery-entry-yield">{meta.yieldRange}</span></div>
            <div className="kv"><span className="kv-label">{t('mystery_stress_cap')}</span><span className="kv-value" id="mystery-entry-loss">{`5%–${formatPct(meta.stressLossPct)}`}</span></div>
            <div className="kv"><span className="kv-label">{t('mystery_price')}</span><span className="kv-value">0.001 USDC</span></div>
          </div>
          <Button id="mystery-preview-btn" variant="primary" disabled={mysteryState.busy.preview} onClick={createPreview}>
            <Icon name="box" size={16} />{mysteryState.busy.preview ? t('mystery_committing') : t('mystery_preview_btn')}
          </Button>
          <span id="mystery-mode-note" className={`small ${demoMode ? 'muted' : 'text-ok'}`}>{demoMode ? t('mystery_demo_mode') : t('mystery_live_mode')}</span>
        </div>
      </Card>

      <PassportCollection />
      <MysteryDialog />
      <SubscribeDialog />
      <ShareDialog />
    </div>
  );
}

function PassportCollection() {
  const hidden = hiddenPassportIds();
  const visible = mysteryState.passports.filter((credential) => mysteryState.showHiddenPassports || !hidden.has(credential.credential_id));
  return (
    <section id="passport-collection" className="passport-collection" aria-labelledby="passport-collection-title">
      <header className="section-head">
        <div>
          <p className="eyebrow">{t('passport_eyebrow')}</p>
          <h2 id="passport-collection-title" className="section-title">{t('passport_collection_title')}</h2>
          <p className="muted small">{t('passport_collection_subtitle')}</p>
        </div>
        <div className="section-head-side">
          <label className="check"><input id="passport-show-hidden" type="checkbox" checked={mysteryState.showHiddenPassports} onChange={(event) => setShowHidden(event.target.checked)} />{t('passport_show_hidden')}</label>
          <Button id="passport-refresh-btn" variant="ghost" size="sm" onClick={() => loadPassportCollection()}><Icon name="refresh" size={14} />{t('passport_refresh')}</Button>
          <span className="muted small"><strong id="passport-collection-count" className="count-strong">{visible.length}</strong> {t('passport_stamps')}</span>
        </div>
      </header>
      <div id="passport-collection-grid" className="passport-grid" aria-live="polite">
        {visible.map((credential) => {
          let card;
          try { card = buildPassportShareCard(credential.share ?? credential, { origin: passportShareOrigin() }); } catch { return null; }
          const stamp = credential.stamp_type ?? card.stamp_type;
          return (
            <Card as="article" key={credential.credential_id} className={`passport-card passport-${stamp.toLowerCase()}`}>
              <div className="passport-card-art" aria-hidden="true">
                <span className="passport-card-symbol">{passportStampIcon(stamp)}</span>
                <span className="passport-card-artwork">{String(card.artwork_variant || 'DAWN')}</span>
              </div>
              <div className="passport-card-body">
                <div className="passport-card-heading">
                  <span className="stat-label">{`${passportStampIcon(stamp)} ${passportStampLabel(stamp)}`}</span>
                  <Badge tone={card.verified_reveal ? 'ok' : 'crit'}>{card.verified_reveal ? t('passport_verified') : t('passport_revoked')}</Badge>
                </div>
                <h3>{card.voyage_id}</h3>
                <p className="muted small">{`${card.cargo_category} · ${card.route_label}`}</p>
                <div className="passport-card-meta muted small">
                  <span>{`${t('passport_reveal_date')}: ${card.reveal_date || '—'}`}</span>
                  <code>{shortPassportDigest(card.credential_id)}</code>
                </div>
                <p className="muted small">{t('passport_fixed_disclaimer')}</p>
                <div className="button-row">
                  <Button variant="ghost" size="sm" data-focus-key={`passport-share:${credential.credential_id}`} onClick={() => openPassportShare(credential)}>{t('passport_share')}</Button>
                  <a className="btn btn-ghost btn-sm" href={card.verify_url} target="_blank" rel="noopener noreferrer">{t('passport_verify')}</a>
                  <Button variant="ghost" size="sm" onClick={() => togglePassportHidden(card.credential_id)}>{hidden.has(card.credential_id) ? t('passport_unhide') : t('passport_hide')}</Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      {!visible.length ? (
        <div id="passport-collection-empty">
          <Empty title={t('passport_empty_title')}>{t('passport_empty_body')}</Empty>
        </div>
      ) : null}
      <p className="muted small passport-disclaimer">{t('passport_fixed_disclaimer')}</p>
    </section>
  );
}

