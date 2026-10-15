import { parseArgs } from 'node:util';
import { loadChainConfig } from '../src/agent/runtime/factory.js';
import { createChainContext } from '../src/agent/runtime/executors/chainExecutor.js';
import { readSmokeChain } from '../src/agent/runtime/liveSmokeVerification.js';
import { runLiveSmoke } from './lib/agent-live-smoke.mjs';
import { writeJsonAtomic } from '../src/lib/jsonStore.js';

const { values } = parseArgs({ options: { server: { type: 'string' }, confirm: { type: 'boolean' }, lifecycle: { type: 'boolean' },
  'run-id': { type: 'string' }, report: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) console.log('Usage: npm run agent:smoke -- [--server http://127.0.0.1:3000] [--run-id <stable-id> --confirm] [--lifecycle] [--report <new-file>]\nDefault is read-only; no .env or private keys. Confirmation uses the server admin token from the environment.');
else {
  const target = values.report ?? `docs/evidence/agent-live-smoke-${Date.now()}.json`;
  // Do not overwrite an earlier successful or failed attempt.
  const fs = await import('node:fs/promises');
  try { await fs.access(target); throw new Error('Choose a new report path; historical smoke evidence is immutable'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let context;
  let report;
  try {
    const config = loadChainConfig();
    // Strict read-only context: never builds a signer or loads dotenv, even with --confirm.
    context = await createChainContext({ chainConfig: config, env: { INJECTIVE_RPC_URL: process.env.INJECTIVE_RPC_URL }, readOnly: true });
    const readChain = (decision, options) => readSmokeChain(context, config, decision, options);
    report = await runLiveSmoke({ base: values.server ?? process.env.AGENTBL_URL ?? 'http://127.0.0.1:3000',
      token: process.env.AGENTBL_ADMIN_TOKEN, confirm: values.confirm ?? false, lifecycle: values.lifecycle ?? false,
      runId: values['run-id'], readChain });
  } catch (error) {
    report = { ...error.report, status: 'FAIL', live_acceptance: false, error: String(error.message).slice(0, 250),
      note: 'Inspect the server decisions before retrying; a failed runner is not proof that no transaction was broadcast.' };
    process.exitCode = 1;
  } finally { context?.provider?.destroy?.(); }
  await writeJsonAtomic(target, report);
  console.log(JSON.stringify({ ...report, report: target }, null, 2));
}
