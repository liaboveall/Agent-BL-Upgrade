// Browser web3 integration for AgentBL.
//
// Target: Injective EVM Testnet (chainId 1439)
//
// Reads /application-config.json at runtime to determine the target network.
// Wallet connection auto-detects the chain and prompts the user to switch.
//
// ethers v6 (and, for Keplr/Leap, @cosmjs/stargate) are loaded lazily, only when the
// user connects a wallet. Both are self-hosted under /vendor (see
// public/vendor/manifest.json and `npm run vendor:check`): a wallet-connected page
// must not execute third-party scripts fetched from a CDN at runtime, and the CSP
// only allows same-origin scripts.

import { priceToE6 } from './format.js';
import { resolveApplicationConfig } from '../../../src/chain/applicationConfig.js';
const ETHERS_MODULE_URL = '/vendor/ethers-6.17.0.min.js';
const COSMOS_STARGATE_MODULE_URL = '/vendor/cosmjs-stargate-0.33.1.js';

// --- Chain presets ---
const CHAIN_PRESETS = {
  injective_testnet: {
    chainName: 'Injective EVM Testnet',
    nativeCurrency: {
      name: 'INJ',
      symbol: 'INJ',
      decimals: 18
    },
    rpcUrls: ['https://k8s.testnet.json-rpc.injective.network', 'https://testnet.sentry.chain.json-rpc.injective.network'],
    blockExplorerUrls: ['https://testnet.blockscout.injective.network'],
    faucetUrl: 'https://testnet.faucet.injective.network/'
  }
};

// --- module-level caches ---
let _ethers = null;
let _cosmosStargate = null;
let _registry = null;
let _config = null;
let _activeNetworkKey = null;
let _session = null; // { kind, walletType, provider, signer, address }
let _cachedProvider = null; // selected EIP-1193 provider

function injectedEvmProviders() {
  if (typeof window === 'undefined') return null;
  const primary = window.ethereum;
  const candidates = [...(Array.isArray(primary?.providers) ? primary.providers : []), primary, window.okxwallet, window.trustwallet, window.bitkeep, window.bitget, window.rabby, window.tokenpocket];
  return [...new Set(candidates.filter(provider => provider?.request))];
}
export function walletAvailability() {
  const providers = injectedEvmProviders() ?? [];
  return {
    metamask: providers.some(provider => provider.isMetaMask && !provider.isRabby) || providers.length > 0,
    keplr: typeof window !== 'undefined' && Boolean(window.keplr?.enable),
    leap: typeof window !== 'undefined' && Boolean(window.leap?.enable)
  };
}
function providerForWallet(walletType) {
  if (typeof window === 'undefined') return null;
  if (walletType === 'keplr') return window.keplr?.enable ? window.keplr : null;
  if (walletType === 'leap') return window.leap?.enable ? window.leap : null;
  const providers = injectedEvmProviders() ?? [];
  return providers.find(provider => provider.isMetaMask && !provider.isRabby) ?? providers[0] ?? null;
}

/** Return the selected EIP-1193 provider; only MetaMask uses this path. */
export function getEthereumProvider() {
  if (_session?.kind === 'evm') return _session.provider;
  if (_cachedProvider) return _cachedProvider;
  _cachedProvider = providerForWallet('metamask');
  return _cachedProvider;
}

/** Lazy-load the self-hosted ethers v6 build (cached). */
export async function loadEthers() {
  if (_ethers) return _ethers;
  if (typeof globalThis !== 'undefined' && globalThis._mockEthers) return globalThis._mockEthers;
  try {
    _ethers = await import(/* @vite-ignore */ETHERS_MODULE_URL);
    return _ethers;
  } catch (cause) {
    throw new Error('Failed to load ethers: ' + (cause?.message ?? 'unknown'), {
      cause
    });
  }
}
async function loadCosmosStargate() {
  if (_cosmosStargate) return _cosmosStargate;
  try {
    _cosmosStargate = await import(/* @vite-ignore */COSMOS_STARGATE_MODULE_URL);
    return _cosmosStargate;
  } catch (cause) {
    throw err('SDK_LOAD', `Failed to load Cosmos signing SDK: ${cause?.message ?? 'unknown'}`);
  }
}
export function resolveBrowserChainConfig(registry, requestedNetwork) {
  return resolveApplicationConfig(registry, requestedNetwork);
}

/** Load /application-config.json and resolve the active network without discarding the registry. */
export async function loadChainConfig(requestedNetwork) {
  const key = requestedNetwork || _activeNetworkKey;
  if (_config && (!key || _config.key === key)) return _config;
  try {
    if (!_registry) {
      const res = await fetch('/application-config.json', {
        cache: 'no-store'
      });
      if (!res.ok) return null;
      _registry = await res.json();
    }
    _activeNetworkKey = key || _registry.defaultNetwork || 'injective-testnet';
    _config = resolveBrowserChainConfig(_registry, _activeNetworkKey);
    return _config;
  } catch {
    return null;
  }
}
export async function configuredNetworks() {
  await loadChainConfig();
  return Object.entries(_registry?.networks ?? {}).map(([key, value]) => ({
    key,
    displayName: value.displayName ?? key,
    chainId: value.chainId,
    deployed: Object.values(value.contracts ?? {}).some(isAddress)
  }));
}
export async function selectNetwork(networkKey) {
  if (_session) throw err('WALLET_CONNECTED', 'Disconnect the wallet before switching application networks');
  _activeNetworkKey = networkKey;
  _config = null;
  return loadChainConfig(networkKey);
}

/** Return the chain preset for the configured network (falls back to injective_testnet). */
function getPreset(cfg) {
  if (cfg?.rpcUrls?.length) {
    return {
      chainName: cfg.displayName,
      nativeCurrency: cfg.nativeCurrency,
      rpcUrls: cfg.rpcUrls,
      blockExplorerUrls: [cfg.explorerBase]
    };
  }
  const net = cfg?.network || 'injective_testnet';
  return CHAIN_PRESETS[net] || CHAIN_PRESETS.injective_testnet;
}
const isAddress = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

/** True when a real contract address is configured (deploy script has run). */
export async function isRealChainConfigured() {
  const cfg = await loadChainConfig();
  return Boolean(cfg && isAddress(cfg.contracts?.RightsController));
}
export function hasInjectedWallet() {
  return Object.values(walletAvailability()).some(Boolean);
}
export function isWalletConnected() {
  return Boolean(_session?.address);
}
export function connectedAddress() {
  return _session?.address ?? null;
}

/** Current browser wallet only; never contains a server-side signing key. */
export function currentWalletSession() {
  return _session;
}
export function connectedWalletType() {
  return _session?.walletType ?? null;
}
function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Attempt silent reconnection using saved wallet type (for MetaMask: eth_accounts; for Keplr/Leap: restore native signer).
 * @returns {Promise<{address:string,walletType:string,kind:string}|null>} session info or null if no saved wallet or silent reconnect fails
 */
export async function restoreWalletSession() {
  let savedType;
  try {
    savedType = window.localStorage?.getItem('agentbl.walletType');
  } catch {/* */}
  if (!savedType) return null;
  const wallet = providerForWallet(savedType);
  if (!wallet) return null;
  const cfg = await loadChainConfig();
  try {
    if (savedType === 'keplr' || savedType === 'leap') {
      const cosmosChainId = cfg?.cosmosChainId;
      if (!cosmosChainId) return null;
      const signer = wallet.getOfflineSigner(cosmosChainId);
      const accounts = await signer.getAccounts();
      if (!accounts[0]?.address) return null;
      _session = {
        kind: 'cosmos',
        walletType: savedType,
        provider: wallet,
        signer,
        address: accounts[0].address,
        cosmosChainId
      };
      if (typeof window !== 'undefined' && !window._agentblCosmosWalletWired) {
        window._agentblCosmosWalletWired = true;
        window.addEventListener('keplr_keystorechange', () => clearWalletSession('account'));
        window.addEventListener('leap_keystorechange', () => clearWalletSession('account'));
      }
    } else {
      const accounts = await wallet.request({
        method: 'eth_accounts'
      });
      if (!accounts || accounts.length === 0) return null;
      const ethers = await loadEthers();
      _cachedProvider = wallet;
      const provider = new ethers.BrowserProvider(wallet);
      const signer = await provider.getSigner();
      _session = {
        kind: 'evm',
        walletType: 'metamask',
        provider: wallet,
        browserProvider: provider,
        signer,
        address: await signer.getAddress()
      };
      if (!wallet._agentblWired) {
        wallet._agentblWired = true;
        wallet.on?.('accountsChanged', () => clearWalletSession('account'));
        wallet.on?.('chainChanged', () => clearWalletSession('network'));
      }
    }
    emitWalletChange('restored');
    return {
      address: _session.address,
      walletType: _session.walletType,
      kind: _session.kind
    };
  } catch {
    return null;
  }
}

/** Ensure the wallet is on the target chain (from application-config.json), adding the network if unknown (EIP-3085). */
async function ensureTargetChain(eth) {
  const cfg = await loadChainConfig();
  const preset = getPreset(cfg);
  const targetHex = cfg?.chainId || '0x59F'; // default: Injective Testnet

  const current = await eth.request({
    method: 'eth_chainId'
  });
  if (current === targetHex) return;
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{
        chainId: targetHex
      }]
    });
  } catch (switchErr) {
    if (switchErr?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: targetHex,
          chainName: preset.chainName,
          nativeCurrency: preset.nativeCurrency,
          rpcUrls: preset.rpcUrls,
          blockExplorerUrls: preset.blockExplorerUrls
        }]
      });
    } else {
      throw switchErr;
    }
  }
}

/**
 * Connect one explicit wallet. MetaMask signs EVM calls; Keplr/Leap use their
 * Cosmos-native Injective signer and never masquerade as window.ethereum.
 * @returns {Promise<{address:string,walletType:string,kind:string}>}
 * @throws {Error} with .code: NO_WALLET | REJECTED | NETWORK
 */
export async function connectWallet(walletType = 'metamask') {
  const wallet = providerForWallet(walletType);
  if (!wallet) throw err('NO_WALLET', `${walletType} wallet extension was not detected`);
  const cfg = await loadChainConfig();
  if (walletType === 'keplr' || walletType === 'leap') {
    const cosmosChainId = cfg?.cosmosChainId;
    if (!cosmosChainId) throw err('NETWORK_CONFIG', 'Cosmos chain ID is missing from application configuration');
    try {
      await wallet.enable(cosmosChainId);
      const signer = wallet.getOfflineSigner(cosmosChainId);
      const accounts = await signer.getAccounts();
      if (!accounts[0]?.address) throw err('NO_ACCOUNT', `${walletType} returned no Injective account`);
      _session = {
        kind: 'cosmos',
        walletType,
        provider: wallet,
        signer,
        address: accounts[0].address,
        cosmosChainId
      };
    } catch (error) {
      if (error?.code === 4001 || /reject|denied/iu.test(error?.message ?? '')) {
        throw err('REJECTED', `User rejected the ${walletType} connection`);
      }
      throw error;
    }
    if (typeof window !== 'undefined' && !window._agentblCosmosWalletWired) {
      window._agentblCosmosWalletWired = true;
      window.addEventListener('keplr_keystorechange', () => clearWalletSession('account'));
      window.addEventListener('leap_keystorechange', () => clearWalletSession('account'));
    }
  } else {
    const ethers = await loadEthers();
    try {
      await wallet.request({
        method: 'eth_requestAccounts'
      });
      await ensureTargetChain(wallet);
    } catch (error) {
      if (error?.code === 4001) throw err('REJECTED', 'User rejected the wallet or network request');
      throw err('NETWORK', `Unable to connect to the configured network: ${error?.message ?? error}`);
    }
    _cachedProvider = wallet;
    const provider = new ethers.BrowserProvider(wallet);
    const signer = await provider.getSigner();
    _session = {
      kind: 'evm',
      walletType: 'metamask',
      provider: wallet,
      browserProvider: provider,
      signer,
      address: await signer.getAddress()
    };
    if (!wallet._agentblWired) {
      wallet._agentblWired = true;
      wallet.on?.('accountsChanged', () => clearWalletSession('account'));
      wallet.on?.('chainChanged', () => clearWalletSession('network'));
    }
  }
  try {
    window.localStorage?.setItem('agentbl.walletType', walletType);
  } catch {/* storage optional */}
  emitWalletChange('connected');
  return {
    address: _session.address,
    walletType: _session.walletType,
    kind: _session.kind
  };
}
function emitWalletChange(reason) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  const detail = {
    reason,
    address: _session?.address ?? null,
    walletType: _session?.walletType ?? null
  };
  const EventConstructor = window.CustomEvent ?? globalThis.CustomEvent;
  if (EventConstructor) window.dispatchEvent(new EventConstructor('agentbl:walletchange', {
    detail
  }));
}
function clearWalletSession(reason) {
  _session = null;
  emitWalletChange(reason);
}
export function __resetWeb3ForTests() {
  _ethers = null;
  _cosmosStargate = null;
  _registry = null;
  _config = null;
  _activeNetworkKey = null;
  _session = null;
  _cachedProvider = null;
}

/**
 * Disconnect the wallet: drop the cached signer session and, when the provider
 * supports it (EIP-2255), ask it to revoke this site's eth_accounts permission
 * so a later "connect" re-prompts instead of silently re-attaching. Best-effort:
 * the local session is always cleared even if the provider can't revoke.
 * @returns {Promise<{revoked:boolean}>}
 */
export async function disconnect() {
  const eth = _session?.kind === 'evm' ? _session.provider : null;
  let revoked = false;
  if (eth?.request) {
    try {
      await eth.request({
        method: 'wallet_revokePermissions',
        params: [{
          eth_accounts: {}
        }]
      });
      revoked = true;
    } catch {
      // Provider doesn't support revoking (or the user dismissed it) — the local
      // session is still cleared below; the wallet just stays authorized.
    }
  }
  clearWalletSession('disconnected');
  try {
    window.localStorage?.removeItem('agentbl.walletType');
  } catch {/* storage optional */}
  return {
    revoked
  };
}
function explorerTx(cfg, hash) {
  const base = cfg?.explorerBase;
  if (!base) return null;
  // Injective explorer uses /tx/ path like Etherscan
  return `${base}/tx/${hash}`;
}

/**
 * Build the on-chain tokenize() arguments from a PricingQuote + financing.
 */

/** Tokens the merchant would receive (floor(financing / issue price)), capped by supply. */
export function mintedTokensFor(quote, financingUsd) {
  const price = Number(quote.final_issue_price_usd) || 1;
  const raw = Math.floor((Number(financingUsd) || 0) / price);
  return Math.min(raw, Math.round(quote.recommended_token_supply || raw));
}

/**
 * Mint on real chain: submit tx, return pending result immediately,
 * then poll a public RPC in background to confirm.
 *
 * Returns { mode:'chain_pending', txHash, ... } right after tx is sent.
 * Calls onConfirmed(confirmedResult) when receipt arrives.
 *
 * @param {Function} [onConfirmed] — receives final result with poolId/blockNumber
 */

/** Best-effort on-chain reprice for View ②'s in-transit events (non-blocking). */

/** Read a pool's RWA balance for an address (returns Number). */

/** Subscribe through the wallet, persisting a v5 funding intent before any signature. */
export async function subscribeOffering(action, {
  assertCurrent = () => {},
  getSession = () => _session,
  getConfig = loadChainConfig,
  ethersFn = loadEthers,
  prepareIntent = prepareCapitalIntent,
  attachIntent = attachCapitalIntent,
  beforeBroadcast = null
} = {}) {
  assertCurrent();
  const session = getSession(),
    cfg = await getConfig(),
    chain = action.chain;
  if (!session || session.kind !== 'evm') throw err('EVM_WALLET_REQUIRED', 'Connect an EVM wallet before confirming');
  if (!chain || chain.chain_id !== cfg.chainIdDecimal || chain.contract.toLowerCase() !== cfg.contracts.RWAOfferingPool?.toLowerCase() || !isAddress(chain.contract) || !Array.isArray(cfg.abis?.RWAOfferingPool)) throw err('NETWORK', 'Offering deployment or network changed');
  const check = async () => {
    assertCurrent();
    if (getSession() !== session) throw err('NO_SESSION', 'Wallet session changed');
    const [network, accounts] = await Promise.all([session.provider.request({
      method: 'eth_chainId'
    }), session.provider.request({
      method: 'eth_accounts'
    })]);
    assertCurrent();
    if (getSession() !== session || BigInt(network) !== BigInt(chain.chain_id) || accounts[0]?.toLowerCase() !== session.address.toLowerCase()) throw err('NETWORK', 'Wallet account or network changed');
  };
  await check();
  const ethers = await ethersFn();
  if (Number(cfg.protocolVersion) !== 5) throw err('PROTOCOL_RETIRED', 'Only controlled v5 subscriptions are supported');
  const abi = (await import('../../../src/chain/protocolV5Abi.js')).protocolAbi('RWAOfferingPool', cfg.abis.RWAOfferingPool);
  const contract = new ethers.Contract(chain.contract, abi, session.signer);
  if (Number(await contract.protocolVersion()) !== 5) throw err('PROTOCOL_CHANGED', 'Capital protocol version changed');
  const [offering, stopped, eligible, version, onChainDeadline] = await Promise.all([contract.offerings(chain.pool_id), contract.emergencyStopped(), contract.isInvestorEligible(session.address, chain.pool_id), contract.quoteVersion(chain.pool_id), contract.subscriptionDeadline(chain.pool_id)]);
  const shares = BigInt(action.shares),
    price = BigInt(chain.price_e6);
  if (chain.quote_version !== undefined && BigInt(chain.quote_version) !== BigInt(version)) throw err('QUOTE_CHANGED', 'The reviewed quote version has changed');
  if (shares <= 0n || !offering.exists || stopped || !eligible || ![2, 3, 6].includes(Number(offering.state))) throw err('POOL_UNAVAILABLE', 'Offering is no longer available to this wallet');
  if (BigInt(offering.issuePrice) !== price || BigInt(offering.tokenSupply) - BigInt(offering.subscribed) < shares) throw err('QUOTE_CHANGED', 'Price or available shares changed; request a new card');
  // Bind payment to the reviewed price, quote version and deadline.
  const block = await session.provider.request({
    method: 'eth_getBlockByNumber',
    params: ['latest', false]
  });
  const now = Number(BigInt(block?.timestamp ?? '0x0'));
  const userDeadline = BigInt(action.deadline ?? now + 600);
  const deadline = onChainDeadline > 0n && onChainDeadline < userDeadline ? onChainDeadline : userDeadline;
  if (now === 0 || BigInt(now) > deadline) throw err('DEADLINE_PASSED', 'The subscription window has closed; request a new card');
  const termsBound = true;
  let intent;
  {
    const asset = offering.settlementAsset;
    if (!isAddress(asset) || chain.settlement_asset && asset.toLowerCase() !== chain.settlement_asset.toLowerCase()) throw err('ASSET_CHANGED', 'Settlement asset changed');
    await check();
    intent = await prepareIntent({
      wallet: session.address,
      chain_pool_id: chain.pool_id,
      shares: String(shares),
      max_unit_price: String(price),
      expected_quote_version: String(version),
      deadline: String(deadline)
    });
    if (intent.asset.toLowerCase() !== asset.toLowerCase() || intent.amount_atomic !== String(shares * price)) throw err('INTENT_CHANGED', 'Saved funding intent differs from the approved terms');
    const usdc = new ethers.Contract(asset, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'], session.signer);
    if (Number(await usdc.decimals()) !== 6) throw err('ASSET_DECIMALS', 'Settlement asset must have six decimals');
    const cost = shares * price;
    const allowance = BigInt(await usdc.allowance(session.address, chain.contract));
    if (allowance < cost) {
      if (allowance > 0n) {
        await check();
        await (await usdc.approve(chain.contract, 0n)).wait();
      }
      await check();
      await (await usdc.approve(chain.contract, cost)).wait();
    }
    await check();
    const calldata = contract.interface.encodeFunctionData('subscribeWithTerms', [BigInt(chain.pool_id), shares, price, version, deadline]);
    if (intent.calldata.toLowerCase() !== calldata.toLowerCase()) throw err('INTENT_CHANGED', 'Saved transaction differs from wallet calldata');
  }
  await contract.subscribeWithTerms.staticCall(BigInt(chain.pool_id), shares, price, version, deadline);
  if (intent && beforeBroadcast) intent = await beforeBroadcast(intent);
  await check();
  const tx = await contract.subscribeWithTerms(BigInt(chain.pool_id), shares, price, version, deadline, ...(intent?.broadcast_nonce === undefined ? [] : [{
    nonce: intent.broadcast_nonce
  }]));
  try {
    if (intent) await attachIntent(intent.intent_id, tx.hash);
    const receipt = await tx.wait(cfg.confirmations ?? 1);
    if (Number(receipt.status) !== 1 || !/^0x[0-9a-f]{64}$/iu.test(tx.hash)) throw new Error('Subscription receipt was not successful');
    const subscribed = (receipt.logs ?? []).filter(log => log.address?.toLowerCase() === chain.contract.toLowerCase()).map(log => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    }).find(event => event?.name === 'Subscribed' && BigInt(event.args.poolId) === BigInt(chain.pool_id) && event.args.investor.toLowerCase() === session.address.toLowerCase() && BigInt(event.args.amount) === shares);
    if (!subscribed || BigInt(subscribed.args.paidAmount) !== shares * price) throw new Error('Subscription event or confirmed price differs from the card');
    {
      const escrow = (receipt.logs ?? []).filter(log => log.address?.toLowerCase() === chain.contract.toLowerCase()).map(log => {
        try {
          return contract.interface.parseLog(log);
        } catch {
          return null;
        }
      }).find(event => event?.name === 'FundEscrowed' && BigInt(event.args.poolId) === BigInt(chain.pool_id) && event.args.investor.toLowerCase() === session.address.toLowerCase() && event.args.asset.toLowerCase() === offering.settlementAsset.toLowerCase() && BigInt(event.args.amountAtomic) === shares * price && BigInt(event.args.shares) === shares);
      if (!escrow) throw new Error('Escrow receipt is missing or differs from the saved funding intent');
      const confirmed = await attachIntent(intent.intent_id, tx.hash);
      if (confirmed?.status !== 'confirmed') throw new Error('Subscription is waiting for canonical confirmations');
    }
    assertCurrent();
    return {
      mode: 'chain',
      txHash: tx.hash,
      explorerUrl: explorerTx(cfg, tx.hash),
      tokenCount: action.shares,
      amountUsd: Number(subscribed.args.paidAmount) / 1_000_000,
      blockNumber: receipt.blockNumber,
      termsBound,
      quoteVersion: Number(version)
    };
  } catch (cause) {
    const failure = new Error(`Transaction ${tx.hash} was submitted; verify its receipt before trying again: ${cause.message}`, {
      cause
    });
    failure.txHash = tx.hash;
    failure.code = 'subscription_reconciliation_required';
    throw failure;
  }
}
export async function protocolDeploymentInfo() {
  const cfg = await loadChainConfig();
  return {
    networkKey: cfg.key,
    displayName: cfg.displayName,
    accessModel: cfg.accessModel,
    explorerBase: cfg.explorerBase,
    contracts: Object.fromEntries(Object.entries(cfg.contracts ?? {}).filter(([name, address]) => !['RWAOfferingPool', 'RWAToken'].includes(name) && isAddress(address)))
  };
}

// Injective's public EVM RPC rejects eth_getLogs ranges larger than 10,000
// blocks. Keep each request at 10,000 blocks (9,999 block distance) and scan
// newest-first so callers that only need recent events can stop early.
const GET_LOGS_BLOCKS_PER_REQUEST = 10_000;
export async function queryFilterInChunks(contract, filter, fromBlock, toBlock, {
  limit = Infinity
} = {}) {
  const start = Math.max(0, Math.trunc(Number(fromBlock)));
  const end = Math.max(0, Math.trunc(Number(toBlock)));
  const parsedLimit = Number(limit);
  const eventLimit = Number.isFinite(parsedLimit) ? Math.max(0, Math.trunc(parsedLimit)) : Infinity;
  if (end < start || eventLimit === 0) return [];
  const events = [];
  let chunkTo = end;
  while (chunkTo >= start) {
    const chunkFrom = Math.max(start, chunkTo - GET_LOGS_BLOCKS_PER_REQUEST + 1);
    const chunkEvents = await contract.queryFilter(filter, chunkFrom, chunkTo);
    events.unshift(...chunkEvents);
    if (events.length >= eventLimit || chunkFrom === start) break;
    chunkTo = chunkFrom - 1;
  }
  return Number.isFinite(eventLimit) ? events.slice(-eventLimit) : events;
}

/** Read the latest real PricingUpdated events through the configured public RPC. */

/** Send a minimal real self-transfer to prove the selected wallet can sign on Injective. */
export async function verifyWalletOnChain() {
  if (!_session) throw err('NO_SESSION', 'Connect a wallet first');
  const cfg = await loadChainConfig();
  if (_session.kind === 'evm') {
    const tx = await _session.signer.sendTransaction({
      to: _session.address,
      value: 0n
    });
    const receipt = await tx.wait();
    return {
      walletType: _session.walletType,
      kind: 'evm',
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      explorerUrl: explorerTx(cfg, tx.hash)
    };
  }
  const {
    SigningStargateClient,
    GasPrice,
    calculateFee
  } = await loadCosmosStargate();
  const gasPrice = GasPrice.fromString('500000000inj');
  const client = await SigningStargateClient.connectWithSigner(cfg.cosmosRpcUrl, _session.signer, {
    gasPrice
  });
  try {
    const result = await client.sendTokens(_session.address, _session.address, [{
      denom: 'inj',
      amount: '1'
    }], calculateFee(90_000, gasPrice), `AgentBL ${_session.walletType} verification`);
    if (result.code !== 0) throw err('TX_FAILED', result.rawLog || `Cosmos transaction failed with code ${result.code}`);
    return {
      walletType: _session.walletType,
      kind: 'cosmos',
      txHash: result.transactionHash,
      blockNumber: result.height,
      explorerUrl: `${cfg.cosmosExplorerTxBase ?? ''}${result.transactionHash}` || null
    };
  } finally {
    client.disconnect();
  }
}

/**
 * Simulated mint fallback: a tx-shaped result from the existing
 * local Demo simulation, so the View renders identically when no
 * wallet / no deployed contract is available.
 */
export async function simulatedMint(_caseId, quote, financingUsd) {
  const tx = {};
  return {
    mode: 'sim',
    // A simulation sends nothing: no hash is better than a hash-shaped placeholder.
    txHash: tx.tx_hash ?? null,
    poolId: 'sim',
    mintedAmount: mintedTokensFor(quote, financingUsd),
    issuePriceE6: priceToE6(quote.final_issue_price_usd),
    explorerUrl: null,
    address: tx.from ?? null,
    blockNumber: tx.block_number ?? null,
    gasUsed: tx.gas_used ?? null
  };
}

/** Read a hardened PaymentOracle attestation by rpt_<sha256> or bytes32 id. */
export async function readX402PaymentAttestation(reportOrReceiptId) {
  const cfg = await loadChainConfig();
  const address = cfg?.contracts?.PaymentOracle;
  const abi = cfg?.paymentOracle?.abi;
  if (!isAddress(address) || !abi) throw err('NO_CONTRACT', 'PaymentOracle is not deployed');
  const receiptId = String(reportOrReceiptId).startsWith('rpt_') ? `0x${String(reportOrReceiptId).slice(4)}` : String(reportOrReceiptId);
  if (!/^0x[0-9a-fA-F]{64}$/.test(receiptId)) {
    throw err('INVALID_RECEIPT', 'Expected rpt_<sha256> or a bytes32 receipt id');
  }
  const ethers = await loadEthers();
  const provider = new ethers.JsonRpcProvider(getPreset(cfg).rpcUrls[0]);
  const oracle = new ethers.Contract(address, abi, provider);
  if (typeof oracle.getAttestation !== 'function') {
    throw err('OUTDATED_CONTRACT', 'Configured PaymentOracle predates PaymentAttested; redeploy it');
  }
  const stored = await oracle.getAttestation(receiptId);
  const events = await oracle.queryFilter(oracle.filters.PaymentAttested(receiptId));
  const event = events.at(-1);
  return {
    receiptId,
    reportHash: stored.reportHash,
    caseIdHash: stored.caseIdHash,
    paymentTxHash: stored.paymentTxHash,
    payer: stored.payer,
    asset: stored.asset,
    amount: stored.amount.toString(),
    attestor: stored.attestor,
    timestamp: Number(stored.timestamp),
    attestationTxHash: event?.transactionHash ?? null,
    explorerUrl: event?.transactionHash ? explorerTx(cfg, event.transactionHash) : null
  };
}
async function capitalPost(url, body) {
  const { rightsSessionToken } = await import('./rights-session.js');
  const token = rightsSessionToken();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', ...(token ? { 'x-rights-session': token } : {})
    },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? 'Capital ledger request failed'), {
    code: result.code
  });
  return result.intent;
}
function prepareCapitalIntent(body) {
  return capitalPost('/api/controlled/subscription-intents', body);
}
function attachCapitalIntent(id, txHash) {
  return capitalPost(`/api/controlled/intents/${id}/transaction`, {
    tx_hash: txHash
  });
}
export async function claimPosition(position, {
  assertCurrent = () => {},
  getSession = () => _session,
  getConfig = loadChainConfig,
  ethersFn = loadEthers,
  prepareClaim = prepareCapitalClaim,
  attachIntent = attachCapitalIntent,
  beforeBroadcast = null
} = {}) {
  const session = getSession(),
    cfg = await getConfig();
  const pi = position.protocol_instance;
  if (!session?.signer || !position.reconciled || Number(pi?.protocol_version) !== 5 || Number(cfg.protocolVersion) !== 5 || Number(cfg.chainIdDecimal) !== Number(pi.chain_id) || cfg.contracts.RWAOfferingPool.toLowerCase() !== pi.pool_address.toLowerCase()) throw err('POSITION_UNAVAILABLE', 'Refresh the confirmed position before claiming');
  const check = async () => {
    assertCurrent();
    if (getSession() !== session || session.address.toLowerCase() !== position.investor.toLowerCase()) throw err('WALLET_CHANGED', 'Wallet changed');
    const [network, accounts] = await Promise.all([session.provider.request({
      method: 'eth_chainId'
    }), session.provider.request({
      method: 'eth_accounts'
    })]);
    if (BigInt(network) !== BigInt(pi.chain_id) || accounts[0]?.toLowerCase() !== session.address.toLowerCase()) throw err('WALLET_CHANGED', 'Wallet or network changed');
  };
  await check();
  const ethers = await ethersFn();
  const {
    protocolAbi
  } = await import('../../../src/chain/protocolV5Abi.js');
  const pool = new ethers.Contract(pi.pool_address, protocolAbi('RWAOfferingPool', cfg.abis.RWAOfferingPool), session.signer);
  let intent = await prepareClaim({
    wallet: session.address,
    chain_pool_id: position.chain_pool_id
  });
  if (intent.calldata.toLowerCase() !== pool.interface.encodeFunctionData('claim', [position.chain_pool_id]).toLowerCase() || intent.asset.toLowerCase() !== position.asset.toLowerCase()) throw err('INTENT_CHANGED', 'Saved claim differs from the reviewed position');
  await pool.claim.staticCall(position.chain_pool_id);
  if (beforeBroadcast) intent = await beforeBroadcast(intent);
  await check();
  const tx = await pool.claim(position.chain_pool_id, ...(intent.broadcast_nonce === undefined ? [] : [{
    nonce: intent.broadcast_nonce
  }]));
  try {
    await attachIntent(intent.intent_id, tx.hash);
    const receipt = await tx.wait(cfg.confirmations ?? 1);
    const claimed = (receipt.logs ?? []).filter(log => log.address?.toLowerCase() === pi.pool_address.toLowerCase()).map(log => {
      try {
        return pool.interface.parseLog(log);
      } catch {
        return null;
      }
    }).find(event => event?.name === 'Claimed' && BigInt(event.args.poolId) === BigInt(position.chain_pool_id) && event.args.investor.toLowerCase() === session.address.toLowerCase() && event.args.asset.toLowerCase() === position.asset.toLowerCase());
    if (Number(receipt.status) !== 1 || !claimed) throw new Error('Claim receipt is missing or invalid');
    const confirmed = await attachIntent(intent.intent_id, tx.hash);
    if (confirmed?.status !== 'confirmed') throw new Error('Claim is waiting for canonical confirmations');
    assertCurrent();
    return {
      txHash: tx.hash,
      explorerUrl: explorerTx(cfg, tx.hash),
      amount_atomic: String(claimed.args.amountAtomic)
    };
  } catch (cause) {
    throw Object.assign(new Error(`Transaction ${tx.hash} was submitted; reconcile its receipt before trying again`, {
      cause
    }), {
      code: 'claim_reconciliation_required',
      txHash: tx.hash
    });
  }
}
function prepareCapitalClaim(body) {
  return capitalPost('/api/controlled/claim-intents', body);
}
