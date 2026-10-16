// Curated demo data is written around one anchor day (`date_anchor`, e.g. "2026-10-16"). When it is
// loaded, every ISO date in it moves by (today - anchor) days, so on any day the voyages are under way
// and the insurance windows make sense. Relative facts (voyage length, cover after ETA, tenor) do not
// change; only the calendar does. AGENTBL_DEMO_TODAY pins "today" (tests, reproducible screenshots).

const DAY_MS = 86_400_000;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?=$|[^\d])/gu;

/** The anchor day all curated cases, documents and scenarios are written around. */
export const DEMO_DATE_ANCHOR = '2026-10-16';

function utcDay(value) {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Today's UTC day as YYYY-MM-DD. AGENTBL_DEMO_TODAY pins it; under `node --test` it defaults to the
 * anchor itself, so the suite sees the data exactly as written whatever day it runs.
 */
export function demoToday({ env = process.env, now } = {}) {
  const pinned = env.AGENTBL_DEMO_TODAY ?? process.env.AGENTBL_DEMO_TODAY;
  if (typeof pinned === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(pinned) && utcDay(pinned) !== null) return pinned;
  if (now === undefined && process.env.NODE_TEST_CONTEXT) return DEMO_DATE_ANCHOR;
  return new Date(now ?? Date.now()).toISOString().slice(0, 10);
}

/** Whole days from `anchor` to today (negative before the anchor). 0 when the anchor is not a date. */
export function shiftDaysFor(anchor, options = {}) {
  const from = utcDay(anchor);
  const to = utcDay(demoToday(options));
  return from === null || to === null ? 0 : Math.round((to - from) / DAY_MS);
}

function shiftMatch(match, year, month, day, days) {
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const back = new Date(ms);
  // Only real calendar dates move ("2026-13-40" is some identifier, not a date).
  if (back.getUTCMonth() !== Number(month) - 1 || back.getUTCDate() !== Number(day)) return match;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** Move every ISO date (also the date part of a timestamp) inside `text` by `days`. */
export function shiftDatesInText(text, days) {
  if (!days || typeof text !== 'string') return text;
  return text.replace(ISO_DATE, (match, y, m, d) => shiftMatch(match, y, m, d, days));
}

// Facts with their own real date (a reference price observed on a given day) never move.
const FIXED_DATE_KEYS = new Set(['date_anchor', 'price_reference_date', 'captured_at']);

function shiftValue(value, days) {
  if (typeof value === 'string') return shiftDatesInText(value, days);
  if (Array.isArray(value)) return value.map((item) => shiftValue(item, days));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = FIXED_DATE_KEYS.has(key) ? item : shiftValue(item, days);
    return out;
  }
  return value;
}

/**
 * A copy of a curated case (or scenario) with its dates moved to today. Data without `date_anchor`
 * (uploads, cases a person typed in, the archived historical case) is returned unchanged.
 */
export function rebaseCaseDates(data, options = {}) {
  if (!data || typeof data !== 'object' || typeof data.date_anchor !== 'string') return data;
  const days = shiftDaysFor(data.date_anchor, options);
  const out = shiftValue(data, days);
  out.date_anchor = data.date_anchor;
  out.date_shift_days = days;
  return out;
}

/** Shift a curated document (Markdown written around DEMO_DATE_ANCHOR) to today. */
export function rebaseDocumentText(text, options = {}) {
  return shiftDatesInText(text, shiftDaysFor(options.anchor ?? DEMO_DATE_ANCHOR, options));
}
