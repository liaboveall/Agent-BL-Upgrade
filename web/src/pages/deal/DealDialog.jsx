// The project detail dialog: voyage + live pricing + in-transit simulation, the risk intelligence
// behind the price, and the paid x402 AI reports. Three tabs instead of one long scroll.
import { useEffect, useState } from 'react';
import { useApp } from '../../state/hooks.js';
import { t, tData } from '../../lib/i18n.js';
import { closeDeal } from '../../state/controller.js';
import { routeText, shortCargoName } from '../../lib/market.js';
import { Dialog, DialogHeader, useRovingKeys } from '../../components/ui.jsx';
import { VoyageTab } from './VoyageTab.jsx';
import { IntelTab } from './IntelTab.jsx';
import { ReportsTab } from './ReportsTab.jsx';

const TABS = ['voyage', 'intel', 'reports'];
const TAB_KEYS = { voyage: 'deal_tab_voyage', intel: 'deal_tab_intel', reports: 'deal_tab_reports' };

export function DealDialog() {
  const open = useApp((s) => s.dealOpen);
  const caseData = useApp((s) => s.caseData);
  const caseId = useApp((s) => s.caseId);
  const [tab, setTab] = useState('voyage');
  const { onKeyDown, choiceProps } = useRovingKeys(TABS, tab, setTab);
  useEffect(() => { if (open) setTab('voyage'); }, [open]);
  const bl = caseData?.bill_of_lading ?? {};
  return (
    <Dialog id="deal-detail-modal" open={open} onClose={closeDeal} labelledBy="modal-title" variant="wide" className="deal-dialog">
      <DialogHeader
        id="modal-title"
        title={caseData ? shortCargoName(tData(bl.cargo || caseId)) : t('modal_title')}
        subtitle={caseData ? `${routeText(bl)} · ${bl.bl_id || bl.bl_no || ''}` : t('modal_subtitle')}
        onClose={closeDeal}
      />
      <div className="tabs" role="tablist" aria-label={t('modal_title')} onKeyDown={onKeyDown}>
        {TABS.map((name, index) => (
          <button
            key={name}
            id={`deal-tab-${name}`}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-controls={`deal-panel-${name}`}
            className={`tab${tab === name ? ' is-active' : ''}`}
            onClick={() => setTab(name)}
            {...choiceProps(name, index)}
          >
            {t(TAB_KEYS[name])}
          </button>
        ))}
      </div>
      <div className="dialog-body deal-body">
        {caseData ? TABS.map((name) => (
          <section key={name} id={`deal-panel-${name}`} role="tabpanel" aria-labelledby={`deal-tab-${name}`} hidden={tab !== name} className={name === 'reports' ? 'view-intel' : undefined}>
            {name === 'voyage' ? <VoyageTab active={tab === 'voyage'} /> : null}
            {name === 'intel' && tab === 'intel' ? <IntelTab /> : null}
            {name === 'reports' && tab === 'reports' ? <ReportsTab /> : null}
          </section>
        )) : <p className="muted">{t('market_detail_loading')}</p>}
      </div>
    </Dialog>
  );
}
