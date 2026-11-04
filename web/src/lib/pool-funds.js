// Where a funding pool's money is, computed from one directory row (src/rights/offerings.js) with the contract's own
// formulas (RWAOfferingPoolV5.targetDistribution and outstandingDebt under cumulative claims). Atomic integers only.
const ceilDiv = (a, b) => (a + b - 1n) / b;
/**
 * Where a pool's money is, from one snapshot row: principal raised (P), drawn (L), still escrowed undrawn, recovered,
 * claimed (escrow accounting: raised − drawn + recovered − escrow) and the contract's target total distribution
 * P + ⌈(G − P) × L / P⌉ with G = shares × target per share, so an undrawn part earns nothing on top of its principal.
 * The remaining debt is that target less recovered cash and undrawn principal. Contract rules, not a forecast.
 */
export function fundsBreakdown(offer) {
  const raised = BigInt(offer.raised_atomic ?? 0), drawn = BigInt(offer.disbursed_atomic ?? 0), recovered = BigInt(offer.recovered_atomic ?? 0);
  if (raised === 0n || offer.state === 'Cancelled') return null;
  const gross = BigInt(offer.subscribed ?? 0) * BigInt(offer.redemption_per_share_atomic ?? 0);
  const target = gross > raised ? raised + ceilDiv((gross - raised) * drawn, raised) : gross;
  const covered = recovered + raised - drawn, escrow = offer.escrow_atomic == null ? null : BigInt(offer.escrow_atomic);
  const claimed = escrow == null ? null : covered - escrow;
  return { raised, drawn, undrawn: raised - drawn, recovered, escrow, claimed: claimed != null && claimed >= 0n ? claimed : null, target, outstanding: target > covered ? target - covered : 0n };
}
