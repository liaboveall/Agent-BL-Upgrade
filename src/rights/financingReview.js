import { HttpError } from '../app/http.js';
import { TERMS_TYPES, hashOfferingTerms } from './typedData.js';
import { id } from 'ethers';
import { RpcReadPool } from './reads.js';
import { verifyDisclosure } from './disclosure.js';

/** One canonical block binds the human document, EIP-712 terms and current quote. */
export async function financingReview(chain, disclosures, poolId) {
  const { read } = (chain.readPool ?? new RpcReadPool()).budget(100);
  const view = (contract, method, ...args) => read(() => contract[method](...args));
  const block = await read(() => chain.provider.getBlock('latest')), at = { blockTag: block.number };
  const [terms, hash, version, offer, controller, pool] = await Promise.all([
    view(chain.controller, 'terms', poolId, at), view(chain.controller, 'termsHash', poolId, at), view(chain.pool, 'quoteVersion', poolId, at),
    view(chain.pool, 'offerings', poolId, at), chain.controller.getAddress(), chain.pool.getAddress() ]);
  const pack = await disclosures.financingDisclosure(terms.disclosureHash);
  if (!verifyDisclosure(pack)) throw new HttpError(409, 'financing_disclosure_unverified', 'Readable terms failed independent hash verification');
  const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const parties = pack.document.parties;
  const bindings = await Promise.all([view(chain.registry, 'holderOf', terms.eblId, at), view(chain.controller, 'governance', at), view(chain.controller, 'valuer', poolId, at),
    ...['issuer', 'operator', 'valuer', 'compliance', 'disposer', 'reviewer'].map((role) => view(chain.controller, 'roles', id(role.toUpperCase()), parties[role], at))]);
  const matches = Number(pack.document.instance.chain_id) === Number(chain.chainId)
    && equal(pack.document.instance.controller, controller) && equal(pack.document.instance.pool, pool)
    && equal(pack.terms_hash, hash) && equal(hashOfferingTerms(chain.chainId, controller, pack.terms), hash)
    && TERMS_TYPES.OfferingTerms.every(({ name }) => equal(terms[name], pack.terms[name]))
    && equal(offer.issuePrice, terms.issuePrice) && equal(offer.targetRedemptionValue, terms.target)
    && equal(offer.tokenSupply, terms.supply) && equal(offer.settlementAsset, terms.settlementAsset)
    && equal(bindings[0], parties.holder) && equal(bindings[1], parties.governance) && equal(bindings[2], parties.valuer)
    && bindings.slice(3).every(Boolean);
  if (!matches) throw new HttpError(409, 'financing_terms_changed', 'Chain terms or quote differ from the readable disclosure; review newly approved terms');
  if ((await read(() => chain.provider.getBlock(block.number)))?.hash !== block.hash) throw new HttpError(503, 'chain_reconciliation_required', 'Review snapshot reorganized');
  return { ...pack, pool_id: Number(poolId), quote_version: String(version), block_number: block.number, block_hash: block.hash,
    verification: 'canonical_chain_and_public_document', business_enabled: false };
}
