import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const releaseRoot = path.resolve(import.meta.dirname, '../..');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
// Keep the byte-level evidence digest comparable with the future Git checkout.
// Respect -text fixtures and vendored bundles rather than rewriting all text.
export function lfSourcePaths(attributeOutput) {
  const fields = attributeOutput.toString().split('\0'), attributes = new Map();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [file, name, value] = fields.slice(i, i + 3);
    if (!attributes.has(file)) attributes.set(file, {});
    attributes.get(file)[name] = value;
  }
  return [...attributes].filter(([, values]) => values.eol === 'lf' && values.text !== 'unset').map(([file]) => file);
}
export async function releaseSourceByteIssues(source) {
  const attributes = execFileSync('git', ['check-attr', '-z', '--stdin', 'text', 'eol'], {
    cwd: releaseRoot, input: source.files.map((file) => file.path + '\0').join('')
  });
  const issues = [];
  for (const file of lfSourcePaths(attributes)) {
    if ((await fs.readFile(path.join(releaseRoot, file))).includes(Buffer.from('\r\n'))) issues.push(file);
  }
  return issues;
}
export async function releaseSourceSnapshot() {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: releaseRoot }).toString().split('\0')
    .filter((file) => file && (/^(?:src|web|scripts|tests|public|data|\.github)\//u.test(file) || /^hardhat\/(?:contracts|test|scripts)\//u.test(file)
      || /^(?:hardhat\/)?(?:package(?:-lock)?\.json|hardhat\.config\.js)$/u.test(file)
      || /^(?:Dockerfile|docker-compose\.yml|\.dockerignore|\.gitignore|\.gitattributes|\.env\.example|eslint\.config\.js|playwright\.config\.js)$/u.test(file)))
    .filter((file) => !file.startsWith('data/runtime/') && !file.endsWith('.log'));
  const deleted = new Set(execFileSync('git', ['ls-files', '--deleted', '-z'], { cwd: releaseRoot }).toString().split('\0'));
  const files = await Promise.all([...new Set(names.filter((name) => !deleted.has(name)))].sort().map(async (file) => ({ path: file, sha256: digest(await fs.readFile(path.join(releaseRoot, file))) })));
  return { schema: 'agentbl-release-source-v1', base_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: releaseRoot }).toString().trim(),
    source_sha256: digest(files.map((file) => `${file.path}\0${file.sha256}\n`).join('')), file_count: files.length, files,
    scope: 'exact application, contracts, deploy scripts, tests, fixtures, lockfiles, CI and image build inputs; secrets/runtime/evidence excluded' };
}
