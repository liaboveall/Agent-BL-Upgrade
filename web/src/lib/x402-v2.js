// Browser-side x402 V2 payment (Live mode): sign an EIP-3009 transferWithAuthorization
// with the user's wallet (eth_signTypedData_v4) and retry the request with the
// PAYMENT-SIGNATURE header. The construction mirrors @injectivelabs/x402's own client
// (same EIP-712 domain, types, time window and header encoding) so the gateway and the
// facilitator treat browser payments exactly like payments from the official client.
//
// Everything except payV2WithWallet's network/wallet calls is a pure function so it can
// be unit-tested in Node (see tests/x402BrowserV2.test.js).

export const SUPPORTED_NETWORKS = Object.freeze(['eip155:1439', 'eip155:1776']);

export const TRANSFER_WITH_AUTHORIZATION_TYPE = Object.freeze([
  Object.freeze({ name: 'from', type: 'address' }),
  Object.freeze({ name: 'to', type: 'address' }),
  Object.freeze({ name: 'value', type: 'uint256' }),
  Object.freeze({ name: 'validAfter', type: 'uint256' }),
  Object.freeze({ name: 'validBefore', type: 'uint256' }),
  Object.freeze({ name: 'nonce', type: 'bytes32' })
]);

const EIP712_DOMAIN_TYPE = Object.freeze([
  Object.freeze({ name: 'name', type: 'string' }),
  Object.freeze({ name: 'version', type: 'string' }),
  Object.freeze({ name: 'chainId', type: 'uint256' }),
  Object.freeze({ name: 'verifyingContract', type: 'address' })
]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const ATOMIC_RE = /^[1-9][0-9]*$/u;
const NAME_SELECTOR = '0x06fdde03'; // ERC-20 name()

export class X402V2Error extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'X402V2Error';
    this.code = code;
    this.cause = options.cause;
  }
}

export function isV2Challenge(body) {
  return body?.x402Version === 2 && Array.isArray(body.accepts) && body.accepts.length > 0;
}

/**
 * Choose the payment requirement to sign and refuse anything unexpected BEFORE the wallet
 * is asked for a signature: an allowed network, well-formed fields, and (when known) the
 * exact price the UI displayed.
 */
export function pickRequirement(challenge, { allowedNetworks = SUPPORTED_NETWORKS, expectedAmountAtomic } = {}) {
  if (!isV2Challenge(challenge)) throw new X402V2Error('not_v2', 'The 402 response is not an x402 V2 challenge');
  const requirement = challenge.accepts.find((entry) => entry?.scheme === 'exact' && allowedNetworks.includes(entry.network));
  if (!requirement) {
    throw new X402V2Error('network_not_allowed', `No acceptable payment option (allowed: ${allowedNetworks.join(', ')})`);
  }
  if (!ADDRESS_RE.test(String(requirement.asset)) || !ADDRESS_RE.test(String(requirement.payTo))) {
    throw new X402V2Error('requirement_invalid', 'The payment requirement has an invalid asset or recipient address');
  }
  if (!ATOMIC_RE.test(String(requirement.amount))) {
    throw new X402V2Error('requirement_invalid', 'The payment requirement has an invalid amount');
  }
  const timeout = Number(requirement.maxTimeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) {
    throw new X402V2Error('requirement_invalid', 'The payment requirement has an invalid timeout');
  }
  if (expectedAmountAtomic !== undefined && String(requirement.amount) !== String(expectedAmountAtomic)) {
    throw new X402V2Error(
      'price_mismatch',
      `The server asks for ${requirement.amount} atomic USDC but ${expectedAmountAtomic} was displayed; refusing to sign`
    );
  }
  return requirement;
}

export function randomNonce(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Same window as the official client: valid from now-10s for maxTimeoutSeconds. */
export function buildAuthorization({ requirement, from, nowSeconds, nonce }) {
  if (!ADDRESS_RE.test(String(from))) throw new X402V2Error('wallet_invalid', 'The paying wallet address is invalid');
  return {
    from,
    to: requirement.payTo,
    value: String(requirement.amount),
    validAfter: String(nowSeconds - 10),
    validBefore: String(nowSeconds + Number(requirement.maxTimeoutSeconds)),
    nonce
  };
}

export function buildTypedData({ requirement, tokenName, authorization }) {
  const chainId = Number(String(requirement.network).split(':')[1]);
  return {
    domain: {
      name: tokenName,
      version: String(requirement.extra?.version ?? '2'),
      chainId,
      verifyingContract: requirement.asset
    },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPE.map((field) => ({ ...field })) },
    primaryType: 'TransferWithAuthorization',
    message: authorization
  };
}

/** The JSON string eth_signTypedData_v4 expects (EIP712Domain must be spelled out). */
export function toWalletTypedDataJson(typedData) {
  return JSON.stringify({
    types: { EIP712Domain: EIP712_DOMAIN_TYPE.map((field) => ({ ...field })), ...typedData.types },
    primaryType: typedData.primaryType,
    domain: typedData.domain,
    message: typedData.message
  });
}

export function buildPaymentPayload({ requirement, authorization, signature }) {
  return { x402Version: 2, accepted: requirement, payload: { signature, authorization } };
}

/** base64(JSON) as the PAYMENT-SIGNATURE header; UTF-8 safe. */
export function encodePaymentHeader(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode an ABI-encoded `string` return value (what name() returns). */
export function decodeAbiString(hex) {
  const data = String(hex ?? '').replace(/^0x/u, '');
  if (data.length < 128) throw new X402V2Error('token_name_invalid', 'The token returned an invalid name()');
  const offset = Number.parseInt(data.slice(0, 64), 16) * 2;
  const length = Number.parseInt(data.slice(offset, offset + 64), 16);
  const body = data.slice(offset + 64, offset + 64 + length * 2);
  if (!Number.isFinite(length) || body.length !== length * 2) {
    throw new X402V2Error('token_name_invalid', 'The token returned a malformed name()');
  }
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

/** The EIP-712 domain name is the token's on-chain name(): read it, never trust a server hint. */
export async function readTokenName(provider, asset) {
  const result = await provider.request({ method: 'eth_call', params: [{ to: asset, data: NAME_SELECTOR }, 'latest'] });
  return decodeAbiString(result);
}

/**
 * Pay an x402 V2 endpoint with the user's wallet.
 * @param {object} options
 * @param {string} options.endpoint
 * @param {object} options.body            JSON request body (sent unpaid and again with the payment)
 * @param {{request: Function}} options.provider  EIP-1193 wallet provider
 * @param {string} options.from            the paying account
 * @param {string|number} [options.expectedAmountAtomic]  price the UI displayed
 * @param {(stage: 'challenge'|'sign'|'settle') => void} [options.onStage]
 * @returns {Promise<{ response: Response, challenge: object|null, requirement?: object, authorization?: object }>}
 */
export async function payV2WithWallet({
  endpoint,
  body,
  provider,
  from,
  expectedAmountAtomic,
  onStage,
  fetchImpl = globalThis.fetch.bind(globalThis),
  now = () => Math.floor(Date.now() / 1000),
  nonce = randomNonce
}) {
  const request = (headers = {}) => fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body ?? {})
  });

  onStage?.('challenge');
  const unpaid = await request();
  if (unpaid.status !== 402) return { response: unpaid, challenge: null }; // free, or rejected before payment

  const challenge = await unpaid.json().catch(() => null);
  const requirement = pickRequirement(challenge, { expectedAmountAtomic });
  const tokenName = await readTokenName(provider, requirement.asset);
  const authorization = buildAuthorization({ requirement, from, nowSeconds: now(), nonce: nonce() });

  onStage?.('sign');
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [from, toWalletTypedDataJson(buildTypedData({ requirement, tokenName, authorization }))]
  });

  onStage?.('settle');
  const header = encodePaymentHeader(buildPaymentPayload({ requirement, authorization, signature }));
  const response = await request({ 'PAYMENT-SIGNATURE': header, 'X-PAYMENT': header });
  return { response, challenge, requirement, authorization };
}
