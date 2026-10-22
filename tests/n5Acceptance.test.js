import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAcceptanceInput } from '../scripts/lib/n5-acceptance.mjs';

const actors = { governorA: '0x9da22292D85e2A584ace6bb347D7054486b5ed6B', investor: '0x32ddDf0e99d2375E502350710A809E4223e28098' };
const base = { schema: 'agentbl-n5-acceptance-input-v1', run: '20261023',
  investors: [{ label: 'A', wallet: '0x1111111111111111111111111111111111111111' }, { label: 'B', wallet: '0x2222222222222222222222222222222222222222' }],
  pools: { normal: { subscribe_until: '2026-10-30T10:00:00+08:00' }, refund: { subscribe_until: '2026-10-24T15:30:00+08:00' } } };

test('acceptance input derives deadlines, organizations and bounded top-ups', () => {
  const input = parseAcceptanceInput(base, actors), normal = Date.parse('2026-10-30T02:00:00Z') / 1000;
  assert.deepEqual(input.pools.normal, { subscribeUntil: normal, disburseUntil: normal + 86400, maturity: normal + 2 * 86400 });
  assert.deepEqual(input.investors.map((investor) => investor.organization), ['N5_ACCEPTANCE_20261023_A', 'N5_ACCEPTANCE_20261023_B']);
  assert.deepEqual(input.topUp, { testUsdcAtomic: '10000000', injWei: '20000000000000000' });
  assert.equal(input.screeningUntil, null);
});

test('acceptance input rejects research signers, reused or missing wallets, zoneless times and oversized top-ups', () => {
  const invalid = [
    { ...base, investors: [base.investors[0], { label: 'B', wallet: actors.investor.toLowerCase() }] },
    { ...base, investors: [base.investors[0], { ...base.investors[0], label: 'B' }] },
    { ...base, investors: [base.investors[0]] },
    { ...base, pools: { ...base.pools, refund: { subscribe_until: '2026-10-24T15:30:00' } } },
    { ...base, pools: { ...base.pools, normal: { subscribe_until: '2026-10-30T10:00:00+08:00', disburse_until: '2026-10-30T09:00:00+08:00' } } },
    { ...base, top_up: { inj_wei: '1000000000000000000' } },
    { ...base, run: 'Bad Run' },
    { ...base, schema: 'agentbl-n5-acceptance-input-v0' }
  ];
  for (const raw of invalid) assert.throws(() => parseAcceptanceInput(raw, actors));
});
