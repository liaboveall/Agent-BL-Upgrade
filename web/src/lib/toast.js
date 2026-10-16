// One transient status message at a time, rendered by <Toast/> as a top-layer popover (so it stays
// visible above an open modal dialog).
import { createStore } from '../state/store.js';

export const toastStore = createStore({ id: 0, message: '', error: false });

export function toast(message, isError = false) {
  toastStore.set((state) => ({ id: state.id + 1, message: String(message ?? ''), error: Boolean(isError) }));
}
