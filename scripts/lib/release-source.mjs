import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const releaseRoot = path.resolve(import.meta.dirname, '../..');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
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
