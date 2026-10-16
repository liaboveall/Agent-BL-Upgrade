// A tiny observable store. Plain JS (no React) so library modules and Node tests can read it;
// components subscribe through useStore() in hooks.js.

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    /** Shallow-merge a patch (or the result of patch(state)) and notify subscribers. */
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      if (!next) return;
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
