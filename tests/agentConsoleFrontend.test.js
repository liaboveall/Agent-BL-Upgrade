import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { safeExplorerUrl } from '../web/src/lib/agent-api.js';
import { shortId } from '../web/src/lib/agent-format.js';

const dir = new URL('../web/src/pages/agent/', import.meta.url);
const sources = new Map();
for (const name of (await fs.readdir(dir)).filter((n) => /\.jsx?$/u.test(n))) {
  sources.set(name, await fs.readFile(new URL(name, dir), 'utf8'));
}

test('console: dynamic values never go through HTML injection (decisions carry event and chain data)', () => {
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/u, `${name} must render values as React text`);
  }
});

test('console: a link is only ever built from an https explorer_url, never from a hash or a demo reference', () => {
  assert.equal(safeExplorerUrl('https://testnet.blockscout.injective.network/tx/0xabc'), 'https://testnet.blockscout.injective.network/tx/0xabc');
  for (const bad of ['javascript:alert(1)', 'http://insecure.example/tx/1', 'demo:abc123', '', null, undefined, 'https://', 'https://a b']) {
    assert.equal(safeExplorerUrl(bad), null, String(bad));
  }
  let links = 0;
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/href=\{([^}]+)\}/gu)) {
      links += 1;
      assert.match(match[1], /^link$|safeExplorerUrl/u, `${name}: href must come from safeExplorerUrl, got ${match[1]}`);
    }
    assert.doesNotMatch(source, /href="/u, `${name} must not hard-code a link`);
    assert.doesNotMatch(source, /blockscout/iu, `${name} must not hard-code an explorer`);
  }
  assert.ok(links >= 3, 'the transaction, execution and anchor links are all checked');
});

test('console: a simulated execution is labelled DEMO and has no link path', () => {
  const detail = sources.get('DecisionDrawer.jsx');
  const exec = detail.slice(detail.indexOf('export function Execution'), detail.indexOf('function Trace'));
  assert.ok(exec.length > 0);
  // The link is only built in the branch that has a tx_hash; the reference branch shows the DEMO badge and no link.
  const txBranch = exec.slice(exec.indexOf('execution.tx_hash ?'), exec.indexOf('execution.reference ?'));
  const refBranch = exec.slice(exec.indexOf('execution.reference ?'), exec.indexOf(') : null}', exec.indexOf('execution.reference ?')));
  assert.match(txBranch, /href=\{link\}/u);
  assert.match(refBranch, /SimulatedBadge/u);
  assert.doesNotMatch(refBranch, /href/u);
  assert.match(sources.get('badges.jsx'), /ac_simulated/u);
});

test('console: shortId shortens without repeating the value', () => {
  assert.equal(shortId('demo:ed39cad0ad05abcdef', 14, 0), 'demo:ed39cad0a…');
  assert.equal(shortId('0x1234567890abcdef1234567890abcdef', 6, 4), '0x1234…cdef');
  assert.equal(shortId('short', 14, 4), 'short');
  assert.equal(shortId(null), '');
});
