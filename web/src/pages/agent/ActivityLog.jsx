import { useEffect, useRef } from 'react';
import { useApp } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { shortLabel } from '../../lib/market.js';
import { Card, CardHead } from '../../components/ui.jsx';

/**
 * The selected case's live agent activity (SSE): business events only. Browser diagnostics stay in
 * DevTools and never flood this panel. Lines are text, never HTML.
 */
export function ActivityLog() {
  const logs = useApp((s) => s.agentLogs);
  const activities = useApp((s) => s.agentActivities);
  const entry = useApp((s) => s.cases.find((c) => c.case_id === s.caseId));
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [logs]);
  return (
    <Card className="activity-log" aria-labelledby="activity-h">
      <CardHead id="activity-h" title={t('agent_terminal_title')} level={3}>
        <span className="live-dot" aria-hidden="true" />
      </CardHead>
      <p className="muted small">{entry ? t('agent_terminal_case', { label: shortLabel(entry) }) : ''}</p>
      <div ref={box} className="terminal" id="agent-logs-container" role="log" aria-live="polite" aria-label={t('agent_terminal_title')}>
        {!logs.length ? <p className="muted">{t('agent_terminal_ready')}</p> : logs.map((line) => (
          <p key={line.id} className={`log-line tone-text-${line.tone}`}>
            <span className="muted">{`[${line.time}]`}</span> {line.key ? t(line.key) : line.text}
          </p>
        ))}
      </div>
      {activities.length ? (
        <div className="activity-recent" id="agent-timeline">
          <span className="stat-label">{t('agent_timeline_heading')}</span>
          <ul>
            {activities.slice(0, 10).map((activity) => {
              const details = activity.details ?? {};
              const detail = details.fileName ? `→ ${details.fileName}` : details.price ? `→ $${details.price}` : details.status ? `→ ${details.status}` : details.newPrice ? `→ $${details.newPrice}` : '';
              return (
                <li key={activity.id}>
                  <span className="muted mono">{new Date(activity.timestamp).toLocaleTimeString('en-US', { hour12: false })}</span>
                  <span>{String(activity.action ?? '').replace(/_/g, ' ')}</span>
                  <span className="text-accent">{detail}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
