// AgentBL MCP Tool Implementations
// Deterministic trade/pricing/document/report capabilities.
// Financing transactions use the controlled participant-wallet workflow.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listenOnUsablePort } from '../../scripts/lib/listen.mjs';
import { quoteFromCase } from '../core/pricingEngine.js';
import { normalizePricingQuoteHashes, PAYOUT_SPEEDS, assertPricingQuote } from '../core/pricingSchema.js';
import { simulateWorkflow } from '../core/workflow.js';
import { simulateOffering } from '../core/offeringSimulator.js';
import { assertTradeCase } from '../core/schema.js';
import { listHarnessCaseFiles } from '../core/scenarioRunner.js';
import { prepareCuratedCase } from '../core/curatedCases.js';
import { searchKnowledgeBase } from '../rag/search.js';
import { checkDocumentConsistency } from '../agent/documentConsistency.js';
import { authorizeMcpWrite, MCP_PINNED_NETWORK } from './security.js';
import { X402_SERVICES } from '../x402/config.js';
import { loadApplicationConfig } from '../chain/loadApplicationConfig.js';
import { previewMysteryVoyage } from '../mystery/service.js';
import { MysteryRevealStore } from '../mystery/store.js';
import { verifyRevealProof } from '../mystery/fairness.js';

// Import Bowen's pricing engine — for real PricingQuote generation

const MYSTERY_OPEN_PRICE_USDC = 0.001;
const CURATED_CASES = path.resolve(import.meta.dirname, '../../data/cases');

/**
 * Every case the tools can name: the demo and harness scenarios as stored, then the market's public curated cases
 * as the app shows them (dates moved to today, market and route evidence attached). Private uploads are never listed.
 */
async function caseCatalog() {
  const cases = [];
  for (const file of await listHarnessCaseFiles({ includeDemo: true })) cases.push(JSON.parse(await fs.readFile(file, 'utf8')));
  const seen = new Set(cases.map((data) => data.case_id));
  const curated = (await fs.readdir(CURATED_CASES).catch(() => [])).filter((name) => name.endsWith('.case.json')).sort();
  for (const name of curated) {
    const raw = JSON.parse(await fs.readFile(path.join(CURATED_CASES, name), 'utf8'));
    if (seen.has(raw.case_id) || raw.visibility === 'private') continue;
    seen.add(raw.case_id);
    cases.push({ raw, load: () => prepareCuratedCase(raw) });
  }
  return cases;
}
const caseIdOf = (entry) => entry.raw?.case_id ?? entry.case_id;

/** The original TradeCase schema applies to harness-style cases; current cases (no legacy financing block) are
 * validated by the pricing engine and its quote schema instead, as the app's own pricing routes do. */
function checkCase(caseData) {
  if (caseData?.financing?.requested_amount_usd !== undefined || caseData?.financing?.requested_cash_usd === undefined) assertTradeCase(caseData);
}
const caseDataOf = async (entry) => entry.load ? entry.load() : entry;

async function loadMysteryPools(caseId) {
  const pools = new Map();
  for (const entry of await caseCatalog()) {
    if (caseId && caseIdOf(entry) !== caseId) continue;
    if (entry.raw?.historical) continue;
    const caseData = await caseDataOf(entry);
    if (!caseData.financing) continue;
    try {
      const configuredSpeed = caseData.financing.payout_speed;
      const quote = normalizePricingQuoteHashes(quoteFromCase(caseData, {
        payout_speed: PAYOUT_SPEEDS.includes(configuredSpeed) ? configuredSpeed : 'BALANCED'
      }));
      assertPricingQuote(quote, caseData);
      const createdAt = new Date().toISOString();
      pools.set(caseData.case_id, {
        poolId: caseData.case_id,
        caseData,
        quote,
        status: 'Open',
        subscribedUsd: 0,
        targetUsd: quote.requested_cash_usd,
        createdAt,
        quoteUpdatedAt: createdAt,
        complianceStatus: 'CLEARED',
        investorEligible: true
      });
    } catch {
      // Skip legacy fixtures that cannot be normalized into a PricingQuote.
    }
  }
  if (caseId && !pools.has(caseId)) throw new Error(`Mystery case not found or not priceable: ${caseId}`);
  if (pools.size === 0) throw new Error('No priceable Mystery Voyage cases are available');
  return pools;
}

/**
 * Load a trade case by its case_id: the demo, the harness scenarios and the market's curated cases.
 *
 * @param {string} caseId
 * @returns {Promise<Object>} TradeCase object
 * @throws {Error} if not found
 */
async function loadCaseById(caseId) {
  const catalog = await caseCatalog();
  const entry = catalog.find((item) => caseIdOf(item) === caseId);
  if (!entry) throw new Error(`Trade case not found: ${caseId}. Known cases: ${catalog.map(caseIdOf).join(', ')}`);
  const data = await caseDataOf(entry);
  checkCase(data);
  return data;
}

// ============================================================
// Tool 1: get_trade_case
// ============================================================

export async function handleGetTradeCase({
  case_id
}) {
  if (!case_id || typeof case_id !== 'string') {
    throw new Error('Missing required parameter: case_id (string)');
  }
  const caseData = await loadCaseById(case_id);
  return {
    tool: 'get_trade_case',
    result: caseData
  };
}

// ============================================================
// Tool 2: generate_pricing_quote
// ============================================================

export async function handleGeneratePricingQuote({
  case_id,
  trade_case
} = {}) {
  const caseData = trade_case || (case_id ? await loadCaseById(case_id) : null);
  if (!caseData) throw new Error('Either case_id or trade_case must be provided');
  checkCase(caseData);
  const quote = quoteFromCase(caseData, {
    payout_speed: caseData.financing?.payout_speed ?? 'BALANCED'
  });
  assertPricingQuote(quote, caseData);
  return {
    tool: 'generate_pricing_quote',
    result: quote
  };
}

// ============================================================
// Tool 3: simulate_offering
// ============================================================

export async function handleSimulateOffering({
  case_id,
  trade_case
} = {}) {
  const caseData = trade_case || (case_id ? await loadCaseById(case_id) : null);
  if (!caseData) {
    throw new Error('Either case_id or trade_case must be provided');
  }
  // A current case has no legacy risk-workflow fields: simulate its offering on the pricing model the app uses.
  if (caseData?.financing?.requested_amount_usd === undefined && caseData?.financing?.requested_cash_usd !== undefined) {
    const offering = simulateOffering(caseData, { payout_speed: PAYOUT_SPEEDS.includes(caseData.financing.payout_speed) ? caseData.financing.payout_speed : 'BALANCED' });
    const quote = offering.final_quote;
    return {
      tool: 'simulate_offering',
      result: {
        case_id: offering.case_id,
        final_state: offering.final_state,
        offering_state: offering.final_state,
        steps: offering.steps,
        initial_quote: offering.initial_quote,
        settlement: offering.settlement,
        pricing_summary: { final_issue_price_usd: quote.final_issue_price_usd, pricing_action: quote.pricing_action, risk_level: quote.risk_level, risk_score_bps: quote.risk_score_bps }
      }
    };
  }
  const workflow = simulateWorkflow(caseData);
  const report = workflow.risk_report;

  // Augment with RWA offering-specific fields
  const offeringResult = {
    case_id: workflow.case_id,
    final_state: workflow.final_state,
    offering_state: workflow.final_state,
    risk_report: report,
    steps: workflow.steps,
    pricing_summary: {
      health_factor: report.health_factor,
      cargo_health_score: report.cargo_health_score,
      recommended_ltv: report.recommended_ltv,
      contract_action: report.contract_action,
      risk_level: report.risk_level
    }
  };
  return {
    tool: 'simulate_offering',
    result: offeringResult
  };
}

// ============================================================
// Tool: search_knowledge_base
// ============================================================

export async function handleSearchKnowledgeBase({
  query,
  categories,
  limit
} = {}) {
  if (!query || typeof query !== 'string' || query.trim() === '') {
    throw new Error('Missing required parameter: query (non-empty string)');
  }
  const results = searchKnowledgeBase(query, {
    categories: Array.isArray(categories) ? categories : undefined,
    limit: typeof limit === 'number' && limit > 0 ? limit : 5
  });
  return {
    tool: 'search_knowledge_base',
    result: {
      query: query.trim(),
      matches: results,
      match_count: results.length,
      categories_searched: categories || 'all'
    }
  };
}

// ============================================================
// Tool 6: verify_trade_documents
// ============================================================

export async function handleVerifyTradeDocuments({
  case_id,
  trade_case
} = {}) {
  const caseData = trade_case || (case_id ? await loadCaseById(case_id) : null);
  if (!caseData) throw new Error('Either case_id or trade_case must be provided');
  checkCase(caseData);
  return {
    tool: 'verify_trade_documents',
    result: checkDocumentConsistency(caseData)
  };
}
async function withEphemeralApp(run) {
  const {
    createServer
  } = await import('../app/server.js');
  const server = createServer();
  await listenOnUsablePort(server, '127.0.0.1');
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ============================================================
// Tool 7: purchase_premium_analysis
// ============================================================

/** The mode of the runtime serving this call: the app's agent service when present, else this process's own setting. */
function runtimeMode(context) {
  const mode = context?.getService?.()?.getMode?.();
  if (mode === 'demo' || mode === 'live') return mode;
  return process.env.DEMO_MODE === 'false' ? 'live' : 'demo';
}

export async function handlePurchasePremiumAnalysis({
  case_id,
  kind = 'premium-risk',
  mode = 'demo',
  budget_usdc = 0.005,
  approved = false,
  approval_token
} = {}, context) {
  if (!case_id) throw new Error('Missing required parameter: case_id');
  const service = X402_SERVICES.find(item => item.serviceId === kind);
  if (!service) throw new Error(`Unknown premium analysis kind: ${kind}`);
  if (!['demo', 'live'].includes(mode)) throw new Error('mode must be demo or live');
  // A simulated purchase must never hand out a report that a Live runtime sells for a real payment.
  if (mode === 'demo' && runtimeMode(context) === 'live') {
    throw Object.assign(new Error('Simulated purchases are disabled while the runtime is Live; pay through the Live x402 flow'), {
      code: 'demo_purchase_disabled_in_live_mode',
      status: 409,
      expose: true
    });
  }
  const caseData = await loadCaseById(case_id);
  if (mode === 'live') {
    const chainConfig = loadApplicationConfig();
    authorizeMcpWrite({
      operation: 'x402_payment',
      network: MCP_PINNED_NETWORK,
      contract: chainConfig.contracts?.PaymentOracle,
      amount_usdc: service.priceUSDC,
      dry_run: false,
      approved,
      approval_token
    });
    throw new Error('Live MCP purchase requires the V2 facilitator client; use npm run smoke:x402:live. Demo mode still traverses the HTTP 402 middleware.');
  }
  const {
    fetchPaidIntel
  } = await import('../x402/client.js');
  // The runtime is in Demo (checked above), so its paid routes already use the simulated transport. Process-wide
  // settings are never rewritten here: other requests served meanwhile would see a different payment mode.
  const result = await withEphemeralApp(baseUrl => fetchPaidIntel(baseUrl, service.endpoint, {
    demoMode: true,
    budgetUSDC: Number(budget_usdc),
    caseData,
    timeoutMs: 15_000
  }));
  if (!result.paid?.report_envelope) throw new Error(result.error?.error ?? 'Paid report was not unlocked');
  const envelope = result.paid.report_envelope;
  return {
    tool: 'purchase_premium_analysis',
    result: {
      payment: {
        mode: 'demo',
        protocol: 'x402',
        challenged: result.x402_required,
        network: result.network,
        amount_usdc: result.priceUSDC,
        settlement_tx: envelope.payment_tx,
        live: false
      },
      report: envelope,
      oracle_proof: {
        event: null,
        attestation_tx: null,
        onchain: false,
        reason: 'demo_mode'
      }
    }
  };
}

// ============================================================
// Tool 8: preview_mystery_voyage
// ============================================================

export async function handlePreviewMysteryVoyage({
  wallet_address,
  case_id,
  risk_passport = {
    tier: 'BALANCED'
  },
  budget_usdc = MYSTERY_OPEN_PRICE_USDC,
  idempotency_key,
  ttl_seconds
} = {}) {
  const budget = Number(budget_usdc);
  if (!Number.isFinite(budget) || budget < MYSTERY_OPEN_PRICE_USDC) {
    throw new Error(`Mystery Voyage report price is ${MYSTERY_OPEN_PRICE_USDC} USDC; budget_usdc is too low`);
  }
  if (!wallet_address) throw new Error('Missing required parameter: wallet_address');
  const pools = await loadMysteryPools(case_id);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-mcp-mystery-'));
  const store = new MysteryRevealStore({
    filePath: path.join(directory, 'reveals.json')
  });
  try {
    const preview = await previewMysteryVoyage({
      wallet_address,
      risk_passport,
      idempotency_key,
      ttl_seconds
    }, {
      pools,
      store
    });
    return {
      tool: 'preview_mystery_voyage',
      result: {
        ...preview,
        authorization: {
          report_price_usdc: MYSTERY_OPEN_PRICE_USDC,
          budget_usdc: budget,
          budget_ok: true,
          payment_authorized: false,
          human_approval_required: true,
          automatically_subscribes_rwa: false,
          next_step: 'Use the host wallet and the x402 payment flow to open the report.'
        }
      }
    };
  } finally {
    await fs.rm(directory, {
      recursive: true,
      force: true
    });
  }
}

// ============================================================
// Tool 9: verify_mystery_reveal
// ============================================================

export async function handleVerifyMysteryReveal({
  proof,
  report,
  report_envelope
} = {}) {
  if (!proof || typeof proof !== 'object') throw new Error('Missing required parameter: proof');
  const verification = verifyRevealProof(proof);
  const errors = [...verification.errors];
  const bindings = [['report.selected_pool_id', report?.selected_pool_id, proof.selected_pool_id], ['report.reveal_proof_hash', report?.reveal_proof_hash, proof.reveal_proof_hash], ['report.risk_passport_hash', report?.risk_passport_hash, proof.risk_passport_hash], ['report_envelope.selected_pool_id', report_envelope?.selected_pool_id, proof.selected_pool_id], ['report_envelope.reveal_proof_hash', report_envelope?.reveal_proof_hash, proof.reveal_proof_hash], ['report_envelope.risk_passport_hash', report_envelope?.risk_passport_hash, proof.risk_passport_hash], ['report_envelope.payment_tx', report_envelope?.payment_tx, proof.payment_tx_hash]];
  for (const [field, actual, expected] of bindings) {
    if (actual !== undefined && String(actual).toLowerCase() !== String(expected).toLowerCase()) {
      errors.push(`${field} mismatch`);
    }
  }
  return {
    tool: 'verify_mystery_reveal',
    result: {
      valid: errors.length === 0,
      errors,
      reveal_id: proof.reveal_id,
      selected_pool_id: proof.selected_pool_id,
      reveal_proof_hash: proof.reveal_proof_hash,
      candidate_count: proof.candidate_pool_ids?.length ?? 0,
      investment_authorized: false,
      subscription_requires_independent_signature: true
    }
  };
}
