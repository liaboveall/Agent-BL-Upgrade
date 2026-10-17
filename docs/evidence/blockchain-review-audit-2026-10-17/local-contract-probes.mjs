// Investigative counterexamples, executed only against Hardhat's in-process EVM.
// Run from hardhat/: node ../docs/evidence/blockchain-review-audit-2026-10-17/local-contract-probes.mjs
import assert from 'node:assert/strict';
import { deployProtocol, newOffering, send, applyPricing, uniqueHash, ACTION, TARGET, ethers } from '../../../hardhat/test/helpers/protocol.js';

const observations = [];
async function probe(name, fn) {
  const result = await fn();
  observations.push({ name, confirmed: true, ...result });
}
async function rejects(fn, reason) {
  await assert.rejects(fn, (error) => {
    let detail = String(error.message);
    if (typeof error.data === 'string' && error.data.startsWith('0x08c379a0')) {
      detail += ethers.AbiCoder.defaultAbiCoder().decode(['string'], `0x${error.data.slice(10)}`)[0];
    }
    return detail.includes(reason);
  });
}
async function advance(seconds) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

await probe('permissionless-subscription-without-payment', async () => {
  const ctx = await deployProtocol();
  const { poolId } = await newOffering(ctx, 'audit-free', { supply: 100n });
  const tx = await ctx.pool.connect(ctx.outsider).subscribe(poolId, 100n);
  const receipt = await tx.wait();
  assert.equal(tx.value, 0n);
  assert.equal(await ctx.token.balanceOf(poolId, ctx.outsider.address), 100n);
  assert.equal(await ctx.pool.stateOf(poolId), 4n);
  const event = receipt.logs.map((log) => { try { return ctx.pool.interface.parseLog(log); } catch { return null; } })
    .find((log) => log?.name === 'Subscribed');
  assert.equal(event.args.paidAmount, 80_000_000n);
  return { shares: '100', tx_value: '0', reported_paid_amount: String(event.args.paidAmount), state: 'Funded', note: 'Native gas is still paid; no subscription asset is transferred.' };
});

await probe('liquidation-has-no-existing-exit', async () => {
  const ctx = await deployProtocol();
  const { poolId, eblId } = await newOffering(ctx, 'audit-liquidation');
  await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 100n));
  await send(applyPricing(ctx, poolId, 800_000n, ACTION.TRIGGER_LIQUIDATION));
  const attempts = [
    ['cancel', () => ctx.pool.cancelOffering.staticCall(poolId, uniqueHash()), 'has subscribers'],
    ['default', () => ctx.pool.markDefault.staticCall(poolId), 'illegal transition'],
    ['loss', () => ctx.pool.settleLoss.staticCall(poolId, uniqueHash()), 'not defaulted'],
    ['payment', () => ctx.pool.recordImporterPayment.staticCall(poolId, uniqueHash(), TARGET), 'bad settlement state'],
    ['arrival', () => ctx.pool.recordCargoArrival.staticCall(poolId, uniqueHash()), 'bad settlement state'],
    ['settle', () => ctx.pool.settle.staticCall(poolId, 100n * TARGET), 'bad settlement state'],
    ['pause', () => ctx.pool.pauseOffering.staticCall(poolId, uniqueHash()), 'illegal transition'],
    ['resume', () => ctx.pool.resumeOffering.staticCall(poolId, uniqueHash()), 'not paused'],
    ['freeze', () => ctx.oracle.updatePricing.staticCall(poolId, 800_000n, 1, ACTION.FREEZE_POOL, uniqueHash(), uniqueHash()), 'illegal transition'],
    ['reprice', () => ctx.oracle.updatePricing.staticCall(poolId, 700_000n, 1, ACTION.REPRICE_DOWN, uniqueHash(), uniqueHash()), 'illegal transition'],
    ['owner-release', () => ctx.registry.releasePledge.staticCall(eblId), 'not authorized'],
    ['holder-transfer', () => ctx.registry.transfer.staticCall(eblId, ctx.other.address), 'ebl pledged']
  ];
  for (const [, fn, reason] of attempts) await rejects(fn, reason);
  assert.equal(await ctx.pool.stateOf(poolId), 11n);
  assert.equal(await ctx.registry.pledgedTo(eblId), await ctx.pool.getAddress());
  return { rejected_exits: attempts.map(([name]) => name), state: 'Liquidation', collateral_locked: true };
});

await probe('frozen-empty-offering-cannot-close', async () => {
  const ctx = await deployProtocol();
  const { poolId } = await newOffering(ctx, 'audit-frozen-empty');
  await send(applyPricing(ctx, poolId, 800_000n, ACTION.FREEZE_POOL));
  await rejects(() => ctx.pool.cancelOffering.staticCall(poolId, uniqueHash()), 'illegal transition');
  await rejects(() => ctx.pool.markDefault.staticCall(poolId), 'not overdue');
  await rejects(() => ctx.pool.settle.staticCall(poolId, TARGET), 'bad settlement state');
  return { state: 'Frozen', subscribers: '0', cancellation_rejected: true, only_liquidation_action_remains: true };
});

await probe('frozen-fully-recovered-offering-also-cannot-close', async () => {
  const ctx = await deployProtocol();
  const { poolId } = await newOffering(ctx, 'audit-frozen-paid');
  await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 100n));
  await send(ctx.pool.recordImporterPayment(poolId, uniqueHash(), 100n * TARGET));
  await send(ctx.pool.recordCargoArrival(poolId, uniqueHash()));
  await send(applyPricing(ctx, poolId, 800_000n, ACTION.FREEZE_POOL));
  await advance(61 * 86400);
  assert.equal(await ctx.pool.outstandingDebt(poolId), 0n);
  await rejects(() => ctx.pool.settle.staticCall(poolId, 100n * TARGET), 'bad settlement state');
  await rejects(() => ctx.pool.markDefault.staticCall(poolId), 'not overdue');
  await rejects(() => ctx.pool.resumeOffering.staticCall(poolId, uniqueHash()), 'not paused');
  return { state: 'Frozen', outstanding_debt: '0', past_maturity: true, settle_and_default_rejected: true };
});

await probe('subscription-after-maturity-is-accepted', async () => {
  const ctx = await deployProtocol();
  const { poolId } = await newOffering(ctx, 'audit-matured');
  await advance(61 * 86400);
  await send(ctx.pool.connect(ctx.outsider).subscribe(poolId, 1n));
  assert.equal((await ctx.pool.offerings(poolId)).subscribed, 1n);
  return { past_maturity: true, subscribed: '1' };
});

await probe('contract-accepts-late-payment-and-arrival-after-default', async () => {
  const ctx = await deployProtocol();
  const { poolId } = await newOffering(ctx, 'audit-default-recovery');
  await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 100n));
  await advance(61 * 86400);
  await send(ctx.pool.markDefault(poolId));
  assert.equal(await ctx.pool.stateOf(poolId), 13n);
  await send(ctx.pool.recordImporterPayment(poolId, uniqueHash(), 40n * TARGET));
  await send(ctx.pool.recordAdditionalPayment(poolId, uniqueHash(), 60n * TARGET));
  await send(ctx.pool.recordCargoArrival(poolId, uniqueHash()));
  await send(ctx.pool.settle(poolId, 100n * TARGET));
  assert.equal(await ctx.pool.stateOf(poolId), 9n);
  return { before: 'Defaulted', direct_record_payment: 'accepted', direct_record_arrival: 'accepted', after: 'Repaid' };
});

await probe('unused-old-oracle-message-can-follow-a-newer-message', async () => {
  const ctx = await deployProtocol();
  const { poolId } = await newOffering(ctx, 'audit-oracle-order');
  const oldArgs = [poolId, 900_000n, 1, ACTION.OPEN_OFFERING, uniqueHash('old-evidence'), uniqueHash('old-quote')];
  await send(applyPricing(ctx, poolId, 700_000n, ACTION.REPRICE_DOWN));
  await send(ctx.oracle.updatePricing(...oldArgs));
  assert.equal(await ctx.pool.issuePriceOf(poolId), 900_000n);
  await rejects(() => ctx.oracle.updatePricing.staticCall(...oldArgs), 'decision replay');
  return { newer_price: '700000', subsequent_old_message_price: '900000', identical_duplicate_rejected: true, note: 'Requires an authorized updater; tuple deduplication does not enforce quote freshness or ordering.' };
});

await probe('default-maturity-is-always-sixty-days', async () => {
  const ctx = await deployProtocol();
  const { poolId } = await newOffering(ctx, 'audit-maturity');
  const block = await ethers.provider.getBlock('latest');
  const seconds = await ctx.pool.maturityAt(poolId) - BigInt(block.timestamp);
  assert.equal(seconds, 60n * 86400n);
  return { seconds_after_creation: String(seconds), days: 60 };
});

console.log(JSON.stringify({ schema: 'agentbl-review-local-contract-probes-v1', evidence: 'local Hardhat EVM only', observations }, null, 2));
