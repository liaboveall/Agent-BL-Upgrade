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
  'function offerings(uint256) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes32,address,uint256,uint256,uint8,bool)',
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
  'event LiquidationRecoveryRecorded(uint256 indexed poolId,bytes32 paymentProof,uint256 amount,uint256 totalRecovered)',
  'event AdditionalPaymentRecorded(uint256 indexed poolId,bytes32 paymentProof,uint256 amount,uint256 totalRecovered)'
]);

const RWATokenV5 = Object.freeze([
  'function burn(uint256,address,uint256)',
  'event RWABurned(uint256 indexed poolId,address indexed investor,uint256 amount)'
]);

export const PROTOCOL_V5_ABI = Object.freeze({
  RWAOfferingPoolV5,
  // Backwards-compatible alias used by Task 5 rebuilder/tests before the V5 naming was finalised.
  RWAOfferingPool: RWAOfferingPoolV5,
  RWATokenV5
});

/** Return the configured ABI plus any missing v5 fragments; unknown contracts are unchanged. */
export function protocolAbi(name, abi = []) {
  const additions = PROTOCOL_V5_ABI[name];
  if (!additions) return abi;
  const key = (fragment) => (fragment.type === 'constructor' ? 'constructor' : `${fragment.type}:${fragment.format('sighash')}`);
  const known = new Set(new Interface(abi).fragments.map(key));
  return [...abi, ...additions.filter((entry) => !known.has(key(new Interface([entry]).fragments[0])))];
}
