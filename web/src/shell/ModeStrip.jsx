import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/hooks.js';
import { t } from '../lib/i18n.js';
import { resetDemo, toggleRuntimeMode } from '../state/controller.js';

/** The Demo / Live boundary, always visible under the top bar. */
export function ModeStrip() {
  const demoMode = useApp((state) => state.demoMode);
  const liveAvailable = useApp((state) => state.liveAvailable);
  const chainReal = useApp((state) => state.chainReal);
  const networkName = useApp((state) => state.networkName);
  const [confirming, setConfirming] = useState(false);
  const confirmButton = useRef(null);
  const resetButton = useRef(null);
  // Live is a server setting, not something a visitor can turn on: say so instead of offering a control that only fails.
  const liveUnavailable = demoMode && !liveAvailable;

  const refocusReset = useRef(false);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (refocusReset.current) { refocusReset.current = false; resetButton.current?.focus(); }
  }, [confirming]);
  useEffect(() => { if (!demoMode) setConfirming(false); }, [demoMode]);
  const cancel = () => { refocusReset.current = true; setConfirming(false); };

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
            disabled={liveUnavailable}
            aria-describedby={liveUnavailable ? 'mode-unavailable' : undefined}
          >
            {demoMode ? t('switch_to_live') : t('switch_to_demo')}
          </button>
          {liveUnavailable ? <span id="mode-unavailable" className="mode-note muted">{t('live_unavailable_short')}</span> : null}
          {confirming ? (
            <span className="mode-confirm" role="group" aria-label={t('demo_reset')} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); cancel(); } }}>
              <span>{t('demo_reset_confirm')}</span>
              <button ref={confirmButton} type="button" className="link-btn is-danger" onClick={() => { setConfirming(false); resetDemo(); }}>{t('demo_reset_yes')}</button>
              <button type="button" className="link-btn" onClick={cancel}>{t('demo_reset_cancel')}</button>
            </span>
          ) : (
            <button id="demo-reset-btn" ref={resetButton} type="button" className="link-btn" onClick={() => setConfirming(true)} disabled={!demoMode}>
              {t('demo_reset')}
            </button>
          )}
        </span>
      </div>
    </section>
  );
}
