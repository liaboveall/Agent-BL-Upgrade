import { lazy } from 'react';

/**
 * A page loaded on first use, so the default finance view does not download every other view first.
 * `preload()` resolves it ahead of time; once resolved it renders synchronously (also under SSR tests).
 */
export function lazyPage(load) {
  let Loaded = null;
  const resolve = () => load().then((Component) => { Loaded = Component; return Component; });
  const Lazy = lazy(() => resolve().then((Component) => ({ default: Component })));
  function Page(props) { return Loaded ? <Loaded {...props} /> : <Lazy {...props} />; }
  Page.preload = () => (Loaded ? Promise.resolve(Loaded) : resolve());
  return Page;
}
