import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileDocument, MAX_FILE_BYTES } from '../public/agent/documents.js';

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
  const root = new URL('../public/', import.meta.url);
  const popup = await fs.readFile(new URL('popup-assistant.js', root), 'utf8');
  const app = await fs.readFile(new URL('app.js', root), 'utf8');
  const ui = await fs.readFile(new URL('copilot/ui.js', root), 'utf8');
  const docs = await fs.readFile(new URL('agent/documents.js', root), 'utf8');
  for (const text of [popup, ui, docs]) assert.doesNotMatch(text, /innerHTML|insertAdjacentHTML|\bhtml:/u);
  assert.doesNotMatch(popup, /_scoreAllCases|streamChat|mintRWA|subscribeToPool/u);
  assert.doesNotMatch(app, /filter_eBLs|getLlmClient|caseList\.map/u);
  assert.match(popup, /copilotQuery/u); assert.match(app, /copilotQuery/u);
  assert.match(app, /modeGeneration !== state\.modeGeneration/u);
});
