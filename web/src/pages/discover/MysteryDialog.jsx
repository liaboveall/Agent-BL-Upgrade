import { useStore } from '../../state/hooks.js';
import { t, tData } from '../../lib/i18n.js';
import { cargoImage, shortRoute, stripParens } from '../../lib/market.js';
import { scrollBehavior } from '../../lib/accessibility.js';
import { Badge, Button, Dialog, DialogHeader, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import {
  MYSTERY_STEPS, claimPassport, closeMysteryModal, editProof, formatPct, formatUsd, mysteryState, mysteryStore, openMysteryVoyage,
  openSubscriptionConfirmation, paymentEvidence, resetProof, riskFactorSegments, shortHash, tierMeta
} from './mystery.js';

const STEP_TEXT = {
  commit: ['mystery_step_commit', 'mystery_step_commit_desc'],
  challenge: ['mystery_step_402', 'mystery_step_402_desc'],
  settlement: ['mystery_step_settlement', 'mystery_step_settlement_desc'],
  reveal: ['mystery_step_reveal', 'mystery_step_reveal_desc'],
  verify: ['mystery_step_verify', 'mystery_step_verify_desc']
};

function Stepper() {
  return (
    <ol id="mystery-stepper" className="x402-flow mystery-stepper" aria-label={t('a11y_mystery_progress')}>
      {MYSTERY_STEPS.map((name, index) => {
        const step = mysteryState.steps[name];
        return (
          <li key={name} id={`mystery-step-${name}`} className={cx('x402-step', step.status !== 'pending' && `is-${step.status}`)} title={t(STEP_TEXT[name][1])}>
            <span className="x402-step-num">{step.status === 'done' ? <Icon name="check" size={14} /> : index + 1}</span>
            <span className="x402-step-body"><strong>{t(STEP_TEXT[name][0])}</strong><span className="sr-only">{t(STEP_TEXT[name][1])}</span></span>
            <span className="x402-step-status">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function PreOpen() {
  const preview = mysteryState.preview;
  const meta = tierMeta();
  const motion = mysteryState.boxMotion;
  return (
    <section id="mystery-preopen" className={cx('mystery-preopen', motion !== 'idle' && `is-${motion}`)} aria-busy={motion === 'unlocking' || undefined}>
      <div id="mystery-box-stage" className="mystery-box-stage" aria-hidden="true">
        <div className="mystery-blind-box">
          <div className="mystery-blind-box-lid"><span /></div>
          <div className="mystery-blind-box-body">
            <span className="mystery-box-route-line" />
            <span className="mystery-box-question">?</span>
            <span className="mystery-box-seal">M</span>
          </div>
        </div>
        <div className="mystery-box-sparks"><span /><span /><span /><span /><span /><span /></div>
      </div>
      <div className="mystery-preopen-head">
        <div>
          <span className="stat-label">{t('mystery_round_frozen')}</span>
          <h3><span id="mystery-candidate-count">{preview?.candidate_count ?? '—'}</span> {t('mystery_routes')}</h3>
        </div>
        <Badge tone="info">{preview ? t('mystery_equal_odds', { n: preview.candidate_count }) : '—'}</Badge>
      </div>
      <div className="kv-grid kv-grid-4">
        <div className="kv"><span className="kv-label">{t('mystery_risk_boundary')}</span><span className="kv-value">{`0–${meta.riskBps.toLocaleString()} bps`}</span></div>
        <div className="kv"><span className="kv-label">{t('mystery_yield_range')}</span><span className="kv-value">{meta.yieldRange}</span></div>
        <div className="kv"><span className="kv-label">{t('mystery_stress_cap')}</span><span className="kv-value">{`5%–${formatPct(meta.stressLossPct)}`}</span></div>
        <div className="kv"><span className="kv-label">{t('mystery_price')}</span><span className="kv-value">0.001 USDC</span></div>
      </div>
      <div className="commit-evidence">
        <div><span className="kv-label">{t('mystery_server_commitment')}</span><code id="mystery-server-commitment">{shortHash(preview?.server_commitment, 16, 10)}</code></div>
        <div><span className="kv-label">{t('mystery_candidate_hash')}</span><code id="mystery-candidate-hash">{shortHash(preview?.candidate_set_hash, 16, 10)}</code></div>
      </div>
      <p className="notice">{t('mystery_non_subscription')}</p>
      <div className="button-row">
        <Button id="mystery-open-btn" variant="primary" disabled={mysteryState.busy.open} onClick={openMysteryVoyage}>{t('mystery_open_btn')}</Button>
        <span id="mystery-payment-note" className={cx('small', mysteryState.paymentNote.tone === 'crit' ? 'text-crit' : 'muted')} aria-live="polite">{mysteryState.paymentNote.text}</span>
      </div>
    </section>
  );
}

function Reveal() {
  const report = mysteryState.report;
  const cargo = report?.cargo ?? {};
  const risk = report?.risk ?? {};
  const phase = mysteryState.reveal;
  const from = stripParens(tData(cargo.port_of_loading || '—')), to = stripParens(tData(cargo.port_of_discharge || '—'));
  const sameSite = from === to;
  return (
    <section id="mystery-reveal" className={cx('mystery-reveal', phase === 'opening' && 'is-opening', phase === 'open' && 'is-opening is-open')} hidden={phase === 'hidden'}>
      <div className="mystery-container-scene" aria-hidden="true">
        <div className="mystery-reveal-burst"><span /><span /><span /><span /><span /><span /></div>
        <div className="mystery-container">
          <div className="mystery-container-door door-left"><span>AGENTBL</span></div>
          <div className="mystery-container-door door-right"><span>SEALED</span></div>
          <div className="mystery-container-cargo"><img id="mystery-cargo-image" src={report ? cargoImage(cargo.category) : undefined} alt={tData(cargo.category || t('mystery_trade_cargo'))} /></div>
        </div>
        <div className="mystery-seal">M</div>
      </div>
      <div className="mystery-route-reveal">
        <div className="mystery-route-heading">
          <div><span className="stat-label">{t('mystery_selected_route')}</span><h3 id="mystery-cargo-name">{tData(cargo.category || t('mystery_trade_cargo'))}</h3></div>
          <Badge tone={risk.level === 'LOW' ? 'ok' : ['HIGH', 'CRITICAL'].includes(risk.level) ? 'crit' : 'warn'} className="risk-pulse">{`${risk.level ?? '—'} · ${Number(risk.score_bps ?? 0).toLocaleString()} bps`}</Badge>
        </div>
        {/* A warehouse receipt starts and ends at the same site: show it once instead of a departure and an arrival that are the same place. */}
        <div className={cx('mystery-map-route', sameSite && 'is-single')}>
          <div><span>{t(sameSite ? 'mystery_site' : 'vp_dep')}</span><strong id="mystery-port-from">{from}</strong></div>
          <div className="mystery-route-line" hidden={sameSite}><span className="mystery-route-ship" aria-hidden="true">◆</span></div>
          <div hidden={sameSite}><span>{t('vp_arr')}</span><strong id="mystery-port-to">{to}</strong></div>
        </div>
      </div>
    </section>
  );
}

function RiskPassport() {
  const report = mysteryState.report;
  if (!report || mysteryState.reveal === 'hidden') return null;
  const cargo = report.cargo ?? {}, pricing = report.pricing ?? {}, risk = report.risk ?? {}, suitability = report.suitability ?? {};
  const evidence = paymentEvidence(report);
  const reasons = suitability.reasons?.length ? suitability.reasons.map(tData) : [t('mystery_no_match_reason')];
  const factors = risk.factors?.length ? risk.factors : null;
  return (
    <section id="mystery-risk-passport" className="mystery-section">
      <div className="mystery-section-head">
        <div><span className="stat-label">AI Risk Passport</span><h3 id="mystery-report-route">{shortRoute(cargo)}</h3></div>
        <Badge tone={suitability.matched ? 'ok' : 'crit'}>{suitability.matched ? t('mystery_passport_match') : t('mystery_passport_mismatch')}</Badge>
      </div>
      <div className="kv-grid kv-grid-3">
        <div className="kv"><span className="kv-label">{t('market_issue_price')}</span><span className="kv-value">{formatUsd(pricing.issue_price_usd, 3)}</span></div>
        <div className="kv"><span className="kv-label">{t('market_detail_upside')}</span><span className="kv-value">{`${(Number(pricing.implied_gross_yield_bps ?? 0) / 100).toFixed(2)}%`}</span></div>
        <div className="kv"><span className="kv-label">{t('mystery_stress_recovery')}</span><span className="kv-value">{formatUsd(risk.stress_recovery_per_token_usd, 3)}</span></div>
        <div className="kv"><span className="kv-label">{t('mystery_collateral_coverage')}</span><span className="kv-value">{`${Number(report.collateral?.coverage_ratio ?? 0).toFixed(2)}x`}</span></div>
        <div className="kv"><span className="kv-label">{t('mystery_evidence_freshness')}</span><span className="kv-value">{`${report.evidence_freshness?.status ?? '—'} · ${Number(report.evidence_freshness?.age_seconds ?? 0).toFixed(0)}s`}</span></div>
        <div className="kv"><span className="kv-label">{t('mystery_payment_evidence')}</span><span className="kv-value" id="mystery-report-payment">{evidence.href ? <a href={evidence.href} target="_blank" rel="noopener noreferrer">{evidence.text}</a> : evidence.text}</span></div>
      </div>
      <div className="two-col">
        <div><h4 className="sub-title">{t('mystery_match_reasons')}</h4><ul className="bullets" id="mystery-report-reasons">{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>
        <div>
          <h4 className="sub-title">{t('mystery_risk_factors')}</h4>
          <ul className="bullets" id="mystery-report-risks">
            {factors ? factors.map((factor, index) => (
              <li key={index}>{riskFactorSegments(factor).map((part, partIndex) => (part.source ? <span key={partIndex} data-source-document-field={part.source}>{part.text}</span> : part.text))}</li>
            )) : <li>{t('mystery_no_risk_factor')}</li>}
          </ul>
        </div>
      </div>
      <p className="notice" id="mystery-non-guarantee">{report.non_guarantee_notice || t('mystery_non_guarantee')}</p>
    </section>
  );
}

function ProofTool() {
  if (!mysteryState.canonicalProof) return null;
  const result = mysteryState.proofResult;
  const statusClass = !result || result.checking ? 'checking' : result.valid ? 'valid' : 'failed';
  const statusText = !result || result.checking ? t('mystery_verifying') : result.valid ? t('mystery_proof_valid') : t('mystery_proof_failed');
  return (
    <section id="mystery-proof-tool" className="mystery-section proof-tool">
      <div className="mystery-section-head">
        <div><span className="stat-label">{t('mystery_local_verifier')}</span><h3>{t('mystery_verifier_title')}</h3></div>
        <span id="mystery-proof-status" className={`proof-status ${statusClass}`}>{statusText}</span>
      </div>
      <textarea id="mystery-proof-json" className="code-area" spellCheck={false} aria-label={t('mystery_verifier_title')} value={mysteryState.proofText} onChange={(event) => editProof(event.target.value)} />
      <div className="button-row end"><Button id="mystery-proof-reset" variant="ghost" size="sm" onClick={resetProof}>{t('mystery_reset_proof')}</Button></div>
      <div id="mystery-proof-summary" className="proof-summary" aria-live="polite">
        {result && !result.checking && !result.valid ? result.errors.map((error, index) => <div key={index} className="proof-error">{error}</div>) : null}
        {result?.valid ? [
          [t('mystery_selected_pool'), result.summary.selected_pool_id],
          [t('mystery_candidate_count'), result.summary.candidate_count],
          [t('mystery_selection_hash'), shortHash(result.summary.selection_hash, 16, 10)],
          [t('mystery_proof_hash'), shortHash(result.summary.reveal_proof_hash, 16, 10)],
          [t('mystery_payment_binding'), shortHash(result.summary.payment_tx_hash, 16, 10)]
        ].map(([label, value]) => <div key={label}><span className="kv-label">{label}</span><strong>{String(value)}</strong></div>) : null}
      </div>
    </section>
  );
}

function PostActions() {
  if (!mysteryState.report || mysteryState.reveal === 'hidden') return null;
  const valid = mysteryState.proofValid;
  const busy = mysteryState.busy;
  return (
    <div id="mystery-post-actions" className="mystery-post-actions">
      <Button id="mystery-view-report-btn" variant="ghost" onClick={() => document.getElementById('mystery-risk-passport')?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })}>{t('mystery_view_report')}</Button>
      <Button id="mystery-claim-discovery-btn" variant="secondary" disabled={!valid || busy.DISCOVERY} onClick={() => claimPassport('DISCOVERY')}>
        {mysteryState.claimed.DISCOVERY ? t('passport_claimed') : t('passport_claim_discovery')}
      </Button>
      <Button id="mystery-subscribe-btn" variant="primary" disabled={!valid} onClick={openSubscriptionConfirmation}>{t('mystery_subscribe_selected')}</Button>
      <Button id="mystery-claim-journey-btn" variant="primary" hidden={!mysteryState.subscription} disabled={!valid || !mysteryState.subscription || busy.INVESTOR_JOURNEY} onClick={() => claimPassport('INVESTOR_JOURNEY')}>
        {mysteryState.claimed.INVESTOR_JOURNEY ? t('passport_claimed') : t('passport_claim_journey')}
      </Button>
    </div>
  );
}

export function MysteryDialog() {
  useStore(mysteryStore, (s) => s.version);
  return (
    <Dialog id="mystery-modal" open={mysteryState.modal} onClose={closeMysteryModal} labelledBy="mystery-modal-title" variant="wide" className="mystery-modal">
      <DialogHeader id="mystery-modal-title" title={t('mystery_modal_title')} subtitle={t('mystery_modal_subtitle')} onClose={closeMysteryModal} />
      <div className="dialog-body">
        <Stepper />
        {mysteryState.reveal !== 'open' ? <PreOpen /> : null}
        <Reveal />
        <RiskPassport />
        <ProofTool />
        <PostActions />
      </div>
    </Dialog>
  );
}
