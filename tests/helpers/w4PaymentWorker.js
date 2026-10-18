import fs from 'node:fs/promises';
import { JsonReceiptStore, X402SettlementService } from '../../src/x402/settlement.js';
import { syntheticPaymentVerifier } from './paymentVerifier.js';
const [filePath, counterPath, inputFile] = process.argv.slice(2), input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
const service = new X402SettlementService({ mode: 'live', store: new JsonReceiptStore({ filePath }), verifier: syntheticPaymentVerifier,
  adapter: { verify: async () => ({ response: { isValid: true }, attempts: 1 }), settle: async () => {
    await fs.appendFile(counterPath, 'settled\n');
    return { response: { success: true, transaction: `0x${'ab'.repeat(32)}`, network: input.paymentRequirements.network, payer: input.paymentPayload.payload.authorization.from }, attempts: 1 };
  } } });
const result = await service.process(input); console.log(JSON.stringify({ state: result.record.state, replayed: result.replayed }));
