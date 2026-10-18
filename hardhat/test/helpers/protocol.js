// Shared fixtures for the protocol hardening tests.
import { network } from 'hardhat';

export const { ethers } = await network.create();

/** RWAOfferingPool.OfferingState enum indices. */
export const STATE = Object.freeze({
  Created: 0n,
  Priced: 1n,
  Open: 2n,
  Subscribed: 3n,
  Funded: 4n,
  InTransit: 5n,
  Repriced: 6n,
  Paused: 7n,
  Frozen: 8n,
  Repaid: 9n,
  Redeemed: 10n,
  Liquidation: 11n,
  Cancelled: 12n,
  Defaulted: 13n,
  LossSettled: 14n
});

/** Pricing action codes understood by RWAOfferingPool.applyPricingAction. */
export const ACTION = Object.freeze({
  OPEN_OFFERING: 0,
  OPEN_WITH_WARNING: 1,
  REPRICE_DOWN: 2,
  PAUSE_OFFERING: 3,
  FREEZE_POOL: 4,
  TRIGGER_LIQUIDATION: 5,
  RESUME_OFFERING: 6,
  SETTLE_OFFERING: 7,
  EMERGENCY_PAUSE: 8,
  CANCEL_OFFERING: 9
});

export const TARGET = 1_000_000n;
export const ISSUE_PRICE = 800_000n;

/** Wait for a transaction promise to be mined. */
export async function send(transaction) {
  return (await transaction).wait();
}

let hashCounter = 0;
/** A fresh, never-before-used bytes32 (every oracle decision must be unique). */
export function uniqueHash(label = 'h') {
  hashCounter += 1;
  return ethers.id(`${label}:${hashCounter}`);
}


export async function applyPricing(ctx, poolId, price, action) {
  return ctx.pool.applyPricingAction(poolId, price, action, uniqueHash('evidence'), uniqueHash('quote'));
}
