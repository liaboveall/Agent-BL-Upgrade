import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareBytecode, stripMetadata, verifyDeployment } from '../scripts/verify-bytecode.mjs';

// A runtime code stand-in: 6 opcode bytes + a 4-byte "metadata" blob + its 2-byte length (0x0004).
const code = (body, metadata = 'a1b2c3d4') => `0x${body}${metadata}0004`;

test('stripMetadata removes the CBOR trailer named by the last two bytes', () => {
  assert.equal(stripMetadata(code('600160005500')), '600160005500');
  assert.equal(stripMetadata('0x'), '');
  assert.equal(stripMetadata('0x6001'), '6001', 'a blob longer than the code is left alone');
});

test('compareBytecode distinguishes identical, metadata-only and different code', () => {
  const local = code('600160005500');
  assert.equal(compareBytecode(local, local), 'MATCH');
  assert.equal(compareBytecode(local, code('600160005500', 'ffffffff')), 'MATCH_METADATA');
  assert.equal(compareBytecode(local, code('600260005500')), 'DIFFERENT');
  assert.equal(compareBytecode(local, '0x'), 'NOT_DEPLOYED');
  assert.equal(compareBytecode(local, null), 'NOT_DEPLOYED');
  assert.equal(compareBytecode(local.toUpperCase().replace('0X', '0x'), local), 'MATCH', 'case does not matter');
});

test('verifyDeployment reports each configured contract against the local artifacts', async (t) => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbl-artifacts-'));
  t.after(() => fs.rmSync(artifacts, { recursive: true, force: true }));
  const write = (name, deployedBytecode) => {
    fs.mkdirSync(path.join(artifacts, `${name}.sol`), { recursive: true });
    fs.writeFileSync(path.join(artifacts, `${name}.sol`, `${name}.json`), JSON.stringify({ deployedBytecode }));
  };
  write('AgentBLRWA', code('6001'));
  write('PaymentOracle', code('6002'));
  write('EBLRegistry', code('6003'));
  write('RWAToken', code('6004'));
  write('RWAOfferingPool', code('6005'));
  write('AgentDecisionLog', code('6006'));
  // RiskPricingOracle has no artifact on purpose.

  const remote = new Map();
  const getCode = async (urls, method, params) => {
    assert.equal(method, 'eth_getCode');
    assert.ok(Array.isArray(urls) && urls.length > 0);
    return remote.get(params[0].toLowerCase()) ?? '0x';
  };
  const report = await verifyDeployment({ artifactsDir: artifacts, getCode });
  const addressOf = (name) => report.results.find((entry) => entry.name === name).address.toLowerCase();
  remote.set(addressOf('AgentBLRWA'), code('6001'));
  remote.set(addressOf('PaymentOracle'), code('6002', 'ffffffff'));
  remote.set(addressOf('EBLRegistry'), code('60ff'));
  remote.set(addressOf('AgentDecisionLog'), code('6006'));
  // RWAToken is not deployed (no code); RWAOfferingPool likewise.

  const second = await verifyDeployment({ artifactsDir: artifacts, getCode });
  const status = Object.fromEntries(second.results.map((entry) => [entry.name, entry.status]));
  assert.deepEqual(status, {
    AgentBLRWA: 'MATCH',
    PaymentOracle: 'MATCH_METADATA',
    EBLRegistry: 'DIFFERENT',
    RWAToken: 'NOT_DEPLOYED',
    RWAOfferingPool: 'NOT_DEPLOYED',
    RiskPricingOracle: 'NO_ARTIFACT',
    AgentDecisionLog: 'MATCH'
  });
  assert.equal(second.chainId, 1439);
});
