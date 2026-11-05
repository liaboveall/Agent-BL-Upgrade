// Dependency audit of the browser-bundle toolchain (scripts/vendor/package-lock.json), the third lock file next to the
// application's and Hardhat's. `npm audit` on the other two cannot see it, yet its output (public/vendor/cosmjs-stargate-*.js)
// is code that runs in users' browsers next to their wallet.
//
//   node scripts/audit-vendor.mjs                    audit the lock against the npm advisory database (needs network)
//   node scripts/audit-vendor.mjs --report file.json evaluate a saved `npm audit --json` report (offline)
//
// The lock installs more than the bundle contains. What ships is the list esbuild recorded in public/vendor/manifest.json
// (`bundled_packages`, see scripts/vendor-frontend.mjs), so each advisory is judged by whether its package ships:
//   - moderate or worse in a shipped package          -> fail (fix it: upgrade the dependency and rebuild the bundle);
//   - high or worse in a package that does not ship   -> fail (build tooling; fix it by updating the lock);
//   - anything lower                                   -> reported, not failed.
// A finding may be accepted for a limited time in scripts/vendor/audit-exceptions.json: each entry names the advisory, says
// why, and carries a review date after which the audit fails again; an entry whose claim about the bundle no longer matches
// the manifest, or whose advisory has gone, is reported. An unreachable advisory service fails the audit rather than passing it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDirectory = path.join(root, 'scripts', 'vendor');
export const EXCEPTIONS_SCHEMA = 'agentbl-vendor-audit-exceptions-v1';
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const rank = (severity) => SEVERITIES.indexOf(severity);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const packageName = (identity) => identity.slice(0, identity.lastIndexOf('@'));

/** Advisories in an `npm audit --json` report (version 2): one per advisory id, whichever package chain carried it. */
export function advisoriesOf(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || !via?.url) continue; // a string only names the package the advisory travelled through
      const id = String(via.url).split('/').pop();
      if (!found.has(id)) found.set(id, { id, package: via.name, severity: via.severity, title: via.title, url: via.url });
    }
  }
  return [...found.values()].sort((a, b) => rank(b.severity) - rank(a.severity) || a.id.localeCompare(b.id));
}

/**
 * @param {{id: string, package: string, severity: string}[]} advisories
 * @param {{bundled: Iterable<string>, exceptions: object[], today: string}} context `bundled` is the manifest's
 *   `name@version` list, `today` an ISO date (YYYY-MM-DD)
 * @returns {{failures: string[], warnings: string[], accepted: string[]}}
 */
export function evaluateVendorAudit(advisories, { bundled, exceptions = [], today }) {
  const shipped = new Set([...bundled].map(packageName));
  const failures = [], warnings = [], accepted = [];
  const present = new Set(advisories.map((advisory) => advisory.id));
  const describe = (advisory) => `${advisory.id} ${advisory.package} (${advisory.severity})${advisory.title ? `: ${advisory.title}` : ''}`;
  // Only a complete exception whose claim about the bundle still holds can accept anything.
  const usable = [];
  for (const exception of exceptions) {
    const valid = /^GHSA-[\w-]+$/u.test(exception.advisory ?? '') && exception.package && SEVERITIES.includes(exception.severity)
      && typeof exception.shipped_in_bundle === 'boolean' && /^\d{4}-\d{2}-\d{2}$/u.test(exception.review_by ?? '') && String(exception.reason ?? '').trim().length >= 20;
    if (!valid) failures.push(`exception ${exception.advisory ?? '(no id)'} is incomplete: advisory, package, severity, shipped_in_bundle, review_by (YYYY-MM-DD) and a reason are required`);
    else if (exception.shipped_in_bundle !== shipped.has(exception.package)) {
      failures.push(`exception ${exception.advisory} says ${exception.package} ${exception.shipped_in_bundle ? 'ships' : 'does not ship'} in the bundle, but the manifest says the opposite; review it`);
    } else {
      usable.push(exception);
      if (!present.has(exception.advisory)) warnings.push(`exception ${exception.advisory} no longer matches any advisory: remove it`);
    }
  }
  for (const advisory of advisories) {
    const exception = usable.find((item) => item.advisory === advisory.id && item.package === advisory.package);
    const ships = shipped.has(advisory.package), severity = rank(advisory.severity);
    if (exception) {
      if (exception.review_by < today) failures.push(`${describe(advisory)} was accepted until ${exception.review_by}; fix it or review the exception again`);
      else accepted.push(`${describe(advisory)} accepted until ${exception.review_by} (${ships ? 'ships in the bundle' : 'build tooling only'}): ${exception.reason}`);
    } else if (ships && severity >= rank('moderate')) failures.push(`${describe(advisory)} is in the shipped bundle: upgrade the dependency and rebuild public/vendor`);
    else if (!ships && severity >= rank('high')) failures.push(`${describe(advisory)} is in the vendor build tooling: update scripts/vendor/package-lock.json (or review an exception)`);
    else warnings.push(`${describe(advisory)} ${ships ? 'ships in the bundle' : 'is build tooling only'}; below the failing threshold`);
  }
  return { failures, warnings, accepted };
}

/** The shipped package list from the vendor manifest and the reviewed exceptions, as the audit reads them. */
export function loadVendorAuditInputs() {
  const manifest = readJson(path.join(root, 'public', 'vendor', 'manifest.json'));
  const bundled = Object.values(manifest.files ?? {}).flatMap((entry) => entry.bundled_packages ?? []);
  if (bundled.length === 0) throw new Error('public/vendor/manifest.json lists no bundled_packages; run npm run vendor:build');
  const file = path.join(vendorDirectory, 'audit-exceptions.json'), document = fs.existsSync(file) ? readJson(file) : { schema: EXCEPTIONS_SCHEMA, exceptions: [] };
  if (document.schema !== EXCEPTIONS_SCHEMA) throw new Error(`${path.relative(root, file)} must use schema ${EXCEPTIONS_SCHEMA}`);
  return { bundled, exceptions: document.exceptions ?? [] };
}

function runNpmAudit() {
  // Fixed arguments, no user input; npm audit exits non-zero when it finds something, so the exit code is not an error here.
  const result = spawnSync(`npm audit --json --prefix "${vendorDirectory}"`, { encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024 });
  let report;
  try { report = JSON.parse(result.stdout); } catch { /* reported below */ }
  if (!report || report.error || !report.vulnerabilities) {
    throw new Error(`npm audit gave no report (${report?.error?.summary ?? (result.stderr || 'no output').trim().split('\n')[0]}); the advisory service may be unreachable`);
  }
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const reportIndex = process.argv.indexOf('--report');
    const report = reportIndex > 0 ? readJson(process.argv[reportIndex + 1]) : runNpmAudit();
    const { bundled, exceptions } = loadVendorAuditInputs();
    const advisories = advisoriesOf(report), { failures, warnings, accepted } = evaluateVendorAudit(advisories, { bundled, exceptions, today: new Date().toISOString().slice(0, 10) });
    console.log(`vendor audit: ${advisories.length} advisories in scripts/vendor/package-lock.json; ${new Set(bundled.map(packageName)).size} packages ship in the bundle`);
    for (const line of accepted) console.log(`  accepted: ${line}`);
    for (const line of warnings) console.log(`  note:     ${line}`);
    if (failures.length) { for (const line of failures) console.error(`  FAIL:     ${line}`); process.exit(1); }
    console.log('vendor audit passed');
  } catch (error) {
    console.error(`vendor audit could not run: ${error.message}`);
    process.exit(2);
  }
}
