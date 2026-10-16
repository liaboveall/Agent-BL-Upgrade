import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import * as f from '../../lib/format.js';
import * as web3 from '../../lib/web3.js';
import { Button, Card, CardHead, Disclosure, KV } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';

const RISK_NAMES = ['LOW', 'MEDIUM', 'WARNING', 'CRITICAL'];
const ACTION_NAMES = ['OPEN', 'OPEN_WARNING', 'REPRICE', 'PAUSE', 'FREEZE', 'LIQUIDATE', 'RESUME'];

/** The quote's on-chain anchors and the live protocol record: deployed contracts and recent PricingUpdated events. */
export function ProtocolEvidence({ quote }) {
  const networkKey = useApp((s) => s.networkKey);
  const [deployment, setDeployment] = useState(null);
  const [events, setEvents] = useState({ status: 'loading', items: [], error: null });

  const load = useCallback(async () => {
    setEvents({ status: 'loading', items: [], error: null });
    try {
      const info = await web3.protocolDeploymentInfo();
      setDeployment(info);
      const items = await web3.readPricingUpdatedEvents(5);
      setEvents({ status: 'done', items, error: null });
    } catch (error) {
      setEvents({ status: 'error', items: [], error: error.message });
    }
  }, []);
  useEffect(() => { load(); }, [load, networkKey]);

  return (
    <Card aria-labelledby="onchain-h" className="protocol-evidence">
      <CardHead id="onchain-h" title={t('onchain_h')} level={3} />
      <div className="kv-stack">
        <KV label="quote_hash" mono><span id="quote-hash" title={quote.quote_hash || ''}>{f.shortHash(quote.quote_hash, 14, 8)}</span></KV>
        <KV label="evidence_hash" mono><span id="evidence-hash" title={quote.evidence_hash || ''}>{f.shortHash(quote.evidence_hash, 14, 8)}</span></KV>
      </div>
      <Disclosure summary={t('protocol_evidence_h')} id="protocol-proof">
        <p className="muted small" id="protocol-access-model">
          {!deployment ? t('protocol_loading_deployment')
            : deployment.accessModel === 'permissionless' ? t('protocol_permissionless', { network: deployment.displayName }) : t('protocol_compliance', { network: deployment.displayName })}
        </p>
        {deployment ? (
          <ul className="contract-list" id="protocol-contracts">
            {Object.entries(deployment.contracts).map(([name, address]) => (
              <li key={name}>
                <span>{name}</span>
                <a href={`${deployment.explorerBase}/address/${address}`} target="_blank" rel="noopener noreferrer" className="mono">{`${address.slice(0, 8)}…${address.slice(-6)} ↗`}</a>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="events-head">
          <span className="stat-label">PricingUpdated</span>
          <Button id="protocol-refresh-btn" variant="ghost" size="sm" onClick={load}><Icon name="refresh" size={14} />{t('protocol_refresh')}</Button>
        </div>
        <div id="pricing-events" aria-live="polite">
          {events.status === 'loading' ? <p className="muted small">{t('protocol_loading_events')}</p> : null}
          {events.status === 'error' ? <p className="muted small">{t('protocol_events_unavailable', { msg: events.error })}</p> : null}
          {events.status === 'done' && !events.items.length ? <p className="muted small">{t('protocol_no_events')}</p> : null}
          {events.items.map((event) => (
            <div key={`${event.txHash}-${event.poolId}`} className="pricing-event">
              <div className="pricing-event-head">
                <strong>{t('protocol_event_pool', { pool: event.poolId })}</strong>
                <a href={event.explorerUrl} target="_blank" rel="noopener noreferrer" className="mono">{`${f.shortHash(event.txHash, 8, 6)} ↗`}</a>
              </div>
              <span>{`$${event.issuePriceUsd.toFixed(4)} · ${RISK_NAMES[event.riskLevel] ?? event.riskLevel} · ${ACTION_NAMES[event.action] ?? event.action}`}</span>
              <code className="mono small" title={event.evidenceHash}>{`evidence ${f.shortHash(event.evidenceHash, 9, 7)}`}</code>
            </div>
          ))}
        </div>
      </Disclosure>
    </Card>
  );
}
