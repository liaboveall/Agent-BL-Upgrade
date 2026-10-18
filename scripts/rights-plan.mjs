import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Never imports env.js, creates a signer, requests a key or broadcasts.
const root = path.resolve(import.meta.dirname, '..');
const names = ['RightsGovernance', 'AssetIdentityHub', 'CommittedEBLRegistry', 'RightsController', 'ControlledRWAToken', 'RWAOfferingPoolV5'];
export async function rightsDeploymentPlan() {
  const contracts = [];
  for (const name of names) {
    const file = path.join(root, 'hardhat/artifacts/contracts', `${name}.sol`, `${name}.json`);
    const a = JSON.parse(await fs.readFile(file, 'utf8'));
    const runtime_bytes = (a.deployedBytecode.length - 2) / 2;
    const initcode_bytes = (a.bytecode.length - 2) / 2 + (name === 'RightsController' ? 64 : name === 'CommittedEBLRegistry' ? 64 : name === 'AssetIdentityHub' ? 32 : name === 'RightsGovernance' ? 192 : name === 'RWAOfferingPoolV5' ? 64 : 0);
    if (runtime_bytes > 24576 || initcode_bytes > 49152) throw new Error(`${name} exceeds a standard EVM size limit`);
    contracts.push({ name, artifact_sha256: createHash('sha256').update(JSON.stringify(a)).digest('hex'), runtime_bytes, initcode_bytes,
      deployment: ['ControlledRWAToken', 'RWAOfferingPoolV5'].includes(name) ? 'created_by_controller' : 'separate' });
  }
  return { schema: 'agentbl-w3-deployment-review-v1', scope: 'research_test_assets_only', execution: 'dry_run_only',
    compiler: { version: '0.8.24', viaIR: true, evmVersion: 'paris', optimizerRuns: 200, openzeppelin: '5.1.0' }, contracts,
    required_inputs: ['three independent governor addresses', 'issuer / holder / valuer / operator / attestor / compliance / disposer / reviewer / guardian addresses',
      'reviewed test settlement asset', 'shared hub and historical title alias inventory', 'encrypted material custody and separately backed-up vault key', 'approved notice and distribution policy'],
    steps: ['freeze source and artifacts; inventory existing instances read-only', 'deploy governance with 2-of-3 membership and minimum 3600 second delay',
      'deploy shared hub and committed registry under governance', 'deploy controller; read back its fresh capital pool and fixed token',
      'activate controller once; verify pool owner/oracle/gate/mode and token binding', 'two governors approve registry enrollment, source issuer and controller binding; wait the delay',
      'two governors approve operational roles and test-asset allowlist; verify no raw pool executor', 'import reviewed legacy aliases before permitting controlled issuance',
      'verify identities, sign source and valuation credentials, collect holder consent, publish two-reviewer disclosure',
      'authorize a bounded testnet scenario separately, then enable intake through delayed governance', 'retain old configurations, assets, positions, pending transactions and recovery evidence'],
    untouched: ['public/chain-config.json', 'existing contracts and owner keys', 'existing runtime and ledgers'],
    business_enabled: false, broadcast: false, real_asset_and_legal_proof: 'required_before_real_business' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length) throw new Error('rights:plan accepts no execution flags');
  console.log(JSON.stringify(await rightsDeploymentPlan(), null, 2));
}
