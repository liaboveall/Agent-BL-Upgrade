import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDeploymentContinuation, runDeployment } from '../scripts/legacy-testnet.mjs';

test('legacy maintenance rejects every historical execution action', async () => {
  for (const action of ['prepare', 'activate', 'smoke', 'anchor', undefined]) {
    await assert.rejects(runDeployment(action), /exit-only/u);
  }
});

test('deployment continuation preserves frozen evidence and prefers the durable current checkpoint', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-deployment-continuation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const paths = { stateFile: path.join(directory, 'state.json'), evidenceFile: path.join(directory, 'release.json'), baselineFile: path.join(directory, 'original.json'), initialized: true };
  const make = (transactions) => ({ schema: 'agentbl-w5-testnet-deployment-v1', chain_id: 1439, transactions, contracts: {}, actors: {} });
  const original = JSON.stringify(make([{ label: 'original' }]));
  await fs.writeFile(paths.baselineFile, original);
  const first = await loadDeploymentContinuation(paths);
  assert.equal(first.from, paths.baselineFile);
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);
  await fs.writeFile(paths.evidenceFile, JSON.stringify(make([{ label: 'release' }])));
  assert.equal((await loadDeploymentContinuation(paths)).from, paths.evidenceFile);
  await fs.writeFile(paths.stateFile, JSON.stringify(make([{ label: 'durable', tx_hash: 'saved-before-broadcast' }])));
  const current = await loadDeploymentContinuation(paths);
  assert.equal(current.from, paths.stateFile);
  assert.equal(current.state.transactions[0].tx_hash, 'saved-before-broadcast');
  assert.equal(await fs.readFile(paths.baselineFile, 'utf8'), original);
});

test('deployment continuation refuses missing initialized history and corrupt checkpoints', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-deployment-missing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const paths = { stateFile: path.join(directory, 'state.json'), evidenceFile: path.join(directory, 'release.json'), baselineFile: path.join(directory, 'original.json') };
  assert.equal(await loadDeploymentContinuation(paths), null);
  await assert.rejects(loadDeploymentContinuation({ ...paths, initialized: true }), /Initialized deployment history is missing/u);
  await fs.writeFile(paths.stateFile, JSON.stringify({ schema: 'wrong', chain_id: 1776 }));
  await assert.rejects(loadDeploymentContinuation(paths), /Invalid deployment history/u);
});
