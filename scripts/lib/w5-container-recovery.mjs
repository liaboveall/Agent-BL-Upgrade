// Replacement Linux container. Only the encrypted snapshot and separately mounted keys
// are available; the source host's runtime directory is never mounted.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Wallet } from 'ethers';
import { restoreRuntimeBackup } from '../../src/ops/backup.js';
import { verifyRuntimeMaterials } from '../../src/ops/runtime.js';
import { rightsKey, unseal } from '../../src/rights/vault.js';
import { RightsService } from '../../src/rights/service.js';
import { readJson, writeJsonAtomic } from '../../src/lib/jsonStore.js';
import { Ledger } from '../../src/ledger/ledger.js';
import { CapitalLedgerService } from '../../src/ledger/service.js';
import { loadRightsChain } from '../../src/rights/chain.js';
import { controlledCapitalConfig } from '../../src/app/controlledRoutes.js';
import { hashSnapshot } from '../../src/agent/decisionLogger.js';

const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const started = Date.now(), root = '/tmp/agentbl-restored';
const backupKey = Buffer.from((await fs.readFile('/run/secrets/backup-key.hex', 'utf8')).trim(), 'hex');
const env = { AGENTBL_RIGHTS_KEY: (await fs.readFile('/run/secrets/rights-key.hex', 'utf8')).trim() };
const restored = await restoreRuntimeBackup({ input: '/restore/backup.json', directory: root, key: backupKey });
const configuration = restored.configuration, instance = configuration.rights_instance;
ensure(configuration.expected_positions_hash, 'Recovery inventory is incomplete');
const readonlyOffhost = configuration.recovery_mode === 'readonly_offhost';
ensure(readonlyOffhost || configuration.encrypted_signers, 'Signing recovery bundle is missing');
const issuer = readonlyOffhost ? Wallet.createRandom() : new Wallet(unseal(backupKey, configuration.encrypted_signers, 'agentbl-w5-research-signers-v1').issuer);
await verifyRuntimeMaterials(root, env);
const vault = unseal(rightsKey(env), await readJson(path.join(root, 'rights/vault.json')), 'agentbl-rights-vault-v1');
const rights = new RightsService({ directory: path.join(root, 'rights'), env });
const subject = readonlyOffhost ? await rights.createSubject({ organization: 'W5_RESEARCH', wallet: issuer.address, roles: ['issuer'] })
  : Object.values(vault.subjects).find((s) => s.wallet.toLowerCase() === issuer.address.toLowerCase() && s.roles.includes('issuer'));
ensure(subject && !subject.revoked, 'Recovered issuer identity is unavailable');
const challenge = await rights.createChallenge(subject.subject_id);
const session = await rights.openSession({ challenge_id: challenge.challenge_id, signature: await issuer.signTypedData(challenge.domain, challenge.types, challenge.message) });
const evidenceId = Object.keys(vault.evidence ?? {})[0], pack = await rights.exportEvidence(session.token, evidenceId);
ensure(pack.verification.passed, 'Restored private evidence did not verify');
const cfgFile = '/tmp/rights-instance.json'; await writeJsonAtomic(cfgFile, instance);
const chain = await loadRightsChain(cfgFile);
let positions, ledgerHash;
try {
  const cfg = controlledCapitalConfig(instance), ledger = new Ledger({ baseDir: path.join(root, `controlled-capital-${cfg.contracts.RWAOfferingPool.toLowerCase()}`) });
  const capital = new CapitalLedgerService({ ledger, chainConfig: cfg, getContext: async () => ({ provider: chain.provider }), getMode: () => 'live', confirmations: 3 });
  positions = await capital.list(instance.actors.investor);
  ensure(!positions.warning && positions.positions.every((p) => p.reconciled), 'Replacement container cannot reconcile canonical positions');
  ledgerHash = hashSnapshot(await ledger.listPositions()); ensure(ledgerHash === configuration.expected_positions_hash, 'Restored shares or capital differ from source ledger');
} finally { await chain.provider.destroy(); }
const report = { schema: 'agentbl-w5-container-recovery-v1', passed: true, generated_at: new Date().toISOString(),
  replacement: { platform: process.platform, hostname: os.hostname(), node: process.version }, source_runtime_mounted: false,
  isolation: readonlyOffhost ? 'Independent GitHub-hosted replacement machine; source Windows host is not an input or network dependency'
    : 'replacement Linux container on the same physical Windows host; not an independent physical-host disaster drill',
  key_takeover: readonlyOffhost ? 'Restored vault key and a new authenticated research recovery operator; original transaction-signing keys were not supplied'
    : 'Recovered encrypted research issuer key signed a fresh business-session challenge; no transaction broadcast',
  snapshot_source_revision: restored.source_revision, files: restored.file_count, ledger_hash: ledgerHash,
  positions: positions.positions.map((p) => ({ pool_id: p.chain_pool_id, shares: p.shares, cost_atomic: p.cost_atomic, claimed_atomic: p.claimed_atomic, refunded_atomic: p.refunded_atomic })),
  private_evidence_verified: pack.verification.passed, evidence_package_hash: pack.package_hash,
  elapsed_ms: Date.now() - started, rto_target_ms: 300000, real_business: false, broadcasts: 0 };
ensure(report.elapsed_ms < report.rto_target_ms, 'Replacement recovery exceeded its RTO target');
console.log(JSON.stringify(report));
