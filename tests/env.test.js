// A developer's .env (a Live x402 setup, an admin token, wallet keys) configures the app, but the tests
// assume a clean environment: src/env.js must not load it while the test runner is running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldLoadDotEnv } from '../src/env.js';

test('.env is loaded for the app but not inside the test runner', () => {
  assert.equal(shouldLoadDotEnv({}), true);
  assert.equal(shouldLoadDotEnv({ NODE_TEST_CONTEXT: 'child-v8' }), false);
});

test('the real test runner marks this process, so .env cannot leak into any test', (t) => {
  if (!process.env.NODE_TEST_CONTEXT) return t.skip('not started through `node --test`');
  assert.equal(shouldLoadDotEnv(process.env), false);
  return undefined;
});
