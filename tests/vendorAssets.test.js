// Third-party browser code is self-hosted and integrity-checked. The page used to
// import ethers / cosmjs from esm.sh and jsDelivr at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { vendoredFiles, verifyVendor } from '../scripts/vendor-frontend.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const web3Path = path.join(root, 'web', 'src', 'lib', 'web3.js');

/** Every dashboard source: web/index.html, web/src (React + helpers) and the files kept in public/. */
function frontendFiles() {
  const out = [path.join(root, 'web', 'index.html')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'vendor') walk(full); }
      else if (/\.(js|jsx|html|css)$/u.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(root, 'web', 'src'));
  walk(publicDir);
  return out;
}
const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'vendor', 'manifest.json'), 'utf8'));

test('public/vendor matches its manifest (hashes, versions, no unlisted files)', () => {
  assert.deepEqual(verifyVendor(), []);
  assert.deepEqual(vendoredFiles(), Object.keys(manifest.files).sort());
});

test('the vendored ethers build is the version the backend pins', async () => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const [name, entry] = Object.entries(manifest.files).find(([, file]) => file.package === 'ethers');
  assert.equal(entry.version, rootPackage.dependencies.ethers);

  const ethers = await import(pathToFileURL(path.join(publicDir, 'vendor', name)).href);
  assert.equal(ethers.version, entry.version, 'embedded version string must match the manifest');
  for (const symbol of ['BrowserProvider', 'JsonRpcProvider', 'Contract', 'Interface', 'id', 'keccak256', 'formatEther', 'parseUnits']) {
    assert.equal(typeof ethers[symbol], 'function', `ethers.${symbol}`);
  }
});

test('the cosmjs bundle exports exactly what web3.js uses and imports no Node built-ins', () => {
  // The bundle targets browsers (its WASM loaders probe for Node at import time), so it
  // is inspected statically here and exercised for real in the browser smoke test.
  const [name] = Object.entries(manifest.files).find(([, file]) => file.package === '@cosmjs/stargate');
  const source = fs.readFileSync(path.join(publicDir, 'vendor', name), 'utf8');

  const exportClause = /export\s*\{([^}]*)\}\s*;?\s*$/u.exec(source.trimEnd());
  assert.ok(exportClause, 'bundle must end with a single ES export clause');
  const exported = exportClause[1].split(',').map((part) => part.trim().split(/\s+as\s+/u).pop()).sort();
  assert.deepEqual(exported, ['GasPrice', 'SigningStargateClient', 'calculateFee']);

  // Every symbol web3.js destructures from the module must be exported.
  const web3 = fs.readFileSync(web3Path, 'utf8');
  const used = /const\s*\{([^}]+)\}\s*=\s*await\s+loadCosmosStargate\(\)/u.exec(web3);
  assert.ok(used, 'web3.js must destructure the Cosmos SDK exports');
  for (const symbol of used[1].split(',').map((part) => part.trim())) assert.ok(exported.includes(symbol), `${symbol} is used by web3.js`);

  assert.ok(!/(?:from|import\()\s*["'](?:node:)?(?:fs|path|crypto|stream|buffer|os|net|http|https|zlib|util)["']/u.test(source),
    'a browser bundle must not import Node built-ins');
});

test('no frontend source loads code from a third-party origin', () => {
  const offenders = [];
  for (const full of frontendFiles()) {
    const file = path.relative(root, full);
    const source = fs.readFileSync(full, 'utf8');
    for (const match of source.matchAll(/(?:import\s*\(\s*|from\s+|<script[^>]*\ssrc=|@import\s+(?:url\()?)['"]?(https?:\/\/[^'")\s>]+)/giu)) {
      offenders.push(`${file}: ${match[1]}`);
    }
    for (const host of ['esm.sh', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com']) {
      if (source.includes(host)) offenders.push(`${file}: references ${host}`);
    }
  }
  assert.deepEqual(offenders, []);

  const web3 = fs.readFileSync(web3Path, 'utf8');
  for (const url of web3.matchAll(/(?:ETHERS|COSMOS_STARGATE)_MODULE_URL\s*=\s*'([^']+)'/gu)) {
    assert.ok(fs.existsSync(path.join(publicDir, url[1])), `${url[1]} must exist under public/`);
    assert.ok(Object.hasOwn(manifest.files, path.basename(url[1])), `${url[1]} must be listed in the manifest`);
  }
});

test('the browser code never reads an API key from the page or talks to an LLM provider directly', () => {
  // The server used to inject window.ENV = { DEEPSEEK_API_KEY } into every page and the
  // browser called the provider itself; now only the same-origin relay holds the key.
  const offenders = [];
  for (const full of frontendFiles()) {
    const file = path.relative(root, full);
    const source = fs.readFileSync(full, 'utf8');
    if (source.includes('window.ENV')) offenders.push(`${file}: reads window.ENV`);
    for (const host of ['api.deepseek.com', 'dashscope.aliyuncs.com', 'api.openai.com', 'tokenhub.tencentmaas.com']) {
      if (source.includes(host)) offenders.push(`${file}: references ${host}`);
    }
  }
  assert.deepEqual(offenders, []);
});
