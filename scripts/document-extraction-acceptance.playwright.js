// Run against scripts/document-extraction-acceptance-server.mjs only (offline fixture vision).
async page => {
  const report = { checked_at: new Date().toISOString(), browser: page.context().browser().version(),
    mode: 'demo', vision_provider: 'mock-fixture', checks: [], screenshots: [], page_errors: [], jobs: [], passed: false };
  const check = (name, ok, detail) => {
    report.checks.push({ name, passed: !!ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) throw new Error(name + (detail === undefined ? '' : `: ${JSON.stringify(detail)}`));
  };
  page.on('pageerror', (error) => report.page_errors.push(error.message));
  const json = async (path, body) => {
    const response = body === undefined ? await page.request.get(new URL(path, page.url()).href)
      : await page.request.post(new URL(path, page.url()).href, { data: body });
    if (!response.ok()) throw new Error(`${path}: ${response.status()}`);
    return response.json();
  };
  const fixture = (name) => `.playwright-cli/wp22-fixtures/${name}`;
  const original = ['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'].map((name) => `data/uploads/copper-sg-shanghai/${name}`);
  const completed = async (id) => {
    let data;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      data = await json(`/api/agent/jobs/${id}?acceptance_poll=${attempt}`);
      if (['DONE', 'FAILED'].includes(data.job.status)) break;
      await page.waitForTimeout(100);
    }
    check(`Job ${id} completed`, data.job.status === 'DONE', { status: data.job.status, error: data.job.error });
    report.jobs.push({ job_id: id, result_action: data.job.result_action, reviewed_job_id: data.job.reviewed_job_id,
      sources: data.job.extraction.map((document) => ({ source: document.source, confidence: document.confidence })) });
    return data.job;
  };
  const upload = async (files, review = false) => {
    const sent = page.waitForResponse((response) => response.request().method() === 'POST'
      && (review ? /\/api\/agent\/jobs\/[^/]+\/review$/u.test(new URL(response.url()).pathname) : new URL(response.url()).pathname === '/api/agent/ingest'));
    await page.locator('#ebl-file-input').setInputFiles(files);
    const response = await sent; check('Browser submitted actual file contents', response.ok());
    const data = await response.json(); return completed(data.job.job_id);
  };
  const measure = async (tag) => {
    const result = await page.locator('#ebl-upload-status').evaluate((element) => ({
      page_overflow: globalThis.document.documentElement.scrollWidth - globalThis.innerWidth,
      fields_overflow: [...element.querySelectorAll('.ebl-fields')].some((node) => node.scrollWidth > node.clientWidth + 1)
    }));
    check(`${tag}: documents fit the viewport`, result.page_overflow <= 1 && !result.fields_overflow, result);
  };
  try {
    check('Isolated server is in Demo mode', (await json('/api/demo/mode')).demoMode === true);
    for (const width of [1440, 390]) for (const locale of ['zh', 'en']) {
      const tag = `${width}/${locale}`;
      await json('/api/demo/reset', {}); await page.setViewportSize({ width, height: 960 }); await page.reload();
      await page.locator('.market-card').first().waitFor();
      if (await page.locator('html').getAttribute('lang') !== (locale === 'zh' ? 'zh-CN' : 'en')) await page.locator('#lang-btn').click();
      await page.locator('#tab-mint').click();
      const pdf = await upload(['bill-of-lading.pdf', 'commercial-invoice.pdf', 'insurance-policy.pdf'].map(fixture));
      check(`${tag}: PDF bundle opens in Demo`, ['OPEN', 'OPEN_WITH_WARNING'].includes(pdf.result_action));
      check(`${tag}: three PDF sources and actual page counts`, pdf.extraction.length === 3 && pdf.extraction.every((document) => document.source.extractor === 'pdf-text'));
      check(`${tag}: invoice amount is exact`, pdf.extraction.some((document) => document.fields.total_amount_usd === 6875000));
      await page.waitForFunction(() => globalThis.document.querySelectorAll('#ebl-upload-status .ebl-fields').length >= 3);
      await page.locator('#ebl-upload-status details').evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
      const text = await page.locator('#ebl-upload-status').textContent();
      check(`${tag}: PDF source and page 2 are visible`, text.includes(locale === 'zh' ? 'PDF 文本层' : 'PDF text layer') && text.includes(locale === 'zh' ? '页码: 2' : 'Page: 2'));
      await measure(tag);
      const replay = await upload(['bill-of-lading.pdf', 'commercial-invoice.pdf', 'insurance-policy.pdf'].map(fixture));
      check(`${tag}: repeated upload is idempotent`, replay.job_id === pdf.job_id);
      const scan = await upload([fixture('scan.pdf')]);
      check(`${tag}: scan is held and explains OCR`, scan.result_action === 'HOLD_FOR_REVIEW' && scan.findings.some((finding) => finding.kind === 'OCR_REQUIRED'));
      await page.waitForFunction(() => globalThis.document.querySelector('#ebl-upload-status')?.textContent.includes(globalThis.document.documentElement.lang === 'zh-CN' ? '没有可读文本' : 'no readable text'));
      const image = await upload([original[0], fixture('invoice.png'), original[2]]);
      check(`${tag}: fixture vision stays in review`, image.result_action === 'HOLD_FOR_REVIEW' && image.extraction.some((document) => document.source.extractor === 'llm-vision' && document.confidence <= .75));
      await page.waitForFunction(() => [...globalThis.document.querySelectorAll('#ebl-upload-status summary')].some((node) => node.textContent.includes('75%')));
      await page.locator('#ebl-upload-status details').evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
      check(`${tag}: image review warning is translated`, (await page.locator('#ebl-upload-status').textContent()).includes(locale === 'zh' ? '图片抽取需要人工核对' : 'Image extraction requires human verification'));
      await measure(`${tag}/vision`);
      await page.locator('#ebl-upload-status summary').filter({ hasText: 'invoice.png' }).evaluate((element) => element.scrollIntoView({ block: 'start' }));
      const screenshot = `docs/evidence/document-extraction-${width}-${locale}.png`;
      await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
      // CLI modal tracking outlives Playwright's filechooser.setFiles(). Suppress only the native
      // picker, click the real review button, then supply files through the real input handler.
      const reviewButton = page.locator('#ebl-upload-status .ebl-job').filter({ hasText: 'invoice.png' }).getByRole('button', { name: locale === 'zh' ? '提交修正单证' : 'Submit corrected documents' });
      const sent = page.waitForResponse((response) => response.request().method() === 'POST' && /\/review$/u.test(new URL(response.url()).pathname));
      await page.locator('#ebl-file-input').evaluate((input) => { input.click = () => {}; });
      await reviewButton.click(); await page.locator('#ebl-file-input').setInputFiles(original);
      const reviewedResponse = await sent; check(`${tag}: corrected files are accepted`, reviewedResponse.ok());
      const reviewed = await completed((await reviewedResponse.json()).job.job_id);
      check(`${tag}: review has a new job and reruns all nine steps`, reviewed.job_id !== image.job_id && reviewed.reviewed_job_id === image.job_id && reviewed.steps.length === 9);
      check(`${tag}: corrected text can open`, ['OPEN', 'OPEN_WITH_WARNING'].includes(reviewed.result_action));
      check(`${tag}: original image HOLD remains`, (await json(`/api/agent/jobs/${image.job_id}`)).job.result_action === 'HOLD_FOR_REVIEW');
      const incomplete = await upload([fixture('incomplete-invoice.pdf')]);
      check(`${tag}: missing invoice date requires review`, incomplete.result_action === 'HOLD_FOR_REVIEW'
        && incomplete.extraction[0].missing_fields.includes('invoice_date'));
      await page.waitForFunction(() => globalThis.document.querySelector('#ebl-upload-status')?.textContent.includes(globalThis.document.documentElement.lang === 'zh-CN' ? '缺少字段: 发票日期' : 'Missing fields: Invoice date'));
      check(`${tag}: missing fields are translated`, (await page.locator('#ebl-upload-status').textContent()).includes(locale === 'zh' ? '缺少字段: 发票日期' : 'Missing fields: Invoice date'));
      await page.locator('#lang-btn').click();
      const translated = await page.locator('#ebl-upload-status').textContent();
      check(`${tag}: language change updates existing PDF sources`, translated.includes(locale === 'zh' ? 'PDF text layer' : 'PDF 文本层'));
      check(`${tag}: no unresolved translation keys`, !/ebld_/u.test(translated));
    }
    check('No page script errors', report.page_errors.length === 0, report.page_errors);
    report.passed = true;
  } catch (error) { report.error = error.message; }
  await page.evaluate((value) => { globalThis.__documentExtractionReport = value; }, report);
  return report;
}
