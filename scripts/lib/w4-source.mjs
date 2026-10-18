import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export const w4Root = path.resolve(import.meta.dirname, '../..');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function w4SourceSnapshot() {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: w4Root }).toString().split('\0')
    .filter((file) => file && (/^(?:src|web|scripts|tests|public|data|\.github)\//u.test(file) || /^hardhat\/(?:contracts|test)\//u.test(file)
      || /^(?:hardhat\/)?(?:package(?:-lock)?\.json|hardhat\.config\.js)$/u.test(file)
      || /^(?:Dockerfile|docker-compose\.yml|\.env\.example|eslint\.config\.js|playwright\.config\.js)$/u.test(file)))
    .filter((file) => !file.startsWith('data/runtime/') && !file.endsWith('.log'));
  const files = await Promise.all([...new Set(paths)].sort().map(async (file) => ({ path: file, sha256: sha256(await fs.readFile(path.join(w4Root, file))) })));
  return { schema: 'agentbl-w4-source-manifest-v1', base_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: w4Root }).toString().trim(),
    source_sha256: sha256(files.map((file) => `${file.path}\0${file.sha256}\n`).join('')), file_count: files.length, files,
    scope: 'exact workspace bytes; application/contracts/tests/CI/public fixtures; secrets, runtime and evidence excluded; HEAD alone is not the dirty source revision' };
}
