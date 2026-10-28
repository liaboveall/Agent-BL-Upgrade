// Material lifecycle. A record is active (readable and writable) until its retention date, then archived: still readable
// by the same organization's roles but closed to new evidence, reviews, terms or wallet operations. After the archive
// window it leaves the vault, which is re-encrypted whole on every write and must not grow without bound.
//
// The retention date is never a fixed age the financing can outlive. It starts at creation plus the declared tenor plus
// MATERIAL_RETENTION_MS, every financing disclosure saved for the material moves it to that pool's maturity plus
// FINANCING_RECORD_RETENTION_MS (notice periods, default resolution and its disputes, late recoveries), and while a
// wallet operation on the material awaits reconciliation the record stays active whatever its date.
const DAY = 86_400_000;
export const MATERIAL_RETENTION_MS = 90 * DAY;
export const FINANCING_RECORD_RETENTION_MS = 180 * DAY;
export const MATERIAL_ARCHIVE_MS = 30 * DAY;
const SETTLED_PLAN = ['draft', 'confirmed', 'reverted'];

/** Retention date of a new record: the base period after the declared tenor. */
export function initialRetention(now, summary) { return now + MATERIAL_RETENTION_MS + summary.tenor_days * DAY; }

/** The record's retention date, extended by every financing disclosure saved for it (stored records included). */
export function materialRetention(state, materialId, record = state.materials?.[materialId]) {
  let until = Number(record?.retention_until) || 0;
  for (const entry of Object.values(state.financing_disclosures ?? {})) {
    const maturity = Number(entry?.pack?.terms?.maturity);
    if (entry?.material_id === materialId && Number.isFinite(maturity)) until = Math.max(until, maturity * 1000 + FINANCING_RECORD_RETENTION_MS);
  }
  return until;
}

/** An unreconciled wallet operation keeps the material active past its date. */
export function materialHeld(state, materialId) {
  return Object.values(state.plans ?? {}).some((plan) => plan?.material_id === materialId && !SETTLED_PLAN.includes(plan.status));
}

/** 'active', 'archived' (read-only) or 'expired' (due to leave the vault). */
export function materialPhase(state, materialId, now, record = state.materials?.[materialId]) {
  const until = materialRetention(state, materialId, record);
  if (now < until || materialHeld(state, materialId)) return 'active';
  return now < until + MATERIAL_ARCHIVE_MS ? 'archived' : 'expired';
}
