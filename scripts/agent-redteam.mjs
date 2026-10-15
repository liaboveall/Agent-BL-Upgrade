import fs from 'node:fs/promises';
import { runRedteam } from '../src/agent/redteam/runner.js';

const caseData = JSON.parse(await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8'));
const documents = await Promise.all(['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'].map(async (name) => ({
  name, kind: 'text', mime_type: 'text/markdown', text: await fs.readFile(new URL(`../data/uploads/copper-sg-shanghai/${name}`, import.meta.url), 'utf8')
})));
const report = await runRedteam({ caseData, documents });
console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1;
