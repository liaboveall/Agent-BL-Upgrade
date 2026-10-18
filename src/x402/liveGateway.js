// Live x402 V2 gateway.
//
// The plain-http app server cannot run Express middleware, so the verified EIP-3009
// payment middleware (createX402PaymentMiddleware) used to be reachable only from its
// own unit tests: in Live mode every paid route answered 503. This module mounts it
// for the app's paid services inside an Express sub-application that the server
// delegates to whenever Live mode is on:
//
//   1. preflight  - validate the request BEFORE the buyer is charged (Mystery Voyage)
//   2. payment    - 402 challenge, or verify + settle through the facilitator
//   3. delivery   - build the report, PaidReportEnvelope, on-chain attestation, cache
//
// Settlement is idempotent per signed authorization: if delivery fails after the
// payment settled, re-sending the same PAYMENT-SIGNATURE re-runs delivery and never
// charges twice (the response says so).
import express from 'express';
import { decodePaymentSignatureHeader } from '@injectivelabs/x402/client';
import { loadX402Config, X402_SERVICES } from './config.js';
import { deliverPaidReport } from './delivery.js';
import { createX402Runtime } from './server.js';
import { paidRouteMap } from './discovery.js';
import { rightsKey } from '../rights/vault.js';

const JSON_LIMIT = '1mb';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

/** Route map (the shape createX402PaymentMiddleware expects) derived from the paid-service catalog. */
export function liveRouteMap(config, services = X402_SERVICES) {
  return paidRouteMap(config, services);
}

function trustedHops(value) {
  if (value === undefined || value === '' || value === 'false' || value === '0') return 0;
  if (value === 'true') return 1;
  const hops = Number(value);
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
}

/** The wallet named in a still-unverified PAYMENT-SIGNATURE (only used for pre-payment checks). */
function claimedPayer(req) {
  const header = req.get('PAYMENT-SIGNATURE') ?? req.get('X-PAYMENT');
  if (!header) return null;
  try {
    const from = decodePaymentSignatureHeader(header)?.payload?.authorization?.from;
    return ADDRESS_RE.test(String(from)) ? from : null;
  } catch {
    return null;
  }
}

const SETTLEMENT_STATUS = Object.freeze({
  payment_independent_verification_required: 503,
  payment_oracle_unavailable: 503,
  payment_oracle_write_failed: 502,
  payment_tx_invalid: 502,
  paid_report_required: 500,
  payment_payer_mismatch: 500
});

function describeGatewayError(error, describeError) {
  // The envelope is built by this server: if it does not validate, that is OUR bug (500),
  // not a bad client request, whatever the generic mapper would say.
  if (error?.code === 'paid_report_invalid') {
    return { status: 500, code: 'internal_error', message: 'Internal server error' };
  }
  const custom = describeError?.(error);
  if (custom && custom.status < 500) return custom;
  if (error?.type === 'entity.parse.failed') return { status: 400, code: 'invalid_json', message: 'Request body is not valid JSON' };
  if (error?.type === 'entity.too.large') return { status: 413, code: 'payload_too_large', message: 'Request body is too large' };
  if (SETTLEMENT_STATUS[error?.code]) {
    return { status: SETTLEMENT_STATUS[error.code], code: error.code, message: error.message };
  }
  if (custom) return custom;
  return { status: 500, code: 'internal_error', message: 'Internal server error' };
}

/**
 * @param {object} options
 * @param {Record<string, { preflight?: Function, handler: Function }>} options.definitions per-service business logic
 * @param {Function} [options.describeError] maps domain errors to { status, code, message, details }
 * @param {Function} [options.attest] PaymentOracle attestation (defaults to recordPaymentEvidence)
 * @param {Function} [options.fetchImpl] facilitator transport (tests inject a fake)
 */
export async function createLiveGateway(options = {}) {
  const { definitions, services = X402_SERVICES, env = process.env, logger = console } = options;
  if (!definitions) throw new TypeError('definitions are required');

  const config = options.config ?? loadX402Config(env, { mode: 'live' });
  if (config.mode !== 'live') throw new TypeError('The live gateway requires a live x402 configuration');
  const deliveryKey = options.deliveryKey ?? options.settlementService?.deliveryKey ?? rightsKey(env);
  if (!deliveryKey) throw new Error('Live paid-report recovery requires the separately managed AGENTBL_RIGHTS_KEY');

  const runtime = await createX402Runtime({
    config,
    routes: liveRouteMap(config, services),
    baseUrl: options.baseUrl ?? env.AGENTBL_PUBLIC_BASE_URL ?? env.X402_PUBLIC_BASE_URL,
    fetchImpl: options.fetchImpl,
    store: options.store,
    settlementService: options.settlementService,
    now: options.now,
    clock: options.clock,
    delay: options.delay,
    baseDelayMs: options.baseDelayMs,
    verifier: options.verifier,
    rpcUrl: options.rpcUrl ?? env.X402_RPC_URL ?? env.INJECTIVE_RPC_URL,
    confirmations: options.confirmations ?? Number(env.X402_CONFIRMATIONS ?? 2),
    unlockOnFinish: false,
    deliveryKey,
    canSettle: options.canSettle,
    env
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustedHops(env.TRUST_PROXY));
  app.use(express.json({ limit: JSON_LIMIT }));

  // 1) Reject invalid requests before any money moves.
  for (const service of services) {
    const { preflight } = definitions[service.serviceId] ?? {};
    if (!preflight) continue;
    app.post(service.endpoint, express.json({ limit: JSON_LIMIT }), async (req, res, next) => {
      const payer = claimedPayer(req);
      if (!payer) return next(); // unpaid probe or malformed header: the payment middleware answers 402
      try {
        await preflight({ body: req.body ?? null, payer });
        return next();
      } catch (error) {
        return next(error);
      }
    });
  }

  // 2) 402 challenge / verify + settle.
  app.use(runtime.middleware);

  // 3) Delivery (only reachable once the payment middleware settled).
  app.use(express.json({ limit: JSON_LIMIT }));
  for (const service of services) {
    const definition = definitions[service.serviceId];
    if (!definition?.handler) throw new TypeError(`No handler defined for ${service.serviceId}`);
    app.post(service.endpoint, async (req, res, next) => {
      const receipt = req.x402;
      try {
        const record = await runtime.settlementService.get(receipt.paymentId);
        const deliveredBody = await runtime.settlementService.deliver(receipt.paymentId, async (prepared, checkpoint) => {
        const report = prepared?.report ?? await definition.handler({
          body: req.body ?? null,
          payer: receipt.payer,
          paymentTx: receipt.transaction,
          live: true
        });
        const delivered = await deliverPaidReport({
          preparedEnvelope: prepared?.envelope ?? null,
          checkpoint,
          serviceId: service.serviceId,
          priceUSDC: service.priceUSDC,
          payer: receipt.payer,
          payTo: config.payTo,
          network: config.network,
          asset: config.asset,
          paymentTx: receipt.transaction,
          settledAt: record?.settled_at ?? new Date().toISOString(),
          live: true,
          payment: {
            independent_verification: record.independent_verification,
            txHash: receipt.transaction,
            explorerUrl: `${config.explorerUrl}/tx/${receipt.transaction}`,
            live: true,
            onchain: true
          },
          report,
          attest: options.attest
        });
        return delivered.deliveredBody;
        });
        await runtime.settlementService.markUnlocked(receipt.paymentId, { resource: req.path, delivery: 'durably_available' });
        res.json(deliveredBody);
      } catch (error) {
        // The buyer has already paid: say so, and that a retry is free.
        error.payment = {
          status: 'settled',
          txHash: receipt.transaction,
          payer: receipt.payer,
          retry: 'Re-send the same PAYMENT-SIGNATURE to receive the report; a settled payment is never charged twice'
        };
        next(error);
      }
    });
  }

  // Paid routes accept POST only: a GET/PUT/... probe gets a JSON 405, not Express's HTML 404.
  app.use((req, res) => {
    res.set('Allow', 'POST').status(405).json({
      ok: false,
      code: 'method_not_allowed',
      error: 'Paid x402 endpoints accept POST; send the request (and any PAYMENT-SIGNATURE) with POST'
    });
  });

  // 4) JSON errors, never internals.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const mapped = describeGatewayError(error, options.describeError);
    if (mapped.status >= 500) logger.error('[agentbl] x402 live gateway error:', { code: /^[A-Za-z0-9_]{1,80}$/u.test(error?.code ?? '') ? error.code : 'delivery_failed' });
    if (res.headersSent) { res.end(); return; }
    res.status(mapped.status).json({
      ok: false,
      error: mapped.message,
      code: mapped.code,
      ...(mapped.details !== undefined ? { details: mapped.details } : {}),
      ...(error.payment ? { payment: error.payment } : {})
    });
  });

  return {
    app,
    config,
    runtime,
    /** Hand a raw http request/response pair to the gateway; resolves when the response is done. */
    handle(request, response) {
      return new Promise((resolve) => {
        response.once('close', resolve);
        app(request, response);
      });
    }
  };
}
