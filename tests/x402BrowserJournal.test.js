import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, AbiCoder } from 'ethers';
import { payV2WithWallet } from '../web/src/lib/x402-v2.js';
import {
  MAX_PENDING_PAYMENTS, MAX_SETTLED_RECORDS, SETTLED_RETENTION_MS, exportPaymentJournal, journalEntries, pendingPayments, pruneJournal, reportAuthorization
} from '../web/src/lib/payment-recovery.js';

const memory = () => { const values = new Map(); return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };
const requirement = { scheme: 'exact', network: 'eip155:1439', asset: `0x${'11'.repeat(20)}`, payTo: `0x${'22'.repeat(20)}`,
  amount: '1000', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' } };

function harness() {
  const wallet = Wallet.createRandom(), signatures = [];
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_call') return AbiCoder.defaultAbiCoder().encode(['string'], ['USDC']);
    if (method === 'eth_signTypedData_v4') { const typed = JSON.parse(params[1]); const { EIP712Domain: _domain, ...types } = typed.types; signatures.push(typed.message.nonce); return wallet.signTypedData(typed.domain, types, typed.message); }
    throw new Error('Unexpected wallet operation');
  } };
  let mode = 'ok';
  const delivered = new Map(); // like the gateway: one report per signed payment, re-served on replay
  const fetchImpl = async (_url, init) => {
    const header = init.headers['PAYMENT-SIGNATURE'];
    if (!header) return new Response(JSON.stringify({ x402Version: 2, accepts: [requirement] }), { status: 402 });
    if (mode === 'lost') throw new Error('Response lost after debit');
    if (!delivered.has(header)) delivered.set(header, `rpt_${delivered.size + 1}`);
    return new Response(JSON.stringify({ report_envelope: { report_id: delivered.get(header) } }), { status: 200 });
  };
  return { wallet, signatures, provider, fetchImpl, setMode: (next) => { mode = next; } };
}

test('F01 a new tab keeps an unresolved payment listed, never signs again, and is sent to wallet recovery', async () => {
  const h = harness(), journal = memory(), firstTab = { journal, secrets: memory() }, nextTab = { journal, secrets: memory() };
  const options = { endpoint: '/paid', from: h.wallet.address, body: { case_id: 'research' }, provider: h.provider, fetchImpl: h.fetchImpl, expectedAmountAtomic: 1000 };
  h.setMode('lost');
  await assert.rejects(payV2WithWallet({ ...options, recoveryStore: firstTab }), /lost/u);
  assert.equal(h.signatures.length, 1);
  const [pending] = pendingPayments(nextTab);
  assert.equal(pending.status, 'pending'); assert.equal(pending.nonce, h.signatures[0]); assert.deepEqual(pending.request, { case_id: 'research' });
  assert.equal(pending.amount, '1000'); assert.equal(pending.from, h.wallet.address.toLowerCase());
  assert.equal([...journal.values.values()].join('').includes('signature'), false, 'the persistent journal never holds the payment signature');

  h.setMode('ok');
  await assert.rejects(payV2WithWallet({ ...options, recoveryStore: nextTab }), { code: 'payment_recovery_required' });
  await assert.rejects(payV2WithWallet({ ...options, body: { case_id: 'another' }, recoveryStore: nextTab }), /Reconcile/u);
  assert.equal(h.signatures.length, 1, 'no second payment signature from either tab');

  const replay = await payV2WithWallet({ ...options, recoveryStore: firstTab });
  assert.equal(replay.replayed, true);
  assert.equal(journalEntries(nextTab)[0].status, 'completed');
  assert.equal(journalEntries(nextTab)[0].request, undefined, 'the request body is dropped once delivered');
  assert.equal(reportAuthorization('rpt_1', nextTab), null);
  await assert.rejects(payV2WithWallet({ ...options, recoveryStore: nextTab }), { code: 'purchase_recovery_required' });
});

test('F02 completed records never block a purchase; unresolved ones are capped before the wallet is asked', async () => {
  const h = harness(), store = memory(), now = Date.now(), at = new Date(now).toISOString();
  const completed = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`done-${index}`,
    { key: `done-${index}`, endpoint: `/paid/${index}`, from: h.wallet.address.toLowerCase(), status: 'completed', report_id: `rpt_old_${index}`, created_at: at, updated_at: at }]));
  store.setItem('agentbl-x402-journal-v2', JSON.stringify({ version: 2, entries: completed }));
  const result = await payV2WithWallet({ endpoint: '/paid', from: h.wallet.address, body: {}, provider: h.provider, fetchImpl: h.fetchImpl, expectedAmountAtomic: 1000, recoveryStore: store });
  assert.equal(result.response.status, 200); assert.equal(h.signatures.length, 1);

  const pending = Object.fromEntries(Array.from({ length: MAX_PENDING_PAYMENTS }, (_, index) => [`open-${index}`,
    { key: `open-${index}`, endpoint: `/other/${index}`, from: h.wallet.address.toLowerCase(), status: 'pending', created_at: at, updated_at: at }]));
  store.setItem('agentbl-x402-journal-v2', JSON.stringify({ version: 2, entries: pending }));
  await assert.rejects(payV2WithWallet({ endpoint: '/new', from: h.wallet.address, body: {}, provider: h.provider, fetchImpl: () => { throw new Error('must not request'); }, recoveryStore: store }),
    /still need reconciliation/u);
  assert.equal(h.signatures.length, 1, 'the capacity check runs before the challenge and the signature');
});

test('F02 retention prunes settled records by age and count, never unresolved ones', () => {
  const now = Date.parse('2026-10-27T00:00:00Z'), iso = (ms) => new Date(ms).toISOString();
  const entries = {
    stale: { status: 'completed', updated_at: iso(now - SETTLED_RETENTION_MS - 1) },
    unspent: { status: 'void', updated_at: iso(now - SETTLED_RETENTION_MS - 1) },
    old_pending: { status: 'pending', updated_at: iso(now - 10 * SETTLED_RETENTION_MS) },
    ...Object.fromEntries(Array.from({ length: MAX_SETTLED_RECORDS + 2 }, (_, index) => [`recent-${index}`, { status: 'completed', updated_at: iso(now - index * 1000) }]))
  };
  assert.deepEqual(pruneJournal(entries, now).sort(), ['recent-100', 'recent-101', 'stale', 'unspent'].sort());
});

test('F02 buying the same request again is explicit: a re-read costs nothing, a new snapshot is a new signed payment', async () => {
  const h = harness(), store = { journal: memory(), secrets: memory() };
  const options = { endpoint: '/paid', from: h.wallet.address, body: { case_id: 'research' }, provider: h.provider, fetchImpl: h.fetchImpl, expectedAmountAtomic: 1000, recoveryStore: store };
  await payV2WithWallet(options);
  assert.equal((await payV2WithWallet(options)).replayed, true); assert.equal(h.signatures.length, 1);
  const renewed = await payV2WithWallet({ ...options, renew: true });
  assert.equal(renewed.replayed, false); assert.equal(h.signatures.length, 2);
  const entries = journalEntries(store);
  assert.deepEqual(entries.map((entry) => entry.report_id).sort(), ['rpt_1', 'rpt_2']);
  assert.ok(entries.some((entry) => entry.archived));
  const exported = JSON.stringify(exportPaymentJournal(store));
  assert.equal(exported.includes(reportAuthorization('rpt_2', store)), false, 'the export carries no signature');
});
