import { createDisclosure } from '../../src/rights/disclosure.js';
// Version 2 disclosures carry no control_version; later versions name theirs.
export function disclosureFixture(controlVersion = 3) {
  const a = (n) => `0x${n.repeat(20)}`;
  return createDisclosure({ revision: 1, instance: { chain_id: 1439, controller: a('90'), pool: a('34'), ...(controlVersion >= 3 ? { control_version: controlVersion } : {}) },
    terms: { eblId: '1', assetKey: `0x${'ac'.repeat(32)}`, documentHash: `0x${'de'.repeat(32)}`, settlementAsset: a('56'),
      exporter: a('11'), feeRecipient: a('22'), supply: '10', issuePrice: '800000', target: '1000000', minRaise: '8000000',
      subscribeUntil: '1899900000', disburseUntil: '1899950000', maturity: '1900000000', maxFee: '0', nonce: '1' },
    parties: Object.fromEntries(['issuer', 'holder', 'operator', 'valuer', 'compliance', 'disposer', 'reviewer', 'governance'].map((role, i) => [role, a(String(i + 1).padStart(2, '0'))])),
    sources: ['invoice', 'cost', 'collateral', 'risk'].map((field) => ({ field, status: 'fixture', reference: 'fictional research data' })) });
}
