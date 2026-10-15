// Decision traces (docs/agent-implementation-plan.md WP1.6): one trace per decision, made of spans
// (pipeline steps, LLM calls, execution) with timing, status and sanitised attributes. They answer
// "what did the agent do for this decision and how long did each step take".
//
// Privacy: attributes pass through sanitizeAttributes (secret-looking keys redacted, long strings cut)
// and LLM prompts/outputs are never stored, only their hashes. If @opentelemetry/api is installed
// every span is also forwarded to it; without it that bridge is a no-op.

import crypto from 'node:crypto';
import { sanitizeAudit, redactText } from '../security/privacy.js';
import { pruneJsonl, retainRecords } from './retention.js';
import { appendJsonl, readJsonl, createWriteQueue } from '../../lib/jsonStore.js';
import { sanitizeAttributes, traceSpan } from '../tracing/tracer.js';

export function hashText(text) {
  return `0x${crypto.createHash('sha256').update(String(text ?? '')).digest('hex')}`;
}

class Span {
  constructor(run, name, parent, attributes) {
    this.run = run;
    this.record = {
      span_id: `sp_${crypto.randomBytes(6).toString('hex')}`,
      parent: parent?.record.span_id ?? null,
      name,
      started_at: new Date(run.tracer.wall()).toISOString(),
      duration_ms: null,
      status: 'ok',
      attributes: sanitizeAttributes(attributes ?? {})
    };
    this.t0 = run.tracer.clock();
  }

  setAttribute(key, value) {
    Object.assign(this.record.attributes, sanitizeAttributes({ [key]: value }));
  }

  /** Record an LLM call by its metadata only: provider, model, latency, token usage and hashes. */
  recordLlm({ provider, model, latency_ms: latencyMs, tokens, prompt, output }) {
    this.setAttribute('llm.provider', provider ?? null);
    this.setAttribute('llm.model', model ?? null);
    if (latencyMs !== undefined) this.setAttribute('llm.latency_ms', latencyMs);
    if (tokens) this.setAttribute('llm.tokens', JSON.stringify(tokens));
    if (prompt !== undefined) this.setAttribute('llm.prompt_hash', hashText(prompt));
    if (output !== undefined) this.setAttribute('llm.output_hash', hashText(output));
  }

  child(name, fn, attributes) {
    return this.run.span(name, fn, attributes, this);
  }

  finish(error) {
    this.record.duration_ms = Math.max(0, Math.round(this.run.tracer.clock() - this.t0));
    if (error) {
      this.record.status = 'error';
      this.record.error = redactText(error?.message ?? error).slice(0, 300);
    }
    return this.record;
  }
}

class Run {
  constructor(tracer, { decision_id: decisionId, name, attributes }) {
    this.tracer = tracer;
    this.trace_id = `tr_${crypto.randomBytes(8).toString('hex')}`;
    this.decision_id = decisionId ?? null;
    this.name = name;
    this.started_at = new Date(tracer.wall()).toISOString();
    this.t0 = tracer.clock();
    this.spans = [];
    this.attributes = sanitizeAttributes(attributes ?? {});
    this.ended = false;
  }

  /** Attach the decision id once it is known (the id is derived after the first pipeline steps). */
  bindDecision(decisionId) {
    this.decision_id = decisionId;
  }

  /** Run `fn` inside a span. The span records status and duration whether `fn` resolves or throws. */
  async span(name, fn, attributes, parent = null) {
    const span = new Span(this, name, parent, attributes);
    const execute = () => fn(span);
    try {
      const result = this.tracer.bridge
        ? await traceSpan(name, execute, span.record.attributes)
        : await execute();
      this.spans.push(span.finish());
      return result;
    } catch (error) {
      this.spans.push(span.finish(error));
      throw error;
    }
  }

  /** Close the trace and persist it. Calling it twice is harmless. */
  async end(status = 'ok') {
    if (this.ended) return this.summary();
    this.ended = true;
    this.status = status;
    this.duration_ms = Math.max(0, Math.round(this.tracer.clock() - this.t0));
    const summary = this.summary();
    this.tracer.remember(summary);
    await this.tracer.persist(summary);
    return summary;
  }

  summary() {
    return {
      trace_id: this.trace_id,
      decision_id: this.decision_id,
      name: this.name,
      started_at: this.started_at,
      duration_ms: this.duration_ms ?? null,
      status: this.status ?? 'open',
      attributes: this.attributes,
      spans: this.spans
    };
  }
}

export class Tracer {
  /**
   * @param {object} [options]
   * @param {string|null} [options.file]      JSONL file (null = memory only)
   * @param {()=>number} [options.clock]      monotonic ms (injectable for tests)
   * @param {()=>number} [options.wall]       wall-clock ms
   * @param {number} [options.memoryRuns]     how many recent traces stay in memory
   * @param {boolean} [options.bridge]        forward spans to OpenTelemetry when installed
   */
  constructor({ file = null, clock = () => performance.now(), wall = () => Date.now(), memoryRuns = 200, bridge = true, maxBytes = 2 * 1024 * 1024, keepFiles = 2 } = {}) {
    this.file = file;
    this.clock = clock;
    this.wall = wall;
    this.memoryRuns = memoryRuns;
    this.bridge = bridge;
    this.maxBytes = maxBytes;
    this.keepFiles = keepFiles;
    this.recent = [];
    this.enqueueWrite = createWriteQueue();
  }

  startRun(options = {}) {
    return new Run(this, options);
  }

  remember(summary) {
    this.recent.push(sanitizeAudit(summary));
    if (this.recent.length > this.memoryRuns) this.recent.splice(0, this.recent.length - this.memoryRuns);
  }

  async persist(summary) {
    if (!this.file) return;
    try {
      await this.enqueueWrite(() => appendJsonl(this.file, sanitizeAudit(summary), { maxBytes: this.maxBytes, keepFiles: this.keepFiles }));
    } catch {
      // Tracing must never break a decision.
    }
  }

  async prune(options) {
    return this.enqueueWrite(async () => {
      this.recent = retainRecords(this.recent, { ...options, timestamp: 'started_at' });
      if (this.file) await pruneJsonl(this.file, this.keepFiles, { ...options, timestamp: 'started_at' });
    });
  }

  /** The newest trace recorded for a decision (memory first, then the files). */
  async getByDecision(decisionId) {
    const inMemory = [...this.recent].reverse().find((trace) => trace.decision_id === decisionId);
    if (inMemory) return structuredClone(inMemory);
    if (!this.file) return null;
    const found = await readJsonl(this.file, { filter: (trace) => trace.decision_id === decisionId, includeRotated: true, keepFiles: this.keepFiles });
    return found.length ? sanitizeAudit(found[found.length - 1]) : null;
  }
}
