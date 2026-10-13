// Keyboard selection and focus recovery shared by the dashboard and Agent console.
const CHOICES = '[role="tab"], [role="radio"]';

export function syncChoiceGroup(group, value, dataKey) {
  for (const choice of group?.querySelectorAll(CHOICES) ?? []) {
    const selected = choice.dataset[dataKey] === value;
    choice.setAttribute(choice.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-checked', String(selected));
    choice.tabIndex = selected ? 0 : -1;
  }
}

export function wireChoiceGroup(group) {
  group?.addEventListener('keydown', (event) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const choices = [...group.querySelectorAll(CHOICES)].filter((choice) => !choice.disabled);
    const index = choices.indexOf(event.target.closest(CHOICES));
    if (index < 0 || !choices.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + choices.length) % choices.length;
    choices[next].click();
    choices[next].focus();
  });
}

export function wireMenuNavigation(menu, close) {
  menu?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      close();
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const items = [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled && !item.closest('[hidden]'));
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(event.target.closest('[role="menuitem"]'));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  });
}

export function wireModalFocus(root) {
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const dialog = event.target.closest('dialog[open]');
    if (!dialog) return;
    const items = [...dialog.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
      .filter((item) => item.tabIndex >= 0 && !item.disabled && item.getClientRects().length && !item.closest('[inert]'));
    if (!items.length) return;
    const first = items[0], last = items.at(-1), active = dialog.ownerDocument.activeElement;
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  });
}

// Rebuilding live controls must not send a keyboard user back to the document body.
// Call synchronously: never move focus after an awaited request while the user may have moved on.
export function preserveFocus(root, render) {
  const active = root?.ownerDocument?.activeElement;
  const key = active?.getAttribute('data-focus-key');
  const id = active?.id;
  const inside = active && root.contains(active);
  const result = render();
  if (inside && !active.isConnected && (key || id)) {
    const replacement = [...root.querySelectorAll('[data-focus-key], [id]')].find((node) =>
      key ? node.getAttribute('data-focus-key') === key : node.id === id);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  }
  return result;
}

// Initial history and unchanged polls are silent. Only new or changed decisions are announced.
export function changedDecisions(previous, current) {
  if (previous === null) return [];
  const fingerprint = (item) => JSON.stringify([item.action, item.status, item.execution?.tx_hash, item.execution?.reference]);
  const known = new Map(previous.map((item) => [item.decision_id, fingerprint(item)]));
  return current.filter((item) => known.get(item.decision_id) !== fingerprint(item));
}

export function scrollBehavior() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}
