import { g } from './runtime.js';

/** Where the listeners of one `history` object live: on the object, so a page patches its history once. */
const LISTENERS = Symbol.for('maqetin.navigation');

type Listener = () => void;
type PatchedHistory = Record<string | symbol, unknown> & { [LISTENERS]?: Set<Listener> };

/**
 * Calls `listener` after every `pushState`, `replaceState` and `popstate` of the page, and returns a function that
 * stops it. The page's history is wrapped once, however many clients listen: a wrapper per client would stack a layer
 * on every navigation for each client ever made, and a closed client's layer would stay. Outside a browser it does
 * nothing.
 */
export function onNavigate(listener: Listener): () => void {
  const history = g.history as PatchedHistory | undefined;
  if (history === undefined || typeof history.pushState !== 'function') return () => undefined;
  let listeners = history[LISTENERS];
  if (listeners === undefined) {
    const all = new Set<Listener>();
    listeners = all;
    history[LISTENERS] = all;
    const notify = () => {
      for (const fn of [...all]) fn();
    };
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = history[name] as (...args: unknown[]) => unknown;
      history[name] = function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
    }
    g.addEventListener?.('popstate', notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
