import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, 'playwright-module': { type: 'string' }, 'browser-executable': { type: 'string' } } });
if (!values.url) throw new Error('A local isolated harness URL is required');
const url = new URL(values.url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Acceptance only runs against a local isolated harness');
const { chromium } = await import(values['playwright-module'] ? pathToFileURL(path.resolve(values['playwright-module'])).href : 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(values['browser-executable'] ? { executablePath: values['browser-executable'] } : process.platform === 'win32' ? { channel: 'msedge' } : {}),
  ...(process.platform === 'linux' ? { args: ['--no-sandbox'] } : {}) });
try {
  process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const page = await browser.newPage(); await page.goto(url.href);
  const scenario = eval(await fs.readFile('scripts/chain-watcher-acceptance.playwright.js', 'utf8'));
  const result = await scenario(page); console.log(JSON.stringify({ passed: result.passed, summary: result.summary, browser: result.browser, real_transactions: result.real_transactions }));
} finally { await browser.close(); }
