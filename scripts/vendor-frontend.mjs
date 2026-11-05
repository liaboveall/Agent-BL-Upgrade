// Self-hosted browser dependencies (public/vendor).
//
// The dashboard used to import ethers and @cosmjs/stargate from esm.sh / jsDelivr at
// runtime. A wallet-connected page should not execute third-party code fetched at
// load time (a compromised CDN could request signatures), so both modules are
// committed under public/vendor and the CSP only allows same-origin scripts.
//
//   node scripts/vendor-frontend.mjs           verify files against the manifest (offline)
//   node scripts/vendor-frontend.mjs --build   rebuild everything from pinned sources
//
// ethers comes from the root node_modules (version pinned in package.json);
// @cosmjs/stargate is bundled by esbuild from scripts/vendor (lockfile-pinned).
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'public', 'vendor');
const buildDir = path.join(root, 'scripts', 'vendor');
const manifestPath = path.join(vendorDir, 'manifest.json');
const MANIFEST_SCHEMA = 'agentbl-vendor-manifest-v1';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * The packages esbuild put into a bundle, as sorted `name@version` strings, from its metafile and the lock it was built from.
 * What ships to browsers is this list, not everything the lock installs: a dependency advisory matters to users only for a
 * package in here (scripts/audit-vendor.mjs), and the licence table lists exactly these. Metafile inputs are paths such as
 * `scripts/vendor/node_modules/elliptic/node_modules/bn.js/lib/bn.js`; the lock key is the part from the first `node_modules/`
 * through the package directory after the last one.
 */
export function bundledPackages(metafile, lock) {
  const found = new Set();
  for (const input of Object.keys(metafile?.inputs ?? {})) {
    const file = input.replaceAll('\\', '/'), first = file.indexOf('node_modules/');
    if (first < 0) continue; // the entry file, the crypto stub and `(disabled):` modules
    const rest = file.slice(first), last = rest.lastIndexOf('node_modules/') + 'node_modules/'.length;
    const segments = rest.slice(last).split('/'), name = segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
    const entry = lock.packages?.[`${rest.slice(0, last)}${name}`];
    if (!entry?.version) throw new Error(`bundled input ${input} has no entry in the vendor lock`);
    found.add(`${name}@${entry.version}`);
  }
  return [...found].sort();
}

function rootDependencyVersion(name) {
  return readJson(path.join(root, 'package.json')).dependencies?.[name];
}

/** Everything under public/vendor except the manifest and docs, relative to that folder. */
export function vendoredFiles() {
  return fs.readdirSync(vendorDir)
    .filter((name) => !['manifest.json', 'README.md', 'THIRD_PARTY_LICENSES.md'].includes(name))
    .sort();
}

/** Returns a list of problems; empty means the vendor folder is consistent. */
export function verifyVendor() {
  const problems = [];
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return [`public/vendor/manifest.json is unreadable: ${error.message}`];
  }
  if (manifest.schema !== MANIFEST_SCHEMA) problems.push(`manifest schema must be ${MANIFEST_SCHEMA}`);

  const listed = new Set(Object.keys(manifest.files ?? {}));
  for (const name of vendoredFiles()) {
    if (!listed.has(name)) problems.push(`${name} is in public/vendor but not in the manifest`);
  }
  for (const [name, entry] of Object.entries(manifest.files ?? {})) {
    const file = path.join(vendorDir, name);
    if (!fs.existsSync(file)) {
      problems.push(`${name} is listed in the manifest but missing`);
      continue;
    }
    const actual = sha256(fs.readFileSync(file));
    if (actual !== entry.sha256) problems.push(`${name}: sha256 ${actual} does not match the manifest (${entry.sha256})`);
    if (!name.includes(entry.version)) problems.push(`${name}: file name must contain its version ${entry.version}`);
  }

  // A bundle built from the vendor lock says which of the lock's packages it contains: that is what the dependency audit
  // (scripts/audit-vendor.mjs) reasons about. Every listed package must still be exactly what the lock resolves.
  const lock = fs.existsSync(path.join(buildDir, 'package-lock.json')) ? readJson(path.join(buildDir, 'package-lock.json')) : null;
  for (const [name, entry] of Object.entries(manifest.files ?? {})) {
    if (!/^scripts\/vendor\b/u.test(entry.source ?? '')) continue;
    if (!Array.isArray(entry.bundled_packages) || entry.bundled_packages.length === 0) {
      problems.push(`${name}: the manifest must list the packages bundled into it (bundled_packages); run npm run vendor:build`);
      continue;
    }
    const locked = new Set(Object.entries(lock?.packages ?? {}).filter(([key]) => key.startsWith('node_modules/'))
      .map(([key, pkg]) => `${key.replace(/^.*node_modules\//u, '')}@${pkg.version}`));
    for (const item of entry.bundled_packages) if (!locked.has(item)) problems.push(`${name}: bundled package ${item} is not what scripts/vendor/package-lock.json resolves`);
    if (entry.bundled_packages.join('\n') !== [...entry.bundled_packages].sort().join('\n')) problems.push(`${name}: bundled_packages must be sorted`);
  }

  const ethers = Object.entries(manifest.files ?? {}).find(([, entry]) => entry.package === 'ethers');
  if (ethers && ethers[1].version !== rootDependencyVersion('ethers')) {
    problems.push(`vendored ethers ${ethers[1].version} differs from package.json (${rootDependencyVersion('ethers')}); run npm run vendor:build`);
  }
  return problems;
}

function buildEthers() {
  const version = rootDependencyVersion('ethers');
  const installed = readJson(path.join(root, 'node_modules', 'ethers', 'package.json'));
  if (installed.version !== version) {
    throw new Error(`node_modules has ethers ${installed.version}, package.json pins ${version}; run npm ci first`);
  }
  const name = `ethers-${version}.min.js`;
  fs.copyFileSync(path.join(root, 'node_modules', 'ethers', 'dist', 'ethers.min.js'), path.join(vendorDir, name));
  return { name, package: 'ethers', version, license: installed.license, source: 'node_modules/ethers/dist/ethers.min.js' };
}

function buildCosmjs() {
  // Fixed command line (no user input), so a shell string is fine and works with npm.cmd on Windows.
  execSync(`npm ci --prefix "${buildDir}" --no-audit --no-fund`, { stdio: 'inherit' });

  const require = createRequire(path.join(buildDir, 'package.json'));
  const esbuild = require('esbuild');
  const lock = readJson(path.join(buildDir, 'package-lock.json'));
  const version = lock.packages['node_modules/@cosmjs/stargate'].version;
  const name = `cosmjs-stargate-${version}.js`;
  const { metafile } = esbuild.buildSync({
    entryPoints: [path.join(buildDir, 'entry-cosmjs.js')],
    outfile: path.join(vendorDir, name),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    // Which packages end up inside the bundle (the metafile does not change the output bytes).
    metafile: true,
    // @cosmjs/crypto only reaches for node:crypto when WebCrypto is missing (never in a browser).
    alias: { crypto: path.join(buildDir, 'node-crypto-stub.js') }
  });
  return {
    name,
    package: '@cosmjs/stargate',
    version,
    license: lock.packages['node_modules/@cosmjs/stargate'].license ?? 'Apache-2.0',
    source: `scripts/vendor (esbuild ${lock.packages['node_modules/esbuild'].version}, lockfile-pinned)`,
    bundled_packages: bundledPackages(metafile, lock)
  };
}

/** Licence rows for exactly the packages in a bundle (`name@version` strings), taken from the lock they were resolved from. */
export function licenseRows(bundled, lock) {
  const byIdentity = new Map(Object.entries(lock.packages ?? {}).filter(([key]) => key.startsWith('node_modules/'))
    .map(([key, pkg]) => [`${key.replace(/^.*node_modules\//u, '')}@${pkg.version}`, pkg]));
  return bundled.map((identity) => {
    const pkg = byIdentity.get(identity);
    if (!pkg) throw new Error(`${identity} is not in the vendor lock`);
    const at = identity.lastIndexOf('@');
    return `| ${identity.slice(0, at)} | ${identity.slice(at + 1)} | ${pkg.license ?? 'see package'} |`;
  }).sort();
}

export function thirdPartyLicenses(ethersEntry, cosmjsEntry) {
  const lock = readJson(path.join(buildDir, 'package-lock.json'));
  const rows = licenseRows(cosmjsEntry.bundled_packages, lock);
  return [
    '# Third-party licenses (public/vendor)',
    '',
    'Generated by `node scripts/vendor-frontend.mjs --build`. Each module is redistributed under its own license;',
    'consult the upstream package for the full license text.',
    '',
    `## ${ethersEntry.name}`,
    '',
    `ethers ${ethersEntry.version} — ${ethersEntry.license}. Unmodified build from the npm package.`,
    '',
    '## cosmjs-stargate bundle',
    '',
    'Contains exactly the following packages (the ones esbuild bundled, resolved from scripts/vendor/package-lock.json;',
    'build tooling and dependencies the browser build leaves out are not listed):',
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
    ...rows,
    ''
  ].join('\n');
}

function build() {
  fs.mkdirSync(vendorDir, { recursive: true });
  for (const name of vendoredFiles()) fs.rmSync(path.join(vendorDir, name));
  const entries = [buildEthers(), buildCosmjs()];
  const files = {};
  for (const entry of entries) {
    files[entry.name] = {
      package: entry.package,
      version: entry.version,
      license: entry.license,
      source: entry.source,
      ...(entry.bundled_packages ? { bundled_packages: entry.bundled_packages } : {}),
      sha256: sha256(fs.readFileSync(path.join(vendorDir, entry.name)))
    };
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify({ schema: MANIFEST_SCHEMA, files }, null, 2)}\n`);
  fs.writeFileSync(path.join(vendorDir, 'THIRD_PARTY_LICENSES.md'), thirdPartyLicenses(entries[0], entries[1]));
  console.log(`vendor: rebuilt ${entries.map((entry) => entry.name).join(', ')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--build')) build();
  const problems = verifyVendor();
  if (problems.length > 0) {
    console.error(`vendor check failed:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('vendor check passed: public/vendor matches manifest.json');
}
