// Native Playwright runner for CLI versions whose run-code VM does not support dynamic imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, 'playwright-module': { type: 'string' }, 'browser-executable': { type: 'string' } } });
if (!values.url) throw new Error('Usage: node scripts/settlement-acceptance-runner.mjs --url <isolated URL> [--playwright-module <index.mjs>] [--browser-executable <browser>]');
const endpoint = new URL(values.url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('Acceptance runs only against the local isolated harness');
const module = values['playwright-module'] ? pathToFileURL(path.resolve(values['playwright-module'])).href : 'playwright';
const { chromium } = await import(module);
const browser = await chromium.launch({ headless: true,
  ...(values['browser-executable'] ? { executablePath: values['browser-executable'] } : process.platform === 'win32' ? { channel: 'msedge' } : {}),
  ...(process.platform === 'linux' ? { args: ['--no-sandbox'] } : {}) });
try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(root);
  const page = await browser.newPage(); await page.goto(endpoint.href);
  // This is the repository-owned scenario, never code obtained from a page or remote response.
  const scenario = eval(await fs.readFile(path.join(root, 'scripts/settlement-acceptance.playwright.js'), 'utf8'));
  console.log(JSON.stringify(await scenario(page)));
} finally { await browser.close(); }
