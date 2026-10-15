import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, 'playwright-module': { type: 'string' }, 'browser-executable': { type: 'string' }, 'all-pages': { type: 'boolean' } } });
if (!values.url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(values.url).hostname)) throw new Error('An isolated loopback harness URL is required');
const { chromium } = await import(values['playwright-module'] ? pathToFileURL(path.resolve(values['playwright-module'])).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(values['browser-executable'] ? { executablePath: values['browser-executable'] } : {}),
  ...(process.platform === 'linux' ? { args: ['--no-sandbox'] } : {}) });
const attempt = Date.now();
const report = { checked_at: new Date().toISOString(), browser: browser.version(), checks: [], screenshots: [], page_errors: [],
  real_transactions: 0, real_provider_calls: 0, human_acceptance: false, builtin_browser_control: false };
const page = await browser.newPage();
const origin = new URL(values.url).origin;
const check = (name, passed, detail) => { report.checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) }); if (!passed) throw new Error(name); };
const api = async (pathname, body) => {
  const response = body === undefined ? await page.request.get(origin + pathname) : await page.request.post(origin + pathname, { data: body });
  if (!response.ok()) throw new Error(`${pathname}: HTTP ${response.status()}`);
  return response.json();
};
const inject = async (status, prefix) => {
  const observed = Date.now() - (status === 'stale' ? 2 * 86400000 : 1000);
  await api('/api/agent/events?wait=1', { type: 'WORLD_RISK_UPDATED', case_id: 'CASE-EBL-2026-CU-SG-SHA', event_id: `${prefix}:${attempt}`,
    observed_at: new Date(observed).toISOString(), expires_at: new Date(observed + 86400000).toISOString(), source_status: status,
    data: { events: [{ type: 'severe_weather', severity: 'critical', region: 'East China Sea', description: 'Local browser fixture' }] } });
  return (await api('/api/agent/decisions')).decisions[0];
};
const open = async (id) => {
  await page.locator('#tab-agent').click();
  await page.locator(`[data-focus-key="decision:${id}"]`).click();
  await page.locator('[data-focus-key="decision:replay"]').waitFor();
};
page.on('pageerror', (error) => report.page_errors.push(error.message));
await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
try {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (values['all-pages']) {
    const source = (await fs.readFile(new URL('./ui-acceptance.playwright.js', import.meta.url), 'utf8'))
      .replaceAll('http://127.0.0.1:3000', origin).replaceAll('docs/evidence/agent-phase4-', `docs/evidence/phase5-regression-${attempt}-`);
    const result = await eval(source)(page);
    report.checks.push(...result.checks); report.screenshots.push(...result.screenshots); report.measurements = result.measurements;
    if (!result.passed) throw new Error(result.error);
  } else {
  for (const width of [1440, 390]) for (const lang of ['zh', 'en']) {
    const prefix = `${width}/${lang}`;
    await api('/api/demo/reset', {});
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(origin); await page.evaluate((locale) => localStorage.setItem('ts_lang', locale), lang); await page.reload();
    await page.locator('.market-card').first().waitFor();
    const fresh = await inject('fixture', `${prefix}:fresh`);
    await open(fresh.decision_id);
    check(`${prefix}: fixture badge records source and times`, await page.locator('[data-evidence-status="fixture"]').count() === 1 && fresh.freshness.observed_at && fresh.freshness.expires_at);
    await page.locator('[data-focus-key="decision:replay"]').focus(); await page.keyboard.press('Enter');
    await page.locator('[data-replay-status="PASS"]').waitFor();
    check(`${prefix}: keyboard replay passes`, await page.locator('.ac-replay-result li').count() >= 6);
    check(`${prefix}: replay creates no additional decisions`, (await api('/api/agent/decisions')).count === 1);
    await api(`/__phase5__/tamper?id=${fresh.decision_id}`, {});
    await page.locator('[data-focus-key="decision:replay"]').click(); await page.locator('[data-replay-status="FAIL"]').waitFor();
    check(`${prefix}: tampered evidence fails visibly`, (await page.locator('.ac-replay-result').textContent()).includes('evidence_hash'));
    await page.keyboard.press('Escape');
    await api('/api/demo/reset', {});
    const stale = await inject('stale', `${prefix}:stale`); await open(stale.decision_id);
    check(`${prefix}: stale approval button is disabled`, await page.locator(`#ac-drawer [data-focus-key="approve:${stale.approval.approval_id}"]`).isDisabled());
    check(`${prefix}: stale badge is visible`, await page.locator('[data-evidence-status="stale"]').count() === 1);
    check(`${prefix}: stale evidence cannot execute automatically`, stale.status === 'PENDING_APPROVAL' && !stale.execution?.reference);
    const denied = await page.request.post(`${origin}/api/agent/approvals/${stale.approval.approval_id}/approve`, { data: {} });
    check(`${prefix}: stale approval is rejected`, denied.status() === 409 && (await denied.json()).code === 'evidence_expired');
    const text = await page.locator('#ac-drawer').textContent();
    check(`${prefix}: new controls are localized`, !/ac_(?:replay|source|freshness|observed|expires)_[a-z_]+/u.test(text));
    const dimensions = await page.locator('#ac-drawer').evaluate((node) => ({ viewport: globalThis.innerWidth, document: globalThis.document.documentElement.scrollWidth, content: node.scrollWidth, width: node.clientWidth }));
    check(`${prefix}: drawer fits the viewport`, dimensions.document <= width && dimensions.content <= dimensions.width + 1, dimensions);
    const screenshot = `docs/evidence/phase5-${attempt}-${width}-${lang}.png`; await page.locator('[data-evidence-status="stale"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
  }
  }
  check('No browser script errors', report.page_errors.length === 0);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message;
  const screenshot = `docs/evidence/phase5-${attempt}-failure.png`; await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
} finally {
  await browser.close(); await fs.writeFile(`docs/evidence/phase5-browser-${attempt}.json`, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ attempt, passed: report.passed, checks: report.checks.length, error: report.error, report: `docs/evidence/phase5-browser-${attempt}.json` }));
process.exitCode = report.passed ? 0 : 1;
