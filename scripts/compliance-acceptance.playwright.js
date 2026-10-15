// Run against scripts/compliance-acceptance-server.mjs only. Uploads use actual file bytes.
async page => {
  const fs = await import('node:fs/promises');
  const names = ['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'];
  const texts = await Promise.all(names.map((name) => fs.readFile(`data/uploads/copper-sg-shanghai/${name}`, 'utf8')));
  const origin = new URL(page.url()).origin;
  const report = { checked_at: new Date().toISOString(), browser: page.context().browser().version(),
    mode: 'demo', external_screening: 'disabled', checks: [], screenshots: [], page_errors: [], jobs: [], passed: false };
  const check = (name, ok, detail) => {
    report.checks.push({ name, passed: !!ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) throw new Error(name + (detail === undefined ? '' : `: ${JSON.stringify(detail)}`));
  };
  page.on('pageerror', (error) => report.page_errors.push(error.message));
  const json = async (path) => {
    const response = await page.request.get(new URL(path, origin).href);
    if (!response.ok()) throw new Error(`${path}: ${response.status()}`);
    return response.json();
  };
  const completed = async (id) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const data = await json(`/api/agent/jobs/${id}?acceptance_poll=${attempt}`);
      if (data.job.status === 'DONE') return data.job;
      if (data.job.status === 'FAILED') throw new Error(JSON.stringify(data.job.error));
      await page.waitForTimeout(100);
    }
    throw new Error('Intake did not complete');
  };
  const files = (edit = (_, text) => text) => texts.map((text, i) => ({ name: names[i], mimeType: 'text/markdown', buffer: Buffer.from(edit(names[i], text)) }));
  const upload = async (documents) => {
    const sent = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/agent\/ingest$/u.test(new URL(response.url()).pathname));
    await page.locator('#ebl-file-input').setInputFiles(documents);
    const response = await sent; check('File upload accepted', response.ok());
    const job = await completed((await response.json()).job.job_id);
    report.jobs.push({ job_id: job.job_id, status: job.status, action: job.result_action, compliance: job.compliance?.status });
    await page.waitForFunction(({ id, status }) => [...globalThis.document.querySelectorAll('#ebl-upload-status .ebl-compliance')].some((element) =>
      element.textContent.includes('demo-screening-v2.0') && element.closest('.ebl-job').textContent.includes(status)) && !!id,
    { id: job.job_id, status: job.result_action === 'REJECT' ? (await page.locator('html').getAttribute('lang') === 'en' ? 'Rejected' : '拒绝接入') : '' });
    return job;
  };
  async function measure(tag) {
    const result = await page.locator('#ebl-upload-status').evaluate((root) => {
      const doc = globalThis.document, width = globalThis.innerWidth;
      const visible = (element) => element.getClientRects().length && globalThis.getComputedStyle(element).visibility !== 'hidden';
      return { document_width: doc.documentElement.scrollWidth, viewport: width,
        overflow: [...root.querySelectorAll('*')].filter(visible).filter((element) => { const rect = element.getBoundingClientRect(); return rect.right > width + 1 || rect.left < -1; }).map((element) => ({ tag: element.tagName, text: element.textContent.slice(0, 80) })),
        raw_keys: [...root.querySelectorAll('*')].filter(visible).filter((element) => !element.childElementCount && /(?:comp|ebld)_[A-Za-z_]+/u.test(element.textContent)).map((element) => element.textContent),
        nested_controls: root.querySelectorAll('button button, button a, summary button').length };
    });
    check(`${tag}: viewport has no horizontal overflow`, result.document_width <= result.viewport && result.overflow.length === 0, result);
    check(`${tag}: translations resolve and controls are separate`, !result.raw_keys.length && result.nested_controls === 0, result);
  }
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const status = await json('/api/agent/status');
    check('Isolated Demo runtime has no configured signer', status.mode === 'demo' && Object.values(status.signers).every((signer) => !signer.configured));
    for (const width of [1440, 390]) for (const locale of ['zh', 'en']) {
      const tag = `${width}/${locale}`;
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto(origin); await page.locator('.market-card').first().waitFor();
      if (await page.locator('html').getAttribute('lang') !== (locale === 'zh' ? 'zh-CN' : 'en')) await page.locator('#lang-btn').click();
      const resetResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/demo/reset');
      await page.locator('#demo-reset-btn').click();
      check(`${tag}: Demo reset completes`, (await resetResponse).ok());
      await page.locator('#tab-mint').click();
      const clean = await upload(files());
      check(`${tag}: clean bundle opens with CLEAR evidence`, ['OPEN', 'OPEN_WITH_WARNING'].includes(clean.result_action) && clean.compliance.status === 'CLEAR');
      check(`${tag}: report has version, date and structured field evidence`, clean.compliance.list_version === 'demo-screening-v2.0' && clean.compliance.as_of === '2026-10-14' && clean.compliance.checks.every((check) => check.evidence.field));
      const nearFiles = files((_, text) => text.replaceAll('Strait Resources Trading Pte. Ltd.', 'Demo Cobalt Lantren Trading Pte. Ltd.'));
      const near = await upload(nearFiles);
      check(`${tag}: near entity is held and not a chain action`, near.result_action === 'HOLD_FOR_REVIEW' && near.compliance.status === 'REVIEW');
      check(`${tag}: near evidence includes the fictional entry and fixed score`, near.compliance.checks.some((check) => check.code === 'ENTITY_MATCH_REVIEW' && check.evidence.entry_id === 'DEMO-ENTITY-001' && check.evidence.score >= .85 && check.evidence.score < .92));
      check(`${tag}: repeated upload is idempotent`, (await upload(nearFiles)).job_id === near.job_id);
      const nearCard = page.locator('.ebl-job').filter({ hasText: 'Demo Cobalt Lantren Trading' }).first();
      const summary = nearCard.locator('.ebl-compliance > summary');
      await summary.focus(); await page.keyboard.press('Enter');
      const keyboardState = await nearCard.locator('.ebl-compliance').evaluate((element) => ({
        open: element.open, active_tag: globalThis.document.activeElement.tagName,
        active_text: globalThis.document.activeElement.textContent?.slice(0, 100), key: element.dataset.detailKey
      }));
      check(`${tag}: compliance evidence expands by keyboard`, keyboardState.open, keyboardState);
      await upload(nearFiles);
      check(`${tag}: repeated intake preserves expanded evidence`, await nearCard.locator('.ebl-compliance').evaluate((element) => element.open));
      const copy = await nearCard.locator('.ebl-compliance').textContent();
      check(`${tag}: status, disclaimer, fictional match and score are visible`, copy.includes(locale === 'zh' ? '需人工复核' : 'Human review required') && copy.includes(locale === 'zh' ? '不是官方名单' : 'not official screening') && copy.includes('Demo Cobalt Lantern Trading') && copy.includes('%'));
      await measure(tag);
      const screenshot = `docs/evidence/compliance-${width}-${locale}.png`;
      await summary.scrollIntoViewIfNeeded(); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
      const sent = page.waitForResponse((response) => response.request().method() === 'POST' && /\/review$/u.test(new URL(response.url()).pathname));
      await page.locator('#ebl-file-input').evaluate((input) => { input.click = () => {}; });
      await nearCard.getByRole('button', { name: locale === 'zh' ? '提交修正单证' : 'Submit corrected documents' }).click();
      await page.locator('#ebl-file-input').setInputFiles(files());
      const reviewedResponse = await sent; check(`${tag}: review upload accepted`, reviewedResponse.ok());
      const reviewed = await completed((await reviewedResponse.json()).job.job_id);
      check(`${tag}: correction reruns nine steps and opens with new CLEAR evidence`, reviewed.job_id !== near.job_id && reviewed.reviewed_job_id === near.job_id && reviewed.steps.length === 9 && reviewed.compliance.status === 'CLEAR' && ['OPEN', 'OPEN_WITH_WARNING'].includes(reviewed.result_action));
      check(`${tag}: original report remains REVIEW`, (await json(`/api/agent/jobs/${near.job_id}`)).job.compliance.status === 'REVIEW');
      const exact = await upload(files((_, text) => text.replaceAll('Strait Resources Trading Pte. Ltd.', 'Demo Cobalt Lantern Trading Pte. Ltd.')));
      check(`${tag}: exact entity is rejected with BLOCK evidence`, exact.result_action === 'REJECT' && exact.compliance.status === 'BLOCK');
      const port = await upload(files((_, text) => text.replaceAll('Singapore (SGSIN)', 'Unlisted Example Port')));
      check(`${tag}: unknown port is held`, port.result_action === 'HOLD_FOR_REVIEW' && port.compliance.checks.some((check) => check.code === 'PORT_UNKNOWN'));
      const hs = await upload(files((_, text) => text.replaceAll('7403.11', '8542.31')));
      check(`${tag}: dual-use HS is held`, hs.result_action === 'HOLD_FOR_REVIEW' && hs.compliance.checks.some((check) => check.code === 'HS_REVIEW'));
      const imo = await upload(files((name, text) => name === 'bill-of-lading.md' ? `${text}\n**Vessel IMO:** 9999993\n` : text));
      check(`${tag}: synthetic IMO is rejected and provenance is visible`, imo.result_action === 'REJECT' && imo.extraction.some((document) => document.fields.vessel_imo === '9999993'));
      await page.locator('#ebl-upload-status .ebl-compliance').evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
      await measure(`${tag}/all-rules`);
      await page.locator('#lang-btn').click();
      const translated = await page.locator('#ebl-upload-status').textContent();
      check(`${tag}: language switch updates existing evidence`, translated.includes(locale === 'zh' ? 'Demo compliance screening' : '演示合规筛查'));
      check(`${tag}: no internal entry IDs or unresolved keys in visible evidence`, !/DEMO-ENTITY-|comp_code_|comp_category_/u.test(translated));
    }
    check('No page script errors', report.page_errors.length === 0, report.page_errors);
    report.passed = true;
  } catch (error) { report.error = error.message; }
  await page.evaluate((value) => { globalThis.__complianceReport = value; }, report);
  return report;
}
