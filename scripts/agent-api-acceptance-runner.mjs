import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, 'playwright-module': { type: 'string' }, 'browser-executable': { type: 'string' } } });
if (!values.url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(values.url).hostname)) throw new Error('A loopback harness URL is required');
const { chromium } = await import(values['playwright-module'] ? pathToFileURL(path.resolve(values['playwright-module'])).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(values['browser-executable'] ? { executablePath: values['browser-executable'] } : {}),
  ...(process.platform === 'linux' ? { args: ['--no-sandbox'] } : {}) });
const report = { checked_at: new Date().toISOString(), browser: browser.version(), model: 'x-test-2',
  real_provider_calls: 0, real_transactions: 0, builtin_browser_control: false, human_acceptance: false, checks: [], screenshots: [], page_errors: [] };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); if (!passed) throw new Error(name); };
const origin = new URL(values.url).origin;
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => report.page_errors.push(error.message));
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin); await page.locator('.market-card').first().waitFor();
  const fixtures = await (await page.request.get(`${origin}/__acceptance__/fixtures`)).json();
  for (const width of [1440, 390]) for (const lang of ['zh', 'en']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((lang) => localStorage.setItem('ts_lang', lang), lang);
    await page.reload(); await page.locator('.market-card').first().waitFor();
    const prefix = `${width}/${lang}`;
    const results = await page.evaluate(async (fixtures) => {
      const call = async (operation, body) => {
        const response = await fetch(`/api/agent/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
      };
      return {
        extraction: await call('extract-documents', { documents: fixtures.documents }),
        verification: await call('verify-documents', { case_data: fixtures.case_data }),
        price: await call('price-rwa', { case_data: fixtures.case_data, payout_speed: 'FAST' }),
        brief: await call('generate-investor-brief', { case_data: fixtures.case_data }),
        graph: await call('generate-evidence-graph', fixtures),
        invalid: await call('price-rwa', { case_data: fixtures.case_data, quote: { final_issue_price_usd: 0.01 } })
      };
    }, fixtures);
    for (const key of ['extraction', 'verification', 'price', 'brief', 'graph']) {
      check(`${prefix}: ${key} runs through browser same-origin fetch`, results[key].status === 200 && results[key].data.stateless && !results[key].data.chain_action_executed);
    }
    check(`${prefix}: extraction includes real source fields`, results.extraction.data.extraction.documents.some((doc) => doc.fields.quantity_mt === 500));
    check(`${prefix}: price honors selected speed`, results.price.data.quote.payout_speed === 'FAST');
    check(`${prefix}: brief retains target-redemption caution`, /not a guarantee/u.test(results.brief.data.brief.text));
    check(`${prefix}: graph includes three document commitments and compliance`, results.graph.data.evidence_graph.nodes.filter((node) => node.type === 'document').length === 3 && results.graph.data.evidence_graph.nodes.some((node) => node.type === 'compliance'));
    check(`${prefix}: forged quote cannot enter pricing`, results.invalid.status === 400);
    const model = await page.evaluate(async () => {
      const status = await (await fetch('/api/llm/status')).json();
      const response = await fetch('/api/llm/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'forged-browser-model', messages: [{ role: 'user', content: 'local fixture' }] }) });
      return { status, result: await response.json() };
    });
    check(`${prefix}: relay status and upstream use x-test-2`, model.status.model === 'x-test-2' && model.result.model === 'x-test-2');
    const size = await page.evaluate(() => ({ viewport: globalThis.innerWidth, document: globalThis.document.documentElement.scrollWidth }));
    check(`${prefix}: existing application has no horizontal overflow`, size.document <= size.viewport);
    const screenshot = `docs/evidence/agent-api-${width}-${lang}.png`;
    await page.screenshot({ path: screenshot, fullPage: false }); report.screenshots.push(screenshot);
  }
  // Live permits the same pure operations without requiring an owner key or accessing a chain.
  await page.request.post(`${origin}/__acceptance__/mode?mode=live`);
  for (const operation of ['price-rwa', 'generate-investor-brief', 'generate-evidence-graph']) {
    const response = await page.request.post(`${origin}/api/agent/${operation}`, { data: { case_data: fixtures.case_data } });
    const data = await response.json(); check(`live: ${operation} remains stateless without an admin token`, response.status() === 200 && data.stateless && !data.chain_action_executed);
  }
  await page.request.post(`${origin}/__acceptance__/mode?mode=demo`);
  const state = await (await page.request.get(`${origin}/__acceptance__/state`)).json();
  check('every intercepted model request is x-test-2', state.calls.length >= 4 && state.calls.every((call) => call.model === 'x-test-2'));
  check('no operation opened a job, decision, approval or transaction', !state.jobs && !state.decisions && !state.approvals && state.real_transactions === 0);
  check('zero page script errors', report.page_errors.length === 0);
  report.summary = { total: report.checks.length, passed: report.checks.filter((item) => item.passed).length };
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; throw error;
} finally {
  await browser.close();
  const output = report.passed ? 'docs/evidence/agent-api-browser.json' : `docs/evidence/agent-api-browser-attempt-${Date.now()}.json`;
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, summary: report.summary, output, error: report.error }));
}
