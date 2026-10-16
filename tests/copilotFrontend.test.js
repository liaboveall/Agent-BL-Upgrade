import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileDocument, MAX_FILE_BYTES } from '../web/src/lib/documents.js';

test('document upload reads actual bytes as base64 and rejects files beyond the intake limit', async () => {
  class Reader {
    readAsDataURL(file) { this.result = `data:${file.type};base64,${Buffer.from('actual document content').toString('base64')}`; this.onload(); }
  }
  const document = await fileDocument({ name: 'bill.md', type: '', size: 23 }, Reader);
  assert.equal(document.mime_type, 'text/markdown');
  assert.equal(Buffer.from(document.content_base64, 'base64').toString(), 'actual document content');
  await assert.rejects(fileDocument({ name: 'x.pdf', size: MAX_FILE_BYTES + 1 }, Reader));
  class BadReader { readAsDataURL() { this.onerror(); } }
  await assert.rejects(fileDocument({ name: 'x.txt', type: 'text/plain', size: 1 }, BadReader));
});

test('Copilot surfaces share the server, contain no client ranking, and never inject dynamic HTML', async () => {
  const root = new URL('../web/src/', import.meta.url);
  const read = (name) => fs.readFile(new URL(name, root), 'utf8');
  const [launcher, recommendations, documents, controller] = await Promise.all([
    read('features/copilot/CopilotLauncher.jsx'), read('features/copilot/Recommendations.jsx'), read('pages/mint/Documents.jsx'), read('state/controller.js')
  ]);
  for (const text of [launcher, recommendations, documents, controller]) assert.doesNotMatch(text, /innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/u);
  for (const text of [launcher, recommendations, controller]) {
    assert.doesNotMatch(text, /_scoreAllCases|streamChat|mintRWA|subscribeToPool|filter_eBLs|getLlmClient|\.sort\([^)]*score/u);
  }
  assert.match(launcher, /copilotQuery/u);
  assert.match(controller, /copilotQuery/u);
  // A search result is applied only while the runtime generation it started in is still current.
  assert.match(controller, /modeGeneration === get\(\)\.modeGeneration/u);
});
