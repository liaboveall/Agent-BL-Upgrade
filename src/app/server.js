import '../env.js';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { calculateRisk } from '../core/riskEngine.js';
import { runHarnessScenarios, runScenario } from '../core/scenarioRunner.js';
import { assertRiskReport, assertTradeCase, ValidationError } from '../core/schema.js';
import { simulateWorkflow } from '../core/workflow.js';
import { compareSpeeds, quoteFromCase } from '../core/pricingEngine.js';
import { simulateOffering } from '../core/offeringSimulator.js';
import { simulatePricingWorkflow } from '../core/pricingWorkflow.js';
import { toOracleUpdate } from '../core/oracle.js';
import {
  assertPricingQuote,
  normalizePricingQuoteHashes,
  PAYOUT_SPEEDS
} from '../core/pricingSchema.js';
import { X402_SERVICES } from '../x402/config.js';
import { demoModeController, LiveModeUnavailableError } from '../demo/mode.js';
import { DEFAULT_MYSTERY_QUOTE_MAX_AGE_SECONDS } from '../mystery/policy.js';
import { storeState, createPool, resetStore, subscribeToPool } from './store.js';
import { parseLlmCriteria, poolToAdvisorCase, recommend } from '../agent/investmentAdvisor.js';
import {
  loadSpotPurchase,
  loadSpotSale,
  loadTransport,
  loadWarehouse,
  loadAllDesensitizationData,
  getDesensitizationSummary
} from '../data/desensitizationStore.js';
import {
  HttpError,
  clientIp,
  describeError,
  readJsonBody,
  safeDecodeURIComponent,
  sendError,
  sendJson
} from './http.js';
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
  checkAdminToken,
  connectOriginsFromChainConfig,
  createRateLimiter,
  envInt,
  MIN_ADMIN_TOKEN_LENGTH
} from './security.js';
import { cleanupOrphanTemps } from '../lib/jsonStore.js';
import { ActivityLog } from '../agent/runtime/activityLog.js';
import { attachActivityPersistence, createAgentService } from '../agent/runtime/factory.js';
import { loadAgentConfig } from '../agent/runtime/config.js';
import { createAgentRoutes } from './agentRoutes.js';
import { runtimeDir } from '../runtimePaths.js';
import { createStaticHandler } from './static.js';
import { llmStatus, relayChat } from './llmProxy.js';
import { isRecord, looksLikeCase } from './shapes.js';
import { createX402ServiceDefinitions } from './x402Services.js';
import { createLiveGateway } from '../x402/liveGateway.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const publicDir = path.join(rootDir, 'public');
const dataPath = path.join(rootDir, 'data/demo-case.json');
const casesDir = path.join(rootDir, 'data/cases');

// FE-7 support: human labels + a risk-ladder ordering for the curated demo
// cases, so the frontend scenario selector can present clean -> warning ->
// critical without bundling case JSON. Cases not listed here still load (with a
// derived label) so adding a *.case.json file is enough to surface it.
const CASE_META = {
  'CASE-EBL-2026-CU-SG-SHA': { label: '铜矿 · Singapore → Shanghai', risk_hint: 'MEDIUM', order: 1 },
  'CASE-EBL-2026-REFINED-SG-JKT': { label: '成品油 · Singapore → Jakarta', risk_hint: 'LOW', order: 2 },
  'CASE-EBL-2026-RUBBER-BKK-QD': { label: '橡胶 · Bangkok → Qingdao', risk_hint: 'MEDIUM', order: 3 },
  'CASE-EBL-2026-0001': { label: '铜矿 · Shanghai → Hamburg (保险缺口)', risk_hint: 'WARNING', order: 4 },
  'CASE-EBL-2026-OIL-SG-ULS': { label: '原油 · Singapore → Ulsan', risk_hint: 'MEDIUM', order: 5 },
  'CASE-EBL-2026-IRONORE-AU-TJ': { label: '铁矿石 · Port Hedland → Tianjin', risk_hint: 'LOW', order: 6 },
  'CASE-EBL-2026-ALU-DXB-RTM': { label: '铝 · Dubai → Rotterdam (Hormuz)', risk_hint: 'HIGH', order: 7 },
  'CASE-EBL-2026-CUCONC-ANF-LYG': { label: '铜精矿 · Antofagasta → Lianyungang', risk_hint: 'MEDIUM', order: 8 },
  'CASE-EBL-2026-CU-SG-SHA-WARCRISIS': { label: '铜矿 · Hormuz 战争危机 · Singapore → Shanghai', risk_hint: 'CRITICAL', order: 9 }
};

// ---------------------------------------------------------------------------
// Request limits (all knobs are env-tunable; 0 disables a limiter)
// ---------------------------------------------------------------------------
const limiters = {
  api: createRateLimiter({ max: envInt(process.env, 'AGENTBL_RATE_LIMIT_PER_MIN', 1200) }),
  write: createRateLimiter({ max: envInt(process.env, 'AGENTBL_WRITE_RATE_LIMIT_PER_MIN', 300) }),
  llm: createRateLimiter({ max: envInt(process.env, 'LLM_RATE_LIMIT_PER_MIN', 30) })
};

function enforceLimit(limiter, key, response) {
  if (limiter.max <= 0) return;
  const result = limiter.take(key);
  if (!result.allowed) {
    response.setHeader('Retry-After', String(result.retryAfterSeconds));
    throw new HttpError(429, 'rate_limited', 'Too many requests; slow down and retry shortly');
  }
}

/** Test hook: forget all rate-limit windows. */
export function resetRateLimiters() {
  for (const limiter of Object.values(limiters)) limiter.reset();
}

function enforceRateLimits(request, response, url) {
  if (!url.pathname.startsWith('/api/') || url.pathname === '/api/health') return;
  const key = clientIp(request);
  enforceLimit(limiters.api, key, response);
  if (request.method === 'POST') enforceLimit(limiters.write, key, response);
  if (url.pathname === '/api/llm/chat') enforceLimit(limiters.llm, key, response);
}

// ---------------------------------------------------------------------------
// Static assets (CSP derived from the chain registry the page may talk to)
// ---------------------------------------------------------------------------
let staticHandler = null;

function getStaticHandler() {
  if (!staticHandler) {
    let registry = null;
    try {
      registry = JSON.parse(readFileSync(path.join(publicDir, 'chain-config.json'), 'utf8'));
    } catch {
      // Without a registry the CSP still allows the built-in RPC hosts.
    }
    staticHandler = createStaticHandler({
      rootDir: publicDir,
      csp: buildContentSecurityPolicy({ connectSrc: connectOriginsFromChainConfig(registry) })
    });
  }
  return staticHandler;
}

async function loadDemoCase() {
  return JSON.parse(await fs.readFile(dataPath, 'utf8'));
}

/**
 * FE-7 support: load the curated trade-case catalog (demo case + data/cases/*.case.json).
 * Returns full case objects, each annotated with a label / route / risk_hint and
 * ordered as a risk ladder, so the frontend can drive the pricing endpoints
 * directly. Read-only; never throws on a single bad file.
 */
async function loadCaseCatalog() {
  const files = new Map(); // case_id -> case object (demo first, then data/cases)
  const add = (data) => { if (data?.case_id && !files.has(data.case_id)) files.set(data.case_id, data); };

  try { add(await loadDemoCase()); } catch { /* ignore */ }
  try {
    const entries = await fs.readdir(casesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.case.json')) continue;
      try { add(JSON.parse(await fs.readFile(path.join(casesDir, entry.name), 'utf8'))); } catch { /* skip bad file */ }
    }
  } catch { /* no cases dir */ }

  const cases = [...files.values()].map((data) => {
    const bl = data.bill_of_lading ?? {};
    const meta = CASE_META[data.case_id] ?? {};
    return {
      case_id: data.case_id,
      label: meta.label ?? `${bl.cargo ?? 'Trade case'} · ${bl.port_of_loading ?? '?'} → ${bl.port_of_discharge ?? '?'}`,
      route: `${bl.port_of_loading ?? '?'} → ${bl.port_of_discharge ?? '?'}`,
      cargo: bl.cargo ?? null,
      risk_hint: meta.risk_hint ?? null,
      order: meta.order ?? 99,
      case: data
    };
  });
  cases.sort((a, b) => a.order - b.order || a.case_id.localeCompare(b.case_id));
  return cases;
}

/** A JSON object body, or the demo case when the body is empty. Anything else is a 400. */
async function caseBodyOrDemo(body) {
  if (body === null || body === undefined) return loadDemoCase();
  if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  return body;
}

function requireRecordBody(body, hint) {
  if (!isRecord(body)) throw new HttpError(400, 'invalid_request', `Request body must be a JSON object${hint ? ` (${hint})` : ''}`);
  return body;
}

// 0x + alphanumerics: real addresses, plus the demo placeholders ("0xDemoWallet").
const WALLET_PATTERN = /^0x[0-9A-Za-z]{1,64}$/u;

const DEFAULT_SKILL_CASE_ID = 'CASE-EBL-2026-0001';

/** Skill endpoints take { case_id, payout_speed? }; an empty body runs the demo case. */
function skillInput(body) {
  if (body === null) return { case_id: DEFAULT_SKILL_CASE_ID };
  const input = requireRecordBody(body, 'case_id');
  if (typeof input.case_id !== 'string' || input.case_id.trim() === '') {
    throw new HttpError(400, 'invalid_request', 'case_id (non-empty string) is required');
  }
  return input;
}

// A POST body is treated as a bare trade case when looksLikeCase() says so (see
// ./shapes.js). Otherwise it is treated as a request wrapper:
//   { case?, payout_speed?, requested_cash_usd?, subscription_usd?, events?, compare?,
//     paid_report_envelope? | paid_report_envelopes? }

// BE-7: parse a caller-supplied numeric override, collecting a validation error
// when it is present but not a valid (non-)negative number.
function parseAmount(raw, field, errors, { allowZero = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
    errors.push(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} number`);
    return undefined;
  }
  return n;
}

/**
 * Resolve the case + pricing options for the AI-pricing endpoints from a POST
 * body and the request URL. Empty body -> the demo case (PRD §9 convention).
 * Query params (?payout_speed=&requested_cash_usd=&compare=) override the body.
 * Throws ValidationError (-> HTTP 400) on malformed input (BE-7).
 */
async function resolvePricingRequest(body, url) {
  const wrapper = isRecord(body) && !looksLikeCase(body) ? body : {};
  const caseData = looksLikeCase(body) ? body : (wrapper.case ?? await loadDemoCase());
  const q = url.searchParams;

  const errors = [];
  const payoutSpeed = q.get('payout_speed') ?? wrapper.payout_speed ?? undefined;
  if (payoutSpeed !== undefined && payoutSpeed !== null && !PAYOUT_SPEEDS.includes(payoutSpeed)) {
    errors.push(`payout_speed must be one of: ${PAYOUT_SPEEDS.join(', ')}`);
  }
  const requestedCash = parseAmount(q.get('requested_cash_usd') ?? wrapper.requested_cash_usd, 'requested_cash_usd', errors);
  const subscription = parseAmount(q.get('subscription_usd') ?? wrapper.subscription_usd, 'subscription_usd', errors, { allowZero: true });

  // target redemption value is FIXED at 1.00 in this model; reject any other.
  const target = caseData?.financing?.target_redemption_value_usd;
  if (target !== undefined && Number(target) !== 1) {
    errors.push('financing.target_redemption_value_usd must be 1.00 (target redemption value is fixed)');
  }
  if (wrapper.events !== undefined && !Array.isArray(wrapper.events)) {
    errors.push('events must be an array');
  } else if (Array.isArray(wrapper.events) && wrapper.events.some((event) => !isRecord(event))) {
    errors.push('events must be an array of objects');
  }
  if (wrapper.paid_report_envelope !== undefined && !isRecord(wrapper.paid_report_envelope)) {
    errors.push('paid_report_envelope must be an object');
  }
  if (wrapper.paid_report_envelopes !== undefined
      && (!Array.isArray(wrapper.paid_report_envelopes)
        || wrapper.paid_report_envelopes.some((entry) => !isRecord(entry)))) {
    errors.push('paid_report_envelopes must be an array of objects');
  }
  if (errors.length > 0) throw new ValidationError('Invalid pricing request', errors);

  const minAcceptablePrice = parseAmount(q.get('min_acceptable_issue_price') ?? wrapper.min_acceptable_issue_price, 'min_acceptable_issue_price', errors, { allowZero: true });

  const compareRaw = q.get('compare') ?? wrapper.compare;
  const options = {
    payout_speed: payoutSpeed === null ? undefined : payoutSpeed,
    requested_cash_usd: requestedCash,
    subscription_usd: subscription,
    events: Array.isArray(wrapper.events) ? wrapper.events : undefined,
    paid_report_envelopes: wrapper.paid_report_envelopes
      ?? (wrapper.paid_report_envelope ? [wrapper.paid_report_envelope] : undefined),
    compare: compareRaw === true || compareRaw === 'true',
    pool_id: q.get('pool_id') ?? wrapper.pool_id ?? undefined,
    min_acceptable_issue_price: minAcceptablePrice
  };
  return { caseData, options };
}

/** Narrow the resolved options to what quoteFromCase / compareSpeeds accept. */
function quoteOptions(options) {
  const out = {};
  if (options.payout_speed !== undefined) out.payout_speed = options.payout_speed;
  if (options.requested_cash_usd !== undefined) out.requested_cash_usd = options.requested_cash_usd;
  if (options.paid_report_envelopes !== undefined) out.paid_report_envelopes = options.paid_report_envelopes;
  if (options.min_acceptable_issue_price !== undefined) out.min_acceptable_issue_price = options.min_acceptable_issue_price;
  return out;
}

// ---------------------------------------------------------------------------
// Runtime mode switching (Demo <-> Live) is an admin operation
// ---------------------------------------------------------------------------

/**
 * Leaving Live, or entering a Live that is actually configured, changes how
 * payments are treated, so it needs AGENTBL_ADMIN_TOKEN. (An open endpoint let
 * anyone flip a Live server back to Demo and read paywalled reports for free.)
 * No-op requests and demo->live on an unconfigured server (rejected by the
 * controller anyway) stay open.
 */
function authorizeModeChange(request, requested) {
  const snapshot = demoModeController.snapshot();
  if (requested === snapshot.mode) return;
  const touchesLive = snapshot.mode === 'live' || snapshot.liveAvailable;
  if (!touchesLive) return;
  const admin = checkAdminToken(request);
  if (!admin.configured) {
    throw new HttpError(403, 'admin_token_not_configured',
      `Switching runtime mode requires AGENTBL_ADMIN_TOKEN (at least ${MIN_ADMIN_TOKEN_LENGTH} characters) to be set on the server`);
  }
  if (!admin.authorized) {
    throw new HttpError(401, 'admin_token_required', 'A valid admin token is required to switch runtime mode');
  }
}

// ---------------------------------------------------------------------------
// Agent activity feed (REST + SSE)
// ---------------------------------------------------------------------------
const SSE_HEARTBEAT_MS = 25_000;
let sseHeartbeat = null;

function startSseHeartbeat() {
  if (sseHeartbeat) return;
  // Comment frames keep idle proxies (nginx: 60s) from dropping the stream.
  sseHeartbeat = setInterval(() => {
    for (const client of storeState.sseClients ?? []) {
      try { client.response.write(': ping\n\n'); } catch { /* closed; its 'close' handler cleans up */ }
    }
  }, Math.max(10, envInt(process.env, 'AGENTBL_SSE_HEARTBEAT_MS', SSE_HEARTBEAT_MS)));
  sseHeartbeat.unref();
}

function stopSseHeartbeatIfIdle() {
  if (sseHeartbeat && (storeState.sseClients?.length ?? 0) === 0) {
    clearInterval(sseHeartbeat);
    sseHeartbeat = null;
  }
}

/** End every open live-stream subscription (used on shutdown). */
export function closeActivityStreams() {
  for (const client of [...(storeState.sseClients ?? [])]) {
    try { client.response.end(); } catch { /* already gone */ }
  }
  storeState.sseClients = [];
  stopSseHeartbeatIfIdle();
}

function boundedParam(value) {
  return value ? String(value).slice(0, 128) : null;
}

// The feed itself (sequence numbers, persistence, replay) lives in src/agent/runtime/activityLog.js;
// this file only does the HTTP side. Every SSE message carries `id: <seq>`, so a client that
// reconnects sends Last-Event-ID and receives what it missed instead of silently losing events.
export const activityLog = new ActivityLog({
  store: storeState,
  mode: () => demoModeController.snapshot().mode
});

function lastEventId(request, url) {
  const header = request.headers['last-event-id'];
  const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('last_event_id');
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sseMessage(activity) {
  // Preserve the SSE envelope discriminator even when the domain activity has
  // its own `type` (PRICING, RISK, TEST, ...).
  return `id: ${activity.seq}\ndata: ${JSON.stringify({ ...activity, activityType: activity.type, type: 'activity' })}\n\n`;
}

function clientWants(client, activity) {
  if (client.caseId && activity.caseId !== client.caseId) return false;
  if (client.poolId && activity.poolId !== client.poolId) return false;
  return true;
}

function openActivityStream(request, response, url) {
  if (!storeState.sseClients) storeState.sseClients = [];
  const maxClients = envInt(process.env, 'AGENTBL_MAX_SSE_CLIENTS', 200);
  if (storeState.sseClients.length >= maxClients) {
    throw new HttpError(503, 'sse_capacity', 'Too many live-stream subscribers; retry shortly');
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.write('retry: 3000\n\n');
  response.write('data: ' + JSON.stringify({ type: 'connected', timestamp: new Date().toISOString(), last_seq: activityLog.seq }) + '\n\n');

  const client = {
    response,
    caseId: boundedParam(url.searchParams.get('case_id')),
    poolId: boundedParam(url.searchParams.get('pool_id')),
    // While missed events are being replayed, live ones are held back so the order stays strict.
    replaying: false,
    held: []
  };
  storeState.sseClients.push(client);
  startSseHeartbeat();

  // IncomingMessage "close" can fire as soon as the request body is
  // complete even while the SSE response is intentionally still open.
  // Track the writable response lifecycle so live subscribers are not
  // removed before the first activity broadcast.
  response.on('close', () => {
    const index = storeState.sseClients.indexOf(client);
    if (index > -1) storeState.sseClients.splice(index, 1);
    stopSseHeartbeatIfIdle();
  });

  const resumeFrom = lastEventId(request, url);
  if (resumeFrom !== null) {
    client.replaying = true;
    activityLog.since(resumeFrom, { caseId: client.caseId ?? undefined, poolId: client.poolId ?? undefined })
      .then((missed) => {
        let highest = resumeFrom;
        for (const activity of missed) {
          response.write(sseMessage(activity));
          highest = Math.max(highest, activity.seq);
        }
        client.replaying = false;
        for (const activity of client.held) {
          if (activity.seq > highest) response.write(sseMessage(activity));
        }
        client.held = [];
      })
      .catch(() => { client.replaying = false; client.held = []; });
  }
}

export function broadcastAgentActivity(activity) {
  if (!storeState.sseClients) return;
  const message = sseMessage(activity);
  for (const client of storeState.sseClients) {
    if (!clientWants(client, activity)) continue;
    if (client.replaying) {
      client.held.push(activity);
      continue;
    }
    try {
      client.response.write(message);
    } catch {
      // Client disconnected
    }
  }
}

activityLog.onAppend(broadcastAgentActivity);

// The agent runtime. `createServer()` never starts it (so tests stay deterministic); the entry point
// does, with persistence, unless AGENT_ENABLED=false. Until then this is a memory-only instance whose
// routes can still be read and driven by tests.
let agentService = null;

export function getAgentService() {
  if (!agentService) {
    agentService = createAgentService({
      demoModeController,
      ensurePools: () => ensureMockPools(),
      activity: activityLog,
      store: storeState
    });
  }
  return agentService;
}

/** Test hook: replace the runtime (e.g. with one that persists to a temp dir). */
export function setAgentService(service) {
  agentService = service;
}

const handleAgentRoute = createAgentRoutes({
  getService: getAgentService,
  runtimeMode: () => demoModeController.snapshot(),
  activityLog
});

export function logAgentActivity(activity) {
  return activityLog.append(activity);
}

/** 0x1234…abcd — enough to recognise a wallet without publishing it in a public feed. */
function shortAddress(address) {
  const value = String(address ?? '');
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

// ---------------------------------------------------------------------------
// Market pools (lazily seeded from the same canonical PricingQuote as pricing,
// oracle and Mystery Voyage)
// ---------------------------------------------------------------------------
const quotePoolCase = (caseData) => {
  const configuredSpeed = caseData.financing.payout_speed;
  const quote = normalizePricingQuoteHashes(quoteFromCase(caseData, {
    // A few imported/desensitized fixtures predate the FAST/BALANCED/
    // LOW_COST enum. They still receive a real deterministic quote.
    payout_speed: PAYOUT_SPEEDS.includes(configuredSpeed) ? configuredSpeed : 'BALANCED'
  }));
  assertPricingQuote(quote, caseData);
  return quote;
};

const ensureMockPools = async (options = {}) => {
  if (storeState.pools.size === 0) {
    const cases = await loadCaseCatalog();
    for (const c of cases) {
      const caseData = c.case;
      if (!caseData || !caseData.financing) continue;
      createPool(c.case_id, caseData, quotePoolCase(caseData));
    }
  }

  if (options.refreshStaleDemoQuotes && demoModeController.snapshot().demoMode) {
    const now = Date.now();
    const refreshedAt = new Date(now).toISOString();
    for (const pool of storeState.pools.values()) {
      const updatedAt = Date.parse(pool.quoteUpdatedAt ?? pool.createdAt);
      const quoteAgeSeconds = Number.isFinite(updatedAt) ? (now - updatedAt) / 1000 : Infinity;
      if (quoteAgeSeconds <= DEFAULT_MYSTERY_QUOTE_MAX_AGE_SECONDS) continue;
      pool.quote = quotePoolCase(pool.caseData);
      pool.quoteUpdatedAt = refreshedAt;
    }
  }
};

const mysteryService = () => import('../mystery/service.js');

/** Shared error reply for the Mystery Voyage routes, which carry their own status mapping. */
async function sendMysteryError(response, error, fallbackCode) {
  const { mysteryHttpStatus } = await mysteryService();
  sendJson(response, mysteryHttpStatus(error), {
    ok: false,
    code: error.code ?? fallbackCode,
    error: error.message,
    details: error.details
  });
}

function parseRequestUrl(request) {
  const raw = String(request.url ?? '');
  // Origin-form only: "//host/path" and absolute-form targets are never legitimate here.
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    throw new HttpError(400, 'malformed_url', 'Malformed request target');
  }
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    throw new HttpError(400, 'malformed_url', 'Malformed request target');
  }
}

// ---------------------------------------------------------------------------
// Paid x402 services (shared business logic, two payment transports)
// ---------------------------------------------------------------------------
const x402Definitions = createX402ServiceDefinitions({
  loadDemoCase,
  ensureMockPools,
  getPools: () => storeState.pools
});

const DEFAULT_LIVE_GATEWAY_RETRY_MS = 5_000; // override: X402_GATEWAY_RETRY_MS
const liveGatewayState = { promise: null, generation: null, failure: null, failedAt: 0 };

/**
 * The Live gateway is created lazily (it validates the facilitator over the network)
 * and rebuilt when the runtime mode generation changes. A failure is remembered for a
 * few seconds so a down facilitator is not hammered by every request.
 */
async function getLiveGateway() {
  const { generation } = demoModeController.snapshot();
  if (liveGatewayState.promise && liveGatewayState.generation === generation) return liveGatewayState.promise;
  if (liveGatewayState.failure
      && liveGatewayState.generation === generation
      && Date.now() - liveGatewayState.failedAt < envInt(process.env, 'X402_GATEWAY_RETRY_MS', DEFAULT_LIVE_GATEWAY_RETRY_MS)) {
    throw liveGatewayState.failure;
  }

  const { MysteryStoreError } = await import('../mystery/store.js');
  const { mysteryHttpStatus } = await mysteryService();
  liveGatewayState.generation = generation;
  liveGatewayState.failure = null;
  liveGatewayState.promise = createLiveGateway({
    definitions: x402Definitions,
    describeError: (error) => (error instanceof MysteryStoreError
      ? { status: mysteryHttpStatus(error), code: error.code, message: error.message, details: error.details }
      : describeError(error))
  }).catch((cause) => {
    liveGatewayState.promise = null;
    liveGatewayState.failedAt = Date.now();
    liveGatewayState.failure = new HttpError(
      503,
      'x402_v2_live_transport_required',
      `The x402 V2 live gateway is unavailable: ${cause.message}`
    );
    throw liveGatewayState.failure;
  });
  return liveGatewayState.promise;
}

async function handlePaidService(request, response, service) {
  if (process.env.DEMO_MODE === 'false') {
    const gateway = await getLiveGateway();
    await gateway.handle(request, response);
    return;
  }
  const definition = x402Definitions[service.serviceId];
  const { createX402Route } = await import('../x402/server.js');
  const route = createX402Route({
    serviceId: service.serviceId,
    priceUSDC: service.priceUSDC,
    preflight: definition.preflight
      ? (paidRequest, { payer }) => definition.preflight({ body: paidRequest.x402Body ?? null, payer })
      : undefined,
    handler: (paidRequest, context) => definition.handler({
      body: paidRequest.x402Body ?? null,
      payer: context.payer,
      paymentTx: context.payment_tx,
      live: false
    })
  });
  await route(request, response);
}

async function routeRequest(request, response, url) {
  const { method } = request;
  const { pathname } = url;

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, { ok: true, service: 'agentbl-agent-harness', ...demoModeController.snapshot() });
    return;
  }

  if (method === 'GET' && pathname === '/api/demo/mode') {
    sendJson(response, 200, { ok: true, ...demoModeController.snapshot() });
    return;
  }

  if (method === 'POST' && pathname === '/api/demo/mode') {
    const body = await readJsonBody(request);
    const requested = body?.mode;
    if (requested === 'demo' || requested === 'live') authorizeModeChange(request, requested);
    try {
      sendJson(response, 200, { ok: true, ...demoModeController.setMode(requested) });
    } catch (error) {
      sendJson(response, error instanceof LiveModeUnavailableError ? 409 : 400, {
        ok: false,
        code: error.code ?? 'invalid_mode',
        error: error.message,
        missing: error.missing
      });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/demo/reset') {
    let snapshot;
    try {
      snapshot = demoModeController.reset();
    } catch (error) {
      sendJson(response, 409, { ok: false, code: error.code, error: error.message });
      return;
    }
    // A Demo reset starts the Demo over: the offchain pools and everything the agent recorded in Demo
    // mode. Live records are never touched.
    resetStore();
    await getAgentService().resetDemo();
    sendJson(response, 200, { ok: true, ...snapshot });
    return;
  }

  if (method === 'GET' && pathname === '/api/demo-data') {
    sendJson(response, 200, await loadDemoCase());
    return;
  }

  // FE-7: curated trade-case catalog for the scenario selector (read-only).
  if (method === 'GET' && pathname === '/api/cases') {
    const cases = await loadCaseCatalog();
    sendJson(response, 200, { ok: true, count: cases.length, cases });
    return;
  }

  // ---- LLM relay: the provider key never leaves the server ----

  if (method === 'GET' && pathname === '/api/llm/status') {
    sendJson(response, 200, { ok: true, ...llmStatus() });
    return;
  }

  if (method === 'POST' && pathname === '/api/llm/chat') {
    await relayChat(request, response);
    return;
  }

  // ---- 脱敏数据 API ----

  if (method === 'GET' && pathname === '/api/desensitization/spot-purchase') {
    const data = await loadSpotPurchase();
    sendJson(response, 200, { ok: true, count: data.length, data });
    return;
  }

  if (method === 'GET' && pathname === '/api/desensitization/spot-sale') {
    const data = await loadSpotSale();
    sendJson(response, 200, { ok: true, count: data.length, data });
    return;
  }

  if (method === 'GET' && pathname === '/api/desensitization/transport') {
    const data = await loadTransport();
    sendJson(response, 200, { ok: true, count: data.length, data });
    return;
  }

  if (method === 'GET' && pathname === '/api/desensitization/warehouse') {
    const data = await loadWarehouse();
    sendJson(response, 200, { ok: true, count: data.length, data });
    return;
  }

  if (method === 'GET' && pathname === '/api/desensitization/summary') {
    const summary = await getDesensitizationSummary();
    sendJson(response, 200, { ok: true, ...summary });
    return;
  }

  if (method === 'GET' && pathname === '/api/desensitization/all') {
    const all = await loadAllDesensitizationData();
    sendJson(response, 200, { ok: true, ...all });
    return;
  }

  if (method === 'POST' && pathname === '/api/risk/analyze') {
    const caseData = await caseBodyOrDemo(await readJsonBody(request));
    assertTradeCase(caseData);
    const report = calculateRisk(caseData);
    assertRiskReport(report, caseData);
    sendJson(response, 200, report);
    return;
  }

  if (method === 'POST' && pathname === '/api/workflow/simulate') {
    const caseData = await caseBodyOrDemo(await readJsonBody(request));
    sendJson(response, 200, simulateWorkflow(caseData));
    return;
  }

  // BE-3: AI dynamic-pricing quote. Empty body -> demo case. `compare=true`
  // returns all three payout speeds + a recommendation (Exporter page).
  if (method === 'POST' && pathname === '/api/pricing/quote') {
    const body = await readJsonBody(request);
    const { caseData, options } = await resolvePricingRequest(body, url);
    if (options.compare) {
      const comparison = compareSpeeds(caseData, quoteOptions(options));
      const quotes = comparison.quotes.map(normalizePricingQuoteHashes);
      for (const quote of quotes) assertPricingQuote(quote, caseData);
      sendJson(response, 200, {
        ...comparison,
        quotes,
        recommended_quote: quotes.find(
          (quote) => quote.payout_speed === comparison.recommended_payout_speed
        )
      });
    } else {
      const quote = normalizePricingQuoteHashes(quoteFromCase(caseData, quoteOptions(options)));
      assertPricingQuote(quote, caseData);
      logAgentActivity({
        type: 'PRICING',
        action: 'PRICING_QUOTE',
        caseId: quote.case_id ?? caseData.case_id,
        details: {
          price: quote.final_issue_price_usd,
          riskLevel: quote.risk_level,
          payoutSpeed: quote.payout_speed
        }
      });
      sendJson(response, 200, quote);
    }
    return;
  }

  // ---------------------------------------------------------
  // BE-11, 12, 13: Market, Pool, and Role Dashboard APIs
  // ---------------------------------------------------------

  // MBOX-BE-5: freeze an eligible candidate snapshot before payment.
  if (method === 'POST' && pathname === '/api/mystery/preview') {
    const body = await readJsonBody(request);
    await ensureMockPools({ refreshStaleDemoQuotes: true });
    const { previewMysteryVoyage } = await mysteryService();
    try {
      sendJson(response, 201, await previewMysteryVoyage(body ?? {}, { pools: storeState.pools }));
    } catch (error) {
      await sendMysteryError(response, error, 'mystery_preview_failed');
    }
    return;
  }

  // MBOX-BE-5: proof is disclosed only after a successful paid reveal.
  if (method === 'GET' && pathname.startsWith('/api/mystery/') && pathname.endsWith('/proof')) {
    const revealId = safeDecodeURIComponent(pathname.slice('/api/mystery/'.length, -'/proof'.length));
    const { getMysteryProof } = await mysteryService();
    try {
      sendJson(response, 200, await getMysteryProof(revealId));
    } catch (error) {
      await sendMysteryError(response, error, 'mystery_proof_failed');
    }
    return;
  }

  const passportClaimMatch = pathname.match(/^\/api\/mystery\/([^/]+)\/passport\/claim$/u);
  if (method === 'POST' && passportClaimMatch) {
    const revealId = safeDecodeURIComponent(passportClaimMatch[1]);
    const body = await readJsonBody(request);
    const { claimMysteryPassport } = await mysteryService();
    try {
      sendJson(response, 201, await claimMysteryPassport({
        ...(body ?? {}),
        reveal_id: revealId
      }, { investments: storeState.investments }));
    } catch (error) {
      await sendMysteryError(response, error, 'passport_claim_failed');
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/mystery/passports') {
    const { listMysteryPassports, mysteryHttpStatus } = await mysteryService();
    try {
      sendJson(response, 200, await listMysteryPassports(url.searchParams.get('wallet_address')));
    } catch (error) {
      sendJson(response, mysteryHttpStatus(error), {
        ok: false,
        code: error.code ?? 'passport_list_failed',
        error: error.message
      });
    }
    return;
  }

  const passportVerifyMatch = pathname.match(/^\/api\/mystery\/passport\/([^/]+)\/verify$/u);
  if (method === 'GET' && passportVerifyMatch) {
    const credentialId = safeDecodeURIComponent(passportVerifyMatch[1]);
    const { verifyPublicMysteryPassport, mysteryHttpStatus } = await mysteryService();
    try {
      sendJson(response, 200, await verifyPublicMysteryPassport(credentialId));
    } catch (error) {
      sendJson(response, mysteryHttpStatus(error), {
        ok: false,
        code: error.code ?? 'passport_verify_failed',
        error: error.message
      });
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/mystery/analytics') {
    const { getMysteryRevealStore } = await import('../mystery/store.js');
    const { buildMysteryAnalytics } = await import('../mystery/analytics.js');
    const records = await getMysteryRevealStore().list({ internal: true });
    sendJson(response, 200, buildMysteryAnalytics({ records, investments: storeState.investments }));
    return;
  }

  // BE-11: Market Listings
  if (method === 'GET' && pathname === '/api/market/listings') {
    await ensureMockPools();
    const activePools = Array.from(storeState.pools.values())
      .filter((pool) => ['Open', 'Repriced'].includes(pool.status));
    sendJson(response, 200, { ok: true, count: activePools.length, pools: activePools });
    return;
  }

  // BE-11: Market Search (AI-19 Recommendation)
  if (method === 'POST' && pathname === '/api/market/search') {
    const body = await readJsonBody(request);
    await ensureMockPools();

    const availableCases = Array.from(storeState.pools.values())
      .filter((pool) => ['Open', 'Repriced'].includes(pool.status))
      .map(poolToAdvisorCase);

    const preference = typeof body?.preference === 'string' ? body.preference.slice(0, 500) : undefined;
    // Optional structured criteria (the assistant's tool call): validated like LLM output, then
    // used as-is instead of re-parsing free text.
    let criteria = null;
    if (body?.criteria !== undefined) {
      criteria = parseLlmCriteria(body.criteria);
      if (!criteria) {
        throw new HttpError(400, 'invalid_criteria', 'criteria must use risk_max, yield_min, commodity, financing_max, sort_by with valid values');
      }
    }
    const limit = Number.isInteger(body?.limit) ? body.limit : undefined;
    const result = await recommend(preference, availableCases, { criteria, limit });
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  // BE-12: Pool Subscribe
  if (method === 'POST' && pathname === '/api/pool/subscribe') {
    const body = requireRecordBody(await readJsonBody(request), 'pool_id, amount_usd and optional wallet_address');
    await ensureMockPools();
    if (typeof body.pool_id !== 'string' || body.pool_id === '') {
      throw new HttpError(400, 'invalid_request', 'pool_id must be a non-empty string');
    }
    if (typeof body.amount_usd !== 'number' || !Number.isFinite(body.amount_usd) || body.amount_usd <= 0) {
      throw new HttpError(400, 'invalid_amount', 'amount_usd must be a finite number greater than 0');
    }
    // The wallet is stored and later shown in dashboards: keep markup out of shared data.
    if (body.wallet_address !== undefined
        && (typeof body.wallet_address !== 'string' || !WALLET_PATTERN.test(body.wallet_address))) {
      throw new HttpError(400, 'invalid_wallet', 'wallet_address must look like 0x followed by up to 64 letters or digits');
    }
    const walletAddress = body.wallet_address || '0xDemoWallet';
    try {
      const { validateMysterySubscriptionSource } = await mysteryService();
      const source = await validateMysterySubscriptionSource({
        wallet_address: walletAddress,
        pool_id: body.pool_id,
        source: body.mystery_source
      });
      const res = subscribeToPool(walletAddress, body.pool_id, body.amount_usd, { source });
      logAgentActivity({
        type: 'INVESTMENT',
        action: 'SUBSCRIPTION',
        caseId: body.pool_id,
        poolId: body.pool_id,
        details: {
          amountUsd: res.investment.amountUsd,
          price: res.investment.price,
          wallet: shortAddress(walletAddress)
        }
      });
      sendJson(response, 200, { ok: true, ...res });
    } catch (err) {
      if (err.code && !(err instanceof HttpError)) {
        await sendMysteryError(response, err, err.code);
      } else {
        throw err;
      }
    }
    return;
  }

  // BE-12: Pool Status
  if (method === 'GET' && pathname === '/api/pool/status') {
    const poolId = url.searchParams.get('pool_id');
    await ensureMockPools();
    const pool = storeState.pools.get(poolId);
    if (!pool) throw new HttpError(404, 'pool_not_found', 'Pool not found');
    sendJson(response, 200, {
      ok: true,
      poolId,
      status: pool.status,
      subscribedUsd: pool.subscribedUsd,
      targetUsd: pool.targetUsd,
      // Offchain mirror only: pools here live in server memory, they are not contract reads.
      source: 'offchain-mirror',
      quoteUpdatedAt: pool.quoteUpdatedAt,
      quote: {
        final_issue_price_usd: pool.quote.final_issue_price_usd,
        implied_gross_yield_bps: pool.quote.implied_gross_yield_bps,
        risk_level: pool.quote.risk_level,
        risk_score_bps: pool.quote.risk_score_bps,
        pricing_action: pool.quote.pricing_action,
        recommended_token_supply: pool.quote.recommended_token_supply
      }
    });
    return;
  }

  // BE-13: Investors Portfolio
  if (method === 'GET' && pathname === '/api/investors/portfolio') {
    const walletAddress = url.searchParams.get('wallet_address') || '0xDemoWallet';
    const normalizedWalletAddress = walletAddress.toLowerCase();
    const myInvestments = storeState.investments.filter(
      (investment) => String(investment.walletAddress).toLowerCase() === normalizedWalletAddress
    );

    let totalInvested = 0;
    let weightedYieldSum = 0;
    myInvestments.forEach((inv) => {
      totalInvested += inv.amountUsd;
      weightedYieldSum += inv.amountUsd * inv.yieldBps;
    });

    const avgYieldBps = totalInvested > 0 ? (weightedYieldSum / totalInvested) : 0;

    sendJson(response, 200, {
      ok: true,
      wallet: walletAddress,
      investments: myInvestments,
      summary: {
        totalInvestedUsd: totalInvested,
        avgYieldBps: Math.round(avgYieldBps)
      }
    });
    return;
  }

  // BE-13: Exporters Dashboard
  if (method === 'GET' && pathname === '/api/exporters/dashboard') {
    await ensureMockPools();
    // Since exporter identity isn't strictly passed in demo, we return all active pools representing eBLs
    const myPools = Array.from(storeState.pools.values());
    sendJson(response, 200, {
      ok: true,
      total_ebl_submitted: myPools.length,
      pools: myPools.map((p) => ({
        poolId: p.poolId,
        status: p.status,
        financingUsd: p.quote.requested_cash_usd,
        createdAt: p.createdAt
      }))
    });
    return;
  }

  // BE-4: RWA offering lifecycle — issue, subscribe, reprice, pause, settle.
  // Pass `events` to escalate risk mid-transit; `subscription_usd` to size demand.
  if (method === 'POST' && pathname === '/api/offering/simulate') {
    const body = await readJsonBody(request);
    const { caseData, options } = await resolvePricingRequest(body, url);
    const offering = simulateOffering(caseData, {
      ...quoteOptions(options),
      subscription_usd: options.subscription_usd,
      events: options.events
    });
    assertPricingQuote(offering.initial_quote, caseData);
    sendJson(response, 200, offering);
    return;
  }

  // BE-6: merged PricingQuote + RiskReport + offering workflow simulation.
  if (method === 'POST' && pathname === '/api/workflow/pricing-simulate') {
    const body = await readJsonBody(request);
    const { caseData, options } = await resolvePricingRequest(body, url);
    sendJson(response, 200, simulatePricingWorkflow(caseData, {
      ...quoteOptions(options),
      subscription_usd: options.subscription_usd,
      events: options.events
    }));
    return;
  }

  // BE-8: on-chain oracle update payload (quote_hash / evidence_hash + terms)
  // for RiskPricingOracle.updatePricing / RWAOfferingPool.createOffering.
  if (method === 'POST' && pathname === '/api/oracle/pricing-update') {
    const body = await readJsonBody(request);
    const { caseData, options } = await resolvePricingRequest(body, url);
    const quote = normalizePricingQuoteHashes(quoteFromCase(caseData, quoteOptions(options)));
    assertPricingQuote(quote, caseData);
    sendJson(response, 200, toOracleUpdate(quote, { pool_id: options.pool_id }));
    return;
  }

  if (method === 'GET' && pathname === '/api/scenarios') {
    sendJson(response, 200, { ok: true, scenarios: await runHarnessScenarios() });
    return;
  }

  if (method === 'POST' && pathname === '/api/scenarios/run') {
    const caseData = await caseBodyOrDemo(await readJsonBody(request));
    sendJson(response, 200, runScenario(caseData));
    return;
  }

  // ========================
  // MCP / RAG / Skill Endpoints
  // ========================

  // MCP-1: Return tools manifest
  if (method === 'GET' && pathname === '/api/mcp/tools') {
    const { MCP_TOOLS_MANIFEST } = await import('../mcp/mcpServer.js');
    sendJson(response, 200, { ok: true, protocol: 'agentbl-mcp-v1', tools: MCP_TOOLS_MANIFEST });
    return;
  }

  // MCP-2~5: Universal tool call dispatcher
  if (method === 'POST' && pathname === '/api/mcp/call') {
    const body = await readJsonBody(request);
    if (!isRecord(body) || typeof body.tool !== 'string' || body.tool === '') {
      sendJson(response, 400, { ok: false, error: 'Missing "tool" in request body. Available tools: GET /api/mcp/tools' });
      return;
    }
    if (body.params !== undefined && !isRecord(body.params)) {
      sendJson(response, 400, { ok: false, error: '"params" must be an object', tool: body.tool });
      return;
    }
    try {
      const { callTool } = await import('../mcp/mcpServer.js');
      const result = await callTool(body.tool, body.params ?? {});
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message, tool: body.tool });
    }
    return;
  }

  // RAG: Search knowledge base
  if (method === 'POST' && pathname === '/api/rag/search') {
    const body = await readJsonBody(request);
    if (!isRecord(body) || typeof body.query !== 'string' || body.query.trim() === '') {
      sendJson(response, 400, { ok: false, error: 'Missing "query" in request body' });
      return;
    }
    const limit = Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 50) : 10;
    const { searchKnowledgeBase } = await import('../rag/search.js');
    const results = searchKnowledgeBase(body.query, {
      categories: Array.isArray(body.categories) ? body.categories : undefined,
      limit
    });
    sendJson(response, 200, { ok: true, query: body.query, matches: results, match_count: results.length });
    return;
  }

  // RAG-2: Return Judge Q&A pairs
  if (method === 'GET' && pathname === '/api/rag/judge-qa') {
    const { JUDGE_QA_PAIRS } = await import('../rag/judgeQA.js');
    sendJson(response, 200, { ok: true, pairs: JUDGE_QA_PAIRS });
    return;
  }

  // RAG: Full risk sweep for a case
  if (method === 'POST' && pathname === '/api/rag/risk-sweep') {
    const caseData = await caseBodyOrDemo(await readJsonBody(request));
    const { fullRiskSweep } = await import('../rag/search.js');
    sendJson(response, 200, { ok: true, ...fullRiskSweep(caseData) });
    return;
  }

  // INTEL: live real-world risk via xAPI (Twitter/X + Google News + prediction
  // markets) -> structured macro_risk_events -> re-priced quote (before/after).
  // No XAPI_KEY -> deterministic offline fixtures, so the endpoint never breaks.
  if (method === 'POST' && pathname === '/api/intel/world-risk') {
    const body = await readJsonBody(request);
    const caseData = looksLikeCase(body) ? body : (isRecord(body) && body.case ? body.case : await loadDemoCase());
    const { assessWorldRisk } = await import('../agent/worldRiskAgent.js');
    const { repriceWithWorldRisk } = await import('../core/worldRiskPricing.js');
    const assessment = await assessWorldRisk(caseData, {});
    const repriced = repriceWithWorldRisk(caseData, assessment.events);
    if (assessment.events?.length) {
      logAgentActivity({
        type: 'RISK',
        action: 'RISK_ESCALATION',
        caseId: caseData?.case_id,
        details: {
          events: assessment.events.length,
          provider: assessment.provider,
          price: repriced.after?.final_issue_price_usd
        }
      });
    }
    sendJson(response, 200, {
      ok: true,
      live: assessment.live,
      provider: assessment.provider,
      queried: assessment.queried,
      profile: assessment.profile,
      events: assessment.events,
      signals: assessment.signals,
      sources: assessment.sources,
      summary: assessment.summary,
      evidence_hash: assessment.evidence_hash,
      before_quote: repriced.before,
      after_quote: repriced.after,
      delta: repriced.delta
    });
    return;
  }

  // SKILL-1: Run pricing analyst
  if (method === 'POST' && pathname === '/api/skill/pricing-analyst') {
    const input = skillInput(await readJsonBody(request));
    if (input.payout_speed !== undefined && !PAYOUT_SPEEDS.includes(input.payout_speed)) {
      throw new HttpError(400, 'invalid_request', `payout_speed must be one of: ${PAYOUT_SPEEDS.join(', ')}`);
    }
    const { runPricingAnalyst } = await import('../skill/pricingAnalyst.js');
    sendJson(response, 200, { ok: true, ...await runPricingAnalyst(input) });
    return;
  }

  // SKILL-2: Run demo operator
  if (method === 'POST' && pathname === '/api/skill/demo-operator') {
    const input = skillInput(await readJsonBody(request));
    const { runDemoOperator } = await import('../skill/demoOperator.js');
    sendJson(response, 200, { ok: true, ...await runDemoOperator(input) });
    return;
  }

  // ========================
  // x402 Pay-to-Unlock Endpoints (HTTP 402 Premium Intel)
  // ========================

  // x402 config — available paid services
  if (method === 'GET' && pathname === '/api/x402/config') {
    const x402Config = await import('../x402/config.js');
    sendJson(response, 200, {
      ok: true,
      services: X402_SERVICES,
      network: x402Config.x402Network(),
      facilitatorUrl: x402Config.x402FacilitatorUrl(),
      configured: x402Config.isX402Configured(),
      appMode: demoModeController.snapshot()
    });
    return;
  }

  // x402 re-read: return an already-paid report by id within its TTL, with
  // no new charge. A miss (unknown id or expired) is a 404 — the caller must
  // pay again. This backs the UI's "purchased reports survive a refresh".
  if (method === 'GET' && pathname.startsWith('/api/x402/report/')) {
    const reportId = safeDecodeURIComponent(pathname.slice('/api/x402/report/'.length));
    const { getPaidReportCache } = await import('../x402/reportStore.js');
    const cached = await getPaidReportCache().read(reportId);
    if (!cached) {
      sendJson(response, 404, {
        ok: false,
        code: 'paid_report_not_cached',
        error: 'No unexpired paid report is cached for this id; payment is required again'
      });
      return;
    }
    sendJson(response, 200, { ok: true, cached: true, ...cached.report, expires_at: cached.expires_at });
    return;
  }

  // Paid services. Demo mode uses the personal-sign compatibility transport; Live mode
  // uses the verified x402 V2 gateway (EIP-3009 authorization settled by the facilitator).
  const paidService = X402_SERVICES.find((entry) => entry.endpoint === pathname);
  if (paidService) {
    await handlePaidService(request, response, paidService);
    return;
  }

  // x402 smoke test — end-to-end: unpaid 402 → paid → intel unlocked
  if (method === 'POST' && pathname === '/api/x402/smoke') {
    if (!demoModeController.snapshot().demoMode) {
      sendJson(response, 409, {
        ok: false,
        code: 'demo_smoke_disabled_in_live_mode',
        error: 'The simulated x402 smoke endpoint is disabled in live mode'
      });
      return;
    }
    const body = await readJsonBody(request);
    const caseData = looksLikeCase(body) ? body : (isRecord(body) && body.case ? body.case : await loadDemoCase());
    const requestedServiceId = isRecord(body) && body.serviceId ? String(body.serviceId) : 'premium-risk';
    const service = X402_SERVICES.find((entry) => entry.serviceId === requestedServiceId);
    if (!service) {
      sendJson(response, 400, { ok: false, error: 'Unknown x402 serviceId', serviceId: requestedServiceId });
      return;
    }
    if (service.serviceId === 'mystery-voyage') {
      sendJson(response, 400, {
        ok: false,
        code: 'mystery_preview_required',
        error: 'Use /api/mystery/preview followed by /api/x402/mystery/voyage'
      });
      return;
    }
    const { PAID_REPORT_BUILDERS } = await import('../x402/endpoints.js');
    const { recordPaymentEvidence } = await import('../x402/settlement.js');

    // Step 1: simulate fetching premium report with payment
    const reportBuilder = PAID_REPORT_BUILDERS[service.serviceId];
    const intelResult = await reportBuilder(caseData);

    // Step 2: record payment evidence (on-chain in production)
    const paymentResult = await recordPaymentEvidence({
      serviceId: service.serviceId,
      amountUSDC: service.priceUSDC,
      responseData: intelResult
    });

    const steps = [{
      step: 1,
      action: 'x402_challenge',
      status: '402_returned',
      mode: 'demo',
      detail: 'Server returned HTTP 402 Payment Required'
    }, {
      step: 2,
      action: 'payment_signed',
      status: 'signed',
      mode: 'demo',
      detail: 'DEMO (simulated) — no EIP-3009 authorization was signed'
    }, {
      step: 3,
      action: 'settlement',
      status: 'settled',
      mode: 'demo',
      txHash: paymentResult.payment.txHash,
      detail: 'DEMO (simulated) settlement of ' + service.priceUSDC + ' USDC — not an on-chain transaction'
    }, {
      step: 4,
      action: 'intel_unlocked',
      status: 'unlocked',
      mode: 'demo',
      detail: service.title + ' returned — ' + (intelResult.events?.length || 0) + ' risk events, ' + (intelResult.deepIntel?.length || 0) + ' evidence entries'
    }];

    sendJson(response, 200, {
      ...intelResult,
      ok: true,
      steps,
      payment: paymentResult.payment,
      intel_preview: {
        events_count: intelResult.events?.length || 0,
        deep_intel_count: intelResult.deepIntel?.length || 0,
        before_price: intelResult.before_quote?.final_issue_price_usd,
        after_price: intelResult.after_quote?.final_issue_price_usd,
        price_delta: intelResult.delta?.issue_price_delta_usd
      }
    });
    return;
  }

  // BE-14: eBL Document Upload with ENI Adapter
  if (method === 'POST' && pathname === '/api/ebl/upload') {
    const body = await readJsonBody(request);
    const { eniAdapter } = await import('./eniAdapter.js');

    if (!isRecord(body) || !body.file) {
      sendJson(response, 400, { ok: false, error: 'Missing file object in request body' });
      return;
    }

    const caseId = body.case_id === undefined ? null : String(body.case_id).slice(0, 128);
    const result = await eniAdapter.uploadDocument(body.file);

    // Remember which case a document belongs to. The orchestrator is NOT triggered from here yet
    // (see docs/agent-implementation-plan.md WP2.1/WP2.4); recording the link is all this does.
    if (caseId) {
      if (!storeState.eblDocuments) storeState.eblDocuments = new Map();
      storeState.eblDocuments.set(result.documentId, { ...result, caseId });
    }
    logAgentActivity({
      type: 'DOCUMENT',
      action: 'eBL_UPLOADED',
      caseId: caseId ?? undefined,
      details: { fileName: result.fileName, documentId: result.documentId, status: result.status }
    });

    sendJson(response, 200, {
      ok: true,
      document: result,
      message: 'Document uploaded successfully',
      eni_mode: eniAdapter.mode
    });
    return;
  }

  // BE-14: Get Document Status
  if (method === 'GET' && pathname === '/api/ebl/document-status') {
    const documentId = url.searchParams.get('document_id');
    if (!documentId) {
      sendJson(response, 400, { ok: false, error: 'Missing document_id parameter' });
      return;
    }

    const { eniAdapter } = await import('./eniAdapter.js');
    const status = await eniAdapter.getDocumentStatus(documentId);

    sendJson(response, 200, { ok: true, ...status });
    return;
  }

  // Agent runtime: status, control, events, decisions, approvals, pools.
  if (await handleAgentRoute(request, response, url)) return;

  // BE-15: Agent Activity Query API
  if (method === 'GET' && pathname === '/api/agent/activity') {
    const caseId = url.searchParams.get('case_id');
    const poolId = url.searchParams.get('pool_id');

    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const sinceRaw = url.searchParams.get('since_seq');
    const filters = { caseId: caseId ?? undefined, poolId: poolId ?? undefined };
    const activities = sinceRaw === null
      ? activityLog.list({ ...filters, limit })
      : await activityLog.since(Number(sinceRaw), { ...filters, limit });

    sendJson(response, 200, {
      ok: true,
      activities,
      count: activityLog.count(filters),
      last_seq: activityLog.seq
    });
    return;
  }

  // BE-15: Agent Activity Real-time Subscription (SSE)
  if (method === 'GET' && pathname === '/api/agent/activity/stream') {
    openActivityStream(request, response, url);
    return;
  }

  if (pathname.startsWith('/api/')) {
    throw new HttpError(404, 'not_found', 'Unknown API route');
  }

  if (method === 'GET' || method === 'HEAD') {
    await getStaticHandler()(request, response, pathname);
    return;
  }

  response.setHeader('Allow', 'GET, HEAD');
  throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
}

export async function handleRequest(request, response) {
  const requestId = crypto.randomBytes(6).toString('hex');
  response.setHeader('X-Request-Id', requestId);
  try {
    const url = parseRequestUrl(request);
    applySecurityHeaders(response, { isApi: url.pathname.startsWith('/api/') });
    enforceRateLimits(request, response, url);
    await routeRequest(request, response, url);
  } catch (error) {
    sendError(response, error, { requestId });
  }
}

export function createServer() {
  const server = http.createServer((request, response) => {
    // handleRequest reports its own errors; this is the last line of defence so
    // that no rejection can ever take the process down.
    handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('Internal server error');
    });
  });
  // Bound slow clients (slowloris) without cutting off long-lived SSE/LLM responses,
  // which are governed by the response side rather than these request timeouts.
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return server;
}

function printStartupNotes(port, host) {
  console.log(`AgentBL Agent harness running at http://localhost:${port}${host ? ` (listening on ${host})` : ''}`);
  const llm = llmStatus();
  console.log(llm.configured
    ? `LLM relay: ${llm.provider} / ${llm.model} (key stays on the server)`
    : 'LLM relay: no provider configured (assistant falls back to keyword search)');
  const token = String(process.env.AGENTBL_ADMIN_TOKEN ?? '').trim();
  if (token && token.length < MIN_ADMIN_TOKEN_LENGTH) {
    console.warn(`WARNING: AGENTBL_ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters and is ignored.`);
  }
  if (demoModeController.snapshot().liveAvailable && !checkAdminToken({ headers: {} }).configured) {
    console.warn('WARNING: Live mode is configured but AGENTBL_ADMIN_TOKEN is not set; runtime mode switching is disabled.');
  }
}

function installGracefulShutdown(server) {
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down...`);
    closeActivityStreams();
    // Let the agent finish the event it is on and write its state before the process ends.
    const agentStopped = (agentService?.stop() ?? Promise.resolve()).catch(() => {});
    agentStopped.finally(() => activityLog.flush().catch(() => {})).finally(() => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Entry point only: switch persistence on and start the agent unless AGENT_ENABLED=false. */
async function startAgentRuntime() {
  const config = loadAgentConfig();
  if (!config.enabled) {
    console.log('[agentbl] agent runtime disabled (AGENT_ENABLED=false); decisions and activity stay readable.');
    return;
  }
  await attachActivityPersistence(activityLog);
  agentService = createAgentService({
    demoModeController,
    ensurePools: () => ensureMockPools(),
    activity: activityLog,
    store: storeState,
    persist: true
  });
  const status = await agentService.start();
  console.log(`[agentbl] agent runtime started: mode=${status.mode} autonomy=${status.autonomy.effective}${status.autonomy.downgraded ? ' (auto is treated as propose in Live)' : ''}`);
}

const isEntryPoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntryPoint) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST || undefined;
  // Leftovers of writes that crashed mid-flight (see src/lib/jsonStore.js).
  cleanupOrphanTemps(runtimeDir()).catch(() => {});
  const server = createServer();
  server.listen(port, host, () => printStartupNotes(port, host));
  installGracefulShutdown(server);
  startAgentRuntime().catch((error) => console.error('[agentbl] agent runtime failed to start:', error));
}
