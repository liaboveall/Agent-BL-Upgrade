import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, 'playwright-module': { type: 'string' }, 'browser-executable': { type: 'string' }, 'all-pages': { type: 'boolean' } } });
if (!values.url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(values.url).hostname)) throw new Error('A loopback isolated harness URL is required');
const { chromium } = await import(values['playwright-module'] ? pathToFileURL(path.resolve(values['playwright-module'])).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(values['browser-executable'] ? { executablePath: values['browser-executable'] } : {}),
  ...(process.platform === 'linux' ? { args: ['--no-sandbox'] } : {}) });
const attempt = Date.now();
const report = { checked_at: new Date().toISOString(), browser: browser.version(), mode: 'isolated-demo',
  real_transactions: 0, real_provider_calls: 0, builtin_browser_control: false, human_acceptance: false,
  builtin_browser_error: 'sandboxCwd is not a local file URI', checks: [], screenshots: [], page_errors: [], blocked_external_requests: [] };
const check = (name, passed, detail) => { report.checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) }); if (!passed) throw new Error(name); };
const origin = new URL(values.url).origin;
const page = await browser.newPage();
const api = async (url, data) => {
  const response = data === undefined ? await page.request.get(origin + url) : await page.request.post(origin + url, { data });
  if (!response.ok()) throw new Error(`${url}: ${response.status()} ${await response.text()}`);
  return response.json();
};
const refs = async (selector) => page.locator(selector).first().evaluate((node) => [...node.querySelectorAll('[data-reference-kind]')].map((item) => [item.dataset.referenceKind, item.dataset.referenceValue]));
const dimensions = async (selector) => page.locator(selector).evaluate((node) => ({ viewport: globalThis.innerWidth,
  document: globalThis.document.documentElement.scrollWidth, scope: node.scrollWidth, width: node.clientWidth }));
const ready = async () => {
  await page.locator('.market-card').first().waitFor();
  await page.waitForFunction(() => !globalThis.document.querySelector('.page').classList.contains('busy'));
};
page.on('pageerror', (error) => report.page_errors.push(error.message));
await page.route('**/*', (route) => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  report.blocked_external_requests.push(new URL(route.request().url()).origin); return route.abort();
});
try {
  if (values['all-pages']) {
    const source = (await fs.readFile(new URL('./ui-acceptance.playwright.js', import.meta.url), 'utf8'))
      .replaceAll('http://127.0.0.1:3000', origin).replaceAll('docs/evidence/agent-phase4-', `docs/evidence/phase4-regression-${attempt}-`);
    const scenario = eval(source);
    const result = await scenario(page);
    report.checks.push(...result.checks); report.screenshots.push(...result.screenshots);
    report.measurements = result.measurements; report.legacy_suite_page_errors = result.page_errors;
    if (!result.passed) throw new Error(result.error);
    report.passed = true;
  } else {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin);
  for (const width of [1440, 390]) for (const lang of ['zh', 'en']) {
    const prefix = `${width}/${lang}`;
    await api('/api/demo/reset', {});
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate((lang) => localStorage.setItem('ts_lang', lang), lang);
    await page.reload(); await ready();
    await page.locator('#market-subscription').fill('1000');
    await page.locator('#market-subscribe-btn').click(); await page.locator('#portfolio-list .cp-card').first().waitFor();
    check(`${prefix}: subscription comes from server`, (await api('/api/investors/portfolio?wallet_address=0xDemoWallet')).investments.length === 1);
    const fixture = await api('/__phase4__/report', {});
    const decision = (await api(`/api/agent/decisions/${fixture.decision.decision_id}`)).decision;
    await page.locator('#case-dropdown').selectOption('CASE-EBL-2026-IRONORE-AU-TJ');
    await page.waitForFunction(() => !globalThis.document.querySelector('.page').classList.contains('busy'));
    await page.locator('#tab-agent').click();
    await page.locator(`.ac-row-open[data-focus-key="decision:${decision.decision_id}"]`).click();
    await page.locator('[data-focus-key="decision-view:market"]').waitFor();
    await page.waitForFunction((id) => globalThis.document.querySelector('#case-dropdown').value === id, decision.case_id);
    check(`${prefix}: timeline click synchronizes a different selected case`, await page.locator('#case-dropdown').inputValue() === decision.case_id);
    const selector = `.evidence-references[data-decision-id="${decision.decision_id}"]`;
    const expected = await refs(`#ac-drawer ${selector}`);
    check(`${prefix}: saved quote and paid report retained`, expected.some(([kind, value]) => kind === 'quote' && value === decision.quote_snapshot.quote_hash)
      && expected.some(([kind, value]) => kind === 'report' && value === fixture.envelope.report_id));
    check(`${prefix}: timeline uses same references`, JSON.stringify(await refs(`#ac-timeline ${selector}`)) === JSON.stringify(expected));
    check(`${prefix}: Demo decision has no transaction or explorer link`, !decision.references.tx_hash && await page.locator('#ac-drawer a').count() === 0);
    await page.locator('[data-focus-key="decision-view:market"]').click();
    await page.locator('.market-card.decision-highlight').waitFor();
    check(`${prefix}: market highlights the linked pool`, await page.locator('.market-card.decision-highlight').getAttribute('data-case') === decision.case_id);
    check(`${prefix}: market uses same references`, JSON.stringify(await refs(`.market-card ${selector}`)) === JSON.stringify(expected));
    check(`${prefix}: portfolio uses same references`, JSON.stringify(await refs(`#portfolio-list ${selector}`)) === JSON.stringify(expected));
    await page.locator('#tab-agent').click();
    await page.locator(`.ac-row-open[data-focus-key="decision:${decision.decision_id}"]`).click();
    await page.locator('[data-focus-key="decision-view:mint"]').click();
    await page.locator('#waterfall .decision-quote-note').waitFor();
    check(`${prefix}: waterfall uses the exact saved quote`, await page.locator('#waterfall').getAttribute('data-quote-hash') === decision.quote_snapshot.quote_hash);
    check(`${prefix}: waterfall uses same references`, JSON.stringify(await refs(`#waterfall ${selector}`)) === JSON.stringify(expected));
    await api('/api/agent/events?wait=1', { type: 'WORLD_RISK_UPDATED', case_id: decision.case_id, event_id: `browser-reprice:${attempt}:${prefix}`,
      data: { events: [{ type: 'severe_weather', region: 'East China Sea', severity: 'warning', description: 'Typhoon', date: '2026-06-12' }] } });
    check(`${prefix}: later reprice cannot overwrite historical waterfall`, await page.locator('#waterfall').getAttribute('data-quote-hash') === decision.quote_snapshot.quote_hash);
    check(`${prefix}: saved snapshot survives later execution`, JSON.stringify((await api(`/api/agent/decisions/${decision.decision_id}`)).decision.quote_snapshot) === JSON.stringify(decision.quote_snapshot));
    const mintSize = await dimensions('#waterfall');
    check(`${prefix}: long evidence IDs fit waterfall`, mintSize.document <= width && mintSize.scope <= mintSize.width + 1, mintSize);
    await page.locator('#tab-market').click();
    await page.locator(`.market-card[data-case="${decision.case_id}"] [data-focus-key^="market-track:"]`).click();
    await page.locator('#deal-detail-modal[open]').waitFor();
    check(`${prefix}: x402 panel uses same references`, JSON.stringify(await refs(`#x402-decision-reference ${selector}`)) === JSON.stringify(expected));
    await page.keyboard.press('Escape');
    check(`${prefix}: linked-view dialog closes with Escape`, !await page.locator('#deal-detail-modal').evaluate((node) => node.open));
    // A fresh full workflow is started entirely through visible controls.
    await page.locator('#demo-reset-btn').click();
    await page.waitForFunction(() => !globalThis.document.querySelector('.page').classList.contains('busy'));
    await page.locator('#tab-agent').click();
    await page.locator('#ac-demo-scenario').selectOption('copper-lifecycle'); await page.locator('#ac-demo-speed').selectOption('10');
    await page.locator('[data-focus-key="demo:run"]').click();
    await page.locator('#ac-demo[data-demo-state="completed"]').waitFor({ timeout: 30_000 });
    const run = (await api('/api/agent/demo/run')).run;
    check(`${prefix}: full workflow reaches all 10 server steps`, run.scenario.next_step === 10 && run.scenario.log[0].job_id);
    check(`${prefix}: UI highlights last real step`, await page.locator('.ac-demo-steps [aria-current="step"]').getAttribute('data-demo-step') === '9');
    check(`${prefix}: progress announcements are polite`, await page.locator('.ac-demo-progress').getAttribute('aria-live') === 'polite');
    const [payment] = (await api('/api/agent/approvals?status=PENDING')).approvals;
    check(`${prefix}: payment waits for explicit approval`, payment.action === 'RECORD_PAYMENT');
    await page.locator(`#ac-approvals [data-focus-key="approve:${payment.approval_id}"]`).click();
    await page.locator('#ac-approvals .ac-approval-card .ac-badge').filter({ hasText: /^SETTLE$/u }).waitFor();
    const settlement = (await api('/api/agent/approvals?status=PENDING')).approvals.find((item) => item.action === 'SETTLE');
    check(`${prefix}: settlement has its own approval`, settlement.action === 'SETTLE' && settlement.approval_id !== payment.approval_id);
    const settledResponse = page.waitForResponse((response) => response.url().endsWith(`/api/agent/approvals/${settlement.approval_id}/approve`) && response.request().method() === 'POST');
    await page.locator(`#ac-approvals [data-focus-key="approve:${settlement.approval_id}"]`).click();
    check(`${prefix}: settlement approval request succeeds`, (await settledResponse).ok());
    check(`${prefix}: completed settlement is simulated`, (await api(`/api/agent/decisions/${settlement.decision_id}`)).decision.execution.mode === 'demo');
    const size = await dimensions('#ac-demo');
    check(`${prefix}: console and controls fit viewport`, size.document <= width && size.scope <= size.width + 1, size);
    const keys = await page.locator('#ac-demo').textContent();
    check(`${prefix}: demo copy is localized`, !/ac_demo_[a-z_]+|\[object Object\]/u.test(keys) && (lang !== 'en' || !/[\u3400-\u9fff]/u.test(keys)));
    const screenshot = `docs/evidence/phase4-${attempt}-${width}-${lang}.png`;
    await page.locator('#ac-demo').scrollIntoViewIfNeeded(); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    // Stop through the keyboard and verify the server has no later step to publish.
    await api('/api/demo/reset', {}); await page.reload(); await ready(); await page.locator('#tab-agent').click();
    await page.locator('#ac-demo-scenario').selectOption('copper-typhoon'); await page.locator('#ac-demo-speed').selectOption('0.5');
    await page.locator('[data-focus-key="demo:run"]').click(); await page.locator('#ac-demo[data-demo-state="running"]').waitFor();
    await page.locator('[data-focus-key="demo:stop"]').focus(); await page.keyboard.press('Enter');
    await page.locator('#ac-demo[data-demo-state="stopped"]').waitFor();
    const stopped = (await api('/api/agent/demo/run')).run;
    check(`${prefix}: keyboard stop drains active playback`, !stopped.active && stopped.scenario.next_step < stopped.scenario.total_steps);
    check(`${prefix}: reduced motion disables decorative animation`, await page.locator('.ambient-glow').first().evaluate((node) => globalThis.getComputedStyle(node).animationName === 'none'));
  }
  await api('/__phase4__/mode?mode=live', {}); await page.reload(); await ready(); await page.locator('#tab-agent').click();
  check('Live hides demo playback controls', await page.locator('#ac-demo').isHidden());
  const denied = await page.request.post(`${origin}/api/agent/demo/run`, { data: {} });
  check('Live cannot launch playback', [403, 409].includes(denied.status()));
  await api('/__phase4__/mode?mode=demo', {});
  check('No page script errors', report.page_errors.length === 0, report.page_errors);
  report.passed = true;
  }
} catch (error) {
  report.passed = false; report.error = error.message;
  report.failure_focus = await page.evaluate(() => ({ id: globalThis.document.activeElement?.id,
    key: globalThis.document.activeElement?.getAttribute('data-focus-key'), tag: globalThis.document.activeElement?.tagName })).catch(() => null);
  const screenshot = `docs/evidence/phase4-${attempt}-failure.png`;
  await page.screenshot({ path: screenshot }).then(() => report.screenshots.push(screenshot)).catch(() => {});
}
finally {
  report.summary = { total: report.checks.length, passed: report.checks.filter((item) => item.passed).length };
  await browser.close();
  const output = `docs/evidence/phase4-${values['all-pages'] ? 'regression' : 'browser'}-${attempt}.json`;
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, summary: report.summary, output, error: report.error }));
  if (!report.passed) process.exitCode = 1;
}
