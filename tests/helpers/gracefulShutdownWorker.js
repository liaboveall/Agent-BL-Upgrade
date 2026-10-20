import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { acquireRuntimeLease } from '../../src/ops/lease.js';
import { OperationsMonitor } from '../../src/ops/monitor.js';
import { installGracefulShutdown } from '../../src/app/server.js';
const root = process.env.AGENTBL_RUNTIME_DIR;
const journal = path.join(root, 'drain-order.jsonl');
const append = (event) => fs.appendFile(journal, JSON.stringify({ event, at: Date.now() }) + '\n');
const release = await acquireRuntimeLease(root, 'shutdown-regression');
const server = http.createServer((_request, response) => response.end('ok'));
let probes = 0;
server.operations = new OperationsMonitor({ directory: root, env: { AGENTBL_OPS_INTERVAL_MS: '60000' },
  getAgentStatus: async () => ({ enabled: false, mode: 'demo', queue: {}, activity: {} }),
  probeStorage: async () => {
    if (++probes > 1) {
      await append('probe-start'); process.send({ type: 'probe-start' });
      await new Promise((resolve) => setTimeout(resolve, 12000));
      await append('probe-done');
    }
    return { available_bytes: '1000000000' };
  } });
installGracefulShutdown(server, async () => { await append('lease-release'); await release(); });
// Windows does not deliver POSIX SIGTERM to Node children; exercise the same registered handler via IPC there.
process.on('message', (message) => { if (message === 'stop') process.emit('SIGTERM'); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await server.operations.start();
void server.operations.sample();
