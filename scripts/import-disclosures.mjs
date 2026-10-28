// Copy approved financing terms from public records into data/disclosures/ so any checkout can show them.
//
//   npm run disclosures:import -- <record.json>... [--config <rights-instance.json>] [--dry-run]
//
// A record is any JSON file that contains disclosure packs, such as an instance's deployment-state.json or
// public-evidence/*.json. A pack is copied only when it recomputes to its own hash and the configured instance has an
// offering whose on-chain termsHash and disclosureHash are exactly that pack's; nothing private is read or written.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Contract, FetchRequest, JsonRpcProvider } from 'ethers';
import { verifyDisclosure } from '../src/rights/disclosure.js';
import { SHIPPED_DISCLOSURES, savePublicDisclosure } from '../src/rights/public-disclosures.js';

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index < 0 ? null : args.splice(index, 2)[1]; };
const configFile = flag('--config') ?? 'public/rights-instance.json';
const dryRun = args.includes('--dry-run');
const files = args.filter((arg) => arg !== '--dry-run');
if (!files.length) {
  console.error('Usage: npm run disclosures:import -- <record.json>... [--config <rights-instance.json>] [--dry-run]');
  process.exit(2);
}

const packs = new Map();
const collect = (value) => {
  if (!value || typeof value !== 'object') return;
  if (value.document?.schema === 'agentbl-financing-disclosure-v1' && typeof value.disclosure_hash === 'string' && verifyDisclosure(value)) {
    packs.set(value.disclosure_hash.toLowerCase(), value);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) collect(child);
};
for (const file of files) collect(JSON.parse(await fs.readFile(file, 'utf8')));

const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
const rpc = new FetchRequest(config.rpc_url); rpc.timeout = 20_000;
const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
const controller = new Contract(config.contracts.RightsController, [
  'function termsHash(uint256) view returns (bytes32)',
  'function terms(uint256) view returns (uint256 eblId,bytes32 assetKey,bytes32 documentHash,address settlementAsset,address exporter,address feeRecipient,uint256 supply,uint256 issuePrice,uint256 target,uint256 minRaise,uint64 maturity,uint64 subscribeUntil,uint64 disburseUntil,uint256 maxFee,bytes32 policyHash,bytes32 disclosureHash,uint256 nonce)'
], provider);
const pool = new Contract(config.contracts.RWAOfferingPoolV5, ['function nextPoolId() view returns (uint256)'], provider);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
let copied = 0, present = 0;
try {
  const next = Number(await pool.nextPoolId());
  for (let poolId = 1; poolId < next; poolId++) {
    const [terms, termsHash] = await Promise.all([controller.terms(poolId), controller.termsHash(poolId)]);
    const pack = packs.get(String(terms.disclosureHash).toLowerCase());
    const instance = pack?.document.instance;
    if (!pack || !same(pack.terms_hash, termsHash) || Number(instance.chain_id) !== Number(config.chain_id)
      || !same(instance.controller, config.contracts.RightsController) || !same(instance.pool, config.contracts.RWAOfferingPoolV5)) {
      console.log(`#${poolId}: no matching public pack in the given records`);
      continue;
    }
    if (dryRun) { console.log(`#${poolId}: ${pack.disclosure_hash} verified`); continue; }
    if (await savePublicDisclosure(SHIPPED_DISCLOSURES, pack)) copied++; else present++;
  }
  console.log(`${dryRun ? 'dry run' : `copied ${copied}, already present ${present}`} → ${path.relative(process.cwd(), SHIPPED_DISCLOSURES)}`);
} finally {
  provider.destroy();
}
