import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src');
const sources = new Map();
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (/\.jsx?$/u.test(entry.name)) sources.set(path.relative(root, full), await fs.readFile(full, 'utf8'));
  }
}
await walk(root);

test('judge-facing Agent activity does not intercept browser diagnostics', () => {
  for (const [file, text] of sources) assert.doesNotMatch(text, /console\.(?:log|warn|error)\s*=/u, file);
});

test('render code does not emit debug logs (the activity panel shows business events only)', () => {
  for (const [file, text] of sources) {
    if (file.startsWith(`lib${path.sep}`)) continue; // web3.js keeps its transaction diagnostics in DevTools
    assert.doesNotMatch(text, /console\.(?:log|debug|info)\(/u, file);
  }
});
