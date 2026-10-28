import { HttpError } from '../app/http.js';
import { CONTROL_VERSION, TERMS_TYPES, hashOfferingTerms } from './typedData.js';
import { id } from 'ethers';
import { RpcReadPool } from './reads.js';
import { verifyDisclosure } from './disclosure.js';

const SIGNING_ROLES = ['issuer', 'operator', 'valuer', 'compliance', 'disposer', 'reviewer'];

/**
 * One canonical block binds the human document, EIP-712 terms and current quote. Two questions are answered separately:
 * whether this readable pack is the one the pool committed to (history: always required, a forged or altered pack fails),
 * and whether new operations on it are allowed now (current: holder, roles, governance, valuer and the live offering still
 * match the signed terms). A revoked role or a later transfer never hides terms that were valid when they were signed;
 * callers about to accept or subscribe keep `requireCurrent`, and a read-only view gets the reasons in `current`.
 */
export async function financingReview(chain, disclosures, poolId, { requireCurrent = true } = {}) {
  const { read } = (chain.readPool ?? new RpcReadPool()).budget(100);
  const view = (contract, method, ...args) => read(() => contract[method](...args));
  const block = await read(() => chain.provider.getBlock('latest')), at = { blockTag: block.number };
  const [terms, hash, version, offer, controller, pool] = await Promise.all([
    view(chain.controller, 'terms', poolId, at), view(chain.controller, 'termsHash', poolId, at), view(chain.pool, 'quoteVersion', poolId, at),
    view(chain.pool, 'offerings', poolId, at), chain.controller.getAddress(), chain.pool.getAddress() ]);
  const pack = await disclosures.financingDisclosure(terms.disclosureHash);
  if (!verifyDisclosure(pack)) throw new HttpError(409, 'financing_disclosure_unverified', 'Readable terms failed independent hash verification');
  const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const parties = pack.document.parties, controlVersion = pack.document.instance.control_version ?? 2;
  const committed = Number(pack.document.instance.chain_id) === Number(chain.chainId)
    && equal(pack.document.instance.controller, controller) && equal(pack.document.instance.pool, pool)
    && equal(pack.terms_hash, hash) && equal(hashOfferingTerms(chain.chainId, controller, pack.terms, controlVersion), hash)
    && TERMS_TYPES.OfferingTerms.every(({ name }) => equal(terms[name], pack.terms[name]));
  if (!committed) throw new HttpError(409, 'financing_terms_changed', 'Chain terms or quote differ from the readable disclosure; review newly approved terms');
  const bindings = await Promise.all([view(chain.registry, 'holderOf', terms.eblId, at), view(chain.controller, 'governance', at), view(chain.controller, 'valuer', poolId, at),
    ...SIGNING_ROLES.map((role) => view(chain.controller, 'roles', id(role.toUpperCase()), parties[role], at))]);
  const reasons = [
    ...controlVersion < CONTROL_VERSION ? ['legacy_exit_only'] : [],
    ...equal(offer.issuePrice, terms.issuePrice) && equal(offer.targetRedemptionValue, terms.target)
      && equal(offer.tokenSupply, terms.supply) && equal(offer.settlementAsset, terms.settlementAsset) ? [] : ['offering_changed'],
    ...equal(bindings[0], parties.holder) ? [] : ['holder_changed'],
    ...equal(bindings[1], parties.governance) ? [] : ['governance_changed'],
    ...equal(bindings[2], parties.valuer) ? [] : ['valuer_changed'],
    ...SIGNING_ROLES.filter((_, index) => !bindings[3 + index]).map((role) => `${role}_revoked`)
  ];
  if ((await read(() => chain.provider.getBlock(block.number)))?.hash !== block.hash) throw new HttpError(503, 'chain_reconciliation_required', 'Review snapshot reorganized');
  if (requireCurrent && reasons.length) throw new HttpError(409, 'financing_terms_changed', 'Chain terms or quote differ from the readable disclosure; review newly approved terms', { reasons });
  return { ...pack, pool_id: Number(poolId), quote_version: String(version), block_number: block.number, block_hash: block.hash,
    verification: 'canonical_chain_and_public_document', current: { ok: !reasons.length, reasons }, business_enabled: false };
}
