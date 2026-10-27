import { useApp } from '../state/hooks.js';
import { t, toggleLang } from '../lib/i18n.js';
import { changeNetwork, setView, VIEWS } from '../state/controller.js';
import { useRovingKeys } from '../components/ui.jsx';
import { WalletMenu } from './WalletMenu.jsx';

const NAV_KEYS = { finance: 'nav_finance', market: 'nav_market', mint: 'nav_mint', agent: 'nav_agent', discover: 'nav_discover' };

export function TopBar() {
  const view = useApp((state) => state.view);
  // Arrow keys move the selection without piling up history entries; a click is a real navigation.
  const { onKeyDown, choiceProps } = useRovingKeys(VIEWS, view, (name) => setView(name, { history: 'replace' }));
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#/finance" onClick={(event) => { event.preventDefault(); setView('finance'); }}>
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22"><rect width="24" height="24" rx="6" fill="currentColor" /><path d="M6 15.5 12 6l6 9.5H6Z" fill="#fff" /></svg>
          </span>
          <span className="brand-text">
            <strong>AgentBL</strong>
          </span>
        </a>
        <nav className="nav" role="tablist" aria-label={t('a11y_views')} onKeyDown={onKeyDown}>
          {VIEWS.map((name, index) => (
            <button
              key={name}
              id={`tab-${name}`}
              type="button"
              role="tab"
              aria-selected={view === name}
              aria-controls={`view-${name}`}
              className={`nav-tab${view === name ? ' is-active' : ''}`}
              onClick={() => setView(name)}
              {...choiceProps(name, index)}
            >
              {t(NAV_KEYS[name])}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <NetworkSelect />
          <button type="button" className="btn btn-ghost btn-sm lang-btn" onClick={toggleLang} title={t('lang_btn_title')}>
            {t('lang_switch_to')}
          </button>
          <WalletMenu />
        </div>
      </div>
    </header>
  );
}

/** The protocol network. On a phone it lives in the expandable mode strip instead of the top bar. */
export function NetworkSelect({ className = '' }) {
  const networks = useApp((state) => state.networks);
  const networkKey = useApp((state) => state.networkKey);
  const wallet = useApp((state) => state.wallet);
  if (!networks.length) return null;
  return (
    <select
      className={`select select-sm network-select ${className}`.trim()}
      aria-label={t('a11y_network')}
      value={networkKey ?? ''}
      disabled={Boolean(wallet?.address)}
      title={wallet?.address ? t('network_locked_hint') : undefined}
      onChange={(event) => changeNetwork(event.target.value)}
    >
      {networks.map((network) => (
        <option key={network.key} value={network.key}>
          {network.displayName}{network.deployed ? '' : ` · ${t('network_not_deployed')}`}
        </option>
      ))}
    </select>
  );
}
