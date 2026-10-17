import path from 'node:path';
import { appendJsonl, writeJsonAtomic, readJson, readJsonl } from '../lib/jsonStore.js';

export class LedgerWriter {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  #file(name) { return path.join(this.baseDir, name); }

  async appendIntent(intent) {
    await appendJsonl(this.#file('intents.jsonl'), intent);
  }

  async appendCashEntry(entry) {
    await appendJsonl(this.#file('cash-entries.jsonl'), entry);
  }

  async writePositions(positions) {
    await writeJsonAtomic(this.#file('positions.json'), positions);
  }

  async writeCursor(cursor) {
    await writeJsonAtomic(this.#file('cursor.json'), cursor);
  }

  async readIntents(filter) {
    return readJsonl(this.#file('intents.jsonl'), { filter });
  }

  async readCashEntries(filter) {
    return readJsonl(this.#file('cash-entries.jsonl'), { filter });
  }

  async readPositions() {
    return readJson(this.#file('positions.json'), {});
  }

  async readCursor() {
    return readJson(this.#file('cursor.json'), {});
  }
}
