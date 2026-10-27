import { Contract, keccak256 } from 'ethers';

// Multicall3 is deployed at one address with byte-identical runtime code on Ethereum, Base, Injective EVM testnet and
// most other EVM chains. Its results are trusted only after the deployed code matches that canonical hash; where it
// is missing (a local test chain) or different, callers keep their one-call-per-value reads.
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL3_CODE_HASH = '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';
const ABI = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'];
// Calls per eth_call: a page of 20 pools is about 180 views, far below any node's call gas cap at this size.
const CHUNK = 64;
const checked = new WeakMap();

/** The verified Multicall3 on this provider's chain, or null. A match is remembered per provider; a miss is re-checked. */
export async function multicallFor(provider, read) {
  if (typeof provider?.getCode !== 'function' || typeof provider?.call !== 'function') return null;
  if (!checked.has(provider)) {
    const check = read(() => provider.getCode(MULTICALL3_ADDRESS)).then((code) => keccak256(code) === MULTICALL3_CODE_HASH, () => false);
    checked.set(provider, check);
    if (!await check) checked.delete(provider);
  }
  return await checked.get(provider) ? new Contract(MULTICALL3_ADDRESS, ABI, provider) : null;
}

/**
 * Read many views at one block. Items are { contract, method, args }. Each result is what the contract method
 * itself would return (the value for a single output, the Result otherwise), or an Error for a reverted or
 * undecodable call, so one bad pool never hides the others.
 */
export async function multicallViews(multicall, items, { blockTag, read }) {
  const calls = await Promise.all(items.map(async ({ contract, method, args }) => ({
    target: await contract.getAddress(), allowFailure: true, callData: contract.interface.encodeFunctionData(method, args)
  })));
  const chunks = [];
  for (let start = 0; start < calls.length; start += CHUNK) chunks.push(calls.slice(start, start + CHUNK));
  const answers = (await Promise.all(chunks.map((chunk) => read(() => multicall.aggregate3.staticCall(chunk, { blockTag }))))).flat();
  return answers.map(([success, data], index) => {
    if (!success) return new Error('view reverted');
    const { contract, method } = items[index];
    try {
      const result = contract.interface.decodeFunctionResult(method, data);
      return contract.interface.getFunction(method).outputs.length === 1 ? result[0] : result;
    } catch (error) {
      return error;
    }
  });
}
