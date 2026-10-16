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
      <div className="agent-top">
        <StatusCard />
        <ControlsCard />
      </div>
      <ApprovalsPanel />
      <div className="agent-layout">
        <div className="agent-main">
          <Timeline />
        </div>
        <aside className="agent-side">
          {status?.mode === 'demo' ? <DemoPlayback /> : null}
          {status ? (status.mode === 'live' ? <SettlementIntake /> : <Injector />) : null}
          <ActivityLog />
        </aside>
      </div>
      <p id="ac-announcement" className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</p>
      <DecisionDrawer id={openId} onClose={closeDecision} />
    </div>
  );
}
