// The values RightsController reads before it accepts new money (isEligible()) or releases it (disburse()), named once so
// the funding-pool directory and the role workflow cannot disagree about why a pool cannot move. A subscription and a
// draw need the same instance- and pool-wide sources:
//   - the delayed-governance intake switch is off;
//   - the instance-wide screening window is open and the wallet that signed it still holds COMPLIANCE;
//   - the pool's valuation is still valid and the valuer who signed it still holds VALUER;
//   - the pledged title is still active in the registry;
//   - the settlement asset is still an allowed test asset.
// They differ in one second of arithmetic and nowhere else: isEligible() accepts a valuation through its last second
// (`validUntil >= now`) while disburse() needs it strictly in the future (`now < validUntil`).
// A wallet's own credentials (eligibility, accepted terms, the caller's role) are checked per wallet elsewhere.

/**
 * @param {object} values what the controller reads; `null` or `undefined` means the value could not be read
 * @param {{draw?: boolean}} options `draw` applies disburse()'s rule for the valuation instead of isEligible()'s
 * @returns {{blockers: string[], unknown: boolean}} every definite reason in the order the directory shows them, and whether
 *   any value was unreadable (a definite blocker still holds; with none, `unknown` means the answer is not "yes")
 */
export function controllerSourceBlockers(values, { draw = false } = {}) {
  const { now, intakeStopped, screeningValidUntil, screeningActive, valuationValidUntil, valuerActive, titleActive, assetAllowed } = values;
  const unread = (value) => value == null;
  const blockers = [];
  if (intakeStopped === true) blockers.push('intake_stopped');
  // One refresh by a current compliance wallet clears either; an expired window is the one reported when both apply.
  if (!unread(screeningValidUntil) && Number(screeningValidUntil) < now) blockers.push('screening_expired');
  else if (screeningActive === false) blockers.push('screening_source_inactive');
  if (!unread(valuationValidUntil) && (draw ? Number(valuationValidUntil) <= now : Number(valuationValidUntil) < now)) blockers.push('valuation_expired');
  if (valuerActive === false) blockers.push('valuer_inactive');
  if (titleActive === false) blockers.push('title_inactive');
  if (assetAllowed === false) blockers.push('asset_not_allowed');
  const unknown = [intakeStopped, screeningValidUntil, screeningActive, valuationValidUntil, valuerActive, titleActive, assetAllowed].some(unread);
  return { blockers, unknown };
}
