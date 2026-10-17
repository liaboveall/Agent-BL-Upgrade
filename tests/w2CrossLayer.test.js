import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { id } from 'ethers';
import { buildOwnerPlan } from '../src/agent/runtime/ownerTxPlan.js';
import { runHardhatNode, stopHardhatNode, deployW2 } from './helpers/ledgerTestHarness.js';
import { Ledger } from '../src/ledger/ledger.js';
import { CapitalLedgerService } from '../src/ledger/service.js';
import { createServer, setAgentService } from '../src/app/server.js';
import { storeState, resetStore } from '../src/app/store.js';
import { subscribeOffering, claimPosition } from '../web/src/lib/web3.js';

async function backend(ctx, t) {
  setAgentService({ capital: ctx.capital });
  resetStore();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); resetStore(); setAgentService(null); });
  const get = async (wallet) => {
    const response = await fetch(`${base}/api/positions?wallet=${wallet}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (url, data) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, code: result.code });
    return result.intent;
  };
  const walletOptions = (signer) => {
    const session = { kind: 'evm', address: signer.address, signer, provider: { request: ({ method, params = [] }) => ctx.provider.send(method, params) } };
    // Wallet accounts must report the connected address first, just like an EIP-1193 wallet.
    const rpc = session.provider.request;
    session.provider.request = (request) => request.method === 'eth_accounts' ? Promise.resolve([signer.address]) : rpc(request);
    return { getSession: () => session, getConfig: async () => ctx.cfg, ethersFn: () => import('ethers'),
      prepareIntent: (body) => post('/api/positions/subscription-intents', body),
      prepareClaim: (body) => post('/api/positions/claim-intents', body),
      attachIntent: (intentId, txHash) => post(`/api/positions/subscription-intents/${intentId}/transaction`, { tx_hash: txHash }) };
  };
  const subscribe = async (offering, signer, shares) => {
    const action = { shares: String(shares), chain: { pool_id: offering.poolId, chain_id: ctx.cfg.chainIdDecimal,
      contract: ctx.cfg.contracts.RWAOfferingPool, protocol_version: 5, settlement_asset: await ctx.usdc.getAddress(), price_e6: String(offering.price) } };
    await ctx.send(ctx.usdc.mint(signer.address, BigInt(shares) * offering.price));
    return subscribeOffering(action, walletOptions(signer));
  };
  return { get, post, subscribe, walletOptions, base };
}

// The application-only CI jobs do not install Hardhat. The dedicated W2 job runs this suite.
describe('W2 real EVM + HTTP + wallet lifecycle', { skip: process.env.AGENTBL_W2_INTEGRATION !== '1' }, () => {
  let node;
  before(async () => { node = await runHardhatNode(); });
  after(async () => { await stopHardhatNode(node); });

  it('persists wallet subscriptions, additional purchases, fees and claims through the real HTTP adapter', async (t) => {
    const ctx = await deployW2(node, t), app = await backend(ctx, t);
    const offering = await ctx.createOffering();
    await app.subscribe(offering, ctx.investor, 4n);
    await app.subscribe(offering, ctx.investor, 6n);
    let data = await app.get(ctx.investor.address);
    assert.equal(data.positions.length, 1); assert.equal(data.positions[0].shares, '10');
    assert.equal(data.positions[0].cost_atomic, '8000000'); assert.equal(data.positions[0].reconciled, true);
    assert.equal((await app.get(ctx.secondInvestor.address)).positions.length, 0);
    const intents = await ctx.ledger.writer.readIntents();
    assert.equal(intents.filter((intent) => intent.status === 'confirmed').length, 2);
    await ctx.send(ctx.pool.disburseToExporter(offering.poolId, 8_000_000n, ctx.exporter.address, id('w2:drawdown')));
    await ctx.send(ctx.usdc.mint(ctx.exporter.address, 10_000_000n));
    await ctx.send(ctx.usdc.connect(ctx.exporter).approve(await ctx.pool.getAddress(), 10_000_000n));
    await ctx.send(ctx.pool.connect(ctx.exporter).repay(offering.poolId, 10_000_000n));
    await ctx.send(ctx.pool.recordImporterPayment(offering.poolId, id('w2:payment'), 10_000_000n));
    await ctx.send(ctx.pool.recordCargoArrival(offering.poolId, id('w2:arrival')));
    await ctx.send(ctx.pool.settle(offering.poolId, 10_000_000n));
    await ctx.send(ctx.pool.deductFee(offering.poolId, 1_000_000n, ctx.owner.address, id('w2:fee')));
    const recoveryTopic = ctx.pool.interface.getEvent('RepaymentReceived').topicHash;
    const incompleteProvider = new Proxy(ctx.provider, { get(target, property) {
      if (property === 'getLogs') return async (filter) => (await target.getLogs(filter)).filter((log) => log.topics[0] !== recoveryTopic);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    ctx.capital.getContext = async () => ({ ...await ctx.getContext(), provider: incompleteProvider });
    data = await app.get(ctx.investor.address);
    assert.equal(data.warning, 'chain_reconciliation_required');
    assert.equal(data.positions[0].status, 'reconciling');
    assert.equal(data.positions[0].claimable_atomic, null);
    ctx.capital.getContext = ctx.getContext;
    data = await app.get(ctx.investor.address);
    assert.equal(data.positions[0].claimable_atomic, '9000000');
    const result = await claimPosition(data.positions[0], app.walletOptions(ctx.investor));
    assert.equal(result.amount_atomic, '9000000');
    data = await app.get(ctx.investor.address);
    assert.equal(data.positions[0].claimed_atomic, '9000000'); assert.equal(data.positions[0].status, 'fully_claimed');
    const entries = Ledger.activeEntries(await ctx.ledger.writer.readCashEntries());
    assert.deepEqual(entries.map((entry) => entry.kind), ['INVESTOR_DEPOSIT', 'INVESTOR_DEPOSIT', 'DISBURSEMENT', 'RECOVERY', 'FEE', 'CLAIM']);
    assert.equal(entries.reduce((sum, entry) => sum + (['INVESTOR_DEPOSIT', 'RECOVERY'].includes(entry.kind) ? BigInt(entry.amount_atomic) : -BigInt(entry.amount_atomic)), 0n), 0n);
    assert.equal(await ctx.usdc.balanceOf(ctx.investor.address), 9_000_000n);
  });

  it('refunds actual paid capital, isolates Demo holdings and survives an empty position snapshot', async (t) => {
    const ctx = await deployW2(node, t), app = await backend(ctx, t);
    const offering = await ctx.createOffering();
    await app.subscribe(offering, ctx.investor, 4n);
    storeState.investments.push({ walletAddress: ctx.investor.address.toLowerCase(), poolId: 'demo-only', tokenCount: 5, amountUsd: 4, reference: 'demo:sub:w2' });
    await ctx.advance(offering.deadline + 1n);
    await ctx.send(ctx.pool.refundInvestor(offering.poolId, ctx.investor.address));
    const data = await app.get(ctx.investor.address);
    const live = data.positions.find((position) => position.mode === 'live');
    assert.equal(live.status, 'refunded'); assert.equal(live.refunded_atomic, '3200000'); assert.equal(live.shares, '0');
    assert.equal(data.positions.find((position) => position.mode === 'demo').shares, '5');
    await fs.rm(path.join(ctx.ledgerDir, 'positions.json'));
    const restored = new Ledger({ baseDir: ctx.ledgerDir });
    assert.equal((await restored.listPositions())[0].refunded_atomic, '3200000');
    assert.equal(await ctx.usdc.balanceOf(ctx.investor.address), 3_200_000n);
  });

  it('recovers a broadcast whose process died before attaching its hash, without signing again', async (t) => {
    const ctx = await deployW2(node, t);
    const offering = await ctx.createOffering();
    const block = await ctx.provider.getBlock('latest');
    const intent = await ctx.capital.prepareSubscription({ wallet: ctx.investor.address, chain_pool_id: offering.poolId,
      shares: '10', max_unit_price: String(offering.price), expected_quote_version: '1', deadline: String(block.timestamp + 300) });
    await ctx.send(ctx.usdc.mint(ctx.investor.address, 8_000_000n));
    await ctx.send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), 8_000_000n));
    await ctx.send(ctx.investor.sendTransaction({ to: await ctx.pool.getAddress(), data: intent.calldata }));
    const count = await ctx.provider.getTransactionCount(ctx.investor.address);
    const restored = new Ledger({ baseDir: ctx.ledgerDir });
    const capital = new CapitalLedgerService({ ledger: restored, chainConfig: ctx.cfg, getContext: ctx.getContext, getMode: () => 'live' });
    const result = await capital.list(ctx.investor.address);
    assert.equal(result.positions[0].shares, '10');
    assert.equal((await restored.getIntent(intent.intent_id)).status, 'confirmed');
    await capital.sync(); await capital.sync();
    assert.equal((await restored.writer.readCashEntries()).length, 1);
    assert.equal(await ctx.provider.getTransactionCount(ctx.investor.address), count);
    await fs.rm(path.join(ctx.ledgerDir, 'cash-entries.jsonl'));
    const replayed = await capital.list(ctx.investor.address);
    assert.equal(replayed.positions[0].cost_atomic, '8000000');
    assert.equal(replayed.positions[0].shares, '10');
    assert.equal((await restored.writer.readCashEntries()).filter((entry) => entry.kind === 'INVESTOR_DEPOSIT').length, 1);
  });

  it('removes reorganized receipts from the position while preserving their audit history', async (t) => {
    const ctx = await deployW2(node, t), app = await backend(ctx, t);
    const offering = await ctx.createOffering();
    const snapshot = await ctx.provider.send('evm_snapshot', []);
    await app.subscribe(offering, ctx.investor, 4n);
    assert.equal((await app.get(ctx.investor.address)).positions[0].shares, '4');
    assert.equal(await ctx.provider.send('evm_revert', [snapshot]), true);
    await ctx.provider.send('evm_mine', []);
    const data = await app.get(ctx.investor.address);
    assert.equal(data.positions.length, 0);
    const history = await ctx.ledger.writer.readCashEntries();
    assert.ok(history.some((entry) => entry.kind === 'CHAIN_REORG'));
    assert.equal(Ledger.activeEntries(history).length, 0);
    await app.subscribe(offering, ctx.investor, 3n);
    assert.equal((await app.get(ctx.investor.address)).positions[0].shares, '3');
  });

  it('preflights owner capital plans, refuses forged receipts and waits for canonical confirmation depth', async (t) => {
    const ctx = await deployW2(node, t), app = await backend(ctx, t);
    const offering = await ctx.createOffering({ minRaise: 4n * 800_000n });
    await app.subscribe(offering, ctx.investor, 4n);
    const common = { chain_pool_id: offering.poolId, chainConfig: ctx.cfg, context: await ctx.getContext() };
    await assert.rejects(buildOwnerPlan({ ...common, action: 'DISBURSE', params: { amount_atomic: '1', exporter: ctx.exporter.address, evidence: 'before-success' } }));
    await ctx.advance(offering.deadline + 1n);
    const closePlan = await buildOwnerPlan({ ...common, action: 'FINALIZE_FUNDING' });
    assert.equal(closePlan.steps[0].method, 'finalizeFunding');
    await ctx.send(ctx.pool.finalizeFunding(offering.poolId));
    const plan = await buildOwnerPlan({ ...common, action: 'DISBURSE', params: { amount_atomic: '3200000', exporter: ctx.exporter.address, evidence: 'approved-drawdown' } });
    assert.equal(plan.steps[0].event_checks[0].args.amountAtomic, '3200000');
    await assert.rejects(buildOwnerPlan({ ...common, action: 'DISBURSE', params: { amount_atomic: '-1', exporter: ctx.exporter.address, evidence: 'bad' } }), { code: 'invalid_amount' });
    await assert.rejects(buildOwnerPlan({ ...common, action: 'REFUND', params: { investor: ctx.investor.address } }));
    const draftPool = await ctx.createOffering();
    const block = await ctx.provider.getBlock('latest');
    const intent = await ctx.capital.prepareSubscription({ wallet: ctx.investor.address, chain_pool_id: draftPool.poolId, shares: '2', max_unit_price: '800000', expected_quote_version: '1', deadline: String(block.timestamp + 300) });
    const wrongTx = await ctx.send(ctx.usdc.mint(ctx.investor.address, 1_600_000n));
    await assert.rejects(ctx.capital.attach(intent.intent_id, wrongTx.hash), { code: 'intent_transaction_mismatch' });
    await ctx.send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), 1_600_000n));
    const tx = await ctx.send(ctx.investor.sendTransaction({ to: await ctx.pool.getAddress(), data: intent.calldata }));
    const strict = new CapitalLedgerService({ ledger: ctx.ledger, chainConfig: ctx.cfg, getContext: ctx.getContext, getMode: () => 'live', confirmations: 2 });
    const attached = await strict.attach(intent.intent_id, tx.hash);
    assert.equal(attached.status, 'broadcast');
    await ctx.provider.send('evm_mine', []);
    await strict.sync();
    assert.equal((await ctx.ledger.getIntent(intent.intent_id)).status, 'confirmed');
  });

  it('supports liquidation recovery, zero recovery and proportional loss without duplicate payouts', async (t) => {
    const ctx = await deployW2(node, t), app = await backend(ctx, t);
    for (const recovery of [0n, 3_000_001n]) {
      const offering = await ctx.createOffering();
      await app.subscribe(offering, ctx.investor, 3n);
      await app.subscribe(offering, ctx.secondInvestor, 7n);
      await ctx.send(ctx.pool.disburseToExporter(offering.poolId, 8_000_000n, ctx.exporter.address, id(`w2:drawdown:${recovery}`)));
      await ctx.send(ctx.pool.applyPricingAction(offering.poolId, 0, 5, id(`w2:liquidation:${recovery}`), id(`w2:quote:${recovery}`)));
      if (recovery > 0n) {
        await ctx.send(ctx.usdc.mint(ctx.exporter.address, recovery));
        await ctx.send(ctx.usdc.connect(ctx.exporter).approve(await ctx.pool.getAddress(), recovery));
        await ctx.send(ctx.pool.connect(ctx.exporter).repay(offering.poolId, recovery));
        await ctx.send(ctx.pool.recordLiquidationRecovery(offering.poolId, id(`w2:recovery:${recovery}`), recovery));
      }
      await ctx.send(ctx.pool.resolveLiquidation(offering.poolId, id(`w2:resolution:${recovery}`)));
      for (const signer of [ctx.investor, ctx.secondInvestor]) {
        const position = (await app.get(signer.address)).positions.find((position) => position.chain_pool_id === offering.poolId);
        await claimPosition(position, app.walletOptions(signer));
      }
      assert.equal(await ctx.pool.totalClaimed(offering.poolId), recovery);
      assert.equal(await ctx.token.totalSupply(offering.poolId), 0n);
      assert.equal(await ctx.pool.escrowed(offering.poolId, await ctx.usdc.getAddress()), 0n);
    }
  });
});
