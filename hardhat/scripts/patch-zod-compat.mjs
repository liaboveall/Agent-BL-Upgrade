// Keep the security-patched Zod override while hardhat-zod-utils still reads Zod 3's errors alias.
// Remove this shim once upstream uses the issues API, which is shared by Zod 3 and Zod 4.
import fs from 'node:fs/promises';

const manifest = JSON.parse(await fs.readFile(new URL(import.meta.resolve('@nomicfoundation/hardhat-zod-utils/package.json')), 'utf8'));
const entry = new URL(import.meta.resolve('@nomicfoundation/hardhat-zod-utils'));
const source = await fs.readFile(entry, 'utf8');
const before = 'return result.error.errors.map((issue) => ({';
const after = 'return result.error.issues.map((issue) => ({';

if (source.includes(before)) {
  if (manifest.version !== '3.0.8' || source.split(before).length !== 2) {
    throw new Error('Recheck the Hardhat Zod compatibility patch for hardhat-zod-utils ' + manifest.version);
  }
  await fs.writeFile(entry, source.replace(before, after));
  console.log('Applied Hardhat Zod compatibility patch (errors → issues)');
} else if (!source.includes(after)) {
  throw new Error('Hardhat Zod validation changed; recheck the compatibility patch before installing');
}

// `--verify`: prove the installed modules now report an invalid field instead of crashing (imported only after patching).
if (process.argv.includes('--verify')) {
  const { z } = await import('zod');
  const { validateUserConfigZodType } = await import('@nomicfoundation/hardhat-zod-utils');
  const schema = z.object({ networks: z.record(z.string(), z.object({ url: z.string() })) });
  const issues = validateUserConfigZodType({ networks: { bad: { url: 123 } } }, schema);
  if (issues.length !== 1 || issues[0].path.join('.') !== 'networks.bad.url') throw new Error('Hardhat configuration diagnostics are broken after install');
  console.log('Hardhat configuration diagnostics report networks.bad.url');
}
