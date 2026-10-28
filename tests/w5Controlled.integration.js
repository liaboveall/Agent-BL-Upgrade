import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runHardhatNode, stopHardhatNode } from './helpers/ledgerTestHarness.js';
import { deployRightsRpc } from './helpers/rightsHarness.js';
import { listen, requestJson } from './helpers/http.js';
import { createControlledRoutes } from '../src/app/controlledRoutes.js';
import { sendError } from '../src/app/http.js';
import { subscribeOffering, claimPosition } from '../web/src/lib/web3.js';
import * as ethers from 'ethers';

describe('W5 actual controlled capital HTTP, wallet and crash recovery', () => {
  let node;
  before(async () => { node = await runHardhatNode(); }); after(async () => { await stopHardhatNode(node); });
  const fixture = async (t) => {
    const c = await deployRightsRpc(node, t), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w5-controlled-'));
    let mode = 'live';
    const packs = new Map(), disclosures = { financingDisclosure: async (hash) => { const pack = packs.get(hash); if (!pack) throw new Error('Missing fixture terms'); return pack; } };
    const contracts = { RWAOfferingPoolV5: await c.pool.getAddress(), ControlledRWAToken: await c.token.getAddress() };
    const routes = createControlledRoutes({ env: { AGENTBL_RUNTIME_DIR: dir }, chain: c.chain, disclosures, configuration: { chain_id: 31337, deployment_block: 0, contracts }, getMode: () => mode });
    const app = await listen(http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://local')).catch((error) => sendError(res, error, { logger: { warn() {}, error() {} } }))));
    t.after(async () => { await app.close(); await routes.close(); await fs.rm(dir, { recursive: true, force: true }); });
    const get = async (route) => (await requestJson(app.base, 'GET', `/api/controlled/${route}`)).data;
    const post = async (route, body) => {
      const response = await requestJson(app.base, 'POST', `/api/controlled/${route}`, body);
      if (response.status >= 400) throw Object.assign(new Error(response.data.error), { code: response.data.code }); return response.data;
    };
    const create = async () => {
      const issue = await c.issuance(); await c.send(c.registry.registerTitle(issue.issuance, issue.signature));
      const eblId = await c.registry.nextEblId() - 1n, offer = await c.offering(eblId, issue.issuance);
      packs.set(offer.terms.disclosureHash, offer.pack);
      await c.send(c.registry.connect(c.holder).pledge(eblId, await c.pool.getAddress(), offer.hash, offer.terms.subscribeUntil, '0x'));
      await c.send(c.controller.connect(c.issuer).createControlledOffering(offer.terms, offer.valuation, offer.valuer, offer.signature));
      const poolId = String(await c.pool.nextPoolId() - 1n), time = await c.now();
      await c.send(c.controller.connect(c.compliance).setEligibility(c.investor.address, c.fresh(), c.fresh(), time + 100000n));
      await c.send(c.controller.connect(c.compliance).refreshScreening(time + 80000n, c.fresh()));
      await c.send(c.controller.connect(c.investor).acknowledgeTerms(poolId, offer.hash, 1n, offer.terms.subscribeUntil));
      await c.send(c.usdc.mint(c.investor.address, 8000000n));
      return { ...offer, poolId };
    };
    const session = { kind: 'evm', signer: c.investor, address: c.investor.address, provider: { request: ({ method, params = [] }) => method === 'eth_accounts' ? Promise.resolve([c.investor.address]) : c.provider.send(method, params) } };
    const config = (await get('status')).config;
    let latestIntent;
    const options = { getSession: () => session, getConfig: async () => config, ethersFn: async () => ethers,
      prepareIntent: async (body) => { const reviewed = await get(`offerings/${body.chain_pool_id}/terms`); latestIntent = (await post('subscription-intents', { ...body, reviewed_disclosure_hash: reviewed.disclosure_hash })).intent; return latestIntent; },
      prepareClaim: async (body) => { latestIntent = (await post('claim-intents', body)).intent; return latestIntent; },
      beforeBroadcast: async (intent) => { latestIntent = (await post(`intents/${intent.intent_id}/broadcast`, {})).intent; return latestIntent; },
      attachIntent: async (id, hash) => (await post(`intents/${id}/transaction`, { tx_hash: hash })).intent };
    const action = (p, shares) => ({ shares, chain: { chain_id: 31337, contract: contracts.RWAOfferingPoolV5, pool_id: p.poolId, price_e6: '800000', quote_version: '1', settlement_asset: p.terms.settlementAsset } });
    return { c, get, post, create, options, action, latestIntent: () => latestIntent, setMode: (value) => { mode = value; } };
  };
  it('uses the production wallet adapter for actual escrow, fixed exporter, multiple late repayments and a separate confirmed claim', async (t) => {
    const f = await fixture(t), { c } = f, p = await f.create();
    const listing = await f.get('offerings'); assert.equal(listing.offerings[0].state, 'Open'); assert.equal(listing.offerings[0].subscription_open, true);
    await subscribeOffering(f.action(p, '10'), f.options);
    assert.equal(await c.pool.escrowed(p.poolId, p.terms.settlementAsset), 8000000n);
    let positions = (await f.get(`positions?wallet=${c.investor.address}`)).positions; assert.equal(positions[0].reconciled, true); assert.equal(positions[0].cost_atomic, '8000000');
    await c.send(c.controller.connect(c.operator).disburse(p.poolId, 8000000n, c.fresh()));
    await c.advance(BigInt(p.terms.maturity) + 1n); await c.lifecycle('markDefault', [p.poolId]);
    assert.equal(await c.pool.stateOf(p.poolId), 13n);
    await c.send(c.usdc.mint(c.holder.address, 2000000n)); await c.send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), 10000000n));
    for (const [index, value] of [4000000n, 6000000n].entries()) {
      await c.send(c.pool.connect(c.holder).repay(p.poolId, value));
      await c.send(c.controller.connect(c.attestor).executeLifecycle(c.pool.interface.encodeFunctionData(index === 0 ? 'recordImporterPayment' : 'recordAdditionalPayment', [p.poolId, c.fresh(), value])));
    }
    await c.lifecycle('recordCargoArrival', [p.poolId, c.fresh()]); await c.lifecycle('settle', [p.poolId, 10000000n]);
    positions = (await f.get(`positions?wallet=${c.investor.address}`)).positions; assert.equal(positions[0].claimable_atomic, '10000000');
    assert.equal(await c.usdc.balanceOf(c.investor.address), 0n, 'Repaid precedes the separate investor claim');
    await claimPosition(positions[0], f.options);
    assert.equal(await c.usdc.balanceOf(c.investor.address), 10000000n);
    assert.equal((await f.get(`positions?wallet=${c.investor.address}`)).positions[0].claimed_atomic, '10000000');
    assert.equal(await c.pool.escrowed(p.poolId, p.terms.settlementAsset), 0n);
    // Permanent recovery rights survive a burned token and the append-only ledger replay.
    await c.send(c.usdc.mint(c.holder.address, 1234567n));
    await c.send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), 1234567n));
    await c.send(c.pool.connect(c.holder).repay(p.poolId, 1234567n));
    positions = (await f.get(`positions?wallet=${c.investor.address}`)).positions;
    assert.equal(positions[0].shares, '0'); assert.equal(positions[0].claimable_atomic, '1234567'); assert.equal(positions[0].reconciled, true);
    await claimPosition(positions[0], f.options);
    assert.equal((await f.get(`positions?wallet=${c.investor.address}`)).positions[0].claimed_atomic, '11234567');
    assert.equal(await c.usdc.balanceOf(c.investor.address), 11234567n);
    assert.equal(await c.pool.escrowed(p.poolId, p.terms.settlementAsset), 0n);
  });
  it('reconciles a crash after nonce-bound broadcast without resending, and detects a canonical reorg', async (t) => {
    const f = await fixture(t), { c } = f, p = await f.create();
    await c.send(c.usdc.connect(c.investor).approve(await c.pool.getAddress(), 8000000n));
    const prepared = (await f.post('subscription-intents', { wallet: c.investor.address, chain_pool_id: p.poolId, shares: '10', max_unit_price: '800000', expected_quote_version: '1', deadline: String(await c.now() + 600n), reviewed_disclosure_hash: p.terms.disclosureHash })).intent;
    const intent = (await f.post(`intents/${prepared.intent_id}/broadcast`, {})).intent;
    await assert.rejects(f.post(`intents/${prepared.intent_id}/broadcast`, {}));
    const snapshot = await c.provider.send('evm_snapshot', []), count = await c.provider.getTransactionCount(c.investor.address);
    const tx = await c.investor.sendTransaction({ to: intent.protocol_instance.pool_address, data: intent.calldata, nonce: intent.broadcast_nonce }); await tx.wait();
    const recovered = (await f.get(`intents/${intent.intent_id}`)).intent;
    assert.equal(recovered.status, 'confirmed'); assert.equal(recovered.tx_hash.toLowerCase(), tx.hash.toLowerCase());
    assert.equal(await c.provider.getTransactionCount(c.investor.address), count + 1);
    await c.provider.send('evm_revert', [snapshot]); await c.provider.send('evm_mine', []);
    const after = (await f.get(`intents/${intent.intent_id}`)).intent;
    assert.equal(after.status, 'reconciliation_required');
  });
  it('releases a checkpoint the wallet never sent, makes the retry reuse its nonce, and supersedes the original', async (t) => {
    const f = await fixture(t), { c } = f, p = await f.create();
    await c.send(c.usdc.connect(c.investor).approve(await c.pool.getAddress(), 8000000n));
    const deadline = String(await c.now() + 600n);
    const subscribe = async () => (await f.post('subscription-intents', { wallet: c.investor.address, chain_pool_id: p.poolId, shares: '2', max_unit_price: '800000', expected_quote_version: '1', deadline, reviewed_disclosure_hash: p.terms.disclosureHash })).intent;
    const first = (await f.post(`intents/${(await subscribe()).intent_id}/broadcast`, {})).intent;
    // The wallet refused: nothing was sent. The next send is held until the first is resolved.
    const second = await subscribe();
    await assert.rejects(f.post(`intents/${second.intent_id}/broadcast`, {}), { code: 'wallet_reconciliation_required' });
    assert.deepEqual((await f.get(`intents?wallet=${c.investor.address}`)).intents.map((intent) => intent.intent_id), [first.intent_id]);
    assert.equal((await f.post(`intents/${first.intent_id}/release`, {})).intent.status, 'released');
    const retry = (await f.post(`intents/${second.intent_id}/broadcast`, {})).intent;
    assert.equal(retry.broadcast_nonce, first.broadcast_nonce);
    // The retry is the same call: whichever is mined, it happens once, and it belongs to the retry.
    assert.equal(retry.calldata, first.calldata);
    const tx = await c.investor.sendTransaction({ to: retry.protocol_instance.pool_address, data: retry.calldata, nonce: retry.broadcast_nonce }); await tx.wait();
    assert.equal((await f.post(`intents/${retry.intent_id}/transaction`, { tx_hash: tx.hash })).intent.status, 'confirmed');
    const original = (await f.get(`intents/${first.intent_id}`)).intent;
    assert.equal(original.status, 'superseded'); assert.equal(original.superseded_by_tx_hash, tx.hash.toLowerCase());
    assert.equal((await f.get(`positions?wallet=${c.investor.address}`)).positions[0].shares, '2');
    assert.equal(await c.pool.escrowed(p.poolId, p.terms.settlementAsset), 1600000n);
  });
  it('ends a subscription whose mined transaction reverted, without blocking the next one', async (t) => {
    const f = await fixture(t), { c } = f, p = await f.create();
    await c.send(c.usdc.connect(c.investor).approve(await c.pool.getAddress(), 8000000n));
    const deadline = await c.now() + 600n;
    const prepared = (await f.post('subscription-intents', { wallet: c.investor.address, chain_pool_id: p.poolId, shares: '2', max_unit_price: '800000', expected_quote_version: '1', deadline: String(deadline), reviewed_disclosure_hash: p.terms.disclosureHash })).intent;
    const intent = (await f.post(`intents/${prepared.intent_id}/broadcast`, {})).intent;
    // Mined after its deadline: the receipt has status 0 and no cash event.
    await c.provider.send('evm_setAutomine', [false]);
    let tx;
    try {
      tx = await c.investor.sendTransaction({ to: intent.protocol_instance.pool_address, data: intent.calldata, nonce: intent.broadcast_nonce, gasLimit: 1_000_000n });
      await c.provider.send('evm_setNextBlockTimestamp', [Number(deadline) + 1]); await c.provider.send('evm_mine', []);
    } finally { await c.provider.send('evm_setAutomine', [true]); }
    assert.equal((await c.provider.getTransactionReceipt(tx.hash)).status, 0);
    const reverted = (await f.post(`intents/${intent.intent_id}/transaction`, { tx_hash: tx.hash })).intent;
    assert.equal(reverted.status, 'reverted');
    assert.deepEqual((await f.get(`intents?wallet=${c.investor.address}`)).intents, []);
    assert.equal(await c.pool.escrowed(p.poolId, p.terms.settlementAsset), 0n);
    const next = (await f.post('subscription-intents', { wallet: c.investor.address, chain_pool_id: p.poolId, shares: '1', max_unit_price: '800000', expected_quote_version: '1', deadline: String(await c.now() + 600n), reviewed_disclosure_hash: p.terms.disclosureHash })).intent;
    assert.equal((await f.post(`intents/${next.intent_id}/broadcast`, {})).intent.status, 'broadcast_prepared');
  });
  it('refunds exact paid principal through a saved wallet intent after failed fundraising, preserving Demo isolation', async (t) => {
    const f = await fixture(t), { c } = f, p = await f.create();
    f.setMode('demo'); await assert.rejects(f.post('subscription-intents', { wallet: c.investor.address, chain_pool_id: p.poolId, shares: '1' }), { code: 'live_mode_required' }); f.setMode('live');
    await subscribeOffering(f.action(p, '3'), f.options);
    await c.advance(BigInt(p.terms.subscribeUntil) + 1n);
    const prepared = (await f.post('refund-intents', { wallet: c.investor.address, chain_pool_id: p.poolId })).intent;
    assert.equal(prepared.amount_atomic, '2400000');
    const intent = (await f.post(`intents/${prepared.intent_id}/broadcast`, {})).intent;
    const tx = await c.investor.sendTransaction({ to: intent.protocol_instance.pool_address, data: intent.calldata, nonce: intent.broadcast_nonce }); await tx.wait();
    const done = (await f.post(`intents/${intent.intent_id}/transaction`, { tx_hash: tx.hash })).intent; assert.equal(done.status, 'confirmed');
    const [position] = (await f.get(`positions?wallet=${c.investor.address}`)).positions;
    assert.equal(position.refunded_atomic, '2400000'); assert.equal(position.shares, '0');
    assert.equal(await c.pool.escrowed(p.poolId, p.terms.settlementAsset), 0n);
  });
});
