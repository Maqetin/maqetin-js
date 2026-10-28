// The SDK runs in browsers and in Node, so its source uses neither the DOM nor the Node type definitions: the few
// globals it needs are reached through these narrow, typed views of `globalThis`.

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
}

/**
 * The abort signal the SDK passes to `fetch`. Typed `never` because this source loads no DOM types: `never` fits any
 * `fetch`'s own `signal` type (`AbortSignal`), so the platform's `fetch` is a `FetchLike` as it is.
 */
export type SignalLike = never;

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    keepalive?: boolean;
    signal?: SignalLike;
  },
) => Promise<FetchResponseLike>;

interface Globals {
  fetch?: FetchLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
  navigator?: { userAgent?: string; language?: string };
  window?: unknown;
  addEventListener?: (type: string, listener: () => void) => void;
  document?: {
    visibilityState?: string;
    title?: string;
    referrer?: string;
    addEventListener?: (type: string, listener: () => void) => void;
  };
  location?: { href?: string };
  history?: Record<string, unknown>;
  AbortController?: new () => { signal: unknown; abort(): void };
  URL?: new (url: string, base?: string) => { href: string; origin: string; protocol: string };
  localStorage?: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
  };
}

export const g = globalThis as unknown as Globals;

export function setTimer(fn: () => void, ms: number): unknown {
  const handle = g.setTimeout(fn, ms);
  // Node: a pending flush timer must not keep the process alive (call flush()/close() before exit).
  (handle as { unref?: () => void } | null)?.unref?.();
  return handle;
}

export function clearTimer(handle: unknown): void {
  if (handle !== undefined) g.clearTimeout(handle);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimer(resolve, ms));
}

/** RFC 4122 v4. `crypto.randomUUID` exists in every supported browser and in Node 19+. */
export function uuid(): string {
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  const b = new Uint8Array(16);
  if (!g.crypto?.getRandomValues) throw new Error('maqetin-js needs crypto.getRandomValues');
  g.crypto.getRandomValues(b);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UTF-8 byte length without TextEncoder (not in the ES lib). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i += 1; // the low surrogate is part of the same code point
    } else bytes += 3;
  }
  return bytes;
}

/** A request that took longer than its timeout. Handled as a network error: the request may or may not have arrived. */
export class RequestTimeoutError extends Error {
  override readonly name = 'RequestTimeoutError';
  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
  }
}

/**
 * Calls `send` with an abort signal and gives up after `ms`. It does not rely on the signal: a fetch that ignores the
 * abort still loses the race, so one hung connection can never hold the queue.
 */
export function withTimeout<T>(
  ms: number,
  send: (signal: SignalLike | undefined) => Promise<T>,
): Promise<T> {
  const controller = g.AbortController ? new g.AbortController() : undefined;
  let timer: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimer(() => {
      controller?.abort();
      reject(new RequestTimeoutError(ms));
    }, ms);
  });
  // the controller's signal is a real AbortSignal at run time; SignalLike only stands for its type
  return Promise.race([send(controller?.signal as SignalLike | undefined), timeout]).finally(() =>
    clearTimer(timer),
  );
}
