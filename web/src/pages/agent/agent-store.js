// Agent console state: what the runtime is doing, what it decided and why, and what waits for a
// human. Every row comes from the server's decision log; updates arrive over the activity SSE stream
// (the browser resumes it with Last-Event-ID), with a slow poll as a safety net.
import { createStore } from '../../state/store.js';
import { appStore } from '../../state/app-store.js';
import * as api from '../../lib/api.js';
import { agent } from '../../lib/agent-api.js';
import { changedDecisions } from '../../lib/accessibility.js';
import { t } from '../../lib/i18n.js';
import { toast } from '../../lib/toast.js';
import { shortId } from '../../lib/agent-format.js';

const POLL_MS = 10_000;
const REFRESH_DEBOUNCE_MS = 250;
const TIMELINE_LIMIT = 40;

export const agentStore = createStore({
  active: false,
  status: null,
  error: null,
  decisions: [],
  protectedCases: new Set(),
  cases: [],
  selectedCase: null,
  filters: { status: '', action: '' },
  openDecisionId: null,
  refreshSeq: 0,
  announcement: null,
  scenarios: []
});

const get = () => agentStore.get();
const set = (patch) => agentStore.set(patch);
const runtime = { stream: null, poll: null, debounce: null, refreshing: false, announced: null };

export async function refresh() {
  if (!get().active || runtime.refreshing) return;
  runtime.refreshing = true;
  try {
    const [status, decisions, pools] = await Promise.all([
      agent.status(),
      agent.decisions({ limit: TIMELINE_LIMIT }),
      agent.pools().catch(() => ({ pools: [] }))
    ]);
    const list = decisions.decisions ?? [];
    const changes = changedDecisions(runtime.announced, list);
    runtime.announced = list;
    set((state) => ({
      status,
      error: null,
      decisions: list,
      protectedCases: new Set((pools.pools ?? []).filter((pool) => pool.protected).map((pool) => pool.case_id)),
      refreshSeq: state.refreshSeq + 1,
      announcement: changes.length
        ? { count: changes.length, action: changes[0].action, status: changes[0].status, id: shortId(changes[0].decision_id, 11, 4) }
        : state.announcement
    }));
  } catch (error) {
    if (!get().status) set({ error: error.message });
  } finally {
    runtime.refreshing = false;
  }
}

function scheduleRefresh() {
  clearTimeout(runtime.debounce);
  runtime.debounce = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
}

export async function startConsole() {
  set({ active: true });
  try {
    const cases = appStore.get().cases.length ? appStore.get().cases : await api.getCases();
    set((state) => ({ cases, selectedCase: state.selectedCase ?? cases[0]?.case_id ?? null }));
  } catch {
    set({ cases: [] });
  }
  try { set({ scenarios: (await agent.scenarios()).scenarios ?? [] }); } catch { /* demo playback stays empty */ }
  await refresh();
  if (!get().active) return;
  runtime.stream?.close();
  if (typeof EventSource !== 'undefined') {
    runtime.stream = new EventSource('/api/agent/activity/stream');
    runtime.stream.onmessage = (message) => {
      let data;
      try { data = JSON.parse(message.data); } catch { return; }
      if (data.type === 'activity' || data.type === 'connected') scheduleRefresh();
    };
  }
  clearInterval(runtime.poll);
  runtime.poll = setInterval(refresh, POLL_MS);
}

export function stopConsole() {
  set({ active: false });
  runtime.stream?.close();
  runtime.stream = null;
  clearInterval(runtime.poll);
  clearTimeout(runtime.debounce);
}

export async function control(body, doneKey) {
  try {
    await agent.control(body);
    toast(t(doneKey));
  } catch (error) {
    toast(error.message, true);
  }
  await refresh();
}

export function openDecision(id) {
  set({ openDecisionId: id });
}

export function closeDecision() {
  set({ openDecisionId: null });
}

export function setFilter(key, value) {
  set((state) => ({ filters: { ...state.filters, [key]: value } }));
}

export function setSelectedCase(caseId) {
  set({ selectedCase: caseId });
}
