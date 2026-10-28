// Payer recovery for Live paid reports.
//
// A browser keeps the original PAYMENT-SIGNATURE only for the life of its tab. When that tab is gone,
// the payer proves control of the paying wallet by signing a one-time, server-issued EIP-712 challenge
// (it moves no funds and authorizes no payment) and receives a short-lived token bound to that address
// and to the current runtime generation. The token only lists, reconciles and re-reads that payer's own
// payments; it can never create one.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyTypedData } from 'ethers';
import { HttpError } from '../app/http.js';

export const RECOVERY_DOMAIN = Object.freeze({ name: 'AgentBL Paid Report Recovery', version: '1' });
export const RECOVERY_TYPES = Object.freeze({ PaidReportRecovery: Object.freeze([
  Object.freeze({ name: 'payer', type: 'address' }),
  Object.freeze({ name: 'purpose', type: 'string' }),
  Object.freeze({ name: 'nonce', type: 'bytes32' }),
  Object.freeze({ name: 'validUntil', type: 'uint256' })
]) });
const PURPOSE = 'List and re-read my paid AgentBL reports. This signature moves no funds and authorizes no payment.';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const REUSE_MIN_MS = 2 * 60 * 1000;
const digest = (value) => createHash('sha256').update(value).digest('hex');

export class PayerRecoverySessions {
  constructor({ clock = () => Date.now(), getGeneration = () => 0, maxChallenges = 1000, maxSessions = 1000 } = {}) {
    Object.assign(this, { clock, getGeneration, maxChallenges, maxSessions });
    this.challenges = new Map();
    this.sessions = new Map();
  }
  #prune(now) {
    for (const [id, challenge] of this.challenges) if (challenge.expires_at <= now || challenge.used) this.challenges.delete(id);
    for (const [key, session] of this.sessions) if (session.expires_at <= now) this.sessions.delete(key);
  }
  // A paying wallet is public, so anyone can ask for its recovery challenge: asking hands out the open one while it still
  // leaves time to sign, instead of using up the payer's own requests. Only the payer's signature opens a session.
  challenge(payer) {
    if (!ADDRESS_RE.test(String(payer ?? '')) || /^0x0{40}$/iu.test(payer)) throw new HttpError(400, 'x402_recovery_payer_invalid', 'A paying wallet address is required');
    const now = this.clock(); this.#prune(now);
    const view = (challenge_id, { message }) => ({ challenge_id, domain: { ...RECOVERY_DOMAIN }, types: { PaidReportRecovery: RECOVERY_TYPES.PaidReportRecovery.map((field) => ({ ...field })) }, message });
    const open = [...this.challenges].find(([, entry]) => entry.payer === payer.toLowerCase() && entry.expires_at - now >= REUSE_MIN_MS);
    if (open) return view(...open);
    // At capacity the oldest open request gives way, so a flood of other addresses delays a payer instead of locking them out.
    if (this.challenges.size >= this.maxChallenges) this.challenges.delete(this.challenges.keys().next().value);
    const challenge_id = randomUUID();
    const message = { payer, purpose: PURPOSE, nonce: `0x${randomBytes(32).toString('hex')}`, validUntil: Math.floor((now + CHALLENGE_TTL_MS) / 1000) };
    const entry = { payer: payer.toLowerCase(), message, expires_at: now + CHALLENGE_TTL_MS, used: false };
    this.challenges.set(challenge_id, entry);
    return view(challenge_id, entry);
  }
  open({ challenge_id: challengeId, signature } = {}) {
    if (typeof challengeId !== 'string' || !/^0x[0-9a-fA-F]{130}$/u.test(String(signature ?? ''))) throw new HttpError(400, 'x402_recovery_input_invalid', 'A recovery challenge id and wallet signature are required');
    const now = this.clock(), challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.used || challenge.expires_at <= now) throw new HttpError(401, 'x402_recovery_challenge_invalid', 'The recovery request expired; start it again');
    // A shared challenge is spent only by the payer's valid signature, so a wrong one cannot burn it for the payer.
    let signer = null;
    try { signer = verifyTypedData(RECOVERY_DOMAIN, RECOVERY_TYPES, challenge.message, signature); } catch {}
    if (signer?.toLowerCase() !== challenge.payer) throw new HttpError(401, 'x402_recovery_signature_invalid', 'The signature does not come from the paying wallet');
    challenge.used = true;
    this.#prune(now);
    if (this.sessions.size >= this.maxSessions) throw new HttpError(429, 'x402_recovery_rate_limited', 'Too many recovery sessions are open; retry in a few minutes');
    const token = randomBytes(32).toString('hex'), expires_at = now + SESSION_TTL_MS;
    this.sessions.set(digest(token), { payer: challenge.payer, expires_at, generation: this.getGeneration() });
    return { token, payer: challenge.payer, expires_at };
  }
  /** The payer this token was issued to; a mode change or expiry ends it. */
  payer(token) {
    const session = /^[a-f0-9]{64}$/u.test(String(token ?? '')) ? this.sessions.get(digest(token)) : null;
    if (!session || session.expires_at <= this.clock() || session.generation !== this.getGeneration()) {
      throw new HttpError(401, 'x402_recovery_session_required', 'Sign a recovery request with the paying wallet first');
    }
    return session.payer;
  }
}
