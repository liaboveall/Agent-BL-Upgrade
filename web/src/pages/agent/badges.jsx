import { t } from '../../lib/i18n.js';
import { STATUS_TONE, VERDICT_TONE, labelFor } from '../../lib/agent-format.js';
import { Badge } from '../../components/ui.jsx';

export function StatusBadge({ status }) {
  return <Badge tone={STATUS_TONE[status] ?? 'muted'}>{labelFor('ac_status_', status)}</Badge>;
}

export function VerdictBadge({ verdict }) {
  return <Badge tone={VERDICT_TONE[verdict] ?? 'muted'}>{labelFor('ac_verdict_', verdict)}</Badge>;
}

export function ModeBadge({ mode }) {
  return <Badge tone={mode === 'live' ? 'ok' : 'muted'}>{String(mode ?? '').toUpperCase()}</Badge>;
}

export function SimulatedBadge() {
  return <Badge tone="warn" title={t('ac_simulated_hint')}>{t('ac_simulated')}</Badge>;
}
