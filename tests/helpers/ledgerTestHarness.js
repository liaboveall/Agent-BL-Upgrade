import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ContractFactory, JsonRpcProvider, id } from 'ethers';
import { Ledger } from '../../src/ledger/ledger.js';
import { CapitalLedgerService } from '../../src/ledger/service.js';

export async function tmpLedger() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  return { ledger: new Ledger({ baseDir: dir }), dir };
}
export async function cleanupTmpLedger(dir) { await fs.rm(dir, { recursive: true, force: true }); }

const HARDHAT_ROOT = path.resolve('hardhat');
const HARDHAT_CLI = path.join(HARDHAT_ROOT, 'node_modules/hardhat/dist/src/cli.js');
const artifact = async (name) => JSON.parse(await fs.readFile(path.join(HARDHAT_ROOT, 'artifacts/contracts', `${name}.sol`, `${name}.json`), 'utf8'));

export async function runHardhatNode() {
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const proc = spawn(process.execPath, [HARDHAT_CLI, 'node', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: HARDHAT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: 'w2-local', AGENTBL_W2_INTEGRATION: '1' }
  });
  // Drain the output without exposing Hardhat's printed development private keys.
  proc.stderr.resume();
  try {
    await new Promise((resolve, reject) => {
      // A shared Windows checkout under WSL can take tens of seconds to load native plugins.
      const timer = setTimeout(() => reject(new Error('Isolated Hardhat node startup timed out')), 90_000);
      let outputTail = '';
      proc.stdout.on('data', (data) => {
        outputTail = `${outputTail}${data}`.slice(-4096);
        if (outputTail.includes('Started HTTP and WebSocket JSON-RPC server')) { clearTimeout(timer); resolve(); }
      });
      proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Isolated Hardhat node exited ${code}`)); });
      proc.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
  } catch (error) { proc.kill(); throw error; }
  return { proc, url: `http://127.0.0.1:${port}` };
}

export async function stopHardhatNode(node) {
  if (!node?.proc || node.proc.exitCode !== null) return;
  const exited = new Promise((resolve) => node.proc.once('exit', resolve));
  node.proc.kill(); await exited;
}

export async function deployW2(node, t) {
  const provider = new JsonRpcProvider(node.url, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const [owner, investor, exporter, secondInvestor] = await Promise.all([0, 1, 2, 3].map((index) => provider.getSigner(index)));
  const deploy = async (name, args = []) => {
    const { abi, bytecode } = await artifact(name);
    return (await new ContractFactory(abi, bytecode, owner).deploy(...args)).waitForDeployment();
  };
  const registry = await deploy('MockCapitalRegistry'), usdc = await deploy('MockUSDC'), token = await deploy('ControlledRWAToken');
  const pool = await deploy('RWAOfferingPoolV5', [await registry.getAddress(), await token.getAddress()]);
  const send = async (tx) => (await tx).wait();
  await send(token.bindPool(await pool.getAddress()));
  const { ledger, dir } = await tmpLedger();
  const network = await provider.getNetwork();
  const cfg = { network: 'hardhat-local', protocolVersion: 5, chainIdDecimal: Number(network.chainId), explorerBase: 'http://local.invalid', rpcUrls: [node.url],
    contracts: { RWAOfferingPool: await pool.getAddress(), RWAToken: await token.getAddress(), EBLRegistry: await registry.getAddress() },
    abis: { RWAOfferingPool: (await artifact('RWAOfferingPoolV5')).abi, RWAToken: (await artifact('ControlledRWAToken')).abi },
    deployments: { RWAOfferingPool: { blockNumber: (await pool.deploymentTransaction().wait()).blockNumber } } };
  const getContext = async () => ({ provider, pool, registry, token });
  const capital = new CapitalLedgerService({ ledger, chainConfig: cfg, getContext, getMode: () => 'live' });
  t.after(async () => { await provider.destroy(); await cleanupTmpLedger(dir); });
  let serial = 0;
  const createOffering = async ({ supply = 10n, price = 800_000n, target = 1_000_000n, minRaise = supply * price, deadlineIn = 500, asset = usdc } = {}) => {
    await send(registry.mintEBL(id(`w2:${await pool.getAddress()}:${++serial}`), owner.address));
    const eblId = await registry.nextEblId() - 1n;
    await send(registry.pledge(eblId, await pool.getAddress()));
    const now = BigInt((await provider.getBlock('latest')).timestamp), deadline = now + BigInt(deadlineIn), maturity = now + 10_000n;
    await send(pool.createOfferingWithTerms(eblId, supply, price, target, maturity, deadline, await asset.getAddress(), minRaise));
    return { poolId: Number(await pool.nextPoolId() - 1n), supply, price, target, deadline, maturity, eblId };
  };
  const advance = async (time) => { await provider.send('evm_setNextBlockTimestamp', [Number(time)]); await provider.send('evm_mine', []); };
  return { provider, owner, investor, secondInvestor, exporter, registry, usdc, token, pool, ledger, ledgerDir: dir, capital, cfg, getContext, send, deploy, createOffering, advance };
}
