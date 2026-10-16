import { useStore } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { Button, Dialog, DialogHeader, Field } from '../../components/ui.jsx';
import {
  closeSubscriptionConfirmation, confirmSubscription, confirmationAuthorized, formatUsd, mysteryState, mysteryStore, updateConfirmation
} from './mystery.js';

/** The independent second signature: subscribing to the revealed RWA is never part of the reveal payment. */
export function SubscribeDialog() {
  useStore(mysteryStore, (s) => s.version);
  const report = mysteryState.report;
  const { amount, ack, result, tone } = mysteryState.confirm;
  const loss = Number(amount) * Number(report?.risk?.stress_loss_pct ?? 1);
  return (
    <Dialog id="mystery-subscribe-modal" open={mysteryState.subscribeOpen} onClose={closeSubscriptionConfirmation} labelledBy="mystery-subscribe-title" className="mystery-subscribe-modal">
      <DialogHeader id="mystery-subscribe-title" title={t('mystery_second_confirmation')} onClose={closeSubscriptionConfirmation} />
      <form id="mystery-subscribe-form" className="dialog-body form-stack" noValidate onSubmit={(event) => { event.preventDefault(); confirmSubscription(); }}>
        <div className="kv-grid kv-grid-3">
          <div className="kv"><span className="kv-label">{t('mystery_selected_pool')}</span><span className="kv-value" id="mystery-confirm-pool">{String(report?.selected_pool_id ?? '—')}</span></div>
          <div className="kv"><span className="kv-label">{t('market_detail_risk')}</span><span className="kv-value" id="mystery-confirm-risk">{`${report?.risk?.level ?? '—'} · ${Number(report?.risk?.score_bps ?? 0).toLocaleString()} bps`}</span></div>
          <div className="kv"><span className="kv-label">{t('mystery_max_stress_loss')}</span><span className="kv-value" id="mystery-confirm-loss">{formatUsd(loss, 0)}</span></div>
        </div>
        <Field label={t('mystery_amount_label')} htmlFor="mystery-subscribe-amount">
          <input id="mystery-subscribe-amount" className="input" type="number" min="1" step="100" inputMode="decimal" value={amount} onChange={(event) => updateConfirmation({ amount: event.target.value })} />
        </Field>
        <label className="ack">
          <input id="mystery-risk-ack" type="checkbox" checked={ack} onChange={(event) => updateConfirmation({ ack: event.target.checked })} />
          <span>{t('mystery_risk_ack')}</span>
        </label>
        <p id="mystery-subscribe-result" className={tone === 'ok' ? 'text-ok' : tone === 'crit' ? 'text-crit' : 'muted'} aria-live="polite">{result}</p>
        <Button id="mystery-confirm-subscribe" type="submit" variant="primary" disabled={!confirmationAuthorized() || mysteryState.busy.subscribe}>{t('mystery_confirm_subscribe')}</Button>
      </form>
    </Dialog>
  );
}
