// Isolated Demo browser verification. Reuse the established bilingual/narrow-screen workflow.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { url: { type: 'string' }, 'playwright-module': { type: 'string' }, 'browser-executable': { type: 'string' } } });
if (!values.url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(values.url).hostname)) throw new Error('An isolated loopback harness URL is required');
const { chromium } = await import(values['playwright-module'] ? pathToFileURL(path.resolve(values['playwright-module'])).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(values['browser-executable'] ? { executablePath: values['browser-executable'] } : {}),
  ...(process.platform === 'linux' ? { args: ['--no-sandbox'] } : {}) });
const attempt = Date.now();
const report = { phase: 6, checked_at: new Date().toISOString(), browser: browser.version(), checks: [], screenshots: [],
  real_transactions: 0, real_provider_calls: 0, human_acceptance: false, builtin_browser_control: false,
  builtin_browser_limitation: 'node_repl rejects the WSL cwd as a non-local file URI; initialization retried and kernel reset without success' };
const page = await browser.newPage();
const origin = new URL(values.url).origin;
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); if (!passed) throw new Error(name); };
await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
try {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const source = (await fs.readFile(new URL('./ui-acceptance.playwright.js', import.meta.url), 'utf8'))
    .replaceAll('http://127.0.0.1:3000', origin).replaceAll('docs/evidence/agent-phase4-', `docs/evidence/phase6-regression-${attempt}-`);
  const ui = await eval(source)(page);
  report.checks.push(...ui.checks); report.screenshots.push(...ui.screenshots); report.measurements = ui.measurements;
  report.page_errors = ui.page_errors; report.unexpected_http_errors = ui.unexpected_http_errors;
  if (!ui.passed) report.ui_error = ui.error;
  check('Established Chinese/English and 1440/390px browser workflow', ui.passed);
  const read = (url) => page.evaluate(async (url) => {
    const response = await fetch(url); return { status: response.status, body: await response.json() };
  }, url);
  const post = (path, body, headers = {}) => page.evaluate(async ({ path, body, headers }) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { path, body, headers });
  const card = await read('/.well-known/agent-card.json'), legacy = await read('/.well-known/agent.json');
  check('Browser receives the same 1.0 Agent Card at both paths', card.status === 200 && card.body.supportedInterfaces?.[0]?.protocolVersion === '1.0' && JSON.stringify(card.body) === JSON.stringify(legacy.body));
  const catalog = await read('/api/x402/discovery');
  check('Browser discovery keeps Demo payment boundaries', catalog.body.items?.length === 4 && catalog.body.items.every((item) => item.accepts.length === 0));
  const input = { case_id: 'CASE-EBL-2026-CU-SG-SHA', request_id: `browser-${attempt}` };
  const quoted = await post('/api/agent/delegate-pricing', input);
  const a2a = await post('/api/a2a', { jsonrpc: '2.0', id: attempt, method: 'SendMessage', params: {
    message: { messageId: `browser-${attempt}`, role: 'ROLE_USER', parts: [{ data: input }] }
  } }, { 'A2A-Version': '1.0' });
  check('Browser A2A and HTTP quote commitments match', quoted.status === 200 && quoted.body.result_hash === a2a.body.result?.message?.parts?.[0]?.data?.result_hash);
  const mcp = await post('/api/mcp/call', { tool: 'delegate_pricing', params: input });
  check('Browser MCP adapter matches the same quotation', mcp.body.result?.result_hash === quoted.body.result_hash && mcp.body.result?.authorization?.chain_action_executed === false);
  const status = await read('/api/agent/status');
  const preview = await post('/api/mcp/call', { tool: 'submit_agent_event', params: { event: {
    type: 'CARGO_DEPARTED', case_id: input.case_id, event_id: `browser-preview-${attempt}`, data: {}
  } } });
  const after = await read('/api/agent/status');
  check('Browser event preview is a side-effect-free dry-run', preview.body.result?.dry_run === true && !preview.body.result?.submitted
    && JSON.stringify(status.body.queue) === JSON.stringify(after.body.queue));
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; process.exitCode = 1;
  const screenshot = `docs/evidence/phase6-browser-${attempt}-failure.png`;
  await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
}
finally {
  await browser.close();
  const output = `docs/evidence/phase6-browser-${attempt}.json`;
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: output, error: report.error }));
}
