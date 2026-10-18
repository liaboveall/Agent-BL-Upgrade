import { useEffect } from 'react';
import { useApp, useLang } from './state/hooks.js';
import { t } from './lib/i18n.js';
import { TopBar } from './shell/TopBar.jsx';
import { ModeStrip } from './shell/ModeStrip.jsx';
import { Toast } from './components/Toast.jsx';
import { MarketPage } from './pages/market/MarketPage.jsx';
import { MintPage } from './pages/mint/MintPage.jsx';
import { AgentPage } from './pages/agent/AgentPage.jsx';
import { DiscoverPage } from './pages/discover/DiscoverPage.jsx';
import { DealDialog } from './pages/deal/DealDialog.jsx';
import { CopilotLauncher } from './features/copilot/CopilotLauncher.jsx';
import { VIEWS } from './state/controller.js';
import { RightsPanel } from './features/rights/RightsPanel.jsx';
import { EvidencePanel } from './features/evidence/EvidencePanel.jsx';
import { OperationsPanel } from './features/operations/OperationsPanel.jsx';
import { ControlledFinancePanel } from './features/rights/ControlledFinancePanel.jsx';

const PAGES = { market: MarketPage, mint: MintPage, agent: AgentPage, discover: DiscoverPage };

export function App() {
  const lang = useLang();
  const view = useApp((state) => state.view);
  const busy = useApp((state) => state.busy);

  useEffect(() => {
    document.title = t('document_title');
  }, [lang]);

  return (
    <div className="app" data-lang={lang}>
      <a className="skip-link" href="#main-content">{t('a11y_skip')}</a>
      <div className="app-header">
        <TopBar />
        <ModeStrip />
        <div className={`busy-bar${busy ? ' is-busy' : ''}`} aria-hidden="true" />
      </div>
      <main id="main-content" className="page" tabIndex={-1} aria-busy={busy || undefined}>
        {VIEWS.map((name) => {
          const Page = PAGES[name];
          return (
            <section key={name} id={`view-${name}`} role="tabpanel" aria-labelledby={`tab-${name}`} hidden={view !== name} className="view">
              {view === name ? <Page /> : null}
            </section>
          );
        })}
      </main>
      <RightsPanel />
      <ControlledFinancePanel />
      <EvidencePanel />
      <OperationsPanel />
      <footer className="page-foot">
        <span>{t('footer_left')}</span>
        <span className="muted">{t('footer_right')}</span>
      </footer>
      <DealDialog />
      <CopilotLauncher />
      <Toast />
    </div>
  );
}
