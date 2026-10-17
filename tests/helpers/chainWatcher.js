import fs from 'node:fs/promises';
import { Interface } from 'ethers';
import { cargoIdentityHash } from '../../src/chain/cargoIdentity.js';
import { loadChainConfig } from '../../src/agent/runtime/factory.js';
import { ChainWatcher } from '../../src/agent/runtime/sources/chainWatcher.js';
import { createAgentService } from '../../src/agent/runtime/factory.js';
import { createPool } from '../../src/app/store.js';
import { quoteFromCase } from '../../src/core/pricingEngine.js';
import { readJsonl } from '../../src/lib/jsonStore.js';

export const copper = JSON.parse(await fs.readFile(new URL('../../data/cases/archive/copper-sg-shanghai-2026-06.case.json', import.meta.url), 'utf8'));
export const oil = JSON.parse(await fs.readFile(new URL('../../data/cases/crude-fuj-sin.case.json', import.meta.url), 'utf8'));
export const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
export const ZERO = hash(0);

export function watcherChain({ latest = 110 } = {}) {
  const active = loadChainConfig();
  const chainConfig = structuredClone(active.legacyProtocols?.find((entry) => entry.protocolVersion === 2)?.config ?? active);
  for (const deployment of Object.values(chainConfig.deployments)) deployment.blockNumber = 100;
  const state = { latest, network: 1439, headStop: false, confirmedStop: false, failLogs: false, logs: [], calls: [], blockOverrides: new Map(), pools: new Map() };
  const block = (n) => ({ number: n, hash: state.blockOverrides.get(n) ?? hash(n), timestamp: 1791979200 + n });
  function addPool(id, caseData = oil, extra = {}) {
    const bill = caseData.bill_of_lading;
    const item = { exists: true, eblId: id === 2 ? 2n : BigInt(id + 10), tokenSupply: 1000n, issuePrice: 800000n,
      targetRedemptionValue: 1000000n, subscribed: 0n, repaymentAmount: 0n, paymentProof: ZERO, arrivalProof: ZERO, state: 2,
      cargoHash: cargoIdentityHash(caseData), metadata: { vessel: bill.vessel, voyage: '', portOfLoading: bill.port_of_loading,
        portOfDischarge: bill.port_of_discharge, cargo: bill.cargo, quantity: 1000n, quantityUnit: 'MT', hsCode: caseData.cargo.hs_code,
        declaredValueUsdE6: 1000000000n, incoterms: bill.incoterms, mletr: true, eucp: false, dcsa: true }, ...extra };
    state.pools.set(id, item); return item;
  }
  addPool(2, copper); addPool(11, oil);
  const provider = {
    async send(method) { state.calls.push({ method }); if (method !== 'eth_chainId') throw new Error('Unexpected RPC'); return `0x${state.network.toString(16)}`; },
    async getNetwork() { return { chainId: BigInt(state.network) }; },
    async getBlockNumber() { state.calls.push({ method: 'getBlockNumber' }); return state.latest; },
    async getBlock(n) { state.calls.push({ method: 'getBlock', number: Number(n) }); return block(Number(n)); },
    async getLogs(filter) {
      state.calls.push({ method: 'getLogs', filter });
      if (state.failLogs) throw new Error('secret RPC credential must not appear in status');
      return state.logs.filter((l) => l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock);
    },
    async getTransactionReceipt(tx) { return { status: 1, contractAddress: chainConfig.contracts.PaymentOracle,
      hash: tx, blockNumber: 100, blockHash: block(100).hash }; }
  };
  const pool = {
    async emergencyStopped(opts) { state.calls.push({ method: 'emergencyStopped', blockTag: opts.blockTag }); return opts.blockTag === state.latest ? state.headStop : state.confirmedStop; },
    async offerings(id, opts) { state.calls.push({ method: 'offerings', id: Number(id), blockTag: opts?.blockTag }); return state.pools.get(Number(id)) ?? { exists: false }; },
    async stateOf(id) { return state.pools.get(Number(id))?.state ?? 0; }
  };
  const registry = {
    async cargoHashOf(id) { return [...state.pools.values()].find((p) => p.eblId === BigInt(id))?.cargoHash; },
    async metadataOf(id) { return [...state.pools.values()].find((p) => p.eblId === BigInt(id))?.metadata; }
  };
  const context = { provider, pool, registry, signers: {}, chainConfig };
  const log = (name, args, { contract = 'RWAOfferingPool', height = 105, index = 0, transactionIndex = 0, ...extra } = {}) => {
    const iface = new Interface(chainConfig.abis[contract]);
    const encoded = iface.encodeEventLog(iface.getEvent(name), args);
    return { ...encoded, address: chainConfig.contracts[contract], blockNumber: height, blockHash: block(height).hash,
      transactionHash: hash(10000 + height), transactionIndex, index, removed: false, ...extra };
  };
  return { state, context, chainConfig, provider, block, log, addPool };
}

export async function watcherService({ chain = watcherChain(), dir, confirmations = 1, batchBlocks = 5000, timeoutMs, withOil = true } = {}) {
  let nowMs = Date.parse('2026-10-15T00:00:00Z');
  const runtime = { mode: 'live', generation: 1 };
  const store = { pools: new Map(), investments: [], agentActivities: [] };
  createPool(copper.case_id, structuredClone(copper), quoteFromCase(copper), { store });
  if (withOil) createPool(oil.case_id, structuredClone(oil), quoteFromCase(oil), { store });
  const watcher = new ChainWatcher({ file: dir ? `${dir}/agent-chain-cursor.json` : null,
    chainConfig: chain.chainConfig, getContext: async () => chain.context, confirmations, batchBlocks, timeoutMs,
    now: () => new Date(nowMs) });
  const service = createAgentService({ dir, store, chainConfig: chain.chainConfig,
    env: { AGENT_VALUATION_LLM: 'false', AGENT_COOLDOWN_SEC: '0', AGENT_MONITOR_INTERVAL_SEC: '3600' },
    getMode: () => runtime.mode, getGeneration: () => runtime.generation,
    monitors: false, sources: [], chainWatcher: watcher, getChainContext: async () => chain.context });
  await service.init();
  // Completed queue entries intentionally drop payloads; the immutable event journal retains them.
  service.chainTestJournal = new Map((dir ? await readJsonl(`${dir}/agent-events.jsonl`) : [])
    .map((record) => [record.event.idempotency_key, record.event]));
  const submit = service.bus.submit.bind(service.bus);
  service.bus.submit = async (event) => {
    const result = await submit(event);
    if (!service.chainTestJournal.has(event.idempotency_key)) service.chainTestJournal.set(event.idempotency_key, structuredClone(event));
    return result;
  };
  service.bus.start();
  return { chain, runtime, store, service, watcher, advance: (ms) => { nowMs += ms; },
    poll: async () => { const status = await watcher.poll(service); await service.bus.idle(); return status; } };
}
