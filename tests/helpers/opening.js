import fs from 'node:fs/promises';
import { Interface, ZeroAddress } from 'ethers';
import { loadChainConfig } from '../../src/agent/runtime/factory.js';
import { cargoIdentityHash } from '../../src/chain/cargoIdentity.js';

export const OWNER = '0x1111111111111111111111111111111111111111';
export const chainConfig = loadChainConfig();
export const copper = JSON.parse(await fs.readFile(new URL('../../data/cases/archive/copper-sg-shanghai-2026-06.case.json', import.meta.url), 'utf8'));
export const oil = JSON.parse(await fs.readFile(new URL('../../data/cases/crude-fuj-sin.case.json', import.meta.url), 'utf8'));

/** In-memory chain fixture with real deployed ABI encoding. No key, RPC or signing code. */
export function openingChain() {
  const bills = new Map(), pools = new Map(), transactions = new Map(), receipts = new Map();
  const state = { nextEbl: 7, nextPool: 11, stopped: false, owner: OWNER, poolOwner: OWNER, reads: 0, sent: [] };
  const interfaces = { EBLRegistry: new Interface(chainConfig.abis.EBLRegistry), RWAOfferingPool: new Interface(chainConfig.abis.RWAOfferingPool) };
  const registry = {
    owner: async () => state.owner,
    isUnique: async (hash) => { state.reads++; return ![...bills.values()].some((bill) => bill.cargoHash.toLowerCase() === hash.toLowerCase()); },
    eblIdForCargo: async (hash) => [...bills].find(([, bill]) => bill.cargoHash.toLowerCase() === hash.toLowerCase())?.[0] ?? 0,
    cargoHashOf: async (id) => bills.get(Number(id))?.cargoHash,
    metadataHashOf: async (id) => bills.get(Number(id))?.metadataHash,
    holderOf: async (id) => bills.get(Number(id))?.holder ?? ZeroAddress,
    pledgedTo: async (id) => bills.get(Number(id))?.pledgedTo ?? ZeroAddress
  };
  const pool = {
    target: chainConfig.contracts.RWAOfferingPool,
    interface: interfaces.RWAOfferingPool,
    owner: async () => state.poolOwner,
    emergencyStopped: async () => state.stopped,
    poolOfEbl: async (id) => [...pools].find(([, item]) => item.eblId === Number(id))?.[0] ?? 0,
    offerings: async (id) => pools.get(Number(id)) ?? { exists: false },
    stateOf: async (id) => pools.get(Number(id))?.state ?? 0
  };
  const provider = { getTransaction: async (hash) => transactions.get(hash) ?? null,
    getTransactionReceipt: async (hash) => receipts.get(hash) ?? null };
  function emit(step, args, { eventArgs, from = OWNER, eventAddress = step.address, txData, status = 1, nativeValue = 0n } = {}) {
    const iface = interfaces[step.contract];
    const txHash = `0x${(state.sent.length + 101).toString(16).padStart(64, '0')}`;
    const name = step.expected_events[0];
    const encoded = iface.encodeEventLog(iface.getEvent(name), eventArgs ?? args);
    const receipt = { hash: txHash, from, to: step.address, status, blockNumber: 1000 + state.sent.length, logs: [{ address: eventAddress, topics: encoded.topics, data: encoded.data }] };
    transactions.set(txHash, { hash: txHash, to: step.address, from, data: txData ?? iface.encodeFunctionData(step.method, step.args), chainId: 1439n, value: nativeValue });
    receipts.set(txHash, receipt); state.sent.push({ step, tx_hash: txHash });
    return { hash: txHash, wait: async () => receipt };
  }
  function send(step, options) {
    if (step.method === 'mintEBLV2') {
      const [cargoHash, metadataHash, holder] = step.args, id = state.nextEbl++;
      bills.set(id, { cargoHash, metadataHash, holder, pledgedTo: ZeroAddress });
      return emit(step, [id, cargoHash, metadataHash, holder], options);
    }
    const id = Number(step.args[0]);
    if (step.method === 'pledge') {
      const bill = bills.get(id); bill.pledgedTo = step.args[1];
      return emit(step, [id, step.args[1], bill.holder], options);
    }
    const poolId = state.nextPool++;
    pools.set(poolId, { eblId: id, tokenSupply: BigInt(step.args[1]), issuePrice: BigInt(step.args[2]), targetRedemptionValue: BigInt(step.args[3]), state: 2, exists: true, subscribed: 0 });
    return emit(step, [poolId, id, ...step.args.slice(1)], options);
  }
  function seed(caseData = copper, { eblId = 2, poolId = 2, poolState = 2, metadataHash = `0x${'ab'.repeat(32)}` } = {}) {
    bills.set(eblId, { cargoHash: cargoIdentityHash(caseData), metadataHash, holder: OWNER, pledgedTo: poolId ? chainConfig.contracts.RWAOfferingPool : ZeroAddress });
    if (poolId) pools.set(poolId, { eblId, exists: true, state: poolState, issuePrice: 900000n, subscribed: 0 });
  }
  return { context: { registry, pool, provider, signers: {} }, state, bills, pools, transactions, receipts, interfaces, seed, send, emit };
}

export async function uploadedDocuments(folder = 'crude-fuj-sin', edit = (name, text) => text) {
  return Promise.all(['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'].map(async (name) => ({ name, mime_type: 'text/markdown',
    text: edit(name, await fs.readFile(new URL(`../../data/uploads/${folder}/${name}`, import.meta.url), 'utf8')) })));
}
