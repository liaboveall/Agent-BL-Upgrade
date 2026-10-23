import { useStore } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { formatTime } from '../../lib/agent-format.js';
import { Badge, Button, Card, CardHead, KV } from '../../components/ui.jsx';
import { agentStore, control } from './agent-store.js';
import { ModeBadge } from './badges.jsx';

const WATCHER_STATES = ['disabled', 'inactive', 'idle', 'healthy', 'catching-up', 'waiting-confirmations', 'degraded'];

function ChainWatcher({ status }) {
  const watcher = status.chain_watcher ?? { state: 'disabled' };
  const state = WATCHER_STATES.includes(watcher.state) ? watcher.state : 'idle';
  const tone = state === 'degraded' ? 'crit' : state === 'healthy' ? 'ok' : 'muted';
  return (
    <div className="chain-watcher" data-watcher-state={state} data-last-block={String(watcher.last_block ?? '')} data-chain-stop={String(Boolean(status.emergency_stop_sources?.chain))}>
      <KV label={t('ac_chain_watcher')}><Badge tone={tone}>{t(`ac_chain_${state}`)}</Badge></KV>
      {watcher.enabled && status.mode === 'live' ? (
        <>
          <KV label={t('ac_chain_progress')}>{t('ac_chain_progress_value', { block: watcher.last_block ?? '—', lag: watcher.lag_blocks ?? '—', confirmations: watcher.confirmations })}</KV>
          {watcher.retry_at ? <KV label={t('ac_chain_retry')}>{formatTime(watcher.retry_at)}</KV> : null}
          {watcher.reconciliation_required ? <p className="text-crit small" role="status">{t('ac_chain_reconcile')}</p> : null}
          {status.emergency_stop_sources?.chain ? <p className="text-crit small">{t('ac_chain_stop_hint')}</p> : null}
          {status.emergency_stop_sources?.chain_unknown ? <p className="muted small">{t('ac_chain_unknown_hint')}</p> : null}
        </>
      ) : null}
    </div>
  );
}

export function StatusCard() {
  const status = useStore(agentStore, (s) => s.status);
  const error = useStore(agentStore, (s) => s.error);
  if (!status) {
    return <Card id="ac-status" className="ac-status"><p className={error ? 'text-crit' : 'muted'}>{error ?? t('ac_loading')}</p></Card>;
  }
  const { autonomy } = status;
  return (
    <Card id="ac-status" className="ac-status" aria-labelledby="ac-status-h">
      <CardHead id="ac-status-h" title={t('ac_status_h')} level={2}>
        <Badge tone={status.running ? 'ok' : 'muted'}>{status.running ? t('ac_running') : t('ac_stopped')}</Badge>
      </CardHead>
      <div className="kv-grid kv-grid-3">
        <KV label={t('ac_mode')}>
          <span className="badge-row"><ModeBadge mode={status.mode} /><Badge tone={status.executor === 'chain' ? 'ok' : 'muted'} title={status.executor === 'chain' ? t('ac_exec_chain') : t('ac_exec_demo')}>{status.executor === 'chain' ? 'CHAIN' : 'SIM'}</Badge></span>
        </KV>
        <KV label={t('ac_autonomy')}>
          <span className="badge-row">{t(`ac_autonomy_${autonomy.effective}`)}{autonomy.downgraded ? <Badge tone="warn" title={t('ac_downgraded_hint')}>{t('ac_downgraded')}</Badge> : null}</span>
        </KV>
        <KV label={t('ac_monitor')}>{t('ac_monitor_value', { sec: status.scheduler.interval_sec })}</KV>
        <KV label={t('ac_last_tick')}>{status.scheduler.last_tick_at ? formatTime(status.scheduler.last_tick_at) : '—'}</KV>
        <KV label={t('ac_next_tick')}>{status.scheduler.next_tick_at ? formatTime(status.scheduler.next_tick_at) : '—'}</KV>
        <KV label={t('ac_queue')}>{t('ac_queue_value', { queued: status.queue.queued, processing: status.queue.processing, dead: status.queue.dead })}</KV>
        <KV label={t('ac_pending')}>{t('ac_pending_value', { pending: status.pending_approvals, owner: status.awaiting_owner_signature })}</KV>
        <KV label={t('ac_emergency')}>{status.emergency_stop ? <Badge tone="crit">{t('ac_emergency_on')}</Badge> : <Badge tone="muted">{t('ac_emergency_off')}</Badge>}</KV>
        <KV label={t('ac_signers')}>
          {Object.keys(status.signers ?? {}).length ? (
            <span className="badge-row">
              {Object.entries(status.signers).map(([role, info]) => <Badge key={role} tone={info.configured ? 'ok' : 'muted'}>{`${role} ${info.configured ? '✓' : '—'}`}</Badge>)}
            </span>
          ) : <span className="muted">{t('ac_signers_none')}</span>}
        </KV>
      </div>
      {status.last_error ? <p className="text-crit small">{`${t('ac_last_error')}: ${status.last_error.message}`}</p> : null}
      <ChainWatcher status={status} />
    </Card>
  );
}

export function ControlsCard() {
  const status = useStore(agentStore, (s) => s.status);
  const localStopped = status?.emergency_stop_sources?.local ?? status?.emergency_stop;
  return (
    <Card id="ac-controls" className="ac-controls" aria-labelledby="ac-controls-h">
      <CardHead id="ac-controls-h" title={t('ac_controls_h')} level={2} />
      <div className="button-row">
        <Button data-focus-key="control:running" onClick={() => control({ action: status?.running ? 'stop' : 'start' }, status?.running ? 'ac_stopped_toast' : 'ac_started_toast')}>
          {status?.running ? t('ac_stop') : t('ac_start')}
        </Button>
        <Button data-focus-key="control:tick" onClick={() => control({ action: 'tick' }, 'ac_tick_toast')}>{t('ac_tick')}</Button>
        <Button variant={localStopped ? 'danger' : 'danger-ghost'} data-focus-key="control:emergency"
          onClick={() => control({ action: 'emergency_stop', stopped: !localStopped }, localStopped ? 'ac_emergency_lifted' : 'ac_emergency_set')}>
          {localStopped ? t('ac_emergency_lift') : t('ac_emergency_stop')}
        </Button>
      </div>
      <label className="field" htmlFor="ac-autonomy">
        <span className="field-label">{t('ac_autonomy')}</span>
        <select id="ac-autonomy" className="select" value={status?.autonomy.effective ?? 'propose'} onChange={(event) => control({ action: 'set_autonomy', autonomy: event.target.value }, 'ac_autonomy_set')}>
          {['off', 'observe', 'propose', 'auto'].map((level) => <option key={level} value={level}>{t(`ac_autonomy_${level}`)}</option>)}
        </select>
      </label>
      <p className="muted small">{status?.mode === 'live' ? t('ac_live_note') : t('ac_demo_note')}</p>
    </Card>
  );
}
