import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { AbiCoder, Interface, keccak256, toUtf8Bytes } from 'ethers';
import { createPool, resetStore, storeState } from '../src/app/store.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { toChainPricingArgs } from '../src/core/oracle.js';
import {
  ChainExecutionError, ChainExecutor, ExecutionPendingError, oracleDecisionId, proofToBytes32
} from '../src/agent/runtime/executors/chainExecutor.js';
import { SimExecutionError, SimExecutor, demoReference } from '../src/agent/runtime/executors/simExecutor.js';
import { chainStateName, planTransition } from '../src/agent/runtime/poolRules.js';

const copper = JSON.parse(await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8'));
const baseQuote = quoteFromCase(copper, { payout_speed: 'FAST' });
const cmd = (action, extra = {}) => ({
  decision_id: `decision_${action.toLowerCase()}${'0'.repeat(24)}`.slice(0, 33),
  idempotency_key: `event:${action}-${Math.random()}`,
  action, case_id: 'P1', pool_id: 'P1', ...extra
});

// ---------------- poolRules ----------------

test('poolRules: transitions mirror the contract', () => {
  const open = { state: 'Open', subscribed: 0 };
  assert.deepEqual(planTransition('REPRICE', open), { ok: true, from: 'Open', to: 'Open', changesState: false });
  assert.equal(planTransition('PAUSE', open).to, 'Paused');
  assert.equal(planTransition('PAUSE', { state: 'Paused' }).ok, false);
  assert.equal(planTransition('RESUME', { state: 'Open' }).code, 'not_paused');
  assert.equal(planTransition('RESUME', { state: 'Paused', stateBeforePause: 'Repriced' }).to, 'Repriced');
  assert.equal(planTransition('RESUME', { state: 'Paused' }).to, 'Open');
  assert.equal(planTransition('MARK_IN_TRANSIT', open).ok, false);
  assert.equal(planTransition('MARK_IN_TRANSIT', { state: 'Funded' }).to, 'InTransit');
  assert.equal(planTransition('CANCEL', { state: 'Open', subscribed: 5 }).code, 'has_subscribers');
  assert.equal(planTransition('CANCEL', open).to, 'Cancelled');
  assert.equal(planTransition('RECORD_PAYMENT', open).code, 'no_subscribers');
  assert.equal(planTransition('SETTLE', { state: 'InTransit', subscribed: 1 }).code, 'proofs_missing');
  assert.equal(planTransition('SETTLE', { state: 'InTransit', subscribed: 1, paymentProof: true, arrivalProof: true, repaymentAmountAtomic: '1000000', targetRedemptionValueAtomic: '1000000' }).to, 'Repaid');
  assert.equal(planTransition('REPRICE', { state: 'Repaid' }).ok, false);
  assert.equal(planTransition('WARNING', { state: 'Repaid' }).changesState, false);
  assert.equal(planTransition('NONSENSE', open).code, 'unknown_action');
  assert.equal(chainStateName(7), 'Paused');
  assert.equal(chainStateName(12), 'Cancelled');
  assert.throws(() => chainStateName(99), /Unknown on-chain/u);
});

// ---------------- SimExecutor ----------------

function simSetup({ subscribed = 0, status = 'Open' } = {}) {
  resetStore();
  const pool = createPool('P1', copper, baseQuote);
  pool.subscribedUsd = subscribed;
  pool.status = status;
  return { executor: new SimExecutor(), pool };
}

test('SimExecutor: REPRICE changes the offchain pool and returns a demo reference, never a hash', async () => {
  const { executor, pool } = simSetup();
  const lower = { ...baseQuote, final_issue_price_usd: baseQuote.final_issue_price_usd - 0.05 };
  const result = await executor.execute(cmd('REPRICE', { params: { quote: lower } }));
  assert.equal(result.success, true);
  assert.equal(result.mode, 'demo');
  assert.match(result.reference, /^demo:[0-9a-z]{1,12}$/u);
  assert.equal(result.signer_role, null);
  assert.equal(pool.status, 'Open');
  assert.equal(pool.quote.final_issue_price_usd, lower.final_issue_price_usd);
  assert.equal(result.effects.state_before, 'Open');
  assert.equal(result.effects.state_after, 'Open');
  assert.equal(result.effects.issue_price_before_usd, baseQuote.final_issue_price_usd);
  assert.equal('tx_hash' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /0x[0-9a-fA-F]{64}/u);
  assert.equal(demoReference('decision_abcdef0123456789'), 'demo:abcdef012345');
  resetStore();
});

test('SimExecutor: the same idempotency key is applied once', async () => {
  const { executor, pool } = simSetup();
  const command = cmd('PAUSE');
  const first = await executor.execute(command);
  assert.equal(pool.status, 'Paused');
  pool.status = 'Open'; // something else changed the pool afterwards
  const second = await executor.execute(command);
  assert.equal(second.duplicate, true);
  assert.equal(second.reference, first.reference);
  assert.equal(pool.status, 'Open', 'the duplicate did not re-apply the action');
  assert.deepEqual(await executor.findByIdempotencyKey(command.idempotency_key), first);
  assert.equal(await executor.findByIdempotencyKey('event:never'), null);
  resetStore();
});

test('SimExecutor: PAUSE then RESUME restores the previous state; illegal moves are refused', async () => {
  const { executor, pool } = simSetup();
  await executor.execute(cmd('REPRICE', { params: { quote: baseQuote } }));
  assert.equal(pool.status, 'Open');
  await executor.execute(cmd('PAUSE'));
  assert.equal(pool.status, 'Paused');
  await assert.rejects(executor.execute(cmd('PAUSE')), (error) => error instanceof SimExecutionError && error.code === 'illegal_transition');
  await executor.execute(cmd('RESUME'));
  assert.equal(pool.status, 'Open');
  await assert.rejects(executor.execute(cmd('RESUME')), { code: 'not_paused' });
  await assert.rejects(executor.execute(cmd('REPRICE')), { code: 'quote_required' });
  resetStore();
});

test('SimExecutor: settlement needs subscribers and both proofs, in order', async () => {
  const { executor, pool } = simSetup({ subscribed: 0 });
  await assert.rejects(executor.execute(cmd('RECORD_PAYMENT', { params: { payment_proof: 'p', repayment_amount: 10 } })), { code: 'no_subscribers' });
  pool.subscribedUsd = 1000;
  await assert.rejects(executor.execute(cmd('SETTLE')), { code: 'proofs_missing' });
  await assert.rejects(executor.execute(cmd('RECORD_PAYMENT', { params: { repayment_amount: 10 } })), { code: 'proof_required' });
  await executor.execute(cmd('MARK_IN_TRANSIT', { params: { departure_proof: 'dep-1' } }));
  assert.equal(pool.status, 'InTransit');
  await executor.execute(cmd('RECORD_PAYMENT', { params: { payment_proof: 'pay-1', repayment_amount: 2000 } }));
  await assert.rejects(executor.execute(cmd('RECORD_PAYMENT', { params: { payment_proof: 'pay-2', repayment_amount: 2000 } })), { code: 'already_recorded' });
  await assert.rejects(executor.execute(cmd('SETTLE')), { code: 'proofs_missing' });
  await executor.execute(cmd('RECORD_ARRIVAL', { params: { arrival_proof: 'bol-9' } }));
  const settled = await executor.execute(cmd('SETTLE'));
  assert.equal(pool.status, 'Repaid');
  assert.equal(settled.effects.state_after, 'Repaid');
  assert.equal(pool.settlement.payment_proof, 'pay-1');
  assert.ok(pool.settlement.settled_at);
  resetStore();
});

test('SimExecutor: FREEZE, LIQUIDATE, WARNING and OPEN', async () => {
  const { executor, pool } = simSetup();
  await executor.execute(cmd('WARNING', { params: { warning: 'INSURANCE_EXPIRING' } }));
  assert.equal(pool.status, 'Open');
  assert.equal(pool.warnings.length, 1);
  await executor.execute(cmd('FREEZE'));
  assert.equal(pool.status, 'Frozen');
  await executor.execute(cmd('LIQUIDATE'));
  assert.equal(pool.status, 'Liquidation');

  resetStore();
  const executor2 = new SimExecutor();
  await assert.rejects(executor2.execute(cmd('PAUSE')), { code: 'pool_not_found' });
  const opened = await executor2.execute(cmd('OPEN', { params: { case_data: copper, quote: baseQuote } }));
  assert.equal(opened.effects.state_after, 'Open');
  assert.ok(storeState.pools.get('P1'));
  await assert.rejects(new SimExecutor().execute({ action: 'PAUSE' }), TypeError);
  resetStore();
});

// ---------------- ChainExecutor ----------------

const ZERO = `0x${'0'.repeat(64)}`;
const TX = `0x${'ab'.repeat(32)}`;

function fakeChain(options = {}) {
  const sent = [];
  const events = [];
  const o = {
    state: 2, emergency: false, subscribed: 0, price: 800_000, target: 1_000_000, processed: false,
    revert: null, receiptStatus: 1, logs: ['PricingUpdated', 'PricingDecision', 'OfferingPaused'], processedLogs: [], waitMs: 0,
    executorPool: false, ...options
  };
  const oracleAddress = '0x1111111111111111111111111111111111111111';
  const poolAddress = '0x2222222222222222222222222222222222222222';
  const updater = '0x3333333333333333333333333333333333333333';
  const executorAddress = '0x4444444444444444444444444444444444444444';
  const blockHash = `0x${'ab'.repeat(32)}`;
  const functions = new Interface(['function updatePricing(uint256,uint256,uint8,uint8,bytes32,bytes32,uint256,uint256,uint256)',
    'function markInTransit(uint256,bytes32)', 'function recordImporterPayment(uint256,bytes32,uint256)',
    'function recordAdditionalPayment(uint256,bytes32,uint256)',
    'function recordCargoArrival(uint256,bytes32)', 'function settle(uint256,uint256)']);
  const initial = toChainPricingArgs({ ...baseQuote, pricing_action: 'PAUSE_OFFERING' }, {
    pool_id: 2, expected_quote_version: 1, valid_until: 2_000_000_000, decision_seq: 1
  });
  let transaction = { hash: TX, to: oracleAddress, from: updater, chainId: 1439n, value: 0n,
    data: functions.encodeFunctionData('updatePricing', [initial.pool_id, initial.issue_price_e6, initial.risk_level,
      initial.pricing_action, initial.evidence_hash, initial.quote_hash,
      initial.expected_quote_version, initial.valid_until, initial.decision_seq]) };
  const receipt = () => ({ hash: transaction.hash, from: transaction.from, to: transaction.to,
    status: o.receiptStatus, blockNumber: o.receiptBlock ?? 12345, blockHash,
    logs: o.logs.map((name) => ({ name, address: o.logAddress ?? (name === 'PricingUpdated' ? oracleAddress : poolAddress) })) });
  const parse = {
    parseLog: (log) => (log.name ? { name: log.name } : null),
    encodeFunctionData: functions.encodeFunctionData.bind(functions),
    parseTransaction: functions.parseTransaction.bind(functions)
  };
  const staticCheck = async () => { if (o.revert) throw Object.assign(new Error('call exception'), { reason: o.revert }); };
  const updatePricing = Object.assign(async (...args) => {
    events.push('send');
    sent.push(args);
    const hash = options.txHash ?? TX;
    transaction = { ...transaction, hash, from: updater, to: oracleAddress, data: functions.encodeFunctionData('updatePricing', args) };
    return {
      hash,
      wait: async () => {
        events.push('wait-start');
        if (o.waitMs === 'never') return new Promise(() => {});
        if (o.waitMs) await new Promise((r) => setTimeout(r, o.waitMs));
        events.push('wait-end');
        return receipt();
      }
    };
  }, { staticCall: staticCheck });
  const executorMethod = (name) => Object.assign(async (...args) => {
    sent.push([name, ...args]);
    transaction = { ...transaction, from: executorAddress, to: poolAddress, data: functions.encodeFunctionData(name, args) };
    return { hash: TX, wait: async () => receipt() };
  }, { staticCall: staticCheck });
  const context = {
    sent, events, options: o,
    provider: {
      send: async () => o.chainId ?? '0x59f',
      getBlockNumber: async () => o.head ?? 20000,
      getBlock: async () => ({ hash: o.blockHash ?? blockHash, timestamp: o.timestamp ?? Math.floor(Date.now() / 1000) }),
      getTransaction: async () => ({ ...transaction, ...o.transaction }),
      getTransactionReceipt: async (hash) => (o.pendingTx === hash ? null : { ...receipt(), ...o.receipt })
    },
    explorerBase: 'https://explorer.example/',
    signers: { PRICING_UPDATER: updater, AGENT_EXECUTOR: executorAddress },
    oracle: {
      target: oracleAddress,
      interface: parse,
      getAddress: async () => oracleAddress,
      isDecisionProcessed: async () => o.processed,
      lastDecisionSeq: async () => o.lastSeq ?? 0n,
      updatePricing,
      filters: { PricingUpdated: (id) => ({ id }) },
      queryFilter: async () => o.processedLogs
    },
    pool: {
      target: poolAddress,
      interface: parse,
      stateOf: async () => o.state,
      emergencyStopped: async () => o.emergency,
      quoteVersion: async () => o.version ?? 1n,
      offerings: async () => ({ subscribed: o.subscribed, issuePrice: o.price, targetRedemptionValue: o.target }),
      settlementProofs: async () => [ZERO, ZERO]
    }
  };
  if (o.executorPool) {
    context.executorPool = {
      target: poolAddress,
      interface: parse,
      markInTransit: executorMethod('markInTransit'),
      recordImporterPayment: executorMethod('recordImporterPayment'),
      recordCargoArrival: executorMethod('recordCargoArrival'),
      settle: executorMethod('settle')
    };
  }
  return context;
}

const quoteFor = (extra = {}) => ({ ...baseQuote, ...extra });
const chainCmd = (action, extra = {}) => cmd(action, { chain_pool_id: 2, params: { quote: quoteFor() }, ...extra });
const makeExecutor = (context, extra = {}) => new ChainExecutor({ getContext: async () => context, txTimeoutMs: 200, ...extra });

test('ChainExecutor: a PAUSE is sent once with the exact oracle arguments and confirmed from the receipt', async () => {
  const context = fakeChain({ logs: ['PricingUpdated', 'PricingDecision', 'OfferingPaused', 'OfferingStateChanged'] });
  const submitted = [];
  const result = await makeExecutor(context).execute({ ...chainCmd('PAUSE'), onSubmitted: async (info) => submitted.push(info) });
  assert.equal(context.sent.length, 1);
  const expected = toChainPricingArgs({ ...baseQuote, pricing_action: 'PAUSE_OFFERING' }, { pool_id: 2 });
  const [poolId, price, risk, action, evidence, quote, version, validUntil, seq] = context.sent[0];
  assert.deepEqual([poolId, price, risk, action, evidence, quote], [expected.pool_id, expected.issue_price_e6, expected.risk_level, 3, expected.evidence_hash, expected.quote_hash]);
  assert.equal(String(version), '1', 'quote version read from the pool');
  assert.equal(String(seq), '1', 'next sequence for the pool');
  assert.ok(BigInt(validUntil) > 1_700_000_000n, 'a bounded validity is attached');
  assert.deepEqual(
    { success: result.success, mode: result.mode, tx_hash: result.tx_hash, signer_role: result.signer_role, block: result.block_number },
    { success: true, mode: 'chain', tx_hash: TX, signer_role: 'PRICING_UPDATER', block: 12345 }
  );
  assert.equal(result.explorer_url, `https://explorer.example/tx/${TX}`);
  assert.deepEqual(result.confirmed_events, ['PricingUpdated', 'PricingDecision', 'OfferingPaused', 'OfferingStateChanged']);
  assert.deepEqual(submitted, [{ tx_hash: TX, signer_role: 'PRICING_UPDATER' }], 'the hash is reported before waiting for the receipt');
});

test('ChainExecutor: each pricing action uses its oracle action code (RESUME = 6)', async () => {
  const cases = [
    ['PAUSE', 2, ['PricingUpdated', 'PricingDecision', 'OfferingPaused'], 3],
    ['RESUME', 7, ['PricingUpdated', 'PricingDecision', 'OfferingResumed'], 6],
    ['FREEZE', 2, ['PricingUpdated', 'PricingDecision', 'OfferingFrozen'], 4],
    ['LIQUIDATE', 2, ['PricingUpdated', 'PricingDecision', 'OfferingStateChanged'], 5]
  ];
  for (const [action, state, logs, code] of cases) {
    const context = fakeChain({ state, logs });
    const result = await makeExecutor(context).execute(chainCmd(action));
    assert.equal(result.success, true, action);
    assert.equal(context.sent[0][3], code, action);
  }
});

test('ChainExecutor: REPRICE must lower the price and not exceed the redemption value', async () => {
  const lower = quoteFor({ final_issue_price_usd: 0.75 });
  const context = fakeChain({ state: 2, logs: ['PricingUpdated', 'PricingDecision', 'OfferingRepriced'] });
  const ok = await makeExecutor(context).execute(chainCmd('REPRICE', { params: { quote: lower } }));
  assert.equal(ok.success, true);
  assert.equal(context.sent[0][1], 750_000);
  assert.equal(context.sent[0][3], 2);

  const same = fakeChain({ state: 2 });
  await assert.rejects(makeExecutor(same).execute(chainCmd('REPRICE', { params: { quote: quoteFor({ final_issue_price_usd: 0.8 }) } })), { code: 'reprice_not_down' });
  assert.equal(same.sent.length, 0);
});

test('ChainExecutor: a transaction the contract would reject is never sent', async () => {
  const context = fakeChain({ revert: 'decision replay' });
  await assert.rejects(makeExecutor(context).execute(chainCmd('PAUSE')), (error) => {
    assert.ok(error instanceof ChainExecutionError);
    assert.equal(error.code, 'would_revert');
    assert.match(error.message, /decision replay/u);
    return true;
  });
  assert.equal(context.sent.length, 0);
});

test('ChainExecutor: emergency stop, illegal states and missing mapping stop before any send', async () => {
  const stopped = fakeChain({ emergency: true });
  await assert.rejects(makeExecutor(stopped).execute(chainCmd('PAUSE')), { code: 'emergency_stopped' });
  const terminal = fakeChain({ state: 9 });
  await assert.rejects(makeExecutor(terminal).execute(chainCmd('REPRICE', { params: { quote: quoteFor({ final_issue_price_usd: 0.5 }) } })), { code: 'illegal_transition' });
  await assert.rejects(makeExecutor(fakeChain()).execute(cmd('PAUSE', { params: { quote: quoteFor() } })), { code: 'no_chain_pool' });
  await assert.rejects(makeExecutor(fakeChain()).execute(chainCmd('PAUSE', { params: {} })), { code: 'quote_required' });
  await assert.rejects(makeExecutor(fakeChain()).execute(chainCmd('PAUSE', { params: { quote: quoteFor({ risk_level: 'EXTREME' }) } })), /risk_level/u);
  await assert.rejects(makeExecutor(fakeChain()).execute(chainCmd('SOMETHING')), { code: 'unsupported_action' });
  for (const context of [stopped, terminal]) assert.equal(context.sent.length, 0);
});

test('ChainExecutor: an action that is already in effect is skipped, not retried', async () => {
  const paused = fakeChain({ state: 7 });
  const skipped = await makeExecutor(paused).execute(chainCmd('PAUSE'));
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.tx_hash, null);
  const open = fakeChain({ state: 2 });
  assert.equal((await makeExecutor(open).execute(chainCmd('RESUME'))).skipped, true);
  assert.equal(paused.sent.length + open.sent.length, 0);
});

test('ChainExecutor: a decision the oracle already processed is reconciled by its event, not re-sent', async () => {
  const args = toChainPricingArgs({ ...baseQuote, pricing_action: 'PAUSE_OFFERING' }, { pool_id: 2 });
  const context = fakeChain({
    processed: true, txHash: TX, state: 7,
    processedLogs: [{
      transactionHash: `0x${'ff'.repeat(32)}`,
      args: { poolId: 2n, issuePrice: BigInt(args.issue_price_e6 + 1), evidenceHash: args.evidence_hash, quoteHash: args.quote_hash, action: 3n }
    }, {
      transactionHash: TX,
      args: { poolId: 2n, issuePrice: BigInt(args.issue_price_e6), evidenceHash: args.evidence_hash, quoteHash: args.quote_hash, action: 3n }
    }]
  });
  const result = await makeExecutor(context).execute(chainCmd('PAUSE'));
  assert.equal(context.sent.length, 0, 'no second transaction');
  assert.equal(result.recovered, true);
  assert.equal(result.tx_hash, TX);

  const lost = fakeChain({ processed: true, processedLogs: [] });
  await assert.rejects(makeExecutor(lost).execute(chainCmd('PAUSE')), { code: 'broadcast_uncertain' });
  assert.equal(lost.sent.length, 0);
});

test('ChainExecutor: a confirmation timeout leaves the decision pending with the tx hash', async () => {
  const context = fakeChain({ waitMs: 'never' });
  await assert.rejects(makeExecutor(context, { txTimeoutMs: 20 }).execute(chainCmd('PAUSE')), (error) => {
    assert.ok(error instanceof ExecutionPendingError);
    assert.equal(error.tx_hash, TX);
    return true;
  });
});

test('ChainExecutor: a reverted receipt or missing events is a failure, not a success', async () => {
  await assert.rejects(makeExecutor(fakeChain({ receiptStatus: 0 })).execute(chainCmd('PAUSE')), { code: 'tx_reverted' });
  await assert.rejects(makeExecutor(fakeChain({ logs: ['PricingUpdated'] })).execute(chainCmd('PAUSE')), (error) => {
    assert.equal(error.code, 'events_missing');
    assert.match(error.message, /OfferingPaused/u);
    return true;
  });
});

test('ChainExecutor: one transaction per signer at a time, so nonces stay in order', async () => {
  const context = fakeChain({ waitMs: 20, state: 2, logs: ['PricingUpdated', 'PricingDecision', 'OfferingPaused'] });
  const executor = makeExecutor(context);
  // Two different decisions against the same signer, started together.
  const a = executor.execute(chainCmd('PAUSE', { params: { quote: quoteFor({ evidence_hash: `0x${'11'.repeat(32)}` }) } }));
  const b = executor.execute(chainCmd('PAUSE', { params: { quote: quoteFor({ evidence_hash: `0x${'22'.repeat(32)}` }) } }));
  await Promise.all([a, b]);
  assert.deepEqual(context.events, ['send', 'wait-start', 'wait-end', 'send', 'wait-start', 'wait-end']);
});

test('ChainExecutor: executor-role actions go to an operator unless the optional AGENT_EXECUTOR key exists', async () => {
  const without = fakeChain();
  const executor = makeExecutor(without);
  assert.equal(await executor.canExecute('PAUSE'), true);
  assert.equal(await executor.canExecute('SETTLE'), false);
  assert.equal(await executor.canExecute('CANCEL'), false);
  await assert.rejects(executor.execute(chainCmd('MARK_IN_TRANSIT', { params: { departure_proof: 'dep-1' } })), { code: 'owner_signature_required' });

  const withKey = fakeChain({ executorPool: true, state: 4, subscribed: 1, logs: ['DepartureRecorded'] });
  const keyed = makeExecutor(withKey);
  assert.equal(await keyed.canExecute('SETTLE'), true);
  const result = await keyed.execute(chainCmd('MARK_IN_TRANSIT', { params: { departure_proof: 'dep-1' } }));
  assert.equal(result.signer_role, 'AGENT_EXECUTOR');
  assert.deepEqual(withKey.sent[0], ['markInTransit', 2, keccak256(toUtf8Bytes('dep-1'))]);
});

test('ChainExecutor: findTransaction resolves a submitted hash only once it is mined', async () => {
  const context = fakeChain({ logs: ['PricingUpdated', 'PricingDecision', 'OfferingPaused'] });
  context.options.pendingTx = TX;
  const executor = makeExecutor(context);
  assert.equal(await executor.findTransaction(TX, 'PAUSE', chainCmd('PAUSE')), null);
  context.options.pendingTx = null;
  const done = await executor.findTransaction(TX, 'PAUSE', chainCmd('PAUSE'));
  assert.equal(done.success, true);
  assert.equal(done.recovered, true);
  assert.equal(done.tx_hash, TX);
});

test('ChainExecutor: recovery waits for canonical confirmation depth without resending', async () => {
  const context = fakeChain({ head: 12345 });
  const executor = makeExecutor(context, { confirmations: 3 });
  const command = chainCmd('PAUSE');
  assert.equal(await executor.findTransaction(TX, 'PAUSE', command), null);
  context.options.head = 12347;
  assert.equal((await executor.findTransaction(TX, 'PAUSE', command)).success, true);
  assert.equal(context.sent.length, 0);
  await assert.rejects(makeExecutor(fakeChain({ head: 12345 }), { confirmations: 3 }).execute(command), { code: 'execution_pending', tx_hash: TX });
});

test('ChainExecutor: recovery rejects reorgs and binds the exact approved transaction', async (t) => {
  for (const [name, patch, code] of [
    ['reorg', { blockHash: `0x${'cd'.repeat(32)}` }, 'tx_reorged'],
    ['wrong target', { transaction: { to: '0x5555555555555555555555555555555555555555' } }, 'tx_verification_failed'],
    ['wrong signer', { transaction: { from: '0x5555555555555555555555555555555555555555' } }, 'tx_verification_failed'],
    ['different calldata', { transaction: { data: '0x1234' } }, 'tx_verification_failed'],
    ['other chain', { chainId: '0x1' }, 'tx_verification_failed'],
    ['value transfer', { transaction: { value: 1n } }, 'tx_verification_failed'],
    ['foreign event source', { logAddress: '0x5555555555555555555555555555555555555555' }, 'events_missing'],
    ['substituted receipt', { receipt: { hash: `0x${'cd'.repeat(32)}` } }, 'tx_verification_failed']
  ]) await t.test(name, async () => {
    const context = fakeChain(patch);
    await assert.rejects(makeExecutor(context).findTransaction(TX, 'PAUSE', chainCmd('PAUSE')), { code });
    assert.equal(context.sent.length, 0);
  });
  await assert.rejects(makeExecutor(fakeChain()).findTransaction(TX, 'PAUSE'), { code: 'command_required' });
  await assert.rejects(makeExecutor(fakeChain()).findTransaction(TX, 'PAUSE', chainCmd('RESUME')), { code: 'command_required' });
});

test('helpers: proofToBytes32 and oracleDecisionId match what the contracts compute', async () => {
  assert.equal(await proofToBytes32('bol-123'), keccak256(toUtf8Bytes('bol-123')));
  const hash = `0x${'AB'.repeat(32)}`;
  assert.equal(await proofToBytes32(hash), hash.toLowerCase());
  await assert.rejects(proofToBytes32('  '), { code: 'proof_required' });

  const oracleAddress = '0x1111111111111111111111111111111111111111';
  const args = {
    ...toChainPricingArgs({ ...baseQuote, pricing_action: 'PAUSE_OFFERING' }, {
      pool_id: 2, expected_quote_version: 1, valid_until: 2_000_000_000, decision_seq: 4
    }),
    chain_id: 1439, oracle_address: oracleAddress
  };
  const expected = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'uint256', 'uint256', 'uint8', 'bytes32', 'bytes32', 'uint256', 'uint256'],
    [1439, oracleAddress, 2, args.issue_price_e6, 3, args.evidence_hash, args.quote_hash, 1, 4]
  ));
  assert.equal(await oracleDecisionId(args), expected);
  assert.throws(() => new ChainExecutor({}), /getContext/u);
});
