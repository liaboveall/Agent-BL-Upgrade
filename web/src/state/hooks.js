import { useSyncExternalStore } from 'react';
import { appStore } from './app-store.js';
import { getLang, onLangChange } from '../lib/i18n.js';

/** Subscribe to one slice of a store. The selector must return a stable value (a field, not a new object). */
export function useStore(store, selector) {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}

export function useApp(selector) {
  return useStore(appStore, selector);
}

/** The current UI language; components that call t() re-render when it changes. */
export function useLang() {
  return useSyncExternalStore(onLangChange, getLang, getLang);
}
