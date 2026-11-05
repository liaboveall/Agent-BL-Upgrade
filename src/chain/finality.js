// One finality policy for the wallet operations that move or lock test assets (role plans and capital intents alike).
//
// A receipt decides the fate of an operation only once enough blocks follow it, and the rule is the same for every
// receipt: a failed (status 0) receipt is as provisional as a successful one. If the latest blocks of a chain can still
// be replaced, the same signed transaction can fail on one branch and succeed on the other, so a retry the user sent
// after seeing the failure could then land beside it. Until the receipt is deep enough the operation stays open: it is
// still listed for recovery and still holds the wallet's next send.
//
// The depth is a defensive choice of this application, not a protocol requirement. Injective describes instant
// finality, so on the public testnet it is a margin against an RPC that serves a not-yet-settled view, not a response
// to ordinary reorganisations. Local development chains decide at once. Changing the policy means changing it here, for
// every path, rather than letting some paths wait and others decide immediately.

const LOCAL_CHAIN_ID = 31337n;
/** Blocks that must follow a receipt's own block before a decision rests on it, on a chain that can still reorganise. */
export const SUCCESSOR_BLOCKS = 2;

/** Successor blocks a receipt needs on `chainId`; local development chains decide immediately, anything unreadable waits. */
export function successorBlocks(chainId) {
  try { return BigInt(chainId) === LOCAL_CHAIN_ID ? 0 : SUCCESSOR_BLOCKS; } catch { return SUCCESSOR_BLOCKS; }
}

/** The same depth in the capital ledger's unit, which counts the receipt's own block as the first confirmation. */
export function confirmationsFor(chainId) { return successorBlocks(chainId) + 1; }

/** Whether a receipt mined in `blockNumber` has `successors` blocks on top of it when the chain head is `latest`. */
export function hasSuccessors(latest, blockNumber, successors) { return BigInt(latest) - BigInt(blockNumber) >= BigInt(successors); }
