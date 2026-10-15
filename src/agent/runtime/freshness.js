// Evidence time is explicit. Re-reading an old feed must not refresh its observation time.
export const EVIDENCE_TTL_MS = 24 * 3600 * 1000;
export const SOURCE_STATUSES = Object.freeze(['live', 'fixture', 'stale', 'unavailable']);

export function evidenceMetadata(input, { now = Date.now(), mode = 'demo' } = {}) {
  const observed = input.observed_at === null ? null : input.observed_at ?? new Date(now).toISOString();
  const expires = Number.isFinite(Date.parse(observed)) ? new Date(Date.parse(observed) + EVIDENCE_TTL_MS).toISOString() : null;
  return {
    observed_at: observed,
    expires_at: input.expires_at === null ? null : input.expires_at ?? expires,
    source_status: input.source_status ?? (mode === 'live' ? 'live' : 'fixture')
  };
}

export function assessFreshness(input, now = Date.now()) {
  const observed = Date.parse(input?.observed_at);
  const expires = Date.parse(input?.expires_at);
  const status = input?.source_status;
  const fresh = Number.isFinite(observed) && Number.isFinite(expires) && observed <= now
    && expires > observed && now < expires && now - observed <= EVIDENCE_TTL_MS
    && ['live', 'fixture'].includes(status);
  return { observed_at: input?.observed_at ?? null, expires_at: input?.expires_at ?? null,
    source_status: fresh ? status : 'stale', original_source_status: status ?? null, fresh,
    evaluated_at: new Date(now).toISOString(), age_ms: Number.isFinite(observed) ? now - observed : null };
}

export function eventFreshness(event, now) {
  const current = assessFreshness(event, now);
  const children = (event.data?.events ?? []).filter((item) => item.observed_at || item.expires_at || item.source_status);
  if (children.some((item) => !assessFreshness({ ...event, ...item }, now).fresh)) {
    return { ...current, fresh: false, source_status: 'stale' };
  }
  return current;
}
