import { parseArgs } from 'node:util';
import { DecisionLogger } from '../src/agent/decisionLogger.js';
import { replayDecision } from '../src/agent/runtime/replay.js';
import { runtimePath } from '../src/runtimePaths.js';

const { values } = parseArgs({ options: { decision: { type: 'string' }, file: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) console.log('Usage: npm run agent:replay -- --decision <id> [--file <decision-journal>]');
else {
  try {
    if (!values.decision) throw new Error('--decision is required');
    const logger = new DecisionLogger({ filePath: values.file ?? runtimePath('agent-decisions.json') });
    const decision = await logger.get(values.decision);
    if (!decision) throw new Error('Unknown decision');
    const result = replayDecision(decision);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1;
  } catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}
