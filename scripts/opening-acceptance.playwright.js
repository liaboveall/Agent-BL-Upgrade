// Run only against opening-acceptance-server.mjs; every chain write below changes a memory fixture.
async page => {
  const fs = await import('node:fs/promises');
  const origin = new URL(page.url()).origin;
  const token = 'wp24-isolated-browser-fixture';
  const headers = { authorization: `Bearer ${token}` };
  const report = { checked_at: new Date().toISOString(), browser: page.context().browser().version(),
    mode: 'live-runtime', chain: 'in-memory-ABI-fixture', real_transactions: 0, checks: [], screenshots: [], page_errors: [], passed: false };
  const check = (name, passed, detail) => {
    report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
    if (!passed) throw new Error(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  };
  page.on('pageerror', (error) => report.page_errors.push(error.message));
  const json = async (pathname, method = 'GET') => {
    const response = await page.request.fetch(new URL(pathname, origin).href, { method, headers });
    if (!response.ok()) throw new Error(`${pathname}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const waitJob = async (id) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const { job } = await json(`/api/agent/jobs/${id}`);
      if (job.status === 'DONE') return job;
      if (job.status === 'FAILED') throw new Error(JSON.stringify(job.error));
      await page.waitForTimeout(100);
    }
    throw new Error('Intake timed out');
  };
  const files = async (folder) => Promise.all(['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'].map(async (name) => ({
    name, mimeType: 'text/markdown', buffer: Buffer.from(await fs.readFile(`data/uploads/${folder}/${name}`, 'utf8'))
  })));
  const upload = async (folder, caseId) => {
    await page.locator('#case-dropdown').selectOption(caseId);
    const pending = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/agent/ingest');
    await page.locator('#ebl-file-input').setInputFiles(await files(folder));
    const response = await pending; check('Document upload is authorized', response.ok());
    const job = await waitJob((await response.json()).job.job_id);
    return { job, ...(await json(`/api/agent/decisions/${job.decision_ids[0]}`)) };
  };
  const openAgent = async () => { await page.locator('#tab-agent').click(); await page.locator('#ac-status').waitFor({ state: 'visible' }); };
  const measure = async (tag) => {
    const dimensions = await page.evaluate(() => ({ width: globalThis.innerWidth, document: globalThis.document.documentElement.scrollWidth }));
    check(`${tag}: no horizontal document overflow`, dimensions.document <= dimensions.width, dimensions);
    const text = await page.locator('#view-agent').innerText();
    check(`${tag}: plan has no unresolved translation keys or object coercions`, !/ac_open_|\[object Object\]/u.test(text));
  };
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript((value) => { sessionStorage.setItem('agentbl.adminToken', value); }, token);
    const status = await json('/api/agent/status');
    check('No signing role is configured in isolated Live runtime', status.mode === 'live' && Object.values(status.signers).every((item) => !item.configured));
    for (const width of [1440, 390]) for (const locale of ['zh', 'en']) {
      const tag = `${width}/${locale}`;
      await json('/__acceptance__/reset', 'POST');
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await page.goto(origin);
      await page.locator('.market-card').first().waitFor();
      if (await page.locator('html').getAttribute('lang') !== (locale === 'zh' ? 'zh-CN' : 'en')) await page.locator('#lang-btn').click();
      await page.locator('#tab-mint').click();
      const oil = await upload('crude-sg-ulsan', 'CASE-EBL-2026-OIL-SG-ULS');
      check(`${tag}: new cargo produces owner approval without broadcasting`, oil.decision.status === 'PENDING_APPROVAL' && oil.approvals[0].route === 'owner_cli' && (await json('/__acceptance__/state')).sent.length === 0);
      const id = oil.approvals[0].approval_id;
      await openAgent();
      const card = page.locator('.ac-approval-card').filter({ hasText: oil.decision.case_id }); await card.waitFor();
      check(`${tag}: three-step disclosure is localized`, (await card.innerText()).includes(locale === 'zh' ? '三笔交易逐笔确认' : 'Confirm each of three transactions separately'));
      await card.getByRole('button', { name: locale === 'zh' ? '批准' : 'Approve', exact: true }).click();
      await card.locator('.ac-command').waitFor();
      check(`${tag}: approval waits for a signature without broadcasting`, (await json(`/api/agent/approvals/${id}`)).approval.status === 'AWAITING_OWNER_SIGNATURE' && (await json('/__acceptance__/state')).sent.length === 0);
      check(`${tag}: CLI hint selects the first step and defaults to dry run`, (await card.locator('.ac-command').innerText()).includes('--step 0') && !(await card.locator('.ac-command code').innerText()).includes('--confirm'));
      const show = card.getByRole('button', { name: locale === 'zh' ? '查看要签的交易' : 'Show the transactions to sign' });
      await show.focus(); await page.keyboard.press('Enter'); await card.locator('.ac-owner-plan').waitFor();
      check(`${tag}: all three steps appear`, await card.locator('.ac-owner-plan > li').count() === 3);
      check(`${tag}: dependent ID is presented as awaiting a receipt`, (await card.locator('.ac-owner-plan').innerText()).includes(locale === 'zh' ? '等待前一步回执' : 'Awaiting the eBL ID'));
      const detail = card.locator('.ac-owner-plan details').first(); await detail.locator('summary').focus(); await page.keyboard.press('Enter');
      check(`${tag}: arguments expand by keyboard`, await detail.evaluate((node) => node.open));
      await measure(`${tag}/plan`);
      await page.evaluate((lang) => {
        const banner = globalThis.document.createElement('p'); banner.className = 'wp24-acceptance-banner';
        banner.textContent = lang === 'zh' ? '隔离本地验收：链使用内存桩，真实交易 0 笔' : 'Isolated local verification: in-memory chain fixture, zero real transactions';
        banner.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:99999;max-width:calc(100vw - 16px);background:#fff1c2;color:#322500;padding:8px;font-size:12px'; globalThis.document.querySelector('#view-agent').prepend(banner);
      }, locale);
      await card.scrollIntoViewIfNeeded();
      const screenshot = `docs/evidence/opening-${width}-${locale}.png`; await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
      for (let index = 0; index < 3; index++) {
        const result = await json(`/__acceptance__/step/${id}`, 'POST');
        check(`${tag}: fixture step ${index} is verified in order`, result.approval.steps_done.length === index + 1 && result.complete === (index === 2));
        if (index < 2) {
          await page.reload(); await page.locator('.market-card').first().waitFor(); await openAgent();
          await page.waitForFunction((step) => [...globalThis.document.querySelectorAll('.ac-command code')].some((node) => node.textContent.includes(`--step ${step}`)), index + 1);
          check(`${tag}: progress ${index + 1}/3 survives refresh`, (await card.innerText()).includes(`${index + 1}/3`));
        } else {
          check(`${tag}: pool is linked only after the final receipt`, result.decision.status === 'COMPLETED' && result.decision.execution.tx_hashes.length === 3 && (await json('/__acceptance__/state')).registry.some((item) => item.case_id === oil.decision.case_id && item.chain.pool_id === 11));
        }
      }
      await page.locator('#tab-mint').click();
      const linked = await upload('copper-sg-shanghai', 'CASE-EBL-2026-CU-SG-SHA');
      check(`${tag}: registered copper produces a link with no transactions`, linked.decision.opening.kind === 'link' && linked.approvals[0].plan.steps.length === 0);
      await openAgent();
      const linkCard = page.locator('.ac-approval-card').filter({ hasText: 'CASE-EBL-2026-CU-SG-SHA' });
      await linkCard.waitFor(); await measure(`${tag}/link-proposal`);
      await page.locator('#lang-btn').click();
      check(`${tag}: language switch updates existing-cargo disclosure`, (await linkCard.innerText()).includes(locale === 'zh' ? 'Link already registered cargo' : '关联已登记的货物'));
      await page.locator('#lang-btn').click();
      const linkResponse = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/agent/approvals/${linked.approvals[0].approval_id}/approve`);
      await linkCard.getByRole('button', { name: locale === 'zh' ? '核对并关联' : 'Verify and link', exact: true }).click();
      check(`${tag}: association approval completes`, (await linkResponse).ok());
      check(`${tag}: linking does not broadcast or alter protected status`, (await json('/__acceptance__/state')).sent.length === 3 && (await json(`/api/agent/decisions/${linked.decision.decision_id}`)).decision.execution.mode === 'record');
      await measure(`${tag}/linked`);
    }
    check('No page script errors', report.page_errors.length === 0, report.page_errors); report.passed = true;
  } catch (error) { report.error = error.message; }
  return report;
}
