import { Interface, ZeroHash } from 'ethers';
import { openingChain, oil, chainConfig, OWNER } from './opening.js';
import { X402_NETWORKS } from '../../src/x402/config.js';

export { oil, chainConfig, OWNER };
export const RECIPIENT = '0x2222222222222222222222222222222222222222';
export const PAYER = '0x3333333333333333333333333333333333333333';
export const paymentHash = `0x${'ca'.repeat(32)}`;
export const blockHash = (number) => `0x${BigInt(number).toString(16).padStart(64, '0')}`;

/** Canonical receipt fixture; all logs/calldata use the actual contract ABI. No network or signing. */
export function settlementChain() {
  const chain = openingChain();
  chain.seed(oil, { eblId: 7, poolId: 11, poolState: 5 });
  Object.assign(chain.pools.get(11), { subscribed: 1n, repaymentAmount: 0n, paymentProof: ZeroHash, arrivalProof: ZeroHash });
  Object.assign(chain.state, { head: 5000, chainId: 1439, blocks: new Map() });
  const provider = chain.context.provider;
  provider.send = async () => `0x${chain.state.chainId.toString(16)}`;
  provider.getBlockNumber = async () => chain.state.head;
  provider.getBlock = async (number) => ({ number, hash: chain.state.blocks.get(number) ?? blockHash(number) });
  chain.context.pool.settlementProofs = async (id) => {
    const pool = chain.pools.get(Number(id)); return [pool?.paymentProof ?? ZeroHash, pool?.arrivalProof ?? ZeroHash];
  };
  chain.context.chainConfig = chainConfig; chain.context.settlementRecipient = RECIPIENT;
  const transferIface = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  function payment({ txHash = paymentHash, asset = X402_NETWORKS['eip155:1439'].asset, from = PAYER, to = RECIPIENT,
    amount = 1_234_567n, status = 1, block = 100, extraLogs = [] } = {}) {
    const log = transferIface.encodeEventLog(transferIface.getEvent('Transfer'), [from, to, amount]);
    const receipt = { hash: txHash, blockNumber: block, blockHash: blockHash(block), status,
      logs: [{ address: asset, topics: log.topics, data: log.data, index: 0, transactionHash: txHash, blockHash: blockHash(block) }, ...extraLogs] };
    chain.transactions.set(txHash, { hash: txHash, chainId: 1439n, to: asset, from: PAYER, value: 0n });
    chain.receipts.set(txHash, receipt); return receipt;
  }
  function send(step, options = {}) {
    const pool = chain.pools.get(Number(step.args[0]));
    let args;
    if (step.method === 'recordImporterPayment') {
      pool.paymentProof = step.args[1]; pool.repaymentAmount = BigInt(step.args[2]);
      args = [step.args[0], pool.paymentProof, pool.arrivalProof];
    } else if (step.method === 'recordCargoArrival') {
      pool.arrivalProof = step.args[1]; args = [step.args[0], pool.paymentProof, pool.arrivalProof];
    } else if (step.method === 'settle') {
      pool.state = 9; args = [step.args[0], pool.repaymentAmount, pool.paymentProof, pool.arrivalProof];
    } else throw new Error('Unsupported settlement fixture step');
    const tx = chain.emit(step, args, options), receipt = chain.receipts.get(tx.hash);
    receipt.blockHash = blockHash(receipt.blockNumber); receipt.logs[0].index = 0;
    return tx;
  }
  return { ...chain, payment, send };
}
