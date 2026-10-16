import { useApp } from '../state/hooks.js';
import { t } from '../lib/i18n.js';
import { resetDemo, toggleRuntimeMode } from '../state/controller.js';

/** The Demo / Live boundary, always visible under the top bar. */
export function ModeStrip() {
  const demoMode = useApp((state) => state.demoMode);
  const liveAvailable = useApp((state) => state.liveAvailable);
  const chainReal = useApp((state) => state.chainReal);
  const networkName = useApp((state) => state.networkName);
  return (
    <section id="demo-banner" className={`mode-strip ${demoMode ? 'is-demo' : 'is-live'}`} aria-live="polite">
      <div className="mode-strip-inner">
        <span className="mode-pill"><span className="mode-dot" aria-hidden="true" />{demoMode ? 'DEMO' : 'LIVE'}</span>
        <span className="mode-copy">{demoMode ? t('demo_mode_copy') : t('live_mode_copy')}</span>
        <span className="mode-chain muted">{chainReal ? t('chain_deployed', { network: networkName }) : t('chain_not_deployed')}</span>
        <span className="mode-actions">
          <button
            id="mode-toggle-btn"
            type="button"
            className="link-btn"
            onClick={toggleRuntimeMode}
            title={liveAvailable || !demoMode ? undefined : t('live_config_required')}
          >
            {demoMode ? t('switch_to_live') : t('switch_to_demo')}
          </button>
          <button id="demo-reset-btn" type="button" className="link-btn" onClick={resetDemo} disabled={!demoMode}>
            {t('demo_reset')}
          </button>
        </span>
      </div>
    </section>
  );
}
