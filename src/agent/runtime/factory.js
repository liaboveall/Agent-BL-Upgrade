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
import { IngestService } from '../ingest/ingestService.js';
import { createDocumentModel } from '../ingest/modelExtraction.js';
import { ActivityLog } from './activityLog.js';
import { AgentService } from './agentService.js';
import { ApprovalQueue } from './approvals.js';
import { loadAgentConfig } from './config.js';
import { EventBus } from './eventBus.js';
import { ChainExecutor, createChainContext } from './executors/chainExecutor.js';
import { SimExecutor } from './executors/simExecutor.js';
import { PoolRegistry } from './poolRegistry.js';
import { PreferenceStore } from './preferences.js';
import { SettlementEvidenceStore } from './settlementEvidence.js';
import { RiskTracker } from './sources/riskTracker.js';
import { ScenarioPlayer } from './sources/scenarioPlayer.js';
import { createVoyageMonitor } from './sources/voyageMonitor.js';
import { createWorldRiskMonitor } from './sources/worldRiskMonitor.js';
import { ChainWatcher } from './sources/chainWatcher.js';
import { Tracer } from './trace.js';
import { DecisionAnchoring } from './anchoring.js';
import { createAgentVersion } from './agentVersion.js';
import { createAnchorChainAdapter } from './anchorChain.js';

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
 * @param {boolean} [options.monitors]         run the world-risk and insurance monitors on every tick (default: when persisting)
 * @param {object} [options.chainConfig]
 * @param {Function} [options.getChainContext] override how the Live chain context is built (tests)
 */
export function createAgentService(options = {}) {
  const env = options.env ?? process.env;
  let config = options.config ?? loadAgentConfig(env);
  const store = options.store ?? storeState;
  const chainConfig = options.chainConfig === undefined ? loadChainConfig() : options.chainConfig;
  const v3 = Number(chainConfig?.protocolVersion) >= 3;
  if (v3 && !options.config && env.AGENT_PROTECTED_CHAIN_POOLS === undefined) config = { ...config, protectedChainPools: [] };
  const baseDir = options.persist || options.dir ? (options.dir ?? runtimeDir(env)) : null;
  // Never replay a legacy approval, watcher cursor or numbered pool against a replacement contract.
  const dir = baseDir && v3 ? path.join(baseDir, `protocol-v3-${chainConfig.contracts.RWAOfferingPool.toLowerCase()}`) : baseDir;
  const file = (name) => (dir ? path.join(dir, name) : null);
  const modeController = options.demoModeController;
  const getMode = options.getMode ?? (() => modeController?.snapshot().mode ?? 'demo');
  const getGeneration = options.getGeneration ?? (() => modeController?.snapshot().generation ?? 1);

  const activity = options.activity ?? new ActivityLog({ store, mode: getMode, now: options.now });
  const logger = options.logger ?? new DecisionLogger({ filePath: file('agent-decisions.json'), clock: options.now });
  const approvals = options.approvals ?? new ApprovalQueue({ file: file('agent-approvals.json'), ttlSec: config.approvalTtlSec, maxRecords: config.maxDecisions, now: options.now });
  const registry = options.registry ?? new PoolRegistry({ file: file('agent-pools.json'),
    protectedChainPools: config.protectedChainPools,
    ...(v3 ? { historyChainPools: [] } : {}), now: options.now });
  const tracer = options.tracer ?? new Tracer({ file: file('agent-traces.jsonl'), wall: options.now ? () => options.now().getTime() : undefined });
  const bus = options.bus ?? new EventBus({
    handler: async () => {}, // replaced by the service
    eventsFile: file('agent-events.jsonl'),
    indexFile: file('agent-event-index.json'),
    now: options.now,
    maxIndexEntries: config.maxDecisions,
    sleep: options.sleep
  });
  const sim = options.sim ?? new SimExecutor({ store, now: options.now });
  const ingest = options.ingest ?? new IngestService({ dir, maxBytes: config.uploadMaxBytes, now: options.now, getMode });
  const documentModel = createDocumentModel({ env, completion: options.documentCompletion });
  const documentParser = {
    visionEnabled: config.visionEnabled,
    ...(config.visionEnabled && documentModel.configured ? { visionExtractor: documentModel.vision } : {}),
    ...(config.documentLlm && documentModel.configured ? { aiExtractor: documentModel.complete } : {})
  };
  const preferences = options.preferences ?? new PreferenceStore({ file: file('agent-preferences.json'), now: options.now });
  const settlementEvidence = options.settlementEvidence ?? new SettlementEvidenceStore({ file: file('agent-settlement-evidence.json') });
  const riskTracker = options.riskTracker ?? new RiskTracker({ clearTicks: config.riskClearTicks, file: file('agent-risk-snapshots.json') });
  let service = null;
  const scenarios = options.scenarios ?? new ScenarioPlayer({ getService: () => service, clearTicks: config.riskClearTicks, speed: config.scenarioSpeed });
  // The monitors poll on every tick, so they run in the real server; a plain createServer() / test
  // runtime stays quiet unless asked.
  const monitorsOn = options.monitors ?? Boolean(options.persist);
  const sources = options.sources ?? (monitorsOn
    ? [createWorldRiskMonitor({ tracker: riskTracker, env: () => env }), createVoyageMonitor({ getClock: () => scenarios.clockMs })]
    : []);

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

  // Isolated read-only provider: this path never builds wallets or resolves signer keys.
  let watcherContext = null;
  const watcher = options.chainWatcher === false || !config.chainWatcherEnabled || !monitorsOn && !options.chainWatcher ? null
    : options.chainWatcher ?? new ChainWatcher({ file: file('agent-chain-cursor.json'), chainConfig,
      confirmations: config.chainConfirmations, pollSec: config.chainPollSec, startBlock: config.chainStartBlock ?? chainConfig?.watcherStartBlock ?? null,
      now: options.now, getContext: options.getWatcherContext ?? options.getChainContext ?? (async () => {
        if (!chainConfig) return null;
        watcherContext ??= await createChainContext({ chainConfig, env, readOnly: true });
        return watcherContext;
      }) });

  const signerRoles = () => ({
    PRICING_UPDATER: Boolean(resolveSignerKey('PRICING_UPDATER', env, { warn: () => {} })?.dedicated),
    AGENT_EXECUTOR: Boolean(resolveSignerKey('AGENT_EXECUTOR', env, { warn: () => {} }))
  });

  const version = options.agentVersion ?? createAgentVersion(config, env);
  const anchoring = options.anchoring ?? new DecisionAnchoring({ file: file('agent-anchors.json'), version, config, logger,
    getMode, getGeneration, now: options.now,
    adapter: options.anchorAdapter ?? (chainConfig?.contracts?.AgentDecisionLog ? createAnchorChainAdapter({ chainConfig, getContext: getChainContext,
      confirmations: config.chainConfirmations, runExclusive: async (task) => {
        const chain = await getChain(), context = await getChainContext();
        if (!chain || !context?.signers?.PRICING_UPDATER) throw new Error('Dedicated pricing signer is unavailable');
        return chain.withSigner(context.signers.PRICING_UPDATER, task);
      } }) : null) });
  logger.agentVersion = version;
  logger.onRecord = (decision) => anchoring.captureSafe(decision);

  service = new AgentService({
    config, env, store, getMode, getGeneration, activity, logger, approvals, registry, bus, tracer, sim,
    ingest, scenarios, riskTracker, documentParser, settlementEvidence, chainWatcher: watcher, anchoring,
    getChain, getChainContext, chainConfig, signerRoles,
    ensurePools: options.ensurePools,
    now: options.now,
    sleep: options.sleep,
    sources,
    preferences,
    orchestrator: options.orchestrator
  });
  return service;
}

/** Turn on persistence for the shared activity feed (the server entry point calls this once). */
export async function attachActivityPersistence(activity, env = process.env) {
  await activity.attachFile(path.join(runtimeDir(env), 'agent-activity.jsonl'));
}
