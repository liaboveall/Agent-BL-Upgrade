import { useEffect } from 'react';
import { useStore } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { agentStore, closeDecision, startConsole, stopConsole } from './agent-store.js';
import { StatusCard, ControlsCard } from './StatusCards.jsx';
import { ApprovalsPanel } from './Approvals.jsx';
import { Timeline } from './Timeline.jsx';
import { DemoPlayback } from './DemoPlayback.jsx';
import { Injector, SettlementIntake } from './Injector.jsx';
import { ActivityLog } from './ActivityLog.jsx';
import { DecisionDrawer } from './DecisionDrawer.jsx';

export function AgentPage() {
  const status = useStore(agentStore, (s) => s.status);
  const announcement = useStore(agentStore, (s) => s.announcement);
  const openId = useStore(agentStore, (s) => s.openDecisionId);
  useEffect(() => {
    startConsole();
    return () => stopConsole();
  }, []);
  const statusMode = status?.mode;
  // A proposal waiting for a person is the one thing on this page that needs action now, so it leads.
  const waiting = useStore(agentStore, (s) => s.decisions.some((decision) => ['PENDING_APPROVAL', 'AWAITING_OWNER_SIGNATURE'].includes(decision.status) && decision.approval?.approval_id));
  const announce = announcement ? t('ac_timeline_update', { ...announcement, status: t(`ac_status_${announcement.status}`) }) : '';
  return (
    <div className="agent-console">
      <header className="page-head">
        <div className="page-head-text">
          <p className="eyebrow">{t('ac_eyebrow')}</p>
          <h1>{t('ac_title')}</h1>
          <p className="page-sub">{t('ac_subtitle')}</p>
        </div>
      </header>
      {/* In Demo the one-click story sits beside the status; operator controls move to the side column. */}
      {waiting ? <ApprovalsPanel /> : null}
      <div className="agent-top">
        <StatusCard />
        {statusMode === 'demo' ? <DemoPlayback /> : <ControlsCard />}
      </div>
      {waiting ? null : <ApprovalsPanel />}
      <div className="agent-layout">
        {/* The live log reads with the decisions it explains; the side column holds the inputs. */}
        <div className="agent-main">
          <Timeline />
          <ActivityLog />
        </div>
        <aside className="agent-side">
          {status ? (statusMode === 'live' ? <SettlementIntake /> : <Injector />) : null}
          {statusMode === 'demo' ? <ControlsCard /> : null}
        </aside>
      </div>
      <p id="ac-announcement" className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</p>
      <DecisionDrawer id={openId} onClose={closeDecision} />
    </div>
  );
}
