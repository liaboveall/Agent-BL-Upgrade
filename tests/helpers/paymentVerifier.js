// Synthetic collaborator for legacy HTTP/state-machine tests. W4 separately exercises the real
// IndependentPaymentVerifier against actual ERC-3009 transactions on an isolated EVM.
export const syntheticPaymentVerifier = {
  prepare: async () => ({ from_block: 0, authorization_used: false }),
  locate: async () => null,
  verify: async (input, transaction) => ({ schema: 'synthetic-payment-test-v1', verified: true,
    network: input.paymentRequirements.network, asset: input.paymentRequirements.asset,
    payer: input.paymentPayload.payload.authorization.from, payee: input.paymentRequirements.payTo,
    amount_atomic: input.paymentRequirements.amount, nonce: input.paymentPayload.payload.authorization.nonce,
    transaction_hash: transaction, block_hash: `0x${'ba'.repeat(32)}`, block_number: 1, confirmations: 2 })
};
