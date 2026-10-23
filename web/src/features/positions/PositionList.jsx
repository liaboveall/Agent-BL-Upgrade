import { useState } from 'react';
import { t } from '../../lib/i18n.js';
import { claimPosition } from '../../lib/web3.js';
import { askConfirm } from '../../lib/dialogs.js';
import { useApp } from '../../state/hooks.js';
import { getAppState } from '../../state/app-store.js';
import { Button } from '../../components/ui.jsx';

function atomic(value) {
  if (value == null) return '—';
  const amount = BigInt(value), whole = amount / 1_000_000n, fraction = String(amount % 1_000_000n).padStart(6, '0');
  return `${whole}.${fraction}`;
}

export function PositionList({ positions = [], onRefresh = () => {} }) {
  const demoMode = useApp((state) => state.demoMode);
  const [busy, setBusy] = useState(null), [message, setMessage] = useState(''), [receipt, setReceipt] = useState(null);
  const claim = async (position) => {
    if (busy || !await askConfirm({ title: t('position_claim'), body: t('position_claim_confirm'), confirmLabel: t('position_claim') })) return;
    const wallet = getAppState().wallet?.address, generation = getAppState().modeGeneration;
    setBusy(position.position_id); setMessage(''); setReceipt(null);
    try {
      const result = await claimPosition(position, { assertCurrent: () => {
        if (getAppState().wallet?.address !== wallet || getAppState().modeGeneration !== generation || getAppState().demoMode) throw new Error(t('cp_wallet_changed'));
      } });
      setReceipt(result);
      await onRefresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(null); }
  };
  if (!positions.length) return null;
  return (
    <section className="live-positions" aria-label={t('position_live')}>
      <h3>{t('position_live')}</h3>
      <ul className="holding-list">
        {positions.map((position) => (
          <li className="holding" key={position.position_id ?? `${position.protocol_instance.pool_address}:${position.chain_pool_id}`}>
            <div className="holding-head"><strong>Live · #{position.chain_pool_id}</strong><span>{t(`position_${position.status}`)}</span></div>
            <p className="mono small position-address">{t('position_pool')}: {position.protocol_instance.chain_id} · v{position.protocol_instance.protocol_version} · {position.protocol_instance.pool_address}</p>
            <p className="mono small position-address">{t('position_asset')}: {position.asset}</p>
            <dl className="position-values">
              <div><dt>{t('position_shares')}</dt><dd>{position.shares}</dd></div>
              <div><dt>{t('position_cost')}</dt><dd>{atomic(position.cost_atomic)}</dd></div>
              <div><dt>{t('position_claimable')}</dt><dd>{atomic(position.claimable_atomic)}</dd></div>
              <div><dt>{t('position_claimed')}</dt><dd>{atomic(position.claimed_atomic)}</dd></div>
            </dl>
            {position.reconciled && BigInt(position.shares) > 0n && ['Repaid', 'LossSettled'].includes(position.chain_state)
              ? <Button disabled={Boolean(busy) || demoMode} onClick={() => claim(position)}>{t(busy === position.position_id ? 'position_busy' : 'position_claim')}</Button> : null}
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite">{message}</p>
      {receipt ? <a href={receipt.explorerUrl} target="_blank" rel="noreferrer">{t('position_receipt')}: {receipt.txHash}</a> : null}
    </section>
  );
}
