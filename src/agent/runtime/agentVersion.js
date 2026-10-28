import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toUtf8Bytes } from 'ethers';
import { hashSnapshot, stableStringify } from '../decisionLogger.js';
import { DEFAULT_LLM_MODEL, isConfigured } from '../llm/openaiCompatClient.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let runtimeCodeHash;

/** What a version commits as its model: the configured one, or a plain statement that no model can run. */
export const NO_MODEL_ID = 'none:deterministic-only';
export function configuredModelId(env = {}) {
  const enabled = String(env.LLM_PROXY_ENABLED ?? 'true').toLowerCase() !== 'false' && isConfigured(env);
  return enabled ? String(env.LLM_MODEL ?? '').trim() || DEFAULT_LLM_MODEL : NO_MODEL_ID;
}

export function createAgentVersion(config, env = {}, sourceHash, modelId = configuredModelId(env)) {
  if (!sourceHash && !runtimeCodeHash) {
    const files = [];
    const visit = (dir) => {
      for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const name = `${dir}/${item.name}`;
        if (item.isDirectory()) visit(name);
        else if (item.isFile() && name.endsWith('.js')) files.push([name, fs.readFileSync(path.join(root, name), 'utf8').replaceAll('\r\n', '\n')]);
      }
    };
    visit('src');
    for (const name of ['package.json', 'package-lock.json']) files.push([name, fs.readFileSync(path.join(root, name), 'utf8').replaceAll('\r\n', '\n')]);
    runtimeCodeHash = hashSnapshot(files);
  }
  sourceHash ??= runtimeCodeHash;
  const { anchorEnabled: _enabled, anchorIntervalSec: _interval, anchorMinBatch: _min, ...policy } = config;
  const version = { policy_hash: hashSnapshot(policy), code_commit: sourceHash, model_id: modelId };
  return { ...version, version_id: keccak256(toUtf8Bytes(stableStringify(version))) };
}

// Old journals cannot establish which code/config/model produced their decisions.
export const LEGACY_AGENT_VERSION = createAgentVersion({ legacy: 'unrecorded' }, {}, hashSnapshot({ code: 'unrecorded legacy' }), 'UNRECORDED_LEGACY');
