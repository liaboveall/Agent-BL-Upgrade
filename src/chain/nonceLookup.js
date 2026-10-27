// Recovery of a wallet transaction whose hash never reached the server: the saved sender and nonce identify it.
// Injective's EVM makes a block about every 0.55 s, so a fixed scan of the next 500 blocks covered under five
// minutes. Instead the account nonce is read at historical blocks and bisected to the one block that consumed it,
// which costs about log2(blocks) reads however long ago the wallet sent it.

// Without historical state the old bounded scan of every transaction in every block is the fallback.
export const LINEAR_SCAN_LIMIT = 500;

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function unavailable(cause) {
  return Object.assign(new Error('The node cannot answer historical nonce queries for this range'), { code: 'nonce_history_unavailable', cause });
}

async function transactionIn(provider, read, blockNumber, from, nonce) {
  const block = await read(() => provider.getBlock(blockNumber, true));
  if (!block) throw Object.assign(new Error('A recovery block is unavailable'), { code: 'recovery_block_missing' });
  // Some providers ignore prefetch; fetch each transaction by the hashes the block lists.
  for (const hash of block.transactions) {
    const tx = await read(() => provider.getTransaction(hash));
    if (!tx) throw Object.assign(new Error('A recovery transaction is unavailable'), { code: 'recovery_transaction_missing' });
    if (same(tx.from, from) && Number(tx.nonce) === nonce) return { hash, tx, block_number: blockNumber };
  }
  return null;
}

/**
 * The transaction from `from` with `nonce`, mined in [fromBlock, latest], or null while that nonce is still unused.
 * @returns {Promise<{hash: string, tx: object, block_number: number} | null>}
 */
export async function findNonceTransaction(provider, read, { from, nonce, fromBlock, latest }) {
  // The current nonce must be readable (a failure here is an ordinary read failure for the caller to retry);
  // an older block that cannot be read means the node keeps no history that far back.
  if (Number(await read(() => provider.getTransactionCount(from, latest))) <= nonce) return null;
  const countAt = async (blockTag) => {
    try { return Number(await read(() => provider.getTransactionCount(from, blockTag))); }
    catch (error) { throw unavailable(error); }
  };
  try {
    // Invariant: the nonce is unused at `low` and used at `high`. A nonce saved from the pending count is unused
    // at the block it was prepared in; if a node says otherwise, that block is the only candidate.
    let low = Math.max(0, fromBlock), high = latest;
    if (await countAt(low) > nonce) high = low;
    else while (high - low > 1) {
      const middle = low + Math.floor((high - low) / 2);
      if (await countAt(middle) > nonce) high = middle; else low = middle;
    }
    const found = await transactionIn(provider, read, high, from, nonce);
    if (!found) throw Object.assign(new Error('The block that consumed the nonce does not list its transaction'), { code: 'recovery_transaction_missing' });
    return found;
  } catch (error) {
    if (error?.code !== 'nonce_history_unavailable' || latest - fromBlock > LINEAR_SCAN_LIMIT) throw error;
    for (let number = fromBlock; number <= latest; number++) {
      const found = await transactionIn(provider, read, number, from, nonce);
      if (found) return found;
    }
    return null;
  }
}
