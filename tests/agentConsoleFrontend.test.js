import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { safeExplorerUrl } from '../public/agent/api.js';
import { shortId } from '../public/agent/ui.js';

const dir = new URL('../public/agent/', import.meta.url);
const sources = new Map();
for (const name of (await fs.readdir(dir)).filter((n) => n.endsWith('.js'))) {
  sources.set(name, await fs.readFile(new URL(name, dir), 'utf8'));
}

test('console: dynamic values never go through innerHTML (decisions carry event and chain data)', () => {
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|\bhtml:/u, `${name} must build DOM with el()/text nodes`);
  }
});

test('console: a link is only ever built from an https explorer_url, never from a hash or a demo reference', () => {
  assert.equal(safeExplorerUrl('https://testnet.blockscout.injective.network/tx/0xabc'), 'https://testnet.blockscout.injective.network/tx/0xabc');
  for (const bad of ['javascript:alert(1)', 'http://insecure.example/tx/1', 'demo:abc123', '', null, undefined, 'https://', 'https://a b']) {
    assert.equal(safeExplorerUrl(bad), null, String(bad));
  }
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/href:\s*([^,}]+)/gu)) {
      assert.match(match[1], /link|safeExplorerUrl/u, `${name}: href must come from safeExplorerUrl, got ${match[1]}`);
    }
    assert.doesNotMatch(source, /blockscout/iu, `${name} must not hard-code an explorer`);
  }
});

test('console: a simulated execution is labelled DEMO and has no link path', () => {
  const detail = sources.get('decision-detail.js');
  assert.match(detail, /ac_simulated/u);
  const exec = detail.slice(detail.indexOf('export function renderExecution'), detail.indexOf('/** Pipeline step'));
  // The link is only attached in the branch that has a tx_hash; the reference branch has none.
  assert.match(exec, /if \(execution\.tx_hash\)[\s\S]*?else if \(execution\.reference\)/u);
});

test('console: shortId shortens without repeating the value', () => {
  assert.equal(shortId('demo:ed39cad0ad05abcdef', 14, 0), 'demo:ed39cad0a…');
  assert.equal(shortId('0x1234567890abcdef1234567890abcdef', 6, 4), '0x1234…cdef');
  assert.equal(shortId('short', 14, 4), 'short');
  assert.equal(shortId(null), '');
});
