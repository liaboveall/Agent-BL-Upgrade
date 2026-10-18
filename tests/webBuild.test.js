// The production build must run under the server's CSP (script-src 'self'): no inline script,
// no third-party origin, and every file the page references present in the output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the Vite build is CSP-clean and self-contained', async (t) => {
  const { build } = await import('vite');
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-web-build-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  await build({ configFile: path.join(root, 'web', 'vite.config.js'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });

  const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
  for (const tag of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)) {
    assert.match(tag[1], /\bsrc="\/assets\//u, `every script is an external same-origin file: ${tag[0]}`);
    assert.equal(tag[2].trim(), '', 'no inline script body');
  }
  assert.doesNotMatch(html, /\bon[a-z]+="/u, 'no inline event handlers');
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//u, 'no third-party origins');

  const referenced = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/gu)].map((match) => match[1]);
  assert.ok(referenced.some((url) => url.endsWith('.js')) && referenced.some((url) => url.endsWith('.css')));
  for (const url of referenced) await fs.access(path.join(outDir, url));

  // public/ is copied as-is: the chain registry and the vendored wallet SDKs are served from the build too.
  for (const file of ['application-config.json', 'vendor/manifest.json', 'img/cargo/copper.webp']) await fs.access(path.join(outDir, file));

  const assets = await fs.readdir(path.join(outDir, 'assets'));
  for (const name of assets.filter((file) => file.endsWith('.js'))) {
    const code = await fs.readFile(path.join(outDir, 'assets', name), 'utf8');
    assert.doesNotMatch(code, /\beval\(|new Function\(/u, `${name} must not need 'unsafe-eval'`);
    // LLM keys stay on the server (the admin token is only named in its prompt text, never bundled).
    assert.doesNotMatch(code, /DEEPSEEK_API_KEY|DASHSCOPE_API_KEY|OPENAI_API_KEY|LLM_API_KEY/u, `${name} must not reference the LLM keys`);
  }
});
