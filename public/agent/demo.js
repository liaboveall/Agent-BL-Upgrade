import { clear, el, toast } from '../dom.js';
import { t, tData, getLang } from '../i18n.js';
import { agent } from './api.js';
import { badge } from './ui.js';

const ui = { scenarios: [], selected: 'copper-lifecycle', speed: '1', pending: false };
const localized = (value) => value && typeof value === 'object' ? value[getLang()] ?? value.en ?? '' : tData(value);

export async function loadDemoCatalog() {
  ui.scenarios = (await agent.scenarios()).scenarios;
}

export function renderDemoPlayback(root, status, refresh) {
  clear(root);
  root.hidden = status?.mode !== 'demo';
  if (root.hidden) return;
  const run = status.demo_run ?? { state: 'idle', active: false };
  const scenario = run.scenario;
  const call = async (stop) => {
    if (ui.pending) return;
    ui.pending = true; renderDemoPlayback(root, status, refresh);
    try {
      if (stop) await agent.stopDemo();
      else await agent.runDemo({ scenario: ui.selected, speed: Number(ui.speed) });
    } catch (error) { toast(t('ac_demo_error', { message: error.message }), true); }
    finally {
      ui.pending = false; await refresh();
      const focus = root.querySelector(`[data-focus-key="demo:${stop ? 'run' : 'stop'}"]`);
      if (focus && !focus.disabled) focus.focus({ preventScroll: true });
    }
  };
  const select = el('select', { id: 'ac-demo-scenario', class: 'ac-select', disabled: run.active || ui.pending, 'aria-label': t('ac_demo_scenario') },
    ui.scenarios.map((item) => el('option', { value: item.name, selected: item.name === ui.selected }, localized(item.title))));
  select.addEventListener('change', () => { ui.selected = select.value; });
  const speed = el('select', { id: 'ac-demo-speed', class: 'ac-select', disabled: run.active || ui.pending, 'aria-label': t('ac_demo_speed') },
    ['0.5', '1', '2', '5', '10'].map((value) => el('option', { value, selected: value === ui.speed }, `${value}×`)));
  speed.addEventListener('change', () => { ui.speed = speed.value; });
  const stages = scenario?.log ?? [];
  root.dataset.demoState = ui.pending && !run.active ? 'starting' : run.state;
  root.append(el('header', { class: 'ac-panel-head' }, el('h3', {}, t('ac_demo_title')),
    badge(t(`ac_demo_state_${run.state}`), run.state === 'failed' ? 'tone-err' : 'tone-muted')),
  el('p', { class: 'muted' }, t('ac_demo_playback_note')),
  el('div', { class: 'ac-actions ac-wrap' }, select, speed,
    el('button', { type: 'button', class: 'btn', 'data-focus-key': 'demo:run', disabled: run.active || ui.pending || status.autonomy?.effective !== 'auto', onclick: () => call(false) }, t('ac_demo_run')),
    el('button', { type: 'button', class: 'btn ghost', 'data-focus-key': 'demo:stop', disabled: !run.active || ui.pending, onclick: () => call(true) }, t('ac_demo_stop'))),
  el('p', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', class: 'ac-demo-progress' },
    t('ac_demo_progress', { done: scenario?.next_step ?? 0, total: scenario?.total_steps ?? 0 })),
  el('ol', { class: 'ac-steps ac-demo-steps' }, stages.map((step, index) => el('li', {
    'aria-current': index === stages.length - 1 ? 'step' : null,
    class: index === stages.length - 1 ? 'is-current' : '', 'data-demo-step': String(step.index)
  }, localized(step.label) ?? step.kind,
  ...step.events.flatMap((event) => event.decisions ?? []).map((decision) => el('button', { type: 'button', class: 'btn ghost sm',
    'data-focus-key': `demo:decision:${decision.decision_id}`, onclick: () => window.dispatchEvent(new CustomEvent('agentbl:decisionopen', { detail: { decision_id: decision.decision_id } })) }, decision.action))))));
  if (run.error) root.append(el('p', { class: 'ac-error' }, t('ac_demo_error', { message: run.error.message })));
}
