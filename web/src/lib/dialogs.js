// The small questions the app asks (an admin token, a rejection reason, a yes/no) as promises, in place of the
// browser's native prompt() and confirm(). <AppDialogs /> renders the pending question; the answer settles the promise:
// text → the entered string or null when cancelled, confirm → true or false.
import { createStore } from '../state/store.js';

export const dialogStore = createStore({ request: null });
let pending = null;

function open(request) {
  return new Promise((resolve) => {
    // A newer question replaces an unanswered one, which counts as cancelled.
    if (pending) pending.resolve(pending.kind === 'confirm' ? false : null);
    pending = { resolve, kind: request.kind };
    dialogStore.set({ request: { ...request, id: Date.now() + Math.random() } });
  });
}

/** @param {{title: string, label: string, hint?: string, secret?: boolean, multiline?: boolean, optional?: boolean, confirmLabel?: string}} options */
export const askText = (options) => open({ kind: 'text', ...options });

/** @param {{title: string, body: string, confirmLabel?: string}} options */
export const askConfirm = (options) => open({ kind: 'confirm', ...options });

export function answerDialog(value) {
  const current = pending;
  pending = null;
  dialogStore.set({ request: null });
  current?.resolve(value);
}
