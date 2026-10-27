import { Contract, FetchRequest, Interface, JsonRpcProvider, Signature, verifyTypedData } from 'ethers';

export const AUTHORIZATION_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
] };
export const PAYMENT_ABI = [
  'function name() view returns (string)', 'function version() view returns (string)', 'function decimals() view returns (uint8)',
  'function authorizationState(address,bytes32) view returns (bool)',
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
];
const abi = new Interface(PAYMENT_ABI), same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function fail(code) { throw Object.assign(new Error('Independent payment verification requires reconciliation'), { code }); }

/** Read-only verifier. No facilitator response, attestor, client hash or balance delta is proof.
 * Direct ERC-3009 token calls are supported; an unreviewed wrapper is rejected. */
export class IndependentPaymentVerifier {
  constructor({ provider = null, rpcUrl = null, confirmations = 2, maxScanBlocks = 500 } = {}) {
    if (!Number.isInteger(confirmations) || confirmations < 1 || !Number.isInteger(maxScanBlocks) || maxScanBlocks < 1 || maxScanBlocks > 5000) throw new Error('Invalid payment verification policy');
    Object.assign(this, { provider, rpcUrl, confirmations, maxScanBlocks });
  }
  async #read(task) {
    if (this.provider) return task(this.provider);
    if (!this.rpcUrl) fail('payment_verifier_unconfigured');
    const connection = new FetchRequest(this.rpcUrl); connection.timeout = 10000;
    const provider = new JsonRpcProvider(connection, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    try { return await task(provider); } finally { provider.destroy(); }
  }
  async #authorization(provider, { paymentPayload, paymentRequirements: req }) {
    const auth = paymentPayload.payload.authorization, chainId = Number(await provider.send('eth_chainId', []));
    if (`eip155:${chainId}` !== req.network || !same(auth.to, req.payTo) || auth.value !== req.amount) fail('payment_chain_or_terms_mismatch');
    if (await provider.getCode(req.asset) === '0x') fail('payment_asset_missing');
    const token = new Contract(req.asset, PAYMENT_ABI, provider);
    const [name, version, decimals] = await Promise.all([token.name(), token.version(), token.decimals()]);
    if (name !== req.extra.name || version !== req.extra.version || Number(decimals) !== 6) fail('payment_asset_domain_mismatch');
    if (!paymentPayload.payload.signature) fail('payment_signature_unavailable');
    let recovered;
    try { recovered = verifyTypedData({ name, version, chainId, verifyingContract: req.asset }, AUTHORIZATION_TYPES, auth, paymentPayload.payload.signature); }
    catch { fail('payment_authorization_invalid'); }
    if (!same(recovered, auth.from)) fail('payment_authorization_invalid');
    return { token, auth, chainId };
  }
  async #withExecutedSignature(provider, input, transaction) {
    const tx = await provider.getTransaction(transaction);
    if (!tx) fail('payment_receipt_pending');
    let decoded;
    try { decoded = abi.parseTransaction({ data: tx.data }); } catch { fail('payment_calldata_mismatch'); }
    if (decoded?.name !== 'transferWithAuthorization') fail('payment_calldata_mismatch');
    let signature;
    try { signature = Signature.from({ v: decoded.args.v, r: decoded.args.r, s: decoded.args.s }).serialized; } catch { fail('payment_calldata_mismatch'); }
    return { ...input, paymentPayload: { ...input.paymentPayload, payload: { ...input.paymentPayload.payload, signature } } };
  }
  async prepare(input) {
    return this.#read(async (provider) => {
      const { token, auth } = await this.#authorization(provider, input);
      const latest = await provider.getBlockNumber();
      const used = await token.authorizationState(auth.from, auth.nonce);
      return { from_block: used ? Math.max(0, latest - this.maxScanBlocks + 1) : latest, authorization_used: used };
    });
  }
  async locate(input, checkpoint = {}) {
    return this.#read(async (provider) => {
      const { token, auth } = await this.#authorization(provider, input);
      const latest = await provider.getBlockNumber();
      const from = checkpoint.from_block ?? Math.max(0, latest - this.maxScanBlocks + 1);
      if (!Number.isInteger(from) || from < 0 || latest - from > this.maxScanBlocks) fail('payment_recovery_scan_exceeded');
      const logs = await token.queryFilter(token.filters.AuthorizationUsed(auth.from, auth.nonce), from, latest);
      if (logs.length !== 1) return null;
      return logs[0].transactionHash;
    });
  }
  async verify(input, transaction) {
    return this.#read(async (provider) => {
      // A payer-signed recovery may carry the stored authorization without its EIP-3009 signature. An executed
      // transferWithAuthorization holds that signature in its calldata; it is checked like a supplied one.
      if (!input.paymentPayload?.payload?.signature) input = await this.#withExecutedSignature(provider, input, transaction);
      const { token, auth, chainId } = await this.#authorization(provider, input), req = input.paymentRequirements;
      const [receipt, tx, latest] = await Promise.all([provider.getTransactionReceipt(transaction), provider.getTransaction(transaction), provider.getBlockNumber()]);
      if (!receipt || !tx) fail('payment_receipt_pending');
      const block = await provider.getBlock(receipt.blockNumber);
      if (receipt.status !== 1 || !block || !same(block.hash, receipt.blockHash) || !same(tx.blockHash, receipt.blockHash)) fail('payment_receipt_noncanonical');
      if (latest - receipt.blockNumber + 1 < this.confirmations) fail('payment_confirmations_pending');
      if (!same(tx.to, req.asset) || Number(tx.chainId) !== chainId || BigInt(tx.value) !== 0n) fail('payment_transaction_mismatch');
      let decoded;
      try { decoded = abi.parseTransaction({ data: tx.data }); } catch { fail('payment_calldata_mismatch'); }
      if (decoded?.name !== 'transferWithAuthorization' || ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'].some((field) => !same(decoded.args[field], auth[field]))) fail('payment_calldata_mismatch');
      if (BigInt(block.timestamp) <= BigInt(auth.validAfter) || BigInt(block.timestamp) >= BigInt(auth.validBefore)) fail('payment_execution_window_invalid');
      const events = receipt.logs.filter((log) => same(log.address, req.asset)).flatMap((log) => {
        try { return [abi.parseLog(log)]; } catch { return []; }
      });
      if (events.filter((event) => event?.name === 'AuthorizationUsed' && same(event.args.authorizer, auth.from) && same(event.args.nonce, auth.nonce)).length !== 1
        || events.filter((event) => event?.name === 'Transfer' && same(event.args.from, auth.from) && same(event.args.to, auth.to) && event.args.value.toString() === auth.value).length !== 1
        || !await token.authorizationState(auth.from, auth.nonce, { blockTag: receipt.blockNumber })) fail('payment_events_mismatch');
      return { schema: 'agentbl-independent-payment-v1', verified: true, network: req.network, asset: req.asset,
        payer: auth.from, payee: auth.to, amount_atomic: auth.value, nonce: auth.nonce, transaction_hash: transaction.toLowerCase(),
        block_number: receipt.blockNumber, block_hash: receipt.blockHash, confirmations: latest - receipt.blockNumber + 1 };
    });
  }
}
