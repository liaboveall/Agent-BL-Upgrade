// This format is independent of transport and contains only the public audit projection.
import { concat, keccak256, toUtf8Bytes } from 'ethers';
import { stableStringify } from '../decisionLogger.js';
import { sanitizeAudit } from '../security/privacy.js';

export const ANCHOR_SCHEMA = 'agentbl-decision-anchor-v1';
export const TERMINAL_DECISIONS = ['COMPLETED', 'FAILED', 'REJECTED', 'SKIPPED', 'OBSERVE_ONLY'];
export const MAX_ANCHOR_BATCH = 256;
const HASH = /^0x[0-9a-f]{64}$/u;

export function terminalPayload(decision, { seq, versionId, finalizedAt = decision.updated_at }) {
  if (!TERMINAL_DECISIONS.includes(decision.status) || !['demo', 'live'].includes(decision.mode)) throw new Error('Only terminal decisions have anchor leaves');
  const approval = decision.approval;
  return { ...sanitizeAudit({
    schema: ANCHOR_SCHEMA, mode: decision.mode, seq, decision_id: decision.decision_id,
    event_id: decision.event_id ?? null, case_id: decision.case_id, pool_id: decision.pool_id ?? null,
    action: decision.action, status: decision.status, policy: { verdict: decision.policy?.verdict ?? null },
    approval: approval ? { approval_id: approval.approval_id, status: approval.status,
      route: approval.route ?? null, decided_by: approval.decided_by ?? null, decided_at: approval.decided_at ?? null,
      expires_at: approval.expires_at ?? null } : null,
    execution: { mode: decision.execution?.mode ?? null, reference: decision.execution?.reference ?? null,
      tx_hash: decision.execution?.tx_hash ?? decision.transaction?.tx_hash ?? null },
    evidence_hash: decision.evidence_hash ?? null, quote_hash: decision.quote_hash ?? null,
    finalized_at: finalizedAt
  }), version_id: versionId };
}

// The 0x00 prefix separates JSON leaves from the 64-byte internal-node preimage.
export const anchorLeaf = (payload) => keccak256(concat(['0x00', toUtf8Bytes(stableStringify(payload))]));
export function hashPair(a, b) { return keccak256(concat(a < b ? [a, b] : [b, a])); }

export function merkleTree(leaves) {
  if (!leaves.length || leaves.length > MAX_ANCHOR_BATCH || leaves.some((leaf) => !HASH.test(leaf))) throw new Error('Invalid Merkle leaves');
  const levels = [[...leaves]];
  while (levels.at(-1).length > 1) {
    const previous = levels.at(-1), next = [];
    for (let i = 0; i < previous.length; i += 2) next.push(i + 1 < previous.length ? hashPair(previous[i], previous[i + 1]) : previous[i]);
    levels.push(next);
  }
  return { root: levels.at(-1)[0], proofs: leaves.map((_, index) => {
    const proof = [];
    for (const level of levels.slice(0, -1)) {
      const sibling = index ^ 1;
      if (sibling < level.length) proof.push(level[sibling]);
      index = Math.floor(index / 2);
    }
    return proof;
  }) };
}

export function verifyMerkleProof(leaf, proof, root) {
  if (!HASH.test(leaf ?? '') || !HASH.test(root ?? '') || !Array.isArray(proof) || proof.length > 8 || proof.some((item) => !HASH.test(item))) return false;
  return proof.reduce(hashPair, leaf) === root;
}

export function verifyAnchorRecord(result, decision = null) {
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  try {
    check('canonical_leaf', result.leaf === anchorLeaf(result.payload));
    check('decision_binding', result.decision_id === result.payload.decision_id && result.seq === result.payload.seq && result.mode === result.payload.mode);
    if (decision) {
      check('current_decision', stableStringify(terminalPayload(decision, { seq: result.seq, versionId: result.payload.version_id,
        finalizedAt: result.payload.finalized_at })) === stableStringify(result.payload));
      if (decision.agent_version) {
        const { version_id: versionId, ...metadata } = decision.agent_version;
        check('recorded_agent_version', versionId === result.payload.version_id && versionId === keccak256(toUtf8Bytes(stableStringify(metadata))));
      }
    }
    check('merkle_inclusion', verifyMerkleProof(result.leaf, result.proof, result.batch?.merkle_root));
    const batch = result.batch;
    check('batch_binding', batch && batch.mode === result.mode && result.seq >= batch.from_seq && result.seq <= batch.to_seq
      && batch.count === batch.to_seq - batch.from_seq + 1 && batch.version_id === result.payload.version_id);
  } catch { check('valid_anchor_format', false); }
  return { passed: checks.every((check) => check.passed), status: checks.every((check) => check.passed) ? 'PASS_LOCAL' : 'FAIL', checks };
}
