// Delivery pipeline shared by both x402 transports (the Demo personal-sign route and
// the Live V2 gateway): paid report -> PaidReportEnvelope -> (Live) on-chain
// attestation -> cached, re-readable response body.
import { assertPaidReportEnvelope, createPaidReportEnvelope, hashReportSnapshot } from './paidReport.js';
import { getPaidReportCache } from './reportStore.js';
import { recordPaymentEvidence, usdcToAtomic } from './settlement.js';

/**
 * @param {object} input
 * @param {object} input.payment   transport-specific settlement info ({ txHash, explorerUrl?, evidence?, ... })
 * @param {boolean} input.live     true only for a facilitator-settled payment; triggers the on-chain attestation
 * @returns {Promise<{ reportEnvelope: object, deliveredBody: object, payment: object }>}
 */
export async function deliverPaidReport({
  serviceId,
  priceUSDC,
  payer,
  payTo,
  network,
  asset,
  paymentTx,
  settledAt,
  live,
  payment = {},
  report,
  preparedEnvelope = null,
  checkpoint = async () => {},
  ttlSeconds = Number(process.env.X402_REPORT_TTL_SECONDS ?? 300),
  attest = recordPaymentEvidence,
  cache = getPaidReportCache
}) {
  const reportEnvelope = preparedEnvelope ?? createPaidReportEnvelope({
    kind: report.kind,
    case_id: report.case_id,
    payer,
    payee: payTo,
    network,
    asset,
    amount: usdcToAtomic(priceUSDC).toString(),
    payment_tx: paymentTx,
    settled_at: settledAt,
    data_snapshot: report,
    model_provider: report.provider ?? 'deterministic-agentbl',
    evidence_hash: report.evidence_hash
      ?? report.pricing_result?.evidence_hash
      ?? payment.evidence?.responseHash
      ?? hashReportSnapshot(report),
    ...(report.selected_pool_id ? { selected_pool_id: report.selected_pool_id } : {}),
    ...(report.risk_passport_hash ? { risk_passport_hash: report.risk_passport_hash } : {}),
    ...(report.reveal_proof_hash ? { reveal_proof_hash: report.reveal_proof_hash } : {})
  }, { ttlSeconds });
  assertPaidReportEnvelope(reportEnvelope);
  await checkpoint({ report, envelope: reportEnvelope });

  let settled = payment;
  if (live) {
    const attestation = await attest({
      serviceId,
      amountUSDC: priceUSDC,
      payer,
      reportEnvelope,
      paymentTxHash: payment.txHash,
      independentVerification: payment.independent_verification,
      asset,
      responseData: report
    });
    settled = { ...payment, ...attestation.payment };
  }

  const deliveredBody = {
    ...report,
    report_envelope: reportEnvelope,
    payment: {
      status: 'settled',
      payer,
      txHash: settled.txHash,
      explorerUrl: settled.explorerUrl || null,
      attestationTxHash: settled.attestationTxHash ?? null,
      attestationExplorerUrl: settled.attestationExplorerUrl ?? null,
      ...(settled.attestation ? { attestation: settled.attestation } : {}),
      live: settled.live === true,
      serviceId,
      amountUSDC: priceUSDC
    }
  };

  // Cache the delivered report so the buyer can re-read it (e.g. after a page
  // refresh) within its TTL without paying again. Best-effort: a cache failure must
  // never block delivering the report the buyer paid for.
  if (!live) {
    try { await cache().save({ envelope: reportEnvelope, report: deliveredBody }); }
    catch { /* Demo convenience cache; Live delivery is durably encrypted in its receipt store. */ }
  }
  return { reportEnvelope, deliveredBody, payment: settled };
}
