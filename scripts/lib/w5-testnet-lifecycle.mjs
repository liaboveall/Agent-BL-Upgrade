import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Contract, Signature, id, ZeroHash } from 'ethers';
import { RightsService } from '../../src/rights/service.js';
import { seal, unseal } from '../../src/rights/vault.js';
import { ISSUANCE_TYPES, VALUATION_TYPES, assetIdentity, rightsDomain, titleDomain, hashOfferingTerms } from '../../src/rights/typedData.js';
import { createRightsRoutes } from '../../src/app/rightsRoutes.js';
import { createControlledRoutes } from '../../src/app/controlledRoutes.js';
import { sendError } from '../../src/app/http.js';
import { writeJsonAtomic, readJson } from '../../src/lib/jsonStore.js';
import { sendRightsPlan } from '../../web/src/lib/rights.js';
import { IndependentPaymentVerifier, AUTHORIZATION_TYPES } from '../../src/x402/independentVerifier.js';
import { X402SettlementService, JsonReceiptStore } from '../../src/x402/settlement.js';
import { releaseSourceSnapshot } from './release-source.mjs';
import { listenOnUsablePort } from './listen.mjs';

const AAD = 'agentbl-w5-smoke-private-v1';
const safe = (value) => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? String(v) : v));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
export async function runTestnetLifecycle({ state, save, txSend, signers, provider, artifacts, directory, evidence, backupKey, keyDirectory }) {
  const appDirectory = path.resolve(directory, '../w5-app'), privateFile = path.join(directory, 'smoke-private.json');
  const rightsKey = (await fs.readFile(path.join(keyDirectory, 'rights-key.hex'), 'utf8')).trim();
  const env = { AGENTBL_RIGHTS_KEY: rightsKey, AGENTBL_ADMIN_TOKEN: randomBytes(32).toString('hex'), AGENTBL_RUNTIME_DIR: appDirectory };
  const stored = await readJson(privateFile), work = stored ? unseal(backupKey, stored, AAD) : { subjects: {}, materials: {}, plans: {}, scenarios: {} };
  const keep = () => writeJsonAtomic(privateFile, seal(backupKey, safe(work), AAD), { durable: true });
  const chain = await (await import('../../src/rights/chain.js')).loadRightsChain(path.resolve(directory, '../../..', 'public/rights-instance.json'));
  const service = new RightsService({ directory: path.join(appDirectory, 'rights'), env, chain });
  const rightsRoutes = createRightsRoutes({ env, service });
  const configuration = await readJson(path.resolve(directory, '../../..', 'public/rights-instance.json'));
  const capitalRoutes = createControlledRoutes({ env, getMode: () => 'live', chain, configuration });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (await rightsRoutes(req, res, url) || await capitalRoutes(req, res, url)) return;
      res.writeHead(404); res.end();
    } catch (error) { sendError(res, error, { logger: { error() {}, warn() {} } }); }
  });
  await listenOnUsablePort(server, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (method, route, body, token) => {
    const response = await fetch(`${base}/${route}`, { method, headers: { 'content-type': 'application/json',
      ...(token ? { 'x-rights-session': token } : { authorization: `Bearer ${env.AGENTBL_ADMIN_TOKEN}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(safe(body)) }), signal: AbortSignal.timeout(45000) });
    const result = await response.json(); ensure(response.ok, `Application ${route}: ${result.code ?? response.status}`); return result;
  };
  const login = async (actor, roles) => {
    let subject = work.subjects[actor];
    if (!subject) { subject = await request('POST', 'rights/subjects', { organization: 'W5_RESEARCH', wallet: signers[actor].address, roles }); work.subjects[actor] = subject; await keep(); }
    const challenge = await request('POST', 'rights/session-challenges', { subject_id: subject.subject_id });
    const session = await request('POST', 'rights/sessions', { challenge_id: challenge.challenge_id,
      signature: await signers[actor].signTypedData(challenge.domain, challenge.types, challenge.message) });
    return { actor, token: session.token, subject };
  };
  const call = (label, contract, method, args, actor) => txSend(`smoke:${label}`, signers[actor], { to: contract.target, data: contract.interface.encodeFunctionData(method, args) });
  const contract = (name) => new Contract(state.contracts[name], artifacts[name].abi, provider);
  const controller = contract('RightsController'), registry = contract('CommittedEBLRegistry'), pool = contract('RWAOfferingPoolV5'), usdc = contract('MockAuthorizationUSDC');
  try {
    ensure(Number(await controller.controlVersion()) === 2, 'Legacy v1 is exit-only; use an independently verified v2 candidate');
    const sessions = {};
    for (const [actor, roles] of [['issuer', ['issuer']], ['holder', ['holder']], ['investor', ['investor']], ['reviewer', ['reviewer']], ['governorC', ['reviewer']], ['operator', ['custodian']]]) sessions[actor] = await login(actor, roles);
    const executePlan = async (label, session, input) => {
      let plan;
      if (work.plans[label]) {
        plan = await request('GET', `rights/transaction-plans/${work.plans[label]}`, undefined, session.token);
        if (plan.status === 'confirmed') return plan;
        ensure(!plan.tx_hash, 'Saved rights transaction needs reconciliation before continuing');
      } else {
        plan = await request('POST', 'rights/transaction-plans', input, session.token); work.plans[label] = plan.plan_id; await keep();
      }
      const signer = signers[session.actor];
      return sendRightsPlan(plan, { session: { address: signer.address, signer: { provider, getAddress: async () => signer.address,
        sendTransaction: async (tx) => ({ hash: (await txSend(`smoke:plan:${label}`, signer, tx)).tx_hash }) } },
      attachTransaction: (planId, hash) => request('POST', `rights/transaction-plans/${planId}/transaction`, { tx_hash: hash }, session.token) });
    };
    const create = async (tag) => {
      let p = work.scenarios[tag];
      if (!p) {
        const time = (await provider.getBlock('latest')).timestamp, eblId = String(await registry.nextEblId());
        const material = await request('POST', 'rights/materials', { material: { scope: 'SIMULATED_TITLE_NOT_CARRIER_ISSUANCE', case: `W5-${tag}`, original_identity: `SYNTHETIC-${tag}-${registry.target}` },
          public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 1, terms_hash: id('provisional-w5-terms'), risk_flags: ['simulated_title', 'test_asset', 'capital_at_risk', 'unverified_external_rights'] } }, sessions.issuer.token);
        const issuance = { assetKey: assetIdentity('AGENTBL W5 SYNTHETIC ISSUER', `${tag}-${registry.target}`), documentHash: material.document_hash,
          issuerOrg: id('AGENTBL_W5_SYNTHETIC_ISSUER'), holder: signers.holder.address, revision: 1, previousHash: ZeroHash, nonce: String(BigInt(id(`issuance-${tag}`))), validUntil: String(time + 86400) };
        const terms = { eblId, assetKey: issuance.assetKey, documentHash: material.document_hash, settlementAsset: usdc.target, exporter: signers.holder.address,
          feeRecipient: signers.governorC.address, supply: '10', issuePrice: '800000', target: '1000000', minRaise: '8000000',
          maturity: String(time + 86400), subscribeUntil: String(time + (tag === 'refund' ? 360 : 3600)), disburseUntil: String(time + 7200), maxFee: '0',
          policyHash: id('W5_RESEARCH_TEST_ASSET_DISTRIBUTION_NO_REAL_COLLATERAL'), disclosureHash: id('W5_RESEARCH_SIMULATED_TITLE_DISCLOSURE'), nonce: String(BigInt(id(`terms-${tag}`))) };
        const termsHash = hashOfferingTerms(1439, controller.target, terms);
        const valuation = { termsHash, assetKey: terms.assetKey, settlementAsset: usdc.target, netValue: '20000000', coverageBps: 15000,
          valuedAt: String(time), validUntil: String(time + 7200), nonce: String(BigInt(id(`valuation-${tag}`))) };
        p = { material, issuance, terms, termsHash, valuation,
          sourceSignature: await signers.issuer.signTypedData(titleDomain(1439, registry.target), ISSUANCE_TYPES, issuance),
          valuationSignature: await signers.valuer.signTypedData(rightsDomain(1439, controller.target), VALUATION_TYPES, valuation) };
        work.scenarios[tag] = safe(p); p = work.scenarios[tag]; await keep();
      }
      await executePlan(`${tag}:register`, sessions.issuer, { operation: 'register_title', payload: { issuance: p.issuance, signature: p.sourceSignature } });
      await executePlan(`${tag}:pledge`, sessions.holder, { operation: 'pledge', payload: { ebl_id: p.terms.eblId }, terms_hash: p.termsHash, valid_until: p.terms.subscribeUntil });
      if (!work.materials[tag]) {
        await request('POST', `rights/materials/${p.material.material_id}/terms`, { terms_hash: p.termsHash }, sessions.issuer.token);
        for (const actor of ['reviewer', 'governorC']) await request('POST', `rights/materials/${p.material.material_id}/review`, { document_hash: p.material.document_hash, terms_hash: p.termsHash }, sessions[actor].token);
        await request('POST', `rights/materials/${p.material.material_id}/publish`, {}, sessions.issuer.token);
        const source = { provider: 'AGENTBL synthetic research issuer', version: 'w5-testnet-v1', level: 'synthetic', source_hash: id(`simulated-${tag}`), observed_at: new Date().toISOString() };
        const entry = await request('POST', 'rights/evidence', { material_id: p.material.material_id, kind: 'raw_material', source }, sessions.issuer.token);
        work.materials[tag] = { evidence_id: entry.evidence_id }; await keep();
      }
      const created = await executePlan(`${tag}:create`, sessions.issuer, { operation: 'create_offering', material_id: p.material.material_id,
        payload: { terms: p.terms, valuation: p.valuation, valuer: signers.valuer.address, signature: p.valuationSignature } });
      if (!p.poolId) {
        const receipt = await provider.getTransactionReceipt(created.tx_hash);
        const event = receipt.logs.map((log) => { try { return controller.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'TermsCommitted');
        ensure(event, 'Controlled offering event missing'); p.poolId = String(event.args.poolId); await keep();
      }
      const eligibilityExpiry = String(Number(p.valuation.valuedAt) + 7200), screeningExpiry = String(Number(p.valuation.valuedAt) + 7200);
      await call(`${tag}:eligibility`, controller, 'setEligibility', [signers.investor.address, id('W5_RESEARCH_INVESTOR'), id('SYNTHETIC_ELIGIBILITY_NOT_KYC'), eligibilityExpiry], 'compliance');
      await call(`${tag}:screening`, controller, 'refreshScreening', [screeningExpiry, id('SYNTHETIC_SCREENING_NOT_ENTERPRISE_COMPLIANCE')], 'compliance');
      await executePlan(`${tag}:accept`, sessions.investor, { operation: 'acknowledge_terms', pool_id: p.poolId, terms_hash: p.termsHash, quote_version: '1', valid_until: p.terms.subscribeUntil });
      return p;
    };
    const subscribe = async (tag, p, shares) => {
      const cost = String(BigInt(shares) * BigInt(p.terms.issuePrice));
      await call(`${tag}:mint-test-assets`, usdc, 'mint', [signers.investor.address, cost], 'governorA');
      await call(`${tag}:approve`, usdc, 'approve', [pool.target, cost], 'investor');
      if (!p.subscriptionIntent) {
        const time = (await provider.getBlock('latest')).timestamp;
        p.subscriptionIntent = (await request('POST', 'controlled/subscription-intents', { wallet: signers.investor.address, chain_pool_id: p.poolId, shares,
          max_unit_price: p.terms.issuePrice, expected_quote_version: '1', deadline: String(Math.min(time + 600, Number(p.terms.subscribeUntil))) })).intent;
        await keep();
      }
      if (p.subscriptionIntent.broadcast_nonce === undefined) { p.subscriptionIntent = (await request('POST', `controlled/intents/${p.subscriptionIntent.intent_id}/broadcast`, {})).intent; await keep(); }
      const sent = await txSend(`smoke:${tag}:subscribe`, signers.investor, { to: pool.target, data: p.subscriptionIntent.calldata });
      const result = await request('POST', `controlled/intents/${p.subscriptionIntent.intent_id}/transaction`, { tx_hash: sent.tx_hash });
      ensure(result.intent.status === 'confirmed', 'Subscription is not canonically reconciled'); return sent;
    };
    const normal = await create('normal'); await subscribe('normal', normal, '10');
    await executePlan('normal:disburse', sessions.operator, { operation: 'disburse', pool_id: normal.poolId, amount_atomic: '8000000', evidence_hash: id('W5_TEST_ASSET_DRAWDOWN') });
    await call('normal:mint-interest-test-assets', usdc, 'mint', [signers.holder.address, '2000000'], 'governorA');
    await call('normal:approve-repayment', usdc, 'approve', [pool.target, '10000000'], 'holder');
    for (const [n, amount] of ['4000000', '6000000'].entries()) {
      const repayment = await call(`normal:repay:${n}`, pool, 'repay', [normal.poolId, amount], 'holder');
      await call(`normal:record-payment:${n}`, controller, 'executeLifecycle', [pool.interface.encodeFunctionData(n === 0 ? 'recordImporterPayment' : 'recordAdditionalPayment', [normal.poolId, repayment.tx_hash, amount])], 'attestor');
    }
    await call('normal:simulated-arrival', controller, 'executeLifecycle', [pool.interface.encodeFunctionData('recordCargoArrival', [normal.poolId, id('SIMULATED_TEST_CARGO_ARRIVAL_NOT_REAL_LOGISTICS')])], 'attestor');
    await call('normal:settle', controller, 'executeLifecycle', [pool.interface.encodeFunctionData('settle', [normal.poolId, '10000000'])], 'operator');
    if (!normal.claimIntent) { normal.claimIntent = (await request('POST', 'controlled/claim-intents', { wallet: signers.investor.address, chain_pool_id: normal.poolId })).intent; await keep(); }
    if (normal.claimIntent.broadcast_nonce === undefined) { normal.claimIntent = (await request('POST', `controlled/intents/${normal.claimIntent.intent_id}/broadcast`, {})).intent; await keep(); }
    const claim = await txSend('smoke:normal:claim', signers.investor, { to: pool.target, data: normal.claimIntent.calldata });
    ensure((await request('POST', `controlled/intents/${normal.claimIntent.intent_id}/transaction`, { tx_hash: claim.tx_hash })).intent.status === 'confirmed', 'Investor claim not reconciled');
    const failed = await create('refund'); await subscribe('refund', failed, '3');
    while ((await provider.getBlock('latest')).timestamp <= Number(failed.terms.subscribeUntil)) {
      if (!failed.waitAnnounced) { console.log(`Refund test observes the actual chain cutoff ${new Date(Number(failed.terms.subscribeUntil) * 1000).toISOString()}`); failed.waitAnnounced = true; await keep(); }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!failed.refundIntent) { failed.refundIntent = (await request('POST', 'controlled/refund-intents', { wallet: signers.investor.address, chain_pool_id: failed.poolId })).intent; await keep(); }
    if (failed.refundIntent.broadcast_nonce === undefined) { failed.refundIntent = (await request('POST', `controlled/intents/${failed.refundIntent.intent_id}/broadcast`, {})).intent; await keep(); }
    const refund = await txSend('smoke:refund:return-principal', signers.investor, { to: pool.target, data: failed.refundIntent.calldata });
    ensure((await request('POST', `controlled/intents/${failed.refundIntent.intent_id}/transaction`, { tx_hash: refund.tx_hash })).intent.status === 'confirmed', 'Refund not reconciled');
    // A real direct ERC-3009 payment on the isolated test asset. The facilitator adapter
    // is a local research executor; no public facilitator support or real USD is claimed.
    if (!work.payment) {
      const time = (await provider.getBlock('latest')).timestamp;
      const auth = { from: signers.investor.address, to: signers.governorC.address, value: '1000', validAfter: String(time - 1), validBefore: String(time + 3600), nonce: id(`W5_REPORT_${controller.target}`) };
      const signature = await signers.investor.signTypedData({ name: 'USDC', version: '2', chainId: 1439, verifyingContract: usdc.target }, AUTHORIZATION_TYPES, auth);
      const requirement = { scheme: 'exact', network: 'eip155:1439', asset: usdc.target, payTo: signers.governorC.address, amount: '1000', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } };
      work.payment = { resource: 'https://agentbl.research/w5/paid-acceptance', paymentRequirements: requirement,
        paymentPayload: { x402Version: 2, accepted: requirement, payload: { signature, authorization: auth } } }; await keep();
    }
    const verifier = new IndependentPaymentVerifier({ provider, confirmations: 3 }); let settlementCalls = 0;
    const adapter = { verify: async () => ({ response: { isValid: true }, attempts: 1 }), settle: async () => {
      settlementCalls++; const auth = work.payment.paymentPayload.payload.authorization, signature = Signature.from(work.payment.paymentPayload.payload.signature);
      const payment = await call('report:erc3009', usdc, 'transferWithAuthorization', [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature.v, signature.r, signature.s], 'attestor');
      return { response: { success: true, transaction: payment.tx_hash, network: 'eip155:1439', payer: auth.from }, attempts: 1 };
    } };
    const store = new JsonReceiptStore({ filePath: path.join(appDirectory, 'w5-paid-report-receipts.json') });
    const paymentService = new X402SettlementService({ mode: 'live', store, verifier, adapter, deliveryKey: Buffer.from(rightsKey, 'hex') });
    const payment = await paymentService.process(work.payment);
    await paymentService.deliver(payment.record.payment_id, async () => ({ kind: 'research-testnet-acceptance', scope: 'SIMULATED_TITLES_TEST_ASSET', normal_pool: normal.poolId, refund_pool: failed.poolId }));
    const recovered = await paymentService.process(work.payment);
    ensure(recovered.replayed && settlementCalls <= 1, 'Paid recovery must not settle again');
    const positions = await request('GET', `controlled/positions?wallet=${signers.investor.address}`);
    const normalPosition = positions.positions.find((pos) => String(pos.chain_pool_id) === normal.poolId), refundPosition = positions.positions.find((pos) => String(pos.chain_pool_id) === failed.poolId);
    ensure(normalPosition?.reconciled && normalPosition.claimed_atomic === '10000000' && refundPosition?.reconciled && refundPosition.refunded_atomic === '2400000', 'Final capital ledger differs from actual claims/refunds');
    ensure(await pool.escrowed(normal.poolId, usdc.target) === 0n && await pool.escrowed(failed.poolId, usdc.target) === 0n, 'Residual escrow obligation');
    for (const [tag, item] of Object.entries(work.materials)) {
      const pack = await request('GET', `rights/evidence/${item.evidence_id}/download`, undefined, sessions.issuer.token);
      ensure(pack.verification.passed, 'Authorized evidence package did not verify');
      work.materials[tag].package_hash = pack.package_hash; await keep();
    }
    const source = await releaseSourceSnapshot();
    state.scenario = { schema: 'agentbl-w5-testnet-acceptance-v1', passed: true, generated_at: new Date().toISOString(), source_sha256: source.source_sha256,
      scope: 'Actual Injective testnet token movement; synthetic titles, eligibility, valuation and arrival; local research facilitator adapter',
      normal: { pool_id: normal.poolId, paid_atomic: '8000000', disbursed_atomic: '8000000', repaid_atomic: '10000000', claimed_atomic: normalPosition.claimed_atomic, claim_tx: claim.tx_hash },
      failed_raise: { pool_id: failed.poolId, paid_atomic: '2400000', refunded_atomic: refundPosition.refunded_atomic, refund_tx: refund.tx_hash },
      paid_report: { payment_id: payment.record.payment_id, transaction: payment.record.transaction, independent_verification: payment.record.independent_verification, replayed: recovered.replayed, settlement_calls_this_run: settlementCalls },
      investor_positions: positions.positions, real_business: false, human_wallet_acceptance: false };
    await save(); await writeJsonAtomic(path.join(evidence, 'financing-acceptance.json'), state.scenario, { durable: true });
    await writeJsonAtomic(path.join(appDirectory, 'runtime-initialized.json'), { schema: 'agentbl-initialized-runtime-v1' }, { durable: true });
    console.log('Actual testnet financing, refund, independent ERC-3009 payment and paid recovery: PASS');
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await capitalRoutes.close(); await chain.provider.destroy();
  }
}
