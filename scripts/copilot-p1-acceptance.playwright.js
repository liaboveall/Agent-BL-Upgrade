// Run via playwright-cli against an isolated offline Demo server. Never use a Live server.
async page => {
  const report = { checked_at: new Date().toISOString(), browser: page.context().browser().version(), mode: 'demo',
    checks: [], transitions: [], screenshots: [], page_errors: [], passed: false };
  const check = (name, passed, detail) => {
    report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
    if (!passed) throw new Error(name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
  };
  const json = async (path, body) => {
    const response = body === undefined ? await page.request.get(new URL(path, page.url()).href)
      : await page.request.post(new URL(path, page.url()).href, { data: body });
    if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const poolId = 'CASE-EBL-2026-CU-SG-SHA';
  page.on('pageerror', (error) => report.page_errors.push(error.message));
  const capture = async (name) => {
    const path = `docs/evidence/copilot-p1-${name}.png`;
    await page.screenshot({ path }); report.screenshots.push(path);
  };
  const measure = async (name) => {
    const result = await page.locator('#copilot-dialog').evaluate((dialog) => ({
      left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right,
      viewport: globalThis.innerWidth, overflow: dialog.scrollWidth - dialog.clientWidth,
      cardOverflow: [...dialog.querySelectorAll('.cp-card,.cp-action-card')].some((element) => element.scrollWidth > element.clientWidth + 1)
    }));
    check(name, result.left >= 0 && result.right <= result.viewport + 1 && result.overflow <= 1 && !result.cardOverflow, result);
  };
  try {
    const mode = await json('/api/demo/mode');
    check('Isolated server is in Demo mode', mode.demoMode === true);
    for (const width of [1440, 390]) for (const locale of ['zh', 'en']) {
      const tag = `${width}/${locale}`;
      await json('/api/demo/reset', {});
      await page.setViewportSize({ width, height: 940 }); await page.reload();
      await page.locator('.market-card').first().waitFor();
      if (await page.locator('html').getAttribute('lang') !== (locale === 'zh' ? 'zh-CN' : 'en')) await page.locator('#lang-btn').click();
      await json('/api/agent/scenarios/copper-typhoon/start', { reset: true });
      await page.evaluate(() => {
        globalThis.__cpP1Updates = [];
        globalThis.__cpP1SearchUpdates = [];
        globalThis.addEventListener('agentbl:copilotupdate', ({ detail }) => {
          if (detail.scope === 'assistant') globalThis.__cpP1Updates.push(detail.update);
          if (detail.scope === 'search') globalThis.__cpP1SearchUpdates.push(detail.update);
        });
      });
      await page.locator('#search-input').fill('compare copper and soybeans');
      const searched = page.waitForResponse((response) => /\/api\/copilot\/sessions\/[^/]+\/messages$/u.test(new URL(response.url()).pathname));
      await page.locator('#ai-search-btn').click();
      const searchPath = new URL((await searched).url()).pathname.replace(/\/messages$/u, '');
      await page.locator('#ai-search-btn:not([disabled])').waitFor();
      await page.locator('.cp-launcher').click();
      const dialog = page.locator('#copilot-dialog');
      const input = dialog.locator(':scope > form input');
      const submit = async (message) => {
        await input.fill(message);
        const received = page.waitForResponse((response) => /\/api\/copilot\/sessions\/[^/]+\/messages$/u.test(new URL(response.url()).pathname));
        await input.press('Enter');
        const response = await received;
        if (!response.ok()) throw new Error(`Copilot query: ${response.status()}`);
        await dialog.locator(':scope > form button:not([disabled])').waitFor();
        return new URL(response.url()).pathname.replace(/\/messages$/u, '');
      };
      const sessionPath = await submit('compare copper and soybeans');
      check(`${tag}: search and assistant sessions are independent`, sessionPath !== searchPath);
      const initial = (await json(sessionPath)).context;
      check(`${tag}: actual copper pool is recommended`, initial.last_recommendation.items.some((item) => item.pool_id === poolId));
      const watch = dialog.locator(`[data-focus-key="cp-watch-${poolId}"]`).last();
      await watch.click(); await page.waitForFunction((id) => globalThis.document.querySelector(`#copilot-dialog [data-focus-key="cp-watch-${id}"]`)?.getAttribute('aria-pressed') === 'true', poolId);
      check(`${tag}: watchlist persists`, (await json(sessionPath)).context.watchlist.includes(poolId));
      const step = async () => json('/api/agent/scenarios/copper-typhoon/step', {});
      await step(); await step(); await step(); // baseline, scenario subscription, departure
      await page.waitForFunction(() => globalThis.__cpP1Updates.some((update) => update.action === 'MARK_IN_TRANSIT' && update.phase === 'EXECUTION_CONFIRMED'));
      await input.focus(); await step();
      await page.waitForFunction(() => globalThis.__cpP1Updates.some((update) => update.action === 'REPRICE' && update.phase === 'EXECUTION_CONFIRMED'));
      check(`${tag}: updates preserve input focus`, await input.evaluate((element) => element === globalThis.document.activeElement));
      const beforePause = (await json(sessionPath)).context.last_recommendation.items;
      await watch.focus(); await step();
      await page.waitForFunction(() => globalThis.__cpP1Updates.some((update) => update.action === 'PAUSE' && update.phase === 'EXECUTION_CONFIRMED'));
      check(`${tag}: rerender preserves the focused watch button`, await watch.evaluate((element) => element === globalThis.document.activeElement));
      const afterPause = (await json(sessionPath)).context;
      const paused = await json(`/api/pool/status?pool_id=${poolId}`);
      check(`${tag}: confirmed pause uses current pool state`, paused.status === 'Paused');
      check(`${tag}: notification contains the decision link`, await dialog.locator('.cp-update button').count() === 1);
      await page.waitForFunction(() => globalThis.__cpP1SearchUpdates.some((update) => update.action === 'PAUSE' && update.phase === 'EXECUTION_CONFIRMED'));
      check(`${tag}: market search also receives the risk update`, await page.locator('#copilot-search-results .cp-update').count() === 1);
      check(`${tag}: original preference history is unchanged`, afterPause.history.length === initial.history.length
        && JSON.stringify(afterPause.constraints) === JSON.stringify(initial.constraints));
      const updates = await page.evaluate(() => globalThis.__cpP1Updates);
      const pause = updates.findLast((update) => update.action === 'PAUSE' && update.phase === 'EXECUTION_CONFIRMED');
      const change = pause.changes.find((entry) => entry.pool_id === poolId);
      check(`${tag}: displayed rank change comes from real snapshots`, change?.previous_rank === beforePause.find((item) => item.pool_id === poolId)?.rank
        && change?.rank === afterPause.last_recommendation.items.find((item) => item.pool_id === poolId)?.rank, change);
      check(`${tag}: decision reason is visible`, !!pause.reasoning_summary && (await dialog.locator('.cp-update').textContent()).includes(pause.reasoning_summary));
      report.transitions.push({ tag, decision_id: pause.decision_id, action: pause.action, changes: pause.changes });
      await measure(`${tag}: update card fits viewport`);
      if (width === 390) await capture(`mobile-rerank-${locale}`);
      await dialog.locator('.cp-update button').click(); await page.locator('#ac-drawer[open]').waitFor();
      await page.waitForFunction((id) => globalThis.document.querySelector('.ac-drawer-body')?.dataset.decisionId === id, pause.decision_id);
      check(`${tag}: decision link opens the actual decision`, await page.locator(`.ac-drawer-body [data-focus-key="copy:${pause.decision_id}"]`).count() === 1);
      await page.keyboard.press('Escape');
      await step(); await step();
      await page.waitForFunction(() => globalThis.__cpP1Updates.some((update) => update.action === 'RESUME' && update.phase === 'EXECUTION_CONFIRMED'));
      check(`${tag}: resume refreshes without another user query`, (await json(sessionPath)).context.history.length === 1);
      const positions = async () => (await json('/api/investors/portfolio')).investments;
      const count = (await positions()).length;
      await submit('copper budget USD 1000');
      const ready = async (message, serviceId) => {
        await submit(message);
        let card = dialog.locator('.cp-action-card').last();
        if (!await card.locator('.cp-action-confirm').count()) {
          await card.locator('select').first().selectOption(poolId);
          if (serviceId) await card.locator('select').nth(1).selectOption(serviceId);
          else await card.locator('input').fill('1000');
          await card.locator('button[type="submit"]').click();
          await dialog.locator('.cp-action-card').last().locator('.cp-action-confirm').waitFor();
          card = dialog.locator('.cp-action-card').last();
        }
        return card;
      };
      let card = await ready('subscribe USD 1000');
      check(`${tag}: messages do not execute a subscription`, (await positions()).length === count);
      check(`${tag}: card discloses certificate and capital risk`, (await card.textContent()).includes(locale === 'zh' ? '不托管资金' : 'holds no investor funds'));
      await measure(`${tag}: subscription card fits viewport`);
      await card.locator('.cp-action-cancel').click();
      await page.waitForFunction(() => [...globalThis.document.querySelectorAll('.cp-action-status')].some((element) => /Cancelled|已取消/u.test(element.textContent)));
      check(`${tag}: cancellation creates no position`, (await positions()).length === count);
      card = await ready('subscribe USD 1000');
      await card.locator('.cp-action-confirm').evaluate((element) => { element.click(); element.click(); });
      await page.waitForFunction(() => [...globalThis.document.querySelectorAll('.cp-action-status')].some((element) => /Demo subscription recorded|Demo 认购已记录/u.test(element.textContent)));
      const recorded = await positions();
      check(`${tag}: double click creates exactly one Demo position`, recorded.length === count + 1);
      const copilotPosition = recorded.findLast((item) => item.source_label === 'Copilot');
      check(`${tag}: actual position preserves cost, origin and honest reference`, copilotPosition?.amountUsd === 1000 && copilotPosition.txHash === null && copilotPosition.reference.startsWith('demo:'));
      card = await ready('buy a valuation report', 'premium-valuation');
      check(`${tag}: report price comes from catalogue`, (await card.textContent()).includes('0.002000'));
      await card.locator('.cp-action-confirm').click();
      await page.waitForFunction(() => [...globalThis.document.querySelectorAll('.cp-action-status')].some((element) => /Report unlocked|报告已解锁/u.test(element.textContent)));
      await card.locator('summary').click();
      check(`${tag}: paid report is visible`, (await card.locator('.cp-report-body').textContent()).includes('premium-valuation'));
      const reportData = JSON.parse(await card.locator('.cp-report-body').textContent());
      check(`${tag}: Demo report uses a labelled receipt instead of a synthetic transaction`, reportData.payment.mode === 'demo'
        && reportData.payment.txHash === undefined && (await card.locator('.cp-action-status').textContent()).includes('demo:x402:'));
      await measure(`${tag}: report card fits viewport`);
      check(`${tag}: report cannot be paid twice from the card`, await card.locator('.cp-action-confirm').isDisabled());
      if (width === 390) await capture(`mobile-actions-${locale}`);
      await page.keyboard.press('Escape');
      check(`${tag}: Escape closes dialog and restores launcher focus`, !await dialog.evaluate((element) => element.open)
        && await page.locator('.cp-launcher').evaluate((element) => element === globalThis.document.activeElement));
      await page.locator('#lang-btn').click(); await page.locator('.cp-launcher').click();
      check(`${tag}: completed receipt survives language changes`, await dialog.locator('.cp-action-confirm').last().isDisabled()
        && (await dialog.locator('.cp-action-status').last().textContent()).includes('demo:x402:'));
      await page.keyboard.press('Escape');
    }
    check('No page script errors', report.page_errors.length === 0, report.page_errors);
    report.passed = true;
  } catch (error) { report.error = error.message; }
  await page.evaluate((report) => { globalThis.__copilotP1Report = report; }, report);
  return report;
}
