// Independent review probes: an in-process Hardhat EVM only; no external RPC or keys.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deployRights, send, uniqueHash, STATE } from '../../../hardhat/test/helpers/rights.js';

const results = [];
const funded = async () => {
  const c = await deployRights();
  const p = await c.create();
  await c.eligible(p);
  await send(c.pool.connect(c.investor).subscribe(p.poolId, 10n));
  return { c, p };
};
const repay = async (c, p, signer, value) => {
  await send(c.usdc.mint(signer.address, value));
  await send(c.usdc.connect(signer).approve(await c.pool.getAddress(), value));
  await send(c.pool.connect(signer).repay(p.poolId, value));
};
const rejected = async (action) => {
  try { await action(); } catch (error) { return error.shortMessage ?? error.message; }
  throw new Error('Expected a rejected operation');
};

{
  const { c, p } = await funded();
  await c.advance(p.terms.maturity + 1n);
  const before = await c.usdc.balanceOf(c.holder.address);
  await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash('late-disburse')));
  assert.equal((await c.usdc.balanceOf(c.holder.address)) - before, 8_000_000n);
  assert.equal(await c.pool.stateOf(p.poolId), STATE.Funded);
  results.push({ id: 'A01', observation: 'Authorized operator disburses all escrow after maturity and valuation expiry; pool remains Funded', maturity: String(p.terms.maturity), valuation_expiry: String(p.valuation.validUntil), executed_at: String(await c.now()), disbursed_atomic: '8000000' });
}
{
  const { c, p } = await funded();
  await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash('disburse')));
  await c.advance(p.terms.maturity + 1n);
  await c.lifecycle(c.operator, 'markDefault', [p.poolId]);
  await repay(c, p, c.holder, 4_000_000n);
  await c.lifecycle(c.attestor, 'recordImporterPayment', [p.poolId, uniqueHash('payment'), 4_000_000n]);
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    const recovery = await c.pool.recoveredAtomic(p.poolId);
    await send(c.controller.connect(c.disposer).notifyResolution(p.poolId, uniqueHash('resolution'), uniqueHash('distribution'), recovery));
    await send(c.controller.connect(c.reviewer).reviewResolution(p.poolId, uniqueHash('review')));
    await c.advance((await c.controller.resolutions(p.poolId)).noticeUntil + 1n);
    await repay(c, p, c.outsider, 1n);
    const error = await rejected(() => send(c.controller.connect(c.operator).finalizeResolution(p.poolId)));
    assert.match(error, /recovery changed/);
    attempts.push({ donation_atomic: '1', error });
  }
  results.push({ id: 'A02', observation: 'An unprivileged payer invalidates two successive completed resolution notice periods with one atomic unit each', attempts, state: String(await c.pool.stateOf(p.poolId)) });
  const sameEvidence = uniqueHash('same-dispute');
  await send(c.controller.connect(c.investor).disputeResolution(p.poolId, sameEvidence));
  await c.govern(c.controller, 'resolveDispute', [p.poolId, uniqueHash('arbitration')]);
  await send(c.controller.connect(c.investor).disputeResolution(p.poolId, sameEvidence));
  assert.equal((await c.controller.resolutions(p.poolId)).disputed, true);
  results.push({ id: 'A03', observation: 'The same investor reopens a governance-resolved dispute with the identical evidence hash', repeated_evidence: sameEvidence, disputed: true });
}
{
  const { c, p } = await funded();
  await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash('disburse')));
  await repay(c, p, c.holder, 10_000_000n);
  await c.lifecycle(c.attestor, 'recordImporterPayment', [p.poolId, uniqueHash('payment'), 10_000_000n]);
  await c.lifecycle(c.attestor, 'recordCargoArrival', [p.poolId, uniqueHash('arrival')]);
  await c.lifecycle(c.operator, 'settle', [p.poolId, 10_000_000n]);
  await send(c.pool.connect(c.investor).claim(p.poolId));
  const fee = await c.queue(c.controller, 'deductFee', [p.poolId, 100_000n, uniqueHash('fee')]);
  await c.advance(fee.eta);
  const error = await rejected(() => send(c.governance.execute(fee.id, fee.data)));
  assert.match(error, /ClaimsStarted/);
  results.push({ id: 'A04', observation: 'An investor claims before the separately governed fee deduction; fee within the signed cap is then unavailable', error, claimed_atomic: String(await c.pool.totalClaimed(p.poolId)), fee_cap_atomic: String(p.terms.maxFee) });
}
const output = { schema: 'agentbl-current-review-probes-v1', source_revision: 'b8db411de044b1132f14419a432be6da6ff1501b', environment: 'local in-process Hardhat EVM', external_broadcasts: 0, observations: results };
await fs.writeFile(new URL('./contract-probes.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
