import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFinanceError, revertName } from '../web/src/lib/finance-errors.js';

const cjk = /[\u3400-\u9fff]/u;

test('server codes, contract reverts and require reasons become a sentence in the reader language', () => {
  for (const failure of [{ code: 'financing_disclosure_missing', message: 'Readable financing terms are unavailable; do not sign' },
    { code: 'rights_not_configured', message: 'Research identity vault is not configured' }, { code: 'quote_changed' },
    { code: 'CALL_EXCEPTION', reason: 'terms changed', revert: { name: 'Error', args: ['terms changed'] } },
    { code: 'CALL_EXCEPTION', data: '0xf8eb54de' }]) {
    const zh = describeFinanceError(failure, true).message, en = describeFinanceError(failure, false).message;
    assert.match(zh, cjk, JSON.stringify(failure));
    assert.doesNotMatch(en, cjk);
    assert.notEqual(en, failure.message);
  }
  assert.equal(revertName({ data: '0xf8eb54de' }), 'NotEligible');
  assert.match(describeFinanceError({ code: 4001 }, true).message, /拒绝/u);
});

test('an unknown failure keeps its own message instead of being hidden', () => {
  assert.equal(describeFinanceError({ code: 'something_new', message: 'Original detail' }, true).message, 'Original detail');
  assert.equal(describeFinanceError({ code: 'CALL_EXCEPTION', reason: 'unmapped reason', message: 'raw' }, false).message, 'raw');
});
