import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ContractFactory, JsonRpcProvider, HDNodeWallet, Mnemonic, id as ethersId } from 'ethers';
import { Ledger } from '../../src/ledger/ledger.js';
import { ChainEventRebuilder } from '../../src/ledger/rebuilder.js';
import { buildPositionView } from '../../src/ledger/positionView.js';

export async function tmpLedger() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  return { ledger: new Ledger({ baseDir: dir }), dir };
}

export async function cleanupTmpLedger(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

const HARDHAT_ROOT = path.resolve('hardhat');
const RPC_URL = 'http://127.0.0.1:8545';
const HARDHAT_CLI = path.join(HARDHAT_ROOT, 'node_modules', 'hardhat', 'dist', 'src', 'cli.js');

// Hardhat default mnemonic accounts used by `hardhat node`.
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

function accountAt(provider, index) {
  const hd = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(HARDHAT_MNEMONIC),
    `m/44'/60'/0'/0/${index}`
  );
  return hd.connect(provider);
}

function artifactPath(name) {
  return path.join(HARDHAT_ROOT, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`);
}

function loadArtifact(name) {
  const file = fsSync.readFileSync(artifactPath(name), 'utf8');
  return JSON.parse(file);
}

class NonceTracker {
  constructor(provider) {
    this.provider = provider;
    this.nonces = {};
  }

  async init(address) {
    this.nonces[address.toLowerCase()] = await this.provider.getTransactionCount(address);
  }

  next(address) {
    return this.nonces[address.toLowerCase()]++;
  }
}

function deployContract(signer, name, args = [], overrides = {}) {
  const { abi, bytecode } = loadArtifact(name);
  const factory = new ContractFactory(abi, bytecode, signer);
  return factory.deploy(...args, overrides);
}

export async function runHardhatNode() {
  const proc = spawn('node', [HARDHAT_CLI, 'node'], {
    cwd: HARDHAT_ROOT,
    stdio: 'pipe'
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hardhat node startup timeout')), 30_000);
    proc.stdout.on('data', (data) => {
      if (String(data).includes('Started HTTP and WebSocket JSON-RPC server')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on('data', (data) => {
      // Surface startup errors so the test does not hang silently.
      const text = String(data);
      if (text.toLowerCase().includes('error')) {
        clearTimeout(timer);
        reject(new Error(text));
      }
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return proc;
}

export function stopHardhatNode(proc) {
  if (!proc) return;
  proc.kill('SIGKILL');
}

export async function deployAndRunW2Lifecycle() {
  const provider = new JsonRpcProvider(RPC_URL);
  const owner = accountAt(provider, 0);
  const investor = accountAt(provider, 1);
  const exporter = accountAt(provider, 2);

  const nonces = new NonceTracker(provider);
  for (const wallet of [owner, investor, exporter]) {
    await nonces.init(wallet.address);
  }

  const ownerDeploy = (name, args = []) => deployContract(owner, name, args, { nonce: nonces.next(owner.address) });
  const ownerSend = (contract, method, args = []) =>
    contract[method](...args, { nonce: nonces.next(owner.address) });
  const investorSend = (contract, method, args = []) =>
    contract.connect(investor)[method](...args, { nonce: nonces.next(investor.address) });
  const exporterSend = (contract, method, args = []) =>
    contract.connect(exporter)[method](...args, { nonce: nonces.next(exporter.address) });

  const usdc = await (await ownerDeploy('MockUSDC')).waitForDeployment();
  const registry = await (await ownerDeploy('EBLRegistry')).waitForDeployment();
  const token = await (await ownerDeploy('RWATokenV5')).waitForDeployment();
  const pool = await (await ownerDeploy('RWAOfferingPoolV5', [
    await registry.getAddress(),
    await token.getAddress()
  ])).waitForDeployment();

  const poolAddress = await pool.getAddress();
  await (await ownerSend(token, 'setPool', [poolAddress])).wait();
  await (await ownerSend(pool, 'setAgentExecutor', [owner.address, true])).wait();

  // Mint and pledge an eBL as collateral.
  const metadataHash = ethersId('w2-cross-layer:ebl');
  await (await ownerSend(registry, 'mintEBL', [metadataHash, owner.address])).wait();
  const eblId = (await registry.nextEblId()) - 1n;
  await (await ownerSend(registry, 'pledge', [eblId, poolAddress])).wait();

  // Create an offering with full-subscription terms.
  const supply = 10n;
  const issuePrice = 1_000_000n; // 1 USDC in 6 decimals.
  const targetRedemptionValue = issuePrice;
  const cost = supply * issuePrice;
  const latestBlock = await provider.getBlock('latest');
  const chainNow = BigInt(latestBlock.timestamp);
  const maturity = chainNow + 10_000n;
  const deadline = chainNow + 1_000n;
  const createTx = await (await ownerSend(pool, 'createOfferingWithTerms', [
    eblId,
    supply,
    issuePrice,
    targetRedemptionValue,
    maturity,
    deadline,
    await usdc.getAddress(),
    cost
  ])).wait();
  const poolId = (await pool.nextPoolId()) - 1n;

  // Investor subscribes to the full supply.
  await (await ownerSend(usdc, 'mint', [investor.address, cost])).wait();
  await (await investorSend(usdc, 'approve', [poolAddress, cost])).wait();
  const userDeadline = chainNow + 600n;
  await (await investorSend(pool, 'subscribeWithTerms', [
    poolId,
    supply,
    issuePrice,
    1n,
    userDeadline
  ])).wait();

  // Owner disburses escrow to the exporter.
  await (await ownerSend(pool, 'disburseToExporter', [poolId, cost, exporter.address, ethersId('disburse')])).wait();

  // Exporter repays the full amount into escrow.
  await (await ownerSend(usdc, 'mint', [exporter.address, cost])).wait();
  await (await exporterSend(usdc, 'approve', [poolAddress, cost])).wait();
  await (await exporterSend(pool, 'repay', [poolId, cost])).wait();

  // Settlement proofs and settle.
  await (await ownerSend(pool, 'recordImporterPayment', [poolId, ethersId('payment'), cost])).wait();
  await (await ownerSend(pool, 'recordCargoArrival', [poolId, ethersId('arrival')])).wait();
  await (await ownerSend(pool, 'settle', [poolId, cost])).wait();

  // Investor claims pro-rata repayment.
  const claimTx = await (await investorSend(pool, 'claim', [poolId])).wait();

  // Rebuild the durable ledger from on-chain v5 events.
  const { ledger, dir } = await tmpLedger();
  const rebuilder = new ChainEventRebuilder(ledger);
  const network = await provider.getNetwork();
  const protocolInstance = {
    chain_id: Number(network.chainId),
    pool_address: poolAddress.toLowerCase(),
    protocol_version: 5
  };
  const fromBlock = Number(createTx.blockNumber);
  const { positions } = await rebuilder.rebuild({
    provider,
    poolAddress,
    chainId: Number(network.chainId),
    protocolVersion: 5,
    fromBlock,
    toBlock: 'latest'
  });

  // Snapshot on-chain token balances for the position view.
  const chainBalances = new Map();
  chainBalances.set(`${protocolInstance.chain_id}:${poolAddress.toLowerCase()}:${Number(poolId)}`,
    await token.balanceOf(poolId, investor.address));

  const view = buildPositionView({
    wallet: investor.address,
    ledgerPositions: positions,
    chainBalances
  });

  return {
    provider,
    owner,
    investor,
    exporter,
    pool,
    usdc,
    token,
    poolId,
    cost,
    ledger,
    ledgerDir: dir,
    protocolInstance,
    positions,
    view,
    claimTxHash: claimTx.hash
  };
}
