import { HttpError } from '../app/http.js';

const unavailable = (code = 'rpc_read_unavailable') => new HttpError(503, code, 'Chain reads are incomplete; retry the same snapshot');
const transient = (error) => ['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'UNKNOWN_ERROR', 'rpc_read_timeout'].includes(error?.code)
  || [429, 502, 503, 504].includes(error?.status ?? error?.info?.responseStatus);

/** One queue per configured instance. A timed-out transport keeps its slot until it
 * settles, so repeated HTTP timeouts cannot create unbounded background RPC work. */
export class RpcReadPool {
  constructor({ concurrency = 6, queueLimit = 240, timeoutMs = 10000, retries = 1 } = {}) {
    Object.assign(this, { concurrency, queueLimit, timeoutMs, retries });
    this.active = 0; this.queue = []; this.peak = 0;
  }
  run(operation, { timeoutMs = this.timeoutMs } = {}) {
    if (this.queue.length >= this.queueLimit) return Promise.reject(unavailable('rpc_read_busy'));
    return new Promise((resolve, reject) => {
      const job = { operation, resolve, reject, expired: false };
      job.timer = setTimeout(() => {
        job.expired = true;
        const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
        reject(unavailable('rpc_read_timeout'));
      }, timeoutMs);
      this.queue.push(job); this.drain();
    });
  }
  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift(); if (job.expired) continue;
      this.active++; this.peak = Math.max(this.peak, this.active);
      Promise.resolve().then(job.operation).then(job.resolve, job.reject).finally(() => {
        clearTimeout(job.timer); this.active--; this.drain();
      });
    }
  }
  budget(maxCalls = 320, { deadlineMs = 20000 } = {}) {
    const stats = { calls: 0, retries: 0, failures: 0 };
    const deadline = Date.now() + deadlineMs;
    const read = async (operation) => {
      for (let attempt = 0; ; attempt++) {
        if (++stats.calls > maxCalls) throw unavailable('rpc_read_budget_exceeded');
        if (Date.now() >= deadline) throw unavailable('rpc_read_deadline');
        try { return await this.run(operation, { timeoutMs: Math.min(this.timeoutMs, deadline - Date.now()) }); }
        catch (error) {
          if (attempt < this.retries && transient(error) && error?.code !== 'rpc_read_timeout') { stats.retries++; continue; }
          stats.failures++; throw unavailable(error?.code === 'rpc_read_timeout' ? error.code : 'rpc_read_unavailable');
        }
      }
    };
    return { read, stats };
  }
}

export async function mapReads(values, callback, concurrency = 3) {
  const result = new Array(values.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) { const current = index++; result[current] = await callback(values[current]); }
  }));
  return result;
}

export function boundedProvider(provider, read) {
  const methods = new Set(['getNetwork', 'send', 'call', 'getBlock', 'getBlockNumber', 'getCode', 'getLogs', 'getTransaction', 'getTransactionReceipt', 'getTransactionCount']);
  return new Proxy(provider, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== 'function') return value;
    return methods.has(property) ? (...args) => read(() => value.apply(target, args)) : value.bind(target);
  } });
}

export function readPage(params) {
  const from = Number(params.get('from') ?? 1), limit = Number(params.get('limit') ?? 10);
  const number = params.get('block_number'), hash = params.get('block_hash');
  if (!Number.isSafeInteger(from) || from < 1 || !Number.isInteger(limit) || limit < 1 || limit > 20
    || (number == null) !== (hash == null) || number != null && (!/^\d+$/u.test(number) || !Number.isSafeInteger(Number(number)) || !/^0x[a-fA-F0-9]{64}$/u.test(hash))) {
    throw new HttpError(400, 'invalid_pagination', 'Use a positive cursor, limit up to 20 and a complete snapshot reference');
  }
  const status = params.get('status');
  if (status != null && !['all', 'open', 'active', 'closed'].includes(status)) throw new HttpError(400, 'invalid_pagination', 'Filter by all, open, active or closed');
  return { from, limit, ...(status == null ? {} : { status }), ...(number == null ? {} : { block_number: Number(number), block_hash: hash }) };
}

export async function readSnapshot(provider, query, read) {
  const block = await read(() => provider.getBlock(query.block_number ?? 'latest'));
  if (!block || !Number.isSafeInteger(block.number) || !Number.isSafeInteger(block.timestamp) || !/^0x[a-fA-F0-9]{64}$/u.test(block.hash ?? '')
    || query.block_hash && block.hash?.toLowerCase() !== query.block_hash.toLowerCase()) throw unavailable('chain_reconciliation_required');
  return block;
}

export async function assertSnapshot(provider, block, read) {
  if ((await read(() => provider.getBlock(block.number)))?.hash !== block.hash) throw unavailable('chain_reconciliation_required');
}

export function snapshotInfo(block) {
  return { block_number: block.number, block_hash: block.hash, block_timestamp: block.timestamp,
    observed_at: new Date().toISOString(), age_seconds: Math.max(0, Math.floor(Date.now() / 1000) - block.timestamp), canonical: true };
}
