import { useEffect, useRef } from 'react';
import { useApp } from '../../state/hooks.js';
import { findCase, quoteStaleReason, selectedQuote } from '../../state/app-store.js';
import { t, tData } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import { caseOptionLabel, cargoQuantity } from '../../lib/market.js';
import { scrollBehavior } from '../../lib/accessibility.js';
import { useStickyFit } from '../../hooks/useStickyFit.js';
import { retryCaseLoad, selectCase } from '../../state/controller.js';
import { Button, Card, Empty } from '../../components/ui.jsx';
import { Valuation } from './Valuation.jsx';
import { Waterfall } from './Waterfall.jsx';
import { MintPanel } from './MintPanel.jsx';
import { Documents, REVIEW_REQUEST, UPLOAD_REQUEST } from './Documents.jsx';
import { Preferences } from './Preferences.jsx';
import { ProtocolEvidence } from './ProtocolEvidence.jsx';

// The page is ordered by task: what is being priced and where to start (a public sample, my own documents, a held
// review), then the documents themselves, then the quote and why. Materials never wait for a quote: when pricing is
// down the upload card, the jobs and the constraints stay usable, and the failed step says so with a retry.
export function MintPage() {
  const state = useApp((s) => s);
  const quote = selectedQuote(state);
  const selected = findCase(state);
  const bl = state.caseData?.bill_of_lading ?? {};
  const focusRequest = state.focusRequest;
  const aside = useRef(null);
  useStickyFit(aside);
  useEffect(() => {
    if (focusRequest?.target !== 'mint') return;
    const node = document.getElementById('waterfall');
    node?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    node?.focus({ preventScroll: true });
  }, [focusRequest]);

  const qty = cargoQuantity(bl);
  // The declared value is the current material's; a collateral value from a quote of older material says so.
  const staleMaterial = quoteStaleReason(state) === 'material';
  const strip = [
    [t('ds_route'), bl.port_of_loading && bl.port_of_discharge ? `${tData(bl.port_of_loading)} → ${tData(bl.port_of_discharge)}` : '—'],
    [t('ds_cargo'), bl.cargo ? `${tData(bl.cargo)}${qty ? ` · ${qty}` : ''}` : '—'],
    [t('ds_ebl'), bl.bl_id ? `${bl.bl_id}${bl.ebl_platform ? ` · ${bl.ebl_platform}` : ''}` : '—'],
    [t('ds_declared'), bl.declared_value_usd ? f.usd(bl.declared_value_usd) : '—'],
    [t('ds_collateral'), quote ? `${f.usd(quote.ai_verified_collateral_value_usd)}${staleMaterial ? ` · ${t('ds_collateral_stale')}` : ''}` : '—']
  ];
  return (
    <div className="mint">
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">{t('hero_eyebrow')}</p>
          <h1>{t('hero_h1')}</h1>
          <p className="page-sub">{t('mint_subtitle_short')}</p>
        </div>
        <div className="case-picker">
          <label className="field-label" htmlFor="case-dropdown">{t('case_label')}</label>
          <select id="case-dropdown" className="select" value={state.caseId ?? ''} onChange={(event) => selectCase(event.target.value)}>
            {state.workspaceCases.length ? (
              <>
                <optgroup label={t('case_group_public')}>
                  {state.cases.map((entry) => <option key={entry.case_id} value={entry.case_id}>{caseOptionLabel(state, entry)}</option>)}
                </optgroup>
                <optgroup label={t('case_group_private')}>
                  {state.workspaceCases.map((entry) => <option key={entry.case_id} value={entry.case_id}>{`${t('case_private_tag')} · ${caseOptionLabel(state, entry)} · ${entry.case.bill_of_lading?.bl_id ?? entry.case_id}`}</option>)}
                </optgroup>
              </>
            ) : state.cases.map((entry) => <option key={entry.case_id} value={entry.case_id}>{caseOptionLabel(state, entry)}</option>)}
          </select>
        </div>
      </header>

      <StartBar selected={selected} />

      <dl className="deal-strip" aria-label={t('mint_strip_label')}>
        {strip.map(([label, value]) => (
          <div key={label} className="deal-strip-item"><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>

      <CaseLoadError />

      <div className="mint-layout">
        <div className="mint-main">
          <Documents />
          {quote ? (
            <>
              <Valuation quote={quote} />
              <Waterfall quote={quote} />
            </>
          ) : null}
        </div>
        <aside ref={aside} className="mint-aside" aria-label={t('p3_h')}>
          {quote ? <MintPanel quote={quote} /> : <QuotePending />}
        </aside>
      </div>
      <div className="mint-secondary">
        <Preferences />
        {quote ? <ProtocolEvidence quote={quote} /> : null}
      </div>
    </div>
  );
}

/** What is priced, and the three ways to start: a public sample, my own documents, a review that waits for me. */
function StartBar({ selected }) {
  const caseId = useApp((s) => s.caseId);
  const cases = useApp((s) => s.cases);
  const held = useApp((s) => s.intakeHeld);
  const uploadReady = useApp((s) => Boolean(s.workspaceCaseId));
  const useSample = () => {
    if (selected?.private && cases[0]) selectCase(selected.source_case_id && cases.some((entry) => entry.case_id === selected.source_case_id) ? selected.source_case_id : cases[0].case_id);
    document.getElementById('case-dropdown')?.focus();
  };
  return (
    <section className="mint-start" aria-labelledby="mint-start-h">
      <h2 id="mint-start-h" className="sr-only">{t('mint_start_h')}</h2>
      <p className="muted small quote-source" id="quote-source">{selected?.private
        ? t('quote_source_private', { id: selected.case_id, from: selected.source_case_id ? t('quote_source_from', { source: selected.source_case_id }) : '' })
        : t('quote_source_public', { id: caseId ?? '—' })}</p>
      <div className="mint-start-actions">
        <Button id="mint-start-sample" variant="secondary" size="sm" onClick={useSample}>{t('mint_start_sample')}</Button>
        <Button id="mint-start-upload" variant="primary" size="sm" disabled={!uploadReady} onClick={() => window.dispatchEvent(new Event(UPLOAD_REQUEST))}>{t('mint_start_upload')}</Button>
        {held > 0 ? <Button id="mint-start-review" variant="secondary" size="sm" onClick={() => window.dispatchEvent(new Event(REVIEW_REQUEST))}>{t('mint_start_review', { n: held })}</Button> : null}
      </div>
    </section>
  );
}

/** A step of loading the selected case failed: say which, keep saying it, and resume there on retry. */
function CaseLoadError() {
  const caseLoad = useApp((s) => s.caseLoad);
  const busy = useApp((s) => s.busy);
  if (!caseLoad) return null;
  return (
    <div className="callout tone-crit case-load-error" id="case-load-error" role="alert">
      <p><strong>{t(`case_load_${caseLoad.step}`)}</strong> {t('case_load_reason', { msg: caseLoad.message })}</p>
      <p className="muted small">{t(caseLoad.step === 'workspace' ? 'case_load_keeps_workspace' : 'case_load_keeps')}</p>
      <Button id="case-load-retry" variant="secondary" size="sm" disabled={busy} onClick={retryCaseLoad}>{t(busy ? 'case_load_retrying' : 'case_load_retry')}</Button>
    </div>
  );
}

/** The issuing panel's place while there is no quote: loading, or pointing at the failure above. */
function QuotePending() {
  const failed = useApp((s) => Boolean(s.caseLoad));
  return failed
    ? <Card className="mint-panel is-unavailable"><p className="muted">{t('case_load_no_quote')}</p></Card>
    : <Empty title={t('market_detail_loading')} />;
}
