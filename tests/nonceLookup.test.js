import test from 'node:test';
import assert from 'node:assert/strict';
import { findNonceTransaction, LINEAR_SCAN_LIMIT } from '../src/chain/nonceLookup.js';

const WALLET = '0x00000000000000000000000000000000000000aa';

/** A chain where WALLET's nonce `nonce` is consumed at block `minedAt`; `history` false refuses older blocks. */
function chain({ minedAt, nonce = 7, latest, history = true }) {
  const stats = { counts: 0, blocks: 0 };
  const provider = {
    async getTransactionCount(_from, block) {
      stats.counts += 1;
      if (!history && block !== latest) throw new Error('missing trie node');
      return minedAt !== null && block >= minedAt ? nonce + 1 : nonce;
    },
    async getBlock(number) { stats.blocks += 1; return { number, transactions: number === minedAt ? ['0xother', '0xmine'] : ['0xother'] }; },
    async getTransaction(hash) { return hash === '0xmine' ? { hash, from: WALLET, nonce } : { hash, from: '0x00000000000000000000000000000000000000bb', nonce: 1 }; }
  };
  return { provider, stats, read: (operation) => operation() };
}

test('a broadcast mined long after its preparation is found by bisecting the nonce, not by scanning blocks', async () => {
  const latest = 2_000_000, { provider, stats, read } = chain({ minedAt: 1_234_567, latest });
  const found = await findNonceTransaction(provider, read, { from: WALLET, nonce: 7, fromBlock: 100, latest });
  assert.equal(found.hash, '0xmine');
  assert.equal(found.block_number, 1_234_567);
  assert.ok(stats.counts <= 24 && stats.blocks === 1, `${stats.counts} nonce reads, ${stats.blocks} block reads`);
});

test('an unused nonce is reported as not yet mined', async () => {
  const { provider, read } = chain({ minedAt: null, latest: 5000 });
  assert.equal(await findNonceTransaction(provider, read, { from: WALLET, nonce: 7, fromBlock: 10, latest: 5000 }), null);
});

test('without historical state a short range is scanned and a long one asks for the wallet hash', async () => {
  const short = chain({ minedAt: 140, latest: 100 + LINEAR_SCAN_LIMIT, history: false });
  assert.equal((await findNonceTransaction(short.provider, short.read, { from: WALLET, nonce: 7, fromBlock: 100, latest: 100 + LINEAR_SCAN_LIMIT })).hash, '0xmine');
  const long = chain({ minedAt: 9000, latest: 20_000, history: false });
  await assert.rejects(findNonceTransaction(long.provider, long.read, { from: WALLET, nonce: 7, fromBlock: 100, latest: 20_000 }), { code: 'nonce_history_unavailable' });
});
