// Demo event injector (Demo mode only): each button posts one real agent event for the selected
// case, labelled as admin-injected on the server, so the whole path — event, decision, policy,
// simulated execution, activity — can be watched. Live operators submit settlement evidence instead.
import { useState } from 'react';
import { useStore } from '../../state/hooks.js';
import { t, tData } from '../../lib/i18n.js';
import { agent } from '../../lib/agent-api.js';
import { toast } from '../../lib/toast.js';
import { Button, Card, CardHead, Field } from '../../components/ui.jsx';
import { agentStore, refresh, setSelectedCase } from './agent-store.js';
import { SETTLEMENT_ERROR_KEYS } from './settlement.js';

const today = () => new Date().toISOString().slice(0, 10);

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

function caseLabel(entry) {
  const bl = entry.case?.bill_of_lading;
  return bl ? `${tData(bl.cargo)} · ${tData(bl.port_of_loading)} → ${tData(bl.port_of_discharge)}` : tData(entry.label ?? entry.case_id);
}

function CaseSelect({ id, value, onChange }) {
  const cases = useStore(agentStore, (s) => s.cases);
  return (
    <select id={id} className="select" value={value ?? ''} aria-label={t('ac_inj_case')} onChange={(event) => onChange(event.target.value)}>
      {cases.map((entry) => <option key={entry.case_id} value={entry.case_id}>{caseLabel(entry)}</option>)}
    </select>
  );
}

export function Injector() {
  const selectedCase = useStore(agentStore, (s) => s.selectedCase);
  const [pending, setPending] = useState(() => new Set());
  const inject = async (scenario) => {
    const caseId = selectedCase, key = `${caseId}:${scenario.id}`;
    if (pending.has(key)) return;
    setPending((current) => new Set(current).add(key));
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
      await refresh();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };
  return (
    <Card id="ac-injector" aria-labelledby="ac-injector-h">
      <CardHead id="ac-injector-h" title={t('ac_injector_h')} level={3} />
      <p className="muted small">{t('ac_injector_hint')}</p>
      <Field label={t('ac_inj_case')} htmlFor="ac-inj-case">
        <CaseSelect id="ac-inj-case" value={selectedCase} onChange={setSelectedCase} />
      </Field>
      <div className="chip-wrap">
        {SCENARIOS.map((scenario) => {
          const busy = pending.has(`${selectedCase}:${scenario.id}`);
          return (
            <Button key={scenario.id} size="sm" data-focus-key={`inject:${scenario.id}`} aria-disabled={busy} onClick={() => inject(scenario)}>
              {t(scenario.label)}
            </Button>
          );
        })}
      </div>
    </Card>
  );
}

const draft = { case_id: '', type: 'PAYMENT_RECEIVED', proof: '', amount: '' };

/** Live: submit settlement evidence. Verification and human approval are separate server steps. */
export function SettlementIntake() {
  const status = useStore(agentStore, (s) => s.status);
  const selectedCase = useStore(agentStore, (s) => s.selectedCase);
  const [form, setForm] = useState(() => ({ ...draft, case_id: draft.case_id || selectedCase || '' }));
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState({ text: '', error: false });
  const update = (patch) => setForm((current) => { const next = { ...current, ...patch }; Object.assign(draft, next); return next; });
  const payment = form.type === 'PAYMENT_RECEIVED';
  const recipientConfigured = Boolean(status?.settlement?.recipient_configured);
  const submit = async (event) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setResult({ text: t('ac_set_verifying'), error: false });
    let accepted = false;
    try {
      const data = payment
        ? { payment_proof: form.proof.trim(), repayment_amount: form.amount.trim(), proof_source: 'usdc-transfer' }
        : form.type === 'CARGO_ARRIVED' ? { arrival_proof: form.proof.trim() } : { departure_proof: form.proof.trim() };
      const response = await agent.inject({ type: form.type, case_id: form.case_id || selectedCase, data });
      if (response.processing?.status === 'DEAD') throw Object.assign(new Error(response.processing.error?.message ?? t('ac_set_failed')), { code: response.processing.error?.code });
      accepted = true;
      setResult({ text: t('ac_set_accepted'), error: false });
      toast(t('ac_set_accepted'));
    } catch (error) {
      const message = SETTLEMENT_ERROR_KEYS[error.code] ? t(SETTLEMENT_ERROR_KEYS[error.code]) : error.message;
      setResult({ text: message, error: true });
      toast(message, true);
    } finally {
      setPending(false);
      if (accepted) await refresh();
    }
  };
  return (
    <Card id="ac-injector" aria-labelledby="ac-set-h">
      <CardHead id="ac-set-h" title={t('ac_set_h')} level={3} />
      <p className="muted small">{t('ac_set_hint')}</p>
      {!recipientConfigured ? <p className="text-crit small">{t('ac_set_unconfigured')}</p> : null}
      <form id="ac-set-form" className="form-stack" onSubmit={submit}>
        <Field label={t('ac_inj_case')} htmlFor="ac-set-case"><CaseSelect id="ac-set-case" value={form.case_id || selectedCase} onChange={(value) => update({ case_id: value })} /></Field>
        <Field label={t('ac_set_type')} htmlFor="ac-set-type">
          <select id="ac-set-type" className="select" value={form.type} onChange={(event) => update({ type: event.target.value })}>
            {[['PAYMENT_RECEIVED', 'ac_inj_pay'], ['CARGO_ARRIVED', 'ac_inj_arrive'], ['CARGO_DEPARTED', 'ac_inj_depart']].map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
          </select>
        </Field>
        <Field label={t(payment ? 'ac_set_payment_hash' : 'ac_set_proof')} htmlFor="ac-set-proof">
          <input id="ac-set-proof" className="input" type="text" maxLength={300} required value={form.proof} autoComplete="off" onChange={(event) => update({ proof: event.target.value })} />
        </Field>
        {payment ? (
          <Field label={t('ac_set_amount')} htmlFor="ac-set-amount">
            <input id="ac-set-amount" className="input" type="text" inputMode="decimal" maxLength={85} required value={form.amount} autoComplete="off" onChange={(event) => update({ amount: event.target.value })} />
          </Field>
        ) : null}
        <Button type="submit" variant="primary" data-focus-key="settlement:submit" disabled={pending || (payment && !recipientConfigured)}>{t('ac_set_submit')}</Button>
        <p id="ac-set-result" className={`small${result.error ? ' text-crit' : ''}`} role="status" aria-live="polite">{result.text}</p>
      </form>
    </Card>
  );
}
