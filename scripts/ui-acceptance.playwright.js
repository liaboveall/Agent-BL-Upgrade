// Run with playwright-cli from the repository root against an isolated offline Demo server.
// This is a function expression for `run-code --filename`, not a Node test entry point.
async page => {
  const report = { checked_at: new Date().toISOString(), browser: page.context().browser().version(), mode: 'demo',
    checks: [], measurements: [], screenshots: [], page_errors: [], unexpected_http_errors: [], payment_challenges: 0, passed: false };
  const check = (name, condition, detail = null) => {
    report.checks.push({ name, passed: !!condition, ...(detail === null ? {} : { detail }) });
    if (!condition) throw new Error(name + (detail === null ? '' : ': ' + JSON.stringify(detail)));
  };
  const active = () => page.evaluate(() => ({ id: globalThis.document.activeElement.id,
    key: globalThis.document.activeElement.getAttribute('data-focus-key'), tag: globalThis.document.activeElement.tagName }));
  const save = async (name) => {
    await page.waitForFunction(() => !globalThis.document.getElementById('toast')?.classList.contains('show'), null, { timeout: 6000 });
    const path = `docs/evidence/agent-phase4-${name}.png`;
    await page.screenshot({ path, fullPage: false }); report.screenshots.push(path);
  };
  const jsonPost = async (path, data) => {
    const response = await page.request.post(new URL(path, page.url()).href, { data });
    check(`Demo setup ${path}`, response.ok()); return response.json();
  };
  page.on('pageerror', (error) => report.page_errors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(page.url()).origin && response.status() >= 400) {
      if (response.status() === 402 && url.pathname.startsWith('/api/x402/')) report.payment_challenges += 1;
      else report.unexpected_http_errors.push({ path: url.pathname, status: response.status() });
    }
  });
  async function measure(name, selector, locale, width) {
    const result = await page.evaluate(({ name, selector, locale, width }) => {
      const doc = globalThis.document, scope = doc.querySelector(selector), cache = new Map();
      const visible = (element) => {
        if (!element || element === doc.body) return true;
        if (cache.has(element)) return cache.get(element);
        const style = globalThis.getComputedStyle(element);
        const value = !!element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none'
          && Number(style.opacity) !== 0 && visible(element.parentElement);
        cache.set(element, value); return value;
      };
      const label = (element) => element.getAttribute('aria-label') || (element.getAttribute('aria-labelledby') || '')
        .split(' ').map((id) => doc.getElementById(id)?.textContent || '').join('').trim()
        || [...(element.labels || [])].map((item) => item.textContent).join('').trim() || element.getAttribute('title')
        || (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) ? '' : element.textContent.trim());
      const elements = [scope, ...scope.querySelectorAll('*')].filter((element) => visible(element) && !element.closest('.ambient-glow, [aria-hidden="true"]'));
      const describe = (element) => ({ tag: element.tagName, id: element.id, class: String(element.className), text: element.textContent.slice(0, 90) });
      return { name, locale, viewport: width, document_width: doc.documentElement.scrollWidth, scope_width: scope.clientWidth,
        overflow: elements.filter((element) => { const rect = element.getBoundingClientRect(); return rect.right > width + 1 || rect.left < -1; }).map(describe),
        unnamed_controls: elements.filter((element) => element.matches('button, input, select, textarea, [role="button"]') && !label(element)).map(describe),
        nested_controls: elements.filter((element) => element.matches('button button, button a, button input')).map(describe),
        untranslated_keys: elements.filter((element) => !element.childElementCount && /^(?:ac|cp|ebld|a11y)_[a-zA-Z0-9_]+$/u.test(element.textContent.trim())).map(describe),
        english_mixed_copy: locale === 'en' ? elements.filter((element) => !element.childElementCount
          && !element.closest('#lang-btn, .cp-user, pre, code, textarea, .ebl-fields dd')
          && /[\u3400-\u9fff]/u.test(element.textContent)).map(describe) : [] };
    }, { name, selector, locale, width });
    report.measurements.push(result);
    await page.evaluate((report) => { globalThis.__agentPhase4Report = report; }, report);
    check(`${width}/${locale}/${name}: content fits viewport`, result.document_width <= width && result.overflow.length === 0, result.overflow);
    check(`${width}/${locale}/${name}: controls are named and separate`, !result.unnamed_controls.length && !result.nested_controls.length,
      [...result.unnamed_controls, ...result.nested_controls]);
    check(`${width}/${locale}/${name}: localized UI copy`, !result.untranslated_keys.length && !result.english_mixed_copy.length,
      [...result.untranslated_keys, ...result.english_mixed_copy]);
  }
  async function modalKeyboard(selector) {
    const first = page.locator(`${selector} button`).first();
    await first.focus(); await page.keyboard.press('Shift+Tab');
    check(`${selector}: reverse Tab stays in modal`, await page.evaluate((selector) => globalThis.document.activeElement.closest(selector) !== null, selector));
    await page.keyboard.press('Escape');
    check(`${selector}: Escape closes`, !await page.locator(selector).evaluate((element) => element.open));
  }
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:3000');
    await page.locator('.market-card').first().waitFor();
    const status = await (await page.request.get('http://127.0.0.1:3000/api/agent/status')).json();
    check('Isolated Demo runtime has no configured signer', status.mode === 'demo' && Object.values(status.signers).every((signer) => !signer.configured));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const locale of ['zh', 'en']) {
        if (await page.locator('html').getAttribute('lang') !== (locale === 'zh' ? 'zh-CN' : 'en')) await page.locator('#lang-btn').click();
        await page.locator('#demo-reset-btn').click();
        await page.waitForFunction(() => !globalThis.document.querySelector('.page').classList.contains('busy'));
        await page.locator('#tab-market').click();
        await page.locator('#case-dropdown').selectOption('CASE-EBL-2026-CU-SG-SHA');
        await page.waitForFunction(() => !globalThis.document.querySelector('.page').classList.contains('busy'));
        await page.locator('#wallet-btn').click();
        await page.keyboard.press('ArrowDown');
        check(`${width}/${locale}: wallet menu arrows move focus`, await page.evaluate(() => globalThis.document.activeElement.dataset.wallet === 'keplr'));
        await page.keyboard.press('Escape');
        check(`${width}/${locale}: wallet menu returns focus`, (await active()).id === 'wallet-btn');
        await page.locator('#market-subscription').fill('10000');
        await page.locator('#market-subscribe-btn').click();
        await page.locator('#portfolio-list .cp-card').first().waitFor();
        await measure('market-and-portfolio', 'body', locale, width);
        if (width === 1440 && locale === 'en') await save('desktop-en');
        await page.locator('#tab-market').focus(); await page.keyboard.press('ArrowRight');
        check(`${width}/${locale}: tab arrows activate mint`, await page.locator('#tab-mint').getAttribute('aria-selected') === 'true');
        const selectedSpeed = page.locator('#speed-select [aria-checked="true"]');
        const oldSpeed = await selectedSpeed.getAttribute('data-speed'); await selectedSpeed.focus(); await page.keyboard.press('ArrowRight');
        check(`${width}/${locale}: payout radios follow arrow keys`, await page.locator('#speed-select [aria-checked="true"]').getAttribute('data-speed') !== oldSpeed);
        // CLI modal handling yields as soon as a file chooser opens. Supply actual fixture files
        // directly here; separately verify the visible browse button with the CLI upload command.
        await page.locator('#ebl-file-input').setInputFiles(['data/uploads/copper-sg-shanghai/bill-of-lading.md', 'data/uploads/copper-sg-shanghai/commercial-invoice.md', 'data/uploads/copper-sg-shanghai/insurance-policy.md']);
        await page.waitForFunction(() => globalThis.document.querySelectorAll('#ebl-upload-status .ebl-fields').length >= 3, { timeout: 15000 });
        await page.locator('#ebl-upload-status details').first().evaluate((element) => { element.open = true; });
        await measure('mint-and-document-extraction', 'body', locale, width);
        if (width === 390 && locale === 'en') { await page.locator('#ebl-upload-status').scrollIntoViewIfNeeded(); await save('mobile-documents-en'); }
        await page.locator('#tab-agent').click(); await page.locator('#ac-autonomy').waitFor();
        await measure('agent-console', 'body', locale, width);
        const oldDecisions = await page.locator('.ac-row-open').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-focus-key')));
        const button = page.locator('[data-focus-key="inject:typhoon"]'); await button.click();
        await page.waitForFunction((old) => [...globalThis.document.querySelectorAll('.ac-row-open')].some((node) => !old.includes(node.getAttribute('data-focus-key'))), oldDecisions);
        check(`${width}/${locale}: SSE update keeps control focus`, (await active()).key === 'inject:typhoon');
        const announcement = await page.locator('#ac-announcement').textContent();
        const oldControl = await page.locator('#ac-autonomy').elementHandle();
        await page.locator('#ac-autonomy').focus(); await jsonPost('/api/agent/control', { action: 'tick' });
        await page.waitForFunction((element) => !element.isConnected, oldControl);
        check(`${width}/${locale}: refreshed select retains focus`, (await active()).id === 'ac-autonomy');
        check(`${width}/${locale}: announcement is polite`, await page.locator('#ac-announcement').getAttribute('aria-live') === 'polite');
        check(`${width}/${locale}: unchanged history is silent`, await page.locator('#ac-announcement').textContent() === announcement);
        const opener = page.locator('.ac-row-open').first(); await opener.click();
        await page.locator('#ac-drawer .ac-section').first().waitFor();
        await measure('decision-drawer', '#ac-drawer', locale, width);
        if (width === 390 && locale === 'zh') await save('mobile-decision-zh');
        const copy = page.locator('#ac-drawer .ac-copy').first(); await copy.focus(); const copyKey = (await active()).key;
        const drawerControl = await page.locator('#ac-autonomy').elementHandle();
        await jsonPost('/api/agent/control', { action: 'tick' });
        await page.waitForFunction((element) => !element.isConnected, drawerControl);
        check(`${width}/${locale}: drawer refresh does not steal focus`, (await active()).key === copyKey);
        await modalKeyboard('#ac-drawer');
        check(`${width}/${locale}: decision focus returns to opener`, (await active()).key?.startsWith('decision:'));
        await page.locator('#tab-agent').focus(); await page.keyboard.press('Home');
        check(`${width}/${locale}: Home activates market`, await page.locator('#tab-market').getAttribute('aria-selected') === 'true');
        await page.locator('#agent-activity-console summary').focus(); await page.keyboard.press('Enter');
        check(`${width}/${locale}: activity disclosure works with Enter`, await page.locator('#agent-activity-console').getAttribute('open') !== null);
        check(`${width}/${locale}: activity terminal stays in page flow`, await page.locator('#agent-activity-console').evaluate((element) => globalThis.getComputedStyle(element).position === 'static'));
        await page.keyboard.press('Enter');
        await page.locator('.market-card [data-focus-key]').first().click();
        await page.locator('#deal-detail-modal[open]').waitFor();
        await page.locator('#ship').focus();
        await measure('voyage-and-x402-reports', '#deal-detail-modal', locale, width);
        if (width === 390 && locale === 'en') await save('mobile-voyage-en');
        await modalKeyboard('#deal-detail-modal');
        check(`${width}/${locale}: voyage focus returns to project`, (await active()).key?.startsWith('market-track:'));
        await page.locator('#mystery-preview-btn').click(); await page.locator('#mystery-modal[open]').waitFor();
        await measure('mystery-commit', '#mystery-modal', locale, width);
        await page.locator('#mystery-open-btn').click();
        await page.locator('#mystery-subscribe-btn:not([disabled])').waitFor({ timeout: 20000 });
        await measure('mystery-reveal-and-proof', '#mystery-modal', locale, width);
        if (width === 390 && locale === 'zh') { await page.locator('#mystery-risk-passport').scrollIntoViewIfNeeded(); await save('mobile-mystery-zh'); }
        const originalProof = await page.locator('#mystery-proof-json').inputValue();
        await page.locator('#mystery-proof-json').fill('{}');
        await page.locator('#mystery-subscribe-btn[disabled]').waitFor();
        check(`${width}/${locale}: edited invalid proof disables subscription`, await page.locator('#mystery-subscribe-btn').isDisabled());
        await page.locator('#mystery-proof-reset').click(); await page.locator('#mystery-subscribe-btn:not([disabled])').waitFor();
        check(`${width}/${locale}: original proof restores`, await page.locator('#mystery-proof-json').inputValue() === originalProof);
        await page.locator('#mystery-subscribe-btn').click(); await page.locator('#mystery-subscribe-modal[open]').waitFor();
        await measure('independent-subscription-confirmation', '#mystery-subscribe-modal', locale, width);
        check(`${width}/${locale}: separate acknowledgement is required`, await page.locator('#mystery-confirm-subscribe').isDisabled());
        await modalKeyboard('#mystery-subscribe-modal');
        await page.locator('#mystery-claim-discovery-btn').click();
        await modalKeyboard('#mystery-modal');
        await page.locator('.passport-card button').first().waitFor(); await page.locator('.passport-card button').first().click();
        await page.locator('#passport-share-modal[open]').waitFor();
        await measure('passport-share', '#passport-share-modal', locale, width);
        if (width === 390 && locale === 'en') await save('mobile-passport-en');
        await modalKeyboard('#passport-share-modal');
        await page.locator('.cp-launcher').click();
        await page.locator('#copilot-dialog input').fill(locale === 'zh' ? '预算10000美元' : 'budget USD 10000');
        await page.locator('#copilot-dialog input').press('Enter');
        await page.locator('#copilot-dialog .cp-card').first().waitFor();
        await page.locator('#copilot-dialog button[type="submit"]:not([disabled])').waitFor();
        await measure('copilot-recommendations', '#copilot-dialog', locale, width);
        if (width === 390 && locale === 'en') await save('mobile-copilot-en');
        await modalKeyboard('#copilot-dialog');
        check(`${width}/${locale}: Copilot focus returns to launcher`, await page.locator('.cp-launcher').evaluate((element) => element === globalThis.document.activeElement));
        check(`${width}/${locale}: reduced motion disables decorative animation`, await page.locator('.ambient-glow').first().evaluate((element) => globalThis.getComputedStyle(element).animationName === 'none'));
      }
    }
    check('No page script errors', report.page_errors.length === 0, report.page_errors);
    check('No unexpected local HTTP errors (402 is the paid-report challenge)', report.unexpected_http_errors.length === 0, report.unexpected_http_errors);
    report.passed = true;
  } catch (error) { report.error = error.message; }
  await page.evaluate((report) => { globalThis.__agentPhase4Report = report; }, report);
  return report;
}
