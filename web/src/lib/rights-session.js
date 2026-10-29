import { connectedAddress, currentWalletSession, provideRightsSessionToken } from './web3.js';
import { appStore } from '../state/app-store.js';

let authorization = null, expiry = null;
// Every surface that shows "signed in" listens for this, so an expired or replaced session is never displayed as live.
// It is dispatched after the current call returns: a read during a render must not update another component.
const changed = () => setTimeout(() => globalThis.window?.dispatchEvent(new CustomEvent('agentbl:rightssession')), 0);
function remember(value) {
  authorization = value;
  clearTimeout(expiry);
  if (value) expiry = setTimeout(() => rightsSessionToken(), Math.max(0, Math.min(value.expires_at - Date.now() + 50, 2_147_000_000)));
  changed();
}
export function clearRightsSession() { if (authorization) remember(null); }
export function rightsSessionToken() {
  if (!authorization) return null;
  const current = appStore.get();
  if (authorization.wallet !== connectedAddress()?.toLowerCase() || authorization.session !== currentWalletSession()
    || authorization.generation !== current.modeGeneration || authorization.expires_at <= Date.now()) { clearRightsSession(); return null; }
  return authorization.token;
}
/** What the identity status line shows: whether a business session is live, until when, and whether it is exit-only. */
export function rightsSessionInfo() {
  return rightsSessionToken() ? { active: true, expires_at: authorization.expires_at, exit_only: Boolean(authorization.exit_only),
    organization: authorization.organization ?? null, roles: authorization.roles ?? [] } : { active: false };
}
provideRightsSessionToken(rightsSessionToken);
export async function rightsRequest(route, body) {
  const token = rightsSessionToken();
  const response = await fetch(`/api/rights/${route}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...(token ? { 'x-rights-session': token } : {}) } });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? 'Role workspace unavailable'), { code: result.code });
  return result;
}
/** The business identities enrolled for the connected wallet, found by one lookup signature (no funds, no session). */
export async function findRightsIdentities() {
  const session = currentWalletSession(), wallet = connectedAddress()?.toLowerCase(), generation = appStore.get().modeGeneration;
  if (!session?.signer || !wallet) throw new Error('Connect your enrolled wallet first');
  const challenge = await rightsRequest('identity-challenges', { wallet });
  if (challenge.message.wallet.toLowerCase() !== wallet) throw new Error('The lookup belongs to a different wallet');
  const signature = await session.signer.signTypedData(challenge.domain, challenge.types, challenge.message);
  if (currentWalletSession() !== session || connectedAddress()?.toLowerCase() !== wallet || appStore.get().modeGeneration !== generation) throw new Error('Wallet or mode changed. Look up again.');
  return (await rightsRequest('identities', { challenge_id: challenge.challenge_id, signature })).identities;
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
  remember({ ...result, wallet, generation, session, exit_only: exitOnly });
  const principal = await rightsRequest(`me${exitOnly ? '?exit_only=1' : ''}`);
  // The status line names the organization and roles this session acts for.
  if (authorization?.token === result.token) remember({ ...authorization, organization: principal.organization, roles: principal.roles });
  return principal;
}
