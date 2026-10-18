import { createHash } from 'node:crypto';

// Stable title identity used by research ingestion and duplicate checks.
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
