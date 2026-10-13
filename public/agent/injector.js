// Demo event injector (Demo mode only). Each button posts one real agent event for the selected case,
// so the whole path -- event, decision, policy, simulated execution, activity -- can be watched. The
// events are labelled as admin-injected on the server; nothing here pretends to be a live feed.

import { clear, el, toast } from '../dom.js';
import { t, tData } from '../i18n.js';
import { agent } from './api.js';

const today = () => new Date().toISOString().slice(0, 10);
const pending = new Set();

/** Event factories. Payload values are plain fixtures; the server validates and sources them. */
const SCENARIOS = [
  { id: 'typhoon', label: 'ac_inj_typhoon', build: () => ({ type: 'WORLD_RISK_UPDATED', data: { events: [{ type: 'severe_weather', region: 'East China Sea', severity: 'warning', description: 'Typhoon warning along the route (demo injection)', date: today() }] } }) },
  { id: 'war', label: 'ac_inj_war', build: () => ({ type: 'WORLD_RISK_UPDATED', data: { events: [{ type: 'war_risk', region: 'Strait of Hormuz', severity: 'critical', description: 'Escalation and closure risk (demo injection)', date: today() }] } }) },
  { id: 'clear', label: 'ac_inj_clear', build: () => ({ type: 'RISK_CLEARED', data: {} }) },
  { id: 'insurance', label: 'ac_inj_insurance', build: () => ({ type: 'INSURANCE_EXPIRING', data: { days_left: 3 } }) },
  { id: 'depart', label: 'ac_inj_depart', build: () => ({ type: 'CARGO_DEPARTED', data: {} }) },
  { id: 'arrive', label: 'ac_inj_arrive', build: () => ({ type: 'CARGO_ARRIVED', data: {} }) },
  { id: 'pay', label: 'ac_inj_pay', build: (ctx) => ({ type: 'PAYMENT_RECEIVED', data: { payment_proof: `demo:wire:${Date.now()}`, repayment_amount: Math.max(1, Math.round((ctx.subscribedUsd || 1) * 1.05)), proof_source: 'demo-injector' } }) }
];

export async function renderInjector(container, { cases, selectedCaseId, onChange, onInjected }) {
  clear(container);
  const select = el('select', { id: 'ac-inj-case', class: 'ac-select', 'aria-label': t('ac_inj_case') },
    cases.map((entry) => {
      const bl = entry.case?.bill_of_lading;
      const label = bl ? `${tData(bl.cargo)} · ${tData(bl.port_of_loading)} → ${tData(bl.port_of_discharge)}` : tData(entry.label ?? entry.case_id);
      return el('option', { value: entry.case_id, selected: entry.case_id === selectedCaseId }, label);
    }));
  select.addEventListener('change', () => onChange?.(select.value));

  const buttons = SCENARIOS.map((scenario) => el('button', {
    class: 'btn ghost', type: 'button', 'data-focus-key': `inject:${scenario.id}`,
    'aria-disabled': String(pending.has(`${selectedCaseId}:${scenario.id}`)),
    onclick: async (event) => {
      const button = event.currentTarget;
      const caseId = select.value, key = `${caseId}:${scenario.id}`;
      if (pending.has(key)) return;
      pending.add(key);
      button.setAttribute('aria-disabled', 'true');
      try {
        let subscribedUsd = 0;
        if (scenario.id === 'pay') {
          try { subscribedUsd = (await agent.poolStatus(caseId)).subscribedUsd ?? 0; } catch { subscribedUsd = 0; }
        }
        const result = await agent.inject({ ...scenario.build({ subscribedUsd }), case_id: caseId });
        const outcome = result.processing;
        if (outcome?.result?.ignored) toast(t('ac_inj_ignored', { reason: outcome.result.ignored }));
        else if (outcome?.status === 'DONE') toast(t('ac_inj_done'));
        else toast(`${outcome?.status ?? result.status}`);
        await onInjected?.();
      } catch (error) {
        toast(error.message, true);
      } finally {
        pending.delete(key);
        container.querySelector(`[data-focus-key="inject:${scenario.id}"]`)?.setAttribute('aria-disabled', 'false');
      }
    }
  }, t(scenario.label)));

  container.append(
    el('header', { class: 'ac-panel-head' }, el('h3', {}, t('ac_injector_h'))),
    el('p', { class: 'muted ac-small' }, t('ac_injector_hint')),
    el('label', { class: 'ac-field', for: 'ac-inj-case' }, el('span', {}, t('ac_inj_case')), select),
    el('div', { class: 'ac-actions ac-wrap' }, buttons));
}
