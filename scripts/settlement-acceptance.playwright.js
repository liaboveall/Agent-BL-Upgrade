// Run only against settlement-acceptance-server.mjs. All writes below mutate an isolated memory chain.
async page => {
  const fs = await import('node:fs/promises'), origin = new URL(page.url()).origin;
  const token = 'wp26-isolated-browser-fixture', headers = { authorization: `Bearer ${token}` };
  const report = { checked_at: new Date().toISOString(), browser: page.context().browser().version(),
    mode: 'live-runtime', chain: 'in-memory-ABI-fixture', real_transactions: 0, checks: [], screenshots: [], page_errors: [], passed: false };
  const check = (name, passed, detail) => { report.checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) }); if (!passed) throw new Error(name); };
  page.on('pageerror', (error) => report.page_errors.push(error.message));
  const json = async (pathname, method = 'GET', data) => {
    const response = await page.request.fetch(new URL(pathname, origin).href, { method, headers, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) throw new Error(`${pathname}: ${response.status()} ${await response.text()}`); return response.json();
  };
  const open = async () => { await page.goto(origin); await page.locator('.market-card').first().waitFor(); await page.locator('#tab-agent').click(); await page.locator('#ac-set-form').waitFor(); };
  const approvals = async (action) => (await json('/api/agent/approvals?status=PENDING')).approvals.filter((item) => item.action === action);
  const submit = async (expectStatus = 200) => {
    const response = page.waitForResponse((item) => item.request().method() === 'POST' && new URL(item.url()).pathname === '/api/agent/events');
    await page.locator('#ac-set-form button[type="submit"]').click(); const reply = await response;
    check(`Evidence request has expected status ${expectStatus}`, reply.status() === expectStatus); return reply.json();
  };
  const approve = async (id) => {
    const pendingCard = page.locator('.ac-approval-card').filter({ has: page.locator(`[data-focus-key="approve:${id}"]`) });
    await pendingCard.waitFor(); const response = page.waitForResponse((item) => new URL(item.url()).pathname.endsWith(`/${id}/approve`));
    await pendingCard.locator(`[data-focus-key="approve:${id}"]`).click(); check('Approval request succeeds', (await response).ok());
    const card = page.locator('.ac-approval-card').filter({ hasText: id });
    await card.locator('.ac-command').waitFor(); return card;
  };
  const measure = async (tag) => {
    const dimensions = await page.evaluate(() => ({ width: globalThis.innerWidth, document: globalThis.document.documentElement.scrollWidth }));
    check(`${tag}: no horizontal overflow`, dimensions.document <= dimensions.width, dimensions);
    check(`${tag}: no unresolved translations or object coercion`, !/ac_set_|\[object Object\]/u.test(await page.locator('#view-agent').innerText()));
    const visibleText = await page.locator('#view-agent').innerText();
    check(`${tag}: no empty-value implementation text`, !/(?:^|\n)\s*(?:null|undefined)\s*(?:\n|$)/u.test(visibleText));
    check(`${tag}: repayment evidence text is not clipped`, await page.locator('.ac-set-evidence p').evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth)));
  };
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript((value) => { sessionStorage.setItem('agentbl.adminToken', value); }, token);
    const state = await json('/__acceptance__/state'); check('Harness is explicitly an isolated memory chain', state.chain === 'in-memory-ABI-fixture');
    const status = await json('/api/agent/status'); check('Isolated Live runtime has no signing key', status.mode === 'live' && Object.values(status.signers).every((role) => !role.configured));
    const unauthorized = await page.request.post(new URL('/api/agent/events', origin).href, { data: {} }); check('Live intake requires administrator authentication', unauthorized.status() === 401);
    for (const width of [1440, 390]) for (const locale of ['zh', 'en']) {
      const tag = `${width}/${locale}`;
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await json('/__acceptance__/reset?recipient=missing', 'POST'); await open();
      if (await page.locator('html').getAttribute('lang') !== (locale === 'zh' ? 'zh-CN' : 'en')) await page.locator('#lang-btn').click();
      check(`${tag}: payment submission is disabled without a configured recipient`, await page.locator('#ac-set-form button[type="submit"]').isDisabled());
      await json('/__acceptance__/reset', 'POST'); await open();
      if (await page.locator('html').getAttribute('lang') !== (locale === 'zh' ? 'zh-CN' : 'en')) await page.locator('#lang-btn').click();
      await page.locator('#ac-set-case').selectOption('CASE-EBL-2026-OIL-SG-ULS');
      await page.locator('#ac-set-type').selectOption('PAYMENT_RECEIVED');
      await page.locator('#ac-set-proof').fill(state.payment_hash); await page.locator('#ac-set-amount').fill('0.000001');
      await submit(422); await page.locator('#ac-set-result.ac-error').waitFor();
      check(`${tag}: payment rejection is localized`, (await page.locator('#ac-set-result').innerText()).includes(locale === 'zh' ? '付款回执与已配置' : 'does not match the configured recipient'));
      check(`${tag}: wrong amount creates no approval or transaction`, (await json('/api/agent/approvals')).approvals.length === 0 && (await json('/__acceptance__/state')).sent.length === 0);
      await page.locator('#ac-set-amount').fill('1.234567'); await submit();
      const [payment] = await approvals('RECORD_PAYMENT'); check(`${tag}: exact repayment becomes one owner proposal`, payment?.plan.steps[0].args[2] === '1234567');
      const paymentCard = await approve(payment.approval_id);
      check(`${tag}: verified evidence shows precise USDC and configured recipient`, (await paymentCard.innerText()).includes('1.234567 USDC') && (await paymentCard.innerText()).includes(state.recipient));
      check(`${tag}: approving never signs and CLI defaults to dry run`, (await json('/__acceptance__/state')).sent.length === 0 && !(await paymentCard.locator('.ac-command code').innerText()).includes('--confirm'));
      await json(`/__acceptance__/step/${payment.approval_id}`, 'POST');
      check(`${tag}: payment alone does not propose settlement`, (await approvals('SETTLE')).length === 0);
      await page.reload(); await page.locator('.market-card').first().waitFor(); await page.locator('#tab-agent').click(); await page.locator('#ac-set-form').waitFor();
      await page.locator('#ac-set-case').selectOption('CASE-EBL-2026-OIL-SG-ULS'); await page.locator('#ac-set-type').selectOption('CARGO_ARRIVED');
      check(`${tag}: arrival proof has no amount field`, !await page.locator('#ac-set-amount').isVisible());
      await page.locator('#ac-set-proof').fill('port-delivery-receipt-7'); await submit();
      const [arrival] = await approvals('RECORD_ARRIVAL'); await approve(arrival.approval_id); await json(`/__acceptance__/step/${arrival.approval_id}`, 'POST');
      const [settle] = await approvals('SETTLE'); check(`${tag}: both recorded proofs produce settlement with unchanged exact amount`, settle?.plan.steps[0].args[1] === '1234567');
      const card = await approve(settle.approval_id);
      check(`${tag}: settlement approval changes no chain state`, (await json('/__acceptance__/state')).state === 5);
      check(`${tag}: settlement disclosure is localized`, (await card.innerText()).includes(locale === 'zh' ? '不托管或分配资金' : 'does not hold or distribute funds'));
      const show = card.getByRole('button', { name: locale === 'zh' ? '查看要签的交易' : 'Show the transactions to sign' });
      await show.focus(); await page.keyboard.press('Enter'); await card.locator('.ac-owner-plan').waitFor();
      check(`${tag}: settlement plan has one separately approved transaction`, await card.locator('.ac-owner-plan > li').count() === 1);
      await card.locator('.ac-owner-plan summary').focus(); await page.keyboard.press('Enter');
      check(`${tag}: contract arguments expand by keyboard`, await card.locator('.ac-owner-plan details').evaluate((node) => node.open));
      check(`${tag}: exact atomic repayment is reviewable`, (await card.locator('.ac-owner-plan').innerText()).includes('1234567'));
      await page.locator('#ac-set-proof').fill('draft-retained-during-SSE');
      await json('/api/agent/control', 'POST', { action: 'tick' });
      await page.waitForTimeout(500); check(`${tag}: evidence draft survives activity refresh`, await page.locator('#ac-set-proof').inputValue() === 'draft-retained-during-SSE');
      await measure(tag);
      await page.evaluate((lang) => {
        const banner = globalThis.document.createElement('p'); banner.textContent = lang === 'zh' ? '隔离本地验收：内存链桩，真实交易 0 笔' : 'Isolated local acceptance: memory chain fixture, zero real transactions';
        banner.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:99999;max-width:calc(100vw - 16px);background:#fff1c2;color:#322500;padding:8px;font-size:12px'; globalThis.document.body.append(banner);
      }, locale);
      await card.scrollIntoViewIfNeeded(); const screenshot = `docs/evidence/settlement-${width}-${locale}.png`; await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
      const completed = await json(`/__acceptance__/step/${settle.approval_id}`, 'POST');
      check(`${tag}: only the matching owner receipt completes settlement`, completed.complete && completed.decision.status === 'COMPLETED' && (await json('/__acceptance__/state')).state === 9);
      const decisions = (await json('/api/agent/decisions')).decisions; check(`${tag}: all three actions have individually verified receipts`, decisions.length === 3 && decisions.every((item) => item.status === 'COMPLETED' && item.execution.tx_hash));
    }
    check('No browser script errors', report.page_errors.length === 0, report.page_errors); report.passed = true;
  } catch (error) { report.error = error.message; throw error; }
  finally {
    let previous;
    try { previous = JSON.parse(await fs.readFile('docs/evidence/settlement-browser.json', 'utf8')); } catch {}
    if (previous) {
      for (let attempt = 1; ; attempt++) {
        const name = `docs/evidence/settlement-browser-attempt${attempt}.json`;
        try { await fs.access(name); } catch { await fs.writeFile(name, `${JSON.stringify(previous, null, 2)}\n`); break; }
      }
    }
    await fs.writeFile('docs/evidence/settlement-browser.json', `${JSON.stringify(report, null, 2)}\n`);
  }
  return { passed: report.passed, checks: report.checks.length, screenshots: report.screenshots };
}
