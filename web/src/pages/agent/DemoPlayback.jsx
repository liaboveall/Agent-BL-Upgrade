import { useState } from 'react';
import { useStore } from '../../state/hooks.js';
import { getLang, t, tData } from '../../lib/i18n.js';
import { agent } from '../../lib/agent-api.js';
import { actionLabel } from '../../lib/agent-format.js';
import { toast } from '../../lib/toast.js';
import { Badge, Button, Card, CardHead, Field } from '../../components/ui.jsx';
import { openDecision as openDecisionEvent } from '../../features/evidence/References.jsx';
import { agentStore, refresh } from './agent-store.js';

const localized = (value) => (value && typeof value === 'object' ? value[getLang()] ?? value.en ?? '' : tData(value));

/** Plays a scripted Demo story through the real agent pipeline (Demo mode, autonomy auto). */
export function DemoPlayback() {
  const status = useStore(agentStore, (s) => s.status);
  const scenarios = useStore(agentStore, (s) => s.scenarios);
  const [selected, setSelected] = useState('copper-lifecycle');
  const [speed, setSpeed] = useState('1');
  const [pending, setPending] = useState(false);
  const run = status?.demo_run ?? { state: 'idle', active: false };
  const scenario = run.scenario;
  const stages = scenario?.log ?? [];
  const call = async (stop) => {
    if (pending) return;
    setPending(true);
    try {
      if (stop) await agent.stopDemo();
      else await agent.runDemo({ scenario: selected, speed: Number(speed) });
    } catch (error) {
      toast(t('ac_demo_error', { message: error.message }), true);
    } finally {
      setPending(false);
      await refresh();
    }
  };
  return (
    <Card id="ac-demo" className="ac-demo" data-demo-state={pending && !run.active ? 'starting' : run.state} aria-labelledby="ac-demo-h">
      <CardHead id="ac-demo-h" title={t('ac_demo_title')} level={3}>
        <Badge tone={run.state === 'failed' ? 'crit' : 'muted'}>{t(`ac_demo_state_${run.state}`)}</Badge>
      </CardHead>
      <p className="muted small">{t('ac_demo_playback_note')}</p>
      <div className="demo-settings">
        <Field label={t('ac_demo_scenario')} htmlFor="ac-demo-scenario">
          <select id="ac-demo-scenario" className="select" value={selected} disabled={run.active || pending} onChange={(event) => setSelected(event.target.value)}>
            {scenarios.map((item) => <option key={item.name} value={item.name}>{localized(item.title)}</option>)}
          </select>
        </Field>
        <Field label={t('ac_demo_speed')} htmlFor="ac-demo-speed">
          <select id="ac-demo-speed" className="select" value={speed} disabled={run.active || pending} onChange={(event) => setSpeed(event.target.value)}>
            {['0.5', '1', '2', '5', '10'].map((value) => <option key={value} value={value}>{`${value}×`}</option>)}
          </select>
        </Field>
      </div>
      <div className="button-row">
        <Button variant="primary" data-focus-key="demo:run" disabled={run.active || pending || status?.autonomy?.effective !== 'auto'} onClick={() => call(false)}
          title={status?.autonomy?.effective !== 'auto' ? t('ac_demo_needs_auto') : undefined}>{t('ac_demo_run')}</Button>
        <Button variant="ghost" data-focus-key="demo:stop" disabled={!run.active || pending} onClick={() => call(true)}>{t('ac_demo_stop')}</Button>
      </div>
      {status?.autonomy?.effective !== 'auto' ? <p className="muted small">{t('ac_demo_needs_auto')}</p> : null}
      <p role="status" aria-live="polite" aria-atomic="true" className="small demo-progress">{scenario?.total_steps ? t('ac_demo_progress', { done: scenario.next_step ?? 0, total: scenario.total_steps }) : t('ac_demo_not_loaded')}</p>
      {stages.length ? (
        <ol className="steps demo-steps">
          {stages.map((step, index) => (
            <li key={step.index} aria-current={index === stages.length - 1 ? 'step' : undefined} className={index === stages.length - 1 ? 'is-current' : ''} data-demo-step={String(step.index)}>
              <span>{localized(step.label) ?? step.kind}</span>
              {step.events.flatMap((event) => event.decisions ?? []).map((decision) => (
                <Button key={decision.decision_id} variant="ghost" size="sm" data-focus-key={`demo:decision:${decision.decision_id}`} onClick={() => openDecisionEvent(decision.decision_id)}>{actionLabel(decision.action)}</Button>
              ))}
            </li>
          ))}
        </ol>
      ) : null}
      {run.error ? <p className="text-crit">{t('ac_demo_error', { message: run.error.message })}</p> : null}
    </Card>
  );
}
