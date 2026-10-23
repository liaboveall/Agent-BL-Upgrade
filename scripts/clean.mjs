import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only reproducible development output. Runtime, evidence, secrets and installed
// application/contract dependencies are deliberately outside this list.
const outputs = ['dist', 'hardhat/artifacts', 'hardhat/cache', 'test-results',
  'playwright-report', 'coverage', '.playwright-cli', 'scripts/vendor/node_modules'];

export async function cleanGenerated(root, { dryRun = false } = {}) {
  const canonicalRoot = await fs.realpath(root);
  const targets = [];
  for (const relative of outputs) {
    const target = path.resolve(canonicalRoot, relative);
    if (!target.startsWith(canonicalRoot + path.sep)) throw new Error(`Outside project: ${relative}`);
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // Reject links, junctions and redirected parents, including redirects into
    // the project's own persistent state. Validate every target before deleting.
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(target) !== target) {
      throw new Error(`Refusing redirected or non-directory output: ${relative}`);
    }
    targets.push({ relative, target });
  }
  if (!dryRun) for (const { target } of targets) await fs.rm(target, { recursive: true, force: true });
  return targets.map(({ relative }) => relative);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg !== '--dry-run')) throw new Error('Usage: npm run clean -- [--dry-run]');
  const dryRun = args.includes('--dry-run');
  const removed = await cleanGenerated(path.resolve(import.meta.dirname, '..'), { dryRun });
  console.log(`${dryRun ? 'Would remove' : 'Removed'}: ${removed.join(', ') || 'no generated output'}`);
}
