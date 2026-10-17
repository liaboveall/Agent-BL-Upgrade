import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { subscribeOffering } from '../web/src/lib/web3.js';
import { PROTOCOL_V5_ABI } from '../src/chain/protocolV5Abi.js';

function fixture() {
  const pool = `0x${'1'.repeat(40)}`, wallet = `0x${'2'.repeat(40)}`, asset = `0x${'3'.repeat(40)}`, txHash = `0x${'a'.repeat(64)}`;
  const iface = new Interface(PROTOCOL_V5_ABI.RWAOfferingPool);
  const calls = [], state = { current: true, confirmation: 'confirmed' };
  const offering = { exists: true, state: 2n, issuePrice: 800000n, tokenSupply: 10n, subscribed: 0n, settlementAsset: asset };
  const events = [
    { name: 'Subscribed', args: { poolId: 1n, investor: wallet, amount: 2n, paidAmount: 1600000n } },
    { name: 'FundEscrowed', args: { poolId: 1n, investor: wallet, asset, shares: 2n, amountAtomic: 1600000n } }
  ];
  const receipt = { status: 1, blockNumber: 1, logs: events.map((_, index) => ({ address: pool, index })) };
  const contract = { offerings: async () => offering, protocolVersion: async () => 5n, emergencyStopped: async () => false,
    isInvestorEligible: async () => true, quoteVersion: async () => 1n, subscriptionDeadline: async () => 5000n,
    interface: { encodeFunctionData: iface.encodeFunctionData.bind(iface), parseLog: (log) => events[log.index] },
    subscribeWithTerms: Object.assign(async () => { calls.push('subscribe'); return { hash: txHash, wait: async () => receipt }; }, { staticCall: async () => { calls.push('static'); } }) };
  const token = { decimals: async () => 6, allowance: async () => 0n, approve: async (_spender, amount) => {
    calls.push(`approve:${amount}`); return { wait: async () => { state.onApproval?.(); } };
  } };
  const session = { kind: 'evm', address: wallet, signer: {}, provider: { request: async ({ method }) => method === 'eth_chainId' ? '0x59f'
    : method === 'eth_getBlockByNumber' ? { timestamp: '0x1000' } : [wallet] } };
  const action = { shares: '2', chain: { chain_id: 1439, pool_id: 1, contract: pool, price_e6: '800000', settlement_asset: asset, protocol_version: 5 } };
  const config = { chainIdDecimal: 1439, protocolVersion: 5, contracts: { RWAOfferingPool: pool }, abis: { RWAOfferingPool: PROTOCOL_V5_ABI.RWAOfferingPool }, explorerBase: 'https://explorer.invalid' };
  const options = { getSession: () => state.current ? session : null, getConfig: async () => config,
    ethersFn: async () => ({ Contract: class { constructor(address) { return address === pool ? contract : token; } } }),
    prepareIntent: async (body) => { calls.push('intent'); return { intent_id: 'intent', asset, amount_atomic: '1600000',
      calldata: iface.encodeFunctionData('subscribeWithTerms', [1, 2n, 800000n, 1n, BigInt(body.deadline)]) }; },
    attachIntent: async () => { calls.push('attach'); return { status: state.confirmation }; } };
  return { action, options, contract, token, calls, state, events, receipt };
}

test('W2 wallet saves the funding intent before approval, then simulates with allowance and verifies escrow', async () => {
  const f = fixture();
  const result = await subscribeOffering(f.action, f.options);
  assert.equal(result.amountUsd, 1.6);
  assert.deepEqual(f.calls, ['intent', 'approve:1600000', 'static', 'subscribe', 'attach', 'attach']);
});

test('W2 wallet refuses version, asset and decimal changes before a subscription signature', async () => {
  for (const change of ['version', 'asset', 'decimals']) {
    const f = fixture();
    if (change === 'version') f.contract.protocolVersion = async () => 4n;
    if (change === 'asset') f.action.chain.settlement_asset = `0x${'4'.repeat(40)}`;
    if (change === 'decimals') f.token.decimals = async () => 18;
    await assert.rejects(subscribeOffering(f.action, f.options));
    assert.ok(!f.calls.includes('subscribe')); assert.ok(!f.calls.some((call) => call.startsWith('approve')));
  }
});

test('W2 wallet rechecks the session after approval and never broadcasts a failed preflight', async () => {
  for (const change of ['wallet', 'terms']) {
    const f = fixture();
    if (change === 'wallet') f.state.onApproval = () => { f.state.current = false; };
    if (change === 'terms') f.contract.subscribeWithTerms.staticCall = async () => { throw new Error('quote version changed'); };
    await assert.rejects(subscribeOffering(f.action, f.options));
    assert.ok(f.calls.includes('approve:1600000')); assert.ok(!f.calls.includes('subscribe'));
  }
});

test('W2 wallet keeps missing escrow and insufficient canonical confirmations unresolved after one broadcast', async () => {
  for (const change of ['receipt', 'confirmations']) {
    const f = fixture();
    if (change === 'receipt') f.receipt.logs.pop();
    if (change === 'confirmations') f.state.confirmation = 'broadcast';
    await assert.rejects(subscribeOffering(f.action, f.options), { code: 'subscription_reconciliation_required' });
    assert.equal(f.calls.filter((call) => call === 'subscribe').length, 1);
  }
});
