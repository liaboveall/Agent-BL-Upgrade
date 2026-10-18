import { Interface } from 'ethers';

// v5 capital-layer ABI additions. These are merged with the deployed configuration so the
// application can parse v5 chain events (Subscribed, FundEscrowed, DisbursedToExporter,
// InvestorRefunded, Claimed, FeeDeducted, LiquidationRecoveryRecorded, AdditionalPaymentRecorded,
// PoolFundingTermsSet) and plan v5 transactions without requiring a live deployment.
const RWAOfferingPoolV5 = Object.freeze([
  // v5 offering creation with funding terms (settlement asset + min/max raise).
  'function createOfferingWithTerms(uint256,uint256,uint256,uint256,uint256,uint256,address,uint256) returns (uint256)',
  // v5 capital-layer functions.
  'function subscribe(uint256,uint256)',
  'function subscribeWithTerms(uint256,uint256,uint256,uint256,uint256)',
  'function refundInvestor(uint256,address)',
  'function refundAllOnFailure(uint256)',
  'function refundAllOnFailure(uint256,uint256,uint256)',
  'function disburseToExporter(uint256,uint256,address,bytes32)',
  'function repay(uint256,uint256)',
  'function claim(uint256)',
  'function deductFee(uint256,uint256,address,bytes32)',
  'function recordAdditionalPayment(uint256,bytes32,uint256)',
  'function recordLiquidationRecovery(uint256,bytes32,uint256)',
  'function resolveLiquidation(uint256,bytes32)',
  'function offerings(uint256) view returns (uint256 eblId,uint256 tokenSupply,uint256 issuePrice,uint256 targetRedemptionValue,uint256 subscribed,uint256 repaymentAmount,bytes32 paymentProof,bytes32 arrivalProof,address settlementAsset,uint256 minRaise,uint256 raisedAtomic,uint8 state,bool exists)',
  'function protocolVersion() view returns (uint256)',
    'function nextPoolId() view returns (uint256)',
  'function quoteVersion(uint256) view returns (uint256)',
  'function subscriptionDeadline(uint256) view returns (uint256)',
  'function maturityAt(uint256) view returns (uint256)',
  'function disbursementDeadline(uint256) view returns (uint256)',
  'function targetDistribution(uint256) view returns (uint256)',
  'function closeUndisbursed(uint256)',
  'function emergencyStopped() view returns (bool)',
  'function isInvestorEligible(address,uint256) view returns (bool)',
  'function claimable(uint256,address) view returns (uint256)',
  'function finalizeFunding(uint256)',
  'function recoveredAtomic(uint256) view returns (uint256)',
  'function fundingFinalized(uint256) view returns (bool)',
  // v5 capital-layer view functions.
  'function escrowed(uint256,address) view returns (uint256)',
  'function investorPaid(uint256,address,address) view returns (uint256)',
  'function investorClaimed(uint256,address,address) view returns (uint256)',
  'function totalClaimed(uint256) view returns (uint256)',
  'function feesDeducted(uint256) view returns (uint256)',
  'function disbursedAtomic(uint256) view returns (uint256)',
  // v5 capital-layer events.
  'event PoolFundingTermsSet(uint256 indexed poolId,address settlementAsset,uint256 minRaise,uint256 maxRaise)',
  'event Subscribed(uint256 indexed poolId,address indexed investor,uint256 amount,uint256 paidAmount)',
  'event FundEscrowed(uint256 indexed poolId,address indexed asset,address indexed investor,uint256 amountAtomic,uint256 shares)',
  'event DisbursedToExporter(uint256 indexed poolId,address indexed asset,uint256 amountAtomic,bytes32 evidenceHash)',
  'event InvestorRefunded(uint256 indexed poolId,address indexed investor,address indexed asset,uint256 amountAtomic)',
  'event Claimed(uint256 indexed poolId,address indexed investor,address indexed asset,uint256 amountAtomic,uint256 sharesBurned)',
  'event FeeDeducted(uint256 indexed poolId,address indexed asset,uint256 feeAtomic,bytes32 feeEvidenceHash)',
  'event RepaymentReceived(uint256 indexed poolId,address indexed asset,address indexed payer,uint256 amountAtomic)',
  'event FundingFinalized(uint256 indexed poolId,uint256 raisedAtomic)',
  'event LiquidationRecoveryRecorded(uint256 indexed poolId,bytes32 paymentProof,uint256 amount,uint256 totalRecovered)',
  'event AdditionalPaymentRecorded(uint256 indexed poolId,bytes32 paymentProof,uint256 amount,uint256 totalRecovered)'
]);

const ControlledRWAToken = Object.freeze([
  'function balanceOf(uint256,address) view returns (uint256)',
  'function totalSupply(uint256) view returns (uint256)',
  'function burn(uint256,address,uint256)',
  'event RWABurned(uint256 indexed poolId,address indexed investor,uint256 amount)'
]);

export const PROTOCOL_V5_ABI = Object.freeze({
  RWAOfferingPoolV5,
  // Shared ledger interfaces resolve these names to the controlled instance only.
  RWAOfferingPool: RWAOfferingPoolV5,
  ControlledRWAToken,
  RWAToken: ControlledRWAToken
});

/** Return the configured ABI plus any missing v5 fragments; unknown contracts are unchanged. */
export function protocolAbi(name, abi = []) {
  const additions = PROTOCOL_V5_ABI[name];
  if (!additions) return abi;
  const key = (fragment) => (fragment.type === 'constructor' ? 'constructor' : `${fragment.type}:${fragment.format('sighash')}`);
  const replaced = new Set(new Interface(additions).fragments.map(key));
  return [...new Interface(abi).fragments.filter((fragment) => !replaced.has(key(fragment))), ...additions];
}
