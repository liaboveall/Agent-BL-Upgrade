// Keyboard and announcement rules shared by the dashboard and the Agent console. Pure functions:
// components call them from their key handlers, and Node tests check the rules directly.

const ARROWS_BACK = ['ArrowLeft', 'ArrowUp'];
const CHOICE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

/**
 * Roving focus for tabs and radio groups: the index to select and focus for `key`, or -1 when the
 * key is not a navigation key. Wraps at both ends and skips disabled choices.
 * @param {{key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} event
 * @param {number} index the focused choice
 * @param {boolean[]} disabled one flag per choice
 */
export function nextChoiceIndex(event, index, disabled) {
  if (!CHOICE_KEYS.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return -1;
  const enabled = disabled.map((off, i) => (off ? -1 : i)).filter((i) => i >= 0);
  const position = enabled.indexOf(index);
  if (!enabled.length || position < 0) return -1;
  if (event.key === 'Home') return enabled[0];
  if (event.key === 'End') return enabled.at(-1);
  const step = ARROWS_BACK.includes(event.key) ? -1 : 1;
  return enabled[(position + step + enabled.length) % enabled.length];
}

/** Menu arrow keys only move focus; they never activate an item. -1 when the key is not handled. */
export function nextMenuIndex(key, index, count) {
  if (!count || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const from = index < 0 ? (key === 'ArrowUp' ? 0 : -1) : index;
  return (from + (key === 'ArrowUp' ? -1 : 1) + count) % count;
}

/** Tab / Shift+Tab inside a modal: the item to move to at the edges, or null to let the browser move. */
export function modalFocusWrap(items, active, shiftKey) {
  if (!items.length) return null;
  const first = items[0], last = items.at(-1);
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  if (!items.includes(active)) return shiftKey ? last : first;
  return null;
}

// Initial history and unchanged polls are silent. Only new or changed decisions are announced.
export function changedDecisions(previous, current) {
  if (previous === null) return [];
  const fingerprint = (item) => JSON.stringify([item.action, item.status, item.execution?.tx_hash, item.execution?.reference]);
  const known = new Map(previous.map((item) => [item.decision_id, fingerprint(item)]));
  return current.filter((item) => known.get(item.decision_id) !== fingerprint(item));
}

export function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export function scrollBehavior() {
  return prefersReducedMotion() ? 'instant' : 'smooth';
}
