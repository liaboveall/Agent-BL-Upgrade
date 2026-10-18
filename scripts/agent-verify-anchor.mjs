import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runtimePath } from '../src/runtimePaths.js';
import { decisionAnchorFromState, readAnchorState } from '../src/agent/runtime/anchoring.js';
import { createReadOnlyAnchorAdapter } from '../src/agent/runtime/anchorChain.js';
import {resolveApplicationConfig} from '../src/chain/applicationConfig.js';

export async function verifyDecisionAnchor({ decisionId, file = runtimePath('research-agent/agent-anchors.json'), decisionFile = runtimePath('research-agent/agent-decisions.json'), configPath, adapter } = {}) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(decisionId ?? '')) throw new Error('--decision requires a valid decision id');
  const state = await readAnchorState(file);
  let decision = null;
  try { decision = JSON.parse(await fs.readFile(decisionFile, 'utf8')).find((record) => record.decision_id === decisionId) ?? null; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = decisionAnchorFromState(state, decisionId, decision);
  if (result.state === 'ANCHORED' && result.verification.passed) {
    let close;
    try {
      if (!adapter) {
        const raw = JSON.parse(await fs.readFile(configPath ?? new URL('../public/application-config.json', import.meta.url), 'utf8'));
        const reader = createReadOnlyAnchorAdapter(resolveApplicationConfig(raw, 'injective-testnet'));
        adapter = reader.adapter; close = reader.close;
      }
      const passed = await adapter.verify(result);
      result.verification.checks.push({ name: 'confirmed_chain_batch', passed: passed === true });
      result.verification.passed = passed === true;
      result.verification.status = passed === true ? 'PASS_CHAIN' : 'FAIL';
    } catch { result.verification = { ...result.verification, passed: false, status: 'CHAIN_UNAVAILABLE' }; }
    finally { close?.(); }
  }
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { decision: { type: 'string' }, file: { type: 'string' }, 'decision-file': { type: 'string' },
    'application-config': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('Usage: npm run agent:verify-anchor -- --decision <id> [--file <anchor-journal>] [--decision-file <audit-journal>]'); return; }
  const result = await verifyDecisionAnchor({ decisionId: values.decision, file: values.file,
    decisionFile: values['decision-file'] ?? (values.file ? path.join(path.dirname(values.file), 'agent-decisions.json') : undefined), configPath: values['application-config'] });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.verification.passed ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('FAIL: anchor journal or decision could not be verified'); process.exitCode = 1;
});
