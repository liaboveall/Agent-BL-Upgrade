// Server-side render entry for the Node tests (tests/webDom.test.js): the real components rendered
// to static markup with a chosen app state, so the DOM contract (tabs, panels, dialogs, ids) is
// checked against what React actually produces. Not part of the browser bundle.
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../App.jsx';
import { appStore } from '../state/app-store.js';
import { mysteryState, publish } from '../pages/discover/mystery.js';
import { setLang } from '../lib/i18n.js';

export { appStore, mysteryState, setLang };

/** Render the whole dashboard after merging `state` into the app store (and `mystery` into the round). */
export function renderApp({ state = {}, mystery = {} } = {}) {
  appStore.set(state);
  Object.assign(mysteryState, mystery);
  publish();
  return renderToStaticMarkup(<App />);
}
