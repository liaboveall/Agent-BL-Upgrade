// Synthetic stopped-runtime recovery in the actual candidate image. No RPC or transaction signer.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { restoreRuntimeBackup } from '../../src/ops/backup.js';
import { verifyRuntimeMaterials } from '../../src/ops/runtime.js';
import { Ledger } from '../../src/ledger/ledger.js';
import { hashSnapshot } from '../../src/agent/decisionLogger.js';

const started = Date.now(), root = '/tmp/n5-restored';
const key = Buffer.from((await fs.readFile('/run/secrets/backup-key.hex', 'utf8')).trim(), 'hex');
await assert.rejects(restoreRuntimeBackup({ input: '/restore/backup.json', directory: root, key: randomBytes(32) }));
await assert.rejects(fs.access(root), { code: 'ENOENT' });
const restored = await restoreRuntimeBackup({ input: '/restore/backup.json', directory: root, key });
const env = { AGENTBL_RIGHTS_KEY: (await fs.readFile('/run/secrets/rights-key.hex', 'utf8')).trim() };
const verified = await verifyRuntimeMaterials(root, env);
assert.equal(verified.initialized_stores_verified, 1);
await assert.rejects(verifyRuntimeMaterials(root, { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') }));
const ledger = new Ledger({ baseDir: path.join(root, 'synthetic-capital') });
const positions = await ledger.listPositions();
assert.equal(hashSnapshot(positions), restored.configuration.expected_positions_hash);
assert.equal(positions.length, 2);
assert.equal(positions.reduce((sum, p) => sum + BigInt(p.cost_atomic), 0n), 8000000n);
assert.equal(positions.reduce((sum, p) => sum + BigInt(p.shares), 0n), 10n);
await fs.rename(path.join(root, 'rights/vault.json'), path.join(root, 'rights/vault-OFFLINE.json'));
await assert.rejects(verifyRuntimeMaterials(root, env));
console.log(JSON.stringify({ schema: 'agentbl-n5-container-recovery-v1', passed: true, source_sha256: restored.source_revision,
  synthetic_ledger: true, positions: positions.map(({ shares, cost_atomic }) => ({ shares, cost_atomic })), wrong_backup_key_rejected: true,
  wrong_vault_key_rejected: true, missing_history_rejected: true, source_runtime_mounted: false, original_signing_keys_supplied: false,
  public_broadcasts: 0, elapsed_ms: Date.now() - started, platform: process.platform, node: process.version }));
