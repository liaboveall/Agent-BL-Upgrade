// Copilot action execution: a confirmed proposal is carried out here, after the user clicked
// Confirm on the action card. Demo actions go to the simulated endpoints; Live ones are signed by
// the connected wallet, which is re-checked before every signature.
import { t, getLang } from './i18n.js';
import { getAppState } from '../state/app-store.js';
import { subscribeOffering, getEthereumProvider, connectedAddress } from './web3.js';
import { payV2WithWallet } from './x402-v2.js';

export async function postAction(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error ?? `HTTP ${response.status}`), { code: result.code });
  return result;
}

export async function executeAction(context, action, { assertCurrent = () => {}, postFn = postAction, subscribeFn = subscribeOffering,
  provider = getEthereumProvider(), payFn = payV2WithWallet, wallet = getAppState().wallet?.address ?? '0xDemoWallet' } = {}) {
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
