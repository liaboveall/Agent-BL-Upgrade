import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, 'playwright-module': { type: 'string' }, 'browser-executable': { type: 'string' } } });
if (!values.url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(values.url).hostname)) throw new Error('An isolated loopback harness URL is required');
const { chromium } = await import(values['playwright-module'] ? pathToFileURL(path.resolve(values['playwright-module'])).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(values['browser-executable'] ? { executablePath: values['browser-executable'] } : {}),
  ...(process.platform === 'linux' ? { args: ['--no-sandbox'] } : {}) });
const attempt = Date.now(), origin = new URL(values.url).origin;
const report = { phase: 7, checked_at: new Date().toISOString(), browser: browser.version(), checks: [], screenshots: [], measurements: [],
  real_transactions: 0, real_provider_calls: 0, human_acceptance: false, builtin_browser_control: false };
const page = await browser.newPage();
const check = (name, passed, detail) => { report.checks.push({ name, passed: Boolean(passed), detail }); if (!passed) throw new Error(name); };
await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
try {
  const source = (await fs.readFile(new URL('./ui-acceptance.playwright.js', import.meta.url), 'utf8'))
    .replaceAll('http://127.0.0.1:3000', origin).replaceAll('docs/evidence/agent-phase4-', `docs/evidence/phase7-regression-${attempt}-`);
  const ui = await eval(source)(page);
  report.checks.push(...ui.checks); report.screenshots.push(...ui.screenshots); report.measurements.push(...ui.measurements);
  report.page_errors = ui.page_errors; report.unexpected_http_errors = ui.unexpected_http_errors;
  check('Established bilingual and narrow-screen workflow', ui.passed, ui.error);
  const post = async (url, data) => {
    const response = await page.request.post(new URL(url, origin).href, { data });
    check(`Harness ${url.split('?')[0]}`, response.ok()); return response.json();
  };
  for (const width of [1440, 390]) for (const locale of ['zh', 'en']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await post('/api/demo/reset', {});
    await page.goto(origin); await page.locator('.market-card').first().waitFor();
    if (await page.locator('html').getAttribute('lang') !== (locale === 'zh' ? 'zh-CN' : 'en')) await page.locator('#lang-btn').click();
    const injected = await post('/api/agent/events?wait=1', { type: 'WORLD_RISK_UPDATED', case_id: 'CASE-EBL-2026-CU-SG-SHA',
      event_id: `phase7-${attempt}-${width}-${locale}`, data: { events: [{ type: 'severe_weather', severity: 'warning', region: 'East China Sea', description: 'Test storm', date: '2026-10-15' }] } });
    const id = injected.processing?.result?.decisions?.[0]; check(`${width}/${locale}: runtime generated a terminal decision`, Boolean(id));
    await post('/api/agent/control', { action: 'tick' });
    await page.locator('#tab-agent').click();
    await page.locator(`[data-focus-key="decision:${id}"]`).click();
    const anchor = page.locator('#ac-drawer .ac-anchor'); await anchor.waitFor();
    await anchor.locator('[data-focus-key="decision:anchor-verify"]').click();
    await anchor.locator('[data-anchor-verification="PASS_LOCAL"]').waitFor();
    check(`${width}/${locale}: Demo verifies locally without an explorer link`, await anchor.getAttribute('data-anchor-state') === 'DEMO' && await anchor.locator('a').count() === 0);
    check(`${width}/${locale}: verifier retains keyboard focus`, await page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-focus-key') === 'decision:anchor-verify'));
    await anchor.locator('details summary').click();
    const proof = JSON.parse(await anchor.locator('pre').textContent());
    check(`${width}/${locale}: proof contains finalization, version and a real computed leaf`, proof.payload.decision_id === id && proof.payload.seq > 0 && proof.version.version_id === proof.payload.version_id
      && /^0x[0-9a-f]{64}$/u.test(proof.leaf) && proof.batch.tx_hash === null);
    const measurement = await anchor.evaluate((scope) => {
      const width = globalThis.innerWidth;
      return { viewport: width, document_width: globalThis.document.documentElement.scrollWidth,
        overflow: [...scope.querySelectorAll('*')].filter((element) => { const rect = element.getBoundingClientRect(); return rect.width && (rect.right > width + 1 || rect.left < -1); }).map((element) => element.tagName),
        unnamed: [...scope.querySelectorAll('button')].filter((element) => !(element.textContent.trim() || element.getAttribute('aria-label') || element.title)).length,
        untranslated: /\bac_anchor_[a-z_]+\b/u.test(scope.textContent) };
    });
    report.measurements.push({ ...measurement, locale });
    check(`${width}/${locale}: expanded proof fits and is accessible`, measurement.document_width <= width && !measurement.overflow.length && !measurement.unnamed && !measurement.untranslated, measurement);
    await anchor.scrollIntoViewIfNeeded();
    const screenshot = `docs/evidence/phase7-${attempt}-${width}-${locale}.png`; await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    await post(`/__phase7__/tamper?id=${encodeURIComponent(id)}`, {});
    await anchor.locator('[data-focus-key="decision:anchor-verify"]').click(); await anchor.locator('[data-anchor-verification="FAIL"]').waitFor();
    check(`${width}/${locale}: altered evidence fails proof verification`, await anchor.locator('[data-anchor-verification="FAIL"]').count() === 1 && await anchor.locator('a').count() === 0);
    await page.keyboard.press('Escape');
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; process.exitCode = 1;
  const screenshot = `docs/evidence/phase7-browser-${attempt}-failure.png`; await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
} finally {
  await browser.close();
  const output = `docs/evidence/phase7-browser-${attempt}.json`;
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: output, error: report.error }));
}
