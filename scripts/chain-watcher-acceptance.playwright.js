// Repository-owned scenario; all mutations target the local memory-chain harness.
async page => {
  const fs = await import('node:fs/promises'), origin = new URL(page.url()).origin;
  const token = 'wp27-isolated-browser-fixture', headers = { authorization: `Bearer ${token}` };
  const report = { checked_at: new Date().toISOString(), browser: page.context().browser().version(),
    chain: 'in-memory-ABI-fixture', real_transactions: 0, checks: [], screenshots: [], page_errors: [], passed: false };
  const check = (name, value, detail) => {
    report.checks.push({ name, passed: Boolean(value), ...(detail === undefined ? {} : { detail }) });
    if (!value) throw new Error(name);
  };
  const json = async (pathname, method = 'GET', data) => {
    const response = await page.request.fetch(new URL(pathname, origin).href, { headers, method, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) throw new Error(`${pathname}: ${response.status()} ${await response.text()}`); return response.json();
  };
  const open = async (lang) => {
    await page.goto(origin); await page.locator('#tab-agent').waitFor();
    await page.evaluate((value) => globalThis.localStorage.setItem('ts_lang', value), lang);
    await page.goto(origin); await page.locator('.market-card').first().waitFor(); await page.locator('#tab-agent').click();
    await page.locator('.ac-chain-watcher').waitFor();
  };
  const refresh = async () => {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/agent/status');
    await page.locator('[data-focus-key="control:tick"]').click();
    const status = await (await response).json();
    await page.waitForFunction((expected) => {
      const card = globalThis.document.querySelector('.ac-chain-watcher');
      return card?.dataset.watcherState === expected.state && card.dataset.lastBlock === expected.block && card.dataset.chainStop === expected.stop;
    }, { state: status.chain_watcher.state, block: String(status.chain_watcher.last_block ?? ''), stop: String(Boolean(status.emergency_stop_sources?.chain)) });
  };
  const measure = async (tag) => {
    const size = await page.evaluate(() => ({ width: globalThis.innerWidth, document: globalThis.document.documentElement.scrollWidth }));
    check(`${tag}: no horizontal overflow`, size.document <= size.width, size);
    const text = await page.locator('#view-agent').innerText();
    check(`${tag}: no unresolved translations or implementation empty values`, !/ac_chain_|\[object Object\]|(?:^|\n)\s*(?:null|undefined)\s*(?:\n|$)/u.test(text));
    check(`${tag}: watcher copy fits its panel`, await page.locator('.ac-chain-watcher p').evaluateAll((nodes) => nodes.every((n) => n.scrollWidth <= n.clientWidth)));
  };
  page.on('pageerror', (e) => report.page_errors.push(e.message));
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript((value) => sessionStorage.setItem('agentbl.adminToken', value), token);
    check('Harness explicitly has zero real transactions', (await json('/__acceptance__/state')).real_transactions === 0);
    const unauthorized = await page.request.get(new URL('/__acceptance__/change?kind=stop', origin).href);
    check('Fixture controls require admin authentication', unauthorized.status() === 401);
    for (const width of [1440, 390]) for (const lang of ['zh', 'en']) {
      const tag = `${width}/${lang}`; await json('/__acceptance__/reset', 'POST');
      await page.setViewportSize({ width, height: 1040 }); await open(lang);
      const card = page.locator('.ac-chain-watcher');
      await page.locator('[data-watcher-state="healthy"]').waitFor();
      check(`${tag}: healthy watcher is localized`, (await card.innerText()).includes(lang === 'zh' ? '已同步' : 'Synced'));
      check(`${tag}: progress shows confirmed block, lag and confirmations`, (await card.innerText()).includes('110') && (await card.innerText()).includes(lang === 'zh' ? '确认数 1' : 'Confirmations 1'));
      const status = await json('/api/agent/status');
      check(`${tag}: no configured signing roles`, Object.values(status.signers).every((s) => !s.configured));
      const first = await json('/__acceptance__/change?kind=reprice', 'POST'); await refresh();
      check(`${tag}: external repricing reconciles exact atomic amount`, first.pools.some((p) => p.issue_price_atomic === '777000' && p.status === 'Repriced' && p.quote_mismatch));
      const activity = await json('/api/agent/activity');
      check(`${tag}: real decoded event provenance is visible through activity API`, activity.activities.some((a) => a.action === 'CHAIN_EVENT_OBSERVED' && a.details.event_name === 'OfferingRepriced'));
      check(`${tag}: mismatch is recorded`, activity.activities.some((a) => a.action === 'RECONCILE_MISMATCH'));
      check(`${tag}: observations create no decisions or approvals`, (await json('/api/agent/decisions')).count === 0 && (await json('/api/agent/approvals')).approvals.length === 0);
      const unknown = await json('/__acceptance__/change?kind=unknown', 'POST');
      check(`${tag}: unknown cargo stays in chain-only monitoring`, unknown.status.chain_watcher.pools.some((p) => p.pool_id === 12 && p.monitoring === 'chain-only'));
      await json('/__acceptance__/change?kind=stop', 'POST'); await refresh();
      check(`${tag}: contract stop explanation is localized`, (await card.innerText()).includes(lang === 'zh' ? '不能解除合约停止' : 'cannot release the contract stop'));
      await page.locator('[data-focus-key="control:emergency"]').focus();
      const control = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/agent/control');
      await page.keyboard.press('Enter'); await control;
      check(`${tag}: local stop is engaged by keyboard`, (await json('/api/agent/status')).emergency_stop_sources.local);
      await json('/api/agent/control', 'POST', { action: 'emergency_stop', stopped: false }); await refresh();
      check(`${tag}: local switch cannot release contract stop`, (await json('/api/agent/status')).emergency_stop);
      await json('/__acceptance__/change?kind=release', 'POST'); await refresh();
      check(`${tag}: confirmed contract release resumes monitoring`, !(await json('/api/agent/status')).emergency_stop);
      const before = await json('/__acceptance__/state');
      await json('/__acceptance__/change?kind=rpc-failure', 'POST'); await refresh();
      await page.locator('[data-watcher-state="degraded"]').waitFor();
      check(`${tag}: outage is localized`, (await card.innerText()).includes(lang === 'zh' ? '等待重试' : 'awaiting retry'));
      check(`${tag}: failed poll preserves cursor and exposes retry time`, (await json('/__acceptance__/state')).cursor === before.cursor && Boolean((await json('/api/agent/status')).chain_watcher.retry_at));
      const recovered = await json('/__acceptance__/change?kind=recover', 'POST'); await refresh();
      await page.locator('[data-watcher-state="healthy"]').waitFor();
      check(`${tag}: successful retry advances cursor`, recovered.cursor > before.cursor);
      const demo = await json('/__acceptance__/change?kind=demo', 'POST'); await open(lang);
      await page.locator('[data-watcher-state="inactive"]').waitFor();
      const quiet = await json('/api/agent/control', 'POST', { action: 'tick' });
      check(`${tag}: Demo watcher is inactive and silent`, quiet.chain_watcher.state === 'inactive' && (await json('/__acceptance__/state')).rpc_calls === demo.rpc_calls);
      check(`${tag}: Demo has no chain-only pools or Live price mirrors`, demo.pools.every((p) => !p.chain_only && p.issue_price_atomic === null));
      await json('/__acceptance__/change?kind=live', 'POST'); await open(lang);
      await page.locator('[data-watcher-state="healthy"]').waitFor();
      await json('/__acceptance__/change?kind=reorg', 'POST'); await refresh();
      await page.locator('[data-watcher-state="degraded"]').waitFor();
      check(`${tag}: reorg needs review and cannot advance the cursor`, (await json('/api/agent/status')).chain_watcher.reconciliation_required);
      check(`${tag}: recovery boundary is localized`, (await card.innerText()).includes(lang === 'zh' ? '核对历史证据' : 'Review the saved evidence'));
      await measure(tag);
      await page.evaluate((locale) => {
        const label = globalThis.document.createElement('p'); label.textContent = locale === 'zh' ? '隔离本地验收：内存链，真实交易 0 笔' : 'Isolated local acceptance: memory chain, zero real transactions';
        label.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:99999;max-width:calc(100vw - 16px);background:#fff1c2;color:#322500;padding:8px;font-size:12px'; globalThis.document.body.append(label);
      }, lang);
      await card.scrollIntoViewIfNeeded(); const file = `docs/evidence/chain-watcher-${width}-${lang}.png`;
      await page.screenshot({ path: file }); report.screenshots.push(file);
    }
    check('No browser script errors', report.page_errors.length === 0, report.page_errors); report.passed = true;
  } catch (error) { report.error = error.message; throw error; }
  finally {
    let previous; try { previous = await fs.readFile('docs/evidence/chain-watcher-browser.json', 'utf8'); } catch {}
    if (previous) for (let attempt = 1; ; attempt++) {
      const file = `docs/evidence/chain-watcher-browser-attempt${attempt}.json`;
      try { await fs.access(file); } catch { await fs.writeFile(file, previous); break; }
    }
    report.summary = { passed: report.checks.filter((c) => c.passed).length, total: report.checks.length };
    await fs.writeFile('docs/evidence/chain-watcher-browser.json', `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
