// Assessment 2026-11-05 F04: the third lock file (scripts/vendor, the toolchain that builds the Keplr/Leap bundle served to
// browsers) was outside every dependency audit. scripts/audit-vendor.mjs judges each advisory by whether its package ships in
// the bundle, using the package list the vendor build records. These tests run the policy offline against reports shaped
// like `npm audit --json`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCEPTIONS_SCHEMA, advisoriesOf, evaluateVendorAudit, loadVendorAuditInputs } from '../scripts/audit-vendor.mjs';
import { bundledPackages, licenseRows } from '../scripts/vendor-frontend.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-06';
const advisory = (id, name, severity, extra = {}) => ({ source: 1, name, dependency: name, title: `${name} advisory`, url: `https://github.com/advisories/${id}`, severity, range: '*', ...extra });
// The shape of the 2026-11-05 report: one shipped low (through a chain of packages that merely carry it) and one build-only high.
const REPORT = { auditReportVersion: 2, vulnerabilities: {
  elliptic: { name: 'elliptic', severity: 'low', via: [advisory('GHSA-848j-6mx2-7j84', 'elliptic', 'low')] },
  '@cosmjs/crypto': { name: '@cosmjs/crypto', severity: 'low', via: ['elliptic'] },
  '@cosmjs/stargate': { name: '@cosmjs/stargate', severity: 'low', via: ['@cosmjs/crypto'] },
  'follow-redirects': { name: 'follow-redirects', severity: 'high', via: [advisory('GHSA-mrwp-f3q8-3g9p', 'follow-redirects', 'high')] }
} };
const BUNDLED = ['@cosmjs/crypto@0.33.1', '@cosmjs/stargate@0.33.1', 'axios@1.20.0', 'elliptic@6.6.1'];
const exception = (id, name, severity, shipped, review_by = '2026-12-31') => ({ advisory: id, package: name, severity, shipped_in_bundle: shipped, review_by, reason: 'reviewed: not reachable from the application' });

test('advisories are read once per id, whichever chain of packages carried them', () => {
  assert.deepEqual(advisoriesOf(REPORT).map(({ id, package: name, severity }) => [id, name, severity]),
    [['GHSA-mrwp-f3q8-3g9p', 'follow-redirects', 'high'], ['GHSA-848j-6mx2-7j84', 'elliptic', 'low']]);
  assert.deepEqual(advisoriesOf({}), []);
});

test('F04 a build-only high advisory fails until it is fixed or reviewed; a shipped low one is reported, not failed', () => {
  const advisories = advisoriesOf(REPORT);
  const bare = evaluateVendorAudit(advisories, { bundled: BUNDLED, exceptions: [], today: TODAY });
  assert.equal(bare.failures.length, 1);
  assert.match(bare.failures[0], /GHSA-mrwp-f3q8-3g9p follow-redirects \(high\).*build tooling/u);
  assert.match(bare.warnings.join('\n'), /GHSA-848j-6mx2-7j84 elliptic \(low\).* ships in the bundle; below the failing threshold/u);
  const reviewed = evaluateVendorAudit(advisories, { bundled: BUNDLED, today: TODAY,
    exceptions: [exception('GHSA-mrwp-f3q8-3g9p', 'follow-redirects', 'high', false), exception('GHSA-848j-6mx2-7j84', 'elliptic', 'low', true)] });
  assert.deepEqual([reviewed.failures, reviewed.warnings, reviewed.accepted.length], [[], [], 2]);
});

test('F04 a moderate or worse advisory in a package that ships always fails', () => {
  const shippedModerate = [{ id: 'GHSA-aaaa-bbbb-cccc', package: 'axios', severity: 'moderate', title: 'x' }];
  assert.match(evaluateVendorAudit(shippedModerate, { bundled: BUNDLED, exceptions: [], today: TODAY }).failures[0], /axios.*shipped bundle/u);
  // The same advisory on a package outside the bundle is only a note below high.
  const buildOnly = [{ id: 'GHSA-aaaa-bbbb-cccc', package: 'ws', severity: 'moderate', title: 'x' }];
  assert.deepEqual(evaluateVendorAudit(buildOnly, { bundled: BUNDLED, exceptions: [], today: TODAY }).failures, []);
  // A package that merely shares a name prefix with a shipped one does not ship.
  assert.deepEqual(evaluateVendorAudit([{ id: 'GHSA-aaaa-bbbb-cccc', package: 'axios-retry', severity: 'moderate', title: 'x' }], { bundled: BUNDLED, exceptions: [], today: TODAY }).failures, []);
});

test('F04 an acceptance expires, must be complete, and must still match what the bundle contains', () => {
  const advisories = advisoriesOf(REPORT);
  const fixed = exception('GHSA-848j-6mx2-7j84', 'elliptic', 'low', true);
  const expired = evaluateVendorAudit(advisories, { bundled: BUNDLED, today: '2027-01-01', exceptions: [exception('GHSA-mrwp-f3q8-3g9p', 'follow-redirects', 'high', false, '2026-11-19'), fixed] });
  assert.match(expired.failures.join('\n'), /accepted until 2026-11-19; fix it or review the exception again/u);
  // The claim "does not ship" is checked against the manifest: if the package now ships, the acceptance no longer holds.
  const claim = evaluateVendorAudit(advisories, { bundled: [...BUNDLED, 'follow-redirects@1.16.1'], today: TODAY, exceptions: [exception('GHSA-mrwp-f3q8-3g9p', 'follow-redirects', 'high', false)] });
  assert.match(claim.failures.join('\n'), /says follow-redirects does not ship in the bundle, but the manifest says the opposite/u);
  assert.match(claim.failures.join('\n'), /GHSA-mrwp-f3q8-3g9p follow-redirects \(high\).* is in the shipped bundle/u, 'an invalid exception accepts nothing');
  // An exception without a reason or a review date is not an exception.
  const thin = evaluateVendorAudit(advisories, { bundled: BUNDLED, today: TODAY, exceptions: [{ advisory: 'GHSA-mrwp-f3q8-3g9p', package: 'follow-redirects', severity: 'high', shipped_in_bundle: false, reason: 'later' }] });
  assert.match(thin.failures.join('\n'), /is incomplete/u);
  assert.match(thin.failures.join('\n'), /build tooling/u);
  // An advisory that has been fixed leaves a stale record, which is reported so it gets removed.
  const stale = evaluateVendorAudit([], { bundled: BUNDLED, today: TODAY, exceptions: [fixed] });
  assert.deepEqual([stale.failures, stale.warnings.length], [[], 1]);
});

test('F04 the committed manifest, lock, licence table and exceptions agree', () => {
  const { bundled, exceptions } = loadVendorAuditInputs();
  const names = new Set(bundled.map((item) => item.slice(0, item.lastIndexOf('@'))));
  // What ships: the Cosmos client and its signing stack; what does not: the HTTP redirect library and the build tool.
  for (const name of ['@cosmjs/stargate', '@cosmjs/crypto', 'elliptic', 'axios']) assert.ok(names.has(name), `${name} ships`);
  for (const name of ['follow-redirects', 'esbuild', 'ws', 'form-data']) assert.ok(!names.has(name), `${name} does not ship`);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'vendor', 'package-lock.json'), 'utf8'));
  const table = licenseRows(bundled, lock);
  assert.equal(table.length, bundled.length);
  const licences = fs.readFileSync(path.join(root, 'public', 'vendor', 'THIRD_PARTY_LICENSES.md'), 'utf8');
  for (const row of table) assert.ok(licences.includes(row), `the licence table lists ${row}`);
  assert.equal(licences.split('\n').filter((line) => /^\| [^|]+ \| \d/u.test(line)).length, bundled.length, 'and nothing else');
  // The recorded exceptions follow the schema, name real packages of the lock, and are not stale at the time of writing.
  const document = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'vendor', 'audit-exceptions.json'), 'utf8'));
  assert.equal(document.schema, EXCEPTIONS_SCHEMA);
  for (const item of exceptions) {
    assert.ok(Object.keys(lock.packages).some((key) => key.endsWith(`node_modules/${item.package}`)), `${item.package} is in the lock`);
    assert.equal(item.shipped_in_bundle, names.has(item.package), `${item.advisory}: the claim about the bundle holds`);
  }
});

test('bundled packages are read from esbuild input paths, nested installs included, and an unknown input is an error', () => {
  const lock = { packages: { 'node_modules/bn.js': { version: '5.2.5' }, 'node_modules/elliptic': { version: '6.6.1' }, 'node_modules/elliptic/node_modules/bn.js': { version: '4.12.5' },
    'node_modules/@cosmjs/math': { version: '0.33.1' } } };
  const inputs = (...names) => ({ inputs: Object.fromEntries(names.map((name) => [name, {}])) });
  assert.deepEqual(bundledPackages(inputs('entry-cosmjs.js', '(disabled):fs', 'node_modules/bn.js/lib/bn.js', 'scripts/vendor/node_modules/elliptic/node_modules/bn.js/lib/bn.js',
    'node_modules/elliptic/lib/elliptic.js', 'node_modules/@cosmjs/math/build/index.js', 'node_modules\\@cosmjs\\math\\build\\decimal.js'), lock),
  ['@cosmjs/math@0.33.1', 'bn.js@4.12.5', 'bn.js@5.2.5', 'elliptic@6.6.1']);
  assert.throws(() => bundledPackages(inputs('node_modules/left-pad/index.js'), lock), /no entry in the vendor lock/u);
});
