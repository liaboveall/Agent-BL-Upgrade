import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyEvidencePackage } from '../src/evidence/schema.js';

export async function verifyEvidenceFile(file, options) {
  return verifyEvidencePackage(JSON.parse(await fs.readFile(file, 'utf8')), options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(3), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--expected-root') options.expectedCommitment = args[i + 1];
      else if (args[i] === '--anchor') options.anchor = JSON.parse(await fs.readFile(args[i + 1], 'utf8'));
      else throw new Error('Unsupported evidence verification option');
    }
    const result = await verifyEvidenceFile(process.argv[2], options);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1;
  } catch { console.error('Evidence package is missing or unreadable'); process.exitCode = 1; }
}
