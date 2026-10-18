import { connectedAddress, currentWalletSession } from './web3.js';
import { appStore } from '../state/app-store.js';

let authorization = null;
export function clearRightsSession() { authorization = null; }
export function rightsSessionToken() {
  if (!authorization) return null;
  const current = appStore.get();
  if (authorization.wallet !== connectedAddress()?.toLowerCase() || authorization.session !== currentWalletSession()
    || authorization.generation !== current.modeGeneration || authorization.expires_at <= Date.now()) { clearRightsSession(); return null; }
  return authorization.token;
}
export async function rightsRequest(route, body) {
  const token = rightsSessionToken();
  const response = await fetch(`/api/rights/${route}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...(token ? { 'x-rights-session': token } : {}) } });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? 'Role workspace unavailable'), { code: result.code });
  return result;
}
export async function openRightsSession(subjectId, { exitOnly = false } = {}) {
  const session = currentWalletSession(), wallet = connectedAddress()?.toLowerCase(), generation = appStore.get().modeGeneration;
  if (!session?.signer || !wallet) throw new Error('Connect your enrolled wallet first');
  const assertCurrent = () => {
    if (currentWalletSession() !== session || connectedAddress()?.toLowerCase() !== wallet || appStore.get().modeGeneration !== generation) throw new Error('Wallet or mode changed. Sign in again.');
  };
  const challenge = await rightsRequest('wallet-challenges', { subject_id: subjectId, exit_only: exitOnly }); assertCurrent();
  if (challenge.message.wallet.toLowerCase() !== wallet) throw new Error('The enrolled role belongs to a different wallet');
  const signature = await session.signer.signTypedData(challenge.domain, challenge.types, challenge.message); assertCurrent();
  const result = await rightsRequest('sessions', { challenge_id: challenge.challenge_id, signature }); assertCurrent();
  authorization = { ...result, wallet, generation, session };
  return rightsRequest(`me${exitOnly ? '?exit_only=1' : ''}`);
}
