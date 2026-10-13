import { createHash } from 'node:crypto';

/** Deployed Wave B v1 identity. Preserve the property order and legacy voyage lookup exactly.
 * `voyage_no` is deliberately not read: the copper eBL #2 was committed with an empty voyage.
 * Changing that fallback requires an explicit versioned migration, never an implicit new cargo.
 */
export function cargoIdentityPayload(caseData) {
  const bill = caseData.bill_of_lading;
  return {
    carrier: bill.carrier ?? null,
    vessel: bill.vessel,
    voyage: bill.voyage ?? bill.voyage_number ?? '',
    cargo: bill.cargo,
    quantity_mt: bill.quantity_mt,
    case_id: caseData.case_id
  };
}

export function cargoIdentityHash(caseData) {
  return `0x${createHash('sha256').update(JSON.stringify(cargoIdentityPayload(caseData))).digest('hex')}`;
}
