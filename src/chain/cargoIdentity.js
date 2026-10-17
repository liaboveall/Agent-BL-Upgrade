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

// v1 remains available only for reading deployed commitments. New registrations use the
// issuer + immutable title reference. Internal case IDs, spelling of cargo and revisions cannot
// create a second economic asset. Document versions belong in metadata, not the uniqueness key.
export function normalizeTitleReference(value) {
  return String(value ?? '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
}
export function cargoIdentityPayloadV2(caseData) {
  const bill = caseData?.bill_of_lading ?? {};
  const issuer = normalizeTitleReference(bill.issuer_id ?? bill.carrier);
  const title = normalizeTitleReference(bill.original_bl_id ?? bill.ebl_title_ref ?? bill.bl_id);
  if (!issuer || !title) throw new TypeError('A stable issuing carrier and original bill identity are required');
  return { version: 'title-v2', issuer, title };
}
export function cargoIdentityHashV2(caseData) {
  return `0x${createHash('sha256').update(JSON.stringify(cargoIdentityPayloadV2(caseData))).digest('hex')}`;
}
export function sameTitle(a, b) {
  const left = a?.bill_of_lading ?? {}, right = b?.bill_of_lading ?? {};
  const refs = (bill) => [bill.original_bl_id, bill.ebl_title_ref, bill.bl_id].filter(Boolean).map(normalizeTitleReference);
  // Equal title references are conservatively held even if a carrier label changed. An operator
  // must resolve the issuer alias, rather than treating the spelling change as unpledged cargo.
  return refs(left).some((value) => refs(right).includes(value));
}
