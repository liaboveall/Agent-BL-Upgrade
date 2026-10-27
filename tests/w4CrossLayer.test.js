import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ContractFactory, JsonRpcProvider, Wallet, Signature, id } from 'ethers';
import { encodePaymentSignatureHeader } from '@injectivelabs/x402/client';
import { IndependentPaymentVerifier, AUTHORIZATION_TYPES } from '../src/x402/independentVerifier.js';
import { X402SettlementService, JsonReceiptStore, paymentIdFor } from '../src/x402/settlement.js';
import { createLiveGateway } from '../src/x402/liveGateway.js';
import { runHardhatNode, stopHardhatNode } from './helpers/ledgerTestHarness.js';
import { listen, requestJson } from './helpers/http.js';
import { randomBytes } from 'node:crypto';
import { DecisionEvidenceArchive } from '../src/evidence/archive.js';
import { DecisionAnchoring } from '../src/agent/runtime/anchoring.js';
import { createAnchorChainAdapter } from '../src/agent/runtime/anchorChain.js';
import { createAgentVersion } from '../src/agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { verifyEvidencePackage } from '../src/evidence/schema.js';

test('W4 actual ERC-3009 EVM + HTTP: exact receipt, wrong terms, failed delivery, expiry, restart, reorg and unknown recovery', { skip: process.env.AGENTBL_W4_INTEGRATION !== '1', timeout: 120000 }, async (t) => {
  const node = await runHardhatNode(); t.after(() => stopHardhatNode(node));
  const provider = new JsonRpcProvider(node.url, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10; t.after(() => provider.destroy());
  const signer = await provider.getSigner(0), payer = Wallet.createRandom(), payee = Wallet.createRandom().address;
  const artifact = JSON.parse(await fs.readFile('hardhat/artifacts/contracts/MockAuthorizationUSDC.sol/MockAuthorizationUSDC.json', 'utf8'));
  const token = await (await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy()).waitForDeployment();
  await (await token.mint(payer.address, 1000000)).wait();
  const chainId = Number((await provider.getNetwork()).chainId), asset = await token.getAddress(), network = `eip155:${chainId}`;
  const verifier = new IndependentPaymentVerifier({ provider, confirmations: 1 });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'w4-evm-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'receipts.json');
  const requirement = { scheme: 'exact', network, asset, payTo: payee, amount: '1000', maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009', chainId, verifyingContract: asset, primaryType: 'TransferWithAuthorization' } };
  let serial = 0;
  const makeInput = async () => {
    const now = Number((await provider.getBlock('latest')).timestamp);
    const authorization = { from: payer.address, to: payee, value: '1000', validAfter: String(now - 5), validBefore: String(now + 60), nonce: id(`w4-${serial++}`) };
    const signature = await payer.signTypedData({ name: 'USDC', version: '2', chainId, verifyingContract: asset }, AUTHORIZATION_TYPES, authorization);
    return { paymentPayload: { x402Version: 2, accepted: requirement, payload: { signature, authorization } }, paymentRequirements: requirement, resource: 'https://local.example/report' };
  };
  const submit = async (input) => {
    const auth = input.paymentPayload.payload.authorization, sig = Signature.from(input.paymentPayload.payload.signature);
    return (await token.transferWithAuthorization(auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig.v, sig.r, sig.s)).wait();
  };
  let settlements = 0, lost = false;
  const adapter = { verify: async () => ({ response: { isValid: true }, attempts: 1 }), settle: async (input) => {
    settlements++; const receipt = await submit(input); if (lost) throw new Error('lost response after actual ERC3009 transfer');
    return { response: { success: true, transaction: receipt.hash, network, payer: payer.address }, attempts: 1 };
  } };
  const service = new X402SettlementService({ mode: 'live', verifier, adapter, store: new JsonReceiptStore({ filePath: storePath }) });
  const first = await makeInput(), checkpoint = await verifier.prepare(first), paid = await service.process(first);
  assert.equal(paid.record.independent_verification.verified, true); assert.equal(await token.balanceOf(payee), 1000n);
  const proof = await verifier.verify(first, paid.record.transaction); assert.equal(proof.amount_atomic, '1000');
  const deeper = new IndependentPaymentVerifier({ provider, confirmations: 2 });
  await assert.rejects(deeper.verify(first, paid.record.transaction), (error) => error.code === 'payment_confirmations_pending');
  await provider.send('evm_mine', []); assert.equal((await deeper.verify(first, paid.record.transaction)).confirmations, 2);
  for (const change of [
    { paymentRequirements: { ...requirement, network: 'eip155:1439' } },
    { paymentRequirements: { ...requirement, asset: payee } },
    { paymentRequirements: { ...requirement, amount: '2000' } },
    { paymentPayload: { ...first.paymentPayload, payload: { ...first.paymentPayload.payload, signature: `0x${'aa'.repeat(65)}` } } }
  ]) await assert.rejects(verifier.verify({ ...first, ...change }, paid.record.transaction));
  assert.equal(await verifier.locate(first, checkpoint), paid.record.transaction);
  // Payer recovery carries the stored authorization without its signature; the executed calldata supplies it,
  // and an authorization that differs from what was executed still fails.
  const unsigned = { ...first, paymentPayload: { ...first.paymentPayload, payload: { authorization: first.paymentPayload.payload.authorization } } };
  assert.equal((await verifier.verify(unsigned, paid.record.transaction)).verified, true);
  await assert.rejects(verifier.verify({ ...unsigned, paymentPayload: { ...unsigned.paymentPayload, payload: { authorization: { ...unsigned.paymentPayload.payload.authorization, nonce: id('other') } } } }, paid.record.transaction));
  await assert.rejects(verifier.prepare(unsigned), (error) => error.code === 'payment_signature_unavailable');
  const restart = new X402SettlementService({ mode: 'live', verifier, adapter, store: new JsonReceiptStore({ filePath: storePath }), deliveryKey: randomBytes(32) });
  assert.equal((await restart.process(first)).replayed, true); assert.equal(settlements, 1);
  const unknown = await makeInput(); lost = true; await assert.rejects(restart.process(unknown)); lost = false;
  assert.equal((await restart.process(unknown)).record.state, 'SETTLED'); assert.equal(settlements, 2);
  assert.equal(await token.balanceOf(payee), 2000n);

  const snapshot = await provider.send('evm_snapshot', []), reorgInput = await makeInput();
  const beforeReorg = await restart.process(reorgInput); await provider.send('evm_revert', [snapshot]);
  await assert.rejects(restart.process(reorgInput), (error) => error.code === 'payment_reverification_required');
  assert.equal((await restart.get(beforeReorg.record.payment_id)).state, 'RECONCILING');

  const services = [{ serviceId: 'w4-report', endpoint: '/paid', priceUSDC: 0.001, description: 'Isolated W4 research report' }];
  const config = { mode: 'live', network, chainId, asset, assetDecimals: 6, payTo: payee, ttlSeconds: 60, requestTimeoutMs: 1000,
    facilitatorUrl: 'https://synthetic-support.invalid', explorerUrl: 'http://local.invalid' };
  let builds = 0, attestations = 0, failDelivery = true;
  const support = () => new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network,
    extra: { supportedAssets: [{ address: asset, decimals: 6, assetTransferMethod: 'eip3009', eip712: { name: 'USDC', version: '2', primaryType: 'TransferWithAuthorization' } }] } }], extensions: [], signers: {} }));
  const gateway = await createLiveGateway({ config, services, settlementService: restart, fetchImpl: support, logger: { error() {} },
    definitions: { 'w4-report': { handler: async () => { builds++; return { kind: 'risk-intelligence', case_id: 'public-research', provider: 'deterministic-test', result: 'complete' }; } } },
    attest: async ({ independentVerification }) => {
      attestations++; assert.equal(independentVerification.verified, true); if (failDelivery) { failDelivery = false; throw new Error('attestation response lost'); }
      return { payment: { live: true, onchain: true, attestation: 'test-only' } };
    }
  });
  const server = await listen(http.createServer((req, res) => gateway.handle(req, res))); t.after(server.close);
  const request = await makeInput(), header = encodePaymentSignatureHeader(request.paymentPayload);
  const failed = await requestJson(server.base, 'POST', '/paid', {}, { 'payment-signature': header });
  assert.equal(failed.status, 500); assert.equal(failed.data.payment.status, 'settled');
  const afterPayment = settlements;
  const retry = await requestJson(server.base, 'POST', '/paid', {}, { 'payment-signature': header });
  assert.equal(retry.status, 200, JSON.stringify(retry.data)); assert.equal(settlements, afterPayment); assert.equal(builds, 1); assert.equal(attestations, 2);
  const replay = await requestJson(server.base, 'POST', '/paid', {}, { 'payment-signature': header });
  assert.deepEqual(replay.data, retry.data); assert.equal(attestations, 2);
  const changedBody = await requestJson(server.base, 'POST', '/paid', { changed: true }, { 'payment-signature': header });
  assert.equal(changedBody.status, 402); assert.equal(settlements, afterPayment);
  const expiredAt = Number(request.paymentPayload.payload.authorization.validBefore) + 100;
  await provider.send('evm_setNextBlockTimestamp', [expiredAt]); await provider.send('evm_mine', []);
  restart.clock = () => new Date(expiredAt * 1000);
  const expiredReplay = await restart.process({ ...request, resource: (await restart.get(paymentIdFor(request.paymentPayload, requirement))).resource });
  assert.equal(expiredReplay.replayed, true); assert.equal(settlements, afterPayment);
});

test('W4 actual anchor contract binds encrypted runtime evidence; version registration, local inclusion and reorg are independent', { skip: process.env.AGENTBL_W4_INTEGRATION !== '1', timeout: 120000 }, async (t) => {
  const node = await runHardhatNode(); t.after(() => stopHardhatNode(node));
  const provider = new JsonRpcProvider(node.url, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10; t.after(() => provider.destroy());
  const signer = await provider.getSigner(0), artifact = JSON.parse(await fs.readFile('hardhat/artifacts/contracts/AgentDecisionLog.sol/AgentDecisionLog.json', 'utf8'));
  const log = await (await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy()).waitForDeployment();
  const config = loadAgentConfig({ AGENT_ANCHOR_ENABLED: 'true', AGENT_ANCHOR_INTERVAL_SEC: '1' });
  const version = createAgentVersion(config, {}, id('local-w4-source'));
  await (await log.setAnchorer(await signer.getAddress(), true)).wait();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'w4-anchor-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const archiveDirectory = path.join(directory, 'archive'), env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') };
  const archive = new DecisionEvidenceArchive({ directory: archiveDirectory, env, ownerFor: () => 'private-owner' });
  const decision = { decision_id: `decision_${id('w4')}`, mode: 'live', case_id: 'private-commercial-case', event_id: 'private-event',
    action: 'HOLD_FOR_REVIEW', status: 'REJECTED', updated_at: new Date().toISOString(), agent_version: version,
    input_snapshot: { original: 'PRIVATE-W4-SOURCE-CONTENT' }, evidence_hash: id('input'), quote_hash: id('quote') };
  const adapter = createAnchorChainAdapter({ confirmations: 1, allowedChainIds: [31337], chainConfig: { chainIdDecimal: 31337,
    explorerBase: 'http://local.invalid', contracts: { AgentDecisionLog: await log.getAddress() }, deployments: { AgentDecisionLog: { deployTx: log.deploymentTransaction().hash } } },
  getContext: async () => ({ provider, decisionLog: log, signers: { ANCHORER: await signer.getAddress() } }) });
  const journal = new DecisionAnchoring({ file: path.join(directory, 'anchors.json'), version, config, archive, schema: 'agentbl-decision-anchor-v2',
    getMode: () => 'live', logger: { list: async () => [decision] }, adapter }); t.after(() => journal.stop());
  await journal.tick(); assert.equal(journal.status().last_error, 'anchor_preflight_failed'); assert.equal(await log.batchCount(), 0n);
  await (await log.registerAgentVersion(version.version_id, version.policy_hash, version.code_commit, version.model_id)).wait();
  const checkpoint = await provider.send('evm_snapshot', []);
  await journal.tick(); assert.equal(await log.batchCount(), 1n);
  const proof = await journal.get(decision.decision_id, decision); assert.equal(proof.verification.status, 'PASS_CHAIN');
  assert.doesNotMatch(JSON.stringify(proof.payload), /private-commercial-case|private-event|PRIVATE-W4-SOURCE-CONTENT/u);
  await assert.rejects(archive.get(decision.decision_id, { owner: 'different-owner' }), (error) => error.code === 'evidence_not_found');
  const pack = await archive.get(decision.decision_id, { owner: 'private-owner' });
  assert.equal(verifyEvidencePackage(pack, { anchor: proof, expectedCommitment: proof.payload.evidence_commitments[0] }).passed, true);
  assert.equal(verifyEvidencePackage(pack, { anchor: { ...proof, version: { ...proof.version, model_id: 'wrong' } } }).passed, false);
  assert.equal(verifyEvidencePackage(pack, { expectedCommitment: id('different-root') }).passed, false);
  await provider.send('evm_revert', [checkpoint]); await journal.tick();
  assert.equal(journal.state.live.batches[0].status, 'RECHECK_REQUIRED'); assert.equal(journal.state.live.batches[0].receipt_history.length, 1);
  assert.equal(journal.status().coverage.confirmed_records, 0); assert.equal(journal.status().coverage.archived_evidence_records, 1);
  const encrypted = await fs.readFile(path.join(archiveDirectory, 'archive.json'), 'utf8'); assert.doesNotMatch(encrypted, /PRIVATE-W4-SOURCE-CONTENT|private-owner/u);
  await fs.rm(path.join(archiveDirectory, 'archive.json'));
  await assert.rejects(archive.get(decision.decision_id, { owner: 'private-owner' }), (error) => error.code === 'evidence_archive_missing');
  await assert.rejects(journal.collect(), (error) => error.code === 'evidence_archive_missing');
});
