import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import * as ethers from 'ethers';
import { runHardhatNode, stopHardhatNode } from './helpers/ledgerTestHarness.js';
import { deployRightsRpc } from './helpers/rightsHarness.js';
import { listen, requestJson } from './helpers/http.js';
import { RightsService } from '../src/rights/service.js';
import { createRightsRoutes } from '../src/app/rightsRoutes.js';
import { createControlledRoutes } from '../src/app/controlledRoutes.js';
import { sendError } from '../src/app/http.js';
import { sendRightsPlan } from '../web/src/lib/rights.js';
import { subscribeOffering, claimPosition } from '../web/src/lib/web3.js';
import { RpcReadPool } from '../src/rights/reads.js';

describe('N3 actual EVM, authenticated HTTP, enrolled roles and wallet adapters', () => {
  let node, c, directory, app, controlled, service, sessions, config, rpcRequests = 0, generation = 1, mode = 'live';
  const observations = { scope: 'local_evm_only', broadcasts_to_public_network: 0, paths: [], queries: [] };
  before(async () => {
    node = await runHardhatNode(); c = await deployRightsRpc(node, { after() {} });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-n3-'));
    const env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex'), AGENTBL_RUNTIME_DIR: directory };
    service = new RightsService({ directory: path.join(directory, 'rights'), env, chain: c.chain, getMode: () => mode, getGeneration: () => generation });
    const rights = createRightsRoutes({ service, env });
    c.provider.on('debug', (event) => { if (event.action === 'sendRpcPayload') rpcRequests += Array.isArray(event.payload) ? event.payload.length : 1; });
    const reads = new RpcReadPool();
    controlled = createControlledRoutes({ env, chain: c.chain, disclosures: service, getMode: () => mode, getGeneration: () => generation, readPool: reads,
      configuration: { chain_id: 31337, deployment_block: 0, contracts: { RWAOfferingPoolV5: c.pool.target, ControlledRWAToken: c.token.target } } });
    app = await listen(http.createServer((req, res) => (async () => {
      const url = new URL(req.url, 'http://local'); if (!await rights(req, res, url)) await controlled(req, res, url);
    })().catch((error) => sendError(res, error, { logger: { warn() {}, error() {} } }))));
    sessions = {};
    for (const [name, signer, roles] of [ ['issuer', c.issuer, ['issuer']], ['holder', c.holder, ['holder']], ['valuer', c.valuer, ['valuer']], ['operator', c.operator, ['operator']],
      ['reviewer', c.reviewer, ['reviewer']], ['reviewer2', c.memberC, ['reviewer']], ['compliance', c.compliance, ['compliance']], ['attestor', c.attestor, ['attestor']],
      ['disposer', c.disposer, ['disposer']], ['investor', c.investor, ['investor']], ['second', c.outsider, ['investor']] ]) {
      const subject = await service.createSubject({ organization: 'research-carrier', wallet: signer.address, roles });
      const challenge = await request('rights/wallet-challenges', { subject_id: subject.subject_id });
      const opened = await request('rights/sessions', { challenge_id: challenge.challenge_id, signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message) });
      sessions[name] = { ...opened, signer, address: signer.address, subject };
    }
    config = (await request('controlled/status')).config;
    observations.rpc_concurrency_limit = reads.concurrency;
  });
  after(async () => {
    if (process.env.AGENTBL_N3_EVIDENCE) { await fs.mkdir(process.env.AGENTBL_N3_EVIDENCE, { recursive: true }); await fs.writeFile(path.join(process.env.AGENTBL_N3_EVIDENCE, 'evm-observations.json'), JSON.stringify(observations, null, 2)); }
    await app?.close(); await controlled?.close(); await c?.provider.destroy(); await stopHardhatNode(node);
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  const request = async (route, body, actor) => {
    const response = await requestJson(app.base, body === undefined ? 'GET' : 'POST', `/api/${route}`, body, actor ? { 'x-rights-session': actor.token } : {});
    if (response.status >= 400) throw Object.assign(new Error(response.data.error), { code: response.data.code, status: response.status });
    return response.data;
  };
  const execute = async (actor, input) => {
    const plan = await request('rights/transaction-plans', input, actor);
    if (input.operation === 'register_title') assert.equal(plan.preview.documentHash, input.payload.issuance.documentHash);
    if (input.operation === 'set_eligibility') assert.equal(plan.preview.investor_wallet, input.payload.wallet);
    const result = await sendRightsPlan(plan, { session: actor, ethersFn: async () => ethers,
      beforeBroadcast: (saved) => request(`rights/transaction-plans/${saved.plan_id}/broadcast`, {}, actor),
      attachTransaction: (id, hash) => request(`rights/transaction-plans/${id}/transaction`, { tx_hash: hash }, actor) });
    assert.equal(result.status, 'confirmed'); return result;
  };
  const create = async (full = false) => {
    const material = await request('rights/materials', { material: { document: 'Fictional copper title, Singapore to Shanghai' }, public_summary: {
      asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 3, terms_hash: c.fresh(), risk_flags: ['simulated_title', 'test_asset'] } }, sessions.issuer);
    const issue = await c.issuance(material.document_hash), eblId = await c.registry.nextEblId(), offer = await c.offering(eblId, issue.issuance);
    if (full) {
      const signing = await request(`rights/materials/${material.material_id}/signing-request`, { kind: 'issuance', value: issue.issuance }, sessions.issuer);
      issue.signature = await c.issuer.signTypedData(signing.domain, signing.types, signing.value);
      await execute(sessions.issuer, { operation: 'register_title', material_id: material.material_id, payload: issue });
    } else await c.send(c.registry.registerTitle(issue.issuance, issue.signature));
    const { schema: _schema, policy: _policy, ...input } = offer.pack.document;
    if (full) {
      const preview = await request(`rights/materials/${material.material_id}/financing-disclosure-preview`, input, sessions.issuer);
      assert.equal(preview.terms_hash, offer.hash);
      await assert.rejects(service.financingDisclosure(preview.disclosure_hash), { code: 'financing_disclosure_missing' });
    }
    await request(`rights/materials/${material.material_id}/financing-disclosure`, input, sessions.issuer);
    await request(`rights/materials/${material.material_id}/terms`, { terms_hash: offer.hash }, sessions.issuer);
    for (const actor of [sessions.reviewer, sessions.reviewer2]) await request(`rights/materials/${material.material_id}/review`, { document_hash: material.document_hash, terms_hash: offer.hash }, actor);
    await request(`rights/materials/${material.material_id}/publish`, {}, sessions.issuer);
    if (full) {
      const signing = await request(`rights/materials/${material.material_id}/signing-request`, { kind: 'valuation', value: offer.valuation }, sessions.valuer);
      offer.signature = await c.valuer.signTypedData(signing.domain, signing.types, signing.value);
      await execute(sessions.holder, { operation: 'pledge', material_id: material.material_id, terms_hash: offer.hash, valid_until: offer.terms.subscribeUntil, payload: { ebl_id: String(eblId) } });
      await execute(sessions.issuer, { operation: 'create_offering', material_id: material.material_id, payload: offer });
    } else {
      await c.send(c.registry.connect(c.holder).pledge(eblId, c.pool.target, offer.hash, offer.terms.subscribeUntil, '0x'));
      await c.send(c.controller.connect(c.issuer).createControlledOffering(offer.terms, offer.valuation, offer.valuer, offer.signature));
    }
    return { ...offer, poolId: String(await c.pool.nextPoolId() - 1n), material_id: material.material_id };
  };
  const options = (actor) => ({ getConfig: async () => config, getSession: () => ({ ...actor, kind: 'evm', provider: { request: ({ method, params = [] }) => method === 'eth_accounts' ? Promise.resolve([actor.address]) : c.provider.send(method, params) } }), ethersFn: async () => ethers });
  const adapter = (actor) => {
    const session = options(actor).getSession();
    return { ...options(actor), getSession: () => session,
      prepareIntent: async (body) => { const reviewed = await request(`controlled/offerings/${body.chain_pool_id}/terms`); return (await request('controlled/subscription-intents', { ...body, reviewed_disclosure_hash: reviewed.disclosure_hash }, actor)).intent; },
      prepareClaim: async (body) => (await request('controlled/claim-intents', body, actor)).intent,
      beforeBroadcast: async (intent) => (await request(`controlled/intents/${intent.intent_id}/broadcast`, {}, actor)).intent,
      attachIntent: async (id, txHash) => (await request(`controlled/intents/${id}/transaction`, { tx_hash: txHash }, actor)).intent };
  };
  const subscribe = async (p, actor, shares) => {
    await execute(sessions.compliance, { operation: 'set_eligibility', valid_until: String(await c.now() + 70000n), evidence_hash: c.fresh(), payload: { wallet: actor.address, subject_hash: c.fresh() } });
    await execute(sessions.compliance, { operation: 'refresh_screening', valid_until: String(await c.now() + 70000n), evidence_hash: c.fresh() });
    await execute(actor, { operation: 'acknowledge_terms', pool_id: p.poolId, terms_hash: p.hash, quote_version: '1', valid_until: p.terms.subscribeUntil, reviewed_disclosure_hash: p.terms.disclosureHash });
    await c.send(c.usdc.mint(actor.address, BigInt(shares) * 800000n));
    await subscribeOffering({ shares, chain: { chain_id: 31337, contract: c.pool.target, pool_id: p.poolId, price_e6: '800000', quote_version: '1', settlement_asset: c.usdc.target } }, adapter(actor));
  };
  const position = async (actor, p) => (await request(`controlled/positions?wallet=${actor.address}`)).positions.find((pos) => String(pos.chain_pool_id) === p.poolId);

  it('completes an explicit issuer→holder→valuer/reviewer→investors→operator→repayment→independent claims flow', async () => {
    const p = await create(true);
    const workflow = await request(`rights/materials/${p.material_id}/workflow`, undefined, sessions.operator);
    assert.equal(workflow.pool_id, Number(p.poolId)); assert.equal(workflow.steps[4].status, 'complete'); assert.ok(workflow.snapshot.block_hash);
    for (const actor of [sessions.investor, sessions.second]) await subscribe(p, actor, '5');
    assert.equal(await c.pool.escrowed(p.poolId, c.usdc.target), 8000000n);
    await execute(sessions.operator, { operation: 'disburse', pool_id: p.poolId, amount_atomic: '8000000', evidence_hash: c.fresh() });
    await c.send(c.usdc.mint(c.holder.address, 2000000n)); await c.send(c.usdc.connect(c.holder).approve(c.pool.target, 10000000n));
    await execute(sessions.holder, { operation: 'repay', pool_id: p.poolId, amount_atomic: '10000000' });
    await execute(sessions.attestor, { operation: 'record_payment', pool_id: p.poolId, amount_atomic: '10000000', evidence_hash: c.fresh() });
    await execute(sessions.attestor, { operation: 'record_arrival', pool_id: p.poolId, evidence_hash: c.fresh() });
    await execute(sessions.operator, { operation: 'settle', pool_id: p.poolId, amount_atomic: '10000000' });
    for (const actor of [sessions.second, sessions.investor]) { const pos = await position(actor, p); assert.equal(pos.claimable_atomic, '5000000'); await claimPosition(pos, adapter(actor)); }
    assert.equal(await c.pool.escrowed(p.poolId, c.usdc.target), 0n);
    assert.equal((await position(sessions.investor, p)).claimed_atomic, '5000000');
    observations.paths.push({ path: 'normal', pool_id: p.poolId, investors: 2, principal: '8000000', repaid: '10000000', claimed: '10000000', escrow: '0' });
  });

  it('rejects stale generations and unauthorized receipt access while preserving original recovery', async () => {
    const issue = await c.issuance(), input = { operation: 'register_title', payload: issue };
    const draft = await request('rights/transaction-plans', input, sessions.issuer);
    generation++; await assert.rejects(request(`rights/transaction-plans/${draft.plan_id}/broadcast`, {}, sessions.issuer), { code: 'execution_context_changed' });
    const next = await request('rights/transaction-plans', input, sessions.issuer);
    await request(`rights/transaction-plans/${next.plan_id}/broadcast`, {}, sessions.issuer);
    await assert.rejects(request(`rights/transaction-plans/${next.plan_id}/broadcast`, {}, sessions.issuer), { code: 'rights_plan_reconcile_required' });
    const snapshot = await c.provider.send('evm_snapshot', []), nonce = await c.provider.getTransactionCount(c.issuer.address);
    const tx = await c.issuer.sendTransaction({ to: next.to, data: next.calldata, nonce: next.nonce }); await tx.wait();
    generation++; mode = 'demo';
    const recovered = await request(`rights/transaction-plans/${next.plan_id}`, undefined, sessions.issuer);
    assert.equal(recovered.tx_hash, tx.hash); assert.equal(recovered.status, 'confirmed'); assert.equal(await c.provider.getTransactionCount(c.issuer.address), nonce + 1);
    await assert.rejects(request(`rights/transaction-plans/${next.plan_id}`, undefined, sessions.holder), { code: 'rights_plan_not_found' });
    await c.provider.send('evm_revert', [snapshot]); await c.provider.send('evm_mine', []);
    const reorg = await request(`rights/transaction-plans/${next.plan_id}`, undefined, sessions.issuer);
    assert.equal(reorg.status, 'reconciling'); assert.equal(reorg.receipt_history.length, 1); mode = 'live';
    const p = await create(), body = { wallet: c.investor.address, chain_pool_id: p.poolId, shares: '1', max_unit_price: '800000', expected_quote_version: '1', deadline: String(await c.now() + 600n), reviewed_disclosure_hash: p.terms.disclosureHash };
    await subscribe(p, sessions.investor, '1');
    const capital = (await request('controlled/subscription-intents', body, sessions.investor)).intent;
    await assert.rejects(request(`controlled/intents/${capital.intent_id}`, undefined, sessions.second), { code: 'controlled_intent_not_found' });
    await assert.rejects(request(`controlled/intents/${capital.intent_id}`), { code: 'rights_session_required' });
    await request(`controlled/positions?wallet=${sessions.investor.address}`);
    assert.equal((await request(`controlled/intents/${capital.intent_id}`, undefined, sessions.investor)).intent.status, 'draft', 'A historical identical subscription is not assigned to the new draft');
    generation++; await assert.rejects(request(`controlled/intents/${capital.intent_id}/broadcast`, {}, sessions.investor), { code: 'execution_context_changed' });
    const revisionDraft = await request('rights/transaction-plans', { operation: 'disburse', pool_id: p.poolId, amount_atomic: '1', evidence_hash: c.fresh(), material_id: p.material_id }, sessions.operator).catch((error) => error);
    assert.equal(revisionDraft.code, 'rights_preflight_failed', 'Unavailable funding cannot be previewed as successful');
  });

  it('refunds failed fundraising and distributes a loss plus late recovery to two investors after burning shares', async () => {
    const refund = await create(); await subscribe(refund, sessions.investor, '3'); await c.advance(BigInt(refund.terms.subscribeUntil) + 1n);
    const prepared = (await request('controlled/refund-intents', { wallet: sessions.investor.address, chain_pool_id: refund.poolId }, sessions.investor)).intent;
    const checkpoint = (await request(`controlled/intents/${prepared.intent_id}/broadcast`, {}, sessions.investor)).intent;
    const tx = await c.investor.sendTransaction({ to: c.pool.target, data: checkpoint.calldata, nonce: checkpoint.broadcast_nonce }); await tx.wait();
    assert.equal((await request(`controlled/intents/${prepared.intent_id}/transaction`, { tx_hash: tx.hash }, sessions.investor)).intent.status, 'confirmed');
    assert.equal((await position(sessions.investor, refund)).refunded_atomic, '2400000');
    observations.paths.push({ path: 'refund', pool_id: refund.poolId, paid: '2400000', refunded: '2400000', escrow: '0' });
    const p = await create(); for (const actor of [sessions.investor, sessions.second]) await subscribe(p, actor, '5');
    await execute(sessions.operator, { operation: 'disburse', pool_id: p.poolId, amount_atomic: '8000000', evidence_hash: c.fresh() });
    await c.send(c.usdc.connect(c.holder).approve(c.pool.target, 4000001n)); await execute(sessions.holder, { operation: 'repay', pool_id: p.poolId, amount_atomic: '4000001' });
    await c.advance(BigInt(p.terms.maturity)); await execute(sessions.investor, { operation: 'start_exit', pool_id: p.poolId });
    const resolution = await c.controller.resolutions(p.poolId); await c.advance(BigInt(resolution.hardDeadline));
    await execute(sessions.second, { operation: 'finalize_resolution', pool_id: p.poolId });
    const before = [];
    for (const actor of [sessions.second, sessions.investor]) { const pos = await position(actor, p); before.push(pos.claimable_atomic); await claimPosition(pos, adapter(actor)); }
    assert.deepEqual(before, ['2000000', '2000001']);
    await c.send(c.usdc.connect(c.holder).approve(c.pool.target, 9n)); await execute(sessions.holder, { operation: 'repay', pool_id: p.poolId, amount_atomic: '9' });
    for (const actor of [sessions.investor, sessions.second]) { const pos = await position(actor, p); assert.equal(pos.shares, '0'); await claimPosition(pos, adapter(actor)); assert.equal((await position(actor, p)).claimed_atomic, '2000005'); }
    assert.equal(await c.pool.escrowed(p.poolId, c.usdc.target), 0n);
    observations.paths.push({ path: 'loss_and_late_recovery', pool_id: p.poolId, principal: '8000000', recovered: '4000010', investor_totals: ['2000005', '2000005'], escrow: '0' });
    await service.revokeSubject(sessions.investor.subject.subject_id);
    const challenge = await request('rights/wallet-challenges', { subject_id: sessions.investor.subject.subject_id, exit_only: true });
    const opened = await request('rights/sessions', { challenge_id: challenge.challenge_id, signature: await c.investor.signTypedData(challenge.domain, challenge.types, challenge.message) });
    const exit = { ...sessions.investor, ...opened };
    assert.equal((await request('rights/me?exit_only=1', undefined, exit)).exit_only, true);
    await assert.rejects(request('rights/materials', undefined, exit), { code: 'rights_session_required' });
    await assert.rejects(request('controlled/subscription-intents', { wallet: exit.address, chain_pool_id: p.poolId }, exit), { code: 'rights_session_required' });
    const old = (await request(`controlled/positions?wallet=${exit.address}`)).positions.find((pos) => pos.chain_pool_id === 2);
    assert.equal(old.shares, '1');
    const refundIntent = (await request('controlled/refund-intents', { wallet: exit.address, chain_pool_id: 2 }, exit)).intent;
    const saved = (await request(`controlled/intents/${refundIntent.intent_id}/broadcast`, {}, exit)).intent;
    const walletBefore = await c.usdc.balanceOf(exit.address);
    const refundTx = await c.investor.sendTransaction({ to: c.pool.target, data: saved.calldata, nonce: saved.broadcast_nonce }); await refundTx.wait();
    assert.equal((await request(`controlled/intents/${saved.intent_id}/transaction`, { tx_hash: refundTx.hash }, exit)).intent.status, 'confirmed');
    assert.equal(await c.usdc.balanceOf(exit.address) - walletBefore, 800000n);
    observations.paths.push({ path: 'revoked_business_subject_exit_only', pool_id: '2', refunded: '800000', new_risk_blocked: true, private_materials_blocked: true });

  });

  it('reads at least 25 actual pools across pinned pages, directly finds pool 25, and exposes partial RPC failure', async () => {
    while (await c.pool.nextPoolId() <= 25n) await create();
    const ids = [], responses = []; let route = 'controlled/offerings';
    for (;;) {
      const beforeRpc = rpcRequests, start = performance.now(), result = await request(route); responses.push(result);
      observations.queries.push({ route, duration_ms: performance.now() - start, rpc_requests: rpcRequests - beforeRpc, read_calls: result.read_metrics.calls, failures: result.failures.length, block_number: result.snapshot.block_number });
      ids.push(...result.offerings.map((row) => row.pool_id)); if (!result.next_cursor) break;
      route = `controlled/offerings?from=${result.next_cursor}&block_number=${result.snapshot.block_number}&block_hash=${result.snapshot.block_hash}`;
    }
    assert.deepEqual(ids, Array.from({ length: 25 }, (_, i) => i + 1)); assert.equal(new Set(responses.map((row) => row.snapshot.block_hash)).size, 1);
    assert.equal((await request('controlled/offerings/25')).offerings[0].pool_id, 25);
    await assert.rejects(request('controlled/offerings/26'), { code: 'controlled_pool_not_found' });
    const snapshot = responses[0].snapshot;
    await create(); assert.equal((await request(`controlled/offerings?from=21&block_number=${snapshot.block_number}&block_hash=${snapshot.block_hash}`)).total_pools, 25);
    assert.equal((await request('controlled/offerings?from=21')).total_pools, 26);
    const actualPool = c.chain.pool;
    c.chain.pool = new Proxy(actualPool, { get(target, property) { if (property === 'offerings') return async (id, ...args) => { if (Number(id) === 12) throw new Error('Private provider failure'); return target.offerings(id, ...args); }; return Reflect.get(target, property); } });
    try {
      const partial = await request('controlled/offerings?from=11'); assert.equal(partial.complete, false); assert.deepEqual(partial.failures.map((row) => row.pool_id), [12]); assert.equal(partial.offerings.length, 9);
      const positions = await request(`controlled/positions?wallet=${sessions.investor.address}&from=11`);
      assert.ok(positions.snapshot); assert.ok(positions.read_metrics.calls > 0);
    } finally { c.chain.pool = actualPool; }
  });

  it('reads a page through the canonical Multicall3 with the same rows and far fewer reads, and ignores a lookalike', async () => {
    const page = async () => { await c.provider.send('evm_mine', []); return request('controlled/offerings?from=1&limit=10'); };
    const rows = (result) => result.offerings.map(({ block_number: _block, ...row }) => row);
    const before = await page();
    const { code } = JSON.parse(await fs.readFile(new URL('./helpers/multicall3-runtime.json', import.meta.url), 'utf8'));
    const { MULTICALL3_ADDRESS } = await import('../src/chain/multicall.js');
    await c.provider.send('hardhat_setCode', [MULTICALL3_ADDRESS, `${code.slice(0, -2)}${code.endsWith('00') ? '01' : '00'}`]);
    const lookalike = await page();
    assert.ok(lookalike.read_metrics.calls > 80, 'altered code is not trusted');
    await c.provider.send('hardhat_setCode', [MULTICALL3_ADDRESS, code]);
    const batched = await page();
    assert.deepEqual(rows(batched), rows(before));
    assert.equal(batched.complete, true);
    assert.ok(batched.read_metrics.calls < 12 && before.read_metrics.calls > 80, `${batched.read_metrics.calls} vs ${before.read_metrics.calls} reads`);
  });
});
