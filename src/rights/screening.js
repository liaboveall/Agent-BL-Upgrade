import { dataSlice, getAddress, id } from 'ethers';

const COMPLIANCE = id('COMPLIANCE');
const ZERO = /^0x0{40}$/iu;
// RightsController keeps the wallet that last refreshed the instance-wide screening private (_screeningAttestor), and
// isEligible() and disburse() also require that this wallet still holds COMPLIANCE. Its storage slot in each control
// version's verified runtime (tests/w3CrossLayer.test.js checks it against a deployment). A version without an entry
// reads as unknown, never as valid.
export const SCREENING_ATTESTOR_SLOT = Object.freeze({ 4: 16 });

/**
 * The instance-wide source screening at one block: its expiry, the wallet that signed it and whether that wallet still
 * holds COMPLIANCE. Each value that cannot be read is null. `read` is a bounded read wrapper (reads.js budget).
 */
export async function readScreening(chain, controlVersion, read = (fn) => fn(), at = {}) {
  const has = (method) => typeof chain.controller?.[method] === 'function';
  const validUntil = has('screeningValidUntil') ? await read(() => chain.controller.screeningValidUntil(at)).catch(() => null) : null;
  let attestor = null, active = null;
  const slot = SCREENING_ATTESTOR_SLOT[Number(controlVersion)];
  if (slot != null && typeof chain.provider?.getStorage === 'function' && has('roles') && has('getAddress')) {
    try {
      const controller = await chain.controller.getAddress();
      attestor = getAddress(dataSlice(await read(() => chain.provider.getStorage(controller, slot, at.blockTag ?? 'latest')), 12));
      // Nobody has refreshed the screening yet: there is no source, and the expiry (zero) already says so.
      active = ZERO.test(attestor) ? false : Boolean(await read(() => chain.controller.roles(COMPLIANCE, attestor, at)));
    } catch { attestor = null; active = null; }
  }
  return { valid_until: validUntil == null ? null : String(validUntil), attestor, attestor_active: active };
}
