import { el } from '../dom.js';
import { t, tData, getLang } from '../i18n.js';
import { state } from '../store.js';
import { copilotQuery } from './api.js';
import { subscribeOffering, getEthereumProvider, connectedAddress } from '../web3.js';
import { payV2WithWallet } from '../x402-v2.js';

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error ?? `HTTP ${response.status}`), { code: result.code });
  return result;
}

export async function executeAction(context, action, { assertCurrent = () => {}, postFn = post, subscribeFn = subscribeOffering,
  provider = getEthereumProvider(), payFn = payV2WithWallet, wallet = state.wallet?.address ?? '0xDemoWallet' } = {}) {
  assertCurrent();
  const confirmed = await postFn(action.type === 'ACTION_SUBSCRIBE' && action.mode === 'demo' ? '/api/pool/subscribe'
    : `/api/copilot/sessions/${context.session_id}/actions/${action.id}/confirm`, {
    copilot_action: { session_id: context.session_id, action_id: action.id }, confirm: true, wallet_address: wallet
  });
  assertCurrent();
  if (action.type === 'ACTION_SUBSCRIBE') {
    if (action.mode === 'demo') return confirmed;
    return subscribeFn(confirmed.action, { assertCurrent });
  }
  let data;
  if (action.mode === 'demo') {
    data = await postFn('/api/x402/smoke', { case: confirmed.caseData, serviceId: action.service_id, locale: getLang() });
  } else {
    if (!provider || !/^0x[0-9a-f]{40}$/iu.test(wallet) || connectedAddress()?.toLowerCase() !== wallet.toLowerCase()) throw new Error(t('cp_wallet_required'));
    const checkWallet = async () => {
      assertCurrent();
      const accounts = await provider.request({ method: 'eth_accounts' });
      if (accounts[0]?.toLowerCase() !== wallet.toLowerCase()) throw new Error(t('cp_wallet_changed'));
    };
    await checkWallet();
    const guardedProvider = { request: async (request) => {
      if (request.method === 'eth_signTypedData_v4') {
        await checkWallet();
        const typed = JSON.parse(request.params[1]);
        const network = await provider.request({ method: 'eth_chainId' });
        if (BigInt(network) !== BigInt(typed.domain.chainId)) throw new Error(t('cp_wallet_changed'));
      }
      assertCurrent(); return provider.request(request);
    } };
    const { response } = await payFn({ endpoint: action.endpoint, body: { case: confirmed.caseData, case_id: action.case_id },
      provider: guardedProvider, from: wallet, expectedAmountAtomic: Math.round(action.amount_usd * 1_000_000),
      fetchImpl: async (...args) => { await checkWallet(); return fetch(...args); } });
    data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  assertCurrent();
  if (action.mode === 'demo' && data.payment) {
    const { txHash: _compatibilityHash, ...payment } = data.payment;
    data = { ...data, payment, steps: data.steps?.map(({ txHash: _compatibilityHash, ...step }) => step) };
  }
  return { mode: action.mode === 'demo' ? 'demo' : 'chain', report: data,
    reference: data.report_envelope?.report_id ?? data.receipt?.receiptId
      ?? (action.mode === 'demo' && data.payment?.receipt?.paymentRef ? `demo:${data.payment.receipt.paymentRef}` : null) };
}

export function renderActionCard(result, { scope, onRefresh }) {
  const action = result.action_proposal, context = result.context;
  const card = el('section', { class: 'cp-action-card', 'aria-label': t('cp_action_card') });
  card.append(el('h4', {}, t('cp_action_card')), el('p', { class: 'cp-warning' }, t('cp_action_disclosure')));
  const status = el('p', { role: 'status', 'aria-live': 'polite', class: 'cp-action-status' });
  if (!action?.id) {
    card.append(el('p', {}, t(`cp_block_${action?.blocked ?? 'select_pool'}`)));
    const pool = el('select', { 'aria-label': t('cp_action_pool'), 'data-focus-key': 'cp-action-pool' },
      ...(result.recommendations ?? []).map((item) => el('option', { value: item.pool_id }, `${tData(item.label)} · ${tData(item.route)}`)));
    const isReport = result.intent === 'ACTION_BUY_REPORT';
    const amount = el('input', { type: 'number', min: '0.000001', step: 'any', value: context.constraints.ticket_usd ?? '',
      'aria-label': t('cp_action_amount'), 'data-focus-key': 'cp-action-amount' });
    const service = el('select', { 'aria-label': t('cp_action_report') },
      ...['premium-risk', 'premium-valuation', 'fraud-review'].map((id) => el('option', { value: id }, t(`cp_report_${id}`))));
    const prepare = el('button', { type: 'submit', class: 'btn', disabled: !result.recommendations?.length }, t('cp_action_prepare'));
    const form = el('form', { class: 'cp-action-form', onsubmit: async (event) => {
      event.preventDefault(); if (prepare.disabled) return; prepare.disabled = true;
      try {
        const message = isReport ? 'buy report' : `subscribe USD ${amount.value}`;
        if (!isReport && !(Number(amount.value) > 0)) throw new Error(t('cp_block_amount_required'));
        const refreshed = await copilotQuery(message, { scope, pool_ids: [pool.value], service_id: isReport ? service.value : undefined });
        onRefresh(refreshed);
      } catch (error) { status.textContent = t('cp_error', { message: error.message }); }
      finally { prepare.disabled = !result.recommendations?.length; }
    } }, pool, isReport ? service : amount, prepare);
    card.append(form, status); return card;
  }
  card.dataset.actionId = action.id;
  const isReport = action.type === 'ACTION_BUY_REPORT';
  card.append(el('p', {}, `${tData(action.label)} · ${tData(action.route)}`),
    el('p', {}, t('cp_action_cost', { amount: action.amount_usd.toFixed(6), price: action.price_usd.toFixed(6) })),
    el('p', {}, isReport ? t(`cp_report_${action.service_id}`) : t('cp_action_shares', { shares: action.shares })),
    el('p', { class: 'muted' }, t(action.mode === 'demo' ? 'cp_action_demo' : isReport ? 'cp_action_live_report' : 'cp_action_live_shares')),
    el('p', { class: 'muted' }, t('cp_action_expiry')));
  const snapshot = { mode: state.demoMode ? 'demo' : 'live', generation: state.modeGeneration, wallet: state.wallet?.address ?? '0xDemoWallet' };
  const assertCurrent = () => {
    if (snapshot.mode !== action.mode || snapshot.generation !== action.generation || state.demoMode !== (action.mode === 'demo')
      || state.modeGeneration !== action.generation || snapshot.wallet !== (state.wallet?.address ?? '0xDemoWallet')) throw new Error(t('cp_wallet_changed'));
  };
  let started = action.status !== 'PENDING';
  const showOutcome = (executed) => {
    status.textContent = executed.report ? t('cp_report_done', { id: executed.reference ?? '—' })
      : t(action.mode === 'demo' ? 'cp_subscription_done_demo' : 'cp_subscription_done_live', { id: executed.reference ?? executed.txHash, shares: action.shares });
    if (executed.report) card.append(el('details', {}, el('summary', {}, t('cp_report_view')),
      el('pre', { class: 'cp-report-body' }, JSON.stringify(executed.report, null, 2))));
    confirm.textContent = t('cp_action_completed');
  };
  const confirm = el('button', { type: 'button', class: 'btn cp-action-confirm', 'data-focus-key': `cp-confirm-${action.id}`, disabled: started,
    onclick: async () => {
      if (started) return; started = true; confirm.disabled = true; cancel.disabled = true; status.textContent = t('cp_action_working');
      action.status = 'CONFIRMING';
      try {
        const executed = await executeAction(context, action, { assertCurrent, wallet: snapshot.wallet });
        action.status = 'COMPLETED';
        action.outcome = executed;
        assertCurrent();
        showOutcome(executed);
        window.dispatchEvent(new CustomEvent('agentbl:copilotaction', { detail: { result: executed, pool_id: action.pool_id } }));
      } catch (error) { action.failure = error.message; status.textContent = t('cp_action_failed', { message: error.message }); }
    } }, t('cp_action_confirm'));
  const cancel = el('button', { type: 'button', class: 'ghost cp-action-cancel', disabled: started, onclick: async () => {
    if (started) return; started = true; confirm.disabled = true; cancel.disabled = true;
    action.status = 'CANCELLED';
    try { await post(`/api/copilot/sessions/${context.session_id}/actions/${action.id}/cancel`, {}); status.textContent = t('cp_action_cancelled'); }
    catch (error) { status.textContent = t('cp_error', { message: error.message }); }
  } }, t('cp_action_cancel'));
  card.append(el('div', { class: 'cp-action-buttons' }, confirm, cancel), status);
  if (action.outcome) showOutcome(action.outcome);
  else if (action.failure) status.textContent = t('cp_action_failed', { message: action.failure });
  else if (action.status === 'CANCELLED') status.textContent = t('cp_action_cancelled');
  else if (action.status === 'CONFIRMING') status.textContent = t('cp_action_working');
  return card;
}
