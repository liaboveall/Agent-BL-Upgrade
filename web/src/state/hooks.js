import { useRef, useSyncExternalStore } from 'react';
import { appStore } from './app-store.js';
import { getLang, onLangChange } from '../lib/i18n.js';

/** Subscribe to one slice of a store. The selector must return a stable value (a field, not a new object). */
export function useStore(store, selector) {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}

export function useApp(selector) {
  return useStore(appStore, selector);
}

/**
 * A page that needs many fields of the app state subscribes to just those: it re-renders when one of them changes,
 * not on every unrelated update (a log line, a polled status). Name every field the component and the helpers it
 * hands the state to actually read.
 */
export function useAppPick(keys) {
  const last = useRef(null);
  const snapshot = () => {
    const state = appStore.get();
    if (last.current && keys.every((key) => Object.is(last.current[key], state[key]))) return last.current;
    last.current = Object.fromEntries(keys.map((key) => [key, state[key]]));
    return last.current;
  };
  return useSyncExternalStore(appStore.subscribe, snapshot, snapshot);
}

/** The current UI language; components that call t() re-render when it changes. */
export function useLang() {
  return useSyncExternalStore(onLangChange, getLang, getLang);
}
