import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateProviderCorpus } from '../src/provenance/evaluation.js';
import { createDocumentModel } from '../src/agent/ingest/modelExtraction.js';
import { resolveProvider } from '../src/agent/llm/openaiCompatClient.js';
import { createExternalComplianceChecker } from '../src/agent/compliance/external.js';
import { hashSnapshot } from '../src/agent/decisionLogger.js';
import { createAgentVersion } from '../src/agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';

const args = process.argv.slice(2);
if (args.some((arg) => !['--live'].includes(arg))) throw new Error('Usage: npm run eval:w4 -- [--live]');
if (args.includes('--live')) await import('../src/env.js');
const corpus = JSON.parse(await fs.readFile('data/evaluation/w4/corpus.json', 'utf8'));
const config = args.includes('--live') ? resolveProvider(process.env) : null;
const model = config ? createDocumentModel({ env: process.env }) : null;
const sourceVersion = createAgentVersion(loadAgentConfig(process.env), process.env);
const report = await evaluateProviderCorpus(corpus, { live: Boolean(model), model: model ? (input) => model.complete(input) : null,
  providerVersion: config ? { provider: config.provider, model: config.model } : null });
report.executed_at = new Date().toISOString();
report.source_version = sourceVersion;
report.provider_identity_verified = false;
report.live_requested = args.includes('--live');
report.compliance = { status: 'NOT_CONFIGURED', business_accepted: false };
if (args.includes('--live') && process.env.COMPLIANCE_SCREENING_URL) {
  const check = createExternalComplianceChecker({ env: process.env, fetchImpl: fetch });
  const result = await check({ bill_of_lading: { shipper: 'DCSA CTK', consignee: 'Global Retail Imports' } });
  report.compliance = { status: result.external?.status ?? 'UNAVAILABLE', list_version: result.external?.list_version ?? null, business_accepted: false };
}
const { report_hash: _previousHash, ...completeReport } = report;
report.report_hash = hashSnapshot(completeReport);
const directory = path.resolve('artifacts/evaluation/provider-runs'); await fs.mkdir(directory, { recursive: true });
const corpusFile = path.join(directory, `corpus-${corpus.corpus_hash.slice(2)}.json`);
try { await fs.writeFile(corpusFile, `${JSON.stringify(corpus, null, 2)}\n`, { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const file = path.join(directory, `${report.executed_at.replaceAll(/[:.]/gu, '-')}-${model ? 'live' : 'local'}.json`);
await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ file, scope: report.scope, metrics: report.metrics, compliance: report.compliance, business_accepted: false }, null, 2));
