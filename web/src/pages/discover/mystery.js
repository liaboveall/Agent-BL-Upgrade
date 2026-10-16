// Mystery Voyage: commit-reveal AI due diligence. The server freezes an equal-odds set of eligible
// routes, the user pays 0.001 USDC (Demo: a signed challenge and a simulated receipt; Live: x402 V2),
// one route is revealed, and the browser re-checks the proof locally. Subscribing to the revealed RWA
// is a separate, second signature; Voyage Passport stamps are product-experience credentials only.
//
// mysteryState holds the flow; publish() tells the components to re-render.
import { createStore } from '../../state/store.js';
import { appStore } from '../../state/app-store.js';
import * as web3 from '../../lib/web3.js';
import { payV2WithWallet } from '../../lib/x402-v2.js';
import { isIndependentSubscriptionAuthorized, verifyMysteryProof } from '../../lib/mystery-proof.js';
import { assertSafePassportShareCard, buildPassportShareCard, buildPassportShareText } from '../../lib/passport.js';
import { t, tData } from '../../lib/i18n.js';
import { toast } from '../../lib/toast.js';
import { prefersReducedMotion } from '../../lib/accessibility.js';

export const TIER_META = Object.freeze({
  CONSERVATIVE: { riskBps: 500, yieldRange: '3-8%', stressLossPct: 0.25 },
  BALANCED: { riskBps: 1000, yieldRange: '5-14%', stressLossPct: 0.5 },
  ADVENTUROUS: { riskBps: 1500, yieldRange: '8-22%', stressLossPct: 0.75 }
});
export const MYSTERY_STEPS = ['commit', 'challenge', 'settlement', 'reveal', 'verify'];

const idleSteps = () => Object.fromEntries(MYSTERY_STEPS.map((step) => [step, { status: 'pending', label: '—' }]));

export const mysteryState = {
  tier: 'BALANCED',
  preview: null,
  signer: null,
  report: null,
  canonicalProof: null,
  proofText: '',
  proofResult: null,
  proofValid: false,
  proofVersion: 0,
  subscriptionSignature: null,
  subscription: null,
  passports: [],
  showHiddenPassports: false,
  selectedPassport: null,
  shareCard: null,
  share: { nickname: '', advanced: false, confirmed: false },
  steps: idleSteps(),
  boxMotion: 'idle', // idle | unlocking | bursting
  reveal: 'hidden', // hidden | opening | open
  paymentNote: { text: '', tone: '' },
  modal: false,
  subscribeOpen: false,
  shareOpen: false,
  busy: { preview: false, open: false, DISCOVERY: false, INVESTOR_JOURNEY: false, subscribe: false },
  claimed: { DISCOVERY: false, INVESTOR_JOURNEY: false },
  confirm: { amount: '10000', ack: false, result: '', tone: '' }
};

export const mysteryStore = createStore({ version: 0 });
export function publish() { mysteryStore.set((state) => ({ version: state.version + 1 })); }

export function tierMeta() {
  return TIER_META[mysteryState.tier] ?? TIER_META.BALANCED;
}

export function formatPct(value, digits = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(digits)}%` : '—';
}

export function formatUsd(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: digits }).format(number) : '—';
}

export function shortHash(value, start = 10, end = 8) {
  const text = String(value ?? '');
  return text.length > start + end + 1 ? `${text.slice(0, start)}…${text.slice(-end)}` : text || '—';
}

function randomHex32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || body.message || `${url} returned ${response.status}`);
    error.status = response.status;
    error.code = body.code;
    error.details = body.details;
    throw error;
  }
  return { response, body };
}

async function resolveSigner() {
  const connected = web3.connectedAddress();
  const provider = web3.getEthereumProvider();
  if (connected && provider && /^0x[0-9a-fA-F]{40}$/u.test(connected)) {
    return { address: connected, demo: false, signMessage: (message) => provider.request({ method: 'personal_sign', params: [message, connected] }) };
  }
  if (!appStore.get().demoMode) throw new Error(t('mystery_evm_wallet_required'));
  if (!mysteryState.signer?.demo) {
    const { Wallet } = await web3.loadEthers();
    const wallet = Wallet.createRandom();
    mysteryState.signer = { address: wallet.address, demo: true, signMessage: wallet.signMessage.bind(wallet) };
  }
  return mysteryState.signer;
}

function setStep(stepId, status = 'pending', label = '—') {
  mysteryState.steps = { ...mysteryState.steps, [stepId]: { status, label } };
  publish();
}

function setMysteryBoxMotion(phase = 'idle') {
  mysteryState.boxMotion = phase;
  publish();
}

function setPaymentNote(text, tone = '') {
  mysteryState.paymentNote = { text, tone };
  publish();
}

// ------------------------------------------------------------------------------------------ passports

function passportWallet() {
  return mysteryState.signer?.address || web3.connectedAddress() || '';
}

function passportClaimMessage(stampType, walletAddress, revealProofHash, revealId) {
  return [
    'AgentBL Voyage Passport Claim',
    `Reveal: ${String(revealId)}`,
    `Stamp: ${String(stampType)}`,
    `Wallet: ${String(walletAddress).toLowerCase()}`,
    `Proof: ${String(revealProofHash).toLowerCase()}`,
    'This credential is non-transferable and carries no investment or cargo rights.'
  ].join('\n');
}

export function hiddenPassportIds() {
  try { return new Set(JSON.parse(localStorage.getItem('agentbl_hidden_passports') || '[]')); } catch { return new Set(); }
}

function saveHiddenPassportIds(ids) {
  try { localStorage.setItem('agentbl_hidden_passports', JSON.stringify([...ids])); } catch { /* private mode */ }
}

export function passportIsDemo(credential) {
  return String(credential?.experience_mode ?? '').toUpperCase() === 'DEMO';
}

export function passportStampLabel(stampType) {
  return stampType === 'INVESTOR_JOURNEY' ? t('passport_stamp_investor') : t('passport_stamp_discovery');
}

export function passportStampIcon(stampType) {
  return stampType === 'INVESTOR_JOURNEY' ? '◆' : '✦';
}

export function passportShareOrigin() {
  return window.location.origin;
}

export async function loadPassportCollection(wallet = passportWallet()) {
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/u.test(wallet)) return;
  try {
    const { body } = await fetchJson(`/api/mystery/passports?wallet_address=${encodeURIComponent(wallet)}`);
    mysteryState.passports = Array.isArray(body.credentials) ? body.credentials : [];
    publish();
  } catch (error) {
    if (error.status !== 404) toast(error.message, true);
  }
}

export function togglePassportHidden(credentialId) {
  const ids = hiddenPassportIds();
  if (ids.has(credentialId)) ids.delete(credentialId); else ids.add(credentialId);
  saveHiddenPassportIds(ids);
  publish();
}

export function setShowHidden(value) {
  mysteryState.showHiddenPassports = value;
  publish();
}

export async function claimPassport(stampType) {
  if (!mysteryState.report || !mysteryState.proofValid) {
    toast(t('mystery_proof_failed'), true);
    return;
  }
  const wallet = await resolveSigner();
  mysteryState.busy = { ...mysteryState.busy, [stampType]: true };
  publish();
  try {
    const message = passportClaimMessage(stampType, wallet.address, mysteryState.report.reveal_proof_hash, mysteryState.report.reveal_id);
    // The claim API is called only after the wallet signed the claim.
    const signature = await wallet.signMessage(message);
    const { body } = await fetchJson(`/api/mystery/${encodeURIComponent(mysteryState.report.reveal_id)}/passport/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address, stamp_type: stampType, claim_signature: signature })
    });
    const credential = body.credential;
    if (credential) {
      const publicPayment = mysteryState.report?.payment?.live === true
        ? { txHash: mysteryState.report.payment.txHash, explorerUrl: mysteryState.report.payment.explorerUrl }
        : null;
      mysteryState.passports = [...mysteryState.passports.filter((item) => item.credential_id !== credential.credential_id), { ...credential, share: body.share, _publicPayment: publicPayment }];
      mysteryState.claimed = { ...mysteryState.claimed, [stampType]: true };
      toast(t('passport_claim_success'));
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    mysteryState.busy = { ...mysteryState.busy, [stampType]: false };
    publish();
  }
}

export function openPassportShare(credential) {
  mysteryState.selectedPassport = credential;
  mysteryState.share = { nickname: '', advanced: false, confirmed: false };
  mysteryState.shareOpen = true;
  renderPassportSharePreview();
}

export function closePassportShare() {
  mysteryState.shareOpen = false;
  publish();
}

export function advancedShareAvailable(credential) {
  return !passportIsDemo(credential) && Boolean(credential?._publicPayment);
}

export function updateShare(patch) {
  const next = { ...mysteryState.share, ...patch };
  if (!next.advanced) next.confirmed = false;
  mysteryState.share = next;
  renderPassportSharePreview();
}

function renderPassportSharePreview() {
  const credential = mysteryState.selectedPassport;
  if (!credential) return;
  const includePublicTx = Boolean(mysteryState.share.advanced && mysteryState.share.confirmed);
  const payment = credential._publicPayment ?? {};
  const card = buildPassportShareCard(credential.share ?? credential, {
    origin: passportShareOrigin(),
    nickname: mysteryState.share.nickname,
    includePublicTx,
    advancedConfirmed: includePublicTx,
    publicTxHash: payment.txHash,
    explorerUrl: payment.explorerUrl
  });
  assertSafePassportShareCard(card);
  mysteryState.shareCard = card;
  publish();
}

export function shareText() {
  return mysteryState.shareCard ? buildPassportShareText(mysteryState.shareCard) : '';
}

function downloadBlob(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportPassportJson() {
  if (!mysteryState.shareCard) renderPassportSharePreview();
  downloadBlob(`${mysteryState.shareCard?.credential_id || 'voyage-passport'}.json`, 'application/json', JSON.stringify(mysteryState.shareCard, null, 2));
}

export function exportPassportPng() {
  const card = mysteryState.shareCard;
  if (!card) return;
  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 760;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#93b4ff'; ctx.font = '700 34px system-ui'; ctx.fillText(`${passportStampIcon(card.stamp_type)} ${passportStampLabel(card.stamp_type)}`, 70, 90);
  ctx.fillStyle = '#f8fafc'; ctx.font = '700 58px system-ui'; ctx.fillText(card.voyage_id, 70, 180);
  ctx.fillStyle = '#cbd5e1'; ctx.font = '28px system-ui'; ctx.fillText(`${card.cargo_category} · ${card.route_label}`, 70, 240);
  ctx.fillText(`${card.experience_mode} · ${card.reveal_date}`, 70, 300);
  ctx.fillStyle = '#f8fafc'; ctx.font = '22px system-ui';
  const lines = ctx.measureText(card.notice).width > 1000 ? [card.notice.slice(0, 85), card.notice.slice(85)] : [card.notice];
  lines.forEach((line, index) => ctx.fillText(line, 70, 625 + index * 30));
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = `${card.credential_id || 'voyage-passport'}.png`;
  link.click();
}

export function printPassport() {
  if (!mysteryState.shareCard) renderPassportSharePreview();
  window.print();
}

// ------------------------------------------------------------------------------------------ the round

export function setTier(tier) {
  mysteryState.tier = TIER_META[tier] ? tier : 'BALANCED';
  resetMysteryExperience({ preserveSigner: true });
}

export async function createPreview() {
  mysteryState.busy = { ...mysteryState.busy, preview: true };
  publish();
  try {
    mysteryState.signer = await resolveSigner();
    const idempotencyKey = `web-${appStore.get().modeGeneration}-${crypto.randomUUID?.() ?? randomHex32().slice(2)}`;
    const { body } = await fetchJson('/api/mystery/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: mysteryState.signer.address, idempotency_key: idempotencyKey, risk_passport: { tier: mysteryState.tier } })
    });
    Object.assign(mysteryState, {
      preview: body, report: null, canonicalProof: null, proofText: '', proofResult: null, proofValid: false, subscription: null,
      steps: idleSteps(), reveal: 'hidden', boxMotion: 'idle', claimed: { DISCOVERY: false, INVESTOR_JOURNEY: false },
      paymentNote: { text: appStore.get().demoMode ? t('mystery_demo_receipt_note') : t('mystery_live_settlement_note'), tone: '' }
    });
    mysteryState.steps.commit = { status: 'done', label: t('mystery_frozen') };
    await loadPassportCollection(mysteryState.signer.address);
    mysteryState.modal = true;
  } catch (error) {
    toast(error.message, true);
  } finally {
    mysteryState.busy = { ...mysteryState.busy, preview: false };
    publish();
  }
}

export function closeMysteryModal() {
  mysteryState.modal = false;
  publish();
}

/** The price the server itself lists for a paid service, in atomic USDC (6 decimals). */
async function listedPriceAtomic(serviceId) {
  const response = await fetch('/api/x402/config');
  const config = await response.json().catch(() => ({}));
  const service = (config.services ?? []).find((entry) => entry.serviceId === serviceId);
  return service ? Math.round(Number(service.priceUSDC) * 1_000_000) : undefined;
}

/** Live mode: pay with the connected wallet through the x402 V2 gateway (EIP-3009 authorization settled by the facilitator). */
async function payMysteryVoyageLive(endpoint, body) {
  const provider = web3.getEthereumProvider();
  const from = mysteryState.signer?.address;
  if (!provider || !from || mysteryState.signer?.demo) throw new Error(t('mystery_evm_wallet_required'));
  const expectedAmountAtomic = await listedPriceAtomic('mystery-voyage');
  const { response, challenge } = await payV2WithWallet({
    endpoint, body, provider, from, expectedAmountAtomic,
    onStage: (stage) => {
      if (stage === 'sign') {
        setStep('challenge', 'done', 'HTTP 402');
        setStep('settlement', 'active', t('mystery_signing_payment'));
        setPaymentNote(t('x402_live_sign_prompt'));
      }
    }
  });
  const report = await response.json().catch(() => ({}));
  if (!challenge && response.status === 402) throw new Error(t('mystery_live_v2_required'));
  if (!response.ok) throw new Error(report.error || t('mystery_payment_failed'));
  return report;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openMysteryVoyage() {
  if (!mysteryState.preview || !mysteryState.signer) return;
  mysteryState.busy = { ...mysteryState.busy, open: true };
  const userNonce = randomHex32();
  const reduceMotion = prefersReducedMotion();
  setMysteryBoxMotion('unlocking');
  try {
    setStep('challenge', 'active', t('mystery_requesting_402'));
    setPaymentNote(t('mystery_requesting_402'));
    const endpoint = '/api/x402/mystery/voyage';
    let report;
    if (appStore.get().demoMode) {
      const unpaid = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ reveal_id: mysteryState.preview.reveal_id, user_nonce: userNonce })
      });
      const challenge = await unpaid.json().catch(() => ({}));
      if (unpaid.status !== 402 || !challenge.challenge || !challenge.nonce) throw new Error(challenge.error || t('mystery_live_v2_required'));
      setStep('challenge', 'done', 'HTTP 402');
      setStep('settlement', 'active', t('mystery_signing_payment'));
      setPaymentNote(t('mystery_signing_payment'));
      const signature = await mysteryState.signer.signMessage(challenge.challenge);
      const paid = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X402-Signature': signature, 'X402-Signer': mysteryState.signer.address },
        body: JSON.stringify({ reveal_id: mysteryState.preview.reveal_id, user_nonce: userNonce, nonce: challenge.nonce })
      });
      report = await paid.json().catch(() => ({}));
      if (!paid.ok) throw new Error(report.error || t('mystery_payment_failed'));
    } else {
      report = await payMysteryVoyageLive(endpoint, { reveal_id: mysteryState.preview.reveal_id, user_nonce: userNonce });
    }
    mysteryState.report = report;
    setStep('settlement', 'done', report.payment?.live ? t('mystery_onchain') : t('mystery_demo_receipt'));
    setPaymentNote(report.payment?.live ? t('mystery_live_settlement_note') : t('mystery_demo_receipt_note'));
    setStep('reveal', 'active', t('mystery_opening'));
    setMysteryBoxMotion('bursting');
    await wait(reduceMotion ? 0 : 520);
    mysteryState.reveal = 'opening';
    publish();
    await wait(reduceMotion ? 0 : 1250);
    mysteryState.reveal = 'open';
    setStep('reveal', 'done', t('mystery_revealed'));
    setMysteryBoxMotion();
    await loadAndVerifyProof();
  } catch (error) {
    setMysteryBoxMotion();
    const stage = mysteryState.steps.settlement.status === 'active' ? 'settlement' : 'challenge';
    setStep(stage, 'error', t('mystery_failed'));
    setPaymentNote(error.message, 'crit');
    toast(error.message, true);
  } finally {
    mysteryState.busy = { ...mysteryState.busy, open: false };
    publish();
  }
}

// Keep the two quoted document values verbatim; surrounding report copy remains localizable.
export function riskFactorSegments(value) {
  const text = String(value);
  const match = text.match(/^(doc: Incoterms agreement \(eBL\/invoice\): eBL ")([^"]*)(" vs invoice ")([^"]*)(")$/u);
  if (!match) return [{ text: tData(text) }];
  return [
    { text: tData(match[1]) },
    { text: match[2], source: 'bill_of_lading.incoterms' },
    { text: tData(match[3]) },
    { text: match[4], source: 'commercial_invoice.incoterms' },
    { text: match[5] }
  ];
}

/** A Live payment with a real transaction hash and an explorer link from the chain layer gets a link. */
export function paymentEvidence(report) {
  const payment = report.payment ?? {};
  const tx = payment.txHash || report.proof?.payment_tx_hash;
  if (payment.live === true && /^0x[0-9a-fA-F]{64}$/u.test(String(tx)) && payment.explorerUrl) return { href: payment.explorerUrl, text: `${shortHash(tx)} ↗` };
  return { href: null, text: `${t('mystery_demo_receipt')} · ${shortHash(tx)}` };
}

async function loadAndVerifyProof() {
  setStep('verify', 'active', t('mystery_verifying'));
  const { body } = await fetchJson(`/api/mystery/${encodeURIComponent(mysteryState.preview.reveal_id)}/proof`);
  mysteryState.canonicalProof = body.proof;
  mysteryState.proofText = JSON.stringify(body.proof, null, 2);
  publish();
  await verifyEditedProof();
}

export function editProof(text) {
  mysteryState.proofText = text;
  publish();
  verifyEditedProof();
}

export function resetProof() {
  if (!mysteryState.canonicalProof) return;
  editProof(JSON.stringify(mysteryState.canonicalProof, null, 2));
}

async function verifyEditedProof() {
  const version = ++mysteryState.proofVersion;
  mysteryState.proofResult = { checking: true };
  publish();
  let proof;
  try {
    proof = JSON.parse(mysteryState.proofText);
  } catch (error) {
    renderProofResult({ valid: false, errors: [`JSON: ${error.message}`], summary: null }, version);
    return;
  }
  const result = await verifyMysteryProof(proof, { report: mysteryState.report, envelope: mysteryState.report?.report_envelope });
  renderProofResult(result, version);
}

function renderProofResult(result, version) {
  if (version !== mysteryState.proofVersion) return;
  mysteryState.proofResult = result;
  mysteryState.proofValid = Boolean(result.valid);
  if (result.valid) setStep('verify', 'done', t('mystery_verified'));
  else setStep('verify', 'error', t('mystery_fail_closed'));
}

// ------------------------------------------------------------------------------------------ subscription

export function confirmationAuthorized() {
  const report = mysteryState.report;
  return isIndependentSubscriptionAuthorized({
    amountUsd: Number(mysteryState.confirm.amount),
    acknowledged: mysteryState.confirm.ack,
    report,
    selectedPoolId: report?.selected_pool_id
  });
}

export function openSubscriptionConfirmation() {
  if (!mysteryState.report || !mysteryState.proofValid) {
    toast(t('mystery_proof_failed'), true);
    return;
  }
  mysteryState.confirm = { ...mysteryState.confirm, ack: false, result: '', tone: '' };
  mysteryState.subscriptionSignature = null;
  mysteryState.subscribeOpen = true;
  publish();
}

export function closeSubscriptionConfirmation() {
  mysteryState.subscribeOpen = false;
  publish();
}

export function updateConfirmation(patch) {
  mysteryState.confirm = { ...mysteryState.confirm, ...patch };
  publish();
}

function subscriptionAuthorizationMessage(amountUsd) {
  const report = mysteryState.report;
  return [
    'AgentBL Independent RWA Subscription Authorization',
    `Pool: ${report.selected_pool_id}`,
    `Amount USD: ${amountUsd}`,
    `Risk: ${report.risk?.level} (${report.risk?.score_bps} bps)`,
    `Stress loss: ${formatPct(report.risk?.stress_loss_pct, 2)}`,
    `Reveal proof: ${report.reveal_proof_hash}`,
    'This authorization is independent from the Mystery Voyage report purchase.'
  ].join('\n');
}

export async function confirmSubscription() {
  const report = mysteryState.report;
  const amountUsd = Number(mysteryState.confirm.amount);
  if (!confirmationAuthorized()) return;
  mysteryState.busy = { ...mysteryState.busy, subscribe: true };
  updateConfirmation({ result: t('mystery_signing_subscription'), tone: '' });
  try {
    // The pool API is called only after this independent second signature succeeds.
    mysteryState.subscriptionSignature = await mysteryState.signer.signMessage(subscriptionAuthorizationMessage(amountUsd));
    const { body } = await fetchJson('/api/pool/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: mysteryState.signer.address,
        pool_id: report.selected_pool_id,
        amount_usd: amountUsd,
        mystery_source: {
          reveal_id: report.reveal_id,
          selected_pool_id: report.selected_pool_id,
          reveal_proof_hash: report.reveal_proof_hash
        }
      })
    });
    mysteryState.subscription = body;
    updateConfirmation({ result: t('mystery_subscription_success', { tx: shortHash(body.txHash) }), tone: 'ok' });
    window.dispatchEvent(new CustomEvent('agentbl:portfoliochange'));
    await loadPassportCollection(mysteryState.signer.address);
    mysteryState.subscribeOpen = false;
    toast(t('mystery_subscription_complete'));
  } catch (error) {
    updateConfirmation({ result: error.message, tone: 'crit' });
  } finally {
    mysteryState.busy = { ...mysteryState.busy, subscribe: false };
    publish();
  }
}

export function resetMysteryExperience(options = {}) {
  Object.assign(mysteryState, {
    preview: null, report: null, canonicalProof: null, proofText: '', proofResult: null, proofValid: false,
    subscriptionSignature: null, subscription: null, steps: idleSteps(), boxMotion: 'idle', reveal: 'hidden',
    modal: false, subscribeOpen: false, paymentNote: { text: '', tone: '' }, claimed: { DISCOVERY: false, INVESTOR_JOURNEY: false }
  });
  if (!options.preserveSigner) mysteryState.signer = null;
  publish();
}

if (typeof window !== 'undefined') {
  // A new runtime (mode switch, demo reset) closes any open round.
  window.addEventListener('agentbl:runtimechange', () => resetMysteryExperience());
}
