import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireRuntimeLease } from '../../src/ops/lease.js';
import { Ledger } from '../../src/ledger/ledger.js';
import { RightsService } from '../../src/rights/service.js';

const [operation, directory, payloadFile] = process.argv.slice(2);
if (operation === 'lease') {
  const release = await acquireRuntimeLease(directory);
  process.send?.({ acquired: true });
  process.on('message', async () => { await release(); process.exit(0); });
  setInterval(() => {}, 1000);
} else if (operation === 'recover') {
  const input = JSON.parse(await fs.readFile(payloadFile, 'utf8'));
  const ledger = new Ledger({ baseDir: path.join(directory, 'capital') });
  const rights = new RightsService({ directory: path.join(directory, 'rights'), env: { AGENTBL_RIGHTS_KEY: input.key } });
  const material = await rights.invoke(input.session, 'read_material', input.material_id, 'http');
  const pack = await rights.exportEvidence(input.session, input.evidence_id);
  console.log(JSON.stringify({ positions: await ledger.listPositions(), material_id: material.material_id, evidence_verified: pack.verification.passed }));
} else throw new Error('Unsupported worker action');
