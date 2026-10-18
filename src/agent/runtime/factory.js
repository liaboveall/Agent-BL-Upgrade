// Builds an AgentService with its real dependencies. Persistence is opt-in: the server entry point
// passes `persist: true`; `createServer()` and the tests get a memory-only service, so nothing
// writes into data/runtime and tests stay deterministic.

import path from 'node:path';
import { loadApplicationConfig } from '../../chain/loadApplicationConfig.js';
import { JsonRpcProvider, Wallet } from 'ethers';
import { runtimeDir } from '../../runtimePaths.js';
import { storeState, ledger } from '../../app/store.js';
import { CapitalLedgerService } from '../../ledger/service.js';
import { DecisionLogger } from '../decisionLogger.js';
import { IngestService } from '../ingest/ingestService.js';
import { createDocumentModel } from '../ingest/modelExtraction.js';
import { ActivityLog } from './activityLog.js';
import { AgentService } from './agentService.js';
import { ApprovalQueue } from './approvals.js';
import { loadAgentConfig } from './config.js';
import { EventBus } from './eventBus.js';
import { SimExecutor } from './executors/simExecutor.js';
import { PoolRegistry } from './poolRegistry.js';
import { PreferenceStore } from './preferences.js';
import { RiskTracker } from './sources/riskTracker.js';
import { ScenarioPlayer } from './sources/scenarioPlayer.js';
import { createVoyageMonitor } from './sources/voyageMonitor.js';
import { createWorldRiskMonitor } from './sources/worldRiskMonitor.js';
import { Tracer } from './trace.js';
import { DecisionAnchoring } from './anchoring.js';
import { createAgentVersion } from './agentVersion.js';
import { createAnchorChainAdapter } from './anchorChain.js';
import { DecisionEvidenceArchive } from '../../evidence/archive.js';

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
 */
export function createAgentService(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? loadAgentConfig(env);
  const store = options.store ?? storeState;
  const chainConfig = loadApplicationConfig();
  const baseDir = options.persist || options.dir ? options.dir ?? runtimeDir(env) : null;
  // Dedicated analysis namespace; existing deployment histories remain outside this runtime.
  const dir = baseDir ? path.join(baseDir, 'research-agent') : null;
  const file = name => dir ? path.join(dir, name) : null;
  const modeController = options.demoModeController;
  const getMode = options.getMode ?? (() => modeController?.snapshot().mode ?? 'demo');
  const getGeneration = options.getGeneration ?? (() => modeController?.snapshot().generation ?? 1);
  const activity = options.activity ?? new ActivityLog({
    store,
    mode: getMode,
    now: options.now
  });
  const logger = options.logger ?? new DecisionLogger({
    filePath: file('agent-decisions.json'),
    clock: options.now
  });
  const approvals = options.approvals ?? new ApprovalQueue({
    file: file('agent-approvals.json'),
    ttlSec: config.approvalTtlSec,
    maxRecords: config.maxDecisions,
    now: options.now
  });
  const registry = options.registry ?? new PoolRegistry({
    file: file('agent-pools.json'),
    protectedChainPools: config.protectedChainPools,
    historyChainPools: [],
    now: options.now
  });
  const tracer = options.tracer ?? new Tracer({
    file: file('agent-traces.jsonl'),
    wall: options.now ? () => options.now().getTime() : undefined
  });
  const bus = options.bus ?? new EventBus({
    handler: async () => {},
    // replaced by the service
    eventsFile: file('agent-events.jsonl'),
    indexFile: file('agent-event-index.json'),
    now: options.now,
    maxIndexEntries: config.maxDecisions,
    sleep: options.sleep
  });
  const sim = options.sim ?? new SimExecutor({
    store,
    now: options.now
  });
  const ingest = options.ingest ?? new IngestService({
    dir,
    maxBytes: config.uploadMaxBytes,
    now: options.now,
    getMode
  });
  const documentModel = createDocumentModel({
    env,
    completion: options.documentCompletion
  });
  const documentParser = {
    visionEnabled: config.visionEnabled,
    ...(config.visionEnabled && documentModel.configured ? {
      visionExtractor: documentModel.vision
    } : {}),
    ...(config.documentLlm && documentModel.configured ? {
      aiExtractor: documentModel.complete
    } : {})
  };
  const preferences = options.preferences ?? new PreferenceStore({
    file: file('agent-preferences.json'),
    now: options.now
  });
  const riskTracker = options.riskTracker ?? new RiskTracker({
    clearTicks: config.riskClearTicks,
    file: file('agent-risk-snapshots.json')
  });
  let service = null;
  const scenarios = options.scenarios ?? new ScenarioPlayer({
    getService: () => service,
    clearTicks: config.riskClearTicks,
    speed: config.scenarioSpeed
  });
  // The monitors poll on every tick, so they run in the real server; a plain createServer() / test
  // runtime stays quiet unless asked.
  const monitorsOn = options.monitors ?? Boolean(options.persist);
  const sources = options.sources ?? (monitorsOn ? [createWorldRiskMonitor({
    tracker: riskTracker,
    env: () => env
  }), createVoyageMonitor({
    getClock: () => scenarios.clockMs
  })] : []);

  // Financing is signed by participants through the controlled workflow. Agent analysis has no financing signer.
  const signerRoles = () => ({});
  const capital = new CapitalLedgerService({
    ledger: options.ledger ?? ledger,
    chainConfig: null,
    getMode
  });
  let anchorContext = null,
    anchorTail = Promise.resolve();
  const getAnchorContext = async () => {
    if (anchorContext) return anchorContext;
    const key = env.AGENT_ANCHOR_PRIVATE_KEY;
    if (!config.anchorEnabled || !/^0x[a-f0-9]{64}$/iu.test(key ?? '')) throw new Error('A dedicated AGENT_ANCHOR_PRIVATE_KEY is required');
    const provider = new JsonRpcProvider(chainConfig.rpcUrls[0]);
    anchorContext = {
      provider,
      signers: {
        ANCHORER: new Wallet(key, provider)
      }
    };
    return anchorContext;
  };
  const exclusiveAnchor = task => {
    const result = anchorTail.then(task, task);
    anchorTail = result.catch(() => {});
    return result;
  };
  const version = options.agentVersion ?? createAgentVersion(config, env);
  const evidenceArchive = options.evidenceArchive ?? new DecisionEvidenceArchive({
    directory: dir ? path.join(dir, 'evidence-archive') : null,
    env,
    ownerFor: caseId => ingest.caseOwner(caseId),
    now: () => (options.now?.() ?? new Date()).getTime()
  });
  const anchoring = options.anchoring ?? new DecisionAnchoring({
    file: file('agent-anchors.json'),
    version,
    config,
    logger,
    schema: 'agentbl-decision-anchor-v2',
    archive: evidenceArchive,
    getMode,
    getGeneration,
    now: options.now,
    adapter: options.anchorAdapter ?? (chainConfig?.contracts?.AgentDecisionLog ? createAnchorChainAdapter({
      chainConfig,
      getContext: getAnchorContext,
      confirmations: config.chainConfirmations,
      runExclusive: exclusiveAnchor
    }) : null)
  });
  logger.agentVersion = version;
  logger.onRecord = decision => anchoring.captureSafe(decision);
  service = new AgentService({
    config,
    env,
    store,
    getMode,
    getGeneration,
    activity,
    logger,
    approvals,
    registry,
    bus,
    tracer,
    sim,
    ingest,
    scenarios,
    riskTracker,
    documentParser,
    chainWatcher: null,
    anchoring,
    signerRoles,
    ensurePools: options.ensurePools,
    now: options.now,
    sleep: options.sleep,
    sources,
    preferences,
    orchestrator: options.orchestrator
  });
  service.capital = capital;
  service.evidenceArchive = evidenceArchive;
  return service;
}

/** Turn on persistence for the shared activity feed (the server entry point calls this once). */
export async function attachActivityPersistence(activity, env = process.env) {
  await activity.attachFile(path.join(runtimeDir(env), 'research-agent', 'agent-activity.jsonl'));
}
export { loadApplicationConfig };
