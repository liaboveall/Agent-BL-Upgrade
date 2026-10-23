import { useEffect } from 'react';
import { useApp, useLang } from './state/hooks.js';
import { t } from './lib/i18n.js';
import { TopBar } from './shell/TopBar.jsx';
import { ModeStrip } from './shell/ModeStrip.jsx';
import { Toast } from './components/Toast.jsx';
import { AppDialogs } from './components/AppDialogs.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
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

function FinanceIntro() {
  const zh = useLang() === 'zh';
  return <header className="finance-intro">
    <p className="eyebrow">{zh ? '贸易融资研究 · 测试代币' : 'Trade finance research · test assets'}</p>
    <h1>{zh ? '从单证到融资，再到资金退出' : 'From title to financing and cash exit'}</h1>
    <p>{zh ? '铜货物 · Singapore → Shanghai。研究签发、研究估值与虚构主体；本金和目标回报均可能损失。' : 'Copper · Singapore → Shanghai. Research issuance, research valuation and fictional parties; principal and target returns may be lost.'}</p>
    <ol className="finance-journey">
      <li><strong>{zh ? '融资方' : 'Borrower'}</strong><span>{zh ? '提交材料 → 持有人同意 → 固定条款' : 'Submit materials → holder consent → fixed terms'}</span></li>
      <li><strong>{zh ? '审查角色' : 'Reviewers'}</strong><span>{zh ? '独立双审 → 估值与资格 → 发行' : 'Independent review → valuation and eligibility → issuance'}</span></li>
      <li><strong>{zh ? '出资人' : 'Investor'}</strong><span>{zh ? '阅读条款 → 钱包认购 → 自行退款或领取' : 'Read terms → subscribe with wallet → refund or claim'}</span></li>
    </ol>
    <p className="small muted">{zh ? '报告服务的 x402 付款只购买报告，不进入融资池，也不取得融资份额。真实手机钱包签名不在本次交付范围内，未经验证。' : 'An x402 payment buys a report; it does not fund a pool or purchase shares. Real mobile wallet signing is outside this delivery and has not been verified.'}</p>
  </header>;
}
const PAGES = { finance: FinanceIntro, market: MarketPage, mint: MintPage, agent: AgentPage, discover: DiscoverPage };

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
              {view === name ? <ErrorBoundary key={name}><Page /></ErrorBoundary> : null}
            </section>
          );
        })}
        <ErrorBoundary><ControlledFinancePanel primary={view === 'finance'} /></ErrorBoundary>
        <details className="research-tools">
          <summary>{lang === 'zh' ? '研究工具、证据与运行状态' : 'Research tools, evidence and operations'}</summary>
          <ErrorBoundary>
            <RightsPanel />
            <EvidencePanel />
            <OperationsPanel />
          </ErrorBoundary>
        </details>
      </main>
      <footer className="page-foot">
        <span>{t('footer_left')}</span>
        <span className="muted">{t('footer_right')}</span>
      </footer>
      <DealDialog />
      <CopilotLauncher />
      <AppDialogs />
      <Toast />
    </div>
  );
}
