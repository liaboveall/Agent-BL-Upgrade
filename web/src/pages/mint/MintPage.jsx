import { useEffect } from 'react';
import { useApp } from '../../state/hooks.js';
import { selectedQuote } from '../../state/app-store.js';
import { t, tData } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import { caseOptionLabel, cargoQuantity } from '../../lib/market.js';
import { scrollBehavior } from '../../lib/accessibility.js';
import { selectCase } from '../../state/controller.js';
import { Empty } from '../../components/ui.jsx';
import { Valuation } from './Valuation.jsx';
import { Waterfall } from './Waterfall.jsx';
import { MintPanel } from './MintPanel.jsx';
import { Documents } from './Documents.jsx';
import { Preferences } from './Preferences.jsx';
import { ProtocolEvidence } from './ProtocolEvidence.jsx';

export function MintPage() {
  const state = useApp((s) => s);
  const quote = selectedQuote(state);
  const bl = state.caseData?.bill_of_lading ?? {};
  const focusRequest = state.focusRequest;
  useEffect(() => {
    if (focusRequest?.target !== 'mint') return;
    const node = document.getElementById('waterfall');
    node?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    node?.focus({ preventScroll: true });
  }, [focusRequest]);

  const qty = cargoQuantity(bl);
  const strip = [
    [t('ds_route'), bl.port_of_loading && bl.port_of_discharge ? `${tData(bl.port_of_loading)} → ${tData(bl.port_of_discharge)}` : '—'],
    [t('ds_cargo'), bl.cargo ? `${tData(bl.cargo)}${qty ? ` · ${qty}` : ''}` : '—'],
    [t('ds_ebl'), bl.bl_id ? `${bl.bl_id}${bl.ebl_platform ? ` · ${bl.ebl_platform}` : ''}` : '—'],
    [t('ds_declared'), bl.declared_value_usd ? f.usd(bl.declared_value_usd) : '—'],
    [t('ds_collateral'), quote ? f.usd(quote.ai_verified_collateral_value_usd) : '—']
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
            {state.cases.map((entry) => <option key={entry.case_id} value={entry.case_id}>{caseOptionLabel(state, entry)}</option>)}
          </select>
        </div>
      </header>

      <dl className="deal-strip" aria-label={t('mint_strip_label')}>
        {strip.map(([label, value]) => (
          <div key={label} className="deal-strip-item"><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>

      {!quote ? <Empty title={t('market_detail_loading')} /> : (
        <>
          <div className="mint-layout">
            <div className="mint-main">
              <Valuation quote={quote} />
              <Waterfall quote={quote} />
            </div>
            <aside className="mint-aside" aria-label={t('p3_h')}>
              <MintPanel quote={quote} />
            </aside>
          </div>
          <div className="mint-secondary">
            <Documents />
            <div className="mint-secondary-side">
              <Preferences />
              <ProtocolEvidence quote={quote} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
