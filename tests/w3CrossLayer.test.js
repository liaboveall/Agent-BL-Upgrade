import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { runHardhatNode, stopHardhatNode } from './helpers/ledgerTestHarness.js';
import { deployRightsRpc } from './helpers/rightsHarness.js';
import { listen, requestJson } from './helpers/http.js';
import { RightsService } from '../src/rights/service.js';
import { createRightsRoutes } from '../src/app/rightsRoutes.js';
import { createControlledRoutes } from '../src/app/controlledRoutes.js';
import { sendError } from '../src/app/http.js';
import { sendRightsPlan } from '../web/src/lib/rights.js';
import { loadRightsChain } from '../src/rights/chain.js';
import { prepareRightsCandidate, writeRightsCandidate } from '../scripts/prepare-rights-candidate.mjs';
import { Contract, ContractFactory, TypedDataEncoder } from 'ethers';
import { titleDomain, rightsDomain, ISSUANCE_TYPES, PLEDGE_TYPES, TERMS_TYPES, VALUATION_TYPES } from '../src/rights/typedData.js';

async function backend(c, t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'w3-cross-')), env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex'), AGENTBL_ADMIN_TOKEN: 'synthetic-cross-layer-admin-w3' };
  const service = new RightsService({ directory, env, chain: c.chain });
  const route = createRightsRoutes({ service, env });
  const controlled = createControlledRoutes({ env: { ...env, AGENTBL_RUNTIME_DIR: directory }, chain: c.chain, disclosures: service, getMode: () => 'live',
    configuration: { chain_id: Number(c.chainId), deployment_block: 0, contracts: { RWAOfferingPoolV5: await c.pool.getAddress(), ControlledRWAToken: await c.token.getAddress() } } });
  const app = await listen(http.createServer((req, res) => (async () => {
    const url = new URL(req.url, 'http://local');
    if (!await route(req, res, url)) await controlled(req, res, url);
  })().catch((error) => sendError(res, error, { logger: { warn() {}, error() {} } }))));
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const post = async (url, body, token, admin = false) => {
    const result = await requestJson(app.base, 'POST', `/api/rights/${url}`, body, { ...(token ? { 'x-rights-session': token } : {}), ...(admin ? { Authorization: `Bearer ${env.AGENTBL_ADMIN_TOKEN}` } : {}) });
    if (result.status !== 200) throw Object.assign(new Error(result.data?.error), { status: result.status, code: result.data?.code });
    return result.data;
  };
  const login = async (wallet, roles, organization = 'w3-demo-carrier') => {
    const subject = await post('subjects', { organization, wallet: wallet.address, roles }, null, true);
    const challenge = await post('session-challenges', { subject_id: subject.subject_id }, null, true);
    const session = await post('sessions', { challenge_id: challenge.challenge_id, signature: await wallet.signTypedData(challenge.domain, challenge.types, challenge.message) });
    return { ...session, wallet };
  };
  const plan = (session, body) => post('transaction-plans', body, session.token);
  const execute = (session, prepared) => sendRightsPlan(prepared, { session: { signer: session.wallet, address: session.wallet.address },
    attachTransaction: (planId, txHash) => post(`transaction-plans/${planId}/transaction`, { tx_hash: txHash }, session.token) });
  return { directory, env, service, app, post, login, plan, execute };
}

describe('W3 actual EVM + business-session HTTP + wallet plans', { skip: process.env.AGENTBL_W3_INTEGRATION !== '1' }, () => {
  let node;
  before(async () => { node = await runHardhatNode(); });
  after(async () => { await stopHardhatNode(node); });
  it('walks trusted issuance, private disclosure approval, holder pledge, investor terms, cash flow and claim', async (t) => {
    const c = await deployRightsRpc(node, t), app = await backend(c, t);
    const issuer = await app.login(c.issuer, ['issuer']), holder = await app.login(c.holder, ['holder']), investor = await app.login(c.investor, ['investor']);
    const reviewerA = await app.login(c.reviewer, ['reviewer']), reviewerB = await app.login(c.memberC, ['reviewer']), operator = await app.login(c.operator, ['custodian']);
    // The private document commitment is fixed before the on-chain issuance.
    const provisional = await c.issuance();
    const eblId = await c.registry.nextEblId(), proposed = await c.offering(eblId, provisional.issuance);
    const material = await app.post('materials', { material: { exporter: 'private simulated exporter', document: 'W3 confidential bill' },
      public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 3, terms_hash: proposed.hash, risk_flags: ['simulated_title', 'test_asset'] } }, issuer.token);
    // Rebind the full terms and issuance to the actual salted material commitment.
    const issue = await c.issuance(material.document_hash), offer = await c.offering(eblId, issue.issuance);
    const recordId = material.material_id;
    const { schema: _schema, policy: _policy, ...readableInput } = offer.pack.document;
    await app.post(`materials/${recordId}/financing-disclosure`, readableInput, issuer.token);
    const registerPlan = await app.plan(issuer, { operation: 'register_title', payload: issue });
    const receipt = await app.execute(issuer, registerPlan); assert.equal(receipt.status, 'confirmed');
    assert.equal(await c.registry.holderOf(eblId), c.holder.address);
    const pledgePlan = await app.plan(holder, { operation: 'pledge', payload: { ebl_id: String(eblId) }, terms_hash: offer.hash, valid_until: offer.terms.subscribeUntil });
    await app.execute(holder, pledgePlan);
    await assert.rejects(app.plan(issuer, { operation: 'create_offering', material_id: recordId, payload: offer }), { code: 'rights_approved_disclosure_required' });
    // The source record can bind final terms through an audited, approval-resetting amendment.
    await app.post(`materials/${recordId}/terms`, { terms_hash: offer.hash }, issuer.token);
    for (const reviewer of [reviewerA, reviewerB]) await app.post(`materials/${recordId}/review`, { document_hash: material.document_hash, terms_hash: offer.hash }, reviewer.token);
    const publication = await app.post(`materials/${recordId}/publish`, {}, issuer.token);
    assert.equal(JSON.stringify(publication).includes('confidential'), false);
    const creation = await app.plan(issuer, { operation: 'create_offering', material_id: recordId, payload: offer });
    await app.execute(issuer, creation);
    const poolId = String(await c.pool.nextPoolId() - 1n);
    await assert.rejects(c.pool.connect(c.investor).subscribe(poolId, 10));
    const time = await c.now();
    await c.send(c.controller.connect(c.compliance).setEligibility(c.investor.address, c.fresh(), c.fresh(), time + 100000n));
    await c.send(c.controller.connect(c.compliance).refreshScreening(time + 80000n, c.fresh()));
    const read = await requestJson(app.app.base, 'GET', `/api/controlled/offerings/${poolId}/terms?download=1`);
    assert.equal(read.status, 200); assert.equal(read.data.terms_hash, offer.hash); assert.equal(read.data.disclosure_hash, offer.terms.disclosureHash);
    assert.equal(read.data.terms.issuePrice, offer.terms.issuePrice);
    await assert.rejects(app.plan(investor, { operation: 'acknowledge_terms', pool_id: poolId, terms_hash: offer.hash, quote_version: '1', valid_until: offer.terms.subscribeUntil }), { code: 'financing_review_required' });
    const acceptance = await app.plan(investor, { operation: 'acknowledge_terms', pool_id: poolId, terms_hash: offer.hash, quote_version: '1', valid_until: offer.terms.subscribeUntil, reviewed_disclosure_hash: offer.terms.disclosureHash });
    await app.execute(investor, acceptance);
    await c.send(c.usdc.mint(c.investor.address, 8000000n)); await c.send(c.usdc.connect(c.investor).approve(await c.pool.getAddress(), 8000000n));
    const subscriptionBody = { wallet: c.investor.address, chain_pool_id: poolId, shares: '10', max_unit_price: '800000', expected_quote_version: '1', deadline: String(await c.now() + 600n) };
    const missingReview = await requestJson(app.app.base, 'POST', '/api/controlled/subscription-intents', subscriptionBody, { 'x-rights-session': investor.token });
    assert.equal(missingReview.status, 409); assert.equal(missingReview.data.code, 'financing_review_required');
    const prepared = await requestJson(app.app.base, 'POST', '/api/controlled/subscription-intents', { ...subscriptionBody, reviewed_disclosure_hash: offer.terms.disclosureHash }, { 'x-rights-session': investor.token });
    assert.equal(prepared.status, 200);
    const checkpoint = await requestJson(app.app.base, 'POST', `/api/controlled/intents/${prepared.data.intent.intent_id}/broadcast`, {}, { 'x-rights-session': investor.token });
    assert.equal(checkpoint.status, 200);
    const tx = await c.investor.sendTransaction({ to: c.pool.target, data: checkpoint.data.intent.calldata, nonce: checkpoint.data.intent.broadcast_nonce }); await tx.wait();
    const confirmed = await requestJson(app.app.base, 'POST', `/api/controlled/intents/${prepared.data.intent.intent_id}/transaction`, { tx_hash: tx.hash }, { 'x-rights-session': investor.token });
    assert.equal(confirmed.data.intent.status, 'confirmed');
    const draw = await app.plan(operator, { operation: 'disburse', pool_id: poolId, amount_atomic: '8000000', evidence_hash: c.fresh() });
    await app.execute(operator, draw); assert.equal(await c.usdc.balanceOf(c.holder.address), 8000000n);
    await c.send(c.usdc.mint(c.holder.address, 2000000n)); await c.send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), 10000000n));
    await c.send(c.pool.connect(c.holder).repay(poolId, 10000000n));
    await c.lifecycle('recordImporterPayment', [poolId, c.fresh(), 10000000n]); await c.lifecycle('recordCargoArrival', [poolId, c.fresh()]); await c.lifecycle('settle', [poolId, 10000000n]);
    await c.send(c.controller.connect(c.guardian).setIntakeStopped(true, c.fresh()));
    await c.send(c.pool.connect(c.investor).claim(poolId));
    assert.equal(await c.usdc.balanceOf(c.investor.address), 10000000n);
    // Revoking a signing role keeps the signed terms readable as history; new operations on them are refused.
    await c.govern(c.controller, 'setRole', [await c.controller.VALUER(), c.valuer.address, false]);
    const history = await requestJson(app.app.base, 'GET', `/api/controlled/offerings/${poolId}/terms`);
    assert.equal(history.status, 200); assert.equal(history.data.terms_hash, offer.hash);
    assert.equal(history.data.current.ok, false); assert.ok(history.data.current.reasons.includes('valuer_revoked'));
    const refused = await requestJson(app.app.base, 'POST', '/api/controlled/subscription-intents', { ...subscriptionBody, reviewed_disclosure_hash: offer.terms.disclosureHash }, { 'x-rights-session': investor.token });
    assert.equal(refused.status, 409); assert.equal(refused.data.code, 'financing_terms_changed');
    const chainTx = await c.provider.getTransaction(receipt.tx_hash);
    for (const secret of ['W3 confidential bill', 'private simulated exporter']) assert.equal(chainTx.data.includes(Buffer.from(secret).toString('hex')), false);
  });
  it('rejects wrong-wallet and wrong-calldata receipts and reconciles saved broadcast without sending again', async (t) => {
    const c = await deployRightsRpc(node, t), app = await backend(c, t), issuer = await app.login(c.issuer, ['issuer']);
    const issue = await c.issuance(), plan = await app.plan(issuer, { operation: 'register_title', payload: issue });
    await assert.rejects(sendRightsPlan(plan, { session: { signer: c.outsider, address: c.outsider.address } }), { code: 'RIGHTS_PLAN_MISMATCH' });
    const count = await c.provider.getTransactionCount(c.issuer.address);
    // Crash after broadcast is simulated by omitting attach; recover read-only using the saved exact plan.
    const tx = await c.issuer.sendTransaction({ to: plan.to, data: plan.calldata, nonce: plan.nonce }); await tx.wait();
    const unrelated = await c.send(c.outsider.sendTransaction({ to: c.holder.address, value: 0n }));
    await assert.rejects(app.post(`transaction-plans/${plan.plan_id}/transaction`, { tx_hash: unrelated.hash }, issuer.token), { code: 'rights_transaction_mismatch' });
    const restored = new RightsService({ directory: app.directory, env: app.env, chain: c.chain });
    const result = await restored.getPlan(issuer.token, plan.plan_id);
    assert.equal(result.status, 'confirmed'); assert.equal((await restored.getPlan(issuer.token, plan.plan_id)).tx_hash, tx.hash);
    assert.equal(await c.provider.getTransactionCount(c.issuer.address), count + 1);
    await assert.rejects(app.execute(issuer, result), { code: 'RIGHTS_PLAN_MISMATCH' });
  });
  it('verifies manifest artifacts, refuses code/network tampering, and preserves receipt reorg failures', async (t) => {
    const c = await deployRightsRpc(node, t), app = await backend(c, t), issuer = await app.login(c.issuer, ['issuer']);
    const contracts = Object.fromEntries(await Promise.all(['RightsGovernance', 'CommittedEBLRegistry', 'RightsController', 'ControlledRWAToken', 'RWAOfferingPoolV5'].map(async (name) => [name,
      await ({ RightsGovernance: c.governance, CommittedEBLRegistry: c.registry, RightsController: c.controller, ControlledRWAToken: c.token, RWAOfferingPoolV5: c.pool })[name].getAddress()])));
    const file = path.join(app.directory, 'instance.json');
    await fs.writeFile(file, JSON.stringify({ schema: 'agentbl-rights-instance-v1', scope: 'research_test_assets_only', rpc_url: node.url, chain_id: String(c.chainId), contracts }));
    const loaded = await loadRightsChain(file); t.after(() => loaded.provider.destroy());
    assert.equal((await loaded.verify()).control_version, 3);
    const expected = c.chain.chainId; c.chain.chainId = 1;
    await assert.rejects(c.chain.verify(), { code: 'rights_network_mismatch' }); c.chain.chainId = expected;
    const issue = await c.issuance(), plan = await app.plan(issuer, { operation: 'register_title', payload: issue });
    const snapshot = await c.provider.send('evm_snapshot', []);
    const sent = await app.execute(issuer, plan); assert.equal(sent.status, 'confirmed');
    await c.provider.send('evm_revert', [snapshot]); await c.provider.send('evm_mine', []);
    const afterReorg = await app.service.getPlan(issuer.token, plan.plan_id);
    assert.equal(afterReorg.status, 'reconciling'); assert.equal(afterReorg.tx_hash, sent.tx_hash);
    assert.equal(afterReorg.receipt_history[0].block_hash, sent.block_hash);
    // A getter-compatible configuration is insufficient: every runtime must match this build.
    const governanceCode = await c.provider.getCode(await c.governance.getAddress());
    const altered = governanceCode.slice(0, -2) + (governanceCode.endsWith('00') ? '01' : '00');
    await c.provider.send('hardhat_setCode', [await c.governance.getAddress(), altered]);
    await assert.rejects(loaded.verify(), { code: 'rights_bytecode_mismatch' });
  });
  it('prepares and executes an isolated unsigned current-version deployment while sharing historical identity reservations', async (t) => {
    const c = await deployRightsRpc(node, t), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'n1-candidate-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const issue = await c.issuance(); await c.send(c.registry.registerTitle(issue.issuance, issue.signature));
    const input = { instance_id: 'n1-local-candidate', chain_id: 31337, governance: await c.governance.getAddress(), hub: await c.hub.getAddress(),
      deployer: c.memberA.address, nonce: await c.provider.getTransactionCount(c.memberA.address, 'pending') };
    const prepared = await prepareRightsCandidate(input);
    const written = await writeRightsCandidate(input, directory);
    assert.equal(written.broadcast, false);
    await assert.rejects(writeRightsCandidate(input, directory), { code: 'EEXIST' });
    for (const request of prepared.transactions) {
      const { expected_address: address, label: _label, ...transaction } = request;
      const receipt = await c.send(c.memberA.sendTransaction(transaction));
      if (address) assert.equal(receipt.contractAddress.toLowerCase(), address.toLowerCase());
    }
    const contract = (name) => new Contract(prepared.contracts[name], prepared.artifacts[name].abi, c.memberA);
    const registry = contract('CommittedEBLRegistry'), controller = contract('RightsController'), pool = contract('RWAOfferingPoolV5');
    await c.govern(c.hub, 'setRegistry', [registry.target, true]); await c.govern(registry, 'bindController', [controller.target]);
    await c.govern(registry, 'setIssuer', [issue.issuance.issuerOrg, c.issuer.address]);
    const duplicate = { ...issue.issuance, nonce: '9999', validUntil: String(await c.now() + 10000n) };
    await assert.rejects(registry.registerTitle(duplicate, await c.issuer.signTypedData(titleDomain(c.chainId, registry.target), ISSUANCE_TYPES, duplicate)), /asset already reserved/u);
    assert.equal(await pool.owner(), controller.target); assert.equal(await controller.intakeStopped(), true);
    const file = path.join(directory, 'instance.json');
    await fs.writeFile(file, JSON.stringify({ schema: 'agentbl-rights-instance-v1', scope: 'research_test_assets_only', control_version: 3,
      rpc_url: node.url, chain_id: 31337, contracts: prepared.contracts }));
    const loaded = await loadRightsChain(file); t.after(() => loaded.provider.destroy());
    assert.equal(prepared.control_version, 3); assert.equal(prepared.signature_domain.version, '3');
    assert.equal((await loaded.verify()).control_version, 3);
    assert.equal((await loaded.verify()).exit_only, false);
    // An old instance's exact calldata/nonce journal cannot name the new pool.
    assert.notEqual(prepared.runtime_namespace, `controlled-capital-${String(c.pool.target).toLowerCase()}`);
    await assert.rejects(prepareRightsCandidate({ ...input, chain_id: 1 }));
  });
  it('loads frozen v2 code after recompilation, keeps its original rules, closes new risk and preserves exits', async (t) => {
    const frozen = JSON.parse(await fs.readFile('scripts/config/rights-v2-artifacts.json', 'utf8')).contracts;
    const c = await deployRightsRpc(node, t), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n1-legacy-v2-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const deploy = async (name, args) => (await new ContractFactory(frozen[name].abi, frozen[name].bytecode, c.memberA).deploy(...args)).waitForDeployment();
    const registry = await deploy('CommittedEBLRegistry', [c.governance.target, c.hub.target]), token = await deploy('ControlledRWAToken', []);
    const pool = await deploy('RWAOfferingPoolV5', [registry.target, token.target]); await c.send(token.bindPool(pool.target));
    const controller = await deploy('RightsController', [c.governance.target, registry.target, token.target, pool.target]);
    await c.send(pool.transferOwnership(controller.target)); await c.send(controller.activate());
    await c.govern(c.hub, 'setRegistry', [registry.target, true]); await c.govern(registry, 'bindController', [controller.target]);
    const issue = await c.issuance(); await c.govern(registry, 'setIssuer', [issue.issuance.issuerOrg, c.issuer.address]);
    for (const [role, wallet] of [['ISSUER', c.issuer], ['VALUER', c.valuer], ['COMPLIANCE', c.compliance]]) await c.govern(controller, 'setRole', [await controller[role](), wallet.address, true]);
    await c.govern(controller, 'setTestAsset', [c.usdc.target, true]); await c.govern(controller, 'setIntakeStopped', [false, c.fresh()]);
    issue.issuance.validUntil = String(await c.now() + 100000n);
    await c.send(registry.registerTitle(issue.issuance, await c.issuer.signTypedData(titleDomain(c.chainId, registry.target), ISSUANCE_TYPES, issue.issuance)));
    const { terms, valuation: current } = await c.offering(1, issue.issuance), oldDomain = rightsDomain(c.chainId, controller.target, 2);
    const hash = TypedDataEncoder.hash(oldDomain, TERMS_TYPES, terms), valuation = { ...current, termsHash: hash };
    const pledge = { eblId: 1, pool: pool.target, termsHash: hash, nonce: await registry.holderNonce(1), validUntil: terms.subscribeUntil };
    await c.send(registry.pledge(1, pool.target, hash, terms.subscribeUntil, await c.holder.signTypedData(titleDomain(c.chainId, registry.target), PLEDGE_TYPES, pledge)));
    await c.send(controller.connect(c.issuer).createControlledOffering(terms, valuation, c.valuer.address, await c.valuer.signTypedData(oldDomain, VALUATION_TYPES, valuation)));
    await c.send(controller.connect(c.compliance).setEligibility(c.investor.address, c.fresh(), c.fresh(), await c.now() + 100000n));
    await c.send(controller.connect(c.compliance).refreshScreening(await c.now() + 80000n, c.fresh()));
    await c.send(controller.connect(c.investor).acknowledgeTerms(1, hash, 1, terms.subscribeUntil));
    await c.send(c.usdc.mint(c.investor.address, 800000n)); await c.send(c.usdc.connect(c.investor).approve(pool.target, 800000n));
    await c.send(pool.connect(c.investor).subscribe(1, 1));
    const file = path.join(dir, 'v2.json');
    await fs.writeFile(file, JSON.stringify({ schema: 'agentbl-rights-instance-v1', scope: 'research_test_assets_only', control_version: 2,
      rpc_url: node.url, chain_id: 31337, contracts: { RightsGovernance: c.governance.target, AssetIdentityHub: c.hub.target,
        CommittedEBLRegistry: registry.target, RightsController: controller.target, ControlledRWAToken: token.target, RWAOfferingPoolV5: pool.target } }));
    const legacy = await loadRightsChain(file); t.after(() => legacy.provider.destroy());
    assert.deepEqual([(await legacy.verify()).control_version, (await legacy.verify()).exit_only], [2, true]);
    await assert.rejects(legacy.prepare({ wallet: c.issuer.address, roles: ['issuer'] }, { operation: 'register_title' }), { code: 'rights_legacy_exit_only' });
    await assert.rejects(legacy.prepare({ wallet: c.investor.address, roles: ['investor'] }, { operation: 'acknowledge_terms', pool_id: '1' }), { code: 'rights_legacy_exit_only' });
    // Exits pass the legacy filter and reach the chain preflight, which still applies the old instance's rules.
    await assert.rejects(legacy.prepare({ wallet: c.investor.address, roles: ['investor'] }, { operation: 'start_exit', pool_id: '1' }), { code: 'rights_preflight_failed' });
    // Source changes do not repair a deployed instance: frozen v2 still drops the title when its issuer key rotates.
    await c.govern(registry, 'setIssuer', [issue.issuance.issuerOrg, c.outsider.address]);
    assert.equal(await registry.isActive(1), false);
    await c.advance(BigInt(terms.subscribeUntil) + 1n);
    await c.send(pool.connect(c.investor).refundInvestor(1, c.investor.address));
    assert.equal(await pool.escrowed(1, c.usdc.target), 0n); assert.equal(await token.balanceOf(1, c.investor.address), 0n);
  });
  it('loads frozen v1 code after recompilation, closes its risk entry, and preserves funded wallet exits', async (t) => {
    const frozen = JSON.parse(await fs.readFile('scripts/config/rights-v1-artifacts.json', 'utf8')).contracts;
    const c = await deployRightsRpc(node, t), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n1-legacy-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const deploy = async (name, args) => (await new ContractFactory(frozen[name].abi, frozen[name].bytecode, c.memberA).deploy(...args)).waitForDeployment();
    const registry = await deploy('CommittedEBLRegistry', [c.governance.target, c.hub.target]);
    const controller = await deploy('RightsController', [c.governance.target, registry.target]); await c.send(controller.activate());
    const pool = new Contract(await controller.capitalPool(), frozen.RWAOfferingPoolV5.abi, c.memberA);
    const token = new Contract(await controller.token(), frozen.ControlledRWAToken.abi, c.memberA);
    await c.govern(c.hub, 'setRegistry', [registry.target, true]); await c.govern(registry, 'bindController', [controller.target]);
    const issue = await c.issuance(); await c.govern(registry, 'setIssuer', [issue.issuance.issuerOrg, c.issuer.address]);
    for (const [role, wallet] of [['ISSUER', c.issuer], ['VALUER', c.valuer], ['COMPLIANCE', c.compliance]]) await c.govern(controller, 'setRole', [await controller[role](), wallet.address, true]);
    await c.govern(controller, 'setTestAsset', [c.usdc.target, true]); await c.govern(controller, 'setIntakeStopped', [false, c.fresh()]);
    issue.issuance.validUntil = String(await c.now() + 100000n);
    await c.send(registry.registerTitle(issue.issuance, await c.issuer.signTypedData(titleDomain(c.chainId, registry.target), ISSUANCE_TYPES, issue.issuance)));
    const current = await c.offering(1, issue.issuance), { disburseUntil: _drawDeadline, ...terms } = current.terms;
    const oldDomain = { name: 'AgentBL Rights', version: '1', chainId: c.chainId, verifyingContract: controller.target };
    const oldTypes = { OfferingTerms: TERMS_TYPES.OfferingTerms.filter((field) => field.name !== 'disburseUntil') };
    const hash = TypedDataEncoder.hash(oldDomain, oldTypes, terms);
    const valuation = { ...current.valuation, termsHash: hash };
    const pledge = { eblId: 1, pool: pool.target, termsHash: hash, nonce: await registry.holderNonce(1), validUntil: terms.subscribeUntil };
    await c.send(registry.pledge(1, pool.target, hash, terms.subscribeUntil, await c.holder.signTypedData(titleDomain(c.chainId, registry.target), PLEDGE_TYPES, pledge)));
    await c.send(controller.connect(c.issuer).createControlledOffering(terms, valuation, c.valuer.address, await c.valuer.signTypedData(oldDomain, VALUATION_TYPES, valuation)));
    await c.send(controller.connect(c.compliance).setEligibility(c.investor.address, c.fresh(), c.fresh(), await c.now() + 100000n));
    await c.send(controller.connect(c.compliance).refreshScreening(await c.now() + 80000n, c.fresh()));
    await c.send(controller.connect(c.investor).acknowledgeTerms(1, hash, 1, terms.subscribeUntil));
    await c.send(c.usdc.mint(c.investor.address, 800000n)); await c.send(c.usdc.connect(c.investor).approve(pool.target, 800000n));
    await c.send(pool.connect(c.investor).subscribe(1, 1));
    const file = path.join(dir, 'v1.json');
    await fs.writeFile(file, JSON.stringify({ schema: 'agentbl-rights-instance-v1', scope: 'research_test_assets_only', control_version: 1,
      rpc_url: node.url, chain_id: 31337, contracts: { RightsGovernance: c.governance.target, AssetIdentityHub: c.hub.target,
        CommittedEBLRegistry: registry.target, RightsController: controller.target, ControlledRWAToken: token.target, RWAOfferingPoolV5: pool.target } }));
    const legacy = await loadRightsChain(file); t.after(() => legacy.provider.destroy());
    assert.equal((await legacy.verify()).exit_only, true);
    await assert.rejects(legacy.prepare({ wallet: c.issuer.address, roles: ['issuer'] }, { operation: 'register_title' }), { code: 'rights_legacy_exit_only' });
    await c.advance(BigInt(terms.subscribeUntil) + 1n);
    await c.send(pool.connect(c.investor).refundInvestor(1, c.investor.address));
    assert.equal(await pool.escrowed(1, c.usdc.target), 0n); assert.equal(await token.balanceOf(1, c.investor.address), 0n);
  });
});
