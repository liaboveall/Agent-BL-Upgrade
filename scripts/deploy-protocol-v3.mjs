// Default: write a public deployment plan. --execute --step N sends only that reviewed step.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { JsonRpcProvider, FetchRequest, Wallet } from 'ethers';
import { CORE_V3, createProtocolV3Plan, executeProtocolV3Step, planDigest } from './lib/protocol-v3-deployment.mjs';
import { createOwnerJournal } from './lib/owner-journal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, 'docs/evidence/protocol-v3-deployment-2026-10-17');
const { values } = parseArgs({ options: { execute: { type: 'boolean', default: false }, step: { type: 'string' } } });
const config = JSON.parse(await fs.readFile(path.join(root, 'public/chain-config.json'), 'utf8'));
const request = new FetchRequest(config.networks['injective-testnet'].rpcUrls[0]); request.timeout = 20000;
const provider = new JsonRpcProvider(request, 1439, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: 0 });
try {
  if (Number(await provider.send('eth_chainId', [])) !== 1439) throw new Error('Wrong RPC chain');
  const artifacts = Object.fromEntries(await Promise.all(CORE_V3.map(async (name) => [name,
    JSON.parse(await fs.readFile(path.join(root, `hardhat/artifacts/contracts/${name}.sol/${name}.json`), 'utf8'))])));
  const planFile = path.join(evidence, 'plan.json');
  if (!values.execute) {
    const inventory = JSON.parse(await fs.readFile(path.join(evidence, 'legacy-inventory-before.json'), 'utf8'));
    const plan = await createProtocolV3Plan({ inventory, chainRegistry: config, artifacts,
      gasPrice: BigInt(await provider.send('eth_gasPrice', [])), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() });
    // An existing plan is immutable; reconcile its commitments instead of assigning new nonces.
    try { await fs.writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || planDigest(JSON.parse(await fs.readFile(planFile, 'utf8'))) !== planDigest(plan)) throw new Error('A different deployment plan already exists', { cause: error });
    }
    await fs.writeFile(path.join(evidence, 'chain-config-before.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    console.log(JSON.stringify({ dry_run: true, plan_sha256: planDigest(plan), addresses: plan.addresses,
      transaction_count: plan.transactions.length, maximum_fee_wei: plan.maximum_fee_wei, broadcasts: 0 }, null, 2));
  } else {
    const index = Number(values.step);
    if (values.step === undefined || !Number.isSafeInteger(index) || index < 0 || index > 6) throw new Error('An explicit --step 0..6 is required');
    const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
    if (planDigest(config) !== plan.chain_registry_sha256) throw new Error('The chain registry changed after planning');
    await import('../src/env.js');
    const owner = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    if (new Wallet(process.env.PRICING_UPDATER_PRIVATE_KEY).address !== plan.updater) throw new Error('Dedicated updater changed after planning');
    const journal = createOwnerJournal(path.join(root, 'data/runtime/protocol-v3-deployment-2026-10-17'));
    const result = await executeProtocolV3Step({ plan, stepIndex: index, owner, provider, journal, artifacts });
    await fs.writeFile(path.join(evidence, `transaction-${index}.json`), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  // Errors from signing/RPC libraries can contain sensitive request context. Do not print them.
  console.error(`Protocol v3 operation stopped (${error.code ?? error.name}). Inspect the public plan and owner journal; never blindly resend.`);
  process.exitCode = 1;
} finally { provider.destroy(); }
