import { Interface } from 'ethers';
import { protocolAbi as protocolV5Abi } from './protocolV5Abi.js';

// Source-level v4 ABI additions. They are merged with the deployed configuration so the
// application can plan and verify v4 transactions without pretending that a v3 deployment
// already exposes them. A v4 deployment should regenerate chain-config.json from the artifact.
export const PROTOCOL_V4_ABI = Object.freeze({
  RWAOfferingPool: Object.freeze([
    'function createOfferingWithTerms(uint256,uint256,uint256,uint256,uint256,uint256) returns (uint256)',
    'function subscribeWithTerms(uint256,uint256,uint256,uint256,uint256)',
    'function setSubscriptionDeadline(uint256,uint256)',
    'function unfreezeOffering(uint256,bytes32)',
    'function recordLiquidationRecovery(uint256,bytes32,uint256)',
    'function resolveLiquidation(uint256,bytes32)',
    'function maturityAt(uint256) view returns (uint256)',
    'function subscriptionDeadline(uint256) view returns (uint256)',
    'function realizedLoss(uint256) view returns (uint256)',
    'function quoteVersion(uint256) view returns (uint256)',
    'event OfferingTermsSet(uint256 indexed poolId,uint256 maturityAt,uint256 subscriptionDeadline)',
    'event SubscriptionDeadlineSet(uint256 indexed poolId,uint256 subscriptionDeadline)',
    'event OfferingFrozen(uint256 indexed poolId,bytes32 evidenceHash)',
    'event OfferingUnfrozen(uint256 indexed poolId,uint8 restoredState,bytes32 evidenceHash)',
    'event LiquidationRecoveryRecorded(uint256 indexed poolId,bytes32 paymentProof,uint256 amount,uint256 totalRecovered)',
    'event LiquidationResolved(uint256 indexed poolId,uint8 outcome,uint256 recoveredAmount,uint256 lossAmount,bytes32 resolutionHash)',
    // v3 lifecycle events absent from the legacy v2 ABI retained in chain-config.json.
    'event OfferingDefaulted(uint256 indexed poolId,uint256 outstandingAmount)',
    'event LossSettlementRecorded(uint256 indexed poolId,uint256 recoveredAmount,uint256 lossAmount,bytes32 resolutionHash)',
    'event AdditionalPaymentRecorded(uint256 indexed poolId,bytes32 paymentProof,uint256 amount,uint256 totalRecovered)'
  ]),
  RiskPricingOracle: Object.freeze([
    'function updatePricing(uint256,uint256,uint8,uint8,bytes32,bytes32,uint256,uint256,uint256)',
    'function lastDecisionSeq(uint256) view returns (uint256)',
    'function latestQuoteVersion(uint256) view returns (uint256)',
    'function MAX_QUOTE_VALIDITY() view returns (uint256)',
    'event PricingDecision(uint256 indexed poolId,uint256 expectedQuoteVersion,uint256 resultingQuoteVersion,uint256 decisionSeq,uint256 validUntil)'
  ])
});

/** Return the configured ABI plus any missing v3/v4 fragments; unknown contracts are unchanged. */
export function protocolAbi(name, abi = [], version = 4) {
  const additions = PROTOCOL_V4_ABI[name];
  if (!additions) return Number(version) >= 5 ? protocolV5Abi(name, abi) : abi;
  const key = (fragment) => fragment.type === 'constructor' ? 'constructor' : `${fragment.type}:${fragment.format('sighash')}`;
  const known = new Set(new Interface(abi).fragments.map(key));
  const merged = [...abi, ...additions.filter((entry) => !known.has(key(new Interface([entry]).fragments[0])))];
  return Number(version) >= 5 ? protocolV5Abi(name, merged) : merged;
}
