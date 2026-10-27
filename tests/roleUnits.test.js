import test from 'node:test';
import assert from 'node:assert/strict';
import { toAtomic, toUnixSeconds } from '../web/src/lib/units.js';

test('role forms take TEST_USDC and derive the exact atomic amount without floating point', () => {
  assert.equal(toAtomic('8'), '8000000');
  assert.equal(toAtomic('8.5'), '8500000');
  assert.equal(toAtomic(' 0.000001 '), '1');
  assert.equal(toAtomic('123456789.123456'), '123456789123456');
  assert.equal(toAtomic('0.1'), '100000', '0.1 is exact, not 99999');
  for (const invalid of ['', '0', '0.000000', '1.0000001', '-1', '1e6', '1,5', 'abc', '.5']) assert.equal(toAtomic(invalid), '', invalid);
});

test('a local deadline becomes Unix seconds; an empty or invalid one becomes nothing', () => {
  assert.equal(toUnixSeconds('2026-10-27T12:30'), String(Math.floor(new Date(2026, 9, 27, 12, 30).getTime() / 1000)));
  assert.equal(toUnixSeconds(''), '');
  assert.equal(toUnixSeconds('not a date'), '');
});
