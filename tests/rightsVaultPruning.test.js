import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPIRED_MATERIAL_GRACE_MS, SETTLED_PLAN_RETENTION_MS, pruneExpiredRecords } from '../src/rights/service.js';

const DAY = 86_400_000;

test('the vault drops expired material, its evidence and finished plans, and keeps everything still needed', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const state = {
    materials: { old: { retention_until: now - EXPIRED_MATERIAL_GRACE_MS - 1 }, recent: { retention_until: now - DAY }, live: { retention_until: now + DAY } },
    evidence: { onOld: { material_id: 'old', bundle: { expires_at: iso(now + DAY) } }, lapsed: { material_id: 'live', bundle: { expires_at: iso(now - EXPIRED_MATERIAL_GRACE_MS - 1) } },
      kept: { material_id: 'live', bundle: { expires_at: iso(now + DAY) } } },
    evidence_reviews: { a: { evidence_id: 'onOld' }, b: { evidence_id: 'kept' } },
    plans: {
      oldDraft: { status: 'draft', prepared_at: now - SETTLED_PLAN_RETENTION_MS - 1 },
      oldConfirmed: { status: 'confirmed', prepared_at: now - 2 * SETTLED_PLAN_RETENTION_MS, checkpoint_at: now - SETTLED_PLAN_RETENTION_MS - 1 },
      oldPending: { status: 'broadcast_prepared', prepared_at: now - 2 * SETTLED_PLAN_RETENTION_MS },
      oldReconciling: { status: 'reconciling', prepared_at: now - 2 * SETTLED_PLAN_RETENTION_MS },
      recentConfirmed: { status: 'confirmed', prepared_at: now - DAY }
    },
    publications: { old: { publication_id: 'old' } }, financing_disclosures: { '0xabc': { material_id: 'old' } }, subjects: { s: {} }
  };
  pruneExpiredRecords(state, now);
  assert.deepEqual(Object.keys(state.materials).sort(), ['live', 'recent']);
  assert.deepEqual(Object.keys(state.evidence), ['kept']);
  assert.deepEqual(Object.keys(state.evidence_reviews), ['b']);
  assert.deepEqual(Object.keys(state.plans).sort(), ['oldPending', 'oldReconciling', 'recentConfirmed']);
  assert.ok(state.publications.old && state.financing_disclosures['0xabc'] && state.subjects.s, 'published terms and identities stay');
});
