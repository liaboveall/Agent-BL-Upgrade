// Build the React dashboard for Node once per test file and import its render entry
// (web/src/testing/ssr.jsx). Everything is bundled, so the output runs from a temp directory.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadWebSsr() {
  const { build } = await import('vite');
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-web-ssr-'));
  await build({
    configFile: path.join(root, 'web', 'vite.config.js'),
    logLevel: 'silent',
    publicDir: false,
    ssr: { noExternal: true },
    build: {
      ssr: path.join(root, 'web', 'src', 'testing', 'ssr.jsx'),
      outDir,
      emptyOutDir: true,
      copyPublicDir: false,
      rollupOptions: { output: { entryFileNames: 'ssr.mjs' } }
    }
  });
  const module = await import(pathToFileURL(path.join(outDir, 'ssr.mjs')).href);
  return { ...module, cleanup: () => fs.rm(outDir, { recursive: true, force: true }) };
}
