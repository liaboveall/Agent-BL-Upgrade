// Builds an AgentService with its real dependencies. Persistence is opt-in: the server entry point
// passes `persist: true`; `createServer()` and the tests get a memory-only service, so nothing
// writes into data/runtime and tests stay deterministic (docs/agent-implementation-plan.md D9).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chainConfigLib from '../../../scripts/lib/chain-config.cjs';
import { resolveSignerKey } from '../../chain/signerKeys.js';
import { runtimeDir } from '../../runtimePaths.js';
import { storeState } from '../../app/store.js';
import { DecisionLogger } from '../decisionLogger.js';
import { ActivityLog } from './activityLog.js';
import { AgentService } from './agentService.js';
import { ApprovalQueue } from './approvals.js';
import { loadAgentConfig } from './config.js';
import { EventBus } from './eventBus.js';
import { ChainExecutor, createChainContext } from './executors/chainExecutor.js';
import { SimExecutor } from './executors/simExecutor.js';
import { PoolRegistry } from './poolRegistry.js';
import { Tracer } from './trace.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHAIN_NETWORK = 'injective-testnet';
const CONTEXT_FAILURE_BACKOFF_MS = 10_000;

/** The deployed contract registry (addresses + ABIs), or null if it is not shipped. */
export function loadChainConfig(network = CHAIN_NETWORK) {
  try {
    const raw = JSON.parse(readFileSync(path.join(projectRoot, 'public', 'chain-config.json'), 'utf8'));
    return chainConfigLib.resolveNetworkConfig(raw, network);
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.persist]          write state under the runtime dir (the server entry point)
 * @param {string}  [options.dir]              override the runtime dir (tests)
 * @param {object}  [options.store]            pool store (defaults to the server's storeState)
 * @param {{snapshot:()=>{mode:string, generation:number}}} [options.demoModeController]
 * @param {() => Promise<void>} [options.ensurePools]
 * @param {ActivityLog} [options.activity]     share the server's feed so REST/SSE and the agent show one history
 * @param {object} [options.chainConfig]
 * @param {Function} [options.getChainContext] override how the Live chain context is built (tests)
 */
export function createAgentService(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? loadAgentConfig(env);
  const store = options.store ?? storeState;
  const dir = options.persist || options.dir ? (options.dir ?? runtimeDir(env)) : null;
  const file = (name) => (dir ? path.join(dir, name) : null);
  const modeController = options.demoModeController;
  const getMode = options.getMode ?? (() => modeController?.snapshot().mode ?? 'demo');
  const getGeneration = options.getGeneration ?? (() => modeController?.snapshot().generation ?? 1);
  const chainConfig = options.chainConfig === undefined ? loadChainConfig() : options.chainConfig;

  const activity = options.activity ?? new ActivityLog({ store, mode: getMode });
  const logger = options.logger ?? new DecisionLogger({ filePath: file('agent-decisions.json') });
  const approvals = options.approvals ?? new ApprovalQueue({ file: file('agent-approvals.json'), ttlSec: config.approvalTtlSec });
  const registry = options.registry ?? new PoolRegistry({ file: file('agent-pools.json'), protectedChainPools: config.protectedChainPools });
  const tracer = options.tracer ?? new Tracer({ file: file('agent-traces.jsonl') });
  const bus = options.bus ?? new EventBus({
    handler: async () => {}, // replaced by the service
    eventsFile: file('agent-events.jsonl'),
    indexFile: file('agent-event-index.json')
  });
  const sim = options.sim ?? new SimExecutor({ store });

  // The Live context (provider, contracts, signers) is built on first use and rebuilt when the runtime
  // mode generation changes. A failure is remembered briefly so a down RPC is not hammered.
  const live = { generation: null, context: null, executor: null, failedAt: 0 };
  const buildContext = options.getChainContext ?? (async () => {
    if (!chainConfig) return null;
    return createChainContext({ chainConfig, env });
  });
  const getChainContext = async () => {
    const generation = getGeneration();
    if (live.generation !== generation) Object.assign(live, { generation, context: null, executor: null, failedAt: 0 });
    if (live.context) return live.context;
    if (Date.now() - live.failedAt < CONTEXT_FAILURE_BACKOFF_MS) return null;
    try {
      live.context = await buildContext();
      if (!live.context) live.failedAt = Date.now();
    } catch {
      live.failedAt = Date.now();
    }
    return live.context;
  };
  const getChain = async () => {
    const context = await getChainContext();
    if (!context) return null;
    if (!live.executor) {
      live.executor = options.chainExecutor ?? new ChainExecutor({ getContext: async () => context, confirmations: config.chainConfirmations });
    }
    return live.executor;
  };

  const signerRoles = () => ({
    PRICING_UPDATER: Boolean(resolveSignerKey('PRICING_UPDATER', env, { warn: () => {} })?.dedicated),
    AGENT_EXECUTOR: Boolean(resolveSignerKey('AGENT_EXECUTOR', env, { warn: () => {} }))
  });

  return new AgentService({
    config, env, store, getMode, getGeneration, activity, logger, approvals, registry, bus, tracer, sim,
    getChain, getChainContext, chainConfig, signerRoles,
    ensurePools: options.ensurePools,
    now: options.now,
    sleep: options.sleep,
    sources: options.sources,
    preferences: options.preferences
  });
}

/** Turn on persistence for the shared activity feed (the server entry point calls this once). */
export async function attachActivityPersistence(activity, env = process.env) {
  await activity.attachFile(path.join(runtimeDir(env), 'agent-activity.jsonl'));
}
